/**
 * D-016 Phase 1 tests for `calculateTakeoff` (CG-IR-MEAS@0.2.0). Covers the task matrix
 * A–Z: happy paths, sheets, lines, expressions, references, count factors, exact
 * arithmetic, rounding targets, exact-vs-rounded preservation, aggregation (V13),
 * sheet totals, provenance, canonical determinism, validation, negative rules,
 * minimal documents, duplicates and regression against the frozen CG-RCS engine.
 */
import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  SPEC_VERSION,
  TAKEOFF_SPEC_VERSION,
  calculateQuantities,
  calculateTakeoff,
  canonicalJson,
  type DimensionalQuantity,
  type ExpressionNode,
  type TakeoffCalculationInput,
  type TakeoffLineInput,
  type TakeoffQuantity,
  type TakeoffSheetInput,
  type TakeoffTraceNode,
} from '../src/index.js';

const L = (
  lineId: string,
  quantity: TakeoffQuantity,
  over: Partial<TakeoffLineInput> = {},
): TakeoffLineInput => ({
  rowNo: 1,
  description: 'test line',
  kind: 'addition',
  unit: 'm',
  itemCode: null,
  ...over,
  lineId,
  quantity,
});
const dimQ = (over: Partial<DimensionalQuantity> = {}): DimensionalQuantity => ({
  type: 'dimensional',
  profile: 'L',
  ...over,
});
const refQ = (
  terms: { lineId: string; factor?: string; use?: 'signed' | 'magnitude' }[],
): TakeoffQuantity => ({
  type: 'reference',
  terms: terms.map((t) => ({ lineId: t.lineId, factor: t.factor ?? '1', use: t.use ?? 'signed' })),
});
const sheet = (sheetId: string, lines: TakeoffLineInput[]): TakeoffSheetInput => ({
  sheetId,
  name: `sheet ${sheetId}`,
  lines,
});
const doc = (
  sheets: TakeoffSheetInput[],
  rounding: TakeoffCalculationInput['rounding'] = [],
): TakeoffCalculationInput => ({
  sheets,
  rounding,
});
const ok = (input: TakeoffCalculationInput) => {
  const r = calculateTakeoff(input);
  expect(r.status).toBe('ok');
  expect(r.errors).toEqual([]);
  return r;
};
const at = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined) throw new Error(`missing element ${String(index)}`);
  return value;
};
const lineOf = (r: ReturnType<typeof calculateTakeoff>, lineId: string) => {
  const found = r.lines.find((l) => l.lineId === lineId);
  if (found === undefined) throw new Error(`missing line ${lineId}`);
  return found;
};
const rule = (
  target: 'line' | 'reference-term' | 'item-total' | 'sheet-total',
  over: object = {},
) => ({
  target,
  scale: 0,
  mode: 'HALF_UP' as const,
  sourceStatus: 'design' as const,
  ...over,
});

describe('result envelope', () => {
  it('stamps spec id, takeoff spec version and engine version', () => {
    const r = ok(doc([sheet('S1', [L('L1', dimQ({ length: '2' }))])]));
    expect(r.specId).toBe('CG-IR-MEAS');
    expect(r.specVersion).toBe(TAKEOFF_SPEC_VERSION);
    expect(r.specVersion).toBe('0.2.0');
    expect(r.engineVersion).toBe(ENGINE_VERSION);
  });

  it('accepts an empty document (no sheets)', () => {
    const r = ok(doc([]));
    expect(r.lines).toEqual([]);
    expect(r.itemTotals).toEqual([]);
    expect(r.sheetTotals).toEqual([]);
  });

  it('accepts a sheet with no lines', () => {
    const r = ok(doc([sheet('S1', [])]));
    expect(r.sheetTotals).toEqual([{ sheetId: 'S1', byItem: [] }]);
  });

  it('returns deeply frozen results and never mutates input', () => {
    const input = doc([sheet('S1', [L('L1', dimQ({ length: '2.5' }))])]);
    const snapshot = JSON.stringify(input);
    const r = calculateTakeoff(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.lines)).toBe(true);
    expect(Object.isFrozen(at(r.lines, 0))).toBe(true);
    expect(Object.isFrozen(at(r.itemTotals, 0))).toBe(true);
  });

  it('is atomic: any error yields empty results and all errors in input order', () => {
    const r = calculateTakeoff(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: 'oops' })),
          L('L2', dimQ({ length: '-2' }), { rowNo: 2 }),
        ]),
      ]),
    );
    expect(r.status).toBe('error');
    expect(r.lines).toEqual([]);
    expect(r.itemTotals).toEqual([]);
    expect(r.sheetTotals).toEqual([]);
    expect(r.errors.map((e) => e.code)).toEqual(['INVALID_DECIMAL', 'NEGATIVE_INPUT']);
    expect(r.errors.map((e) => e.lineId)).toEqual(['L1', 'L2']);
  });

  it('treats a missing rounding set as empty (defensive)', () => {
    const r = calculateTakeoff({
      sheets: [sheet('S1', [L('L1', dimQ({ length: '2' }))])],
    } as unknown as TakeoffCalculationInput);
    expect(r.status).toBe('ok');
    expect(lineOf(r, 'L1').signedValue).toBe('2');
  });
});

