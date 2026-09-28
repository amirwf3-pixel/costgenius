import { Decimal as DecimalJs } from 'decimal.js';
import { DomainError } from './errors.js';

/**
 * Isolated Decimal constructor. Configuration is fixed and never mutated so results
 * do not depend on global state. Precision is significant digits for inexact ops
 * (none of the public operations here are inexact except explicit rounding).
 */
export const Decimal = DecimalJs.clone({
  precision: 60,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
  minE: -9e15,
  maxE: 9e15,
});
export type Decimal = InstanceType<typeof Decimal>;

/** Strict decimal literal: optional sign, digits, optional fraction. No exponent, no whitespace. */
const DECIMAL_LITERAL = /^[+-]?(\d+)(\.\d+)?$/;

/**
 * Accepted inputs:
 * - string decimal literal ("12", "-0.125")
 * - bigint
 * - number, only if it is a safe integer (fractional JS numbers are already imprecise)
 */
export type DecimalInput = string | bigint | number;

export function toDecimal(input: DecimalInput): Decimal {
  if (typeof input === 'bigint') return new Decimal(input.toString());
  if (typeof input === 'number') {
    if (!Number.isFinite(input))
      throw new DomainError('NON_FINITE', `non-finite number ${String(input)}`);
    if (!Number.isSafeInteger(input)) {
      throw new DomainError(
        'UNSAFE_NUMBER',
        `number ${String(input)} is not a safe integer; pass fractional values as decimal strings`,
      );
    }
    return normalizeZero(new Decimal(input));
  }
  if (!DECIMAL_LITERAL.test(input)) {
    throw new DomainError('INVALID_DECIMAL', `"${input}" is not a plain decimal literal`);
  }
  return normalizeZero(new Decimal(input));
}

/** Collapse -0 to 0 so canonical output is stable. */
export function normalizeZero(d: Decimal): Decimal {
  return d.isZero() ? new Decimal(0) : d;
}

export function assertScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 20) {
    throw new DomainError(
      'INVALID_SCALE',
      `scale must be an integer in [0, 20], got ${String(scale)}`,
    );
  }
}

/** Canonical, locale-independent, non-exponential string. */
export function canonical(d: Decimal): string {
  return normalizeZero(d).toFixed();
}
