import { describe, expect, it } from 'vitest';
import {
  calculateEstimate,
  type EstimateInput,
  type EstimateResult,
} from '@costgenius/cost-calculation';
import {
  BoqError,
  combinedMultiBuildingRollup,
  combinedMultiDisciplineRollup,
  getVersion,
  rollupBoqLines,
  type BoqRollup,
  type Estimate,
} from '@costgenius/boq';
import {
  ReportingError,
  buildReportModel,
  validateReportModel,
  type ReportModel,
  type ReportValidationError,
} from '../src/index.js';
import { makeEstimate, makeLine, makePriced, syntheticDataset } from './helpers.js';

const synthetic = syntheticDataset();

/** [lineId, code, quantity, unit] — synthetic dataset rows. */
type LineSpec = readonly [lineId: string, code: string, quantity: string, unit: string];

function setup(specs: readonly LineSpec[] = [['l1', '990001', '10', 'm3']]): {
  report: ReportModel;
  estimate: Estimate;
  rollup: BoqRollup;
} {
  const boqLines = specs.map(([lineId, code, quantity, unit]) =>
    makeLine(synthetic, lineId, code, quantity, unit),
  );
  const estimate = makeEstimate(boqLines);
  const version = getVersion(estimate, 'est-1-v1');
  return {
    report: buildReportModel({ reportId: 'rep-1', estimate, versionId: 'est-1-v1' }),
    estimate,
    rollup: rollupBoqLines(version.lines),
  };
}

/** Recursively-writable view of a type, for corrupting an unfrozen clone in tests. */
type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };

/** Unfrozen deep copy of a report, for corruption tests. */
function corrupt(report: ReportModel): Writable<ReportModel> {
  return structuredClone(report) as Writable<ReportModel>;
}

function messages(errors: readonly ReportValidationError[]): string[] {
  return errors.map((e) => `${e.field}: ${e.message}`);
}

function expectS4Mismatch(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportingError);
  expect((caught as ReportingError).code).toBe('S4_MISMATCH');
}

