/**
 * Validates the CG-IR-MEAS@0.1.0 SYNTHETIC cases (specification data only).
 * The evaluator below is a TEST-ONLY cross-check of expected values; it is not the takeoff engine and
 * production code must never import it (enforced by lint for packages/calc-engine/src).
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import specText from '../spec/CG-IR-MEASUREMENT-SPEC@0.1.0.md?raw';
import suiteJson from '../spec/ir-measurement-cases/ir-measurement.v0.1.0.json' with { type: 'json' };

type Use = 'signed' | 'magnitude';
type Node =
  | { op: 'const'; value: string }
  | { op: 'ref'; lineId: string; use: Use }
  | { op: 'add' | 'mul' | 'sub'; args: Node[] };
type Quantity =
  | {
      type: 'dimensional';
      profile: string;
      floorCount?: string;
      similarCount?: string;
      length?: string;
      width?: string;
      height?: string;
    }
  | { type: 'reference'; terms: { lineId: string; factor: string; use: Use }[] }
  | { type: 'expression'; node: Node }
  | { type: 'manual'; value: string; justification: string };
interface Line {
  lineId: string;
  rowNo: number;
  itemCode: string | null;
  kind: 'addition' | 'deduction';
  unit: string;
  quantity: Quantity;
}
interface Rule {
  target: string;
  selector?: { lineIds?: string[] };
  scale: number;
  mode: 'HALF_UP' | 'HALF_EVEN';
  sourceStatus: string;
}
interface Case {
  id: string;
  title: string;
  category: string;
  formula: string;
  assumptions: string[];
  source: { sourceStatus: string; sourceDocument: null; edition: null; page: null; section: null };
  input: { rounding: Rule[]; sheets: { sheetId: string; lines: Line[] }[] };
  expected:
    | { status: 'ok'; lines: Record<string, string>; itemTotals: Record<string, string> }
    | { status: 'error'; errors: { code: string; lineId: string }[] };
}
const suite = suiteJson as unknown as { specId: string; specVersion: string; cases: Case[] };
const D = Decimal.clone({ precision: 60 });
const canon = (d: Decimal): string => (d.isZero() ? '0' : d.toFixed());
const PROFILE: Record<string, string[]> = {
  count: [],
  L: ['length'],
  LW: ['length', 'width'],
  LWH: ['length', 'width', 'height'],
};

/** Minimal happy-path evaluator: exact decimals, references resolved recursively, reference-term rounding only. */
function evaluate(c: Case): { lines: Record<string, string>; itemTotals: Record<string, string> } {
  const all = new Map(c.input.sheets.flatMap((s) => s.lines).map((l) => [l.lineId, l] as const));
  const memo = new Map<string, Decimal>();
  const roundFor = (lineId: string): Rule | undefined =>
    c.input.rounding.find(
      (r) => r.target === 'reference-term' && r.selector?.lineIds?.includes(lineId),
    );
  const signed = (id: string): Decimal => {
    const cached = memo.get(id);
    if (cached) return cached;
    const l = all.get(id);
    if (!l) throw new Error(`unknown ${id}`);
    const rule = roundFor(id);
    const term = (lineId: string, use: Use): Decimal => {
      const v = use === 'magnitude' ? signed(lineId).abs() : signed(lineId);
      return rule
        ? v.toDecimalPlaces(
            rule.scale,
            rule.mode === 'HALF_UP' ? D.ROUND_HALF_UP : D.ROUND_HALF_EVEN,
          )
        : v;
    };
    const node = (n: Node): Decimal =>
      n.op === 'const'
        ? new D(n.value)
        : n.op === 'ref'
          ? term(n.lineId, n.use)
          : n.op === 'add'
            ? n.args.map(node).reduce((a, b) => a.plus(b))
            : n.op === 'mul'
              ? n.args.map(node).reduce((a, b) => a.times(b))
              : node(n.args[0] as Node).minus(node(n.args[1] as Node));
    const q = l.quantity;
    let mag: Decimal;
    if (q.type === 'dimensional') {
      mag = [q.floorCount, q.similarCount, q.length, q.width, q.height]
        .filter((v): v is string => v !== undefined)
        .reduce((a, v) => a.times(v), new D(1));
    } else if (q.type === 'reference') {
      mag = q.terms.reduce((a, t) => a.plus(term(t.lineId, t.use).times(t.factor)), new D(0));
    } else if (q.type === 'expression') {
      mag = node(q.node);
    } else {
      mag = new D(q.value);
    }
    const v = l.kind === 'deduction' ? mag.negated() : mag;
    memo.set(id, v);
    return v;
  };
  const lines: Record<string, string> = {};
  const totals = new Map<string, Decimal>();
  for (const l of all.values()) {
    const v = signed(l.lineId);
    lines[l.lineId] = canon(v);
    const key = l.itemCode ?? 'null';
    totals.set(key, (totals.get(key) ?? new D(0)).plus(v));
  }
  return { lines, itemTotals: Object.fromEntries([...totals].map(([k, v]) => [k, canon(v)])) };
}

