/**
 * The Takeoff → BOQ transfer (D-016 Phase 4, G2=B — CG-FT-TAKEOFF-SPEC@0.1.0 §8).
 *
 * A deterministic, atomic application operation: **finalized Takeoff document → draft
 * estimate version**. ONE BOQ line is created per PRICED `itemCode`/itemTotal — never one
 * per TakeoffLine — and the aggregation is exclusively the engine's own
 * `result.itemTotals`: this layer performs NO aggregation, NO rounding, NO unit handling
 * and NO pricing of its own. Quantities are the itemTotal's effective `qty` verbatim
 * (R2=C: rounded iff an item-total rule matched, otherwise the exact aggregate) — exact
 * decimal strings end to end.
 *
 * Everything is delegated to the existing engines: line creation goes through
 * `resolveEstimateLines` (S2 exact-code binding + unit equality, S3 exact pricing —
 * arithmetic unchanged) and `addBoqLine` (append-only, duplicate-lineId detection), so
 * S2/S3/S4 semantics and the estimate workflow are untouched.
 *
 * Atomicity: the operation is pure — it either returns an updated estimate carrying ALL
 * the new lines, or a rejection with per-item failures and the input estimate untouched.
 * The persistence layer's single `syncEstimate` transaction (append-only prefix check
 * under `SELECT … FOR UPDATE`) commits it; nothing partial can ever be persisted.
 *
 * Repeat protection (§8.4): rejected with `ALREADY_TRANSFERRED` if the target version
 * already contains any line whose provenance references the same source `documentId`.
 * Uncoded itemTotals (`itemCode: null`) are NEVER transferred — they are reported as
 * `skipped`, remain in the Takeoff, and are not failures.
 */
import {
  addBoqLine,
  BoqError,
  getVersion,
  type BoqLine,
  type Estimate,
  type TakeoffDocumentProvenance,
} from '@costgenius/boq';
import type { PublishedDataset } from '@costgenius/pricebook';
import type { TakeoffItemTotal } from '@costgenius/calc-engine';
import type { FinalizedTakeoff } from './takeoff-document.js';
import { resolveEstimateLines, type EstimateLineInput } from './estimate-lines.js';

/** One itemTotal this transfer refuses to carry (deterministic, per-item detail). */
export interface TakeoffTransferFailure {
  readonly itemCode: string | null;
  readonly unit: string;
  readonly errors: readonly { readonly code: string; readonly message: string }[];
}

/** An uncoded itemTotal that stays in the Takeoff (never a failure; §8.2). */
export interface SkippedItemTotal {
  readonly itemCode: null;
  readonly unit: string;
  readonly lineIds: readonly string[];
  readonly exactQty: string;
  readonly roundedQty?: string;
  readonly qty: string;
}

/** One successfully transferred itemTotal and the BOQ line it became. */
export interface TransferredItemTotal {
  readonly itemCode: string;
  readonly unit: string;
  /** The generated BOQ line identity (deterministic; NOT a Takeoff lineId). */
  readonly lineId: string;
  /** The effective quantity carried by the BOQ line (R2=C: `itemTotal.qty` verbatim). */
  readonly quantity: string;
  /** The contributing Takeoff lines, in the engine's aggregation order. */
  readonly lineIds: readonly string[];
  readonly exactQty: string;
  readonly roundedQty?: string;
}

export type TakeoffTransferResult =
  | {
      readonly ok: true;
      readonly estimate: Estimate;
      readonly lines: readonly BoqLine[];
      readonly transferred: readonly TransferredItemTotal[];
      readonly skipped: readonly SkippedItemTotal[];
    }
  | {
      readonly ok: false;
      readonly code: 'TAKEOFF_TRANSFER_REJECTED';
      readonly message: string;
      readonly failures: readonly TakeoffTransferFailure[];
      readonly skipped: readonly SkippedItemTotal[];
    };

