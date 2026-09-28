import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  SPEC_VERSION,
  calculateQuantities,
  canonicalJson,
  type QuantityCalculationInput,
  type QuantityLineInput,
  type TraceNode,
} from '../src/index.js';

const line = (over: Partial<QuantityLineInput> & { lineKey: string }): QuantityLineInput => ({
  kind: 'addition',
  unit: 'm2',
  count: '1',
  length: '2',
  width: '3',
  ...over,
});
const one = (lines: QuantityLineInput[], extra: object = {}): QuantityCalculationInput => ({
  items: [{ itemKey: 'A', unit: 'm2', lines, ...extra }],
});
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error('unexpected undefined');
  return v;
};
const codes = (i: QuantityCalculationInput) =>
  calculateQuantities(i).errors.map((e) => [e.code, e.itemKey, e.lineKey, e.field]);

/** Independent re-evaluation of a trace using only the engine's own public output. */
const leaves = (n: TraceNode): TraceNode[] => (n.op === 'input' ? [n] : n.inputs.flatMap(leaves));

describe('result envelope', () => {
  it('stamps spec and engine versions', () => {
    const r = calculateQuantities(one([line({ lineKey: 'L1' })]));
    expect(r.specVersion).toBe(SPEC_VERSION);
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    expect(r.status).toBe('ok');
  });

  it('returns deeply frozen results and never mutates input', () => {
    const input = one([line({ lineKey: 'L1' })]);
    const snapshot = JSON.stringify(input);
    const r = calculateQuantities(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.items[0]?.trace.inputs[0])).toBe(true);
  });

  it('returns factors in fixed order with canonical values', () => {
    const r = calculateQuantities({
      items: [
        {
          itemKey: 'V',
          unit: 'm3',
          lines: [
            {
              lineKey: 'L',
              kind: 'addition',
              unit: 'm3',
              count: '02',
              length: '1.50',
              width: '2',
              height: '0.10',
            },
          ],
        },
      ],
    });
    expect(r.items[0]?.lines[0]?.factors).toEqual([
      { name: 'count', value: '2' },
      { name: 'length', value: '1.5' },
      { name: 'width', value: '2' },
      { name: 'height', value: '0.1' },
    ]);
    expect(r.items[0]?.qty).toBe('0.6');
  });

  it('handles multiple items independently and in input order', () => {
    const r = calculateQuantities({
      items: [
        {
          itemKey: 'B',
          unit: 'each',
          lines: [{ lineKey: 'x', kind: 'addition', unit: 'each', count: '2' }],
        },
        {
          itemKey: 'A',
          unit: 'm',
          lines: [{ lineKey: 'x', kind: 'addition', unit: 'm', count: '1', length: '5' }],
        },
      ],
    });
    expect(r.items.map((i) => [i.itemKey, i.qty])).toEqual([
      ['B', '2'],
      ['A', '5'],
    ]);
  });

  it('carries very large and very precise values exactly', () => {
    const r = calculateQuantities(
      one([line({ lineKey: 'L', length: '123456789012345678.000001', width: '1000000' })]),
    );
    expect(r.items[0]?.qty).toBe('123456789012345678000001');
  });
});

