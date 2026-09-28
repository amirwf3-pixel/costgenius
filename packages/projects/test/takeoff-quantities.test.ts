/**
 * D-015: the calc-engine adapter (`takeoff-quantities.ts`) — the only boundary between
 * the estimate workflow and the frozen S1 engine. These tests pin the adapter contract:
 * mechanical shape mapping, verbatim quantity (never reformatted), provenance shape,
 * version preservation, determinism and the pass-through of every engine error class.
 *
 * Engine RULES themselves are pinned by the engine's own 283-test suite; here we only
 * verify that the adapter neither weakens nor reinterprets them.
 */
import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  SPEC_VERSION,
  calculateQuantities,
  type CalculationError,
} from '@costgenius/calc-engine';
import { computeTakeoffQuantities, takeoffInputOf } from '../src/takeoff-quantities.js';

const addition = {
  kind: 'addition' as const,
  count: '2',
};

describe('takeoffInputOf (shape mapping)', () => {
  it('maps single-line items with itemKey echoed as lineKey, carrying only present dimensions', () => {
    const input = takeoffInputOf([
      { itemKey: 'a', ...addition, unit: 'm2', count: '3', length: '2', width: '4' },
      { itemKey: 'b', ...addition, unit: 'm', count: '1', length: '7.5' },
      { itemKey: 'c', ...addition, unit: 'each', count: '6' },
    ]);
    expect(input.items).toHaveLength(3);
    expect(input.items[0]).toEqual({
      itemKey: 'a',
      unit: 'm2',
      lines: [{ lineKey: 'a', kind: 'addition', unit: 'm2', count: '3', length: '2', width: '4' }],
    });
    // m3 without height: the dimension stays ABSENT — no default is invented.
    expect(input.items[1]).toEqual({
      itemKey: 'b',
      unit: 'm',
      lines: [{ lineKey: 'b', kind: 'addition', unit: 'm', count: '1', length: '7.5' }],
    });
    expect('height' in (input.items[1]?.lines[0] ?? {})).toBe(false);
    // each: no dimensions at all.
    expect('length' in (input.items[2]?.lines[0] ?? {})).toBe(false);
    expect(input.items[2]).toEqual({
      itemKey: 'c',
      unit: 'each',
      lines: [{ lineKey: 'c', kind: 'addition', unit: 'each', count: '6' }],
    });
  });
});

