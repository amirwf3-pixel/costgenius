import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { normalizePresentationForms } from '@costgenius/reporting-pdf';
import { renderEstimateExcel, renderEstimatePdf } from '@costgenius/projects';
import {
  COMPLETE_EXPECTED_TOTAL,
  COMPLETE_LINE_INPUTS,
  BLOCKED_LINE_INPUTS,
  ESTIMATE_ID,
  buildFinalized,
  createTestDb,
  loadPublished1404,
} from './helpers.js';

const dataset = loadPublished1404();

async function readXlsx(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.slice().buffer);
  return workbook;
}

function summaryValue(workbook: ExcelJS.Workbook, field: string): unknown {
  const ws = workbook.getWorksheet('Summary');
  if (ws === undefined) throw new Error('Summary sheet missing');
  for (let row = 1; row <= ws.rowCount; row += 1) {
    if (ws.getRow(row).getCell(1).value === field) {
      return ws.getRow(row).getCell(2).value;
    }
  }
  throw new Error(`summary field "${field}" missing`);
}

function lineRowByCode(workbook: ExcelJS.Workbook, code: string): unknown[] {
  const ws = workbook.getWorksheet('Lines');
  if (ws === undefined) throw new Error('Lines sheet missing');
  for (let row = 2; row <= ws.rowCount; row += 1) {
    const values = ws.getRow(row).values as unknown[];
    if (values[4] === code) return values;
  }
  throw new Error(`line row for code ${code} missing`);
}

describe('K. persist → load → ReportModel → Excel/PDF (Phase 13 semantics preserved)', () => {
  it('the report rendered from the RELOADED finalized bundle is byte-honest (Excel)', async () => {
    const { projects, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(dataset, COMPLETE_LINE_INPUTS, 'rep-xlsx');
    await projects.save(project);
    await finalizedRepo.save(finalized);
    const loaded = await finalizedRepo.byVersionId(`${ESTIMATE_ID}-v1`);
    if (loaded === undefined) throw new Error('finalized bundle must reload');

    const bytes = await renderEstimateExcel(loaded.calculation);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    const workbook = await readXlsx(bytes);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'Summary',
      'Chapters',
      'Groups',
      'Lines',
      'S4 Trace',
    ]);
    expect(summaryValue(workbook, 'Total Amount')).toBe(COMPLETE_EXPECTED_TOTAL);
    expect(summaryValue(workbook, 'Edition')).toBe('1404');
    expect(summaryValue(workbook, 'Version Status')).toBe('finalized');

    const l1 = lineRowByCode(workbook, '010101');
    expect(l1[4]).toBe('010101'); // leading zero as exact text
    expect(l1[10]).toBe('2890000'); // line amount
    const l5 = lineRowByCode(workbook, '270320');
    expect(l5[9]).toBe('-1037000'); // negative price as exact text
    expect(l5[10]).toBe('-10370000');
  });

  it('the report rendered from the RELOADED blocked bundle shows nulls, never 0 (Excel)', async () => {
    const { projects, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(
      dataset,
      [...COMPLETE_LINE_INPUTS, ...BLOCKED_LINE_INPUTS],
      'rep-xlsx-blocked',
    );
    await projects.save(project);
    await finalizedRepo.save(finalized);
    const loaded = await finalizedRepo.byVersionId(`${ESTIMATE_ID}-v1`);
    if (loaded === undefined) throw new Error('finalized bundle must reload');

    const workbook = await readXlsx(await renderEstimateExcel(loaded.calculation));
    expect([null, undefined]).toContain(summaryValue(workbook, 'Total Amount'));
    expect(summaryValue(workbook, 'Report Status')).toBe('EXTERNAL_DEPENDENCY');
    const b1 = lineRowByCode(workbook, '220925');
    expect([null, undefined]).toContain(b1[9]); // base price: empty cell, never 0
    expect([null, undefined]).toContain(b1[10]); // line amount: empty cell, never 0
    expect(b1[11]).toBe('INCOMPLETE'); // pricebook status as honest text
  });

  it('the PDF rendered from the RELOADED finalized bundle carries codes, signs and provenance', async () => {
    const { projects, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(
      dataset,
      [...COMPLETE_LINE_INPUTS, ...BLOCKED_LINE_INPUTS],
      'rep-pdf',
    );
    await projects.save(project);
    await finalizedRepo.save(finalized);
    const loaded = await finalizedRepo.byVersionId(`${ESTIMATE_ID}-v1`);
    if (loaded === undefined) throw new Error('finalized bundle must reload');

    const bytes = await renderEstimatePdf(loaded.calculation);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
      getDocument: (options: { data: Uint8Array; isEvalSupported: boolean }) => {
        promise: Promise<{
          numPages: number;
          getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
        }>;
      };
    };
    const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += `${content.items.map((item) => (item as { str?: string }).str ?? '').join(' ')}\n`;
    }
    text = normalizePresentationForms(text);
    expect(text).toContain('010101'); // leading zero
    expect(text).toContain('270320');
    expect(text).toContain('-1037000'); // negative price, no sign stripping
    expect(text).toContain('-2131000');
    expect(text).toContain('220925'); // the blocked deduction row is visible
    expect(text).toContain('—'); // null placeholder — never 0
    expect(text).toContain('EXTERNAL_DEPENDENCY');
    expect(text.replace(/\s+/g, '')).toContain(
      'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
    );
  }, 120_000);
});

describe('L. determinism: same data, same result', () => {
  it('two independent databases loaded with the same data return identical aggregates', async () => {
    const first = await createTestDb();
    const second = await createTestDb();
    const { canonicalJson } = await import('../src/index.js');

    for (const db of [first, second]) {
      const { project, finalized } = buildFinalized(dataset, COMPLETE_LINE_INPUTS, 'rep-det');
      await db.projects.save(project);
      await db.finalized.save(finalized);
    }

    const a = await first.finalized.byVersionId(`${ESTIMATE_ID}-v1`);
    const b = await second.finalized.byVersionId(`${ESTIMATE_ID}-v1`);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    const ea = await first.estimates.findById(ESTIMATE_ID);
    const eb = await second.estimates.findById(ESTIMATE_ID);
    expect(canonicalJson(ea)).toBe(canonicalJson(eb));
  });

  it('saving the same aggregates twice into one database changes nothing', async () => {
    const { projects, estimates, finalized: finalizedRepo } = await createTestDb();
    const { canonicalJson } = await import('../src/index.js');
    const { project, finalized } = buildFinalized(dataset, COMPLETE_LINE_INPUTS, 'rep-idem');
    await projects.save(project);
    await finalizedRepo.save(finalized);
    const before = await finalizedRepo.byVersionId(`${ESTIMATE_ID}-v1`);

    await projects.save(project);
    await estimates.save(finalized.estimate);
    await finalizedRepo.save(finalized);

    const after = await finalizedRepo.byVersionId(`${ESTIMATE_ID}-v1`);
    expect(canonicalJson(after)).toBe(canonicalJson(before));
  });
});
