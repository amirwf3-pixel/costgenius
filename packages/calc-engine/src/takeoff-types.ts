/**
 * Public D-016 Full Takeoff S1 contracts of CG-IR-MEAS@0.2.0 (§2, §4, §6, §8 of
 * CG-IR-MEASUREMENT-SPEC@0.2.0.md). Sibling of the frozen CG-RCS quantity contracts in
 * `types.ts`; item-master/pricing/estimation concerns (S2–S4) remain intentionally absent.
 */
import type { RoundingMode, RoundingRule, UnitCode } from '@costgenius/domain';
import type { DecimalString, LineKind } from './types.js';

/** How a reference consumes its target's resolved value (§4.2). */
export type ReferenceUse = 'signed' | 'magnitude';

/** §4.1 dimensional quantity: `value = floorCount × similarCount × Π(profile dimensions)`. */
export interface DimensionalQuantity {
  readonly type: 'dimensional';
  readonly profile: 'L' | 'LW' | 'LWH' | 'count';
  readonly similarCount?: DecimalString;
  readonly floorCount?: DecimalString;
  readonly length?: DecimalString;
  readonly width?: DecimalString;
  readonly height?: DecimalString;
}

/** §4.2 reference quantity: `value = Σ factorᵢ × refᵢ`. A negative factor is allowed. */
export interface ReferenceTerm {
  readonly lineId: string;
  readonly factor: DecimalString;
  readonly use: ReferenceUse;
}

export interface ReferenceQuantity {
  readonly type: 'reference';
  readonly terms: readonly ReferenceTerm[];
}

/**
 * §4.3 restricted expression tree. No division, powers, π or arbitrary functions
 * (Q-IR-4); the tree is the only representation — there is no text parser.
 */
export type ExpressionNode =
  | { readonly op: 'const'; readonly value: DecimalString }
  | { readonly op: 'ref'; readonly lineId: string; readonly use: ReferenceUse }
  | {
      readonly op: 'add' | 'mul';
      readonly args: readonly [ExpressionNode, ExpressionNode, ...ExpressionNode[]];
    }
  | { readonly op: 'sub'; readonly args: readonly [ExpressionNode, ExpressionNode] }
  | { readonly op: 'round'; readonly arg: ExpressionNode; readonly rule: RoundingRule };

export interface ExpressionQuantity {
  readonly type: 'expression';
  readonly node: ExpressionNode;
}

/** §4.4 manual quantity: directly entered, mandatory justification, audited like an override. */
export interface ManualQuantity {
  readonly type: 'manual';
  readonly value: DecimalString;
  readonly justification: string;
}

export type TakeoffQuantity =
  DimensionalQuantity | ReferenceQuantity | ExpressionQuantity | ManualQuantity;

export type TakeoffLineOrigin = 'user' | 'import' | 'ai-accepted';

/** §2 TakeoffLine. `lineId` is document-unique; references use it, never row numbers. */
export interface TakeoffLineInput {
  readonly lineId: string;
  readonly rowNo: number;
  readonly description: string;
  readonly location?: string;
  /** Opaque price-book/Item-Master code; never interpreted in S1 (V12). */
  readonly itemCode?: string | null;
  readonly kind: LineKind;
  readonly unit: string;
  readonly quantity: TakeoffQuantity;
  readonly notes?: string;
  readonly origin?: TakeoffLineOrigin;
  /** Advisory MeasurementRule ids the estimator claims to apply (§9); echoed in the trace. */
  readonly ruleRefs?: readonly string[];
}

/** §2 TakeoffSheet. `sheetId` is unique in the document; sheet order is presentation only. */
export interface TakeoffSheetInput {
  readonly sheetId: string;
  readonly name: string;
  readonly lines: readonly TakeoffLineInput[];
}

/** §6 rounding targets — exactly the 0.2.0 set; there is no document-level target. */
export type RoundingTarget = 'line' | 'reference-term' | 'item-total' | 'sheet-total';

/** §6 selector: narrowest match wins; ties are errors. Fields AND-combine when present. */
export interface RoundingSelector {
  readonly itemCode?: string;
  readonly unit?: string;
  readonly lineIds?: readonly string[];
}

export type RoundingSourceStatus = 'design' | 'organization-policy' | 'verified' | 'unverified';

/** §0/§9 source reference. `source` is required when `sourceStatus` is `"verified"`. */
export interface SourceRef {
  readonly sourceDocument: string | null;
  readonly edition: string | null;
  readonly page: string | null;
  readonly section: string | null;
  readonly sourceFileHash?: string;
}

export interface RoundingRuleEntry {
  readonly target: RoundingTarget;
  readonly selector?: RoundingSelector;
  readonly scale: number;
  readonly mode: RoundingMode;
  readonly sourceStatus: RoundingSourceStatus;
  readonly source?: SourceRef;
}