describe('validation errors (R1, R3, R4, R8, §4.3)', () => {
  it('rejects empty items', () => {
    expect(codes(one([]))).toEqual([['EMPTY_ITEM', 'A', undefined, undefined]]);
  });

  it('rejects duplicate item and line keys', () => {
    expect(codes(one([line({ lineKey: 'L' }), line({ lineKey: 'L' })]))).toEqual([
      ['DUPLICATE_KEY', 'A', 'L', 'lineKey'],
    ]);
    const dupItems: QuantityCalculationInput = {
      items: [
        must(one([line({ lineKey: 'L' })]).items[0]),
        must(one([line({ lineKey: 'L' })]).items[0]),
      ],
    };
    expect(codes(dupItems)).toEqual([['DUPLICATE_KEY', 'A', undefined, 'itemKey']]);
  });

  it('reports a missing required dimension', () => {
    expect(
      codes(one([{ lineKey: 'L', kind: 'addition', unit: 'm2', count: '1', length: '2' }])),
    ).toEqual([['DIMENSION_UNIT_MISMATCH', 'A', 'L', 'width']]);
  });

  it('rejects units outside the S1 set (no conversion, no guessing)', () => {
    expect(
      codes({
        items: [
          {
            itemKey: 'K',
            unit: 'kg',
            lines: [{ lineKey: 'L', kind: 'addition', unit: 'kg', count: '1' }],
          },
        ],
      }),
    ).toEqual([
      ['UNIT_MISMATCH', 'K', undefined, 'unit'],
      ['UNIT_MISMATCH', 'K', 'L', 'unit'],
    ]);
  });

  it.each(['', '1e3', '.5', '5.', '1,5', ' 1', '۱', 'NaN'])('rejects malformed decimal %j', (v) => {
    expect(codes(one([line({ lineKey: 'L', length: v })]))).toEqual([
      ['INVALID_DECIMAL', 'A', 'L', 'length'],
    ]);
  });

  it('rejects non-string numeric input (floats must not enter the engine)', () => {
    const bad = one([line({ lineKey: 'L', width: 0.1 as unknown as string })]);
    expect(codes(bad)).toEqual([['INVALID_DECIMAL', 'A', 'L', 'width']]);
  });

  it('rejects negative count', () => {
    expect(codes(one([line({ lineKey: 'L', count: '-1' })]))).toEqual([
      ['NEGATIVE_INPUT', 'A', 'L', 'count'],
    ]);
  });

  it('accepts integer counts written with a zero fraction', () => {
    expect(calculateQuantities(one([line({ lineKey: 'L', count: '3.0' })])).items[0]?.qty).toBe(
      '18',
    );
  });

  it('reports errors across items in input order, with no partial result', () => {
    const r = calculateQuantities({
      items: [
        {
          itemKey: 'X',
          unit: 'm',
          lines: [{ lineKey: 'a', kind: 'deduction', unit: 'm', count: '1', length: '1' }],
        },
        {
          itemKey: 'Y',
          unit: 'm',
          lines: [{ lineKey: 'b', kind: 'addition', unit: 'm', count: '1', length: 'x' }],
        },
        {
          itemKey: 'Z',
          unit: 'm',
          lines: [{ lineKey: 'c', kind: 'addition', unit: 'm', count: '1', length: '1' }],
        },
      ],
    });
    expect(r.status).toBe('error');
    expect(r.items).toEqual([]);
    expect(r.errors.map((e) => [e.code, e.itemKey])).toEqual([
      ['NEGATIVE_NET_QUANTITY', 'X'],
      ['INVALID_DECIMAL', 'Y'],
    ]);
    r.errors.forEach((e) => {
      expect(e.message.length).toBeGreaterThan(0);
    });
  });
});

describe('rounding policy (§5)', () => {
  it.each([
    [{ stage: 'x', scale: 2, mode: 'HALF_UP' }, 'rounding.stage'],
    [{ stage: 'item', scale: -1, mode: 'HALF_UP' }, 'rounding.scale'],
    [{ stage: 'item', scale: 1.5, mode: 'HALF_UP' }, 'rounding.scale'],
    [{ stage: 'item', scale: 2, mode: 'NEAREST' }, 'rounding.mode'],
  ])('rejects %j', (rounding, field) => {
    expect(codes(one([line({ lineKey: 'L' })], { rounding }))).toEqual([
      ['INVALID_ROUNDING_POLICY', 'A', undefined, field],
    ]);
  });

  it('accepts boundary scales 0 and 20', () => {
    for (const scale of [0, 20]) {
      const r = calculateQuantities(
        one([line({ lineKey: 'L', length: '1.25' })], {
          rounding: { stage: 'item', scale, mode: 'HALF_EVEN' },
        }),
      );
      expect(r.status).toBe('ok');
    }
  });

  it('omits roundedQty when no policy is given', () => {
    const r = calculateQuantities(one([line({ lineKey: 'L' })]));
    expect(r.items[0]).not.toHaveProperty('roundedQty');
    expect(r.items[0]?.lines[0]).not.toHaveProperty('roundedQty');
  });
});

describe('trace (§8)', () => {
  const input = one(
    [
      line({ lineKey: 'L1', count: '2', length: '1.25', width: '4' }),
      line({ lineKey: 'D1', kind: 'deduction', length: '0.5', width: '0.5' }),
    ],
    { rounding: { stage: 'item', scale: 1, mode: 'HALF_UP' } },
  );
  const trace = must(calculateQuantities(input).items[0]).trace;

  it('has an item-stage round node wrapping the sum (T3)', () => {
    expect(trace.op).toBe('round');
    expect(trace.ref).toEqual({ itemKey: 'A' });
    expect(trace.inputs[0]?.op).toBe('sum');
    expect(trace.inputs[0]?.inputs.map((n) => n.op)).toEqual(['multiply', 'negate']);
  });

  it('references every numeric input (T1)', () => {
    expect(
      leaves(trace).map((n) => `${n.ref?.lineKey ?? ''}.${n.ref?.field ?? ''}=${n.value}`),
    ).toEqual([
      'L1.count=2',
      'L1.length=1.25',
      'L1.width=4',
      'D1.count=1',
      'D1.length=0.5',
      'D1.width=0.5',
    ]);
  });

  it('serialises canonically (T5)', () => {
    const json = canonicalJson(trace);
    expect(json).not.toMatch(/\s/);
    expect(json.indexOf('"inputs"')).toBeLessThan(json.indexOf('"label"'));
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  });
});

