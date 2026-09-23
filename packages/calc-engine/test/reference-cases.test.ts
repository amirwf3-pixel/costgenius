import { describe, expect, it } from 'vitest';
import suiteJson from '../spec/reference-cases/quantity.v0.1.0.json' with { type: 'json' };
import { canon, evaluateTrace, oracleItem } from './reference-oracle.js';
import type { ReferenceSuite, TraceNode } from './reference-types.js';
import { Decimal } from 'decimal.js';

const suite = suiteJson as unknown as ReferenceSuite;
const cases = suite.cases;

const INPUT_DECIMAL = /^-?\d+(\.\d+)?$/;
const CANONICAL = /^-?(0|[1-9]\d*)(\.\d*[1-9])?$/;
const ERROR_CODES = new Set([
  'INVALID_DECIMAL',
  'NEGATIVE_INPUT',
  'NON_INTEGER_COUNT',
  'DIMENSION_UNIT_MISMATCH',
  'UNIT_MISMATCH',
  'NEGATIVE_NET_QUANTITY',
  'EMPTY_ITEM',
  'DUPLICATE_KEY',
  'INVALID_ROUNDING_POLICY',
]);
const TRACE_REQS = new Set(['T1', 'T2', 'T3', 'T4', 'T5']);
const SOURCE_STATUS = new Set(['synthetic-generic', 'requires-authoritative-source', 'superseded']);
const DIMS: Record<string, readonly string[]> = {
  each: [],
  m: ['length'],
  m2: ['length', 'width'],
  m3: ['length', 'width', 'height'],
};
const isCanonical = (v: string): boolean => CANONICAL.test(v) && v !== '-0';

describe('suite metadata', () => {
  it('identifies spec and version', () => {
    expect(suite.specId).toBe('CG-RCS');
    expect(suite.specVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(suite.stage).toBe('S1-quantity');
  });

  it('has unique, well-formed, sequential case ids', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id, i) => {
      expect(id).toBe(`RC-Q-${String(i + 1).padStart(3, '0')}`);
    });
  });

  it('covers every required category', () => {
    const cats = new Set(cases.map((c) => c.category));
    for (const required of [
      'rectangular-area',
      'rectangular-volume',
      'multiple-quantities',
      'summation',
      'deductions',
      'zero-quantity',
      'decimal-precision',
      'unit-mismatch',
      'determinism',
      'rounding',
    ]) {
      expect(cats, required).toContain(required);
    }
  });
});

