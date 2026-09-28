import { describe, expect, it } from 'vitest';
import { combinedMultiBuildingRollup, combinedMultiDisciplineRollup } from '@costgenius/boq';
import type { ReportModel } from '@costgenius/reporting';
import {
  CELL_DELIMITER,
  ReportingExcelError,
  buildWorkbookModel,
  reportStructureErrors,
  type WorkbookCell,
  type WorkbookModel,
  type WorkbookSheetModel,
} from '../src/index.js';
import { goldenS4Result, makeLine, makeReport } from './helpers.js';

// ---- helpers -----------------------------------------------------------------------------------

function sheet(model: WorkbookModel, name: string): WorkbookSheetModel {
  const found = model.sheets.find((s) => s.name === name);
  if (found === undefined) throw new Error(`sheet "${name}" missing`);
  return found;
}

function entry(sheetModel: WorkbookSheetModel, field: string): WorkbookCell {
  const found = sheetModel.entries.find((e) => e.field === field);
  if (found === undefined) throw new Error(`entry "${field}" missing`);
  return found.cell;
}

function lineRows(model: WorkbookModel): readonly (readonly WorkbookCell[])[] {
  return sheet(model, 'Lines').table?.rows ?? [];
}

function expectText(cell: WorkbookCell | undefined, value: string): void {
  expect(cell).toEqual({ kind: 'text', value });
}
function expectInt(cell: WorkbookCell | undefined, value: number): void {
  expect(cell).toEqual({ kind: 'integer', value });
}
function expectEmpty(cell: WorkbookCell | undefined): void {
  expect(cell).toEqual({ kind: 'empty' });
}

/** Recursively-writable view, for corrupting an unfrozen clone in tests. */
type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };
const corrupt = <T>(value: T): Writable<T> => structuredClone(value);

function expectInvalid(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportingExcelError);
  expect((caught as ReportingExcelError).code).toBe('INVALID_REPORT_MODEL');
  expect((caught as ReportingExcelError).details?.length ?? 0).toBeGreaterThan(0);
}

/** COMPLETE report: 990001 ×10 m3 = 10,000 + 990002 ×2 each = 1,000 → total 11,000. */
function completeReport(): ReportModel {
  return makeReport([makeLine('l1', '990001', '10', 'm3'), makeLine('l2', '990002', '2', 'each')]);
}

// ---- A. workbook structure -----------------------------------------------------------------------

