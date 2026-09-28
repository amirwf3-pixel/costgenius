/**
 * The BOQ line — a frozen snapshot of one S2/S3 result.
 *
 * A line is created only from a bound (S2) and priced (S3) pair that refer to the same
 * binding, and it copies — never references — everything needed to reproduce the result
 * later: exact pricebook identity (code, chapter, group, description, printed unit label +
 * code), quantity, base price, line amount, both statuses, the source reference, the
 * external dependencies, the edition, the calculation trace and the row's printed notes
 * (so a blocked line carries its source classification, e.g. 220925's deduction note).
 * After creation the line no longer depends on a live pricebook lookup, so a finalized
 * estimate version cannot silently recalculate when the dataset changes.
 *
 * Identity is `lineId`, not the pricebook code: two lines may carry the same code as
 * separate measurement entries and are never merged.
 */
import type { BoundBoqLine, PricedBoqLine } from '@costgenius/cost-calculation';
import type { CalculationStatus } from '@costgenius/cost-calculation';
import type { PricebookStatus, SourceReference } from '@costgenius/pricebook';
import type { QuantityItemInput, QuantityItemResult } from '@costgenius/calc-engine';
import { BoqError } from './errors.js';

/**
 * D-015: the canonical S1 provenance persisted on a dimensionally computed line —
 * everything needed to replay the quantity later (the exact engine input, the engine's
 * own output and both engine versions). Defined here (boq owns the persisted line
 * contract) from the frozen engine's own types; projects re-exports it.
 */
export interface TakeoffProvenance {
  readonly input: QuantityItemInput;
  readonly output: QuantityItemResult;
  readonly specVersion: string;
  readonly engineVersion: string;
}

/**
 * D-016 (G2=B): the Full-Takeoff transfer provenance persisted on a transferred BOQ line
 * (CG-FT-TAKEOFF-SPEC §8.1) — SEPARATE from D-015's `trace.takeoff` (quick-entry lines),
 * which stays reserved and byte-compatible. One BOQ line carries one itemCode/itemTotal;
 * `lineIds` are the contributing Takeoff lines, so "which Takeoff lines produced this BOQ
 * line?" is always answerable from the line itself. The full calculation trace stays in
 * the finalized Takeoff snapshot — the BOQ line never duplicates the whole document.
 *
 * `exactQty` is always the engine's exact aggregate; `roundedQty` exists iff an item-total
 * rule matched; `qty` is the effective value the line carries (R2=C: rounded iff a rule
 * matched, otherwise exact — never re-rounded downstream).
 *
 * NOTE (documented deviation): the spec sketch lists an optional `roundingRule?` (the
 * matched item-total rule entry). The frozen engine result contract (TakeoffItemTotal,
 * CG-IR-MEAS@0.2.0) does NOT expose the matched rule entry, and re-deriving it would
 * duplicate the engine's selector matching — so it is deliberately absent here. The
 * complete applied rule set remains in the finalized Takeoff snapshot (`input.rounding`).
 */
export interface TakeoffDocumentProvenance {
  /** The source finalized document revision (per-revision identity, CG-FT §2.2). */
  readonly takeoffDocumentId: string;
  readonly takeoffId: string;
  readonly documentNumber: number;
  readonly itemCode: string;
  readonly unit: string;
  /** The contributing Takeoff lines, in the engine's aggregation order. */
  readonly lineIds: readonly string[];
  readonly exactQty: string;
  readonly roundedQty?: string;
  readonly qty: string;
  readonly specVersion: string;
  readonly engineVersion: string;
}

export interface BoqLineUnit {
  /** Printed unit label, verbatim. */
  readonly label: string;
  readonly code: string;
}

export interface BoqLineTrace {
  readonly quantity: string;
  readonly unitPrice: string | null;
  readonly operation: 'multiply';
  readonly lineAmount: string | null;
  /**
   * D-015: S1 dimensional provenance when calc-engine computed the quantity (input,
   * output and both engine versions — everything needed to replay the quantity). Absent
   * on manually entered lines; its presence is the only trace-shape difference.
   */
  readonly takeoff?: TakeoffProvenance;
  /**
   * D-016 (G2=B): transfer provenance when this line was created from a finalized Full
   * Takeoff itemTotal (CG-FT §8.1). Absent on manual and quick-entry lines; its presence
   * is the only additional trace-shape difference.
   */
  readonly takeoffDocument?: TakeoffDocumentProvenance;
}

