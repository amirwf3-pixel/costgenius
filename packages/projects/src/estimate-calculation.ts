/**
 * Estimate-version calculation and finalization — the Phase 13 orchestration core.
 *
 * This module composes the existing engines in the verified order and adds NO arithmetic
 * of its own: BOQ lines → S4 (`calculateEstimate`, unchanged) → BOQ rollup
 * (`rollupBoqLines`, unchanged) → ReportModel (`buildReportModel`, unchanged). Its only
 * own work is mechanical: adapting the frozen `BoqLine` snapshots back into the
 * `PricedBoqLine` view S4 consumes (field-for-field, nothing recomputed) and freezing the
 * result into an immutable `EstimateCalculation` / `FinalizedEstimate` bundle.
 *
 * Snapshot semantics (implementation-contract D-005): the bundle copies the S4 input, the
 * S4 result, the rollup and the ReportModel; none of them references the live pricebook,
 * so a later change to a `PublishedDataset` can never mutate an already-produced
 * calculation or a finalized version. Finalization delegates to the BOQ layer's one-way
 * transition; editing history requires a new version number, by that layer's rules.
 */
import {
  calculateEstimate,
  type EstimateInput,
  type EstimateLine,
  type EstimateResult,
  type FloorCoefficientInput,
  type OverheadSelection,
  type PricedBoqLine,
  type RegionalPart,
} from '@costgenius/cost-calculation';
import {
  finalizeEstimateVersion as boqFinalizeEstimateVersion,
  getVersion,
  rollupBoqLines,
  type BoqLine,
  type BoqRollup,
  type Estimate,
  type EstimateVersion,
} from '@costgenius/boq';
import { parseInstant, parseUnitCode } from '@costgenius/domain';
import { buildReportModel, type ReportModel } from '@costgenius/reporting';
import { ProjectsError } from './errors.js';

/** The coefficient inputs S4 needs, exactly as the engine defines them (never defaulted here). */
export interface EstimateCoefficientInputs {
  readonly floor: FloorCoefficientInput;
  readonly overhead: OverheadSelection;
  readonly regional: { readonly parts: readonly RegionalPart[] };
  /** Project-local lump sum; null keeps the estimate INCOMPLETE (Appendix 5 prices are never invented). */
  readonly siteSetup: { readonly lumpSumAmount: string | null };
}

/** One version's complete, immutable calculation bundle. */
export interface EstimateCalculation {
  readonly versionId: string;
  readonly versionNumber: number;
  /** The exact S4 input that produced the result (full deterministic replay record). */
  readonly s4Input: EstimateInput;
  /** The S4 result, verbatim from the engine. */
  readonly s4Result: EstimateResult;
  /** The authoritative BOQ rollup of the version's lines. */
  readonly rollup: BoqRollup;
  /** The rendering-independent report snapshot (carries the S4 result in its provenance). */
  readonly reportModel: ReportModel;
}

/** A finalized version and its frozen calculation (history: never edited, only superseded). */
export interface FinalizedEstimate {
  readonly estimate: Estimate;
  readonly versionId: string;
  readonly calculation: EstimateCalculation;
  /** Caller-supplied finalization instant. */
  readonly finalizedAt: string;
}

export interface CalculateVersionOptions {
  /** Caller-supplied report identity (no randomness in this layer). */
  readonly reportId: string;
  /** Caller-supplied generation instant; omitted → null in the report metadata. */
  readonly generatedAt?: string;
}

export interface FinalizeVersionOptions extends CalculateVersionOptions {
  /** Caller-supplied finalization instant (ISO string; validated). */
  readonly finalizedAt: string;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}

/**
 * Mechanical adapter: the frozen BOQ-line view of one S2/S3 result back into the
 * `PricedBoqLine` shape S4 consumes. Field-for-field, structural only — no value is
 * recomputed, re-derived or repaired. The unit code is re-validated (it came from the
 * pricebook row, so this can only fail if a line was fabricated outside the engines).
 */
