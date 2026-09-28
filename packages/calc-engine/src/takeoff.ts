/**
 * D-016 Full Takeoff S1 engine (CG-IR-MEASUREMENT-SPEC@0.2.0 §4–§8). Pure sibling of the
 * frozen `calculateQuantities` (CG-RCS@0.1.0): same exact-decimal discipline via
 * @costgenius/domain `Qty`, same atomic all-errors-in-input-order contract, no I/O, clock,
 * randomness or `eval`. Pipeline (spec §7):
 *   1. validate (V1–V8, V10, V13) — static, in document input order
 *   2. resolve references (V5, V7) and reject cycles (V6, lexicographically rotated)
 *   3. topologically order lines (ties broken by `(sheet order, rowNo, lineId)`)
 *   4. evaluate each line exactly; `line` rounding then the `kind` sign (V9)
 *   5. aggregate item/sheet totals from EXACT values only; one rounding at the target (V11)
 *   6. assemble traces (§8) and the canonical result
 *
 * Structural garbage that TypeScript's closed unions exclude (unknown quantity type,
 * unknown node op, unknown `kind`) is a caller-contract violation and throws — the API
 * edge owns structural validation (CG-FT-TAKEOFF-SPEC §12). Everything the engine spec
 * covers is a deterministic `TakeoffError`, never a throw.
 *
 * Selector specificity (§6 "narrowest match wins; ties = errors") is formalized as:
 * `lineIds` membership scores 4, `itemCode` match scores 2, `unit` match scores 1; all
 * specified fields must match (AND); the highest-scoring matching rule applies; two
 * rules sharing the top score is `INVALID_ROUNDING_POLICY`.
 */
import {
  Qty,
  RoundingMode,
  isUnitCode,
  type RoundingRule,
  type UnitCode,
} from '@costgenius/domain';
import type {
  DimensionalQuantity,
  ExpressionNode,
  ManualQuantity,
  ReferenceQuantity,
  ReferenceUse,
  RoundingRuleEntry,
  RoundingRuleSet,
  TakeoffCalculationInput,
  TakeoffError,
  TakeoffErrorCode,
  TakeoffItemTotal,
  TakeoffLineInput,
  TakeoffLineResult,
  TakeoffQuantity,
  TakeoffResult,
  TakeoffSheetInput,
  TakeoffSheetItemTotal,
  TakeoffSheetTotal,
  TakeoffTraceNode,
} from './takeoff-types.js';
import { ENGINE_VERSION, TAKEOFF_SPEC_VERSION } from './version.js';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const MAX_SCALE = 20;
const ROUNDING_MODES: readonly string[] = Object.values(RoundingMode);
const ROUNDING_TARGETS: readonly string[] = ['line', 'reference-term', 'item-total', 'sheet-total'];
const SOURCE_STATUSES: readonly string[] = [
  'design',
  'organization-policy',
  'verified',
  'unverified',
];
const DIMENSIONS = ['length', 'width', 'height'] as const;
type Dimension = (typeof DIMENSIONS)[number];
type Profile = DimensionalQuantity['profile'];
const PROFILE_DIMENSIONS: Readonly<Record<Profile, readonly Dimension[]>> = {
  count: [],
  L: ['length'],
  LW: ['length', 'width'],
  LWH: ['length', 'width', 'height'],
};
const FACTOR_ORDER = ['floorCount', 'similarCount', ...DIMENSIONS] as const;
type FactorName = (typeof FACTOR_ORDER)[number];

/** A line flattened into document order (§2: sheet order then line order). */
interface FlatLine {
  readonly line: TakeoffLineInput;
  readonly sheetIndex: number;
  readonly sheetId: string;
  readonly order: number;
}

type ParsedNode =
  | { readonly op: 'const'; readonly value: Qty }
  | { readonly op: 'ref'; readonly lineId: string; readonly use: ReferenceUse }
  | { readonly op: 'add' | 'mul'; readonly args: readonly ParsedNode[] }
  | { readonly op: 'sub'; readonly args: readonly [ParsedNode, ParsedNode] }
  | { readonly op: 'round'; readonly arg: ParsedNode; readonly rule: RoundingRule };

type ParsedQuantity =
  | {
      readonly type: 'dimensional';
      readonly factors: readonly { readonly name: FactorName; readonly value: Qty }[];
    }
  | {
      readonly type: 'reference';
      readonly terms: readonly {
        readonly lineId: string;
        readonly factor: Qty;
        readonly use: ReferenceUse;
      }[];
    }
  | { readonly type: 'expression'; readonly node: ParsedNode }
  | { readonly type: 'manual'; readonly value: Qty };

/** Everything evaluation needs for one validated line. */
interface LineContext {
  readonly flat: FlatLine;
  readonly unit: UnitCode;
  readonly quantity: ParsedQuantity;
  readonly itemCode: string | null;
}

interface ErrorAt {
  sheetId?: string | undefined;
  lineId?: string | undefined;
  field?: string | undefined;
}

// -------------------------------------------------------------------------------------------------
// §5 error collection (input order, atomic)
// -------------------------------------------------------------------------------------------------

class ErrorCollector {
  private readonly list: TakeoffError[] = [];

  get count(): number {
    return this.list.length;
  }

  add(code: TakeoffErrorCode, message: string, at: ErrorAt = {}): void {
    this.list.push({
      code,
      message,
      ...(at.sheetId === undefined ? {} : { sheetId: at.sheetId }),
      ...(at.lineId === undefined ? {} : { lineId: at.lineId }),
      ...(at.field === undefined ? {} : { field: at.field }),
    });
  }

