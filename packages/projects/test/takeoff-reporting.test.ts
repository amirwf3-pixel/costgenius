import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  createProject,
  createTakeoffDocument,
  finalizeTakeoffDocument,
  renderTakeoffExcel,
  renderTakeoffPdf,
  saveTakeoffDocumentDraft,
  type FinalizedTakeoff,
  type RoundingRuleSet,
  type TakeoffDocumentSheet,
} from '../src/index.js';
import { PROJECT_ID } from './helpers.js';

const T0 = '2026-01-01T00:00:00Z';
const T2 = '2026-01-03T00:00:00Z';

/**
 * A dimensional line (L×W) — the exact-quantity workhorse (same helper shape as the
 * transfer suite).
 */
function dimLine(
  lineId: string,
  itemCode: string | null,
  length: string,
  width: string,
  unit = 'm2',
): TakeoffDocumentSheet['lines'][number] {
  return {
    lineId,
    rowNo: 1,
    description: `خط ${lineId}`,
    itemCode,
    kind: 'addition',
    unit,
    quantity: { type: 'dimensional', profile: 'LW', length, width },
  };
}

/**
 * Builds a FINALIZED takeoff through the real domain (create → save → finalize — the
 * engine runs, so every value the report copies is the engine's own).
 */
function finalizedTakeoff(
  documentId: string,
  sheets: readonly TakeoffDocumentSheet[],
  rounding: RoundingRuleSet = [],
): FinalizedTakeoff {
  const project = createProject({ projectId: PROJECT_ID, title: 'پروژه', createdAt: T0 });
  const draft = saveTakeoffDocumentDraft(
    createTakeoffDocument(project, {
      documentId,
      takeoffId: `tk-${documentId}`,
      title: 'ریز متره',
      createdAt: T0,
    }),
    { title: 'ریز متره', sheets, rounding },
  );
  return finalizeTakeoffDocument(draft, { finalizedAt: T2 });
}

/** The standard two-sheet fixture: coded + uncoded + line/item-total rounding. */
function standardTakeoff(): FinalizedTakeoff {
  return finalizedTakeoff(
    'doc-rep1',
    [
      {
        sheetId: 'sh-a',
        name: 'برگه الف',
        lines: [
          { ...dimLine('ln-1', '280101', '4.25', '3.4'), rowNo: 1 },
          {
            ...dimLine('ln-2', null, '5.1', '2'),
            rowNo: 2,
            description: 'خط ln-2',
          },
        ],
      },
      {
        sheetId: 'sh-b',
        name: 'برگه ب',
        lines: [
          {
            lineId: 'ln-3',
            rowNo: 1,
            description: 'عبارت',
            itemCode: '410202',
            kind: 'addition',
            unit: 'm3',
            quantity: {
              type: 'expression',
              node: {
                op: 'mul',
                args: [
                  { op: 'const', value: '4.25' },
                  { op: 'const', value: '3.4' },
                  { op: 'const', value: '0.37' },
                ],
              },
            },
          },
        ],
      },
    ],
    [
      {
        target: 'line',
        selector: { itemCode: '410202' },
        scale: 2,
        mode: 'HALF_UP',
        sourceStatus: 'design',
      },
      {
        target: 'item-total',
        selector: { unit: 'm3' },
        scale: 1,
        mode: 'HALF_UP',
        sourceStatus: 'design',
      },
    ],
  );
}

/** Reads XLSX bytes back into a workbook (real round-trip). */
async function readXlsx(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.slice().buffer);
  return workbook;
}

function entryValue(workbook: ExcelJS.Workbook, field: string): unknown {
  const ws = workbook.getWorksheet('خلاصه');
  if (ws === undefined) throw new Error('worksheet "خلاصه" missing');
  for (let row = 1; row <= ws.rowCount; row += 1) {
    if (ws.getRow(row).getCell(1).value === field) {
      return ws.getRow(row).getCell(2).value;
    }
  }
  throw new Error(`entry field "${field}" missing`);
}

