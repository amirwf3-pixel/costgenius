import { describe, expect, it } from 'vitest';
import { getVersion, rollupBoqLines, type BoqLine } from '@costgenius/boq';
import { buildReportModel, type ReportModel } from '../src/index.js';
import {
  loadPublished1404,
  makeEstimate,
  makeLine,
  syntheticDataset,
  syntheticDatasetAltPrice,
} from './helpers.js';

const published = loadPublished1404();
const synthetic = syntheticDataset();

/** The verified 1404 four-line set: chapter-28 = 505,400; appendix-1 = 18,913,000; total 19,418,400. */
function verifiedLines(): BoqLine[] {
  return [
    makeLine(published, 'l1', '280101', '10', 'ton_km'), // chapter-28, group 1 → 284,000
    makeLine(published, 'l2', '280501', '2', 'ton_nautical_mile'), // chapter-28, group 5 → 221,400
    makeLine(published, 'l3', '410202', '3', 'm3'), // appendix-1, table-2 → 16,773,000
    makeLine(published, 'l4', '410701', '100', 'each'), // appendix-1, table-2 → 2,140,000
  ];
}

function reportOf(
  lines: readonly BoqLine[],
  options?: Parameters<typeof makeEstimate>[1],
): {
  report: ReportModel;
  estimate: ReturnType<typeof makeEstimate>;
} {
  const estimate = makeEstimate(lines, options);
  const report = buildReportModel({ reportId: 'rep-1', estimate, versionId: 'est-1-v1' });
  return { report, estimate };
}

describe('report creation', () => {
  it('creates a report from a finalized BOQ version', () => {
    const { report } = reportOf(verifiedLines(), { finalize: true });
    expect(report.reportId).toBe('rep-1');
    expect(report.metadata.versionStatus).toBe('finalized');
    expect(report.summary.status).toBe('COMPLETE');
    expect(report.summary.amount).toBe('19418400');
    expect(report.chapters).toHaveLength(2);
  });

  it('preserves estimate and version metadata (ids, instants, building, version metadata)', () => {
    const { report } = reportOf([makeLine(synthetic, 'l1', '990001', '10', 'm3')], {
      buildingId: 'b-1',
      metadata: { costCenter: 'CC-9' },
      createdAt: '2026-02-03T04:05:06Z',
    });
    const m = report.metadata;
    expect(m).toMatchObject({
      reportId: 'rep-1',
      estimateId: 'est-1',
      versionId: 'est-1-v1',
      versionNumber: 1,
      projectId: 'proj-1',
      title: 'SYNTHETIC estimate',
      edition: 'SYN',
      versionStatus: 'draft',
      createdAt: '2026-02-03T04:05:06Z',
      generatedAt: null,
      buildingId: 'b-1',
    });
    expect(m.versionMetadata).toEqual({ costCenter: 'CC-9' });
  });

  it('preserves the caller-supplied generatedAt and the version status of a draft', () => {
    const estimate = makeEstimate([makeLine(synthetic, 'l1', '990001', '10', 'm3')]);
    const report = buildReportModel({
      reportId: 'rep-2',
      estimate,
      versionId: 'est-1-v1',
      generatedAt: '2026-03-04T00:00:00Z',
    });
    expect(report.metadata.generatedAt).toBe('2026-03-04T00:00:00Z');
    expect(report.metadata.versionStatus).toBe('draft');
    expect(report.generatedFrom.generatedAt).toBe('2026-03-04T00:00:00Z');
  });

  it('preserves the pricebook edition (synthetic SYN and real 1404)', () => {
    const { report: synReport } = reportOf([makeLine(synthetic, 'l1', '990001', '1', 'm3')]);
    expect(synReport.metadata.edition).toBe('SYN');

    const real = makeEstimate([makeLine(published, 'l1', '280101', '1', 'ton_km')], {
      estimateId: 'est-1404',
      edition: '1404', // the row's own sourceRef edition; editions are never mixed
    });
    const realReport = buildReportModel({
      reportId: 'rep-1404',
      estimate: real,
      versionId: 'est-1404-v1',
    });
    expect(realReport.metadata.edition).toBe('1404');
    expect(realReport.summary.edition).toBe('1404');
    for (const chapter of realReport.chapters) {
      for (const group of chapter.groups) {
        for (const line of group.lines) expect(line.edition).toBe('1404');
      }
    }
  });
});