  get errors(): readonly TakeoffError[] {
    return this.list;
  }
}

// -------------------------------------------------------------------------------------------------
// §5.1 structural flattening (caller-contract violations throw; spec violations are errors)
// -------------------------------------------------------------------------------------------------

function mustBeString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`structurally invalid takeoff input: ${what} must be a non-empty string`);
  }
  return value;
}

function flattenSheets(sheets: readonly TakeoffSheetInput[]): FlatLine[] {
  const flats: FlatLine[] = [];
  let order = 0;
  for (const [sheetIndex, sheet] of sheets.entries()) {
    const sheetId = mustBeString(sheet.sheetId, 'sheetId');
    for (const line of sheet.lines) {
      flats.push({ line, sheetIndex, sheetId, order: order++ });
    }
  }
  return flats;
}

// -------------------------------------------------------------------------------------------------
// §5.2 static validation (V1–V4, V8, V10) — document input order
// -------------------------------------------------------------------------------------------------

function parseDecimal(raw: unknown, unit: UnitCode): Qty | undefined {
  if (typeof raw !== 'string' || !DECIMAL.test(raw)) return undefined;
  return Qty.of(raw, unit);
}

function validateKeys(
  sheets: readonly TakeoffSheetInput[],
  flats: readonly FlatLine[],
  errs: ErrorCollector,
): void {
  const sheetIds = new Set<string>();
  for (const sheet of sheets) {
    const sheetId = mustBeString(sheet.sheetId, 'sheetId');
    if (sheetIds.has(sheetId)) {
      errs.add('DUPLICATE_KEY', `duplicate sheetId "${sheetId}"`, { sheetId, field: 'sheetId' });
    }
    sheetIds.add(sheetId);
  }
  const lineIds = new Set<string>();
  const rowNos = new Map<string, Set<number>>();
  for (const flat of flats) {
    const { line } = flat;
    const lineId = mustBeString(line.lineId, 'lineId');
    if (lineIds.has(lineId)) {
      errs.add('DUPLICATE_KEY', `duplicate lineId "${lineId}"`, {
        sheetId: flat.sheetId,
        lineId,
        field: 'lineId',
      });
    }
    lineIds.add(lineId);
    const rows = rowNos.get(flat.sheetId) ?? new Set<number>();
    if (rows.has(line.rowNo)) {
      errs.add(
        'DUPLICATE_KEY',
        `duplicate rowNo ${String(line.rowNo)} in sheet "${flat.sheetId}"`,
        {
          sheetId: flat.sheetId,
          lineId,
          field: 'rowNo',
        },
      );
    }
    rows.add(line.rowNo);
    rowNos.set(flat.sheetId, rows);
  }
}

/** V2/V3/V4 dimensional factors, in fixed field order. */
function validateDimensional(
  q: DimensionalQuantity,
  unit: UnitCode,
  errs: ErrorCollector,
  at: { sheetId: string; lineId: string },
):
  | {
      readonly type: 'dimensional';
      readonly factors: readonly { readonly name: FactorName; readonly value: Qty }[];
    }
  | undefined {
  const profile: unknown = q.profile;
  if (typeof profile !== 'string' || !(profile in PROFILE_DIMENSIONS)) {
    errs.add('DIMENSION_PROFILE_MISMATCH', `unknown profile "${String(profile)}"`, {
      ...at,
      field: 'profile',
    });
    return undefined;
  }
  const required = PROFILE_DIMENSIONS[profile as Profile];
  for (const dim of DIMENSIONS) {
    const present = q[dim] !== undefined;
    if (present !== required.includes(dim)) {
      errs.add(
        'DIMENSION_PROFILE_MISMATCH',
        `profile "${profile}" requires exactly [${required.join(', ') || 'none'}]; "${dim}" is ${present ? 'not allowed' : 'missing'}`,
        { ...at, field: dim },
      );
    }
  }
  const factors: { name: FactorName; value: Qty }[] = [];
  const before = errs.count;
  for (const name of FACTOR_ORDER) {
    const raw: unknown = q[name];
    if (raw === undefined) continue;
    const value = parseDecimal(raw, 'each');
    if (value === undefined) {
      errs.add('INVALID_DECIMAL', `${name} is not a plain decimal string`, { ...at, field: name });
      continue;
    }
    if (value.isNegative()) {
      errs.add('NEGATIVE_INPUT', `${name} must be ≥ 0; use kind "deduction"`, {
        ...at,
        field: name,
      });
      continue;
    }
    if ((name === 'floorCount' || name === 'similarCount') && !isIntegerAtLeastOne(value)) {
      errs.add('NON_INTEGER_COUNT', `${name} must be an integer ≥ 1`, { ...at, field: name });
      continue;
    }
    factors.push({ name, value });
  }
  return errs.count === before ? { type: 'dimensional', factors } : undefined;
}

function isIntegerAtLeastOne(value: Qty): boolean {
  const whole = value.round({ scale: 0, mode: RoundingMode.DOWN });
  return value.equals(whole) && value.compare(Qty.of('1', 'each')) >= 0;
}

