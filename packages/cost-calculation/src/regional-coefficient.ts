/**
 * Regional coefficient R — Appendix 4 of the 1404 price book (REGION-01, printed p243).
 *
 * The formula is verified: R = (R1×C1 + R2×C2 + … + Rn×Cn) / C, where Ci is the estimated
 * execution cost of the part of the work to which Ri applies and C is the estimate of that
 * discipline. The NUMERICAL coefficient values are an external dependency (circular
 * 94/69416 annex or later amendments): a missing Ri is never substituted — not with 1, not
 * with an average, not with a neighbouring region — and the result stays
 * EXTERNAL_DEPENDENCY. Whether Ci is measured before or after the floor/overhead
 * coefficients is not stated by the source (recorded open question); the Ci basis is the
 * caller's attestation.
 */
import { Decimal, canonical, toDecimal } from '@costgenius/domain';
import type { CalculationStatus } from './types.js';

export interface RegionalPart {
  /** Optional region identity (label only; never mapped to a value here). */
  readonly regionId?: string;
  /** The regional coefficient Ri — exact decimal, or null when the external value is absent. */
  readonly coefficient: string | null;
  /** Ci — the estimated execution cost of the part to which Ri applies (caller-supplied). */
  readonly executionCost: string;
}

export interface RegionalCoefficientResult {
  /** Exact R per the verified formula, or null when it cannot be computed. */
  readonly value: string | null;
  readonly calculationStatus: CalculationStatus;
  /** Region ids (or indices) whose Ri is missing — the external values still required. */
  readonly missingCoefficients: readonly string[];
}

export type RegionalCoefficientOutcome =
  | { readonly ok: true; readonly result: RegionalCoefficientResult }
  | { readonly ok: false; readonly message: string };

export function computeRegionalCoefficient(
  parts: readonly RegionalPart[],
): RegionalCoefficientOutcome {
  if (parts.length === 0) {
    return {
      ok: false,
      message: 'no regional parts supplied; a complete estimate requires R (clause 1-1)',
    };
  }

  const missing: string[] = [];
  let totalCost = new Decimal(0);
  let weightedSum = new Decimal(0);
  for (const [index, part] of parts.entries()) {
    let cost: Decimal;
    try {
      cost = toDecimal(part.executionCost);
    } catch {
      return {
        ok: false,
        message: `executionCost of part ${String(index)} is not an exact decimal string`,
      };
    }
    if (cost.isNegative()) {
      return { ok: false, message: `executionCost of part ${String(index)} is negative` };
    }
    totalCost = totalCost.plus(cost);
    if (part.coefficient === null) {
      missing.push(part.regionId ?? `part-${String(index)}`);
      continue;
    }
    let coefficient: Decimal;
    try {
      coefficient = toDecimal(part.coefficient);
    } catch {
      return {
        ok: false,
        message: `coefficient of part ${String(index)} is not an exact decimal string`,
      };
    }
    weightedSum = weightedSum.plus(coefficient.times(cost));
  }

  if (totalCost.isZero()) {
    return { ok: false, message: 'total execution cost C is zero; R is undefined' };
  }

  if (missing.length > 0) {
    return {
      ok: true,
      result: {
        value: null,
        calculationStatus: 'EXTERNAL_DEPENDENCY',
        missingCoefficients: missing,
      },
    };
  }

  return {
    ok: true,
    result: {
      value: canonical(weightedSum.div(totalCost)),
      calculationStatus: 'COMPLETE',
      missingCoefficients: [],
    },
  };
}
