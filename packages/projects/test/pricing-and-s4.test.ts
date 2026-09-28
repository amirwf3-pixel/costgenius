import { describe, expect, it } from 'vitest';
import { EstimateInputError } from '@costgenius/cost-calculation';
import {
  addEstimateLines,
  calculateEstimateVersion,
  createEstimateForProject,
  createProject,
  finalizeEstimate,
  startEstimateVersion,
  type EstimateCalculation,
} from '../src/index.js';
import type { Estimate } from '@costgenius/boq';
import {
  BLOCKED_LINE_INPUTS,
  BUILDING_ID,
  COMPLETE_EXPECTED_AMOUNTS,
  COMPLETE_EXPECTED_CHAPTERS,
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

function estimateWith(inputs: Parameters<typeof addEstimateLines>[3]): Estimate {
  const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
  const estimate = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 't' });
  const started = startEstimateVersion(dataset, estimate, {
    createdAt: FIXED_INSTANT,
    buildingId: BUILDING_ID,
  });
  const added = addEstimateLines(dataset, started, `${ESTIMATE_ID}-v1`, inputs);
  if (!added.ok) throw new Error(`fixture lines must resolve: ${JSON.stringify(added.failures)}`);
  return added.estimate;
}

function completeCalculation(): EstimateCalculation {
  return calculateEstimateVersion(
    estimateWith(COMPLETE_LINE_INPUTS),
    `${ESTIMATE_ID}-v1`,
    goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
    { reportId: 'rep-complete', generatedAt: FIXED_INSTANT },
  );
}

describe('G/J. positive pricing and exact quantity calculation', () => {
  it('every line amount is the exact product (quantity × base price)', () => {
    const estimate = estimateWith(COMPLETE_LINE_INPUTS);
    const lines = estimate.versions[0]?.lines ?? [];
    expect(lines).toHaveLength(8);
    for (const l of lines) {
      expect(l.lineAmount).toBe(COMPLETE_EXPECTED_AMOUNTS[l.lineId]);
      expect(l.trace).toEqual({
        quantity: l.quantity,
        unitPrice: l.basePrice,
        operation: 'multiply',
        lineAmount: COMPLETE_EXPECTED_AMOUNTS[l.lineId],
      });
    }
  });

  it('the rollup aggregates exactly: chapter subtotals and the estimate total', () => {
    const calculation = completeCalculation();
    expect(calculation.rollup.status).toBe('COMPLETE');
    expect(calculation.rollup.amount).toBe(COMPLETE_EXPECTED_TOTAL);
    for (const chapter of calculation.rollup.chapterSubtotals) {
      expect(chapter.amount).toBe(COMPLETE_EXPECTED_CHAPTERS[chapter.chapter]);
    }
    expect(calculation.rollup.chapterSubtotals.map((c) => c.chapter)).toEqual([
      'chapter-1',
      'chapter-24',
      'chapter-27',
      'chapter-28',
    ]);
  });
});

describe('H. negative prices survive the whole chain (no absolute value, no sign stripping)', () => {
  it('270320 and 270403 keep their negative base prices and produce negative amounts', () => {
    const estimate = estimateWith(COMPLETE_LINE_INPUTS);
    const lines = estimate.versions[0]?.lines ?? [];
    const l5 = lines.find((l) => l.lineId === 'l5');
    const l6 = lines.find((l) => l.lineId === 'l6');
    expect(l5?.pricebookCode).toBe('270320');
    expect(l5?.basePrice).toBe('-1037000');
    expect(l5?.lineAmount).toBe('-10370000');
    expect(l6?.pricebookCode).toBe('270403');
    expect(l6?.basePrice).toBe('-2131000');
    expect(l6?.lineAmount).toBe('-4262000');
  });

  it('the chapter-27 subtotal reflects the deductions; the S4 chain and report keep the signs', () => {
    const calculation = completeCalculation();
    expect(
      calculation.rollup.chapterSubtotals.find((c) => c.chapter === 'chapter-27')?.amount,
    ).toBe('21248000');
    const l5 = calculation.reportModel.chapters
      .find((c) => c.chapter === 'chapter-27')
      ?.groups.flatMap((g) => g.lines)
      .find((l) => l.lineId === 'l5');
    expect(l5?.basePrice).toBe('-1037000');
    expect(l5?.lineAmount).toBe('-10370000');
  });
});