describe('workbook structure', () => {
  it('has exactly the four base sheets in fixed order (no S4 result)', () => {
    const model = buildWorkbookModel(completeReport());
    expect(model.sheets.map((s) => s.name)).toEqual(['Summary', 'Chapters', 'Groups', 'Lines']);
  });

  it('adds the S4 Trace sheet as the fifth sheet when the report carries an S4 result', () => {
    const s4 = goldenS4Result();
    const report = makeReport(
      [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
      { buildingId: 'b-golden', s4Estimate: s4 },
    );
    const model = buildWorkbookModel(report);
    expect(model.sheets.map((s) => s.name)).toEqual([
      'Summary',
      'Chapters',
      'Groups',
      'Lines',
      'S4 Trace',
    ]);
  });

  it('is deterministic: the same report builds the same model twice', () => {
    const report = completeReport();
    expect(buildWorkbookModel(report)).toEqual(buildWorkbookModel(report));
  });
});

// ---- B. summary sheet ------------------------------------------------------------------------------

describe('summary sheet', () => {
  it('preserves the report metadata entries', () => {
    const report = makeReport([makeLine('l1', '990001', '10', 'm3')], {
      generatedAt: '2026-03-04T00:00:00Z',
      buildingId: 'b-7',
    });
    const summary = sheet(buildWorkbookModel(report), 'Summary');
    expectText(entry(summary, 'Report ID'), 'rep-1');
    expectText(entry(summary, 'Estimate ID'), 'est-1');
    expectText(entry(summary, 'Version ID'), 'est-1-v1');
    expectInt(entry(summary, 'Version Number'), 1);
    expectText(entry(summary, 'Project ID'), 'proj-1');
    expectText(entry(summary, 'Title'), 'SYNTHETIC estimate');
    expectText(entry(summary, 'Edition'), 'SYN');
    expectText(entry(summary, 'Version Status'), 'draft');
    expectText(entry(summary, 'Created At'), '2026-01-01T00:00:00Z');
    expectText(entry(summary, 'Generated At'), '2026-03-04T00:00:00Z');
    expectText(entry(summary, 'Building ID'), 'b-7');
  });

  it('copies the total exactly as a text cell (no numeric conversion)', () => {
    const summary = sheet(buildWorkbookModel(completeReport()), 'Summary');
    expectText(entry(summary, 'Total Amount'), '11000');
    expectText(entry(summary, 'Report Status'), 'COMPLETE');
  });

  it('keeps a pending total as an EMPTY cell — never 0, never a number', () => {
    for (const code of ['990003', '990004', '990005']) {
      const report = makeReport([
        makeLine('ok', '990001', '10', 'm3'),
        makeLine('pending', code, '5', 'm3'),
      ]);
      const summary = sheet(buildWorkbookModel(report), 'Summary');
      expectEmpty(entry(summary, 'Total Amount'));
      expect(entry(summary, 'Total Amount').kind).not.toBe('integer');
    }
  });

  it('preserves line counts as integers and the dependency summary', () => {
    const report = makeReport([
      makeLine('l1', '990004', '5', 'm3'),
      makeLine('l2', '990006', '2', 'm3'),
    ]);
    const summary = sheet(buildWorkbookModel(report), 'Summary');
    expectInt(entry(summary, 'Line Count'), 2);
    expectInt(entry(summary, 'Priced Line Count'), 0);
    expectInt(entry(summary, 'Pending Line Count'), 2);
    expectInt(entry(summary, 'Dependency Count'), 2);
    expectText(
      entry(summary, 'Dependency IDs'),
      `regional-coefficient-circular-94-69416${CELL_DELIMITER}supervision-circular`,
    );
  });

  it('preserves the scope boundaries verbatim (NOT_SPECIFIED, BOQ statements)', () => {
    const summary = sheet(buildWorkbookModel(completeReport()), 'Summary');
    expectText(entry(summary, 'Multi-Building Combination'), 'NOT_SPECIFIED');
    expectText(
      entry(summary, 'Multi-Building Combination — Note'),
      combinedMultiBuildingRollup().message,
    );
    expectText(entry(summary, 'Multi-Discipline Combination'), 'NOT_SPECIFIED');
    expectText(
      entry(summary, 'Multi-Discipline Combination — Note'),
      combinedMultiDisciplineRollup().message,
    );
  });
});

// ---- C. chapters sheet -------------------------------------------------------------------------------

describe('chapters sheet', () => {
  it('preserves chapter order as first appearance (never alphabetical)', () => {
    const report = makeReport([
      makeLine('a', '990008', '1', 'm2'), // zz-syn-chapter (sorts AFTER chapter-99)
      makeLine('b', '990001', '10', 'm3'), // chapter-99
    ]);
    const rows = sheet(buildWorkbookModel(report), 'Chapters').table?.rows ?? [];
    expect(rows.map((r) => r[0])).toEqual([
      { kind: 'text', value: 'zz-syn-chapter' },
      { kind: 'text', value: 'chapter-99' },
    ]);
  });

  it('preserves chapter status and amount from the model', () => {
    const model = buildWorkbookModel(completeReport());
    const rows = sheet(model, 'Chapters').table?.rows ?? [];
    expect(rows).toHaveLength(1);
    expectText(rows[0]?.[1], 'COMPLETE');
    expectText(rows[0]?.[5], '11000');
  });

  it('keeps a pending chapter amount EMPTY (never 0)', () => {
    const report = makeReport([
      makeLine('ok', '990001', '10', 'm3'),
      makeLine('pending', '990003', '5', 'm3'),
    ]);
    const rows = sheet(buildWorkbookModel(report), 'Chapters').table?.rows ?? [];
    expectEmpty(rows[0]?.[5]);
    expectText(rows[0]?.[1], 'INCOMPLETE');
  });

  it('preserves chapter counts as integers', () => {
    const report = makeReport([
      makeLine('a', '990008', '1', 'm2'),
      makeLine('b', '990001', '10', 'm3'),
      makeLine('c', '990003', '5', 'm3'),
    ]);
    const rows = sheet(buildWorkbookModel(report), 'Chapters').table?.rows ?? [];
    expectInt(rows[0]?.[2], 1);
    expectInt(rows[0]?.[3], 1);
    expectInt(rows[0]?.[4], 0);
    expectInt(rows[1]?.[2], 2);
    expectInt(rows[1]?.[3], 1);
    expectInt(rows[1]?.[4], 1);
  });
});

// ---- D. groups sheet -----------------------------------------------------------------------------------

describe('groups sheet', () => {
  it('preserves group order as first appearance (never sorted)', () => {
    const report = makeReport([
      makeLine('a', '990002', '2', 'each'), // chapter-99, group 2 (appears first)
      makeLine('b', '990001', '10', 'm3'), // chapter-99, group 1
    ]);
    const rows = sheet(buildWorkbookModel(report), 'Groups').table?.rows ?? [];
    expect(rows.map((r) => r[1])).toEqual([
      { kind: 'text', value: '2' },
      { kind: 'text', value: '1' },
    ]);
  });

  it('preserves group status and amount from the model', () => {
    const report = makeReport([
      makeLine('a', '990002', '2', 'each'), // group 2 → COMPLETE 1000
      makeLine('b', '990001', '10', 'm3'), // group 1 → COMPLETE 10000
      makeLine('c', '990003', '5', 'm3'), // group 1 → pending
    ]);
    const rows = sheet(buildWorkbookModel(report), 'Groups').table?.rows ?? [];
    expectText(rows[0]?.[2], 'COMPLETE');
    expectText(rows[0]?.[6], '1000');
    expectText(rows[1]?.[2], 'INCOMPLETE');
    expectEmpty(rows[1]?.[6]);
  });

  it('preserves group counts and chapter attribution', () => {
    const report = makeReport([
      makeLine('a', '990002', '2', 'each'),
      makeLine('b', '990003', '5', 'm3'),
    ]);
    const rows = sheet(buildWorkbookModel(report), 'Groups').table?.rows ?? [];
    expect(rows.map((r) => r[0])).toEqual([
      { kind: 'text', value: 'chapter-99' },
      { kind: 'text', value: 'chapter-99' },
    ]);
    expectInt(rows[0]?.[3], 1); // group 2 lineCount
    expectInt(rows[1]?.[5], 1); // group 1 pending count
  });
});

// ---- E. lines sheet --------------------------------------------------------------------------------------

describe('lines sheet', () => {
  it('carries exactly one row per ReportLine, in report order', () => {
    const report = makeReport([
      makeLine('a', '990008', '1', 'm2'),
      makeLine('b', '990001', '10', 'm3'),
      makeLine('c', '990002', '2', 'each'),
    ]);
    const rows = lineRows(buildWorkbookModel(report));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r[2])).toEqual([
      { kind: 'text', value: 'a' },
      { kind: 'text', value: 'b' },
      { kind: 'text', value: 'c' },
    ]);
  });

  it('preserves a leading-zero code as text', () => {
    const report = makeReport([makeLine('lz', '0990007', '3', 'm3')]);
    const row = lineRows(buildWorkbookModel(report))[0];
    expectText(row?.[3], '0990007');
  });

  it('preserves the unit exactly (printed label + code)', () => {
    const report = makeReport([makeLine('u', '990001', '1', 'm3')]);
    const row = lineRows(buildWorkbookModel(report))[0];
    expectText(row?.[5], 'مترمکعب');
    expectText(row?.[6], 'm3');
  });

  it('preserves quantities exactly (negative, zero, decimal)', () => {
    const report = makeReport([
      makeLine('a', '990001', '-15', 'm3'),
      makeLine('b', '990001', '0', 'm3'),
      makeLine('c', '990001', '10.5', 'm3'),
    ]);
    const rows = lineRows(buildWorkbookModel(report));
    expectText(rows[0]?.[7], '-15');
    expectText(rows[1]?.[7], '0');
    expectText(rows[2]?.[7], '10.5');
  });

  it('preserves base prices (value and null)', () => {
    const report = makeReport([
      makeLine('a', '990001', '10', 'm3'),
      makeLine('b', '990003', '5', 'm3'),
    ]);
    const rows = lineRows(buildWorkbookModel(report));
    expectText(rows[0]?.[8], '1000');
    expectEmpty(rows[1]?.[8]);
  });

  it('preserves negative, zero and null line amounts exactly', () => {
    const report = makeReport([
      makeLine('a', '990001', '-15', 'm3'),
      makeLine('b', '990001', '0', 'm3'),
      makeLine('c', '990003', '5', 'm3'),
    ]);
    const rows = lineRows(buildWorkbookModel(report));
    expectText(rows[0]?.[9], '-15000');
    expectText(rows[1]?.[9], '0');
    expectEmpty(rows[2]?.[9]);
  });

  it('preserves both statuses per line', () => {
    const report = makeReport([
      makeLine('a', '990001', '1', 'm3'),
      makeLine('b', '990003', '1', 'm3'),
      makeLine('c', '990004', '1', 'm3'),
      makeLine('d', '990005', '1', 'm3'),
    ]);
    const rows = lineRows(buildWorkbookModel(report));
    expectText(rows[0]?.[10], 'VERIFIED_SPEC_ONLY');
    expectText(rows[0]?.[11], 'COMPLETE');
    expectText(rows[1]?.[10], 'INCOMPLETE');
    expectText(rows[1]?.[11], 'INCOMPLETE');
    expectText(rows[2]?.[10], 'EXTERNAL_DEPENDENCY');
    expectText(rows[2]?.[11], 'EXTERNAL_DEPENDENCY');
    expectText(rows[3]?.[10], 'NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expectText(rows[3]?.[11], 'NOT_SPECIFIED');
  });

  it('preserves the source reference exactly (document, edition, page, section, null hash)', () => {
    const report = makeReport([makeLine('s', '990001', '1', 'm3')]);
    const row = lineRows(buildWorkbookModel(report))[0];
    expectText(row?.[12], 'SYNTHETIC TEST DATA');
    expectText(row?.[13], 'SYN');
    expectText(row?.[14], '1');
    expectText(row?.[15], 'SYN-1');
    expectEmpty(row?.[16]); // sourceFileHash null → empty, never a fake hash
  });

  it('preserves dependency ids verbatim, joined with the deterministic delimiter', () => {
    const report = makeReport([makeLine('d2', '990006', '1', 'm3')]);
    const row = lineRows(buildWorkbookModel(report))[0];
    expectText(
      row?.[17],
      `regional-coefficient-circular-94-69416${CELL_DELIMITER}supervision-circular`,
    );
  });

  it('preserves the structured trace fields (value and pending nulls)', () => {
    const report = makeReport([
      makeLine('a', '990001', '10', 'm3'),
      makeLine('b', '990003', '5', 'm3'),
    ]);
    const rows = lineRows(buildWorkbookModel(report));
    expectText(rows[0]?.[18], '10');
    expectText(rows[0]?.[19], '1000');
    expectText(rows[0]?.[20], 'multiply');
    expectText(rows[0]?.[21], '10000');
    expectText(rows[1]?.[18], '5');
    expectEmpty(rows[1]?.[19]);
    expectText(rows[1]?.[20], 'multiply');
    expectEmpty(rows[1]?.[21]);
  });

  it('preserves building and landscaping attribution (value or empty, never invented)', () => {
    const report = makeReport([
      makeLine('a', '990001', '1', 'm3', { buildingId: 'b-2', landscaping: true }),
      makeLine('b', '990002', '1', 'each'),
    ]);
    const rows = lineRows(buildWorkbookModel(report));
    expectText(rows[0]?.[22], 'b-2');
    expectText(rows[0]?.[23], 'true');
    expectEmpty(rows[1]?.[22]);
    expectEmpty(rows[1]?.[23]);
  });
});

