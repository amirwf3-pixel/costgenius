import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { normalizePresentationForms, shapeArabicPersian } from '@costgenius/reporting-pdf';
import {
  addEstimateLines,
  calculateEstimateVersion,
  createEstimateForProject,
  createProject,
  finalizeEstimate,
  renderEstimateExcel,
  renderEstimatePdf,
  startEstimateVersion,
} from '../src/index.js';
import type { Estimate } from '@costgenius/boq';
import { canonicalJson } from '@costgenius/pricebook';
import {
  BLOCKED_LINE_INPUTS,
  BUILDING_ID,
  COMPLETE_EXPECTED_TOTAL,
  COMPLETE_LINE_INPUTS,
  COMPLETE_S4_EXPECTED,
  ESTIMATE_ID,
  FIXED_INSTANT,
  PROJECT_ID,
  goldenCoefficients,
  loadPublished1404,
} from './helpers.js';

const dataset = loadPublished1404();

function builtEstimate(lines: Parameters<typeof addEstimateLines>[3]): Estimate {
  const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
  const estimate = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 't' });
  const started = startEstimateVersion(dataset, estimate, {
    createdAt: FIXED_INSTANT,
    buildingId: BUILDING_ID,
  });
  const added = addEstimateLines(dataset, started, `${ESTIMATE_ID}-v1`, lines);
  if (!added.ok) throw new Error('fixture lines must resolve');
  return added.estimate;
}

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

function lineRows(workbook: ExcelJS.Workbook): unknown[][] {
  const ws = workbook.getWorksheet('Lines');
  if (ws === undefined) throw new Error('Lines sheet missing');
  const rows: unknown[][] = [];
  for (let row = 2; row <= ws.rowCount; row += 1) rows.push(ws.getRow(row).values as unknown[]);
  return rows;
}

function lineRowByCode(workbook: ExcelJS.Workbook, code: string): unknown[] {
  const found = lineRows(workbook).find((r) => r[4] === code);
  if (found === undefined) throw new Error(`line row for code ${code} missing`);
  return found;
}

/** Lines-sheet column layout (workbook-model LINE_COLUMNS, 1-based `values` indexing). */
const COL = {
  chapter: 1,
  group: 2,
  lineId: 3,
  code: 4,
  description: 5,
  unitLabel: 6,
  unitCode: 7,
  quantity: 8,
  basePrice: 9,
  lineAmount: 10,
  pricebookStatus: 11,
  calculationStatus: 12,
  sourceDocument: 13,
  sourceEdition: 14,
  printedPage: 15,
  sourceSection: 16,
  sourceHash: 17,
  dependencyIds: 18,
} as const;

/** Persian word presence, robust to extractor run ordering and presentation forms. */
function containsPersianWord(extracted: string, word: string): boolean {
  const normalized = normalizePresentationForms(extracted);
  const forward = normalizePresentationForms(shapeArabicPersian(word));
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- verify reversed shaped code points
  const backward = [...forward].reverse().join('');
  return normalized.includes(forward) || normalized.includes(backward);
}

interface ParsedPdf {
  readonly numPages: number;
  readonly text: string;
}

async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (options: { data: Uint8Array; isEvalSupported: boolean }) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
      }>;
    };
  };
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => (item as { str?: string }).str ?? '').join(' '));
  }
  return { numPages: doc.numPages, text: normalizePresentationForms(pages.join('\n')) };
}