describe('report validation', () => {
  it('accepts a correctly built report with zero errors', () => {
    const { report, estimate, rollup } = setup([
      ['l1', '990001', '10', 'm3'],
      ['l2', '990002', '2', 'each'],
      ['l3', '990004', '5', 'm3'],
    ]);
    const errors = validateReportModel(report, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(errors).toEqual([]);
  });

  it('rejects a summary total that disagrees with the authoritative rollup', () => {
    const { report, estimate, rollup } = setup();
    const bad = corrupt(report);
    bad.summary = { ...bad.summary, amount: '999' };
    const errors = validateReportModel(bad, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(messages(errors).some((m) => m.includes('summary.amount'))).toBe(true);
    expect(messages(errors).some((m) => m.includes('10000'))).toBe(true);
  });

  it('rejects a pending summary that shows a total where the rollup is null', () => {
    const { report, estimate, rollup } = setup([
      ['l1', '990001', '10', 'm3'],
      ['l2', '990003', '5', 'm3'],
    ]);
    expect(rollup.amount).toBe(null);
    const bad = corrupt(report);
    bad.summary = { ...bad.summary, amount: '10000' }; // pending must never look priced
    const errors = validateReportModel(bad, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(messages(errors).some((m) => m.includes('summary.amount'))).toBe(true);
  });

  it('rejects a summary status that disagrees with the rollup', () => {
    const { report, estimate, rollup } = setup([
      ['l1', '990001', '10', 'm3'],
      ['l2', '990003', '5', 'm3'],
    ]);
    const bad = corrupt(report);
    bad.summary = { ...bad.summary, status: 'COMPLETE' };
    const errors = validateReportModel(bad, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(messages(errors).some((m) => m.includes('summary.status'))).toBe(true);
  });

  it('rejects a line placed in the wrong chapter/group section (no moving to fix)', () => {
    const { report, estimate, rollup } = setup([
      ['l1', '990001', '10', 'm3'],
      ['l2', '990001', '2', 'm3'],
    ]);
    const bad = corrupt(report);
    const group = bad.chapters[0]?.groups[0];
    if (group === undefined) throw new Error('expected group 1');
    group.lines = group.lines.map((line) =>
      line.lineId === 'l2' ? { ...line, chapter: 'wrong-chapter' } : line,
    );
    const errors = validateReportModel(bad, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(messages(errors).some((m) => m.includes('l2') && m.includes('wrong-chapter'))).toBe(
      true,
    );
  });

  it('rejects COMPLETE lines without an amount', () => {
    const { report, estimate, rollup } = setup();
    const bad = corrupt(report);
    const group = bad.chapters[0]?.groups[0];
    if (group === undefined) throw new Error('expected group');
    group.lines = group.lines.map((line) => ({ ...line, lineAmount: null }));
    const errors = validateReportModel(bad, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(
      messages(errors).some((m) => m.includes('a COMPLETE line must carry a lineAmount')),
    ).toBe(true);
  });

  it('rejects pending lines that carry an amount', () => {
    const { report, estimate, rollup } = setup([
      ['l1', '990001', '10', 'm3'],
      ['l2', '990003', '5', 'm3'],
    ]);
    const bad = corrupt(report);
    for (const chapter of bad.chapters) {
      for (const group of chapter.groups) {
        group.lines = group.lines.map((line) =>
          line.calculationStatus !== 'COMPLETE' ? { ...line, lineAmount: '5' } : line,
        );
      }
    }
    const errors = validateReportModel(bad, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(
      messages(errors).some((m) => m.includes('a non-COMPLETE line must not carry a lineAmount')),
    ).toBe(true);
  });

  it('rejects a dropped line (line count mismatch) and an unknown line', () => {
    const { report, estimate, rollup } = setup([
      ['l1', '990001', '10', 'm3'],
      ['l2', '990001', '2', 'm3'],
    ]);
    const dropped = corrupt(report);
    const group = dropped.chapters[0]?.groups[0];
    if (group === undefined) throw new Error('expected group');
    group.lines = group.lines.slice(0, 1); // l2 dropped
    let errors = validateReportModel(dropped, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(messages(errors).some((m) => m.includes('l2') && m.includes('is missing'))).toBe(true);

    const ghost = corrupt(report);
    const g2 = ghost.chapters[0]?.groups[0];
    if (g2 === undefined) throw new Error('expected group');
    g2.lines = g2.lines.map((line) => (line.lineId === 'l2' ? { ...line, lineId: 'ghost' } : line));
    errors = validateReportModel(ghost, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(messages(errors).some((m) => m.includes('ghost') && m.includes('does not exist'))).toBe(
      true,
    );
  });

  it('rejects edition mixing inside a report', () => {
    const { report, estimate, rollup } = setup();
    const bad = corrupt(report);
    const group = bad.chapters[0]?.groups[0];
    if (group === undefined) throw new Error('expected group');
    group.lines = group.lines.map((line) => ({ ...line, edition: '1403' }));
    const errors = validateReportModel(bad, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(messages(errors).some((m) => m.includes('editions are never mixed'))).toBe(true);
  });

  it('rejects a corrupted chapter subtotal against the rollup', () => {
    const { report, estimate, rollup } = setup([
      ['l1', '990001', '10', 'm3'],
      ['l2', '990002', '2', 'each'],
    ]);
    const bad = corrupt(report);
    const chapter = bad.chapters[0];
    if (chapter === undefined) throw new Error('expected chapter');
    bad.chapters = [{ ...chapter, amount: '1' }];
    const errors = validateReportModel(bad, {
      estimate,
      version: getVersion(estimate, 'est-1-v1'),
      rollup,
    });
    expect(messages(errors).some((m) => m.includes('chapters[0].amount'))).toBe(true);
  });
});

describe('build-time identity checks', () => {
  it('rejects an empty reportId', () => {
    const estimate = makeEstimate([makeLine(synthetic, 'l1', '990001', '10', 'm3')]);
    let caught: unknown;
    try {
      buildReportModel({ reportId: '', estimate, versionId: 'est-1-v1' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReportingError);
    expect((caught as ReportingError).code).toBe('INVALID_REPORT_INPUT');
  });

  it('propagates the BOQ layer error for an unknown versionId', () => {
    const estimate = makeEstimate([makeLine(synthetic, 'l1', '990001', '10', 'm3')]);
    expect(() =>
      buildReportModel({ reportId: 'rep-1', estimate, versionId: 'no-such-version' }),
    ).toThrow(BoqError);
  });

  it('rejects an S4 result from a different estimate (S4_MISMATCH)', () => {
    const estimate = makeEstimate([makeLine(synthetic, 'l1', '990001', '10', 'm3')]);
    expectS4Mismatch(() =>
      buildReportModel({
        reportId: 'rep-1',
        estimate,
        versionId: 'est-1-v1',
        s4Estimate: s4Result('other-estimate', 'b-1'),
      }),
    );
  });

  it('rejects an S4 result for a different building (S4_MISMATCH)', () => {
    const estimate = makeEstimate([makeLine(synthetic, 'l1', '990001', '10', 'm3')], {
      buildingId: 'b-1',
    });
    expectS4Mismatch(() =>
      buildReportModel({
        reportId: 'rep-1',
        estimate,
        versionId: 'est-1-v1',
        s4Estimate: s4Result('est-1', 'b-2'),
      }),
    );
  });
});

/** The verified golden floor case (S=7600, weightedSum=34300, P=1.0451) on a synthetic base. */
function s4Result(estimateId: string, buildingId: string): EstimateResult {
  const floors = (n: number, area: string): { area: string }[] =>
    Array.from({ length: n }, () => ({ area }));
  const input: EstimateInput = {
    estimateId,
    buildingId,
    floor: {
      buildingId,
      groundFloorArea: '600',
      firstBasementArea: '400',
      aboveGroundFloors: [...floors(10, '500'), { area: '400' }],
      belowGroundFloors: floors(3, '400'),
      totalBuildingFloorArea: '7600',
    },
    overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
    regional: { parts: [{ regionId: 'r1', coefficient: '1.1', executionCost: '1358630' }] },
    siteSetup: { lumpSumAmount: '50000' },
    lines: [
      { line: makePriced(synthetic, 'line-990001', '990001', '500', 'm3') },
      { line: makePriced(synthetic, 'line-990002', '990002', '1000', 'each') },
    ],
  };
  return calculateEstimate(input);
}

describe('S4 estimate trace preservation', () => {
  it('preserves the S4 result verbatim: stages, rules, coefficients, site setup separate', () => {
    const estimate = makeEstimate(
      [
        makeLine(synthetic, 'l1', '990001', '500', 'm3'),
        makeLine(synthetic, 'l2', '990002', '1000', 'each'),
      ],
      { buildingId: 'b-golden' },
    );
    const s4 = s4Result('est-1', 'b-golden');
    expect(s4.stages.map((s) => s.stage)).toEqual([
      'base-subtotal',
      'floor',
      'overhead',
      'regional',
      'site-setup',
    ]);
    const report = buildReportModel({
      reportId: 'rep-s4',
      estimate,
      versionId: 'est-1-v1',
      s4Estimate: s4,
    });
    // verbatim preservation — the report's copy is content-identical, never recomputed
    expect(report.generatedFrom.s4Estimate).toEqual(s4);
    expect(report.generatedFrom.s4Estimate).not.toBe(s4); // cloned snapshot, not a reference

    const stages = report.generatedFrom.s4Estimate?.stages ?? [];
    // golden floor coefficient P = 1.0451, preserved string-exact (never as the number 1.0451)
    expect(stages[1]?.stage).toBe('floor');
    expect(stages[1]?.coefficient).toBe('1.0451');
    expect(stages[1]?.rule.id).toBe('IR-1404-E-FLOOR-01..03');
    // verified construction overhead 1.30 (clause 2-7-2), consumed from S4, not hardcoded here
    expect(stages[2]?.stage).toBe('overhead');
    expect(stages[2]?.coefficient).toBe('1.30');
    expect(stages[2]?.rule.id).toBe('IR-1404-E-OVERHEAD-01');
    // site setup stays a separate additive stage (never folded into line prices)
    expect(stages[4]?.stage).toBe('site-setup');
    expect(stages[4]?.rule.id).toBe('IR-1404-E-SITE-01');
    expect(report.generatedFrom.s4Estimate?.finalEstimate).toBe('1544493');
    // coefficients stay exact strings in serialization — no numeric reinterpretation ever
    expect(JSON.stringify(report)).toContain('"coefficient":"1.0451"');
  });
});

describe('scope boundaries preserved', () => {
  it('preserves the regional dependency id and its line attribution', () => {
    const { report } = setup([
      ['l1', '990001', '10', 'm3'],
      ['l2', '990004', '5', 'm3'],
      ['l3', '990004', '2', 'm3'],
    ]);
    const pendingLines = report.chapters
      .flatMap((c) => c.groups.flatMap((g) => g.lines))
      .filter((l) => l.lineId !== 'l1');
    expect(pendingLines).toHaveLength(2);
    for (const line of pendingLines) {
      expect(line.externalDependencies).toEqual(['regional-coefficient-circular-94-69416']);
      expect(line.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
      expect(line.lineAmount).toBe(null);
    }
    expect(report.summary.dependencies).toEqual([
      { id: 'regional-coefficient-circular-94-69416', lineIds: ['l2', 'l3'] },
    ]);
  });

  it('preserves multi-building combination as NOT_SPECIFIED (verbatim BOQ statement)', () => {
    const { report } = setup();
    expect(report.scopeBoundaries.multiBuildingCombination).toEqual(combinedMultiBuildingRollup());
    expect(report.scopeBoundaries.multiBuildingCombination.status).toBe('NOT_SPECIFIED');
  });

  it('preserves multi-discipline combination as NOT_SPECIFIED (verbatim BOQ statement)', () => {
    const { report } = setup();
    expect(report.scopeBoundaries.multiDisciplineCombination).toEqual(
      combinedMultiDisciplineRollup(),
    );
    expect(report.scopeBoundaries.multiDisciplineCombination.status).toBe('NOT_SPECIFIED');
  });

  it('carries building attribution as metadata only (no combined coefficient invented)', () => {
    const lines = [
      makeLine(synthetic, 'l1', '990001', '10', 'm3', { buildingId: 'b-1' }),
      makeLine(synthetic, 'l2', '990002', '2', 'each', { buildingId: 'b-2' }),
    ];
    const estimate = makeEstimate(lines, { buildingId: 'b-1' });
    const report = buildReportModel({ reportId: 'rep-1', estimate, versionId: 'est-1-v1' });
    expect(report.metadata.buildingId).toBe('b-1');
    const reportLines = report.chapters.flatMap((c) => c.groups.flatMap((g) => g.lines));
    expect(reportLines.map((l) => [l.lineId, l.buildingId])).toEqual([
      ['l1', 'b-1'],
      ['l2', 'b-2'],
    ]);
    // no combined multi-building total appears anywhere: the boundary statement governs
    expect(report.scopeBoundaries.multiBuildingCombination.status).toBe('NOT_SPECIFIED');
  });
});