describe('A · happy-path dimensional calculation', () => {
  it('multiplies the profile dimensions exactly', () => {
    const r = ok(
      doc([
        sheet('S1', [
          L('L1', dimQ({ profile: 'LWH', length: '2', width: '3', height: '4' }), { unit: 'm3' }),
        ]),
      ]),
    );
    const l = lineOf(r, 'L1');
    expect(l.exactMagnitude).toBe('24');
    expect(l.signedValue).toBe('24');
    expect(l.trace.op).toBe('multiply');
    expect(l.trace.inputs.map((n) => n.label)).toEqual(['length', 'width', 'height']);
    expect(l.trace.ruleId).toBe('IR-MEAS/4.1');
  });

  it('profile "count" multiplies only the count factors', () => {
    const r = ok(
      doc([
        sheet('S1', [L('L1', dimQ({ profile: 'count', similarCount: '3' }), { unit: 'each' })]),
      ]),
    );
    expect(lineOf(r, 'L1').signedValue).toBe('3');
  });
});

describe('B/C · multiple sheets and multiple lines', () => {
  const r = ok(
    doc([
      sheet('S1', [L('L1', dimQ({ length: '1' })), L('L2', dimQ({ length: '2' }), { rowNo: 2 })]),
      sheet('S2', [L('L3', dimQ({ length: '3' }), { itemCode: 'SYN-1' })]),
    ]),
  );

  it('returns lines in document order', () => {
    expect(r.lines.map((l) => l.lineId)).toEqual(['L1', 'L2', 'L3']);
    expect(r.lines.map((l) => l.sheetId)).toEqual(['S1', 'S1', 'S2']);
  });

  it('aggregates one itemTotal per group in first-appearance order with lineIds', () => {
    expect(r.itemTotals).toEqual([
      { itemCode: null, unit: 'm', exactQty: '3', qty: '3', lineIds: ['L1', 'L2'] },
      { itemCode: 'SYN-1', unit: 'm', exactQty: '3', qty: '3', lineIds: ['L3'] },
    ]);
  });

  it("produces sheetTotals per sheet from only that sheet's lines", () => {
    expect(r.sheetTotals).toEqual([
      {
        sheetId: 'S1',
        byItem: [{ itemCode: null, unit: 'm', exactQty: '3', qty: '3', lineIds: ['L1', 'L2'] }],
      },
      {
        sheetId: 'S2',
        byItem: [{ itemCode: 'SYN-1', unit: 'm', exactQty: '3', qty: '3', lineIds: ['L3'] }],
      },
    ]);
  });
});

describe('D · structured expressions', () => {
  it('evaluates add/mul/sub/const exactly', () => {
    const quantity: TakeoffQuantity = {
      type: 'expression',
      node: {
        op: 'add',
        args: [
          { op: 'const', value: '2' },
          {
            op: 'mul',
            args: [
              { op: 'const', value: '3' },
              { op: 'const', value: '4' },
            ],
          },
        ],
      },
    };
    const r = ok(doc([sheet('S1', [L('L1', quantity)])]));
    const l = lineOf(r, 'L1');
    expect(l.exactMagnitude).toBe('14');
    expect(l.trace.op).toBe('sum');
    expect(at(l.trace.inputs, 1).op).toBe('multiply');
  });

  it('subtracts and allows negative intermediate constants', () => {
    const quantity: TakeoffQuantity = {
      type: 'expression',
      node: {
        op: 'sub',
        args: [
          { op: 'const', value: '5' },
          { op: 'const', value: '2' },
        ],
      },
    };
    expect(lineOf(ok(doc([sheet('S1', [L('L1', quantity)])])), 'L1').exactMagnitude).toBe('3');
  });

  it('evaluates the inline round node (§4.3) with the domain {scale, mode} rule', () => {
    const quantity: TakeoffQuantity = {
      type: 'expression',
      node: {
        op: 'round',
        arg: { op: 'const', value: '2.55' },
        rule: { scale: 1, mode: 'HALF_UP' },
      },
    };
    const r = ok(doc([sheet('S1', [L('L1', quantity)])]));
    const l = lineOf(r, 'L1');
    expect(l.exactMagnitude).toBe('2.6');
    expect(l.trace.op).toBe('round');
    expect(l.trace.rounding).toEqual({ scale: 1, mode: 'HALF_UP' });
  });
});

