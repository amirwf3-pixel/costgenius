import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { ReportModel } from '@costgenius/reporting';
import { ReportingExcelError, renderReportToXlsx } from '../src/index.js';
import { goldenS4Result, loadPublished1404, makeLine, makeLineOn, makeReport } from './helpers.js';

/** COMPLETE report: 990001 ×10 m3 = 10,000 + 990002 ×2 each = 1,000 → total 11,000. */
function completeReport(): ReportModel {
  return makeReport([makeLine('l1', '990001', '10', 'm3'), makeLine('l2', '990002', '2', 'each')]);
}

async function render(report: ReportModel): Promise<Uint8Array> {
  return renderReportToXlsx(report);
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

function cellValue(workbook: ExcelJS.Workbook, sheet: string, row: number, col: number): unknown {
  return worksheet(workbook, sheet).getRow(row).getCell(col).value;
}

/** Value of a Summary key–value entry (scans column A for the field name). */
function summaryValue(workbook: ExcelJS.Workbook, field: string): unknown {
  const ws = worksheet(workbook, 'Summary');
  for (let row = 1; row <= ws.rowCount; row += 1) {
    if (ws.getRow(row).getCell(1).value === field) {
      return ws.getRow(row).getCell(2).value;
    }
  }
  throw new Error(`summary field "${field}" missing`);
}

/** Full read-back structure of a workbook, for determinism comparison. */
function structureOf(workbook: ExcelJS.Workbook): unknown {
  return workbook.worksheets.map((ws) => ({
    name: ws.name,
    rowCount: ws.rowCount,
    values: Array.from({ length: ws.rowCount }, (_, i) => ws.getRow(i + 1).values),
  }));
}

describe('rendering and round-trip', () => {
  it('renders real XLSX bytes (non-empty, ZIP magic "PK")', async () => {
    const bytes = await render(completeReport());
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
  });

  it('read-back: the four base sheets exist in fixed order', async () => {
    const workbook = await readXlsx(await render(completeReport()));
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'Summary',
      'Chapters',
      'Groups',
      'Lines',
    ]);
  });

  it('read-back: Lines has a bold header row and one row per ReportLine', async () => {
    const workbook = await readXlsx(await render(completeReport()));
    const ws = worksheet(workbook, 'Lines');
    expect(ws.rowCount).toBe(3); // header + 2 lines
    expect(ws.getRow(1).getCell(4).value).toBe('Code');
    expect(ws.getRow(1).getCell(10).value).toBe('Line Amount');
    expect(ws.getRow(1).getCell(4).font).toMatchObject({ bold: true });
    expect(ws.getRow(2).getCell(3).value).toBe('l1');
    expect(ws.getRow(3).getCell(3).value).toBe('l2');
  });

  it('read-back: Lines is frozen and auto-filtered', async () => {
    const workbook = await readXlsx(await render(completeReport()));
    const lines = worksheet(workbook, 'Lines');
    expect(lines.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(lines.autoFilter).toBeDefined();
    const chapters = worksheet(workbook, 'Chapters');
    expect(chapters.views[0]).toMatchObject({ state: 'frozen' });
    expect(chapters.autoFilter).toBeDefined();
  });

  it('read-back: leading-zero code stays the exact string "0990007"', async () => {
    const report = makeReport([makeLine('lz', '0990007', '3', 'm3')]);
    const workbook = await readXlsx(await render(report));
    expect(cellValue(workbook, 'Lines', 2, 4)).toBe('0990007');
  });

  it('read-back: Persian unit label and description survive exactly', async () => {
    const workbook = await readXlsx(await render(completeReport()));
    expect(cellValue(workbook, 'Lines', 2, 6)).toBe('مترمکعب');
    expect(cellValue(workbook, 'Lines', 2, 7)).toBe('m3');
    expect(cellValue(workbook, 'Lines', 2, 5)).toBe('SYNTHETIC test row 990001');
  });

  it('read-back: quantity "-15" and amount "0" stay text; pending amount reads back null', async () => {
    const report = makeReport([
      makeLine('a', '990001', '-15', 'm3'),
      makeLine('b', '990001', '0', 'm3'),
      makeLine('c', '990003', '5', 'm3'),
    ]);
    const workbook = await readXlsx(await render(report));
    expect(cellValue(workbook, 'Lines', 2, 8)).toBe('-15');
    expect(cellValue(workbook, 'Lines', 3, 8)).toBe('0');
    expect(cellValue(workbook, 'Lines', 3, 10)).toBe('0'); // zero ≠ null
    expect(cellValue(workbook, 'Lines', 4, 10)).toBe(null); // pending ≠ 0
  });

  it('read-back: negative amount stays visibly negative; base price exact', async () => {
    const report = makeReport([makeLine('a', '990001', '-15', 'm3')]);
    const workbook = await readXlsx(await render(report));
    expect(cellValue(workbook, 'Lines', 2, 9)).toBe('1000');
    expect(cellValue(workbook, 'Lines', 2, 10)).toBe('-15000');
  });

  it('read-back: both statuses and the joined dependency ids survive', async () => {
    const report = makeReport([
      makeLine('a', '990006', '1', 'm3'),
      makeLine('b', '990003', '1', 'm3'),
    ]);
    const workbook = await readXlsx(await render(report));
    expect(cellValue(workbook, 'Lines', 2, 11)).toBe('EXTERNAL_DEPENDENCY');
    expect(cellValue(workbook, 'Lines', 2, 12)).toBe('EXTERNAL_DEPENDENCY');
    expect(cellValue(workbook, 'Lines', 2, 18)).toBe(
      'regional-coefficient-circular-94-69416; supervision-circular',
    );
    expect(cellValue(workbook, 'Lines', 3, 11)).toBe('INCOMPLETE');
  });

  it('read-back: Summary total is the exact text; pending report total reads back null', async () => {
    const workbook = await readXlsx(await render(completeReport()));
    expect(summaryValue(workbook, 'Total Amount')).toBe('11000');
    expect(summaryValue(workbook, 'Report Status')).toBe('COMPLETE');
    expect(summaryValue(workbook, 'Version Number')).toBe(1); // integer cell

    const pending = makeReport([
      makeLine('ok', '990001', '10', 'm3'),
      makeLine('p', '990004', '5', 'm3'),
    ]);
    const pendingWorkbook = await readXlsx(await render(pending));
    expect(summaryValue(pendingWorkbook, 'Total Amount')).toBe(null);
    expect(summaryValue(pendingWorkbook, 'Report Status')).toBe('EXTERNAL_DEPENDENCY');
  });

  it('read-back: scope boundaries are shown verbatim from the model', async () => {
    const workbook = await readXlsx(await render(completeReport()));
    expect(summaryValue(workbook, 'Multi-Building Combination')).toBe('NOT_SPECIFIED');
    expect(summaryValue(workbook, 'Multi-Discipline Combination')).toBe('NOT_SPECIFIED');
    expect(String(summaryValue(workbook, 'Multi-Building Combination — Note'))).toContain(
      'no method for combining',
    );
  });

  it('read-back: the S4 Trace sheet preserves the golden chain (P 1.0451, overhead 1.30, site setup separate)', async () => {
    const report = makeReport(
      [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
      { buildingId: 'b-golden', s4Estimate: goldenS4Result() },
    );
    const workbook = await readXlsx(await render(report));
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'Summary',
      'Chapters',
      'Groups',
      'Lines',
      'S4 Trace',
    ]);
    const s4 = worksheet(workbook, 'S4 Trace');
    // key–value block (rows 1..7), blank separator (8), header (9), stages (10..14)
    expect(s4.getRow(1).getCell(1).value).toBe('S4 Estimate ID');
    expect(s4.getRow(1).getCell(2).value).toBe('est-1');
    expect(s4.getRow(4).getCell(2).value).toBe('1544493'); // Final Estimate
    expect(s4.getRow(9).getCell(1).value).toBe('Stage');
    expect(s4.getRow(11).getCell(1).value).toBe('floor');
    expect(s4.getRow(11).getCell(5).value).toBe('1.0451');
    expect(s4.getRow(11).getCell(2).value).toBe('IR-1404-E-FLOOR-01..03');
    expect(s4.getRow(12).getCell(1).value).toBe('overhead');
    expect(s4.getRow(12).getCell(5).value).toBe('1.30');
    expect(s4.getRow(14).getCell(1).value).toBe('site-setup'); // separate additive stage
    expect(s4.getRow(14).getCell(2).value).toBe('IR-1404-E-SITE-01');
    expect(s4.getRow(14).getCell(4).value).toBe('1494493'); // input = post-regional value
  });

  it('read-back: a real 1404 report keeps the official source identity (edition and Persian document)', async () => {
    const published = loadPublished1404();
    const line = makeLineOn(published);
    const report = makeReport([line('r1', '280101', '10', 'ton_km')], { estimateId: 'est-1404' });
    const workbook = await readXlsx(await render(report));
    expect(summaryValue(workbook, 'Edition')).toBe('1404');
    expect(cellValue(workbook, 'Lines', 2, 4)).toBe('280101');
    expect(cellValue(workbook, 'Lines', 2, 13)).toBe('فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴');
    expect(cellValue(workbook, 'Lines', 2, 14)).toBe('1404');
  });

  it('renders an empty version honestly: total "0" (text) and a header-only Lines sheet', async () => {
    const report = makeReport([]);
    const workbook = await readXlsx(await render(report));
    expect(summaryValue(workbook, 'Total Amount')).toBe('0');
    expect(summaryValue(workbook, 'Line Count')).toBe(0);
    expect(worksheet(workbook, 'Lines').rowCount).toBe(1); // header only
  });
});

