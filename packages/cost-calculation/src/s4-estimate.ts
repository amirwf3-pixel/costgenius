/**
 * S4 — the CostGenius execution-cost estimate pipeline (1404 ابنیه).
 *
 * The verified application order (FLOW-01, clause 2-8): the floor, overhead and regional
 * coefficients are multiplied successively onto the sum of the row amounts — each only
 * where applicable — and the site setup/removal cost is then ADDED. Each stage is traced
 * separately with its rule and source reference; there is no opaque combined multiplier.
 *
 * Verified scope (block E of the implementation contract): the chain is established for a
 * single-scope estimate (one building with its own P, one discipline). Combining several
 * buildings with different P, or in-scope rows with out-of-scope rows (landscaping), has no
 * method stated by the source — such an estimate returns NOT_SPECIFIED_IN_1404_PRICEBOOK
 * for the combined amount, and the stages that can be computed stay visible. On-site
 * material rows are interim-payment data only (ONSITE-01) and are refused as estimate
 * lines. The contractor's proposed coefficient and price adjustment are out of scope.
 *
 * Nothing here defaults, substitutes or rounds silently: a missing regional value keeps the
 * estimate EXTERNAL_DEPENDENCY, a missing site-setup amount keeps it INCOMPLETE, and the
 * final total is emitted only when the whole chain is COMPLETE.
 */
import { Money, canonical, toDecimal } from '@costgenius/domain';
import type { PricedBoqLine } from './s3-pricing.js';
import { sumPricedLines } from './s3-pricing.js';
import {
  type FloorCoefficientInput,
  type FloorInputError,
  computeFloorCoefficient,
} from './floor-coefficient.js';
import {
  type PlanKind,
  type TenderRoute,
  assertConstructionOverheadValue,
  selectOverheadCoefficient,
} from './overhead.js';
import { computeRegionalCoefficient, type RegionalPart } from './regional-coefficient.js';
import { aggregateCalculationStatus, type AppliedRule, type CalculationStatus } from './types.js';

export type EstimateStageKind = 'base-subtotal' | 'floor' | 'overhead' | 'regional' | 'site-setup';

export interface EstimateStage {
  readonly stage: EstimateStageKind;
  readonly rule: AppliedRule;
  readonly input: string | null;
  readonly coefficient: string | null;
  readonly output: string | null;
  readonly status: CalculationStatus;
  readonly note?: string;
}

export interface EstimateLine {
  readonly line: PricedBoqLine;
  /** Landscaping items are excluded from P (Appendix 2 clause 1-3); a mixed-scope estimate is NOT_SPECIFIED for the combined amount. */
  readonly landscaping?: boolean;
}

export type OverheadSelection =
  { readonly planKind: PlanKind; readonly tenderRoute: TenderRoute } | { readonly value: string };

export interface EstimateInput {
  readonly estimateId: string;
  readonly buildingId: string;
  /** The building's floor data; buildingId must match. P is never defaulted. */
  readonly floor: FloorCoefficientInput;
  readonly overhead: OverheadSelection;
  readonly regional: { readonly parts: readonly RegionalPart[] };
  /** Project-local lump sum; the Appendix 5 table prices are never invented here. Null keeps the estimate INCOMPLETE. */
  readonly siteSetup: { readonly lumpSumAmount: string | null };
  readonly lines: readonly EstimateLine[];
}

export interface EstimatePending {
  readonly externalDependencies: readonly string[];
  readonly incomplete: readonly string[];
  readonly notSpecified: readonly string[];
}

export interface EstimateResult {
  readonly estimateId: string;
  readonly buildingId: string;
  readonly stages: readonly EstimateStage[];
  readonly calculationStatus: CalculationStatus;
  /** The chained total, or null unless every stage is COMPLETE — a pending estimate never shows a normal-looking total. */
  readonly finalEstimate: string | null;
  readonly pending: EstimatePending;
}

/** Thrown for structural input violations the source leaves no way to interpret. */
export class EstimateInputError extends Error {
  constructor(
    message: string,
    readonly floorErrors?: readonly FloorInputError[],
  ) {
    super(message);
    this.name = 'EstimateInputError';
  }
}