describe('computeTakeoffQuantities (success)', () => {
  it('computes all four S1 units with exact canonical quantities', () => {
    const result = computeTakeoffQuantities(
      takeoffInputOf([
        { itemKey: 'm-line', ...addition, unit: 'm', count: '3', length: '2.5' }, // 7.5
        { itemKey: 'm2-line', ...addition, unit: 'm2', count: '4', length: '2.5', width: '2' }, // 20
        {
          itemKey: 'm3-line',
          ...addition,
          unit: 'm3',
          count: '2',
          length: '3',
          width: '2',
          height: '0.5',
        }, // 6
        { itemKey: 'each-line', ...addition, unit: 'each', count: '9' }, // 9
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.items.map((item) => [item.lineId, item]));
    expect(byId.get('m-line')?.quantity).toBe('7.5');
    expect(byId.get('m2-line')?.quantity).toBe('20');
    expect(byId.get('m3-line')?.quantity).toBe('6');
    expect(byId.get('each-line')?.quantity).toBe('9');
    for (const item of result.items) {
      expect(item.takeoff.output.qty).toBe(item.quantity); // the quantity IS the engine output
      expect(item.takeoff.output.unit).toBe(item.unit);
    }
  });

  it('preserves the engine versions verbatim on the result and on every provenance', () => {
    const result = computeTakeoffQuantities(
      takeoffInputOf([{ itemKey: 'a', ...addition, unit: 'each', count: '1' }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.specVersion).toBe(SPEC_VERSION);
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(result.items[0]?.takeoff.specVersion).toBe(SPEC_VERSION);
    expect(result.items[0]?.takeoff.engineVersion).toBe(ENGINE_VERSION);
  });

  it('provenance carries the exact caller input and the exact engine output (replayable)', () => {
    const input = takeoffInputOf([
      { itemKey: 'a', ...addition, unit: 'm2', count: '3', length: '2', width: '4' },
    ]);
    const result = computeTakeoffQuantities(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.items[0];
    expect(item?.takeoff.input).toEqual(input.items[0]);
    // The provenance output is the engine's own result object content, verbatim.
    const direct = calculateQuantities(input);
    expect(direct.status).toBe('ok');
    if (direct.status !== 'ok') return;
    expect(item?.takeoff.output).toEqual(direct.items[0]);
  });

  it('never reformats: non-canonical input decimals yield the engine canonical quantity', () => {
    // count '2.0' and length '10.00' are accepted by the engine but the adapter reports
    // the engine's canonical output — it does not echo the caller's formatting.
    const result = computeTakeoffQuantities(
      takeoffInputOf([{ itemKey: 'a', ...addition, unit: 'm', count: '2.0', length: '10.00' }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.quantity).toBe('20');
  });

  it('is deterministic: the same input yields the deep-equal result twice', () => {
    const input = takeoffInputOf([
      { itemKey: 'a', ...addition, unit: 'm3', count: '2', length: '3', width: '2', height: '0.5' },
    ]);
    expect(computeTakeoffQuantities(input)).toEqual(computeTakeoffQuantities(input));
  });

  it('multi-line items (addition + deduction) flow through with the engine sign semantics', () => {
    // takeoffInputOf maps one factor object to one single-line item; a multi-line item
    // (the engine's addition/deduction net) is passed directly, as the engine allows.
    const result = computeTakeoffQuantities({
      items: [
        {
          itemKey: 'a',
          unit: 'm2',
          lines: [
            { lineKey: 'a1', kind: 'addition', unit: 'm2', count: '10', length: '1', width: '1' },
            { lineKey: 'a2', kind: 'deduction', unit: 'm2', count: '3', length: '1', width: '1' },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]?.quantity).toBe('7'); // 10 − 3, exact
    expect(result.items[0]?.takeoff.input.lines).toHaveLength(2);
  });

  it('a standalone single-line deduction item is rejected by the engine net rule (pass-through)', () => {
    // Through the single-line wire shape a lone deduction always nets negative, so the
    // engine answers NEGATIVE_NET_QUANTITY — the adapter passes it through untouched.
    const result = computeTakeoffQuantities(
      takeoffInputOf([
        { itemKey: 'a', kind: 'deduction', unit: 'm2', count: '3', length: '1', width: '1' },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain('NEGATIVE_NET_QUANTITY');
  });
});

describe('computeTakeoffQuantities (engine error pass-through)', () => {
  /** Raw single-item input builder for engine-rule probes (bypasses the UI shape). */
  function raw(itemKey: string, item: Record<string, unknown>): unknown {
    return { items: [{ itemKey, ...item }] };
  }

  const cases: readonly { readonly name: string; readonly input: unknown }[] = [
    {
      name: 'INVALID_DECIMAL — a malformed factor',
      input: raw('a', {
        unit: 'm',
        lines: [{ lineKey: 'a', kind: 'addition', unit: 'm', count: 'x', length: '1' }],
      }),
    },
    {
      name: 'NEGATIVE_INPUT — a negative factor',
      input: raw('a', {
        unit: 'm',
        lines: [{ lineKey: 'a', kind: 'addition', unit: 'm', count: '1', length: '-2' }],
      }),
    },
    {
      name: 'NON_INTEGER_COUNT — a fractional count',
      input: raw('a', {
        unit: 'm',
        lines: [{ lineKey: 'a', kind: 'addition', unit: 'm', count: '1.5', length: '2' }],
      }),
    },
    {
      name: 'DIMENSION_UNIT_MISMATCH — m2 without width',
      input: raw('a', {
        unit: 'm2',
        lines: [{ lineKey: 'a', kind: 'addition', unit: 'm2', count: '1', length: '2' }],
      }),
    },
    {
      name: 'UNIT_MISMATCH — line unit differs from item unit',
      input: raw('a', {
        unit: 'm2',
        lines: [{ lineKey: 'a', kind: 'addition', unit: 'm', count: '1', length: '2', width: '2' }],
      }),
    },
    {
      name: 'UNIT_MISMATCH — a non-S1 unit (kg)',
      input: raw('a', {
        unit: 'kg',
        lines: [{ lineKey: 'a', kind: 'addition', unit: 'kg', count: '1' }],
      }),
    },
    {
      name: 'NEGATIVE_NET_QUANTITY — deduction exceeds addition',
      input: raw('a', {
        unit: 'm2',
        lines: [
          { lineKey: 'a1', kind: 'addition', unit: 'm2', count: '2', length: '1', width: '1' },
          { lineKey: 'a2', kind: 'deduction', unit: 'm2', count: '10', length: '1', width: '1' },
        ],
      }),
    },
    {
      name: 'EMPTY_ITEM — an item with no lines',
      input: raw('a', { unit: 'each', lines: [] }),
    },
    {
      name: 'DUPLICATE_KEY — two items share an itemKey',
      input: {
        items: [
          {
            itemKey: 'a',
            unit: 'each',
            lines: [{ lineKey: 'a', kind: 'addition', unit: 'each', count: '1' }],
          },
          {
            itemKey: 'a',
            unit: 'each',
            lines: [{ lineKey: 'a', kind: 'addition', unit: 'each', count: '1' }],
          },
        ],
      },
    },
    {
      name: 'INVALID_ROUNDING_POLICY — a malformed rounding policy on an item',
      input: {
        items: [
          {
            itemKey: 'a',
            unit: 'each',
            rounding: { stage: 'made-up', scale: 2, mode: 'half-up' },
            lines: [{ lineKey: 'a', kind: 'addition', unit: 'each', count: '1' }],
          },
        ],
      },
    },
  ];

  for (const testCase of cases) {
    it(`returns ok:false with the engine's own error — ${testCase.name.split(' — ')[0] ?? ''}`, () => {
      const direct = calculateQuantities(
        testCase.input as Parameters<typeof calculateQuantities>[0],
      );
      expect(direct.status).toBe('error');
      const result = computeTakeoffQuantities(
        testCase.input as Parameters<typeof computeTakeoffQuantities>[0],
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      if (direct.status !== 'error') return;
      const expected = direct.errors.map((e: CalculationError) => e.code);
      expect(result.errors.map((e) => e.code)).toEqual(expected);
      expect(result.errors).toEqual(direct.errors); // verbatim, no reinterpretation
    });
  }

  it('is atomic: one bad item fails the whole batch with no items', () => {
    const result = computeTakeoffQuantities({
      items: [
        {
          itemKey: 'good',
          unit: 'each',
          lines: [{ lineKey: 'good', kind: 'addition', unit: 'each', count: '2' }],
        },
        {
          itemKey: 'bad',
          unit: 'm2',
          lines: [{ lineKey: 'bad', kind: 'addition', unit: 'm2', count: '1', length: '1' }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('items' in result).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