describe('report lines', () => {
  it('represents every BOQ line exactly once, in version order', () => {
    const { report, estimate } = reportOf(verifiedLines());
    const version = getVersion(estimate, 'est-1-v1');
    const reportLineIds = report.chapters.flatMap((c) =>
      c.groups.flatMap((g) => g.lines.map((l) => l.lineId)),
    );
    expect(reportLineIds).toEqual(version.lines.map((l) => l.lineId));
    expect(report.summary.lineCount).toBe(4);
  });

  it('preserves exact source identity (code, chapter, group, description) from the row', () => {
    const { report } = reportOf(verifiedLines());
    const line = report.chapters[0]?.groups[0]?.lines[0];
    const row = published.rows.find((r) => r.code === '280101');
    expect(line).toMatchObject({
      pricebookCode: '280101',
      chapter: 'chapter-28',
      group: '1',
      description: row?.description,
    });
  });

  it('keeps duplicate pricebook codes as separate lines (identity is lineId)', () => {
    const lines = [
      makeLine(synthetic, 'a', '990001', '10', 'm3'),
      makeLine(synthetic, 'b', '990001', '-15', 'm3'),
    ];
    const { report } = reportOf(lines);
    const reportLines = report.chapters[0]?.groups[0]?.lines ?? [];
    expect(reportLines.map((l) => l.lineId)).toEqual(['a', 'b']);
    expect(reportLines.every((l) => l.pricebookCode === '990001')).toBe(true);
  });

  it('preserves the unit (printed label verbatim + domain code)', () => {
    const { report } = reportOf([makeLine(synthetic, 'l1', '990001', '10', 'm3')]);
    expect(report.chapters[0]?.groups[0]?.lines[0]?.unit).toEqual({ label: 'مترمکعب', code: 'm3' });
  });

  it('preserves quantities exactly, including negative and zero', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '-15', 'm3'),
      makeLine(synthetic, 'l2', '990001', '0', 'm3'),
    ];
    const { report } = reportOf(lines);
    const quantities = (report.chapters[0]?.groups[0]?.lines ?? []).map((l) => l.quantity);
    expect(quantities).toEqual(['-15', '0']);
  });

  it('preserves base prices (priced and null for pending rows)', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '10', 'm3'),
      makeLine(synthetic, 'l2', '990003', '5', 'm3'),
    ];
    const { report } = reportOf(lines);
    const reportLines = report.chapters[0]?.groups[0]?.lines ?? [];
    expect(reportLines[0]?.basePrice).toBe('1000');
    expect(reportLines[1]?.basePrice).toBe(null);
  });

  it('preserves line amounts exactly (positive, negative, zero, null)', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '10', 'm3'),
      makeLine(synthetic, 'l2', '990001', '-15', 'm3'),
      makeLine(synthetic, 'l3', '990001', '0', 'm3'),
      makeLine(synthetic, 'l4', '990003', '5', 'm3'),
    ];
    const { report } = reportOf(lines);
    const amounts = (report.chapters[0]?.groups[0]?.lines ?? []).map((l) => l.lineAmount);
    expect(amounts).toEqual(['10000', '-15000', '0', null]);
  });

  it('preserves the source reference exactly (document, page, section, null hash)', () => {
    const { report } = reportOf([makeLine(synthetic, 'l1', '990001', '10', 'm3')]);
    expect(report.chapters[0]?.groups[0]?.lines[0]?.sourceRef).toEqual({
      sourceDocument: 'SYNTHETIC TEST DATA',
      edition: 'SYN',
      printedPage: '1',
      section: 'SYN-1',
      sourceFileHash: null,
    });
  });

  it('preserves the structured calculation trace (quantity × unitPrice = lineAmount)', () => {
    const { report } = reportOf([makeLine(synthetic, 'l1', '990001', '10', 'm3')]);
    expect(report.chapters[0]?.groups[0]?.lines[0]?.trace).toEqual({
      quantity: '10',
      unitPrice: '1000',
      operation: 'multiply',
      lineAmount: '10000',
    });
  });

  it('preserves pending-line traces with null price and amount', () => {
    const { report } = reportOf([makeLine(synthetic, 'l1', '990003', '5', 'm3')]);
    expect(report.chapters[0]?.groups[0]?.lines[0]?.trace).toEqual({
      quantity: '5',
      unitPrice: null,
      operation: 'multiply',
      lineAmount: null,
    });
  });
});