describe('CG-IR-MEAS synthetic suite metadata', () => {
  it('identifies spec and version', () => {
    expect(suite.specId).toBe('CG-IR-MEAS');
    expect(suite.specVersion).toBe('0.1.0');
  });
  it('has unique sequential ids', () => {
    suite.cases.forEach((c, i) => {
      expect(c.id).toBe(`IRM-${String(i + 1).padStart(3, '0')}`);
    });
  });
  it('covers required categories', () => {
    const cats = new Set(suite.cases.map((c) => c.category));
    for (const k of ['counts', 'references', 'expressions', 'rounding', 'manual', 'validation'])
      expect(cats).toContain(k);
  });
});

describe.each(suite.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
  it('is synthetic and claims no Iranian source', () => {
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
    c.input.rounding.forEach((r) => {
      expect(r.sourceStatus).not.toBe('verified');
    });
    expect(c.formula.length).toBeGreaterThan(0);
  });

  it('has unique lineIds and per-sheet rowNos', () => {
    const ids = c.input.sheets.flatMap((s) => s.lines.map((l) => l.lineId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of c.input.sheets) {
      const rows = s.lines.map((l) => l.rowNo);
      expect(new Set(rows).size).toBe(rows.length);
    }
  });

  if (c.expected.status === 'ok') {
    const exp = c.expected;
    it('success input satisfies the dimensional profile rules', () => {
      for (const l of c.input.sheets.flatMap((s) => s.lines)) {
        const q = l.quantity;
        if (q.type !== 'dimensional') continue;
        const given = (['length', 'width', 'height'] as const).filter((k) => q[k] !== undefined);
        expect(given).toEqual(PROFILE[q.profile]);
      }
    });
    it('expected values agree with the test-only evaluator', () => {
      expect(evaluate(c)).toEqual({ lines: exp.lines, itemTotals: exp.itemTotals });
    });
  } else {
    const errs = c.expected.errors;
    it('lists spec error codes for known lines', () => {
      const codes = new Set([
        'DUPLICATE_KEY',
        'INVALID_DECIMAL',
        'NON_INTEGER_COUNT',
        'NEGATIVE_INPUT',
        'DIMENSION_PROFILE_MISMATCH',
        'UNKNOWN_REFERENCE',
        'CIRCULAR_REFERENCE',
        'UNIT_MISMATCH',
        'MISSING_JUSTIFICATION',
        'NEGATIVE_LINE_MAGNITUDE',
        'INVALID_ROUNDING_POLICY',
        'NEGATIVE_NET_QUANTITY',
      ]);
      const ids = new Set(c.input.sheets.flatMap((s) => s.lines.map((l) => l.lineId)));
      errs.forEach((e) => {
        expect(codes).toContain(e.code);
        expect(ids).toContain(e.lineId);
      });
    });
  }
});

describe('CG-IR-MEAS spec document', () => {
  const spec = specText.replace(/[ \t]+/g, ' ');
  it('keeps stages separate and forbids prices/coefficients in S1', () => {
    expect(spec).toContain('S1 must not read prices, coefficients');
    expect(spec).toContain('The generic engine (`calculateQuantities`, CG-RCS) stays unchanged');
  });
  it('declares no default rounding and exact-value negative checks', () => {
    expect(spec).toContain('no default rounding exists');
    expect(spec).toContain('Negative checks (V9, V11) always use exact values');
  });
  it('every Iranian registry row carries the four source fields and is unverified', () => {
    const table = spec.slice(
      spec.indexOf('| Area | sourceDocument'),
      spec.indexOf('## 9.3 Verified Iranian Rules'),
    );
    const rows = table
      .split('\n')
      .filter((r) => r.startsWith('|') && !/^\| ?-/.test(r) && !r.startsWith('| Area'));
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r) => {
      expect(r.split('|').length - 2).toBe(6);
      expect(r.trim().endsWith('unverified |')).toBe(true);
    });
  });
});