// ---- F. S4 trace sheet ------------------------------------------------------------------------------------

describe('S4 trace sheet', () => {
  function s4Model(): WorkbookModel {
    const report = makeReport(
      [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
      { buildingId: 'b-golden', s4Estimate: goldenS4Result() },
    );
    return buildWorkbookModel(report);
  }

  it('preserves the S4 identity/status block and the final estimate', () => {
    const s4 = sheet(s4Model(), 'S4 Trace');
    expectText(entry(s4, 'S4 Estimate ID'), 'est-1');
    expectText(entry(s4, 'Building ID'), 'b-golden');
    expectText(entry(s4, 'Calculation Status'), 'COMPLETE');
    expectText(entry(s4, 'Final Estimate'), '1544493');
  });

  it('carries the five stages verbatim (P = 1.0451, overhead 1.30, site setup separate)', () => {
    const table = sheet(s4Model(), 'S4 Trace').table;
    if (table === undefined) throw new Error('S4 stage table missing');
    expect(table.rows).toHaveLength(5);
    expect(table.rows.map((r) => r[0])).toEqual([
      { kind: 'text', value: 'base-subtotal' },
      { kind: 'text', value: 'floor' },
      { kind: 'text', value: 'overhead' },
      { kind: 'text', value: 'regional' },
      { kind: 'text', value: 'site-setup' },
    ]);
    const floor = table.rows[1];
    expectText(floor?.[1], 'IR-1404-E-FLOOR-01..03');
    expectText(floor?.[4], '1.0451'); // golden P, exact string, never recomputed
    const overhead = table.rows[2];
    expectText(overhead?.[1], 'IR-1404-E-OVERHEAD-01');
    expectText(overhead?.[4], '1.30'); // verified clause 2-7-2 value, carried as-is
    const siteSetup = table.rows[4];
    expectText(siteSetup?.[1], 'IR-1404-E-SITE-01'); // separate additive stage
    expectText(siteSetup?.[3], '1494493'); // input = the post-regional value
  });
});

// ---- G. validation (fail loudly, never repair) -------------------------------------------------------------

describe('structural validation', () => {
  it('rejects a pending summary that carries an amount', () => {
    const report = corrupt(makeReport([makeLine('a', '990003', '5', 'm3')]));
    report.summary = { ...report.summary, amount: '999' };
    expectInvalid(() => buildWorkbookModel(report));
    expect(reportStructureErrors(report).some((e) => e.includes('summary.amount'))).toBe(true);
  });

  it('rejects a COMPLETE line whose amount was nulled', () => {
    const report = corrupt(completeReport());
    const group = report.chapters[0]?.groups[0];
    if (group === undefined) throw new Error('missing group');
    group.lines = group.lines.map((line) => ({ ...line, lineAmount: null }));
    expectInvalid(() => buildWorkbookModel(report));
  });

  it('rejects a line moved into the wrong group section', () => {
    const report = corrupt(
      makeReport([makeLine('a', '990001', '1', 'm3'), makeLine('b', '990002', '1', 'each')]),
    );
    const group2 = report.chapters[0]?.groups[1];
    if (group2 === undefined) throw new Error('missing group 2');
    group2.lines = group2.lines.map((line) =>
      line.lineId === 'b' ? { ...line, group: 'wrong-group' } : line,
    );
    expectInvalid(() => buildWorkbookModel(report));
  });

  it('rejects a dropped line (coverage/count mismatch)', () => {
    // both lines in the SAME group, so slicing the group really drops a line
    const report = corrupt(
      makeReport([makeLine('a', '990001', '10', 'm3'), makeLine('b', '990001', '2', 'm3')]),
    );
    const group = report.chapters[0]?.groups[0];
    if (group === undefined) throw new Error('missing group');
    expect(group.lines).toHaveLength(2);
    group.lines = group.lines.slice(0, 1);
    expectInvalid(() => buildWorkbookModel(report));
    expect(reportStructureErrors(report).some((e) => e.includes('summary.lineCount'))).toBe(true);
  });

  it('rejects identity garbage (empty reportId, missing chapters)', () => {
    const report = corrupt(completeReport());
    report.reportId = '';
    expect(reportStructureErrors(report).some((e) => e.includes('reportId'))).toBe(true);

    const noChapters = corrupt(completeReport());
    (noChapters as { chapters: unknown }).chapters = undefined;
    expectInvalid(() => buildWorkbookModel(noChapters));
  });

  it('rejects an S4 result from a different estimate', () => {
    const report = corrupt(
      makeReport(
        [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
        { buildingId: 'b-golden', s4Estimate: goldenS4Result() },
      ),
    );
    const s4 = report.generatedFrom.s4Estimate;
    if (s4 === null) throw new Error('expected an s4 result');
    report.generatedFrom = {
      ...report.generatedFrom,
      s4Estimate: { ...s4, estimateId: 'other' },
    };
    expectInvalid(() => buildWorkbookModel(report));
  });

  it('rejects broken dependency attribution in the summary', () => {
    const report = corrupt(makeReport([makeLine('a', '990004', '5', 'm3')]));
    report.summary = {
      ...report.summary,
      dependencies: [{ id: 'regional-coefficient-circular-94-69416', lineIds: ['ghost-line'] }],
    };
    expectInvalid(() => buildWorkbookModel(report));
    expect(reportStructureErrors(report).some((e) => e.includes('ghost-line'))).toBe(true);
  });

  it('rejects a summary that omits a dependency the lines carry', () => {
    const report = corrupt(makeReport([makeLine('a', '990004', '5', 'm3')]));
    report.summary = { ...report.summary, dependencies: [] };
    expectInvalid(() => buildWorkbookModel(report));
  });
});