describe('groups and chapters', () => {
  it('preserves the chapter/group hierarchy of the BOQ lines', () => {
    const { report } = reportOf(verifiedLines());
    expect(report.chapters.map((c) => c.chapter)).toEqual(['chapter-28', 'appendix-1']);
    expect(report.chapters[0]?.groups.map((g) => [g.chapter, g.group])).toEqual([
      ['chapter-28', '1'],
      ['chapter-28', '5'],
    ]);
    expect(report.chapters[1]?.groups.map((g) => [g.chapter, g.group])).toEqual([
      ['appendix-1', 'table-2'],
    ]);
  });

  it('preserves chapter subtotals from the rollup', () => {
    const { report } = reportOf(verifiedLines());
    expect(report.chapters.map((c) => [c.status, c.amount])).toEqual([
      ['COMPLETE', '505400'],
      ['COMPLETE', '18913000'],
    ]);
  });

  it('preserves group subtotals from the rollup', () => {
    const { report } = reportOf(verifiedLines());
    expect(report.chapters[0]?.groups.map((g) => [g.group, g.amount])).toEqual([
      ['1', '284000'],
      ['5', '221400'],
    ]);
    expect(report.chapters[1]?.groups.map((g) => [g.group, g.amount])).toEqual([
      ['table-2', '18913000'],
    ]);
  });

  it('orders sections by first appearance, never alphabetically or numerically', () => {
    // appendix-1 lines first: alphabetical order would also say appendix-1 first, so the
    // decisive case is chapter-28 first (insertion) — plus group 5 before group 1.
    const reordered = [
      makeLine(published, 'l2', '280501', '2', 'ton_nautical_mile'), // chapter-28, group 5
      makeLine(published, 'l1', '280101', '10', 'ton_km'), // chapter-28, group 1
      makeLine(published, 'l3', '410202', '3', 'm3'), // appendix-1, table-2
    ];
    const { report } = reportOf(reordered);
    expect(report.chapters.map((c) => c.chapter)).toEqual(['chapter-28', 'appendix-1']);
    expect(report.chapters[0]?.groups.map((g) => g.group)).toEqual(['5', '1']);
    expect(report.chapters[0]?.groups[0]?.lines.map((l) => l.lineId)).toEqual(['l2']);
  });
});

describe('summary', () => {
  it('total and status match the authoritative BoqRollup', () => {
    const { report, estimate } = reportOf(verifiedLines());
    const version = getVersion(estimate, 'est-1-v1');
    const rollup = rollupBoqLines(version.lines);
    expect(report.summary.amount).toBe(rollup.amount);
    expect(report.summary.status).toBe(rollup.status);
    expect(report.summary.amount).toBe('19418400');
  });

  it('line counts match the version', () => {
    const { report } = reportOf(verifiedLines());
    expect(report.summary.lineCount).toBe(4);
    expect(report.summary.pricedLineCount).toBe(4);
    expect(report.summary.pendingLineCount).toBe(0);
  });

  it('priced/pending counts match the rollup when pending lines exist', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '10', 'm3'),
      makeLine(synthetic, 'l2', '990002', '2', 'each'),
      makeLine(synthetic, 'l3', '990003', '5', 'm3'),
    ];
    const { report, estimate } = reportOf(lines);
    const rollup = rollupBoqLines(getVersion(estimate, 'est-1-v1').lines);
    expect(report.summary.lineCount).toBe(3);
    expect(report.summary.pricedLineCount).toBe(2);
    expect(report.summary.pendingLineCount).toBe(1);
    expect(report.summary.pricedLineCount).toBe(rollup.pricedLineCount);
    expect(report.summary.pendingLineCount).toBe(rollup.pendingLineCount);
  });
});

describe('status behavior', () => {
  it('COMPLETE report carries the exact total', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '10', 'm3'),
      makeLine(synthetic, 'l2', '990002', '2', 'each'),
    ];
    const { report } = reportOf(lines);
    expect(report.summary.status).toBe('COMPLETE');
    expect(report.summary.amount).toBe('11000');
  });

  it('INCOMPLETE report keeps amount null and status INCOMPLETE', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '10', 'm3'),
      makeLine(synthetic, 'l2', '990003', '5', 'm3'),
    ];
    const { report } = reportOf(lines);
    expect(report.summary.status).toBe('INCOMPLETE');
    expect(report.summary.amount).toBe(null);
  });

  it('EXTERNAL_DEPENDENCY report keeps amount null and lists the dependency', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '10', 'm3'),
      makeLine(synthetic, 'l2', '990004', '5', 'm3'),
    ];
    const { report } = reportOf(lines);
    expect(report.summary.status).toBe('EXTERNAL_DEPENDENCY');
    expect(report.summary.amount).toBe(null);
    expect(report.summary.dependencies).toEqual([
      { id: 'regional-coefficient-circular-94-69416', lineIds: ['l2'] },
    ]);
  });

  it('NOT_SPECIFIED report keeps amount null and status NOT_SPECIFIED', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '10', 'm3'),
      makeLine(synthetic, 'l2', '990005', '5', 'm3'),
    ];
    const { report } = reportOf(lines);
    expect(report.summary.status).toBe('NOT_SPECIFIED');
    expect(report.summary.amount).toBe(null);
  });

  it('a pending report never looks priced or zero at any level', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '10', 'm3'),
      makeLine(synthetic, 'l2', '990004', '5', 'm3'),
    ];
    const { report } = reportOf(lines);
    const pendingGroup = report.chapters
      .flatMap((c) => c.groups)
      .find((g) => g.lines.some((l) => l.lineId === 'l2'));
    expect(pendingGroup?.amount).toBe(null);
    expect(pendingGroup?.status).toBe('EXTERNAL_DEPENDENCY');
    for (const chapter of report.chapters) {
      expect(chapter.amount === null || chapter.amount === '10000').toBe(true);
    }
    expect(report.summary.amount).toBe(null);
    expect(report.summary.amount).not.toBe('0');
    const pendingLine = pendingGroup?.lines.find((l) => l.lineId === 'l2');
    expect(pendingLine?.lineAmount).toBe(null);
    expect(pendingLine?.lineAmount).not.toBe('0');
  });
});