function toPricedLine(line: BoqLine): PricedBoqLine {
  let unit: PricedBoqLine['unit'];
  try {
    unit = parseUnitCode(line.unit.code);
  } catch {
    throw new ProjectsError(
      'INVALID_LINE_UNIT',
      `line ${line.lineId} (row ${line.pricebookCode}) carries unit code "${line.unit.code}", which is not a known unit`,
    );
  }
  return {
    lineId: line.lineId,
    pricebookCode: line.pricebookCode,
    pricebookChapter: line.chapter,
    quantity: line.quantity,
    unit,
    basePrice: line.basePrice,
    lineAmount: line.lineAmount,
    calculationStatus: line.calculationStatus,
    pricebookStatus: line.pricebookStatus,
    sourceRef: line.sourceRef,
    dependencies: [...line.externalDependencies],
    trace: line.trace,
  };
}

function s4LinesOf(version: EstimateVersion): readonly EstimateLine[] {
  return version.lines.map((line) => ({
    line: toPricedLine(line),
    ...(line.landscaping === true ? { landscaping: true } : {}),
  }));
}

/**
 * Calculates one estimate version: S4 → rollup → ReportModel. Pure with respect to the
 * estimate (never mutated) and the dataset (never consulted — the version's lines already
 * snapshot everything). Structural violations (Appendix 1 lines, invalid coefficients)
 * propagate the engine's own `EstimateInputError`; a financially blocked estimate is NOT
 * an error: it returns with `s4Result.calculationStatus` / `rollup.status` carrying the
 * reason and null totals.
 */
export function calculateEstimateVersion(
  estimate: Estimate,
  versionId: string,
  coefficients: EstimateCoefficientInputs,
  options: CalculateVersionOptions,
): EstimateCalculation {
  if (typeof options.reportId !== 'string' || options.reportId.length === 0) {
    throw new ProjectsError('INVALID_PROJECT_INPUT', 'reportId must be a non-empty string');
  }
  if (options.generatedAt !== undefined) parseInstant(options.generatedAt);
  const version = getVersion(estimate, versionId);
  if (version.buildingId === undefined) {
    throw new ProjectsError(
      'VERSION_WITHOUT_BUILDING',
      `version ${versionId} carries no buildingId; the verified S4 chain is single-scope (one building with its own floor coefficient P), so a version must be created with a buildingId to be calculable`,
    );
  }

  const s4Input: EstimateInput = {
    estimateId: version.estimateId,
    buildingId: version.buildingId,
    floor: coefficients.floor,
    overhead: coefficients.overhead,
    regional: coefficients.regional,
    siteSetup: coefficients.siteSetup,
    lines: s4LinesOf(version),
  };
  const s4Result = calculateEstimate(s4Input);
  const rollup = rollupBoqLines(version.lines);
  const reportModel = buildReportModel({
    reportId: options.reportId,
    estimate,
    versionId,
    ...(options.generatedAt !== undefined ? { generatedAt: options.generatedAt } : {}),
    s4Estimate: s4Result,
  });

  return deepFreeze({
    versionId,
    versionNumber: version.versionNumber,
    s4Input,
    s4Result,
    rollup,
    reportModel,
  });
}

/**
 * Finalizes a DRAFT version and freezes its calculation alongside it. The version is
 * finalized FIRST and the calculation is then produced from the finalized estimate, so
 * the bundle's ReportModel records versionStatus "finalized" — the report of exactly the
 * snapshot that was frozen. An already-finalized version rejects finalization (the BOQ
 * layer's VERSION_FINALIZED); changing a finalized estimate requires a new version.
 */
export function finalizeEstimate(
  estimate: Estimate,
  versionId: string,
  coefficients: EstimateCoefficientInputs,
  options: FinalizeVersionOptions,
): FinalizedEstimate {
  parseInstant(options.finalizedAt);
  const finalizedEstimate = boqFinalizeEstimateVersion(estimate, versionId);
  const calculation = calculateEstimateVersion(finalizedEstimate, versionId, coefficients, options);
  return deepFreeze({
    estimate: finalizedEstimate,
    versionId,
    calculation,
    finalizedAt: options.finalizedAt,
  });
}
