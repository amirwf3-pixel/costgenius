import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors.js';
import { Money } from '../money/money.js';
import { RoundingMode } from '../rounding.js';
import { Qty } from './qty.js';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  throw new Error('expected DomainError');
};

describe('Qty precision', () => {
  it('adds exactly', () => {
    expect(Qty.of('0.1', 'm3').add(Qty.of('0.2', 'm3')).toString()).toBe('0.3');
  });

  it('scales exactly', () => {
    expect(Qty.of('3.333', 'm2').scale(3).toString()).toBe('9.999');
    expect(Qty.of('12.5', 'kg').scale('0.08').toString()).toBe('1');
  });

  it('supports negative (deduction) quantities and exact cancellation', () => {
    const gross = Qty.of('24.36', 'm2');
    const opening = Qty.of('-2.16', 'm2');
    expect(gross.add(opening).toString()).toBe('22.2');
    expect(gross.add(gross.negate()).toString()).toBe('0');
    expect(opening.isNegative()).toBe(true);
  });

  it('extends quantity × unit price exactly, unrounded', () => {
    const amount = Qty.of('12.345', 'm3').priceAt(Money.of('1234567'), 'm3');
    expect(amount.toString()).toBe('15240729.615');
  });

  it('sum is order-independent', () => {
    const items = ['1.1', '2.22', '-0.333', '4444.4444'].map((v) => Qty.of(v, 'm'));
    expect(Qty.sum(items, 'm').toString()).toBe(Qty.sum([...items].reverse(), 'm').toString());
    expect(Qty.sum(items, 'm').toString()).toBe('4447.4314');
  });
});

describe('Qty rounding', () => {
  it.each([
    ['1.2345', RoundingMode.HALF_UP, '1.235'],
    ['1.2345', RoundingMode.HALF_EVEN, '1.234'],
    ['1.2349', RoundingMode.DOWN, '1.234'],
  ] as const)('%s %s at scale 3 → %s', (v, mode, expected) => {
    expect(Qty.of(v, 'm3').round({ scale: 3, mode }).toString()).toBe(expected);
  });

  it('keeps the unit after rounding', () => {
    expect(Qty.of('1.5', 't').round({ scale: 0, mode: 'HALF_UP' }).unit).toBe('t');
  });
});

describe('Qty invalid values', () => {
  it('rejects unknown units', () => {
    expect(code(() => Qty.of('1', 'sqm'))).toBe('UNKNOWN_UNIT');
    expect(code(() => Qty.of('1', ''))).toBe('UNKNOWN_UNIT');
  });

  it('rejects invalid numbers', () => {
    expect(code(() => Qty.of('abc', 'm'))).toBe('INVALID_DECIMAL');
    expect(code(() => Qty.of('1e2', 'm'))).toBe('INVALID_DECIMAL');
    expect(code(() => Qty.of(0.5, 'm'))).toBe('UNSAFE_NUMBER');
    expect(code(() => Qty.of(Number.NaN, 'm'))).toBe('NON_FINITE');
  });

  it('never silently converts between units', () => {
    expect(code(() => Qty.of('1', 'm').add(Qty.of('1', 'm2')))).toBe('UNIT_MISMATCH');
    expect(code(() => Qty.of('1', 'kg').compare(Qty.of('1', 't')))).toBe('UNIT_MISMATCH');
    expect(code(() => Qty.of('1', 'm3').priceAt(Money.of(100), 'm2'))).toBe('UNIT_MISMATCH');
    expect(Qty.of('1', 'm').equals(Qty.of('1', 'm2'))).toBe(false);
  });
});

describe('Qty determinism', () => {
  it('same inputs produce identical serialized output', () => {
    const run = (): string =>
      JSON.stringify(
        Qty.of('2.75', 'm')
          .scale('3.2')
          .add(Qty.of('-0.05', 'm'))
          .round({ scale: 2, mode: 'HALF_UP' }),
      );
    const first = run();
    for (let i = 0; i < 100; i++) expect(run()).toBe(first);
    expect(first).toBe('{"value":"8.75","unit":"m"}');
  });

  it('is immutable', () => {
    const q = Qty.of('1', 'm');
    q.scale(5);
    expect(q.toString()).toBe('1');
    expect(Object.isFrozen(q)).toBe(true);
  });
});
