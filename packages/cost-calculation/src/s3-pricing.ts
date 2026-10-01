/**
 * S3 — line pricing.
 *
 * Line amount = quantity × base price, computed exactly with the domain Money/Qty value
 * types (integer-Rial decimal strings; no floating point). There is no rounding in S3: the
 * result is the exact product, because the 1404 source establishes no line-level rounding
 * rule for this stage. Negative quantities stay negative (deduction lines); the sign is
 * never normalised. Rows whose verification status is not VERIFIED_SPEC_ONLY, or whose
 * price is blank, are never silently priced: their line amount is null and the calculation
 * status carries the reason (INCOMPLETE, EXTERNAL_DEPENDENCY or NOT_SPECIFIED) — a blank
 * price never becomes zero.
 */
import { Money, Qty, canonical } from '@costgenius/domain';
import type { PricebookStatus, SourceReference } from '@costgenius/pricebook';
import { aggregateCalculationStatus, type CalculationStatus } from './types.js';
import type { BoundBoqLine } from './s2-binding.js';

export interface LineCalculationTrace {
  readonly quantity: string;
  readonly unitPrice: string | null;
  readonly operation: 'multiply';
  readonly lineAmount: string | null;
}

export interface PricedBoqLine {
  readonly lineId: string;
  readonly pricebookCode: string;
  readonly pricebookChapter: string;
  readonly quantity: string;
  readonly unit: BoundBoqLine['unit'];
  readonly basePrice: string | null;
  readonly lineAmount: string | null;
  readonly calculationStatus: CalculationStatus;
  readonly pricebookStatus: PricebookStatus;
  readonly sourceRef: SourceReference;
  readonly dependencies: readonly string[];
  readonly trace: LineCalculationTrace;
}

function unpricedLine(bound: BoundBoqLine, status: CalculationStatus): PricedBoqLine {
  return {
    lineId: bound.lineId,
    pricebookCode: bound.pricebookRow.code,
    pricebookChapter: bound.pricebookRow.chapter,
    quantity: bound.quantity,
    unit: bound.unit,
    basePrice: bound.pricebookRow.basePrice,
    lineAmount: null,
    calculationStatus: status,
    pricebookStatus: bound.status,
    sourceRef: bound.sourceRef,
    dependencies: [...bound.externalDependencies],
    trace: {
      quantity: bound.quantity,
      unitPrice: bound.pricebookRow.basePrice,
      operation: 'multiply',
      lineAmount: null,
    },
  };
}

/** Prices one bound line exactly. The trace records quantity × unit price = line amount. */
export function priceBoqLine(bound: BoundBoqLine): PricedBoqLine {
  if (bound.status === 'INCOMPLETE') return unpricedLine(bound, 'INCOMPLETE');
  if (bound.status === 'EXTERNAL_DEPENDENCY') return unpricedLine(bound, 'EXTERNAL_DEPENDENCY');
  if (bound.status === 'NOT_SPECIFIED_IN_1404_PRICEBOOK')
    return unpricedLine(bound, 'NOT_SPECIFIED');
  if (bound.pricebookRow.basePrice === null) return unpricedLine(bound, 'INCOMPLETE');

  const amount = Qty.of(bound.quantity, bound.unit).priceAt(
    Money.of(bound.pricebookRow.basePrice),
    bound.unit,
  );
  return {
    lineId: bound.lineId,
    pricebookCode: bound.pricebookRow.code,
    pricebookChapter: bound.pricebookRow.chapter,
    quantity: bound.quantity,
    unit: bound.unit,
    basePrice: bound.pricebookRow.basePrice,
    lineAmount: canonical(amount.toDecimal()),
    calculationStatus: 'COMPLETE',
    pricebookStatus: bound.status,
    sourceRef: bound.sourceRef,
    dependencies: [...bound.externalDependencies],
    trace: {
      quantity: bound.quantity,
      unitPrice: bound.pricebookRow.basePrice,
      operation: 'multiply',
      lineAmount: canonical(amount.toDecimal()),
    },
  };
}

export interface PricedLinesTotal {
  /** Exact sum of the complete lines, or null when any line is not COMPLETE. */
  readonly total: string | null;
  readonly calculationStatus: CalculationStatus;
}

/**
 * Sums priced lines exactly. The total is emitted only when every line is COMPLETE —
 * a partial sum is never presented as the total.
 */
export function sumPricedLines(lines: readonly PricedBoqLine[]): PricedLinesTotal {
  const status = aggregateCalculationStatus(lines.map((line) => line.calculationStatus));
  if (status !== 'COMPLETE') return { total: null, calculationStatus: status };
  let sum = Money.zero();
  for (const line of lines) {
    if (line.lineAmount === null) continue;
    sum = sum.add(Money.of(line.lineAmount));
  }
  return { total: canonical(sum.toDecimal()), calculationStatus: 'COMPLETE' };
}