export interface BoqLine {
  readonly lineId: string;
  readonly pricebookCode: string;
  readonly chapter: string;
  readonly group: string;
  readonly description: string;
  readonly unit: BoqLineUnit;
  readonly quantity: string;
  readonly basePrice: string | null;
  readonly lineAmount: string | null;
  readonly pricebookStatus: PricebookStatus;
  readonly calculationStatus: CalculationStatus;
  readonly sourceRef: SourceReference;
  /** Edition identity of the pricebook the row came from (e.g. "1404"). */
  readonly edition: string;
  readonly externalDependencies: readonly string[];
  /** Pricebook-row notes, copied verbatim (e.g. the deduction classification of 220925). */
  readonly notes: readonly string[];
  readonly trace: BoqLineTrace;
  /** Optional building attribution (grouping metadata only; no combined rule is invented). */
  readonly buildingId?: string;
  /** Optional landscaping flag (P exclusion scope; S4 concerns, carried as metadata). */
  readonly landscaping?: boolean;
}

export interface BoqLineExtras {
  readonly buildingId?: string;
  readonly landscaping?: boolean;
  /** D-015: S1 provenance persisted into the line's trace (see BoqLineTrace.takeoff). */
  readonly takeoff?: TakeoffProvenance;
  /** D-016: transfer provenance persisted into the line's trace (see BoqLineTrace.takeoffDocument). */
  readonly takeoffDocument?: TakeoffDocumentProvenance;
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
 * Creates a BOQ line from one S2/S3 pair. The pair must refer to the same binding
 * (lineId, code, quantity, unit and pricebook status); anything else is a LINE_MISMATCH.
 */
export function createBoqLine(
  bound: BoundBoqLine,
  priced: PricedBoqLine,
  extras?: BoqLineExtras,
): BoqLine {
  if (
    bound.lineId !== priced.lineId ||
    bound.pricebookRow.code !== priced.pricebookCode ||
    bound.quantity !== priced.quantity ||
    bound.unit !== priced.unit ||
    bound.status !== priced.pricebookStatus
  ) {
    throw new BoqError(
      'LINE_MISMATCH',
      `the priced line ${priced.lineId} does not belong to the bound line ${bound.lineId}`,
    );
  }
  // D-015: when S1 provenance travels with the line, the quantity MUST be the engine's
  // own output — the caller never asserts a computed quantity or provenance itself.
  if (extras?.takeoff !== undefined && extras.takeoff.output.qty !== priced.quantity) {
    throw new BoqError(
      'LINE_MISMATCH',
      `the takeoff provenance of line ${priced.lineId} computes quantity ${extras.takeoff.output.qty} but the line carries ${priced.quantity}; the quantity is always the engine's own output`,
    );
  }
  // D-016: transfer provenance must describe exactly this line — the same itemCode, the
  // same unit, and the itemTotal's effective quantity (R2=C). Anything else is a
  // LINE_MISMATCH; the transfer layer never asserts values the line does not carry.
  if (extras?.takeoffDocument !== undefined) {
    const provenance = extras.takeoffDocument;
    if (
      provenance.itemCode !== priced.pricebookCode ||
      provenance.unit !== priced.unit ||
      provenance.qty !== priced.quantity
    ) {
      throw new BoqError(
        'LINE_MISMATCH',
        `the takeoff transfer provenance of line ${priced.lineId} (itemCode ${provenance.itemCode}, unit ${provenance.unit}, qty ${provenance.qty}) does not describe the priced line (${priced.pricebookCode}, ${priced.unit}, ${priced.quantity}); a transferred line is always its itemTotal's effective quantity`,
      );
    }
  }

  const pricedTrace: BoqLineTrace = {
    ...structuredClone(priced.trace),
    ...(extras?.takeoff !== undefined ? { takeoff: structuredClone(extras.takeoff) } : {}),
    ...(extras?.takeoffDocument !== undefined
      ? { takeoffDocument: structuredClone(extras.takeoffDocument) }
      : {}),
  };
  const line: BoqLine = {
    lineId: priced.lineId,
    pricebookCode: priced.pricebookCode,
    chapter: bound.pricebookRow.chapter,
    group: bound.pricebookRow.group,
    description: bound.pricebookRow.description,
    unit: { label: bound.pricebookRow.unit.label, code: bound.pricebookRow.unit.code },
    quantity: priced.quantity,
    basePrice: priced.basePrice,
    lineAmount: priced.lineAmount,
    pricebookStatus: priced.pricebookStatus,
    calculationStatus: priced.calculationStatus,
    sourceRef: structuredClone(bound.sourceRef),
    edition: bound.sourceRef.edition,
    externalDependencies: [...priced.dependencies],
    notes: [...bound.pricebookRow.notes],
    trace: pricedTrace,
    ...(extras?.buildingId !== undefined ? { buildingId: extras.buildingId } : {}),
    ...(extras?.landscaping !== undefined ? { landscaping: extras.landscaping } : {}),
  };
  return deepFreeze(line);
}
