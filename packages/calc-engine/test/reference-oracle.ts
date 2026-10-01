/**
 * TEST-ONLY ORACLE. Not the calculation engine.
 *
 * It independently re-derives the expected values written in the reference cases, so an arithmetic mistake in
 * the specification data is caught. It deliberately covers only the successful paths of spec §4.2 and §5, has no
 * validation or error handling, and must never be imported by production code.
 */
import { Decimal } from 'decimal.js';
import type { ItemInput, LineInput, RoundingPolicy, TraceNode } from './reference-types.js';

const D = Decimal.clone({ precision: 60 });
type Dec = InstanceType<typeof D>;

const MODES: Record<RoundingPolicy['mode'], Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
  FLOOR: Decimal.ROUND_FLOOR,
  CEIL: Decimal.ROUND_CEIL,
};

export const canon = (d: Dec): string => (d.isZero() ? '0' : d.toFixed());
const round = (d: Dec, p: RoundingPolicy): Dec => d.toDecimalPlaces(p.scale, MODES[p.mode]);

export interface OracleLine {
  lineKey: string;
  exactQty: string;
  roundedQty?: string;
  signedQty: string;
}
export interface OracleItem {
  itemKey: string;
  exactQty: string;
  roundedQty?: string;
  qty: string;
  lines: OracleLine[];
}

export function oracleItem(item: ItemInput): OracleItem {
  const policy = item.rounding;
  let exactSum = new D(0);
  let contributionSum = new D(0);
  const lines = item.lines.map((l: LineInput): OracleLine => {
    const exact = [l.count, l.length, l.width, l.height]
      .filter((v): v is string => v !== undefined)
      .reduce((acc, v) => acc.times(v), new D(1));
    const sign = l.kind === 'deduction' ? -1 : 1;
    const rounded = policy?.stage === 'line' ? round(exact, policy) : undefined;
    const contribution = (rounded ?? exact).times(sign);
    exactSum = exactSum.plus(exact.times(sign));
    contributionSum = contributionSum.plus(contribution);
    return {
      lineKey: l.lineKey,
      exactQty: canon(exact),
      ...(rounded ? { roundedQty: canon(rounded) } : {}),
      signedQty: canon(contribution),
    };
  });
  let roundedQty: Dec | undefined;
  if (policy?.stage === 'line') roundedQty = contributionSum;
  if (policy?.stage === 'item') roundedQty = round(exactSum, policy);
  return {
    itemKey: item.itemKey,
    exactQty: canon(exactSum),
    ...(roundedQty ? { roundedQty: canon(roundedQty) } : {}),
    qty: canon(roundedQty ?? exactSum),
    lines,
  };
}

/** Re-evaluates a trace tree bottom-up (T4) and returns the recomputed root value. */
export function evaluateTrace(node: TraceNode): string {
  const vals = node.inputs.map((n) => new D(evaluateTrace(n)));
  let v: Dec;
  switch (node.op) {
    case 'input':
      v = new D(node.value);
      break;
    case 'multiply':
      v = vals.reduce((a, b) => a.times(b), new D(1));
      break;
    case 'sum':
      v = vals.reduce((a, b) => a.plus(b), new D(0));
      break;
    case 'negate':
      v = (vals[0] ?? new D(0)).negated();
      break;
    case 'round':
      if (!node.rounding) throw new Error(`round node ${node.label} lacks policy`);
      v = round(vals[0] ?? new D(0), node.rounding);
      break;
  }
  const out = canon(v);
  if (out !== node.value)
    throw new Error(`trace node ${node.label}: stated ${node.value}, recomputed ${out}`);
  return out;
}
