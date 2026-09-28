/**
 * Runs every CG-RCS@0.1.0 reference case through the PRODUCTION engine.
 * Expected values come from the spec JSON unchanged; the test oracle is not used here.
 */
import { describe, expect, it } from 'vitest';
import suiteJson from '../spec/reference-cases/quantity.v0.1.0.json' with { type: 'json' };
import {
  SPEC_VERSION,
  calculateQuantities,
  canonicalJson,
  type QuantityCalculationInput,
  type QuantityItemResult,
  type TraceNode,
} from '../src/index.js';
import type { ReferenceSuite } from './reference-types.js';

const suite = suiteJson as unknown as ReferenceSuite;

/** Project the full result onto the fields a reference case asserts. */
const projectItem = (i: QuantityItemResult) => ({
  itemKey: i.itemKey,
  unit: i.unit,
  exactQty: i.exactQty,
  ...(i.roundedQty === undefined ? {} : { roundedQty: i.roundedQty }),
  qty: i.qty,
  lines: i.lines.map((l) => ({
    lineKey: l.lineKey,
    exactQty: l.exactQty,
    ...(l.roundedQty === undefined ? {} : { roundedQty: l.roundedQty }),
    signedQty: l.signedQty,
  })),
});

it('engine targets the reference spec version', () => {
  expect(SPEC_VERSION).toBe(suite.specVersion);
  expect(suite.cases).toHaveLength(24);
});

describe.each(suite.cases.map((c) => [c.id, c] as const))('%s %s', (_id, c) => {
  const input = c.input as unknown as QuantityCalculationInput;

  it('matches the expected result', () => {
    const r = calculateQuantities(input);
    expect(r.status).toBe(c.expected.status);
    if (c.expected.status === 'ok') {
      expect(r.errors).toEqual([]);
      expect(r.items.map(projectItem)).toEqual(c.expected.items);
    } else {
      expect(r.items).toEqual([]);
      expect(
        r.errors.map((e) => ({
          code: e.code,
          itemKey: e.itemKey,
          ...(e.lineKey === undefined ? {} : { lineKey: e.lineKey }),
          ...(e.field === undefined ? {} : { field: e.field }),
        })),
      ).toEqual(c.expected.errors);
    }
  });

  if (c.expectedTrace) {
    const expectedTrace = c.expectedTrace;
    it('produces the expected trace exactly', () => {
      const r = calculateQuantities(input);
      expect(r.items[0]?.trace).toEqual(expectedTrace as unknown as TraceNode);
    });
  }

  if (c.repeat) {
    const rep = c.repeat;
    it(`is deterministic over ${String(rep.runs)} runs and line permutations`, () => {
      const item0 = input.items[0];
      if (!item0) throw new Error('case has no item');
      const qtys = new Set<string>();
      for (const perm of rep.linePermutations) {
        const lines = perm.map((k) => {
          const l = item0.lines.find((x) => x.lineKey === k);
          if (!l) throw new Error(`unknown line ${k}`);
          return l;
        });
        const permuted: QuantityCalculationInput = { items: [{ ...item0, lines }] };
        const first = canonicalJson(calculateQuantities(permuted));
        for (let i = 1; i < rep.runs; i++) {
          if (canonicalJson(calculateQuantities(permuted)) !== first)
            throw new Error(`run ${String(i)} differs`);
        }
        const r = calculateQuantities(permuted);
        expect(r.items[0]?.lines.map((l) => l.lineKey)).toEqual(perm);
        qtys.add(r.items[0]?.qty ?? '');
      }
      expect([...qtys]).toEqual(c.expected.status === 'ok' ? [c.expected.items[0]?.qty] : []);
    });
  }
});