/** Structure/source-metadata checks for "Verified Iranian Rules — 1404" tables (spec text only). */
export function verifiedRuleRows(spec: string, prefix: string): string[][] {
  return spec
    .split('\n')
    .filter((r) => r.startsWith(`| ${prefix}`))
    .map((r) =>
      r
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
}

describe('CG-IR-MEAS verified Iranian rules — 1404', () => {
  const spec = specText.replace(/[ \t]+/g, ' ');
  const rows = verifiedRuleRows(spec, 'IR-1404-M-');
  it('has the section and the expected measurement rules', () => {
    expect(spec).toContain('Verified Iranian Rules — 1404');
    expect(rows.map((r) => r[0])).toEqual([
      'IR-1404-M-REBAR-01',
      'IR-1404-M-CONC-01',
      'IR-1404-M-CONC-02',
      'IR-1404-M-OPEN-00',
    ]);
  });
  it('every rule carries full source metadata and VERIFIED_SPEC_ONLY', () => {
    for (const r of rows) {
      expect(r).toHaveLength(9);
      expect(r[1]).toBe('فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴');
      expect(r[2]).toBe('1404');
      expect(r[3]).toMatch(/^(\d+(–\d+)?|null)$/);
      for (const i of [4, 5, 6, 7]) expect(r[i]?.length).toBeGreaterThan(0);
      expect(r[8]).toBe('VERIFIED_SPEC_ONLY');
    }
  });
  it('cites the verified pages/clauses', () => {
    const byId = new Map(rows.map((r) => [r[0], r]));
    expect(byId.get('IR-1404-M-REBAR-01')?.slice(3, 5)).toEqual([
      '56',
      'Chapter 7 (کارهای فولادی با میلگرد), General Requirements (الزامات عمومی), clause 2',
    ]);
    expect(byId.get('IR-1404-M-CONC-01')?.slice(3, 5)).toEqual([
      '61',
      'Chapter 8, General Requirements, clause 4',
    ]);
    expect(byId.get('IR-1404-M-CONC-02')?.slice(3, 5)).toEqual([
      '61',
      'Chapter 8 (بتن درجا), General Requirements (الزامات عمومی), clause 6',
    ]);
  });
  it('keeps concrete rules chapter-scoped and has no universal opening deduction', () => {
    expect(spec).not.toMatch(/openingDeduction\s*[:=]\s*true/);
    const conc = rows.filter((r) => r[0]?.startsWith('IR-1404-M-CONC'));
    conc.forEach((r) => {
      expect(r[6]).toContain('Chapter 8 concrete items only');
    });
  });
  it('keeps numeric uncertainties explicitly unverified', () => {
    const byId = new Map(rows.map((r) => [r[0], r[7]]));
    expect(byId.get('IR-1404-M-REBAR-01')).toMatch(
      /^Tolerance value: not printed in the 1404 price list/,
    );
    expect(byId.get('IR-1404-M-CONC-02')).toMatch(
      /^Larger-void treatment is not specified in the 1404 pricebook provision reviewed/,
    );
  });
  it('REBAR-01 uses the weighed unit weight capped by the standard-table maximum tolerance', () => {
    const r = rows.find((x) => x[0] === 'IR-1404-M-REBAR-01');
    const t = r?.[5] ?? '';
    expect(t).toContain('the weighed unit weight (وزن واحد توزین شده) is the basis');
    expect(t).toContain(
      'provided it is not more than the calculated theoretical unit weight taking into account the maximum tolerance of the standard tables (حداکثر رواداری جدول‌های استاندارد)',
    );
    expect(t).toContain('using standard tables or the manufacturer');
    expect(t).not.toMatch(/\d+(\.\d+)?\s*%/);
    expect(r?.[6]).toBe('Chapter 7 rows measured by weight only');
  });
  it('CONC-02 does not deduct voids of 0.05 m³ or less each', () => {
    const r = rows.find((x) => x[0] === 'IR-1404-M-CONC-02');
    expect(r?.slice(3, 5)).toEqual([
      '61',
      'Chapter 8 (بتن درجا), General Requirements (الزامات عمومی), clause 6',
    ]);
    expect(r?.[5]).toContain(
      'each of which is 0.05 cubic metre (مترمکعب) or less, is not deducted from the concrete volume in measurement',
    );
    expect(r?.[5]).toContain('Threshold: 0.05 m³ per individual void, inclusive (≤).');
    expect(r?.[6]).toContain('Chapter 8 concrete items only; per individual void');
  });
  it('CONC-02 asserts no rule for voids larger than 0.05 m³', () => {
    const r = rows.find((x) => x[0] === 'IR-1404-M-CONC-02');
    const t = r?.[5] ?? '';
    expect(t).not.toMatch(
      /larger than|more than|exceed|greater than|> ?0\.05|is deducted|are deducted/i,
    );
    expect(r?.[7]).toContain('neither deduction nor non-deduction is assumed');
  });
});