/** §6: explicit rule set; may be empty. No rule ⇒ no rounding; there is no default. */
export type RoundingRuleSet = readonly RoundingRuleEntry[];

/**
 * Engine input: the computational content of a TakeoffDocument (§2) — sheets plus the
 * document-level rounding rule set. Document metadata (ids, title, project) belongs to
 * the product layer (CG-FT-TAKEOFF-SPEC) and is not an engine concern.
 */
export interface TakeoffCalculationInput {
  readonly sheets: readonly TakeoffSheetInput[];
  readonly rounding: RoundingRuleSet;
}

export type TakeoffErrorCode =
  | 'DUPLICATE_KEY'
  | 'INVALID_DECIMAL'
  | 'NON_INTEGER_COUNT'
  | 'NEGATIVE_INPUT'
  | 'DIMENSION_PROFILE_MISMATCH'
  | 'UNKNOWN_REFERENCE'
  | 'CIRCULAR_REFERENCE'
  | 'UNIT_MISMATCH'
  | 'MISSING_JUSTIFICATION'
  | 'NEGATIVE_LINE_MAGNITUDE'
  | 'INVALID_ROUNDING_POLICY'
  | 'NEGATIVE_NET_QUANTITY'
  | 'AGGREGATION_UNIT_MISMATCH';

/** §5 error; collected in input order, atomic — no partial result is ever returned. */
export interface TakeoffError {
  readonly code: TakeoffErrorCode;
  readonly message: string;
  readonly sheetId?: string;
  readonly lineId?: string;
  readonly field?: string;
}

/**
 * §8 TraceNode, extending the CG-RCS trace with `ref` (referenced line's value shared by
 * `lineId`, never a duplicated sub-trace), `sub`, `const`, `manual`, and the count-factor
 * labels `floorCount`/`similarCount`. Every node carries a `ruleId` spec anchor.
 */
export interface TakeoffTraceNode {
  readonly op:
    'input' | 'multiply' | 'negate' | 'sum' | 'round' | 'ref' | 'sub' | 'const' | 'manual';
  readonly label?: string;
  readonly value: DecimalString;
  readonly unit: UnitCode | null;
  readonly ruleId: string;
  /** The rounding instruction of a `round` node (`{scale, mode}`). */
  readonly rounding?: RoundingRule;
  /** The full rule-set entry, when the rounding came from a §6 rule (provenance). */
  readonly roundingRule?: RoundingRuleEntry;
  /** `op: "ref"` only: the referenced line; its full trace is shared by id, not embedded. */
  readonly lineId?: string;
  readonly inputs: readonly TakeoffTraceNode[];
  /** Claimed MeasurementRule ids (§9), echoed on the line's root node only. */
  readonly measurementRuleIds?: readonly string[];
}

/** §8 per-line result. `signedValue` applies the sign from `kind` after any line rounding. */
export interface TakeoffLineResult {
  readonly lineId: string;
  readonly sheetId: string;
  readonly rowNo: number;
  readonly itemCode: string | null;
  readonly unit: UnitCode;
  readonly kind: LineKind;
  readonly exactMagnitude: DecimalString;
  readonly roundedMagnitude?: DecimalString;
  readonly signedValue: DecimalString;
  readonly trace: TakeoffTraceNode;
}

/** §8 itemTotal: aggregated per `itemCode` (uncoded lines: per unit under `null`), from EXACT values. */
export interface TakeoffItemTotal {
  readonly itemCode: string | null;
  readonly unit: UnitCode;
  readonly exactQty: DecimalString;
  readonly roundedQty?: DecimalString;
  /** Effective value: `roundedQty` when a rule produced one, otherwise `exactQty`. */
  readonly qty: DecimalString;
  readonly lineIds: readonly string[];
}

/** §8 sheet subtotal: per `(sheet, itemCode)` (uncoded: per unit under `null`), from EXACT values. */
export interface TakeoffSheetItemTotal {
  readonly itemCode: string | null;
  readonly unit: UnitCode;
  readonly exactQty: DecimalString;
  readonly roundedQty?: DecimalString;
  readonly qty: DecimalString;
  readonly lineIds: readonly string[];
}

export interface TakeoffSheetTotal {
  readonly sheetId: string;
  readonly byItem: readonly TakeoffSheetItemTotal[];
}

/** §8 TakeoffResult. */
export interface TakeoffResult {
  readonly specId: 'CG-IR-MEAS';
  readonly specVersion: string;
  readonly engineVersion: string;
  readonly status: 'ok' | 'error';
  readonly errors: readonly TakeoffError[];
  readonly lines: readonly TakeoffLineResult[];
  readonly itemTotals: readonly TakeoffItemTotal[];
  readonly sheetTotals: readonly TakeoffSheetTotal[];
}
