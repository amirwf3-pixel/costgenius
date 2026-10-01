/**
 * The estimate rollup — one authoritative aggregation path.
 *
 * lines → group subtotals → chapter subtotals → estimate total. The total is the exact sum
 * of the chapter amounts and is emitted only when every chapter is COMPLETE; a pending
 * estimate never shows a normal-looking total. Nothing is rounded here.
 *
 * Combined multi-building and multi-discipline rollups are NOT_SPECIFIED: the 1404 source
 * states no method for combining several buildings with different floor coefficients in
 * one chain, nor a cross-discipline combination basis (implementation-contract block E);
 * this layer records that boundary instead of inventing a formula.
 */
import { Money, canonical } from '@costgenius/domain';
import { type CalculationStatus, aggregateCalculationStatus } from '@costgenius/cost-calculation';
import type { BoqLine } from './boq-line.js';
import { groupLinesByChapter, groupLinesByChapterGroup } from './grouping.js';
import {
  calculateChapterSubtotal,
  calculateGroupSubtotal,
  type ChapterSubtotal,
  type SubtotalCounts,
} from './subtotal.js';

export interface BoqRollup extends SubtotalCounts {
  /** Exact total, or null unless the whole version is COMPLETE. */
  readonly amount: string | null;
  readonly status: CalculationStatus;
  readonly chapterSubtotals: readonly ChapterSubtotal[];
}

function sumCounts(counts: readonly SubtotalCounts[]): SubtotalCounts {
  let priced = 0;
  let lineCount = 0;
  const dependencies = new Set<string>();
  for (const c of counts) {
    priced += c.pricedLineCount;
    lineCount += c.lineCount;
    for (const dependency of c.dependencies) dependencies.add(dependency);
  }
  return {
    lineCount,
    pricedLineCount: priced,
    pendingLineCount: lineCount - priced,
    dependencies: [...dependencies],
  };
}

/** Rolls up a version's lines through the single authoritative path. */
export function rollupBoqLines(lines: readonly BoqLine[]): BoqRollup {
  const groupSubtotals = groupLinesByChapterGroup(lines).map((g) => calculateGroupSubtotal(g));
  const chapterSubtotals = groupLinesByChapter(lines).map((chapter) =>
    calculateChapterSubtotal(
      chapter,
      groupSubtotals.filter((g) => g.chapter === chapter.chapter),
    ),
  );

  const status = aggregateCalculationStatus(chapterSubtotals.map((c) => c.status));
  let amount: string | null = null;
  if (status === 'COMPLETE') {
    let sum: Money | undefined;
    for (const chapter of chapterSubtotals) {
      if (chapter.amount === null) continue;
      sum = sum === undefined ? Money.of(chapter.amount) : sum.add(Money.of(chapter.amount));
    }
    amount = sum === undefined ? '0' : canonical(sum.toDecimal());
  }

  return { amount, status, chapterSubtotals, ...sumCounts(chapterSubtotals) };
}

/** Blocked combined rollups (explicit, never silently computed). */
export interface BlockedRollup {
  readonly status: 'NOT_SPECIFIED';
  readonly message: string;
}

/** A combined multi-building rollup is not specified by the 1404 source (per-building P; no combination method). */
export function combinedMultiBuildingRollup(): BlockedRollup {
  return {
    status: 'NOT_SPECIFIED',
    message:
      'the 1404 source calculates the floor coefficient per building and states no method for combining several buildings into one coefficient chain (implementation-contract block E); group by building is supported, a combined rollup is not',
  };
}

/** A combined multi-discipline rollup is not specified by the 1404 source (one R per discipline; no cross-discipline basis). */
export function combinedMultiDisciplineRollup(): BlockedRollup {
  return {
    status: 'NOT_SPECIFIED',
    message:
      'the 1404 source prepares each discipline separately under its own price list and states no cross-discipline combination basis for a single coefficient chain; per-discipline estimates and a summary listing stay the supported boundary',
  };
}
