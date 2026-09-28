/**
 * The official Phase 17 golden estimate fixture — the internal regression baseline for
 * the production estimate workflow.
 *
 * v1 ("as-taken" mix) deliberately combines priced rows with the two blocked kinds so the
 * workflow exercises every integrity rule at once, using ONLY verified 1404 prices:
 * - `010101` — leading-zero code, base price 2890 (m2)
 * - `270320` — NEGATIVE verified price −1,037,000 (m3)
 * - `270403` — NEGATIVE verified price −2,131,000 (m3)
 * - `220925` — deduction row (`کسر بها`): basePrice null — NEVER zero (m2)
 * - `090320` — star item, external dependency, unpriced (kg)
 *
 * Because two lines are unpriced, v1 is INCOMPLETE: its rollup amount and S4 total are
 * `null` (never 0) — that null is part of the fixture's expected result.
 *
 * v2 (the revision, see workflow.test.ts) uses the COMPLETE 8-line fixture
 * (`COMPLETE_LINES` in helpers.ts) whose exact S4 chain is
 * 38147600 → ×1.0451 → ×1.30 → ×1.1 → +12000000 → 69011321.1668.
 */
import { COMPLETE_LINES, COMPLETE_S4_EXPECTED } from './helpers.js';

/** The five required codes (exact units, exact decimal quantities). */
export const GOLDEN_WORKFLOW_LINES = [
  { lineId: 'g1', pricebookCode: '010101', quantity: '1000', unit: 'm2' },
  { lineId: 'g2', pricebookCode: '270320', quantity: '10', unit: 'm3' },
  { lineId: 'g3', pricebookCode: '270403', quantity: '2', unit: 'm3' },
  { lineId: 'g4', pricebookCode: '220925', quantity: '40', unit: 'm2' },
  { lineId: 'g5', pricebookCode: '090320', quantity: '80', unit: 'kg' },
] as const;

/** Priced part of the v1 subtotal (exact strings): 1000×2890 − 10×1037000 − 2×2131000. */
export const GOLDEN_V1_EXPECTED = {
  pricedLineCount: 3,
  pendingLineCount: 2,
  lineCount: 5,
  /** The rollup of a version containing unpriced lines: null, never 0. */
  rollupAmount: null,
  s4FinalEstimate: null,
  negativePrices: ['-1037000', '-2131000'],
  deductionNote: 'کسر بها',
  externalDependencyLine: 'g5',
  leadingZeroCode: '010101',
} as const;

/** The v2 revision fixture and its exact, attested result. */
export const GOLDEN_V2_LINES = COMPLETE_LINES;
export const GOLDEN_V2_EXPECTED = COMPLETE_S4_EXPECTED;