describe('I. 220925 stays a blocked deduction (mandatory regression)', () => {
  it('is not priced: null amount, INCOMPLETE, deduction note preserved, no negative price', () => {
    const estimate = estimateWith(BLOCKED_LINE_INPUTS);
    const b1 = estimate.versions[0]?.lines.find((l) => l.lineId === 'b1');
    expect(b1?.pricebookCode).toBe('220925');
    expect(b1?.pricebookStatus).toBe('INCOMPLETE');
    expect(b1?.basePrice).toBeNull();
    expect(b1?.lineAmount).toBeNull();
    expect(b1?.notes).toEqual([
      'The cell prints -\u06f3\u06f7\u06f7\u066c\u06f5\u06f0\u06f0 as a deduction (\u06a9\u0633\u0631 \u0628\u0647\u0627), not a price; no base price is recorded (verified specification).',
    ]);
  });

  it('blocks the whole estimate: no total, statuses and pending reasons exposed', () => {
    const calculation = calculateEstimateVersion(
      estimateWith(BLOCKED_LINE_INPUTS),
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', '1000000', '12000000'),
      { reportId: 'rep-blocked' },
    );
    expect(calculation.s4Result.calculationStatus).toBe('EXTERNAL_DEPENDENCY'); // 090320 dominates
    expect(calculation.s4Result.finalEstimate).toBeNull();
    expect(calculation.rollup.amount).toBeNull();
    expect(calculation.rollup.status).toBe('EXTERNAL_DEPENDENCY');
    expect(calculation.s4Result.pending.incomplete.some((m) => m.includes('b1'))).toBe(true);
    expect(calculation.s4Result.pending.incomplete.some((m) => m.includes('b2'))).toBe(true);
    expect(calculation.s4Result.pending.externalDependencies.some((m) => m.includes('b3'))).toBe(
      true,
    );
    expect(calculation.s4Result.stages.every((s) => s.output === null)).toBe(true);
  });
});

describe('K. S4 calculation through the workflow (verified order, exact decimals)', () => {
  it('runs base → floor → overhead → regional → site-setup with exact outputs', () => {
    const calculation = completeCalculation();
    expect(calculation.s4Result.calculationStatus).toBe('COMPLETE');
    const [base, floor, overhead, regional, siteSetup] = calculation.s4Result.stages;
    expect(base?.stage).toBe('base-subtotal');
    expect(base?.output).toBe(COMPLETE_S4_EXPECTED.base);
    expect(floor?.stage).toBe('floor');
    expect(floor?.coefficient).toBe('1.0451');
    expect(floor?.output).toBe(COMPLETE_S4_EXPECTED.afterFloor);
    expect(overhead?.stage).toBe('overhead');
    expect(overhead?.coefficient).toBe('1.30');
    expect(overhead?.output).toBe(COMPLETE_S4_EXPECTED.afterOverhead);
    expect(regional?.stage).toBe('regional');
    expect(regional?.coefficient).toBe('1.1');
    expect(regional?.output).toBe(COMPLETE_S4_EXPECTED.afterRegional);
    expect(siteSetup?.stage).toBe('site-setup');
    expect(siteSetup?.coefficient).toBeNull();
    expect(siteSetup?.output).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
    expect(calculation.s4Result.finalEstimate).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
  });

  it('the S4 input is fully snapshotted (deterministic replay record)', () => {
    const calculation = completeCalculation();
    expect(calculation.s4Input.estimateId).toBe(ESTIMATE_ID);
    expect(calculation.s4Input.buildingId).toBe(BUILDING_ID);
    expect(calculation.s4Input.lines).toHaveLength(8);
    expect(calculation.s4Input.floor.totalBuildingFloorArea).toBe('7600');
  });

  it('Appendix 1 rows are refused as estimate lines (ONSITE-01), with the row named', () => {
    const estimate = estimateWith([
      { lineId: 'onsite', pricebookCode: '410202', quantity: '10', unit: 'm3' },
    ]);
    expect(() =>
      calculateEstimateVersion(
        estimate,
        `${ESTIMATE_ID}-v1`,
        goldenCoefficients('1.1', '1', '1000'),
        {
          reportId: 'rep-onsite',
        },
      ),
    ).toThrowError(EstimateInputError);
    try {
      calculateEstimateVersion(
        estimate,
        `${ESTIMATE_ID}-v1`,
        goldenCoefficients('1.1', '1', '1000'),
        { reportId: 'rep-onsite' },
      );
    } catch (error) {
      expect((error as Error).message).toContain('410202');
      expect((error as Error).message).toContain('interim-payment data only');
    }
  });
});