/** V2 reference factors (a negative factor is allowed, §4.2). */
function validateReference(
  q: ReferenceQuantity,
  errs: ErrorCollector,
  at: { sheetId: string; lineId: string },
):
  | {
      readonly type: 'reference';
      readonly terms: readonly {
        readonly lineId: string;
        readonly factor: Qty;
        readonly use: ReferenceUse;
      }[];
    }
  | undefined {
  const terms: { lineId: string; factor: Qty; use: ReferenceUse }[] = [];
  const before = errs.count;
  for (const [index, term] of q.terms.entries()) {
    const target = mustBeString(term.lineId, `terms[${String(index)}].lineId`);
    const factor = parseDecimal(term.factor, 'each');
    if (factor === undefined) {
      errs.add('INVALID_DECIMAL', `terms[${String(index)}].factor is not a plain decimal string`, {
        ...at,
        field: `terms[${String(index)}].factor`,
      });
      continue;
    }
    terms.push({ lineId: target, factor, use: term.use });
  }
  return errs.count === before ? { type: 'reference', terms } : undefined;
}

/** V2/V10 expression tree: const formats and inline `round` rules; structure is caller-guaranteed. */
function validateExpression(
  node: ExpressionNode,
  unit: UnitCode,
  errs: ErrorCollector,
  at: { sheetId: string; lineId: string },
): ParsedNode | undefined {
  const before = errs.count;
  const walk = (n: ExpressionNode): ParsedNode => {
    switch (n.op) {
      case 'const': {
        const value = parseDecimal(n.value, unit);
        if (value === undefined) {
          errs.add('INVALID_DECIMAL', 'const value is not a plain decimal string', {
            ...at,
            field: 'value',
          });
          return { op: 'const', value: Qty.zero(unit) };
        }
        return { op: 'const', value };
      }
      case 'ref':
        return { op: 'ref', lineId: mustBeString(n.lineId, 'ref.lineId'), use: n.use };
      case 'add':
      case 'mul': {
        return { op: n.op, args: n.args.map(walk) };
      }
      case 'sub': {
        const [a, b] = n.args;
        return { op: 'sub', args: [walk(a), walk(b)] };
      }
      case 'round': {
        const scale: unknown = n.rule.scale;
        const mode: unknown = n.rule.mode;
        if (
          typeof scale !== 'number' ||
          !Number.isInteger(scale) ||
          scale < 0 ||
          scale > MAX_SCALE ||
          typeof mode !== 'string' ||
          !ROUNDING_MODES.includes(mode)
        ) {
          errs.add(
            'INVALID_ROUNDING_POLICY',
            'expression round rule must have an integer scale in 0..20 and a known mode',
            { ...at, field: 'rule' },
          );
          return { op: 'round', arg: walk(n.arg), rule: { scale: 0, mode: RoundingMode.HALF_UP } };
        }
        return { op: 'round', arg: walk(n.arg), rule: { scale, mode: mode as RoundingMode } };
      }
      default:
        throw new Error(
          `structurally invalid takeoff input: unknown expression op "${String((n as { op: unknown }).op)}"`,
        );
    }
  };
  const parsed = walk(node);
  return errs.count === before ? parsed : undefined;
}

/** V8 manual justification; the value itself is checked at resolution (V9). */
function validateManual(
  q: ManualQuantity,
  unit: UnitCode,
  errs: ErrorCollector,
  at: { sheetId: string; lineId: string },
): { readonly type: 'manual'; readonly value: Qty } | undefined {
  const value = parseDecimal(q.value, unit);
  if (value === undefined) {
    errs.add('INVALID_DECIMAL', 'manual value is not a plain decimal string', {
      ...at,
      field: 'value',
    });
    return undefined;
  }
  if (typeof q.justification !== 'string' || q.justification.trim().length === 0) {
    errs.add('MISSING_JUSTIFICATION', 'manual quantity requires a non-empty justification', {
      ...at,
      field: 'justification',
    });
    return undefined;
  }
  return { type: 'manual', value };
}

function validateQuantity(
  quantity: TakeoffQuantity,
  unit: UnitCode,
  errs: ErrorCollector,
  at: { sheetId: string; lineId: string },
): ParsedQuantity | undefined {
  switch (quantity.type) {
    case 'dimensional':
      return validateDimensional(quantity, unit, errs, at);
    case 'reference':
      return validateReference(quantity, errs, at);
    case 'expression': {
      const node = validateExpression(quantity.node, unit, errs, at);
      return node === undefined ? undefined : { type: 'expression', node };
    }
    case 'manual':
      return validateManual(quantity, unit, errs, at);
    default: {
      const unknownQuantity: unknown = quantity;
      throw new Error(
        `structurally invalid takeoff input: unknown quantity type "${String(
          (unknownQuantity as { type?: unknown }).type,
        )}"`,
      );
    }
  }
}

function validateLine(flat: FlatLine, errs: ErrorCollector): LineContext | undefined {
  const { line } = flat;
  const lineId = mustBeString(line.lineId, 'lineId');
  const at = { sheetId: flat.sheetId, lineId };
  const kind: unknown = line.kind;
  if (kind !== 'addition' && kind !== 'deduction') {
    throw new Error(`structurally invalid takeoff input: unknown kind "${String(kind)}"`);
  }
  let unit: UnitCode | undefined;
  if (typeof line.unit === 'string' && isUnitCode(line.unit)) {
    unit = line.unit;
  } else {
    errs.add('UNIT_MISMATCH', `line unit "${line.unit}" is not a unit code`, {
      ...at,
      field: 'unit',
    });
  }
  const quantity = validateQuantity(line.quantity, unit ?? 'each', errs, at);
  if (unit === undefined || quantity === undefined) return undefined;
  return { flat, unit, quantity, itemCode: line.itemCode ?? null };
}

