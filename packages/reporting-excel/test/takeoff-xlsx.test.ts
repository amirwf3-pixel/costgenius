import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildTakeoffReportModel, type TakeoffReportSource } from '@costgenius/reporting';
import { ReportingExcelError, renderTakeoffReportToXlsx } from '../src/index.js';

// -------------------------------------------------------------------------------------------------
// A hand-written, engine-faithful FINALIZED snapshot (renderer tests keep their own fixture
// copy by repo convention). Every value is exactly what the engine persists; the renderer
// must copy it VERBATIM — exact decimals as text cells, never numbers.
// -------------------------------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00Z';
const T2 = '2026-01-03T00:00:00Z';
const RULE_ID = 'CG-IR-MEASUREMENT-SPEC@0.2.0#multiply';

function finalizedSource(): TakeoffReportSource {
  return {
    document: {
      documentId: 'doc-r1',
      takeoffId: 'tk-doc-r1',
      projectId: 'proj-1',
      title: 'ریز متره فاز یک',
      documentNumber: 3,
      status: 'finalized',
      revision: 2,
      createdAt: T0,
      finalizedAt: T2,
    },
    documentId: 'doc-r1',
    takeoffId: 'tk-doc-r1',
    documentNumber: 3,
    finalizedAt: T2,
    input: {
      sheets: [
        {
          sheetId: 'sh-a',
          name: 'برگه الف',
          lines: [
            {
              lineId: 'ln-1',
              rowNo: 1,
              description: 'کف سالن',
              location: 'طبقه اول',
              itemCode: '280101',
              kind: 'addition',
              unit: 'm2',
              quantity: { type: 'dimensional', profile: 'LW', length: '4.25', width: '3.4' },
            },
            {
              lineId: 'ln-3',
              rowNo: 3,
              description: 'سقف کاذب',
              itemCode: null,
              kind: 'addition',
              unit: 'm2',
              quantity: {
                type: 'reference',
                terms: [{ lineId: 'ln-1', factor: '0.5', use: 'signed' }],
              },
            },
          ],
        },
        {
          sheetId: 'sh-b',
          name: 'برگه ب',
          lines: [
            {
              lineId: 'ln-4',
              rowNo: 1,
              description: 'دال بتنی',
              itemCode: '410202',
              kind: 'addition',
              unit: 'm3',
              quantity: {
                type: 'expression',
                node: {
                  op: 'round',
                  arg: {
                    op: 'mul',
                    args: [
                      { op: 'const', value: '4.25' },
                      { op: 'const', value: '3.4' },
                      { op: 'const', value: '0.37' },
                    ],
                  },
                  rule: { scale: 2, mode: 'HALF_UP' },
                },
              },
            },
          ],
        },
      ],
      rounding: [
        {
          target: 'line',
          selector: { itemCode: '410202' },
          scale: 2,
          mode: 'HALF_UP',
          sourceStatus: 'design',
        },
      ],
    },
    result: {
      specId: 'CG-IR-MEAS',
      specVersion: '0.2.0',
      engineVersion: '0.2.0',
      status: 'ok',
      errors: [],
      lines: [
        {
          lineId: 'ln-1',
          sheetId: 'sh-a',
          rowNo: 1,
          itemCode: '280101',
          unit: 'm2',
          kind: 'addition',
          exactMagnitude: '14.45',
          signedValue: '14.45',
          trace: { op: 'multiply', value: '14.45', unit: 'm2', ruleId: RULE_ID, inputs: [] },
        },
        {
          lineId: 'ln-3',
          sheetId: 'sh-a',
          rowNo: 3,
          itemCode: null,
          unit: 'm2',
          kind: 'addition',
          exactMagnitude: '7.225',
          signedValue: '7.225',
          trace: { op: 'multiply', value: '7.225', unit: 'm2', ruleId: RULE_ID, inputs: [] },
        },
        {
          lineId: 'ln-4',
          sheetId: 'sh-b',
          rowNo: 1,
          itemCode: '410202',
          unit: 'm3',
          kind: 'addition',
          exactMagnitude: '5.3465',
          roundedMagnitude: '5.35',
          signedValue: '5.35',
          trace: { op: 'round', value: '5.3465', unit: 'm3', ruleId: RULE_ID, inputs: [] },
        },
      ],
      itemTotals: [
        { itemCode: '280101', unit: 'm2', exactQty: '14.45', qty: '14.45', lineIds: ['ln-1'] },
        { itemCode: null, unit: 'm2', exactQty: '7.225', qty: '7.225', lineIds: ['ln-3'] },
        {
          itemCode: '410202',
          unit: 'm3',
          exactQty: '5.3465',
          roundedQty: '5.3',
          qty: '5.3',
          lineIds: ['ln-4'],
        },
      ],
      sheetTotals: [
        {
          sheetId: 'sh-a',
          byItem: [
            { itemCode: '280101', unit: 'm2', exactQty: '14.45', qty: '14.45', lineIds: ['ln-1'] },
            { itemCode: null, unit: 'm2', exactQty: '7.225', qty: '7.225', lineIds: ['ln-3'] },
          ],
        },
        {
          sheetId: 'sh-b',
          byItem: [
            {
              itemCode: '410202',
              unit: 'm3',
              exactQty: '5.3465',
              qty: '5.3465',
              lineIds: ['ln-4'],
            },
          ],
        },
      ],
    },
  };
}