describe('L. blocked S4 stages (never a manufactured total)', () => {
  it('a missing regional coefficient keeps the estimate EXTERNAL_DEPENDENCY with a null total', () => {
    const calculation = calculateEstimateVersion(
      estimateWith(COMPLETE_LINE_INPUTS),
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients(null, COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-no-regional' },
    );
    expect(calculation.s4Result.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(calculation.s4Result.finalEstimate).toBeNull();
    const regional = calculation.s4Result.stages.find((s) => s.stage === 'regional');
    expect(regional?.coefficient).toBeNull();
    expect(regional?.output).toBeNull();
    expect(regional?.status).toBe('EXTERNAL_DEPENDENCY');
    expect(calculation.s4Result.pending.externalDependencies.join(' ')).toContain(
      'regional-coefficient-circular-94-69416',
    );
    // the stages that CAN be computed stay visible — nothing is zeroed
    const overhead = calculation.s4Result.stages.find((s) => s.stage === 'overhead');
    expect(overhead?.output).toBe(COMPLETE_S4_EXPECTED.afterOverhead);
  });

  it('a missing site-setup amount keeps the estimate INCOMPLETE with a null total', () => {
    const calculation = calculateEstimateVersion(
      estimateWith(COMPLETE_LINE_INPUTS),
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, null),
      { reportId: 'rep-no-site' },
    );
    expect(calculation.s4Result.calculationStatus).toBe('INCOMPLETE');
    expect(calculation.s4Result.finalEstimate).toBeNull();
    const siteSetup = calculation.s4Result.stages.find((s) => s.stage === 'site-setup');
    expect(siteSetup?.output).toBeNull();
    expect(calculation.s4Result.pending.incomplete.join(' ')).toContain('site setup');
  });

  it('a mixed-scope (landscaping) version halts the chain as NOT_SPECIFIED (guard preserved)', () => {
    const estimate = estimateWith([
      { lineId: 'n1', pricebookCode: '010101', quantity: '10', unit: 'm2' },
      { lineId: 'x1', pricebookCode: '010102', quantity: '2', unit: 'each', landscaping: true },
    ]);
    const calculation = calculateEstimateVersion(
      estimate,
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', '1', '1000'),
      { reportId: 'rep-mixed' },
    );
    expect(calculation.s4Result.calculationStatus).toBe('NOT_SPECIFIED');
    expect(calculation.s4Result.finalEstimate).toBeNull();
    const overhead = calculation.s4Result.stages.find((s) => s.stage === 'overhead');
    expect(overhead?.status).toBe('NOT_SPECIFIED');
    expect(overhead?.note).toContain('chain halted');
  });
});

describe('finalization (lifecycle)', () => {
  it('finalizes a draft and freezes its calculation alongside it', () => {
    const finalized = finalizeEstimate(
      estimateWith(COMPLETE_LINE_INPUTS),
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-final', generatedAt: FIXED_INSTANT, finalizedAt: FIXED_INSTANT },
    );
    expect(finalized.estimate.versions[0]?.status).toBe('finalized');
    expect(finalized.finalizedAt).toBe(FIXED_INSTANT);
    expect(finalized.calculation.s4Result.finalEstimate).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
    expect(finalized.calculation.reportModel.metadata.versionStatus).toBe('finalized');
  });
});