describe('safety and immutability', () => {
  it('does not mutate the ReportModel (content identical, still deeply frozen)', async () => {
    const report = completeReport();
    const before = JSON.stringify(report);
    await render(report);
    expect(JSON.stringify(report)).toBe(before);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.summary)).toBe(true);
    expect(Object.isFrozen(report.chapters[0]?.groups[0]?.lines[0])).toBe(true);
    expect(() => {
      (report.summary as { amount: string | null }).amount = '1';
    }).toThrow();
  });

  it('is deterministic: rendering twice yields the identical read-back structure', async () => {
    const report = makeReport([
      makeLine('a', '990001', '10', 'm3'),
      makeLine('b', '990006', '2', 'm3'),
      makeLine('c', '0990007', '3', 'm3'),
    ]);
    const first = structureOf(await readXlsx(await render(report)));
    const second = structureOf(await readXlsx(await render(report)));
    expect(second).toEqual(first);
  });

  it('is BYTE-deterministic across a DOS-timestamp boundary (no wall clock in the zip)', async () => {
    const report = makeReport([
      makeLine('a', '990001', '10', 'm3'),
      makeLine('b', '990006', '2', 'm3'),
      makeLine('c', '0990007', '3', 'm3'),
    ]);
    const first = await render(report);
    // Wait past the 2-second DOS timestamp granularity: without pinned entry dates the
    // second render's container bytes would differ (the Phase 17 bug this guards against).
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const second = await render(report);
    expect(Buffer.compare(Buffer.from(second), Buffer.from(first))).toBe(0);
  });

  it('rejects an invalid report loudly instead of producing a workbook', async () => {
    const report = structuredClone(completeReport());
    const writable = report as unknown as {
      summary: { amount: string | null; status: string };
    };
    writable.summary = { ...writable.summary, amount: null, status: 'COMPLETE' };
    let caught: unknown;
    try {
      await render(report);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReportingExcelError);
    expect((caught as ReportingExcelError).code).toBe('INVALID_REPORT_MODEL');
  });
});

