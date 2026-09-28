import { type Decimal, type DecimalInput, canonical, toDecimal } from '../decimal.js';
import { DomainError } from '../errors.js';
import { type RoundingRule, roundDecimal } from '../rounding.js';

/**
 * Only Iranian Rial is a storage currency. Toman is a display concern (ARCHITECTURE.md §5).
 */
export type CurrencyCode = 'IRR';

/**
 * Exact monetary amount. Immutable. Arithmetic is exact (add/sub/mul); rounding only
 * happens through an explicit RoundingRule. Intermediate values may carry fractional
 * Rials (e.g. unit price × fractional quantity); round explicitly before persisting totals.
 */
export class Money {
  readonly currency: CurrencyCode;
  readonly #amount: Decimal;

  private constructor(amount: Decimal, currency: CurrencyCode) {
    this.#amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  static of(amount: DecimalInput, currency: CurrencyCode = 'IRR'): Money {
    return new Money(toDecimal(amount), currency);
  }

  static zero(currency: CurrencyCode = 'IRR'): Money {
    return new Money(toDecimal(0), currency);
  }

  /** Exact sum; empty list yields zero. */
  static sum(items: readonly Money[], currency: CurrencyCode = 'IRR'): Money {
    return items.reduce((acc, m) => acc.add(m), Money.zero(currency));
  }

  /** @internal for sibling value types (Qty × price). */
  static fromDecimal(amount: Decimal, currency: CurrencyCode): Money {
    return new Money(toDecimal(canonical(amount)), currency);
  }

  add(other: Money): Money {
    this.#assertSameCurrency(other);
    return Money.fromDecimal(this.#amount.plus(other.#amount), this.currency);
  }

  subtract(other: Money): Money {
    this.#assertSameCurrency(other);
    return Money.fromDecimal(this.#amount.minus(other.#amount), this.currency);
  }

  /** Exact multiplication by a dimensionless factor (e.g. a coefficient). */
  multiply(factor: DecimalInput): Money {
    return Money.fromDecimal(this.#amount.times(toDecimal(factor)), this.currency);
  }

  negate(): Money {
    return Money.fromDecimal(this.#amount.negated(), this.currency);
  }

  round(rule: RoundingRule): Money {
    return Money.fromDecimal(roundDecimal(this.#amount, rule), this.currency);
  }

  /** Round to whole Rials. */
  roundToRial(mode: RoundingRule['mode']): Money {
    return this.round({ scale: 0, mode });
  }

  compare(other: Money): -1 | 0 | 1 {
    this.#assertSameCurrency(other);
    return this.#amount.comparedTo(other.#amount) as -1 | 0 | 1;
  }

  equals(other: Money): boolean {
    return this.#sameCurrency(other) && this.#amount.equals(other.#amount);
  }

  isZero(): boolean {
    return this.#amount.isZero();
  }

  isNegative(): boolean {
    return this.#amount.isNegative() && !this.#amount.isZero();
  }

  isWholeRial(): boolean {
    return this.#amount.isInteger();
  }

  /** Canonical decimal string (no exponent, no trailing zeros, no -0). */
  toString(): string {
    return canonical(this.#amount);
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toString(), currency: this.currency };
  }

  /** @internal exact underlying value for sibling domain types. */
  toDecimal(): Decimal {
    return this.#amount;
  }

  // Compared as plain strings: CurrencyCode is a single literal today, but values may
  // arrive from untyped boundaries (DB/JSON) and the union may widen later.
  #sameCurrency(other: Money): boolean {
    const a: string = this.currency;
    const b: string = other.currency;
    return a === b;
  }

  #assertSameCurrency(other: Money): void {
    if (!this.#sameCurrency(other)) {
      throw new DomainError('CURRENCY_MISMATCH', `${this.currency} vs ${other.currency}`);
    }
  }
}