describe('E/F · references', () => {
  it('signed consumption of a deduction target is a negative magnitude (V9 rejects it)', () => {
    const r = calculateTakeoff(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: '10' })),
          L('L2', dimQ({ length: '8' }), { rowNo: 2, kind: 'deduction' }),
          L('L3', refQ([{ lineId: 'L2', use: 'signed' }]), { rowNo: 3 }),
        ]),
      ]),
    );
    expect(r.status).toBe('error');
    expect(r.errors.some((e) => e.code === 'NEGATIVE_LINE_MAGNITUDE' && e.lineId === 'L3')).toBe(
      true,
    );
  });

  it('reuses a deduction quantity via magnitude and re-negates it with kind', () => {
    const r = ok(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: '10' })),
          L('L2', dimQ({ length: '8' }), { rowNo: 2, kind: 'deduction' }),
          L('L3', refQ([{ lineId: 'L2', use: 'magnitude' }]), { rowNo: 3, kind: 'deduction' }),
        ]),
      ]),
    );
    expect(lineOf(r, 'L3').exactMagnitude).toBe('8');
    expect(lineOf(r, 'L3').signedValue).toBe('-8');
  });

  it('consumes the magnitude (absolute value) when use = "magnitude"', () => {
    const r = ok(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: '8' }), { kind: 'deduction' }),
          L('L2', refQ([{ lineId: 'L1', use: 'magnitude' }]), { rowNo: 2 }),
        ]),
      ]),
    );
    expect(lineOf(r, 'L2').exactMagnitude).toBe('8');
  });

  it('multiplies terms and sums them (Σ factorᵢ × refᵢ), negative factors allowed', () => {
    const r = ok(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: '10' })),
          L('L2', dimQ({ length: '4' }), { rowNo: 2 }),
          L(
            'L3',
            refQ([
              { lineId: 'L1', factor: '2' },
              { lineId: 'L2', factor: '-0.5' },
            ]),
            { rowNo: 3 },
          ),
        ]),
      ]),
    );
    expect(lineOf(r, 'L3').exactMagnitude).toBe('18');
  });

  it('resolves forward references declared later', () => {
    const r = ok(
      doc([
        sheet('S1', [
          L('L1', refQ([{ lineId: 'L2' }])),
          L('L2', dimQ({ length: '3.5' }), { rowNo: 2 }),
        ]),
      ]),
    );
    expect(lineOf(r, 'L1').exactMagnitude).toBe('3.5');
  });

  it('resolves cross-sheet references (lineId is document-unique)', () => {
    const r = ok(
      doc([
        sheet('S1', [L('L1', refQ([{ lineId: 'L2' }]))]),
        sheet('S2', [L('L2', dimQ({ length: '3' }))]),
      ]),
    );
    expect(lineOf(r, 'L1').exactMagnitude).toBe('3');
  });
});

describe('G/H · circular and unresolved references', () => {
  it('rejects a cycle, lists it lexicographically rotated', () => {
    const r = calculateTakeoff(
      doc([
        sheet('S1', [
          L('L1', refQ([{ lineId: 'L3' }])),
          L('L2', refQ([{ lineId: 'L1' }]), { rowNo: 2 }),
          L('L3', refQ([{ lineId: 'L2' }]), { rowNo: 3 }),
        ]),
      ]),
    );
    expect(r.status).toBe('error');
    const e = at(r.errors, 0);
    expect(e.code).toBe('CIRCULAR_REFERENCE');
    expect(e.lineId).toBe('L1');
    expect(e.message).toBe('circular reference: L1 → L3 → L2 → L1');
  });

  it('rejects self-reference', () => {
    const r = calculateTakeoff(doc([sheet('S1', [L('L1', refQ([{ lineId: 'L1' }]))])]));
    expect(at(r.errors, 0).code).toBe('CIRCULAR_REFERENCE');
    expect(at(r.errors, 0).message).toBe('circular reference: L1 → L1');
  });

  it('reports each independent cycle once', () => {
    const r = calculateTakeoff(
      doc([
        sheet('S1', [
          L('a', refQ([{ lineId: 'b' }])),
          L('b', refQ([{ lineId: 'a' }]), { rowNo: 2 }),
          L('c', refQ([{ lineId: 'd' }]), { rowNo: 3 }),
          L('d', refQ([{ lineId: 'c' }]), { rowNo: 4 }),
        ]),
      ]),
    );
    expect(r.errors.filter((e) => e.code === 'CIRCULAR_REFERENCE')).toHaveLength(2);
  });

  it('rejects an unknown reference with the referencing line', () => {
    const r = calculateTakeoff(doc([sheet('S1', [L('L1', refQ([{ lineId: 'ghost' }]))])]));
    const e = at(r.errors, 0);
    expect(e.code).toBe('UNKNOWN_REFERENCE');
    expect(e.lineId).toBe('L1');
    expect(e.message).toContain('ghost');
  });

  it('rejects a reference to a line with a different unit (V7)', () => {
    const r = calculateTakeoff(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: '5' })),
          L('L2', refQ([{ lineId: 'L1' }]), { rowNo: 2, unit: 'm2' }),
        ]),
      ]),
    );
    const e = at(r.errors, 0);
    expect(e.code).toBe('UNIT_MISMATCH');
    expect(e.lineId).toBe('L2');
  });
});