/** The deterministic BOQ line identity of one transferred itemTotal (§8.4: no duplicates). */
export function takeoffTransferLineId(documentId: string, itemCode: string): string {
  return `tk-${documentId}-${itemCode}`;
}

/** The transfer provenance of one itemTotal (CG-FT §8.1; no roundingRule — see boq-line.ts). */
function provenanceOf(
  finalized: FinalizedTakeoff,
  total: TakeoffItemTotal,
): TakeoffDocumentProvenance {
  // itemCode is non-null on every candidate (uncoded totals are skipped before this).
  const itemCode = total.itemCode;
  if (itemCode === null) throw new Error('unreachable: uncoded itemTotals are never bound');
  return {
    takeoffDocumentId: finalized.documentId,
    takeoffId: finalized.takeoffId,
    documentNumber: finalized.documentNumber,
    itemCode,
    unit: total.unit,
    lineIds: [...total.lineIds],
    exactQty: total.exactQty,
    ...(total.roundedQty !== undefined ? { roundedQty: total.roundedQty } : {}),
    qty: total.qty,
    specVersion: finalized.result.specVersion,
    engineVersion: finalized.result.engineVersion,
  };
}

/**
 * Transfers a FINALIZED Takeoff into a DRAFT estimate version (G2=B). The source is the
 * immutable finalized bundle — never mutable draft rows; the target must be a draft
 * version of the given estimate (existing BoqError codes for a missing or finalized
 * target: VERSION_NOT_FOUND / VERSION_FINALIZED). All-or-nothing: any rejected itemCode
 * rejects the whole transfer with per-item failures and the estimate is returned
 * untouched (the caller persists only successful results).
 */