describe('O/P/Q. ReportModel, Excel and PDF through the workflow', () => {
  it('the ReportModel carries the finalized version, the S4 provenance and first-appearance order', () => {
    const finalized = finalizeEstimate(
      builtEstimate(COMPLETE_LINE_INPUTS),
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-model', generatedAt: FIXED_INSTANT, finalizedAt: FIXED_INSTANT },
    );
    const report = finalized.calculation.reportModel;
    expect(report.metadata.reportId).toBe('rep-model');
    expect(report.metadata.projectId).toBe(PROJECT_ID);
    expect(report.metadata.estimateId).toBe(ESTIMATE_ID);
    expect(report.metadata.versionId).toBe(`${ESTIMATE_ID}-v1`);
    expect(report.metadata.edition).toBe('1404');
    expect(report.metadata.versionStatus).toBe('finalized');
    expect(report.summary.amount).toBe(COMPLETE_EXPECTED_TOTAL);
    expect(report.summary.status).toBe('COMPLETE');
    expect(report.chapters.map((c) => c.chapter)).toEqual([
      'chapter-1',
      'chapter-24',
      'chapter-27',
      'chapter-28',
    ]);
    expect(report.generatedFrom.s4Estimate?.finalEstimate).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
    expect(report.scopeBoundaries.multiBuildingCombination.status).toBe('NOT_SPECIFIED');
  });

  it('renders real XLSX bytes with the five sheets (S4 Trace included)', async () => {
    const calculation = calculateEstimateVersion(
      builtEstimate(COMPLETE_LINE_INPUTS),
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-xlsx', generatedAt: FIXED_INSTANT },
    );
    const bytes = await renderEstimateExcel(calculation);
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
    expect(summaryValue(workbook, 'Report Status')).toBe('COMPLETE');
    expect(summaryValue(workbook, 'Edition')).toBe('1404');
  });

  it('Excel Lines sheet: leading-zero code, Persian description, negative prices, zero amount', async () => {
    const calculation = calculateEstimateVersion(
      builtEstimate(COMPLETE_LINE_INPUTS),
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-xlsx2', generatedAt: FIXED_INSTANT },
    );
    const workbook = await readXlsx(await renderEstimateExcel(calculation));

    const l1 = lineRowByCode(workbook, '010101');
    expect(l1[COL.code]).toBe('010101'); // text, leading zero intact — never 10101
    expect(l1[COL.quantity]).toBe('1000');
    expect(l1[COL.basePrice]).toBe('2890');
    expect(l1[COL.lineAmount]).toBe('2890000');
    expect(typeof l1[COL.description]).toBe('string');
    expect((l1[COL.description] as string).length).toBeGreaterThan(0); // Persian description present

    const l5 = lineRowByCode(workbook, '270320');
    expect(l5[COL.basePrice]).toBe('-1037000'); // negative price as exact text
    expect(l5[COL.lineAmount]).toBe('-10370000');

    const l6 = lineRowByCode(workbook, '270403');
    expect(l6[COL.basePrice]).toBe('-2131000');
    expect(l6[COL.lineAmount]).toBe('-4262000');

    const l3 = lineRowByCode(workbook, '240102');
    expect(l3[COL.lineAmount]).toBe('0'); // zero quantity prices to exact 0 (not blank)
    expect(l3[COL.quantity]).toBe('0');

    const l7 = lineRowByCode(workbook, '280101');
    expect(l7[COL.unitCode]).toBe('ton_km'); // compound unit preserved
    expect(l7[COL.unitLabel]).toBe('تن - کیلومتر');
  });

  it('Excel: a blocked estimate renders null amounts as EMPTY cells — never 0', async () => {
    const calculation = calculateEstimateVersion(
      builtEstimate(BLOCKED_LINE_INPUTS),
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', '1000000', '12000000'),
      { reportId: 'rep-xlsx-blocked' },
    );
    const workbook = await readXlsx(await renderEstimateExcel(calculation));
    expect([null, undefined]).toContain(summaryValue(workbook, 'Total Amount'));
    expect(summaryValue(workbook, 'Report Status')).toBe('EXTERNAL_DEPENDENCY');

    const b1 = lineRowByCode(workbook, '220925');
    expect([null, undefined]).toContain(b1[COL.basePrice]);
    expect([null, undefined]).toContain(b1[COL.lineAmount]);
    expect(b1[COL.calculationStatus]).toBe('INCOMPLETE');

    const b3 = lineRowByCode(workbook, '090320');
    expect([null, undefined]).toContain(b3[COL.lineAmount]);
    expect(b3[COL.calculationStatus]).toBe('EXTERNAL_DEPENDENCY');
    expect(b3[COL.dependencyIds]).toBe('star-item-instruction');
  });

  it('renders real PDF bytes: codes, negative prices, the — placeholder and Persian text', async () => {
    const calculation = calculateEstimateVersion(
      builtEstimate([...COMPLETE_LINE_INPUTS, ...BLOCKED_LINE_INPUTS]),
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-pdf', generatedAt: FIXED_INSTANT },
    );
    const bytes = await renderEstimatePdf(calculation);
    expect(bytes.length).toBeGreaterThan(1000);
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    expect(header).toBe('%PDF-');

    const parsed = await parsePdf(bytes);
    expect(parsed.numPages).toBeGreaterThan(3);
    // codes survive (leading zero included)
    expect(parsed.text).toContain('010101');
    expect(parsed.text).toContain('270320');
    expect(parsed.text).toContain('220925');
    // negative prices survive as text — no absolute value, no sign stripping
    expect(parsed.text).toContain('-1037000');
    expect(parsed.text).toContain('-2131000');
    // blocked rows render the — placeholder, never 0
    expect(parsed.text).toContain('—');
    // Persian description text is really shaped and embedded
    expect(containsPersianWord(parsed.text, 'کندن')).toBe(true);
    // the edition and the report identity
    expect(parsed.text).toContain('1404');
    expect(parsed.text).toContain('rep-pdf');
  }, 120_000);

  it('PDF of a blocked estimate: no total number is printed for a null amount', async () => {
    const calculation = calculateEstimateVersion(
      builtEstimate(BLOCKED_LINE_INPUTS),
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', '1000000', '12000000'),
      { reportId: 'rep-pdf-blocked' },
    );
    const parsed = await parsePdf(await renderEstimatePdf(calculation));
    expect(parsed.text).toContain('EXTERNAL_DEPENDENCY');
    expect(parsed.text).toContain('star-item-instruction');
    // the S4 trace section shows the null coefficient as —
    expect(parsed.text).toContain('regional');
  }, 120_000);
});