const RULES = {
  flow: { id: 'IR-1404-E-FLOW-01', sourceReference: 'Application Instructions clause 2-8, p2' },
  floor: { id: 'IR-1404-E-FLOOR-01..03', sourceReference: 'Appendix 2, pp. 239–240' },
  overhead: {
    id: 'IR-1404-E-OVERHEAD-01',
    sourceReference: 'Application Instructions clause 2-7-2, p2',
  },
  regional: { id: 'IR-1404-E-REGION-01', sourceReference: 'Appendix 4, p243' },
  siteSetup: {
    id: 'IR-1404-E-SITE-01',
    sourceReference:
      'Application Instructions clause 2-7-5 (Table A) and Appendix 5, pp. 2, 244–253',
  },
} as const satisfies Record<string, AppliedRule>;

const REGIONAL_VALUES_DEPENDENCY = 'regional-coefficient-circular-94-69416';

function exactMoney(value: string, field: string): Money {
  try {
    return Money.of(value);
  } catch {
    throw new EstimateInputError(`${field} "${value}" is not an exact decimal string`);
  }
}

/** Runs the S4 pipeline for one single-scope estimate. Pure; throws only EstimateInputError. */
export function calculateEstimate(input: EstimateInput): EstimateResult {
  if (input.floor.buildingId !== input.buildingId) {
    throw new EstimateInputError(
      `floor.buildingId "${input.floor.buildingId}" does not match estimate buildingId "${input.buildingId}"`,
    );
  }

  for (const line of input.lines) {
    if (line.line.pricebookChapter === 'appendix-1') {
      throw new EstimateInputError(
        `line ${line.line.lineId} (row ${line.line.pricebookCode}) is an Appendix 1 on-site-material row: interim-payment data only (ONSITE-01), never an execution-cost estimate line`,
      );
    }
  }

  const overheadValue =
    'planKind' in input.overhead
      ? selectOverheadCoefficient(input.overhead.planKind, input.overhead.tenderRoute)
      : input.overhead.value;
  try {
    assertConstructionOverheadValue(overheadValue);
  } catch (error) {
    throw new EstimateInputError(error instanceof Error ? error.message : 'invalid overhead value');
  }

  const floorOutcome = computeFloorCoefficient(input.floor);
  if (!floorOutcome.ok) {
    throw new EstimateInputError('invalid floor coefficient input', floorOutcome.errors);
  }
  const p = floorOutcome.result.roundedValue;

  const regionalOutcome = computeRegionalCoefficient(input.regional.parts);
  if (!regionalOutcome.ok) {
    throw new EstimateInputError(regionalOutcome.message);
  }
  const regional = regionalOutcome.result;

  let siteSetupAmount: Money | null = null;
  if (input.siteSetup.lumpSumAmount !== null) {
    siteSetupAmount = exactMoney(input.siteSetup.lumpSumAmount, 'siteSetup.lumpSumAmount');
  }

  const externalDependencies: string[] = [];
  const incomplete: string[] = [];
  const notSpecified: string[] = [];

  // ---- stage 1: base subtotal (sum of row amounts) -------------------------------------
  const lineStatuses = input.lines.map((line) => line.line.calculationStatus);
  for (const line of input.lines) {
    if (line.line.calculationStatus === 'EXTERNAL_DEPENDENCY') {
      externalDependencies.push(
        ...line.line.dependencies,
        `line ${line.line.lineId} (${line.line.pricebookCode})`,
      );
    } else if (line.line.calculationStatus === 'INCOMPLETE') {
      incomplete.push(
        `line ${line.line.lineId} (${line.line.pricebookCode}) is not completely priced`,
      );
    } else if (line.line.calculationStatus === 'NOT_SPECIFIED') {
      notSpecified.push(`line ${line.line.lineId} (${line.line.pricebookCode})`);
    }
  }
  const inScope = input.lines.filter((line) => line.landscaping !== true);
  const inScopeSum = sumPricedLines(inScope.map((line) => line.line));
  const hasLandscaping = input.lines.some((line) => line.landscaping === true);
  if (hasLandscaping) {
    notSpecified.push(
      'mixed-scope estimate: landscaping items are excluded from P and the source states no method for combining out-of-scope rows into the chain (Appendix 2 clause 1-3; implementation-contract block E)',
    );
  }
  const baseStatus = aggregateCalculationStatus([...lineStatuses, inScopeSum.calculationStatus]);
  const stages: EstimateStage[] = [
    {
      stage: 'base-subtotal',
      rule: RULES.flow,
      input: null,
      coefficient: null,
      output: inScopeSum.total,
      status: baseStatus,
      ...(hasLandscaping
        ? { note: 'subtotal of in-scope rows only; landscaping rows are excluded from P' }
        : {}),
    },
  ];

  // ---- stage 2: floor coefficient P ------------------------------------------------------
  let running: Money | null = inScopeSum.total === null ? null : Money.of(inScopeSum.total);
  const floorOutput = running === null ? null : canonical(running.multiply(p).toDecimal());
  if (floorOutput !== null) running = Money.of(floorOutput);
  stages.push({
    stage: 'floor',
    rule: RULES.floor,
    input: inScopeSum.total,
    coefficient: p,
    output: floorOutput,
    status: baseStatus,
  });

  // ---- stages 3–5: overhead, regional, site setup (halted when scope is mixed) -----------
  const halted: CalculationStatus | null = hasLandscaping ? 'NOT_SPECIFIED' : null;

  if (halted !== null) {
    for (const [stage, rule] of [
      ['overhead', RULES.overhead],
      ['regional', RULES.regional],
      ['site-setup', RULES.siteSetup],
    ] as const) {
      stages.push({
        stage,
        rule,
        input: null,
        coefficient: null,
        output: null,
        status: halted,
        note: 'chain halted: no stated method for combining out-of-scope rows (NOT_SPECIFIED_IN_1404_PRICEBOOK)',
      });
    }
    return finalize(input, stages, { externalDependencies, incomplete, notSpecified });
  }

  // overhead (multiplied successively — FLOW-01)
  const overheadStatus = aggregateCalculationStatus([baseStatus]);
  const overheadOutput =
    running === null ? null : canonical(running.multiply(overheadValue).toDecimal());
  if (overheadOutput !== null) running = Money.of(overheadOutput);
  stages.push({
    stage: 'overhead',
    rule: RULES.overhead,
    input: floorOutput,
    coefficient: overheadValue,
    output: overheadOutput,
    status: overheadStatus,
  });

  // regional (multiplied successively — FLOW-01); missing Ri blocks the total
  let regionalStatus: CalculationStatus = overheadStatus;
  if (regional.calculationStatus === 'EXTERNAL_DEPENDENCY') {
    regionalStatus = 'EXTERNAL_DEPENDENCY';
    externalDependencies.push(
      REGIONAL_VALUES_DEPENDENCY,
      ...regional.missingCoefficients.map(
        (id) => `regional coefficient Ri for ${id} (values are external)`,
      ),
    );
  }
  let regionalOutput: string | null = null;
  if (regional.value !== null && running !== null && regionalStatus !== 'EXTERNAL_DEPENDENCY') {
    regionalOutput = canonical(running.multiply(regional.value).toDecimal());
    running = Money.of(regionalOutput);
  } else {
    running = null;
  }
  stages.push({
    stage: 'regional',
    rule: RULES.regional,
    input: overheadOutput,
    coefficient: regional.value,
    output: regionalOutput,
    status: regionalStatus,
  });

  // site setup (ADDED after the coefficients — FLOW-01); absent amount keeps the estimate INCOMPLETE
  let siteSetupStatus: CalculationStatus = regionalStatus;
  let siteSetupOutput: string | null = null;
  if (siteSetupAmount === null) {
    if (siteSetupStatus === 'COMPLETE') siteSetupStatus = 'INCOMPLETE';
    incomplete.push(
      'site setup/removal lump-sum amount is absent (a complete estimate requires it, clause 2-8)',
    );
  } else if (running !== null) {
    siteSetupOutput = canonical(running.add(siteSetupAmount).toDecimal());
  }
  stages.push({
    stage: 'site-setup',
    rule: RULES.siteSetup,
    input: regionalOutput,
    coefficient: null,
    output: siteSetupOutput,
    status: siteSetupStatus,
    ...(siteSetupAmount === null ? { note: 'amount absent; never defaulted to zero' } : {}),
  });

  return finalize(input, stages, { externalDependencies, incomplete, notSpecified });
}

function finalize(
  input: EstimateInput,
  stages: EstimateStage[],
  pending: { externalDependencies: string[]; incomplete: string[]; notSpecified: string[] },
): EstimateResult {
  const status = aggregateCalculationStatus(stages.map((stage) => stage.status));
  const lastStage = stages[stages.length - 1];
  const finalEstimate =
    status === 'COMPLETE' && lastStage !== undefined && lastStage.output !== null
      ? lastStage.output
      : null;
  return {
    estimateId: input.estimateId,
    buildingId: input.buildingId,
    stages,
    calculationStatus: status,
    finalEstimate,
    pending: {
      externalDependencies: [...new Set(pending.externalDependencies)],
      incomplete: [...new Set(pending.incomplete)],
      notSpecified: [...new Set(pending.notSpecified)],
    },
  };
}

/** Re-exported for consumers building estimate inputs from S1/S2/S3 results. */
export { toDecimal };