describe('renderer source hygiene (architecture scan as a permanent test)', () => {
  const SRC = new URL('../src/', import.meta.url);
  const sourceFiles = readdirSync(SRC).filter((file) => file.endsWith('.ts'));
  const contents = sourceFiles.map((file) => ({
    file,
    content: readFileSync(new URL(file, SRC), 'utf8'),
  }));

  it('scans the renderer production sources', () => {
    // sanity: the scan actually covers the renderer modules
    expect(sourceFiles).toEqual(
      expect.arrayContaining([
        'errors.ts',
        'types.ts',
        'workbook-model.ts',
        'render-xlsx.ts',
        'index.ts',
      ]),
    );
  });

  it('contains no pricebook access, recalculation, numeric coercion, clock or randomness', () => {
    const forbidden = [
      'PublishedDataset',
      'findRows',
      'rollupBoqLines',
      'parseFloat',
      'Math.abs',
      'Date.now',
      'Math.random',
      '|| 0',
      '?? 0',
      'Number(',
      '@costgenius/pricebook',
      '@costgenius/cost-calculation',
      '@costgenius/calc-engine',
      '@costgenius/domain',
    ];
    for (const { file, content } of contents) {
      for (const pattern of forbidden) {
        expect(content.includes(pattern), `${file} must not contain "${pattern}"`).toBe(false);
      }
    }
  });

  it('uses getRow only as the ExcelJS worksheet API, never a dataset lookup', () => {
    for (const { file, content } of contents) {
      for (const match of content.matchAll(/(\w+)\.getRow\(/g)) {
        expect(match[1], `${file}: only worksheet.getRow is allowed`).toBe('worksheet');
      }
    }
  });

  it('touches Date only as the fixed epoch constant (no clock read)', () => {
    for (const { file, content } of contents) {
      for (const match of content.matchAll(/new Date\(([^)]*)\)/g)) {
        expect(match[1], `${file}: only new Date(0) is allowed`).toBe('0');
      }
      expect(content.includes('Date.now'), `${file}: no clock reads`).toBe(false);
    }
  });

  it('imports only @costgenius/reporting, @costgenius/boq, exceljs and jszip (plus relative files)', () => {
    for (const { file, content } of contents) {
      for (const match of content.matchAll(/from '([^']+)'/g)) {
        const specifier: string = match[1] ?? '';
        const allowed =
          specifier.startsWith('./') ||
          specifier === '@costgenius/reporting' ||
          specifier === '@costgenius/boq' ||
          specifier === 'exceljs' ||
          // jszip re-zips the container with pinned entry dates (byte determinism,
          // Phase 17); it is a byte-level encoder dependency of the same layer as exceljs.
          specifier === 'jszip';
        expect(allowed, `${file}: unexpected import "${specifier}"`).toBe(true);
      }
    }
  });

  it('no lower layer imports @costgenius/reporting-excel (zero reverse dependencies)', () => {
    const lowerLayers = [
      'domain',
      'calc-engine',
      'pricebook',
      'cost-calculation',
      'boq',
      'reporting',
    ];
    for (const layer of lowerLayers) {
      const dir = new URL(`../../${layer}/src/`, import.meta.url);
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.ts')) continue;
        const content = readFileSync(new URL(file, dir), 'utf8');
        expect(
          content.includes('@costgenius/reporting-excel'),
          `${layer}/src/${file} must not import the renderer`,
        ).toBe(false);
      }
    }
  });
});