describe('determinism (R9)', () => {
  it('produces byte-identical canonical results over repeated runs', () => {
    const input = one(
      [
        line({ lineKey: 'a', length: '1.005', width: '3.3' }),
        line({ lineKey: 'b', kind: 'deduction', length: '0.12', width: '0.7' }),
      ],
      { rounding: { stage: 'line', scale: 2, mode: 'HALF_EVEN' } },
    );
    const first = canonicalJson(calculateQuantities(input));
    for (let i = 0; i < 500; i++) expect(canonicalJson(calculateQuantities(input))).toBe(first);
  });

  it('is independent of line order for qty and exactQty', () => {
    const lines = ['1.1', '2.22', '3.333', '0.4444'].map((w, i) =>
      line({ lineKey: `L${String(i)}`, width: w }),
    );
    const a = must(calculateQuantities(one(lines)).items[0]);
    const b = must(calculateQuantities(one([...lines].reverse())).items[0]);
    expect([b.qty, b.exactQty]).toEqual([a.qty, a.exactQty]);
  });
});

describe('R6 is checked on the exact, unrounded net', () => {
  const r6 = (
    add: string,
    ded: string,
    rounding?: { stage: 'line' | 'item'; scale: number; mode: 'HALF_UP' | 'FLOOR' | 'CEIL' },
  ) =>
    calculateQuantities({
      items: [
        {
          itemKey: 'A',
          unit: 'm',
          ...(rounding ? { rounding } : {}),
          lines: [
            { lineKey: 'a', kind: 'addition', unit: 'm', count: '1', length: add },
            { lineKey: 'd', kind: 'deduction', unit: 'm', count: '1', length: ded },
          ],
        },
      ],
    });

  it('exact negative → error', () => {
    const r = r6('1', '1.5');
    expect(r.status).toBe('error');
    expect(r.items).toEqual([]);
    expect(r.errors.map((e) => [e.code, e.itemKey])).toEqual([['NEGATIVE_NET_QUANTITY', 'A']]);
  });

  it('exact zero → valid', () => {
    const r = r6('2.5', '2.5', { stage: 'item', scale: 0, mode: 'HALF_UP' });
    expect(r.status).toBe('ok');
    expect([r.items[0]?.exactQty, r.items[0]?.qty]).toEqual(['0', '0']);
  });

  it('small positive rounded to zero → valid', () => {
    const r = r6('0.004', '0.001', { stage: 'item', scale: 2, mode: 'HALF_UP' });
    expect(r.status).toBe('ok');
    expect([r.items[0]?.exactQty, r.items[0]?.qty]).toEqual(['0.003', '0']);
  });

  it('negative that would round to zero (item stage) → error', () => {
    // exact −0.003 would round to 0 under HALF_UP at scale 2
    const r = r6('0.001', '0.004', { stage: 'item', scale: 2, mode: 'HALF_UP' });
    expect(r.status).toBe('error');
    expect(r.errors.map((e) => e.code)).toEqual(['NEGATIVE_NET_QUANTITY']);
  });

  it('negative that would round to zero (line stage) → error', () => {
    // exact 0.001 − 0.004 = −0.003; FLOOR per line gives 0 − 0 = 0
    const r = r6('0.001', '0.004', { stage: 'line', scale: 2, mode: 'FLOOR' });
    expect(r.status).toBe('error');
    expect(r.errors.map((e) => e.code)).toEqual(['NEGATIVE_NET_QUANTITY']);
  });
});

describe('error ordering with duplicate itemKey', () => {
  const dupInput: QuantityCalculationInput = {
    items: [
      // #0 A: net negative (found after validation)
      {
        itemKey: 'A',
        unit: 'm',
        lines: [{ lineKey: 'a', kind: 'deduction', unit: 'm', count: '1', length: '1' }],
      },
      // #1 B: invalid decimal
      {
        itemKey: 'B',
        unit: 'm',
        lines: [{ lineKey: 'b', kind: 'addition', unit: 'm', count: '1', length: 'x' }],
      },
      // #2 A (duplicate): duplicate key + negative input
      {
        itemKey: 'A',
        unit: 'm',
        lines: [{ lineKey: 'c', kind: 'addition', unit: 'm', count: '-1', length: '1' }],
      },
      // #3 A (duplicate): duplicate key + net negative
      {
        itemKey: 'A',
        unit: 'm',
        lines: [{ lineKey: 'e', kind: 'deduction', unit: 'm', count: '1', length: '2' }],
      },
    ],
  };
  const expected = [
    ['NEGATIVE_NET_QUANTITY', 'A', undefined, undefined],
    ['INVALID_DECIMAL', 'B', 'b', 'length'],
    ['DUPLICATE_KEY', 'A', undefined, 'itemKey'],
    ['NEGATIVE_INPUT', 'A', 'c', 'count'],
    ['DUPLICATE_KEY', 'A', undefined, 'itemKey'],
  ];

  it('orders errors by item input position, then detection order', () => {
    expect(codes(dupInput)).toEqual(expected);
  });

  it('is stable across repeated runs', () => {
    const first = canonicalJson(calculateQuantities(dupInput));
    for (let i = 0; i < 200; i++) expect(canonicalJson(calculateQuantities(dupInput))).toBe(first);
  });
});
