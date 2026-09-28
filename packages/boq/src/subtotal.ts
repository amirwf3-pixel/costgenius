/**
 * Group and chapter subtotals — exact, unrounded, status-honest.
 *
 * A subtotal amount is emitted only when every line in scope is COMPLETE; otherwise the
 * amount is null and the status carries the reason (missing values are never treated as
 * zero). Aggregation uses the domain Money type (exact decimal arithmetic, no floating
 * point, no rounding — the source establishes no subtotal rounding rule). Negative
 * subtotals flow through unchanged.
 */
import { Money, canonical } from '@costgenius/domain';
import { type CalculationStatus, aggregateCalculationStatus } from '@costgenius/cost-calculation';
import type { BoqLine } from './boq-line.js';
import type { ChapterGroupLines, ChapterLines } from './grouping.js';

export interface SubtotalCounts {
  readonly lineCount: number;
  readonly pricedLineCount: number;
  readonly pendingLineCount: number;
  /** Union of the external dependencies of the non-complete lines. */
  readonly dependencies: readonly string[];
}

export interface GroupSubtotal extends SubtotalCounts {
  readonly chapter: string;
  readonly group: string;
  /** Exact sum of the complete lines, or null when the group is not COMPLETE. */
  readonly amount: string | null;
  readonly status: CalculationStatus;
}

export interface ChapterSubtotal extends SubtotalCounts {
  readonly chapter: string;
  readonly amount: string | null;
  readonly status: CalculationStatus;
  readonly groupSubtotals: readonly GroupSubtotal[];
}

function countsOf(lines: readonly BoqLine[]): SubtotalCounts {
  let priced = 0;
  const dependencies = new Set<string>();
  for (const line of lines) {
    if (line.calculationStatus === 'COMPLETE') {
      priced += 1;
    } else {
      for (const dependency of line.externalDependencies) dependencies.add(dependency);
    }
  }
  return {
    lineCount: lines.length,
    pricedLineCount: priced,
    pendingLineCount: lines.length - priced,
    dependencies: [...dependencies],
  };
}

function sumComplete(lines: readonly BoqLine[]): string | null {
  let sum: Money | undefined;
  for (const line of lines) {
    if (line.lineAmount === null) continue;
    sum = sum === undefined ? Money.of(line.lineAmount) : sum.add(Money.of(line.lineAmount));
  }
  return sum === undefined ? null : canonical(sum.toDecimal());
}

/** Subtotal of one chapter+group scope (exact; null amount unless COMPLETE). */
export function calculateGroupSubtotal(group: ChapterGroupLines): GroupSubtotal {
  const status = aggregateCalculationStatus(group.lines.map((line) => line.calculationStatus));
  return {
    chapter: group.chapter,
    group: group.group,
    amount: status === 'COMPLETE' ? sumComplete(group.lines) : null,
    status,
    ...countsOf(group.lines),
  };
}

/**
 * Chapter subtotal. The authoritative aggregation path is lines → group subtotals →
 * chapter subtotal: the chapter amount is the exact sum of its group amounts and is null
 * unless every group is COMPLETE.
 */
export function calculateChapterSubtotal(
  chapter: ChapterLines,
  groupSubtotals: readonly GroupSubtotal[],
): ChapterSubtotal {
  const status = aggregateCalculationStatus(groupSubtotals.map((g) => g.status));
  let amount: string | null = null;
  if (groupSubtotals.length > 0 && status === 'COMPLETE') {
    let sum: Money | undefined;
    for (const group of groupSubtotals) {
      if (group.amount === null) continue;
      sum = sum === undefined ? Money.of(group.amount) : sum.add(Money.of(group.amount));
    }
    amount = sum === undefined ? null : canonical(sum.toDecimal());
  }
  return {
    chapter: chapter.chapter,
    amount,
    status,
    groupSubtotals,
    ...countsOf(chapter.lines),
  };
}