describe('I/J · floorCount and similarCount', () => {
  it('multiplies floorCount as an exact factor', () => {
    const r = ok(doc([sheet('S1', [L('L1', dimQ({ floorCount: '3', length: '2.5' }))])]));
    expect(lineOf(r, 'L1').exactMagnitude).toBe('7.5');
    expect(at(lineOf(r, 'L1').trace.inputs, 0).label).toBe('floorCount');
  });

  it('multiplies similarCount separately from floorCount', () => {
    const r = ok(
      doc([sheet('S1', [L('L1', dimQ({ floorCount: '3', similarCount: '4', length: '2.5' }))])]),
    );
    expect(lineOf(r, 'L1').exactMagnitude).toBe('30');
    expect(lineOf(r, 'L1').trace.inputs.map((n) => n.label)).toEqual([
      'floorCount',
      'similarCount',
      'length',
    ]);
  });

  it('records an absent factor as absent, never as 1', () => {
    const r = ok(doc([sheet('S1', [L('L1', dimQ({ length: '2.5' }))])]));
    const labels = lineOf(r, 'L1').trace.inputs.map((n) => n.label);
    expect(labels).toEqual(['length']);
  });

  it('rejects zero and fractional count factors', () => {
    const zero = calculateTakeoff(
      doc([sheet('S1', [L('L1', dimQ({ floorCount: '0', length: '1' }))])]),
    );
    expect(at(zero.errors, 0).code).toBe('NON_INTEGER_COUNT');
    const frac = calculateTakeoff(
      doc([sheet('S1', [L('L1', dimQ({ similarCount: '2.5', length: '1' }))])]),
    );
    expect(at(frac.errors, 0).code).toBe('NON_INTEGER_COUNT');
  });
});

describe('K · exact decimal arithmetic', () => {
  it('computes 0.1 + 0.2 exactly', () => {
    const quantity: TakeoffQuantity = {
      type: 'expression',
      node: {
        op: 'add',
        args: [
          { op: 'const', value: '0.1' },
          { op: 'const', value: '0.2' },
        ],
      },
    };
    expect(lineOf(ok(doc([sheet('S1', [L('L1', quantity)])])), 'L1').exactMagnitude).toBe('0.3');
  });

  it('preserves 20 fractional digits without implicit rounding', () => {
    const r = ok(doc([sheet('S1', [L('L1', dimQ({ length: '0.00000000000000000005' }))])]));
    expect(lineOf(r, 'L1').exactMagnitude).toBe('0.00000000000000000005');
  });

  it('normalizes negative zero', () => {
    const addition = ok(
      doc([sheet('S1', [L('L1', { type: 'manual', value: '-0', justification: 'x' })])]),
    );
    expect(lineOf(addition, 'L1').signedValue).toBe('0');
    const deduction = ok(
      doc([
        sheet('S1', [
          L('L1', { type: 'manual', value: '0', justification: 'x' }, { kind: 'deduction' }),
        ]),
      ]),
    );
    expect(lineOf(deduction, 'L1').signedValue).toBe('0');
  });
});

describe('L/M/N · explicit rounding and target behaviour', () => {
  it('rounds a line only when a line rule matches; exact is retained', () => {
    const r = ok(
      doc(
        [sheet('S1', [L('L1', dimQ({ length: '2.6' }))])],
        [rule('line', { selector: { lineIds: ['L1'] } })],
      ),
    );
    const l = lineOf(r, 'L1');
    expect(l.exactMagnitude).toBe('2.6');
    expect(l.roundedMagnitude).toBe('3');
    expect(l.signedValue).toBe('3');
  });

  it('emits no roundedMagnitude without a rule (no default rounding)', () => {
    const r = ok(doc([sheet('S1', [L('L1', dimQ({ length: '2.6' }))])]));
    expect(lineOf(r, 'L1').roundedMagnitude).toBeUndefined();
    expect('roundedMagnitude' in lineOf(r, 'L1')).toBe(false);
  });

  it('rounds the consumed reference value only when a reference-term rule matches', () => {
    const r = ok(
      doc(
        [
          sheet('S1', [
            L('L1', dimQ({ length: '2.6' })),
            L('L2', refQ([{ lineId: 'L1' }]), { rowNo: 2 }),
          ]),
        ],
        [rule('reference-term', { selector: { lineIds: ['L2'] } })],
      ),
    );
    expect(lineOf(r, 'L1').signedValue).toBe('2.6');
    expect(lineOf(r, 'L2').exactMagnitude).toBe('3');
    // single-term reference: the term's multiply node is the line root
    const root = lineOf(r, 'L2').trace;
    expect(root.op).toBe('multiply');
    expect(at(root.inputs, 0).op).toBe('input');
    expect(at(root.inputs, 1).op).toBe('round');
    expect(at(at(root.inputs, 1).inputs, 0).op).toBe('ref');
  });

  it('rounds an itemTotal once from the exact sum (rounded lines never feed it)', () => {
    const r = ok(
      doc(
        [
          sheet('S1', [
            L('L1', dimQ({ length: '1.15' }), { itemCode: 'SYN-9', unit: 'm' }),
            L('L2', dimQ({ length: '1.15' }), { rowNo: 2, itemCode: 'SYN-9' }),
          ]),
        ],
        [
          rule('line', { selector: { itemCode: 'SYN-9' } }),
          rule('item-total', { selector: { itemCode: 'SYN-9' }, scale: 0 }),
        ],
      ),
    );
    expect(lineOf(r, 'L1').roundedMagnitude).toBe('1');
    const item = at(r.itemTotals, 0);
    expect(item.exactQty).toBe('2.3');
    expect(item.roundedQty).toBe('2');
    expect(item.qty).toBe('2');
  });

  it('rounds a sheetTotal once from the exact subtotal', () => {
    const r = ok(
      doc(
        [
          sheet('S1', [
            L('L1', dimQ({ profile: 'LW', length: '2', width: '1.25' }), { unit: 'm2' }),
          ]),
        ],
        [rule('sheet-total', { selector: { unit: 'm2' }, scale: 0 })],
      ),
    );
    const byItem = at(at(r.sheetTotals, 0).byItem, 0);
    expect(byItem.exactQty).toBe('2.5');
    expect(byItem.roundedQty).toBe('3');
    expect(byItem.qty).toBe('3');
    expect(at(r.itemTotals, 0).qty).toBe('2.5');
  });

  it('supports every domain rounding mode deterministically', () => {
    const modes = ['HALF_EVEN', 'DOWN', 'UP', 'FLOOR', 'CEIL'] as const;
    const expected = ['2', '2', '3', '2', '3'] as const;
    for (const [i, mode] of modes.entries()) {
      const r = ok(
        doc([sheet('S1', [L('L1', dimQ({ length: '2.5' }))])], [rule('line', { mode })]),
      );
      expect(lineOf(r, 'L1').roundedMagnitude).toBe(at(expected, i));
    }
  });
});

