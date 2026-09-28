/**
 * S1 quantity stage of CG-RCS@0.1.0. Pure: no I/O, clock or randomness; exact decimal arithmetic via
 * @costgenius/domain `Qty`. Implements rules R1–R9 and the rounding policy of spec §5, nothing more.
 */
import { Qty, RoundingMode, type UnitCode } from '@costgenius/domain';
import type {
  CalculationError,
  CalculationErrorCode,
  FactorName,
  QuantityCalculationInput,
  QuantityCalculationResult,
  QuantityItemInput,
  QuantityItemResult,
  QuantityLineInput,
  QuantityLineResult,
  QuantityUnit,
  RoundingPolicy,
  TraceNode,
} from './types.js';
import { ENGINE_VERSION, SPEC_VERSION } from './version.js';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const MAX_SCALE = 20;
const DIMENSIONS = ['length', 'width', 'height'] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** R1: required dimensions per unit, in fixed order. */
const REQUIRED_DIMENSIONS: Readonly<Record<QuantityUnit, readonly Dimension[]>> = {
  each: [],
  m: ['length'],
  m2: ['length', 'width'],
  m3: ['length', 'width', 'height'],
};
const QUANTITY_UNITS = Object.keys(REQUIRED_DIMENSIONS) as readonly QuantityUnit[];
const ROUNDING_MODES: readonly string[] = Object.values(RoundingMode);

const isQuantityUnit = (u: unknown): u is QuantityUnit =>
  typeof u === 'string' && (QUANTITY_UNITS as readonly string[]).includes(u);

/** Parses a spec §3 decimal string into a Qty carrier; `undefined` if malformed. */
function parseDecimal(value: unknown, unit: UnitCode): Qty | undefined {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return undefined;
  return Qty.of(value, unit);
}

class ErrorCollector {
  /** Each error tagged with the input position of its item (authoritative ordering key). */
  readonly entries: { itemIndex: number; error: CalculationError }[] = [];
  itemIndex = 0;

  get count(): number {
    return this.entries.length;
  }

  add(
    code: CalculationErrorCode,
    itemKey: string,
    message: string,
    at: { lineKey?: string; field?: string } = {},
  ): void {
    this.entries.push({ itemIndex: this.itemIndex, error: { code, itemKey, ...at, message } });
  }
}

interface ValidLine {
  readonly input: QuantityLineInput;
  readonly unit: QuantityUnit;
  readonly factors: readonly { readonly name: FactorName; readonly value: Qty }[];
}

/**
 * Validates one line. Error order within a line is fixed: R4 unit, R1 dimensionality,
 * then per field (count, length, width, height): decimal format, sign, integer count.
 */
function validateLine(
  line: QuantityLineInput,
  itemKey: string,
  itemUnit: QuantityUnit | undefined,
  errs: ErrorCollector,
): ValidLine | undefined {
  const before = errs.count;
  const lineKey = line.lineKey;
  const lineUnit: unknown = line.unit;

  if (itemUnit !== undefined && lineUnit !== itemUnit) {
    errs.add(
      'UNIT_MISMATCH',
      itemKey,
      `line unit "${String(lineUnit)}" ≠ item unit "${itemUnit}"`,
      {
        lineKey,
        field: 'unit',
      },
    );
  }
  const unit = isQuantityUnit(lineUnit) ? lineUnit : undefined;
  if (unit !== undefined) {
    const required = REQUIRED_DIMENSIONS[unit];
    const offending = DIMENSIONS.find((d) => (line[d] !== undefined) !== required.includes(d));
    if (offending !== undefined) {
      errs.add(
        'DIMENSION_UNIT_MISMATCH',
        itemKey,
        `unit ${unit} requires exactly [${required.join(', ')}]; "${offending}" is ${line[offending] === undefined ? 'missing' : 'not allowed'}`,
        { lineKey, field: offending },
      );
    }
  } else if (itemUnit === undefined) {
    errs.add('UNIT_MISMATCH', itemKey, `line unit "${String(lineUnit)}" is not a quantity unit`, {
      lineKey,
      field: 'unit',
    });
  }

  const factors: { name: FactorName; value: Qty }[] = [];
  for (const name of ['count', ...DIMENSIONS] as const) {
    const raw: unknown = line[name];
    if (raw === undefined && name !== 'count') continue;
    const value = parseDecimal(raw, 'each');
    if (value === undefined) {
      errs.add('INVALID_DECIMAL', itemKey, `${name} is not a plain decimal string`, {
        lineKey,
        field: name,
      });
      continue;
    }
    if (value.isNegative()) {
      errs.add('NEGATIVE_INPUT', itemKey, `${name} must be ≥ 0; use kind "deduction"`, {
        lineKey,
        field: name,
      });
      continue;
    }
    if (name === 'count' && !value.equals(value.round({ scale: 0, mode: RoundingMode.DOWN }))) {
      errs.add('NON_INTEGER_COUNT', itemKey, 'count must be an integer', { lineKey, field: name });
      continue;
    }
    factors.push({ name, value });
  }

  if (errs.count > before || unit === undefined) return undefined;
  return { input: line, unit, factors };
}