/** V10 rule-set validation, in array order. */
function validateRuleSet(rounding: RoundingRuleSet, errs: ErrorCollector): void {
  for (const [index, entry] of rounding.entries()) {
    const at = { field: `rounding[${String(index)}]` };
    const target: unknown = entry.target;
    if (typeof target !== 'string' || !ROUNDING_TARGETS.includes(target)) {
      errs.add(
        'INVALID_ROUNDING_POLICY',
        'target must be "line", "reference-term", "item-total" or "sheet-total"',
        at,
      );
    }
    if (
      typeof entry.scale !== 'number' ||
      !Number.isInteger(entry.scale) ||
      entry.scale < 0 ||
      entry.scale > MAX_SCALE
    ) {
      errs.add(
        'INVALID_ROUNDING_POLICY',
        `scale must be an integer in 0..${String(MAX_SCALE)}`,
        at,
      );
    }
    if (typeof entry.mode !== 'string' || !ROUNDING_MODES.includes(entry.mode)) {
      errs.add('INVALID_ROUNDING_POLICY', 'unknown rounding mode', at);
    }
    if (typeof entry.sourceStatus !== 'string' || !SOURCE_STATUSES.includes(entry.sourceStatus)) {
      errs.add('INVALID_ROUNDING_POLICY', 'unknown sourceStatus', at);
    } else if (entry.sourceStatus === 'verified' && entry.source === undefined) {
      errs.add(
        'INVALID_ROUNDING_POLICY',
        'sourceStatus "verified" requires a source reference',
        at,
      );
    }
    const selector = entry.selector;
    if (
      selector !== undefined &&
      (entry.target === 'item-total' || entry.target === 'sheet-total') &&
      selector.lineIds !== undefined
    ) {
      errs.add(
        'INVALID_ROUNDING_POLICY',
        `a "lineIds" selector does not apply to target "${entry.target}"`,
        at,
      );
    }
  }
}

// -------------------------------------------------------------------------------------------------
// §5.3 references (V5, V7) and the dependency graph (V6)
// -------------------------------------------------------------------------------------------------

/** Referenced lineIds of a parsed quantity, in deterministic (declaration) order. */
function dependenciesOf(quantity: ParsedQuantity): string[] {
  const deps: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      deps.push(id);
    }
  };
  if (quantity.type === 'reference') {
    for (const term of quantity.terms) push(term.lineId);
  } else if (quantity.type === 'expression') {
    const walk = (n: ParsedNode): void => {
      if (n.op === 'ref') push(n.lineId);
      else if (n.op === 'add' || n.op === 'mul' || n.op === 'sub') n.args.forEach(walk);
      else if (n.op === 'round') walk(n.arg);
    };
    walk(quantity.node);
  }
  return deps;
}

function validateReferences(
  contexts: readonly LineContext[],
  byId: ReadonlyMap<string, LineContext>,
  errs: ErrorCollector,
): ReadonlyMap<string, readonly string[]> {
  const deps = new Map<string, readonly string[]>();
  for (const ctx of contexts) {
    const ids = dependenciesOf(ctx.quantity);
    const reported = new Set<string>();
    for (const target of ids) {
      const other = byId.get(target);
      if (other === undefined) {
        if (!reported.has(target)) {
          errs.add('UNKNOWN_REFERENCE', `referenced lineId "${target}" does not exist`, {
            sheetId: ctx.flat.sheetId,
            lineId: ctx.flat.line.lineId,
            field: 'quantity',
          });
          reported.add(target);
        }
        continue;
      }
      if (other.unit !== ctx.unit) {
        errs.add(
          'UNIT_MISMATCH',
          `reference target "${target}" has unit ${other.unit}, referencing line has ${ctx.unit}`,
          { sheetId: ctx.flat.sheetId, lineId: ctx.flat.line.lineId, field: 'quantity' },
        );
      }
    }
    deps.set(ctx.flat.line.lineId, ids);
  }
  return deps;
}

/** V6: DFS cycle detection; each unique cycle is reported once, lexicographically rotated. */
function detectCycles(
  contexts: readonly LineContext[],
  deps: ReadonlyMap<string, readonly string[]>,
  errs: ErrorCollector,
): void {
  const existing = new Set(contexts.map((c) => c.flat.line.lineId));
  const adj = new Map<string, readonly string[]>();
  for (const ctx of contexts) {
    const id = ctx.flat.line.lineId;
    adj.set(
      id,
      (deps.get(id) ?? []).filter((target) => existing.has(target)),
    );
  }
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const seenCycles = new Set<string>();
  const recordCycle = (path: readonly string[]): void => {
    const rotated = rotateToSmallest(path);
    const first = rotated[0];
    if (first === undefined) return;
    const key = rotated.join('\u{2192}');
    if (seenCycles.has(key)) return;
    seenCycles.add(key);
    errs.add('CIRCULAR_REFERENCE', `circular reference: ${rotated.join(' → ')} → ${first}`, {
      lineId: first,
      field: 'quantity',
    });
  };
  const visit = (id: string): void => {
    color.set(id, GREY);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) {
        const from = stack.lastIndexOf(next);
        if (from >= 0) recordCycle(stack.slice(from));
      } else if (c === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const ctx of contexts) {
    const id = ctx.flat.line.lineId;
    if ((color.get(id) ?? WHITE) === WHITE) visit(id);
  }
}