describe('O/P/Q/R · item aggregation', () => {
  it('aggregates same itemCode + same unit and keeps contributing lineIds', () => {
    const r = ok(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: '1' }), { itemCode: 'SYN-A' }),
          L('L2', dimQ({ length: '2' }), { rowNo: 2, itemCode: 'SYN-A' }),
        ]),
      ]),
    );
    expect(r.itemTotals).toEqual([
      { itemCode: 'SYN-A', unit: 'm', exactQty: '3', qty: '3', lineIds: ['L1', 'L2'] },
    ]);
  });

  it('rejects the same itemCode with incompatible units (V13)', () => {
    const r = calculateTakeoff(
      doc([
        sheet('S1', [
          L('L1', dimQ({ profile: 'LW', length: '1', width: '1' }), {
            itemCode: 'SYN-B',
            unit: 'm2',
          }),
          L('L2', dimQ({ length: '1' }), { rowNo: 2, itemCode: 'SYN-B', unit: 'm' }),
        ]),
      ]),
    );
    const e = at(r.errors, 0);
    expect(e.code).toBe('AGGREGATION_UNIT_MISMATCH');
    expect(e.lineId).toBe('L1');
    expect(e.message).toContain('m2');
    expect(e.message).toContain('m');
  });

  it('aggregates uncoded lines per unit under null, never across units', () => {
    const r = ok(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: '5' })),
          L('L2', dimQ({ profile: 'LW', length: '1', width: '3' }), { rowNo: 2, unit: 'm2' }),
          L('L3', dimQ({ length: '2' }), { rowNo: 3 }),
        ]),
      ]),
    );
    expect(r.itemTotals).toEqual([
      { itemCode: null, unit: 'm', exactQty: '7', qty: '7', lineIds: ['L1', 'L3'] },
      { itemCode: null, unit: 'm2', exactQty: '3', qty: '3', lineIds: ['L2'] },
    ]);
  });
});

describe('S · sheet totals', () => {
  it('groups by (sheet, itemCode) — the same code on two sheets stays separate', () => {
    const r = ok(
      doc([
        sheet('S1', [L('L1', dimQ({ length: '1' }), { itemCode: 'SYN-C' })]),
        sheet('S2', [L('L2', dimQ({ length: '2' }), { itemCode: 'SYN-C' })]),
      ]),
    );
    expect(at(r.sheetTotals, 0).byItem).toEqual([
      { itemCode: 'SYN-C', unit: 'm', exactQty: '1', qty: '1', lineIds: ['L1'] },
    ]);
    expect(at(r.sheetTotals, 1).byItem).toEqual([
      { itemCode: 'SYN-C', unit: 'm', exactQty: '2', qty: '2', lineIds: ['L2'] },
    ]);
    expect(at(r.itemTotals, 0).exactQty).toBe('3');
  });
});

