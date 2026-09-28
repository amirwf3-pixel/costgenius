/**
 * Application-level estimate-line input and its resolution into BOQ lines.
 *
 * `EstimateLineInput` is the thin, user-facing shape of one takeoff entry: identity,
 * exact pricebook code, exact quantity + unit, and the optional grouping metadata the BOQ
 * layer already supports (buildingId, landscaping). Deliberately absent: description
 * overrides (the pricebook description is authoritative) and user-entered base prices
 * (the architecture has no override layer yet — D-006 is a future, explicitly audited
 * concern; nothing here may silently replace a pricebook price).
 *
 * Resolution composes the existing engines unchanged — S2 exact-code binding with unit
 * checking, S3 exact pricing — and freezes the result into a BOQ line snapshot. No
 * formula is duplicated; on any failure the whole batch fails deterministically with the
 * per-line errors (all-or-nothing: a half-resolved estimate is never produced).
 *
 * D-015 (2026-09): a negative quantity is rejected here (NEGATIVE_QUANTITY) — deductions
 * are priced کسر بها rows or the dimensional engine's deduction kind, never signed
 * quantities — and an optional calc-engine provenance travels with the line into its
 * trace (see ./takeoff-quantities.ts).
 *
 * D-016 (G2=B): an optional transfer provenance (`takeoffDocument`, CG-FT §8.1) travels
 * the same way for lines created from finalized Takeoff itemTotals — this resolver is the
 * ONE line-creation path and stays unchanged otherwise (see ./takeoff-transfer.ts).
 */
import { bindBoqLine, priceBoqLine, type S2Error } from '@costgenius/cost-calculation';
import {
  createBoqLine,
  type BoqLine,
  type BoqLineExtras,
  type TakeoffDocumentProvenance,
} from '@costgenius/boq';
import { toDecimal } from '@costgenius/domain';
import type { PublishedDataset } from '@costgenius/pricebook';
import type { TakeoffProvenance } from './takeoff-quantities.js';

/** The application-level input for one estimate line. */
export interface EstimateLineInput {
  readonly lineId: string;
  /** Exact printed pricebook code (string identity; leading zeros preserved). */
  readonly pricebookCode: string;
  /**
   * Exact decimal string, ≥ 0 (D-015/D2-A: a deduction is never a signed quantity — it
   * is a priced کسر بها row or, dimensionally, the engine's `kind: "deduction"`).
   * Zero is legitimate; null is not representable here (omit the line instead).
   */
  readonly quantity: string;
  /** Unit the quantity is measured in; must equal the row's unit exactly (no conversion). */
  readonly unit: string;
  readonly buildingId?: string;
  readonly landscaping?: boolean;
  /** D-015: S1 provenance when calc-engine computed the quantity (server-side only). */
  readonly takeoff?: TakeoffProvenance;
  /** D-016 (G2=B): transfer provenance when the line came from a finalized Takeoff itemTotal. */
  readonly takeoffDocument?: TakeoffDocumentProvenance;
}

/** Application-level line-input rejection (D-015/D2-A); the code is part of the API details contract. */
export interface LineInputError {
  readonly code: 'NEGATIVE_QUANTITY';
  readonly lineId: string;
  readonly message: string;
}

/** One line's deterministic resolution failure (S2 errors and line-input errors, verbatim). */
export interface LineResolutionFailure {
  readonly lineId: string;
  readonly pricebookCode: string;
  readonly errors: readonly (S2Error | LineInputError)[];
}

export type LineResolutionResult =
  | { readonly ok: true; readonly lines: readonly BoqLine[] }
  | { readonly ok: false; readonly failures: readonly LineResolutionFailure[] };

/**
 * True only for a WELL-FORMED negative decimal (D-015/D2-A). A malformed quantity is NOT
 * intercepted here — S2 keeps reporting it as INVALID_DECIMAL, exactly as before.
 */
function isNegativeDecimal(quantity: string): boolean {
  try {
    return toDecimal(quantity).isNegative();
  } catch {
    return false;
  }
}

/**
 * Resolves estimate-line inputs into BOQ lines through the existing S2/S3 engines.
 * Exact-code lookup only — no fuzzy match, no neighbouring code, no other edition; the
 * unit must equal the row's unit exactly; blocked rows resolve to unpriced lines with
 * their source statuses (they are data, not errors).
 */
export function resolveEstimateLines(
  dataset: PublishedDataset,
  inputs: readonly EstimateLineInput[],
): LineResolutionResult {
  const failures: LineResolutionFailure[] = [];
  const lines: BoqLine[] = [];

  for (const input of inputs) {
    // D-015/D2-A (owner-approved re-baseline, 2026-09): a negative quantity is rejected
    // here at the application boundary — deductions are priced کسر بها rows or the
    // engine's dimensional deduction kind, never signed quantities. No conversion from
    // a signed quantity to a deduction is invented.
    if (isNegativeDecimal(input.quantity)) {
      failures.push({
        lineId: input.lineId,
        pricebookCode: input.pricebookCode,
        errors: [
          {
            code: 'NEGATIVE_QUANTITY',
            lineId: input.lineId,
            message: `quantity ${input.quantity} of line ${input.lineId} is negative; a deduction is the row's کسر بها price (e.g. 010517) or the dimensional engine's deduction kind — never a signed quantity`,
          },
        ],
      });
      continue;
    }
    const bound = bindBoqLine(dataset, {
      lineId: input.lineId,
      code: input.pricebookCode,
      quantity: input.quantity,
      unit: input.unit,
    });
    if (!bound.ok) {
      failures.push({
        lineId: input.lineId,
        pricebookCode: input.pricebookCode,
        errors: [...bound.errors],
      });
      continue;
    }
    const priced = priceBoqLine(bound.line);
    const extras: BoqLineExtras = {
      ...(input.buildingId !== undefined ? { buildingId: input.buildingId } : {}),
      ...(input.landscaping !== undefined ? { landscaping: input.landscaping } : {}),
      ...(input.takeoff !== undefined ? { takeoff: input.takeoff } : {}),
      ...(input.takeoffDocument !== undefined ? { takeoffDocument: input.takeoffDocument } : {}),
    };
    lines.push(createBoqLine(bound.line, priced, extras));
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, lines };
}
