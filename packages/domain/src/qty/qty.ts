import { type Decimal, type DecimalInput, canonical, toDecimal } from '../decimal.js';
import { DomainError } from '../errors.js';
import { Money } from '../money/money.js';
import { type RoundingRule, roundDecimal } from '../rounding.js';
import { type UnitCode, parseUnitCode } from '../units.js';

/**
 * Exact quantity bound to a unit. Immutable. Negative quantities are allowed because
 * takeoff deductions are modelled as negative lines (ARCHITECTURE.md §4.1).
 */
export class Qty {
  readonly unit: UnitCode;
  readonly #value: Decimal;

  private constructor(value: Decimal, unit: UnitCode) {
    this.#value = value;
    this.unit = unit;
    Object.freeze(this);
  }

  static of(value: DecimalInput, unit: string): Qty {
    return new Qty(toDecimal(value), parseUnitCode(unit));
  }

  static zero(unit: UnitCode): Qty {
    return new Qty(toDecimal(0), unit);
  }

  /** Exact sum; all items must share `unit`. */
  static sum(items: readonly Qty[], unit: UnitCode): Qty {
    return items.reduce((acc, q) => acc.add(q), Qty.zero(unit));
  }

  static #from(value: Decimal, unit: UnitCode): Qty {
    return new Qty(toDecimal(canonical(value)), unit);
  }

  add(other: Qty): Qty {
    this.#assertSameUnit(other);
    return Qty.#from(this.#value.plus(other.#value), this.unit);
  }

  subtract(other: Qty): Qty {
    this.#assertSameUnit(other);
    return Qty.#from(this.#value.minus(other.#value), this.unit);
  }

  /** Exact scaling by a dimensionless factor (e.g. a count). Unit is unchanged. */
  scale(factor: DecimalInput): Qty {
    return Qty.#from(this.#value.times(toDecimal(factor)), this.unit);
  }

  negate(): Qty {
    return Qty.#from(this.#value.negated(), this.unit);
  }

  round(rule: RoundingRule): Qty {
    return Qty.#from(roundDecimal(this.#value, rule), this.unit);
  }

  /**
   * Exact extension: quantity × unit price. The caller asserts the price is expressed
   * per `priceUnit`; mismatch is an error. Result is unrounded.
   */
  priceAt(unitPrice: Money, priceUnit: UnitCode): Money {
    if (priceUnit !== this.unit) {
      throw new DomainError('UNIT_MISMATCH', `quantity in ${this.unit}, price per ${priceUnit}`);
    }
    return Money.fromDecimal(this.#value.times(unitPrice.toDecimal()), unitPrice.currency);
  }

  compare(other: Qty): -1 | 0 | 1 {
    this.#assertSameUnit(other);
    return this.#value.comparedTo(other.#value) as -1 | 0 | 1;
  }

  equals(other: Qty): boolean {
    return this.unit === other.unit && this.#value.equals(other.#value);
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isNegative(): boolean {
    return this.#value.isNegative() && !this.#value.isZero();
  }

  /** Canonical decimal string of the value (unit excluded). */
  toString(): string {
    return canonical(this.#value);
  }

  toJSON(): { value: string; unit: UnitCode } {
    return { value: this.toString(), unit: this.unit };
  }

  #assertSameUnit(other: Qty): void {
    if (other.unit !== this.unit) {
      throw new DomainError('UNIT_MISMATCH', `${this.unit} vs ${other.unit}`);
    }
  }
}