function rotateToSmallest(path: readonly string[]): string[] {
  let minIndex = 0;
  let minValue = path[0] ?? '';
  for (const [i, id] of path.entries()) {
    if (id < minValue) {
      minValue = id;
      minIndex = i;
    }
  }
  return [...path.slice(minIndex), ...path.slice(0, minIndex)];
}

/** V13: all lines sharing one itemCode declare the same unit; per group, first-appearance order. */
function validateAggregationUnits(contexts: readonly LineContext[], errs: ErrorCollector): void {
  const units = new Map<string, Set<UnitCode>>();
  const firstLine = new Map<string, string>();
  for (const ctx of contexts) {
    if (ctx.itemCode === null) continue;
    const set = units.get(ctx.itemCode) ?? new Set<UnitCode>();
    set.add(ctx.unit);
    units.set(ctx.itemCode, set);
    if (!firstLine.has(ctx.itemCode)) firstLine.set(ctx.itemCode, ctx.flat.line.lineId);
  }
  for (const [itemCode, set] of units) {
    if (set.size > 1) {
      const list = [...set].sort();
      errs.add(
        'AGGREGATION_UNIT_MISMATCH',
        `itemCode "${itemCode}" is used with incompatible units: ${list.join(', ')} (no unit conversion exists)`,
        { lineId: firstLine.get(itemCode), field: 'unit' },
      );
    }
  }
}

// -------------------------------------------------------------------------------------------------
// §6 rounding applicability (narrowest match wins; ties are errors)
// -------------------------------------------------------------------------------------------------

interface MatchContext {
  readonly lineId?: string;
  readonly itemCode: string | null;
  readonly unit: UnitCode;
}

/** `null` = no match; otherwise the selector's specificity score (see module doc). */
function selectorScore(entry: RoundingRuleEntry, ctx: MatchContext): number | null {
  const selector = entry.selector;
  if (selector === undefined) return 0;
  let score = 0;
  if (selector.lineIds !== undefined) {
    if (ctx.lineId === undefined || !selector.lineIds.includes(ctx.lineId)) return null;
    score += 4;
  }
  if (selector.itemCode !== undefined) {
    if (ctx.itemCode === null || ctx.itemCode !== selector.itemCode) return null;
    score += 2;
  }
  if (selector.unit !== undefined) {
    if (ctx.unit !== selector.unit) return null;
    score += 1;
  }
  return score;
}

interface RuleMatch {
  readonly rule: RoundingRuleEntry | undefined;
  readonly tie: boolean;
}

function matchRule(
  rounding: RoundingRuleSet,
  target: RoundingRuleEntry['target'],
  ctx: MatchContext,
): RuleMatch {
  let best: RoundingRuleEntry | undefined;
  let bestScore = -1;
  let tie = false;
  for (const entry of rounding) {
    if (entry.target !== target) continue;
    const score = selectorScore(entry, ctx);
    if (score === null) continue;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) {
      tie = true;
    }
  }
  return { rule: tie ? undefined : best, tie };
}

// -------------------------------------------------------------------------------------------------
// §7.2 resolution: topological order with `(sheet order, rowNo, lineId)` tie-breaks
// -------------------------------------------------------------------------------------------------

function topologicalOrder(
  contexts: readonly LineContext[],
  deps: ReadonlyMap<string, readonly string[]>,
): string[] {
  const byId = new Map(contexts.map((c) => [c.flat.line.lineId, c] as const));
  const sortKey = new Map<string, string>();
  for (const ctx of contexts) {
    const id = ctx.flat.line.lineId;
    sortKey.set(
      id,
      `${String(ctx.flat.sheetIndex).padStart(6, '0')} ${String(ctx.flat.line.rowNo).padStart(6, '0')} ${id}`,
    );
  }
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const ctx of contexts) {
    const id = ctx.flat.line.lineId;
    const ids = (deps.get(id) ?? []).filter((d) => byId.has(d) && d !== id);
    remaining.set(id, ids.length);
    for (const d of ids) {
      const list = dependents.get(d) ?? [];
      list.push(id);
      dependents.set(d, list);
    }
  }
  const order: string[] = [];
  while (remaining.size > 0) {
    const next = [...remaining.entries()]
      .filter(([, count]) => count === 0)
      .map(([id]) => id)
      .sort((a, b) => (sortKey.get(a) ?? a).localeCompare(sortKey.get(b) ?? b))[0];
    if (next === undefined) {
      throw new Error('structurally invalid takeoff input: unresolved cycle in dependency graph');
    }
    remaining.delete(next);
    order.push(next);
    for (const dependent of dependents.get(next) ?? []) {
      const count = remaining.get(dependent);
      if (count !== undefined) remaining.set(dependent, count - 1);
    }
  }
  return order;
}

// -------------------------------------------------------------------------------------------------
// §7.3 exact evaluation with §8 traces
// -------------------------------------------------------------------------------------------------

interface Evaluated {
  readonly exactMagnitude: Qty;
  readonly node: TakeoffTraceNode;
}

/**
 * Consumed value of a reference (§6: exact unless a `reference-term` rule rounds it).
 * A `reference-term` rule's selector picks the REFERENCING (consuming) line — the
 * matched rule rounds every term that line consumes (normative case IRM-006).
 */
