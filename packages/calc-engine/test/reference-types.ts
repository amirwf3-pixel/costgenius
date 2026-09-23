/** Type mirror of REFERENCE_CALCULATION_SPEC.md §4, §5, §7, §8 (test use only). */
export type Unit = 'm' | 'm2' | 'm3' | 'each';

export interface RoundingPolicy {
  stage: 'line' | 'item';
  scale: number;
  mode: 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP' | 'FLOOR' | 'CEIL';
}
export interface LineInput {
  lineKey: string;
  kind: 'addition' | 'deduction';
  unit: string;
  count: string;
  length?: string;
  width?: string;
  height?: string;
}
export interface ItemInput {
  itemKey: string;
  unit: string;
  rounding?: RoundingPolicy;
  lines: LineInput[];
}
export interface TraceNode {
  op: 'input' | 'multiply' | 'negate' | 'sum' | 'round';
  label: string;
  value: string;
  unit: string | null;
  rule?: string;
  rounding?: RoundingPolicy;
  inputs: TraceNode[];
  ref?: { itemKey: string; lineKey?: string; field?: string };
}
export interface ExpectedError {
  code: string;
  itemKey: string;
  lineKey?: string;
  field?: string;
}
export interface ExpectedLine {
  lineKey: string;
  exactQty: string;
  roundedQty?: string;
  signedQty: string;
}
export interface ExpectedItem {
  itemKey: string;
  unit: string;
  exactQty: string;
  roundedQty?: string;
  qty: string;
  lines: ExpectedLine[];
}
export type Expected =
  { status: 'ok'; items: ExpectedItem[] } | { status: 'error'; errors: ExpectedError[] };

export interface ReferenceCase {
  id: string;
  title: string;
  stage: string;
  category: string;
  input: { items: ItemInput[] };
  expected: Expected;
  formula: string;
  rounding: RoundingPolicy | null;
  traceRequirements: string[];
  assumptions: string[];
  source: { status: string; reference: string | null };
  expectedTrace?: TraceNode;
  repeat?: { runs: number; linePermutations: string[][]; invariant: string };
}
export interface ReferenceSuite {
  specId: string;
  specVersion: string;
  stage: string;
  notice: string;
  cases: ReferenceCase[];
}