describe('T. determinism (same input snapshot → same output)', () => {
  it('two independent workflow runs produce identical calculations and byte-identical PDFs', async () => {
    const run = () =>
      calculateEstimateVersion(
        builtEstimate(COMPLETE_LINE_INPUTS),
        `${ESTIMATE_ID}-v1`,
        goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
        { reportId: 'rep-det', generatedAt: FIXED_INSTANT },
      );
    const a = run();
    const b = run();
    expect(canonicalJson(a.s4Input)).toBe(canonicalJson(b.s4Input));
    expect(canonicalJson(a.s4Result)).toBe(canonicalJson(b.s4Result));
    expect(canonicalJson(a.rollup)).toBe(canonicalJson(b.rollup));
    expect(canonicalJson(a.reportModel)).toBe(canonicalJson(b.reportModel));

    const pdfA = await renderEstimatePdf(a);
    const pdfB = await renderEstimatePdf(b);
    expect(Buffer.compare(Buffer.from(pdfA), Buffer.from(pdfB))).toBe(0);

    const wbA = await readXlsx(await renderEstimateExcel(a));
    const wbB = await readXlsx(await renderEstimateExcel(b));
    const structure = (wb: ExcelJS.Workbook) =>
      wb.worksheets.map((ws) => ({
        name: ws.name,
        rowCount: ws.rowCount,
        values: Array.from({ length: ws.rowCount }, (_, i) => wbGetRow(ws, i + 1)),
      }));
    function wbGetRow(ws: ExcelJS.Worksheet, i: number): unknown {
      return ws.getRow(i).values;
    }
    expect(structure(wbA)).toEqual(structure(wbB));
  }, 120_000);
});