function consumeReference(
  targetId: string,
  use: ReferenceUse,
  unit: UnitCode,
  exactSignedById: ReadonlyMap<string, Qty>,
  termRule: RoundingRuleEntry | undefined,
): { readonly value: Qty; readonly node: TakeoffTraceNode } {
  const signed = exactSignedById.get(targetId) ?? Qty.zero(unit);
  const exact = use === 'magnitude' ? (signed.isNegative() ? signed.negate() : signed) : signed;
  const rule = termRule;
  if (rule === undefined) {
    return {
      value: exact,
      node: {
        op: 'ref',
        lineId: targetId,
        value: exact.toString(),
        unit,
        ruleId: 'IR-MEAS/4.2',
        inputs: [],
      },
    };
  }
  const rounded = exact.round({ scale: rule.scale, mode: rule.mode });
  return {
    value: rounded,
    node: {
      op: 'round',
      value: rounded.toString(),
      unit,
      ruleId: 'IR-MEAS/6',
      rounding: { scale: rule.scale, mode: rule.mode },
      roundingRule: rule,
      inputs: [
        {
          op: 'ref',
          lineId: targetId,
          value: exact.toString(),
          unit,
          ruleId: 'IR-MEAS/4.2',
          inputs: [],
        },
      ],
    },
  };
}

function evaluateNode(
  node: ParsedNode,
  unit: UnitCode,
  exactSignedById: ReadonlyMap<string, Qty>,
  termRule: RoundingRuleEntry | undefined,
): { readonly value: Qty; readonly node: TakeoffTraceNode } {
  switch (node.op) {
    case 'const':
      return {
        value: node.value,
        node: {
          op: 'const',
          value: node.value.toString(),
          unit: null,
          ruleId: 'IR-MEAS/4.3',
          inputs: [],
        },
      };
    case 'ref':
      return consumeReference(node.lineId, node.use, unit, exactSignedById, termRule);
    case 'add':
    case 'mul': {
      const parts = node.args.map((arg) => evaluateNode(arg, unit, exactSignedById, termRule));
      const value = parts.reduce(
        (acc, part) => (node.op === 'add' ? acc.add(part.value) : acc.scale(part.value.toString())),
        node.op === 'add' ? Qty.zero(unit) : Qty.of('1', unit),
      );
      return {
        value,
        node: {
          op: node.op === 'add' ? 'sum' : 'multiply',
          value: value.toString(),
          unit,
          ruleId: 'IR-MEAS/4.3',
          inputs: parts.map((p) => p.node),
        },
      };
    }
    case 'sub': {
      const [a, b] = node.args;
      const left = evaluateNode(a, unit, exactSignedById, termRule);
      const right = evaluateNode(b, unit, exactSignedById, termRule);
      const value = left.value.subtract(right.value);
      return {
        value,
        node: {
          op: 'sub',
          value: value.toString(),
          unit,
          ruleId: 'IR-MEAS/4.3',
          inputs: [left.node, right.node],
        },
      };
    }
    case 'round': {
      const inner = evaluateNode(node.arg, unit, exactSignedById, termRule);
      const value = inner.value.round(node.rule);
      return {
        value,
        node: {
          op: 'round',
          value: value.toString(),
          unit,
          ruleId: 'IR-MEAS/4.3',
          rounding: node.rule,
          inputs: [inner.node],
        },
      };
    }
  }
}

function evaluateQuantity(
  ctx: LineContext,
  exactSignedById: ReadonlyMap<string, Qty>,
  refTermRule: ReadonlyMap<string, RoundingRuleEntry>,
): Evaluated {
  const { unit } = ctx;
  const q = ctx.quantity;
  /** §6/IRM-006: a reference-term rule matched for THIS line rounds the terms it consumes. */
  const termRule = refTermRule.get(ctx.flat.line.lineId);
  if (q.type === 'dimensional') {
    const exact = q.factors.reduce((acc, f) => acc.scale(f.value.toString()), Qty.of('1', unit));
    return {
      exactMagnitude: exact,
      node: {
        op: 'multiply',
        value: exact.toString(),
        unit,
        ruleId: 'IR-MEAS/4.1',
        inputs: q.factors.map((f) => ({
          op: 'input' as const,
          label: f.name,
          value: f.value.toString(),
          unit: f.name === 'floorCount' || f.name === 'similarCount' ? null : ('m' as const),
          ruleId: 'IR-MEAS/2.1',
          inputs: [],
        })),
      },
    };
  }
  if (q.type === 'manual') {
    return {
      exactMagnitude: q.value,
      node: { op: 'manual', value: q.value.toString(), unit, ruleId: 'IR-MEAS/4.4', inputs: [] },
    };
  }
  if (q.type === 'expression') {
    const evaluated = evaluateNode(q.node, unit, exactSignedById, termRule);
    return { exactMagnitude: evaluated.value, node: evaluated.node };
  }
  // reference (§4.2): Σ factorᵢ × refᵢ
  const terms = q.terms.map((term) => {
    const consumed = consumeReference(term.lineId, term.use, unit, exactSignedById, termRule);
    const value = consumed.value.scale(term.factor.toString());
    const node: TakeoffTraceNode = {
      op: 'multiply',
      label: 'term',
      value: value.toString(),
      unit,
      ruleId: 'IR-MEAS/4.2',
      inputs: [
        {
          op: 'input',
          label: 'factor',
          value: term.factor.toString(),
          unit: null,
          ruleId: 'IR-MEAS/4.2',
          inputs: [],
        },
        consumed.node,
      ],
    };
    return { value, node };
  });
  const exact = terms.reduce((acc, t) => acc.add(t.value), Qty.zero(unit));
  if (terms.length === 0) {
    return {
      exactMagnitude: exact,
      node: { op: 'const', value: exact.toString(), unit, ruleId: 'IR-MEAS/4.2', inputs: [] },
    };
  }
  const only = terms[0];
  if (terms.length === 1 && only !== undefined) {
    return { exactMagnitude: exact, node: only.node };
  }
  return {
    exactMagnitude: exact,
    node: {
      op: 'sum',
      value: exact.toString(),
      unit,
      ruleId: 'IR-MEAS/4.2',
      inputs: terms.map((t) => t.node),
    },
  };
}