function validateRounding(
  policy: RoundingPolicy | undefined,
  itemKey: string,
  errs: ErrorCollector,
): void {
  if (policy === undefined) return;
  const p = policy as unknown as Record<string, unknown>;
  if (p['stage'] !== 'line' && p['stage'] !== 'item') {
    errs.add('INVALID_ROUNDING_POLICY', itemKey, 'stage must be "line" or "item"', {
      field: 'rounding.stage',
    });
  }
  const scale = p['scale'];
  if (typeof scale !== 'number' || !Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    errs.add(
      'INVALID_ROUNDING_POLICY',
      itemKey,
      `scale must be an integer in 0..${String(MAX_SCALE)}`,
      {
        field: 'rounding.scale',
      },
    );
  }
  if (typeof p['mode'] !== 'string' || !ROUNDING_MODES.includes(p['mode'])) {
    errs.add('INVALID_ROUNDING_POLICY', itemKey, 'unknown rounding mode', {
      field: 'rounding.mode',
    });
  }
}

function inputNode(name: FactorName, value: Qty, itemKey: string, lineKey: string): TraceNode {
  return {
    op: 'input',
    label: name,
    value: value.toString(),
    unit: name === 'count' ? null : 'm',
    inputs: [],
    ref: { itemKey, lineKey, field: name },
  };
}

/** Attaches the line/item ref to the outermost node of a chain (spec §8). */
function withRef(node: TraceNode, ref: TraceNode['ref']): TraceNode {
  return ref === undefined ? node : { ...node, ref };
}

function computeLine(
  v: ValidLine,
  itemKey: string,
  policy: RoundingPolicy | undefined,
): { result: QuantityLineResult; exactSigned: Qty; contribution: Qty; trace: TraceNode } {
  const { input, unit, factors } = v;
  const label = `line:${input.lineKey}`;
  // R2: count × Π(dimensions), exact.
  const exact = factors.reduce((acc, f) => acc.scale(f.value.toString()), Qty.of('1', unit));
  let node: TraceNode = {
    op: 'multiply',
    label,
    value: exact.toString(),
    unit,
    rule: 'R2',
    inputs: factors.map((f) => inputNode(f.name, f.value, itemKey, input.lineKey)),
  };

  // §5 stage "line": round the magnitude, before the sign is applied.
  let rounded: Qty | undefined;
  if (policy?.stage === 'line') {
    rounded = exact.round({ scale: policy.scale, mode: policy.mode });
    node = {
      op: 'round',
      label,
      value: rounded.toString(),
      unit,
      rule: 'RND',
      rounding: policy,
      inputs: [node],
    };
  }

  // R3: sign from kind.
  const magnitude = rounded ?? exact;
  const deduction = input.kind === 'deduction';
  const contribution = deduction ? magnitude.negate() : magnitude;
  if (deduction) {
    node = {
      op: 'negate',
      label,
      value: contribution.toString(),
      unit,
      rule: 'R3',
      inputs: [node],
    };
  }

  return {
    result: {
      lineKey: input.lineKey,
      kind: input.kind,
      unit,
      factors: factors.map((f) => ({ name: f.name, value: f.value.toString() })),
      exactQty: exact.toString(),
      ...(rounded === undefined ? {} : { roundedQty: rounded.toString() }),
      signedQty: contribution.toString(),
    },
    exactSigned: deduction ? exact.negate() : exact,
    contribution,
    trace: withRef(node, { itemKey, lineKey: input.lineKey }),
  };
}

