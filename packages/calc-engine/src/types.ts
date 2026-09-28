/**
 * Public S1 (quantity) contracts of CG-RCS@0.1.0 (REFERENCE_CALCULATION_SPEC.md §4, §5, §7, §8).
 * S2 item mapping, S3 pricing and S4 estimation are intentionally absent.
 */
import type { RoundingMode, UnitCode } from '@costgenius/domain';

/** Canonical decimal string, `^-?\d+(\.\d+)?$` (spec §3). */
export type DecimalString = string;

/** Units accepted by the S1 quantity stage (spec §4.1). */
export type QuantityUnit = 'm' | 'm2' | 'm3' | 'each';

export type RoundingStage = 'line' | 'item';

export interface RoundingPolicy {
  readonly stage: RoundingStage;
  readonly scale: number;
  readonly mode: RoundingMode;
}

export type LineKind = 'addition' | 'deduction';

export interface QuantityLineInput {
  readonly lineKey: string;
  readonly kind: LineKind;
  readonly unit: string;
  readonly count: DecimalString;
  readonly length?: DecimalString;
  readonly width?: DecimalString;
  readonly height?: DecimalString;
  /** Free-text reference; carried by callers, not interpreted by the engine. */
  readonly location?: string;
  /** Not interpreted by the engine. */
  readonly note?: string;
}

export interface QuantityItemInput {
  readonly itemKey: string;
  readonly unit: string;
  readonly rounding?: RoundingPolicy;
  readonly lines: readonly QuantityLineInput[];
}

export interface QuantityCalculationInput {
  readonly items: readonly QuantityItemInput[];
}

export type CalculationErrorCode =
  | 'INVALID_DECIMAL'
  | 'NEGATIVE_INPUT'
  | 'NON_INTEGER_COUNT'
  | 'DIMENSION_UNIT_MISMATCH'
  | 'UNIT_MISMATCH'
  | 'NEGATIVE_NET_QUANTITY'
  | 'EMPTY_ITEM'
  | 'DUPLICATE_KEY'
  | 'INVALID_ROUNDING_POLICY';

export interface CalculationError {
  readonly code: CalculationErrorCode;
  readonly itemKey: string;
  readonly lineKey?: string;
  readonly field?: string;
  readonly message: string;
}

export type FactorName = 'count' | 'length' | 'width' | 'height';

export interface QuantityLineResult {
  readonly lineKey: string;
  readonly kind: LineKind;
  readonly unit: QuantityUnit;
  readonly factors: readonly { readonly name: FactorName; readonly value: DecimalString }[];
  readonly exactQty: DecimalString;
  readonly roundedQty?: DecimalString;
  readonly signedQty: DecimalString;
}

export type TraceOp = 'input' | 'multiply' | 'negate' | 'sum' | 'round';

export interface TraceRef {
  readonly itemKey: string;
  readonly lineKey?: string;
  readonly field?: string;
}

export interface TraceNode {
  readonly op: TraceOp;
  readonly label: string;
  readonly value: DecimalString;
  readonly unit: UnitCode | null;
  readonly rule?: string;
  readonly rounding?: RoundingPolicy;
  readonly inputs: readonly TraceNode[];
  readonly ref?: TraceRef;
}

export interface QuantityItemResult {
  readonly itemKey: string;
  readonly unit: QuantityUnit;
  readonly exactQty: DecimalString;
  readonly roundedQty?: DecimalString;
  readonly qty: DecimalString;
  readonly lines: readonly QuantityLineResult[];
  readonly trace: TraceNode;
}

export interface QuantityCalculationResult {
  readonly specVersion: string;
  readonly engineVersion: string;
  readonly status: 'ok' | 'error';
  readonly items: readonly QuantityItemResult[];
  readonly errors: readonly CalculationError[];
}