describe.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
  it('has all mandatory fields', () => {
    expect(c.title.length).toBeGreaterThan(0);
    expect(c.stage).toBe('S1-quantity');
    expect(c.formula.length).toBeGreaterThan(0);
    expect(Array.isArray(c.assumptions)).toBe(true);
    expect(SOURCE_STATUS).toContain(c.source.status);
    c.traceRequirements.forEach((t) => {
      expect(TRACE_REQS).toContain(t);
    });
    if (c.expected.status === 'ok') expect(c.traceRequirements.length).toBeGreaterThan(0);
  });

  it('declares rounding consistently with the input', () => {
    const policies = c.input.items.map((i) => i.rounding ?? null);
    if (c.rounding === null) {
      expect(policies.every((p) => p === null)).toBe(true);
    } else {
      expect(policies).toContainEqual(c.rounding);
    }
  });

  it('uses only S1 units and plain decimal strings (no pricing/regulatory fields)', () => {
    for (const item of c.input.items) {
      expect(Object.keys(item).sort()).toEqual(
        ['itemKey', 'lines', 'unit', ...(item.rounding ? ['rounding'] : [])].sort(),
      );
      expect(Object.keys(DIMS)).toContain(item.unit);
      for (const l of item.lines) {
        for (const k of Object.keys(l)) {
          expect(['lineKey', 'kind', 'unit', 'count', 'length', 'width', 'height']).toContain(k);
        }
        // Invalid-decimal cases intentionally contain a malformed value.
        if (c.expected.status === 'ok') {
          for (const v of [l.count, l.length, l.width, l.height]) {
            if (v !== undefined) expect(v).toMatch(INPUT_DECIMAL);
          }
        }
      }
    }
  });

  if (c.expected.status === 'error') {
    const { errors } = c.expected;
    it('lists known error codes only', () => {
      expect(errors.length).toBeGreaterThan(0);
      errors.forEach((e) => {
        expect(ERROR_CODES).toContain(e.code);
      });
      expect(c.expectedTrace).toBeUndefined();
    });
    return;
  }

  const { items } = c.expected;

  it('is valid input per R1/R3/R4/R6 (success cases only)', () => {
    for (const item of c.input.items) {
      for (const l of item.lines) {
        expect(l.unit).toBe(item.unit);
        const given = ['length', 'width', 'height'].filter((k) => l[k as 'length'] !== undefined);
        expect(given).toEqual(DIMS[item.unit]);
        expect(Number.isInteger(Number(l.count))).toBe(true);
        for (const v of [l.count, l.length, l.width, l.height]) {
          if (v !== undefined) expect(v.startsWith('-')).toBe(false);
        }
      }
    }
    items.forEach((i) => {
      expect(i.qty.startsWith('-')).toBe(false);
    });
  });

  it('expresses every expected number canonically', () => {
    for (const i of items) {
      for (const v of [i.exactQty, i.qty, i.roundedQty])
        if (v !== undefined) expect(isCanonical(v), v).toBe(true);
      for (const l of i.lines) {
        for (const v of [l.exactQty, l.signedQty, l.roundedQty])
          if (v !== undefined) expect(isCanonical(v), v).toBe(true);
      }
    }
  });

  it('expected values agree with the independent test oracle', () => {
    expect(c.input.items.map(oracleItem)).toEqual(
      items.map((i) => {
        const { unit, ...rest } = i;
        expect(unit).toBe(c.input.items.find((x) => x.itemKey === i.itemKey)?.unit);
        return rest;
      }),
    );
  });

  it('expected result is order-independent (R9)', () => {
    for (const item of c.input.items) {
      const reversed = { ...item, lines: [...item.lines].reverse() };
      expect(oracleItem(reversed).qty).toBe(oracleItem(item).qty);
    }
  });

  if (c.expectedTrace) {
    const trace = c.expectedTrace;
    it('expected trace is self-verifying (T4) and matches the result', () => {
      expect(evaluateTrace(trace)).toBe(items[0]?.qty);
    });
    it('expected trace references every numeric input (T1)', () => {
      const refs: string[] = [];
      const walk = (n: TraceNode): void => {
        if (n.op === 'input' && n.ref) refs.push(`${n.ref.lineKey ?? ''}.${n.ref.field ?? ''}`);
        n.inputs.forEach(walk);
      };
      walk(trace);
      const expectedRefs = c.input.items.flatMap((i) =>
        i.lines.flatMap((l) =>
          (['count', 'length', 'width', 'height'] as const)
            .filter((f) => l[f] !== undefined)
            .map((f) => `${l.lineKey}.${f}`),
        ),
      );
      expect(refs.sort()).toEqual(expectedRefs.sort());
    });
  }

  if (c.repeat) {
    const rep = c.repeat;
    it('declares valid permutations of its lines', () => {
      const keys = (c.input.items[0]?.lines ?? []).map((l) => l.lineKey).sort();
      rep.linePermutations.forEach((p) => {
        expect([...p].sort()).toEqual(keys);
      });
      expect(rep.runs).toBeGreaterThan(1);
    });
  }
});

describe('oracle sanity', () => {
  it('uses exact decimal arithmetic', () => {
    expect(canon(new Decimal('0.1').times(3))).toBe('0.3');
    expect(0.1 * 3).not.toBe(0.3);
  });
});