function computeItem(
  item: QuantityItemInput,
  unit: QuantityUnit,
  lines: readonly ValidLine[],
): QuantityItemResult {
  const policy = item.rounding;
  const computed = lines.map((l) => computeLine(l, item.itemKey, policy));
  // R5: exact, order-independent sums.
  const exactQty = Qty.sum(
    computed.map((c) => c.exactSigned),
    unit,
  );
  const contributionSum = Qty.sum(
    computed.map((c) => c.contribution),
    unit,
  );
  const label = `item:${item.itemKey}`;
  let trace: TraceNode = {
    op: 'sum',
    label,
    value: contributionSum.toString(),
    unit,
    rule: 'R5',
    inputs: computed.map((c) => c.trace),
  };

  let roundedQty: Qty | undefined;
  if (policy?.stage === 'line') {
    roundedQty = contributionSum; // Σ rounded lines; not re-rounded.
  } else if (policy?.stage === 'item') {
    roundedQty = exactQty.round({ scale: policy.scale, mode: policy.mode });
    trace = {
      op: 'round',
      label,
      value: roundedQty.toString(),
      unit,
      rule: 'RND',
      rounding: policy,
      inputs: [trace],
    };
  }

  return {
    itemKey: item.itemKey,
    unit,
    exactQty: exactQty.toString(),
    ...(roundedQty === undefined ? {} : { roundedQty: roundedQty.toString() }),
    qty: (roundedQty ?? exactQty).toString(),
    lines: computed.map((c) => c.result),
    trace: withRef(trace, { itemKey: item.itemKey }),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Computes S1 quantities. Pure and deterministic (R9): the same input always yields a result
 * with identical canonical JSON. Atomic (R8): any error yields status "error" with no items and
 * every detected error in input order. The input is never mutated; the result is deeply frozen.
 */
export function calculateQuantities(input: QuantityCalculationInput): QuantityCalculationResult {
  const errs = new ErrorCollector();
  const seenItems = new Set<string>();
  const ready: {
    itemIndex: number;
    item: QuantityItemInput;
    unit: QuantityUnit;
    lines: ValidLine[];
  }[] = [];

  for (const [itemIndex, item] of input.items.entries()) {
    errs.itemIndex = itemIndex;
    const before = errs.count;
    const itemKey = item.itemKey;

    if (seenItems.has(itemKey)) {
      errs.add('DUPLICATE_KEY', itemKey, `duplicate itemKey "${itemKey}"`, { field: 'itemKey' });
    }
    seenItems.add(itemKey);

    const itemUnit: unknown = item.unit;
    const unit = isQuantityUnit(itemUnit) ? itemUnit : undefined;
    if (unit === undefined) {
      errs.add(
        'UNIT_MISMATCH',
        itemKey,
        `item unit "${String(itemUnit)}" is not an S1 quantity unit`,
        {
          field: 'unit',
        },
      );
    }
    validateRounding(item.rounding, itemKey, errs);
    if (item.lines.length === 0) errs.add('EMPTY_ITEM', itemKey, 'item has no lines');

    const seenLines = new Set<string>();
    const valid: ValidLine[] = [];
    for (const line of item.lines) {
      if (seenLines.has(line.lineKey)) {
        errs.add('DUPLICATE_KEY', itemKey, `duplicate lineKey "${line.lineKey}"`, {
          lineKey: line.lineKey,
          field: 'lineKey',
        });
      }
      seenLines.add(line.lineKey);
      const v = validateLine(line, itemKey, unit, errs);
      if (v !== undefined) valid.push(v);
    }

    if (errs.count > before || unit === undefined) continue;
    ready.push({ itemIndex, item, unit, lines: valid });
  }

  // R6 is checked against the EXACT, unrounded net quantity, before any rounding is relied on:
  // an exact negative net can never become valid because rounding would yield zero.
  const items: QuantityItemResult[] = [];
  for (const r of ready) {
    const result = computeItem(r.item, r.unit, r.lines);
    if (result.exactQty.startsWith('-')) {
      errs.itemIndex = r.itemIndex;
      errs.add(
        'NEGATIVE_NET_QUANTITY',
        r.item.itemKey,
        `exact net quantity ${result.exactQty} is negative`,
      );
      continue;
    }
    items.push(result);
  }
  // Order = item input position, then detection order within that item. Positional (not keyed by
  // itemKey), so it stays deterministic when itemKeys are duplicated. Array.prototype.sort is stable.
  const errors = errs.entries
    .map((e, seq) => ({ ...e, seq }))
    .sort((a, b) => a.itemIndex - b.itemIndex || a.seq - b.seq)
    .map((e) => e.error);

  const ok = errors.length === 0;
  return deepFreeze({
    specVersion: SPEC_VERSION,
    engineVersion: ENGINE_VERSION,
    status: ok ? 'ok' : 'error',
    items: ok ? items : [],
    errors,
  });
}