describe('T · provenance / trace', () => {
  it('shares referenced traces by id (ref nodes have no embedded sub-trace)', () => {
    const r = ok(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: '2' })),
          L('L2', refQ([{ lineId: 'L1' }]), { rowNo: 2 }),
        ]),
      ]),
    );
    // single-term reference: the root is the multiply node; the ref node is shared by id
    const root = lineOf(r, 'L2').trace;
    expect(root.op).toBe('multiply');
    const refNode = at(root.inputs, 1);
    expect(refNode.op).toBe('ref');
    expect(refNode.lineId).toBe('L1');
    expect(refNode.value).toBe('2');
    expect(refNode.inputs).toEqual([]);
  });

  it('carries the full rule-set entry on rule-produced round nodes', () => {
    const entry = rule('line', { selector: { lineIds: ['L1'] }, scale: 1 });
    const r = ok(doc([sheet('S1', [L('L1', dimQ({ length: '2.55' }))])], [entry]));
    const t = lineOf(r, 'L1').trace;
    expect(t.op).toBe('round');
    expect(t.rounding).toEqual({ scale: 1, mode: 'HALF_UP' });
    expect(t.roundingRule).toEqual(entry);
  });

  it('wraps deductions in a negate node and labels the root line', () => {
    const r = ok(doc([sheet('S1', [L('L1', dimQ({ length: '2' }), { kind: 'deduction' })])]));
    const t = lineOf(r, 'L1').trace;
    expect(t.op).toBe('negate');
    expect(t.label).toBe('line:L1');
    expect(t.value).toBe('-2');
    expect(at(t.inputs, 0).op).toBe('multiply');
  });

  it('echoes claimed measurementRuleIds on the line root', () => {
    const r = ok(
      doc([sheet('S1', [L('L1', dimQ({ length: '2' }), { ruleRefs: ['IR-1404-M-OPEN-00'] })])]),
    );
    expect(lineOf(r, 'L1').trace.measurementRuleIds).toEqual(['IR-1404-M-OPEN-00']);
  });

  it('gives every trace node a ruleId and a value consistent with the line', () => {
    const r = ok(
      doc([
        sheet('S1', [
          L('L1', dimQ({ floorCount: '2', similarCount: '3', length: '1.5' })),
          L('L2', refQ([{ lineId: 'L1', factor: '2' }]), { rowNo: 2 }),
        ]),
      ]),
    );
    const check = (node: TakeoffTraceNode): void => {
      expect(typeof node.ruleId).toBe('string');
      expect(node.ruleId.length).toBeGreaterThan(0);
      node.inputs.forEach(check);
    };
    for (const l of r.lines) {
      check(l.trace);
      expect(l.trace.value).toBe(l.signedValue);
    }
    expect(lineOf(r, 'L2').exactMagnitude).toBe('18');
  });
});

describe('U · canonical determinism', () => {
  it('produces byte-identical canonical output for identical input', () => {
    const input = doc(
      [
        sheet('S1', [
          L('L1', dimQ({ length: '1.005' })),
          L('L2', refQ([{ lineId: 'L1' }]), { rowNo: 2 }),
        ]),
      ],
      [rule('item-total', { scale: 2 })],
    );
    expect(canonicalJson(calculateTakeoff(input))).toBe(canonicalJson(calculateTakeoff(input)));
  });

  it('changes no value when rowNos are renumbered and sheets reordered', () => {
    const a = ok(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: '1' }), { itemCode: 'SYN-D' }),
          L('L2', dimQ({ length: '2' }), { rowNo: 2, itemCode: 'SYN-D' }),
        ]),
        sheet('S2', [L('L3', dimQ({ length: '3' }), { itemCode: 'SYN-D' })]),
      ]),
    );
    const b = ok(
      doc([
        sheet('S2', [L('L3', dimQ({ length: '3' }), { itemCode: 'SYN-D', rowNo: 41 })]),
        sheet('S1', [
          L('L1', dimQ({ length: '1' }), { itemCode: 'SYN-D', rowNo: 87 }),
          L('L2', dimQ({ length: '2' }), { rowNo: 91, itemCode: 'SYN-D' }),
        ]),
      ]),
    );
    const shape = (r: ReturnType<typeof calculateTakeoff>) => ({
      lines: Object.fromEntries(r.lines.map((l) => [l.lineId, l.signedValue])),
      items: r.itemTotals.map((i) => [i.itemCode, i.unit, i.exactQty, i.qty].join('|')),
      sheets: Object.fromEntries(
        r.sheetTotals.map((s) => [
          s.sheetId,
          s.byItem.map((b2) => [b2.itemCode ?? 'null', b2.unit, b2.exactQty].join('|')).join(';'),
        ]),
      ),
    });
    expect(shape(a)).toEqual(shape(b));
  });
});