function takeoffReport() {
  return buildTakeoffReportModel({ source: finalizedSource(), projectTitle: 'برج مسکونی' });
}

async function render(): Promise<Uint8Array> {
  return renderTakeoffReportToXlsx(takeoffReport());
}

/** Reads XLSX bytes back into a workbook (real round-trip, not an in-memory shortcut). */
async function readXlsx(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const data = bytes.slice().buffer; // exact-size ArrayBuffer copy
  await workbook.xlsx.load(data);
  return workbook;
}

function worksheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const found = workbook.getWorksheet(name);
  if (found === undefined) throw new Error(`worksheet "${name}" missing`);
  return found;
}

/** Value of a key–value entry (scans column A of the given sheet for the field name). */
function entryValue(workbook: ExcelJS.Workbook, sheet: string, field: string): unknown {
  const ws = worksheet(workbook, sheet);
  for (let row = 1; row <= ws.rowCount; row += 1) {
    if (ws.getRow(row).getCell(1).value === field) {
      return ws.getRow(row).getCell(2).value;
    }
  }
  throw new Error(`entry field "${field}" missing on "${sheet}"`);
}

describe('takeoff XLSX render (round-trip)', () => {
  it('renders real XLSX bytes (non-empty, ZIP magic "PK")', async () => {
    const bytes = await render();
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
  });

  it('read-back: the four sheets exist in the fixed V1 order', async () => {
    const workbook = await readXlsx(await render());
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'خلاصه',
      'متره تفصیلی',
      'جمع آیتم‌ها',
      'جمع برگه‌ها',
    ]);
  });

  it('read-back: خلاصه carries the header contract verbatim (identity/status/spec/engine)', async () => {
    const workbook = await readXlsx(await render());
    expect(entryValue(workbook, 'خلاصه', 'شناسه گزارش')).toBe('takeoff-report-doc-r1');
    expect(entryValue(workbook, 'خلاصه', 'عنوان سند')).toBe('ریز متره فاز یک');
    expect(entryValue(workbook, 'خلاصه', 'پروژه')).toBe('برج مسکونی');
    expect(entryValue(workbook, 'خلاصه', 'شناسه پروژه')).toBe('proj-1');
    expect(entryValue(workbook, 'خلاصه', 'شناسه سند')).toBe('doc-r1');
    expect(entryValue(workbook, 'خلاصه', 'زنجیرهٔ متره')).toBe('tk-doc-r1');
    expect(entryValue(workbook, 'خلاصه', 'شمارهٔ سند')).toBe(3);
    expect(entryValue(workbook, 'خلاصه', 'وضعیت')).toBe('finalized');
    expect(entryValue(workbook, 'خلاصه', 'نسخهٔ سند (revision)')).toBe(2);
    expect(entryValue(workbook, 'خلاصه', 'تاریخ ایجاد')).toBe(T0);
    expect(entryValue(workbook, 'خلاصه', 'زمان نهایی‌سازی')).toBe(T2);
    expect(entryValue(workbook, 'خلاصه', 'مشخصات اندازه‌گیری')).toBe('CG-IR-MEAS@0.2.0');
    expect(entryValue(workbook, 'خلاصه', 'نسخهٔ موتور محاسبه')).toBe('0.2.0');
    expect(entryValue(workbook, 'خلاصه', 'تعداد برگه‌ها')).toBe(2);
    expect(entryValue(workbook, 'خلاصه', 'تعداد ردیف‌ها')).toBe(3);
    expect(entryValue(workbook, 'خلاصه', 'اقلام کددار')).toBe(2);
    expect(entryValue(workbook, 'خلاصه', 'اقلام بدون کد')).toBe(1);
  });

  it('read-back: خلاصه carries the rounding rules table (exact/rounded semantics stay labeled)', async () => {
    const workbook = await readXlsx(await render());
    // 17 entries → blank separator → header row 19 → first rule row 20
    const ws = worksheet(workbook, 'خلاصه');
    expect(ws.getRow(19).getCell(1).value).toBe('هدف');
    expect(ws.getRow(19).getCell(3).value).toBe('دقت');
    expect(ws.getRow(19).getCell(6).value).toBe('منبع');
    expect(ws.getRow(20).getCell(1).value).toBe('line');
    expect(ws.getRow(20).getCell(2).value).toBe('کد 410202');
    expect(ws.getRow(20).getCell(3).value).toBe(2);
    expect(ws.getRow(20).getCell(4).value).toBe('HALF_UP');
    expect(ws.getRow(20).getCell(5).value).toBe('design');
  });

  it('read-back: متره تفصیلی carries every line with exact decimal STRINGS (never numbers)', async () => {
    const workbook = await readXlsx(await render());
    const ws = worksheet(workbook, 'متره تفصیلی');
    // No entries → header row 1, data from row 2; 3 lines in sheet order then rowNo order.
    expect(ws.getRow(1).getCell(6).value).toBe('شرح');
    expect(ws.getRow(1).getCell(12).value).toBe('فرمول (§6.3)');
    expect(ws.getRow(1).getCell(15).value).toBe('مقدار دقیق');
    expect(ws.getRow(1).getCell(16).value).toBe('مقدار گردشده');
    expect(ws.getRow(1).getCell(17).value).toBe('مقدار با علامت');
    expect(ws.rowCount).toBe(4); // header + 3 lines
    // Row order: sh-a ln-1, sh-a ln-3, sh-b ln-4
    expect(ws.getRow(2).getCell(5).value).toBe('ln-1');
    expect(ws.getRow(3).getCell(5).value).toBe('ln-3');
    expect(ws.getRow(4).getCell(5).value).toBe('ln-4');
    // Exact decimals are TEXT — no float conversion anywhere (M).
    expect(ws.getRow(2).getCell(15).value).toBe('14.45');
    expect(typeof ws.getRow(2).getCell(15).value).toBe('string');
    expect(ws.getRow(3).getCell(15).value).toBe('7.225');
    expect(ws.getRow(4).getCell(15).value).toBe('5.3465');
    expect(ws.getRow(4).getCell(16).value).toBe('5.35'); // rounded, present only when a rule matched
    expect(ws.getRow(2).getCell(16).value).toBeNull(); // no rule → empty cell, never fabricated
    // The §6.3 canonical formula, verbatim.
    expect(ws.getRow(4).getCell(12).value).toBe('round((4.25 × 3.4 × 0.37), 2, HALF_UP)');
    expect(ws.getRow(2).getCell(12).value).toBe('(4.25 × 3.4)');
    expect(ws.getRow(3).getCell(12).value).toBe('(0.5 × #ln-1)');
    // Uncoded line: empty کد آیتم cell (never an invented code).
    expect(ws.getRow(3).getCell(8).value).toBeNull();
    expect(ws.getRow(2).getCell(8).value).toBe('280101');
    // Kind and quantity type labels.
    expect(ws.getRow(2).getCell(9).value).toBe('افزایش');
    expect(ws.getRow(4).getCell(10).value).toBe('عبارت');
  });

  it('read-back: جمع آیتم‌ها carries exact/rounded/effective with contributing lineIds', async () => {
    const workbook = await readXlsx(await render());
    const ws = worksheet(workbook, 'جمع آیتم‌ها');
    expect(entryValue(workbook, 'جمع آیتم‌ها', 'شناسه سند')).toBe('doc-r1');
    expect(entryValue(workbook, 'جمع آیتم‌ها', 'زنجیرهٔ متره')).toBe('tk-doc-r1');
    // 2 entries → blank → header row 4 → data rows 5..7, engine order preserved.
    expect(ws.getRow(4).getCell(1).value).toBe('کد آیتم');
    expect(ws.getRow(4).getCell(5).value).toBe('مقدار مؤثر (انتقال)');
    expect(ws.getRow(4).getCell(6).value).toBe('ردیف‌های مشارکت‌کننده');
    expect(ws.getRow(5).getCell(1).value).toBe('280101');
    expect(ws.getRow(5).getCell(3).value).toBe('14.45');
    expect(ws.getRow(5).getCell(5).value).toBe('14.45');
    expect(ws.getRow(5).getCell(6).value).toBe('ln-1');
    // Uncoded total stays visible with the fixed label.
    expect(ws.getRow(6).getCell(1).value).toBe('بدون کد');
    expect(ws.getRow(6).getCell(3).value).toBe('7.225');
    // Rounded never replaces exact; effective = transfer quantity (R2=C).
    expect(ws.getRow(7).getCell(1).value).toBe('410202');
    expect(ws.getRow(7).getCell(3).value).toBe('5.3465');
    expect(ws.getRow(7).getCell(4).value).toBe('5.3');
    expect(ws.getRow(7).getCell(5).value).toBe('5.3');
    expect(ws.getRow(7).getCell(6).value).toBe('ln-4');
  });

  it('read-back: جمع برگه‌ها carries per-sheet subtotals in sheet order', async () => {
    const workbook = await readXlsx(await render());
    const ws = worksheet(workbook, 'جمع برگه‌ها');
    expect(ws.getRow(1).getCell(1).value).toBe('ترتیب برگه');
    expect(ws.rowCount).toBe(4); // header + sh-a(2 rows) + sh-b(1 row)
    expect(ws.getRow(2).getCell(1).value).toBe(1);
    expect(ws.getRow(2).getCell(2).value).toBe('برگه الف');
    expect(ws.getRow(2).getCell(3).value).toBe('sh-a');
    expect(ws.getRow(2).getCell(4).value).toBe('280101');
    expect(ws.getRow(3).getCell(4).value).toBe('بدون کد');
    expect(ws.getRow(4).getCell(1).value).toBe(2);
    expect(ws.getRow(4).getCell(2).value).toBe('برگه ب');
    expect(ws.getRow(4).getCell(6).value).toBe('5.3465'); // no sheet-total rule → exact = effective
  });

  it('holds no formulas anywhere (static values only — no live calculations)', async () => {
    const workbook = await readXlsx(await render());
    for (const ws of workbook.worksheets) {
      for (let row = 1; row <= ws.rowCount; row += 1) {
        const values = ws.getRow(row).values as unknown[];
        for (const value of values) {
          if (value !== null && typeof value === 'object') {
            expect((value as { formula?: unknown }).formula).toBeUndefined();
            expect((value as { sharedFormula?: unknown }).sharedFormula).toBeUndefined();
          }
        }
      }
    }
  });

  it('is deterministic: two renders are byte-identical (pinned zip entry dates)', async () => {
    const first = await render();
    const second = await render();
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('fails loudly on a structurally invalid model (nothing is repaired)', async () => {
    // structuredClone yields an unfrozen deep copy (the built model is deeply frozen);
    // the mutable cast mirrors the corruption a caller could hand the renderer.
    const report = structuredClone(takeoffReport());
    (report.metadata as { status: string }).status = 'draft';
    await expect(renderTakeoffReportToXlsx(report)).rejects.toThrowError(ReportingExcelError);
    await expect(renderTakeoffReportToXlsx(report)).rejects.toThrowError(
      /failed the renderer structural validation/,
    );
  });
});