// -------------------------------------------------------------------------------------------------
// §7.4 aggregation (always from EXACT values; one rounding at the target)
// -------------------------------------------------------------------------------------------------

interface Group {
  readonly itemCode: string | null;
  readonly unit: UnitCode;
  exact: Qty;
  readonly lineIds: string[];
}

interface ExactLine {
  readonly ctx: LineContext;
  readonly exactSigned: Qty;
}

function buildGroups(lines: readonly ExactLine[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const { ctx, exactSigned } of lines) {
    const key = `${ctx.itemCode ?? '\u0000'}\u0001${ctx.unit}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        itemCode: ctx.itemCode,
        unit: ctx.unit,
        exact: exactSigned,
        lineIds: [ctx.flat.line.lineId],
      });
    } else {
      group.exact = group.exact.add(exactSigned);
      group.lineIds.push(ctx.flat.line.lineId);
    }
  }
  return groups;
}

// -------------------------------------------------------------------------------------------------
// §8 result assembly
// -------------------------------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Computes a Full Takeoff (S1). Pure and deterministic (§7.5): identical canonical input
 * always yields a byte-identical canonical result; `rowNo` renumbering and sheet
 * reordering change no value. Atomic (§5): any error yields status "error" with empty
 * lines/totals and every detected error in input order. The input is never mutated; the
 * result is deeply frozen.
 */
export function calculateTakeoff(input: TakeoffCalculationInput): TakeoffResult {
  const errs = new ErrorCollector();
  const sheets = input.sheets;
  const rounding: RoundingRuleSet = (input as { rounding?: RoundingRuleSet }).rounding ?? [];

  // 1. static validation, in document input order
  const flats = flattenSheets(sheets);
  validateKeys(sheets, flats, errs);
  validateRuleSet(rounding, errs);
  const contexts: LineContext[] = [];
  for (const flat of flats) {
    const ctx = validateLine(flat, errs);
    if (ctx !== undefined) contexts.push(ctx);
  }
  const byId = new Map(contexts.map((c) => [c.flat.line.lineId, c] as const));
  const deps = validateReferences(contexts, byId, errs);
  detectCycles(contexts, deps, errs);
  validateAggregationUnits(contexts, errs);

  // 2. rule applicability (narrowest wins; ties are errors), in document order
  const lineRule = new Map<string, RoundingRuleEntry>();
  const refTermRule = new Map<string, RoundingRuleEntry>();
  for (const ctx of contexts) {
    const id = ctx.flat.line.lineId;
    const lineMatch = matchRule(rounding, 'line', {
      lineId: id,
      itemCode: ctx.itemCode,
      unit: ctx.unit,
    });
    if (lineMatch.tie) {
      errs.add('INVALID_ROUNDING_POLICY', `two "line" rules tie for line "${id}"`, {
        sheetId: ctx.flat.sheetId,
        lineId: id,
        field: 'rounding',
      });
    } else if (lineMatch.rule !== undefined) {
      lineRule.set(id, lineMatch.rule);
    }
    const refMatch = matchRule(rounding, 'reference-term', {
      lineId: id,
      itemCode: ctx.itemCode,
      unit: ctx.unit,
    });
    if (refMatch.tie) {
      errs.add('INVALID_ROUNDING_POLICY', `two "reference-term" rules tie for line "${id}"`, {
        sheetId: ctx.flat.sheetId,
        lineId: id,
        field: 'rounding',
      });
    } else if (refMatch.rule !== undefined) {
      refTermRule.set(id, refMatch.rule);
    }
  }

  // 3. exact evaluation in topological order
  const evaluated = new Map<string, Evaluated>();
  const exactSignedById = new Map<string, Qty>();
  if (errs.count === 0) {
    for (const id of topologicalOrder(contexts, deps)) {
      const ctx = byId.get(id);
      if (ctx === undefined) continue;
      const result = evaluateQuantity(ctx, exactSignedById, refTermRule);
      evaluated.set(id, result);
      exactSignedById.set(
        id,
        ctx.flat.line.kind === 'deduction' ? result.exactMagnitude.negate() : result.exactMagnitude,
      );
    }
  }

  // 4. per-line rounding, sign and result rows, in document order (V9 on exact magnitudes)
  const lineResults: TakeoffLineResult[] = [];
  for (const ctx of contexts) {
    const { flat } = ctx;
    const id = flat.line.lineId;
    const e = evaluated.get(id);
    if (e === undefined) continue;
    if (e.exactMagnitude.isNegative()) {
      errs.add(
        'NEGATIVE_LINE_MAGNITUDE',
        `resolved magnitude of line "${id}" is negative (${e.exactMagnitude.toString()})`,
        { sheetId: flat.sheetId, lineId: id, field: 'quantity' },
      );
    }
    const rule = lineRule.get(id);
    let magnitude = e.exactMagnitude;
    let node = e.node;
    let rounded: Qty | undefined;
    if (rule !== undefined) {
      rounded = e.exactMagnitude.round({ scale: rule.scale, mode: rule.mode });
      magnitude = rounded;
      node = {
        op: 'round',
        value: rounded.toString(),
        unit: ctx.unit,
        ruleId: 'IR-MEAS/6',
        rounding: { scale: rule.scale, mode: rule.mode },
        roundingRule: rule,
        inputs: [node],
      };
    }
    const deduction = flat.line.kind === 'deduction';
    const signed = deduction ? magnitude.negate() : magnitude;
    if (deduction) {
      node = {
        op: 'negate',
        value: signed.toString(),
        unit: ctx.unit,
        ruleId: 'IR-MEAS/4',
        inputs: [node],
      };
    }
    const ruleRefs = flat.line.ruleRefs;
    lineResults.push({
      lineId: id,
      sheetId: flat.sheetId,
      rowNo: flat.line.rowNo,
      itemCode: ctx.itemCode,
      unit: ctx.unit,
      kind: flat.line.kind,
      exactMagnitude: e.exactMagnitude.toString(),
      ...(rounded === undefined ? {} : { roundedMagnitude: rounded.toString() }),
      signedValue: signed.toString(),
      trace: {
        ...node,
        label: `line:${id}`,
        ...(ruleRefs === undefined || ruleRefs.length === 0
          ? {}
          : { measurementRuleIds: ruleRefs }),
      },
    });
  }

  // 5. aggregation from exact values; V11 on exact nets; one rounding per matching rule
  const exactLines: ExactLine[] = contexts.flatMap((ctx) => {
    const e = evaluated.get(ctx.flat.line.lineId);
    return e === undefined
      ? []
      : [
          {
            ctx,
            exactSigned:
              ctx.flat.line.kind === 'deduction' ? e.exactMagnitude.negate() : e.exactMagnitude,
          },
        ];
  });
  const itemTotals: TakeoffItemTotal[] = [];
  for (const group of buildGroups(exactLines).values()) {
    if (group.itemCode !== null && group.exact.isNegative()) {
      const first = group.lineIds[0];
      errs.add(
        'NEGATIVE_NET_QUANTITY',
        `exact net quantity for itemCode "${group.itemCode}" is negative (${group.exact.toString()})`,
        { ...(first === undefined ? {} : { lineId: first }), field: 'itemCode' },
      );
    }
    const match = matchRule(rounding, 'item-total', { itemCode: group.itemCode, unit: group.unit });
    if (match.tie) {
      errs.add(
        'INVALID_ROUNDING_POLICY',
        `two "item-total" rules tie for itemCode ${group.itemCode === null ? '(uncoded)' : `"${group.itemCode}"`} (${group.unit})`,
        { field: 'rounding' },
      );
    }
    const rule = match.tie ? undefined : match.rule;
    const rounded =
      rule === undefined ? undefined : group.exact.round({ scale: rule.scale, mode: rule.mode });
    itemTotals.push({
      itemCode: group.itemCode,
      unit: group.unit,
      exactQty: group.exact.toString(),
      ...(rounded === undefined ? {} : { roundedQty: rounded.toString() }),
      qty: (rounded ?? group.exact).toString(),
      lineIds: group.lineIds,
    });
  }

  const sheetTotals: TakeoffSheetTotal[] = [];
  for (const [sheetIndex, sheet] of sheets.entries()) {
    const sheetLines = exactLines.filter((l) => l.ctx.flat.sheetIndex === sheetIndex);
    const byItem: TakeoffSheetItemTotal[] = [];
    for (const group of buildGroups(sheetLines).values()) {
      const match = matchRule(rounding, 'sheet-total', {
        itemCode: group.itemCode,
        unit: group.unit,
      });
      if (match.tie) {
        errs.add(
          'INVALID_ROUNDING_POLICY',
          `two "sheet-total" rules tie for sheet "${sheet.sheetId}" itemCode ${group.itemCode === null ? '(uncoded)' : `"${group.itemCode}"`} (${group.unit})`,
          { sheetId: sheet.sheetId, field: 'rounding' },
        );
      }
      const rule = match.tie ? undefined : match.rule;
      const rounded =
        rule === undefined ? undefined : group.exact.round({ scale: rule.scale, mode: rule.mode });
      byItem.push({
        itemCode: group.itemCode,
        unit: group.unit,
        exactQty: group.exact.toString(),
        ...(rounded === undefined ? {} : { roundedQty: rounded.toString() }),
        qty: (rounded ?? group.exact).toString(),
        lineIds: group.lineIds,
      });
    }
    sheetTotals.push({ sheetId: sheet.sheetId, byItem });
  }

  // 6. canonical assembly (atomic: errors ⇒ no partial results)
  const ok = errs.count === 0;
  return deepFreeze({
    specId: 'CG-IR-MEAS' as const,
    specVersion: TAKEOFF_SPEC_VERSION,
    engineVersion: ENGINE_VERSION,
    status: ok ? ('ok' as const) : ('error' as const),
    errors: errs.errors,
    lines: ok ? lineResults : [],
    itemTotals: ok ? itemTotals : [],
    sheetTotals: ok ? sheetTotals : [],
  });
}
