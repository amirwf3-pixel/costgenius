/**
 * S2 — BOQ / pricebook row binding.
 *
 * Identity is the exact printed pricebook code string; lookups go through the published
 * dataset only. There is deliberately no fuzzy matching, no nearest-code substitution, no
 * prefix handling and no numeric coercion: "070612" never becomes "70612", and an unknown
 * code is a controlled PRICEBOOK_ROW_NOT_FOUND result. The BOQ quantity unit must equal the
 * row's UnitCode exactly — no conversion, so ton-kilometres, ton-nautical-miles and
 * square-metre-months are never collapsed into t or m2. The row's verification status and
 * external dependencies survive the binding unchanged.
 */
import { DomainError, Qty, type UnitCode } from '@costgenius/domain';
import type {
  PricebookRow,
  PricebookStatus,
  PublishedDataset,
  SourceReference,
} from '@costgenius/pricebook';

export interface BoqLineInput {
  readonly lineId: string;
  /** Exact printed pricebook code (string identity, leading zeros preserved). */
  readonly code: string;
  /** Exact decimal string; deductions are negative. */
  readonly quantity: string;
  readonly unit: string;
}

export type S2ErrorCode =
  'PRICEBOOK_ROW_NOT_FOUND' | 'UNIT_MISMATCH' | 'INVALID_DECIMAL' | 'UNKNOWN_UNIT';

export interface S2Error {
  readonly code: S2ErrorCode;
  readonly lineId: string;
  readonly message: string;
}

export interface BoundBoqLine {
  readonly lineId: string;
  readonly pricebookRow: PricebookRow;
  readonly quantity: string;
  readonly unit: UnitCode;
  readonly status: PricebookStatus;
  readonly sourceRef: SourceReference;
  readonly externalDependencies: readonly string[];
}

export type S2BindingResult =
  | { readonly ok: true; readonly line: BoundBoqLine }
  | { readonly ok: false; readonly errors: readonly S2Error[] };

/** Binds one BOQ line to a published pricebook row by exact code, with unit checking. */
export function bindBoqLine(dataset: PublishedDataset, input: BoqLineInput): S2BindingResult {
  const errors: S2Error[] = [];

  let quantity: Qty | undefined;
  try {
    quantity = Qty.of(input.quantity, input.unit);
  } catch (error) {
    if (error instanceof DomainError) {
      errors.push({
        code: error.code === 'UNKNOWN_UNIT' ? 'UNKNOWN_UNIT' : 'INVALID_DECIMAL',
        lineId: input.lineId,
        message: error.message,
      });
    } else {
      throw error;
    }
  }

  const row = dataset.getRow(input.code);
  if (row === undefined) {
    errors.push({
      code: 'PRICEBOOK_ROW_NOT_FOUND',
      lineId: input.lineId,
      message: `no published pricebook row with code "${input.code}"; no substitution is made`,
    });
  }

  if (quantity !== undefined && row !== undefined && row.unit.code !== quantity.unit) {
    errors.push({
      code: 'UNIT_MISMATCH',
      lineId: input.lineId,
      message: `BOQ quantity is in ${quantity.unit} but row ${row.code} is priced per ${row.unit.code} (printed unit "${row.unit.label}"); no conversion is applied`,
    });
  }

  if (errors.length > 0 || quantity === undefined || row === undefined) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    line: {
      lineId: input.lineId,
      pricebookRow: row,
      quantity: input.quantity,
      unit: quantity.unit,
      status: row.status,
      sourceRef: row.sourceRef,
      externalDependencies: row.externalDependencies,
    },
  };
}

/** Binds a list of BOQ lines; each binding is independent and order is preserved. */
export function bindBoqLines(
  dataset: PublishedDataset,
  inputs: readonly BoqLineInput[],
): readonly S2BindingResult[] {
  return inputs.map((input) => bindBoqLine(dataset, input));
}