describe('takeoff rendering pass-throughs (D-016 Phase 6, G6=A)', () => {
  it('renders the finalized snapshot to real Excel bytes carrying the engine values verbatim', async () => {
    const finalized = standardTakeoff();
    const bytes = await renderTakeoffExcel(finalized, { projectTitle: 'پروژه' });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K

    const workbook = await readXlsx(bytes);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'خلاصه',
      'متره تفصیلی',
      'جمع آیتم‌ها',
      'جمع برگه‌ها',
    ]);
    // Header contract: identity, status, finalization, spec, engine — from the snapshot.
    expect(entryValue(workbook, 'شناسه سند')).toBe('doc-rep1');
    expect(entryValue(workbook, 'زنجیرهٔ متره')).toBe('tk-doc-rep1');
    expect(entryValue(workbook, 'پروژه')).toBe('پروژه');
    expect(entryValue(workbook, 'وضعیت')).toBe('finalized');
    expect(entryValue(workbook, 'زمان نهایی‌سازی')).toBe(T2);
    expect(entryValue(workbook, 'مشخصات اندازه‌گیری')).toBe(
      `${finalized.result.specId}@${finalized.result.specVersion}`,
    );
    expect(entryValue(workbook, 'نسخهٔ موتور محاسبه')).toBe(finalized.result.engineVersion);

    // Detail sheet: every engine line appears with ITS OWN exact strings (verbatim).
    const detail = workbook.getWorksheet('متره تفصیلی');
    if (detail === undefined) throw new Error('worksheet "متره تفصیلی" missing');
    const exactByLine = new Map(finalized.result.lines.map((line) => [line.lineId, line]));
    for (let row = 2; row <= detail.rowCount; row += 1) {
      const lineId = detail.getRow(row).getCell(5).value as string;
      const engine = exactByLine.get(lineId);
      if (engine === undefined) throw new Error(`unexpected report line ${lineId}`);
      expect(detail.getRow(row).getCell(15).value).toBe(engine.exactMagnitude);
      expect(detail.getRow(row).getCell(16).value).toBe(engine.roundedMagnitude ?? null);
      expect(detail.getRow(row).getCell(17).value).toBe(engine.signedValue);
    }
    expect(detail.rowCount).toBe(1 + finalized.result.lines.length);

    // Spot checks the engine really produced the expected values (4.25 × 3.4 = 14.45;
    // 4.25 × 3.4 × 0.37 = 5.3465 → line rule 2dp HALF_UP → 5.35).
    const line1 = finalized.result.lines.find((line) => line.lineId === 'ln-1');
    expect(line1?.exactMagnitude).toBe('14.45');
    const line3 = finalized.result.lines.find((line) => line.lineId === 'ln-3');
    expect(line3?.exactMagnitude).toBe('5.3465');
    expect(line3?.roundedMagnitude).toBe('5.35');
    expect(line3?.signedValue).toBe('5.35');

    // Item totals: exact/rounded/effective with provenance (engine's own rows).
    const totals = workbook.getWorksheet('جمع آیتم‌ها');
    if (totals === undefined) throw new Error('worksheet "جمع آیتم‌ها" missing');
    for (const [index, total] of finalized.result.itemTotals.entries()) {
      const row = totals.getRow(5 + index); // 2 entries + blank + header + data
      expect(row.getCell(1).value).toBe(total.itemCode ?? 'بدون کد');
      expect(row.getCell(3).value).toBe(total.exactQty);
      expect(row.getCell(4).value).toBe(total.roundedQty ?? null);
      expect(row.getCell(5).value).toBe(total.qty);
      expect(row.getCell(6).value).toBe(total.lineIds.join('، '));
    }
  });

  it('renders the finalized snapshot to real PDF bytes', async () => {
    const bytes = await renderTakeoffPdf(standardTakeoff(), { projectTitle: 'پروژه' });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
  });

  it('rejects a draft source — no report exists before finalization (A/C)', async () => {
    const draft = structuredClone(standardTakeoff());
    (draft.document as { status: string }).status = 'draft';
    await expect(renderTakeoffExcel(draft)).rejects.toThrowError(
      /only a finalized takeoff has a report/,
    );
    await expect(renderTakeoffPdf(draft)).rejects.toThrowError(
      /only a finalized takeoff has a report/,
    );
  });

  it('never mutates the finalized snapshot (rendering is read-only — W)', async () => {
    const finalized = standardTakeoff();
    const before = structuredClone(finalized);
    await renderTakeoffExcel(finalized, { projectTitle: 'پروژه' });
    await renderTakeoffPdf(finalized, { projectTitle: 'پروژه' });
    expect(finalized).toEqual(before);
  });

  it('is deterministic: the same snapshot renders byte-identical reports (K)', async () => {
    const finalized = standardTakeoff();
    const excel1 = await renderTakeoffExcel(finalized);
    const excel2 = await renderTakeoffExcel(finalized);
    expect(Buffer.from(excel1).equals(Buffer.from(excel2))).toBe(true);
    const pdf1 = await renderTakeoffPdf(finalized);
    const pdf2 = await renderTakeoffPdf(finalized);
    expect(Buffer.from(pdf1).equals(Buffer.from(pdf2))).toBe(true);
  });

  it('does not recalculate: the report renders the persisted result, never a fresh engine run', async () => {
    // Corrupt the persisted result AFTER finalization (a post-finalization edit of the
    // persisted snapshot): the report must copy the snapshot verbatim — including the
    // corruption — instead of recomputing from the input. (A re-run would produce 14.45.)
    const finalized = structuredClone(standardTakeoff());
    const target = finalized.result.lines.find((line) => line.lineId === 'ln-1');
    if (target === undefined) throw new Error('ln-1 missing');
    (target as { exactMagnitude: string; signedValue: string }).exactMagnitude = '999.999';
    (target as { exactMagnitude: string; signedValue: string }).signedValue = '999.999';
    const workbook = await readXlsx(await renderTakeoffExcel(finalized));
    const detail = workbook.getWorksheet('متره تفصیلی');
    if (detail === undefined) throw new Error('worksheet "متره تفصیلی" missing');
    const values = Array.from(
      { length: detail.rowCount },
      (_, i) => detail.getRow(i + 1).getCell(15).value as string,
    );
    expect(values).toContain('999.999'); // the snapshot's own value, verbatim
    expect(values).not.toContain('14.45'); // never recalculated from the input
  });
});