export function transferTakeoffToVersion(
  dataset: PublishedDataset,
  finalized: FinalizedTakeoff,
  estimate: Estimate,
  versionId: string,
): TakeoffTransferResult {
  // The target must be a draft version (§8.1) — the existing BOQ lifecycle code: a
  // finalized version is immutable history and rejects lines (VERSION_FINALIZED).
  const version = getVersion(estimate, versionId);
  if (version.status === 'finalized') {
    throw new BoqError(
      'VERSION_FINALIZED',
      `version ${versionId} is finalized and cannot be modified; create a new version instead`,
    );
  }

  const failures: TakeoffTransferFailure[] = [];
  const skipped: SkippedItemTotal[] = [];
  const inputs: EstimateLineInput[] = [];
  const candidates: { total: TakeoffItemTotal; lineId: string; itemCode: string }[] = [];

  // Defensive snapshot invariant (§8: the engine guarantees these upstream; a violation
  // means the store is inconsistent — reject deterministically, never repair).
  if (finalized.result.status !== 'ok') {
    return {
      ok: false,
      code: 'TAKEOFF_TRANSFER_REJECTED',
      message:
        'the finalized takeoff snapshot carries no valid calculation result; nothing was transferred',
      failures: [
        {
          itemCode: null,
          unit: '',
          errors: [{ code: 'INVALID_SNAPSHOT', message: 'result.status is not "ok"' }],
        },
      ],
      skipped: [],
    };
  }
  const unitsByCode = new Map<string, string>();
  for (const total of finalized.result.itemTotals) {
    if (total.itemCode === null) continue; // uncoded: skipped below, never validated
    const known = unitsByCode.get(total.itemCode);
    if (known !== undefined && known !== total.unit) {
      failures.push({
        itemCode: total.itemCode,
        unit: total.unit,
        errors: [
          {
            code: 'AGGREGATION_UNIT_MISMATCH',
            message: `itemCode "${total.itemCode}" appears with units ${known} and ${total.unit}; the engine guarantees unit-homogeneous itemTotals`,
          },
        ],
      });
    }
    unitsByCode.set(total.itemCode, total.unit);
  }
  if (failures.length > 0) {
    return {
      ok: false,
      code: 'TAKEOFF_TRANSFER_REJECTED',
      message:
        'the finalized takeoff snapshot violates the unit-homogeneity invariant; nothing was transferred',
      failures,
      skipped: [],
    };
  }

  // Repeat protection (§8.4): any existing line from the same source document rejects.
  const alreadyTransferred = version.lines.filter(
    (line) => line.trace.takeoffDocument?.takeoffDocumentId === finalized.documentId,
  );
  if (alreadyTransferred.length > 0) {
    return {
      ok: false,
      code: 'TAKEOFF_TRANSFER_REJECTED',
      message: `estimate version "${versionId}" already carries ${String(alreadyTransferred.length)} line(s) transferred from takeoff document "${finalized.documentId}"; no duplicate BOQ line is ever created for the same transfer`,
      failures: alreadyTransferred.map((line) => ({
        itemCode: line.pricebookCode,
        unit: line.unit.code,
        errors: [
          {
            code: 'ALREADY_TRANSFERRED',
            message: `line ${line.lineId} was already transferred from takeoff document "${finalized.documentId}"`,
          },
        ],
      })),
      skipped: [],
    };
  }

  // Partition the engine's own itemTotals (engine order — deterministic): uncoded
  // itemTotals are skipped and reported; coded ones become exactly one candidate each.
  for (const total of finalized.result.itemTotals) {
    if (total.itemCode === null) {
      skipped.push({
        itemCode: null,
        unit: total.unit,
        lineIds: [...total.lineIds],
        exactQty: total.exactQty,
        ...(total.roundedQty !== undefined ? { roundedQty: total.roundedQty } : {}),
        qty: total.qty,
      });
      continue;
    }
    const itemCode = total.itemCode;
    const lineId = takeoffTransferLineId(finalized.documentId, itemCode);
    candidates.push({ total, lineId, itemCode });
    inputs.push({
      lineId,
      pricebookCode: total.itemCode,
      // R2=C: the itemTotal's effective quantity VERBATIM — rounded iff an item-total
      // rule matched, otherwise the exact aggregate. No second rounding anywhere.
      quantity: total.qty,
      unit: total.unit,
      takeoffDocument: provenanceOf(finalized, total),
    });
  }

  // The existing line-resolution path (S2 exact-code binding + unit equality, S3 exact
  // pricing). All-or-nothing: any failure rejects the whole transfer (§8.5).
  const resolution = resolveEstimateLines(dataset, inputs);
  if (!resolution.ok) {
    const byItemCode = new Map<string, { code: string; message: string }[]>();
    for (const failure of resolution.failures) {
      const errors = byItemCode.get(failure.pricebookCode) ?? [];
      errors.push(...failure.errors.map((error) => ({ code: error.code, message: error.message })));
      byItemCode.set(failure.pricebookCode, errors);
    }
    return {
      ok: false,
      code: 'TAKEOFF_TRANSFER_REJECTED',
      message:
        'one or more takeoff itemTotals failed to bind to the published pricebook; nothing was transferred',
      failures: [...byItemCode.entries()].map(([itemCode, errors]) => ({
        itemCode,
        unit: unitsByCode.get(itemCode) ?? '',
        errors,
      })),
      skipped,
    };
  }

  // Append through the existing BOQ lifecycle (duplicate lineIds, edition checks and
  // line validation stay in the boq layer; the input estimate is never mutated).
  let updated = estimate;
  for (const line of resolution.lines) {
    updated = addBoqLine(updated, versionId, line);
  }

  return {
    ok: true,
    estimate: updated,
    lines: resolution.lines,
    transferred: candidates.map(({ total, lineId, itemCode }) => ({
      itemCode,
      unit: total.unit,
      lineId,
      quantity: total.qty,
      lineIds: [...total.lineIds],
      exactQty: total.exactQty,
      ...(total.roundedQty !== undefined ? { roundedQty: total.roundedQty } : {}),
    })),
    skipped,
  };
}
