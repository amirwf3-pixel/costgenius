import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors.js';
import { RoundingMode } from '../rounding.js';
import { Money } from './money.js';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  throw new Error('expected DomainError');
};

describe('Money precision', () => {
  it('adds decimals exactly (no binary float error)', () => {
    expect(Money.of('0.1').add(Money.of('0.2')).toString()).toBe('0.3');
  });

  it('handles very large Rial amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const big = Money.of('987654321987654321987654321');
    expect(big.add(Money.of(1)).toString()).toBe('987654321987654321987654322');
    expect(Money.of(12345678901234567890n).toString()).toBe('12345678901234567890');
  });

  it('multiplies by a coefficient exactly', () => {
    expect(Money.of('1234567').multiply('1.075').toString()).toBe('1327159.525');
  });

  it('sum is exact and independent of order', () => {
    const items = ['0.1', '0.2', '0.3', '3', '-0.6'].map((v) => Money.of(v));
    const a = Money.sum(items).toString();
    const b = Money.sum([...items].reverse()).toString();
    expect(a).toBe(b);
    expect(a).toBe('3');
    expect(Money.sum([]).toString()).toBe('0');
  });

  it('produces canonical strings (no exponent, no trailing zeros, no -0)', () => {
    expect(Money.of('1.2300').toString()).toBe('1.23');
    expect(Money.of('-0.000').toString()).toBe('0');
    expect(Money.of('5').subtract(Money.of('5')).toString()).toBe('0');
    expect(Money.of('0.0000000000001').toString()).toBe('0.0000000000001');
    expect(Money.of('100000000000000000000000').toString()).toBe('100000000000000000000000');
  });
});

describe('Money rounding', () => {
  const cases: [string, RoundingMode, string][] = [
    ['2.5', RoundingMode.HALF_UP, '3'],
    ['-2.5', RoundingMode.HALF_UP, '-3'],
    ['2.5', RoundingMode.HALF_EVEN, '2'],
    ['3.5', RoundingMode.HALF_EVEN, '4'],
    ['2.9', RoundingMode.DOWN, '2'],
    ['-2.9', RoundingMode.DOWN, '-2'],
    ['2.1', RoundingMode.UP, '3'],
    ['-2.1', RoundingMode.FLOOR, '-3'],
    ['-2.9', RoundingMode.CEIL, '-2'],
    ['-0.4', RoundingMode.HALF_UP, '0'],
  ];
  it.each(cases)('%s %s → %s', (input, mode, expected) => {
    expect(Money.of(input).roundToRial(mode).toString()).toBe(expected);
  });

  it('rounds to a given scale', () => {
    expect(Money.of('1.005').round({ scale: 2, mode: RoundingMode.HALF_UP }).toString()).toBe(
      '1.01',
    );
  });

  it('does not round implicitly', () => {
    const m = Money.of('10').multiply('0.333');
    expect(m.isWholeRial()).toBe(false);
    expect(m.toString()).toBe('3.33');
  });

  it('rejects invalid scales', () => {
    expect(code(() => Money.of(1).round({ scale: -1, mode: 'HALF_UP' }))).toBe('INVALID_SCALE');
    expect(code(() => Money.of(1).round({ scale: 1.5, mode: 'HALF_UP' }))).toBe('INVALID_SCALE');
  });
});

describe('Money invalid values', () => {
  it.each(['', ' 1', '1 ', '1e3', '1,000', '۱۲', 'NaN', 'Infinity', '0x10', '.5', '5.', '--1'])(
    'rejects string %j',
    (v) => {
      expect(code(() => Money.of(v))).toBe('INVALID_DECIMAL');
    },
  );

  it('rejects non-finite and imprecise JS numbers', () => {
    expect(code(() => Money.of(Number.NaN))).toBe('NON_FINITE');
    expect(code(() => Money.of(Number.POSITIVE_INFINITY))).toBe('NON_FINITE');
    expect(code(() => Money.of(0.1))).toBe('UNSAFE_NUMBER');
    expect(code(() => Money.of(2 ** 53))).toBe('UNSAFE_NUMBER');
  });

  it('rejects currency mismatch at runtime', () => {
    const other = Money.of(1, 'XXX' as never);
    expect(code(() => Money.of(1).add(other))).toBe('CURRENCY_MISMATCH');
  });
});

describe('Money determinism & immutability', () => {
  it('same inputs produce identical serialized output', () => {
    const run = (): string =>
      JSON.stringify(
        Money.of('123.456')
          .multiply('7.89')
          .add(Money.of('0.001'))
          .round({ scale: 2, mode: 'HALF_EVEN' }),
      );
    const first = run();
    for (let i = 0; i < 100; i++) expect(run()).toBe(first);
    expect(first).toBe('{"amount":"974.07","currency":"IRR"}');
  });

  it('operations return new instances and do not mutate', () => {
    const a = Money.of('10');
    a.add(Money.of('5'));
    expect(a.toString()).toBe('10');
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('compares and equals by value', () => {
    expect(Money.of('1.50').equals(Money.of('1.5'))).toBe(true);
    expect(Money.of('2').compare(Money.of('10'))).toBe(-1);
    expect(Money.of('-1').isNegative()).toBe(true);
    expect(Money.of('0').isNegative()).toBe(false);
  });
});