describe('negative, zero and null amounts', () => {
  it('preserves a negative line amount (deduction stays negative)', () => {
    const { report } = reportOf([makeLine(synthetic, 'l1', '990001', '-15', 'm3')]);
    expect(report.chapters[0]?.groups[0]?.lines[0]?.lineAmount).toBe('-15000');
  });

  it('preserves negative group, chapter and summary amounts', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '10', 'm3'),
      makeLine(synthetic, 'l2', '990001', '-15', 'm3'),
    ];
    const { report } = reportOf(lines);
    expect(report.chapters[0]?.groups[0]?.amount).toBe('-5000');
    expect(report.chapters[0]?.amount).toBe('-5000');
    expect(report.summary.amount).toBe('-5000');
    expect(report.summary.status).toBe('COMPLETE');
  });

  it('preserves a legitimate zero as 0, distinct from null', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '0', 'm3'),
      makeLine(synthetic, 'l2', '990002', '1', 'each'),
    ];
    const { report } = reportOf(lines);
    expect(report.chapters[0]?.groups[0]?.lines[0]?.lineAmount).toBe('0');
    expect(report.chapters[0]?.groups[0]?.amount).toBe('0');
    expect(report.summary.amount).toBe('500');
  });

  it('preserves null for pending amounts (null is never normalized to 0)', () => {
    const { report } = reportOf([makeLine(synthetic, 'l1', '990005', '5', 'm3')]);
    expect(report.chapters[0]?.groups[0]?.lines[0]?.lineAmount).toBe(null);
    expect(report.chapters[0]?.groups[0]?.amount).toBe(null);
    expect(report.chapters[0]?.amount).toBe(null);
    expect(report.summary.amount).toBe(null);
  });
});

describe('snapshot and immutability', () => {
  it('is an independent snapshot: cloned lines, frozen model, unaffected by later versions', () => {
    const { report, estimate } = reportOf([makeLine(synthetic, 'l1', '990001', '10', 'm3')]);
    const version = getVersion(estimate, 'est-1-v1');
    const reportLine = report.chapters[0]?.groups[0]?.lines[0];
    expect(reportLine).toBeDefined();
    expect(reportLine).not.toBe(version.lines[0]); // cloned, not referenced
    expect(reportLine).toEqual(version.lines[0]); // ...but identical in content

    // a later version of the same estimate cannot alter the already-built report
    const before = JSON.stringify(report);
    const grown = makeEstimate([makeLine(synthetic, 'x', '990002', '9', 'each')]);
    expect(grown.versions).toHaveLength(1);
    expect(JSON.stringify(report)).toBe(before);

    expect(() => {
      (report.summary as { amount: string | null }).amount = '1';
    }).toThrow();
    expect(() => {
      (report.chapters[0] as unknown as { groups: unknown[] }).groups = [];
    }).toThrow();
  });

  it('does not depend on the live pricebook (values captured at build time)', () => {
    const { report } = reportOf([makeLine(synthetic, 'l1', '990001', '10', 'm3')]);
    // the same code priced from a changed dataset (999,999) must not alter the report
    const altLine = makeLine(syntheticDatasetAltPrice(), 'l1', '990001', '10', 'm3');
    expect(altLine.basePrice).toBe('999999');
    expect(report.chapters[0]?.groups[0]?.lines[0]?.basePrice).toBe('1000');
    expect(report.summary.amount).toBe('10000');
    // plain data: a JSON round-trip reproduces the report exactly (no live references)
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
