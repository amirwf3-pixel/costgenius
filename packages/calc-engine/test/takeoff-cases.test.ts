/**
 * Runs the CG-IR-MEAS specification case suites through the real `calculateTakeoff`:
 * the new 0.2.0 cases (V13, exact aggregation, rounding targets) and the 0.1.0 case set,
 * which stays normative under 0.2.0 (the 0.2.0 changelog asserts no 0.1.0 case is
 * invalidated). Case JSON is specification data; the engine under test is production code.
 */
import { describe, expect, it } from 'vitest';
import suite02 from '../spec/ir-measurement-cases/ir-measurement.v0.2.0.json' with { type: 'json' };
import suite01 from '../spec/ir-measurement-cases/ir-measurement.v0.1.0.json' with { type: 'json' };
import {
  TAKEOFF_SPEC_VERSION,
  calculateTakeoff,
  type TakeoffCalculationInput,
  type TakeoffQuantity,
} from '../src/index.js';

type CaseQuantity = TakeoffQuantity | { type: string };
interface CaseLine {
  lineId: string;
  rowNo: number;
  itemCode: string | null;
  kind: 'addition' | 'deduction';
  unit: string;
  quantity: CaseQuantity;
}
interface CaseRule {
  target: string;
  selector?: { itemCode?: string; unit?: string; lineIds?: string[] };
  scale: number;
  mode: string;
  sourceStatus: string;
}
interface ExpectedOk {
  status: 'ok';
  lines: Record<string, string>;
  itemTotals?: { itemCode: string | null; unit: string; qty: string }[];
  sheetTotals?: {
    sheetId: string;
    byItem: { itemCode: string | null; unit: string; qty: string }[];
  }[];
}
interface ExpectedError {
  status: 'error';
  errors: { code: string; lineId?: string }[];
}
interface Case {
  id: string;
  title: string;
  category: string;
  formula: string;
  assumptions: string[];
  source: { sourceStatus: string; sourceDocument: null; edition: null; page: null; section: null };
  input: { rounding: CaseRule[]; sheets: { sheetId: string; lines: CaseLine[] }[] };
  expected: ExpectedOk | ExpectedError;
}
interface Suite {
  specId: string;
  specVersion: string;
  cases: Case[];
}

const v02 = suite02 as unknown as Suite;
const v01 = suite01 as unknown as Suite;

/** Maps a specification case onto the engine input (description/name are product-layer fields). */
function toInput(c: Case): TakeoffCalculationInput {
  return {
    rounding: c.input.rounding as unknown as TakeoffCalculationInput['rounding'],
    sheets: c.input.sheets.map((s, i) => ({
      sheetId: s.sheetId,
      name: `sheet-${String(i)}`,
      lines: s.lines.map((l) => ({
        lineId: l.lineId,
        rowNo: l.rowNo,
        description: '',
        itemCode: l.itemCode,
        kind: l.kind,
        unit: l.unit,
        quantity: l.quantity as TakeoffQuantity,
      })),
    })),
  };
}

function expectOk(c: Case, expected: ExpectedOk): void {
  const r = calculateTakeoff(toInput(c));
  expect(r.status, `${c.id}: ${r.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`).toBe(
    'ok',
  );
  const signed = Object.fromEntries(r.lines.map((l) => [l.lineId, l.signedValue]));
  expect(signed).toEqual(expected.lines);
  if (expected.itemTotals !== undefined) {
    expect(r.itemTotals.map((t) => ({ itemCode: t.itemCode, unit: t.unit, qty: t.qty }))).toEqual(
      expected.itemTotals,
    );
  }
  if (expected.sheetTotals !== undefined) {
    expect(
      r.sheetTotals.map((s) => ({
        sheetId: s.sheetId,
        byItem: s.byItem.map((b) => ({ itemCode: b.itemCode, unit: b.unit, qty: b.qty })),
      })),
    ).toEqual(expected.sheetTotals);
  }
}

function expectError(c: Case, expected: ExpectedError): void {
  const r = calculateTakeoff(toInput(c));
  expect(r.status).toBe('error');
  for (const e of expected.errors) {
    const match = r.errors.find(
      (x) => x.code === e.code && (e.lineId === undefined || x.lineId === e.lineId),
    );
    expect(
      match,
      `${c.id}: expected ${e.code} on ${e.lineId ?? '(any)'}; got ${r.errors.map((x) => `${x.code}:${x.lineId ?? ''}`).join(', ')}`,
    ).toBeDefined();
  }
}

describe('CG-IR-MEAS v0.2.0 suite metadata', () => {
  it('identifies spec and version', () => {
    expect(v02.specId).toBe('CG-IR-MEAS');
    expect(v02.specVersion).toBe(TAKEOFF_SPEC_VERSION);
  });
  it('has unique sequential ids after the 0.1.0 range', () => {
    v02.cases.forEach((c, i) => {
      expect(c.id).toBe(`IRM-${String(101 + i).padStart(3, '0')}`);
    });
    expect(new Set(v02.cases.map((c) => c.id)).size).toBe(v02.cases.length);
  });
  it('covers the 0.2.0 categories', () => {
    const cats = new Set(v02.cases.map((c) => c.category));
    for (const k of [
      'aggregation',
      'rounding',
      'references',
      'expressions',
      'counts',
      'validation',
    ])
      expect(cats).toContain(k);
  });
  it('is synthetic and claims no Iranian source', () => {
    for (const c of v02.cases) {
      expect(c.source).toEqual({
        sourceStatus: 'design',
        sourceDocument: null,
        edition: null,
        page: null,
        section: null,
      });
      for (const l of c.input.sheets.flatMap((s) => s.lines)) {
        if (l.itemCode !== null) expect(l.itemCode).toMatch(/^SYN-\d{4}$/);
      }
      for (const r of c.input.rounding) expect(r.sourceStatus).not.toBe('verified');
    }
  });
});

describe.each(v02.cases.map((c) => [c.id, c] as const))('CG-IR-MEAS 0.2.0 %s', (_id, c) => {
  it(`${c.title} [${c.category}]`, () => {
    if (c.expected.status === 'ok') expectOk(c, c.expected);
    else expectError(c, c.expected);
  });
});

describe('CG-IR-MEAS v0.1.0 cases remain valid under the 0.2.0 engine', () => {
  it('suite metadata', () => {
    expect(v01.specId).toBe('CG-IR-MEAS');
    expect(v01.specVersion).toBe('0.1.0');
    expect(v01.cases).toHaveLength(14);
  });

  describe.each(v01.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    it(`${c.title} [${c.category}]`, () => {
      if (c.expected.status === 'ok') {
        const exp = c.expected;
        const r = calculateTakeoff(toInput(c));
        expect(
          r.status,
          `${c.id}: ${r.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`,
        ).toBe('ok');
        // 0.1.0 case lines are the signed values; itemTotals are keyed by itemCode ('null' for uncoded).
        const signed = Object.fromEntries(r.lines.map((l) => [l.lineId, l.signedValue]));
        expect(signed).toEqual(exp.lines);
        const totals = Object.fromEntries(r.itemTotals.map((t) => [t.itemCode ?? 'null', t.qty]));
        expect(totals).toEqual(exp.itemTotals);
      } else {
        expectError(c, c.expected);
      }
    });
  });
});
