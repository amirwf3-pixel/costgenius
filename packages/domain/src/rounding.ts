import type { Decimal as DecimalJs } from 'decimal.js';
import { Decimal, assertScale, normalizeZero } from './decimal.js';

/** Explicit rounding modes. Nothing in the domain rounds implicitly. */
export const RoundingMode = {
  /** Away from zero on .5 (common commercial rounding). */
  HALF_UP: 'HALF_UP',
  /** Banker's rounding. */
  HALF_EVEN: 'HALF_EVEN',
  /** Toward zero (truncate). */
  DOWN: 'DOWN',
  /** Away from zero. */
  UP: 'UP',
  /** Toward -∞. */
  FLOOR: 'FLOOR',
  /** Toward +∞. */
  CEIL: 'CEIL',
} as const;
export type RoundingMode = (typeof RoundingMode)[keyof typeof RoundingMode];

/** A rounding instruction: number of fractional digits plus mode. */
export interface RoundingRule {
  readonly scale: number;
  readonly mode: RoundingMode;
}

const MODE_MAP: Record<RoundingMode, DecimalJs.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
  FLOOR: Decimal.ROUND_FLOOR,
  CEIL: Decimal.ROUND_CEIL,
};

export function roundDecimal(value: Decimal, rule: RoundingRule): Decimal {
  assertScale(rule.scale);
  return normalizeZero(value.toDecimalPlaces(rule.scale, MODE_MAP[rule.mode]));
}