describe('V/Y · validation failures and duplicates', () => {
  const failsWith = (input: TakeoffCalculationInput, code: string, field?: string): void => {
    const r = calculateTakeoff(input);
    expect(r.status).toBe('error');
    expect(
      r.errors.some((e) => e.code === code && (field === undefined || e.field === field)),
    ).toBe(true);
  };

  it('rejects duplicate lineId, sheetId and rowNo (V1)', () => {
    failsWith(
      doc([sheet('S1', [L('L1', dimQ()), L('L1', dimQ(), { rowNo: 2 })])]),
      'DUPLICATE_KEY',
      'lineId',
    );
    failsWith(doc([sheet('S1', []), sheet('S1', [])]), 'DUPLICATE_KEY', 'sheetId');
    failsWith(doc([sheet('S1', [L('L1', dimQ()), L('L2', dimQ())])]), 'DUPLICATE_KEY', 'rowNo');
  });

  it('rejects malformed decimals in every quantity family (V2)', () => {
    failsWith(doc([sheet('S1', [L('L1', dimQ({ length: '2,5' }))])]), 'INVALID_DECIMAL', 'length');
    failsWith(
      doc([sheet('S1', [L('L1', refQ([{ lineId: 'L1', factor: '1.5.5' }]))])]),
      'INVALID_DECIMAL',
    );
    failsWith(
      doc([sheet('S1', [L('L1', { type: 'expression', node: { op: 'const', value: 'abc' } })])]),
      'INVALID_DECIMAL',
    );
    failsWith(
      doc([sheet('S1', [L('L1', { type: 'manual', value: 'x', justification: 'j' })])]),
      'INVALID_DECIMAL',
    );
  });

  it('rejects negative dimensional inputs (V3)', () => {
    failsWith(doc([sheet('S1', [L('L1', dimQ({ length: '-2' }))])]), 'NEGATIVE_INPUT', 'length');
  });

  it('rejects profile/dimension mismatches (V4)', () => {
    failsWith(
      doc([sheet('S1', [L('L1', dimQ({ length: '1', width: '2' }))])]),
      'DIMENSION_PROFILE_MISMATCH',
      'width',
    );
    failsWith(
      doc([sheet('S1', [L('L1', dimQ({ profile: 'LW', length: '1' }))])]),
      'DIMENSION_PROFILE_MISMATCH',
      'width',
    );
    failsWith(
      doc([sheet('S1', [L('L1', dimQ({ profile: 'banana' as 'L', length: '1' }))])]),
      'DIMENSION_PROFILE_MISMATCH',
      'profile',
    );
  });

  it('rejects a manual quantity without justification (V8)', () => {
    failsWith(
      doc([sheet('S1', [L('L1', { type: 'manual', value: '1', justification: '' })])]),
      'MISSING_JUSTIFICATION',
    );
    failsWith(
      doc([sheet('S1', [L('L1', { type: 'manual', value: '1', justification: '   ' })])]),
      'MISSING_JUSTIFICATION',
    );
  });

  it('rejects invalid rounding rules (V10)', () => {
    failsWith(
      doc([sheet('S1', [L('L1', dimQ())])], [rule('line', { scale: 21 })]),
      'INVALID_ROUNDING_POLICY',
    );
    failsWith(
      doc([sheet('S1', [L('L1', dimQ())])], [rule('line', { scale: 1.5 })]),
      'INVALID_ROUNDING_POLICY',
    );
    failsWith(
      doc([sheet('S1', [L('L1', dimQ())])], [rule('line', { mode: 'UP_OR_DOWN' })]),
      'INVALID_ROUNDING_POLICY',
    );
    failsWith(
      doc([sheet('S1', [L('L1', dimQ())])], [rule('document' as 'line')]),
      'INVALID_ROUNDING_POLICY',
    );
    failsWith(
      doc([sheet('S1', [L('L1', dimQ())])], [rule('line', { sourceStatus: 'magic' })]),
      'INVALID_ROUNDING_POLICY',
    );
    failsWith(
      doc([sheet('S1', [L('L1', dimQ())])], [rule('line', { sourceStatus: 'verified' })]),
      'INVALID_ROUNDING_POLICY',
    );
    failsWith(
      doc(
        [sheet('S1', [L('L1', dimQ())])],
        [rule('item-total', { selector: { lineIds: ['L1'] } })],
      ),
      'INVALID_ROUNDING_POLICY',
    );
  });

  it('rejects an unknown unit code (§3)', () => {
    failsWith(doc([sheet('S1', [L('L1', dimQ(), { unit: 'cubits' })])]), 'UNIT_MISMATCH', 'unit');
  });

  it('treats a missing itemCode as null (V12: itemCode is opaque in S1)', () => {
    const r = ok(doc([sheet('S1', [L('L1', dimQ({ length: '1' }))])]));
    expect(lineOf(r, 'L1').itemCode).toBeNull();
    expect(at(r.itemTotals, 0).itemCode).toBeNull();
  });
});

describe('W · negative-result rules', () => {
  it('rejects a negative resolved line magnitude (V9, exact before kind)', () => {
    const quantity: TakeoffQuantity = {
      type: 'expression',
      node: {
        op: 'sub',
        args: [
          { op: 'const', value: '1' },
          { op: 'const', value: '5' },
        ],
      },
    };
    const r = calculateTakeoff(doc([sheet('S1', [L('L1', quantity)])]));
    const e = at(r.errors, 0);
    expect(e.code).toBe('NEGATIVE_LINE_MAGNITUDE');
    expect(e.lineId).toBe('L1');
  });

  it('rejects a negative reference sum (negative factor, V9)', () => {
    const r = calculateTakeoff(
      doc([
        sheet('S1', [
          L('L1', dimQ({ length: '10' })),
          L('L2', refQ([{ lineId: 'L1', factor: '-2' }]), { rowNo: 2 }),
        ]),
      ]),
    );
    expect(r.errors.some((e) => e.code === 'NEGATIVE_LINE_MAGNITUDE' && e.lineId === 'L2')).toBe(
      true,
    );
  });

  it('rejects a negative per-itemCode exact net (V11)', () => {
    const r = calculateTakeoff(
      doc([
        sheet('S1', [
          L('L1', dimQ({ profile: 'LWH', length: '2', width: '2', height: '2' }), {
            itemCode: 'SYN-N',
            unit: 'm3',
          }),
          L('L2', dimQ({ profile: 'LWH', length: '3', width: '3', height: '3' }), {
            rowNo: 2,
            itemCode: 'SYN-N',
            unit: 'm3',
            kind: 'deduction',
          }),
        ]),
      ]),
    );
    expect(r.errors.some((e) => e.code === 'NEGATIVE_NET_QUANTITY' && e.lineId === 'L1')).toBe(
      true,
    );
  });

  it('checks V9 on the exact value, never on a rounded one', () => {
    // exact −0.4 would fail V9; a line rule rounding to 0 must NOT make it valid.
    const quantity: TakeoffQuantity = {
      type: 'expression',
      node: {
        op: 'sub',
        args: [
          { op: 'const', value: '1' },
          { op: 'const', value: '1.4' },
        ],
      },
    };
    const r = calculateTakeoff(
      doc([sheet('S1', [L('L1', quantity)])], [rule('line', { scale: 0 })]),
    );
    expect(r.status).toBe('error');
    expect(at(r.errors, 0).code).toBe('NEGATIVE_LINE_MAGNITUDE');
  });
});

describe('selector specificity (§6 narrowest match)', () => {
  const line = L('L1', dimQ({ length: '2.55' }), { itemCode: 'SYN-S' });

  it('lineIds beats itemCode beats unit beats selectorless', () => {
    const byLineIds = ok(
      doc(
        [sheet('S1', [line])],
        [
          rule('line', { scale: 3 }),
          rule('line', { selector: { unit: 'm' }, scale: 2 }),
          rule('line', { selector: { itemCode: 'SYN-S' }, scale: 1 }),
          rule('line', { selector: { lineIds: ['L1'] }, scale: 0 }),
        ],
      ),
    );
    expect(lineOf(byLineIds, 'L1').roundedMagnitude).toBe('3');

    const byItemCode = ok(
      doc(
        [sheet('S1', [line])],
        [
          rule('line', { scale: 3 }),
          rule('line', { selector: { unit: 'm' }, scale: 2 }),
          rule('line', { selector: { itemCode: 'SYN-S' }, scale: 0 }),
        ],
      ),
    );
    expect(lineOf(byItemCode, 'L1').roundedMagnitude).toBe('3');

    const byUnit = ok(
      doc(
        [sheet('S1', [line])],
        [rule('line', { scale: 3 }), rule('line', { selector: { unit: 'm' }, scale: 0 })],
      ),
    );
    expect(lineOf(byUnit, 'L1').roundedMagnitude).toBe('3');

    const selectorless = ok(doc([sheet('S1', [line])], [rule('line', { scale: 0 })]));
    expect(lineOf(selectorless, 'L1').roundedMagnitude).toBe('3');
  });

  it('a non-matching specific selector falls back to the broader rule', () => {
    const r = ok(
      doc(
        [sheet('S1', [line])],
        [
          rule('line', { selector: { itemCode: 'OTHER' }, scale: 3 }),
          rule('line', { selector: { unit: 'm' }, scale: 0 }),
        ],
      ),
    );
    expect(lineOf(r, 'L1').roundedMagnitude).toBe('3');
  });

  it('two rules tying at the top score are an error', () => {
    const r = calculateTakeoff(
      doc(
        [sheet('S1', [line])],
        [
          rule('line', { selector: { itemCode: 'SYN-S' }, scale: 0 }),
          rule('line', { selector: { unit: 'm' }, scale: 0 }),
        ],
      ),
    );
    // itemCode scores 2, unit scores 1 — no tie; the itemCode rule applies.
    expect(r.status).toBe('ok');
    const tie = calculateTakeoff(
      doc(
        [sheet('S1', [line])],
        [
          rule('line', { selector: { unit: 'm' }, scale: 0 }),
          rule('line', { selector: { unit: 'm' }, scale: 1 }),
        ],
      ),
    );
    expect(tie.status).toBe('error');
    expect(at(tie.errors, 0).code).toBe('INVALID_ROUNDING_POLICY');
  });
});

describe('structural caller-contract violations throw', () => {
  it('throws on unknown quantity type, kind or node op', () => {
    expect(() =>
      calculateTakeoff(
        doc([sheet('S1', [L('L1', { type: 'spell' } as unknown as TakeoffQuantity)])]),
      ),
    ).toThrow(/structurally invalid/);
    expect(() =>
      calculateTakeoff(doc([sheet('S1', [L('L1', dimQ(), { kind: 'miracle' as 'addition' })])])),
    ).toThrow(/structurally invalid/);
    expect(() =>
      calculateTakeoff(
        doc([
          sheet('S1', [
            L('L1', {
              type: 'expression',
              node: { op: 'divide', args: [] } as unknown as ExpressionNode,
            }),
          ]),
        ]),
      ),
    ).toThrow(/structurally invalid/);
  });
});

describe('Z · regression against the frozen CG-RCS engine', () => {
  it('calculateQuantities keeps its frozen CG-RCS stamp and behaviour', () => {
    const r = calculateQuantities({
      items: [
        {
          itemKey: 'A',
          unit: 'm2',
          lines: [
            { lineKey: 'L1', kind: 'addition', unit: 'm2', count: '2', length: '2', width: '3' },
          ],
        },
      ],
    });
    expect(r.status).toBe('ok');
    expect(r.specVersion).toBe(SPEC_VERSION);
    expect(r.specVersion).toBe('0.1.0');
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    expect(at(r.items, 0).qty).toBe('12');
  });
});
