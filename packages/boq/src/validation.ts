/**
 * Structural and consistency validation of BOQ lines and versions.
 *
 * Validation is complete (every violation is reported) and never repairs anything: a code
 * is never normalised, a missing unit never defaulted, an incomplete line never presented
 * as complete. The unknown-code rejection itself lives upstream in S2
 * (PRICEBOOK_ROW_NOT_FOUND) — a BOQ line can only exist for a code S2 bound successfully.
 */
import { isUnitCode } from '@costgenius/domain';
import { PRICE_DECIMAL_PATTERN, sourceReferenceErrors } from '@costgenius/pricebook';
import type { BoqLine } from './boq-line.js';

export interface BoqLineValidationError {
  readonly lineId: string;
  readonly field: string;
  readonly message: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Validates one BOQ line record (unknown input; every field checked). */
export function validateBoqLine(line: unknown): BoqLineValidationError[] {
  const errors: BoqLineValidationError[] = [];
  if (typeof line !== 'object' || line === null) {
    return [{ lineId: '<missing>', field: 'line', message: 'line must be an object' }];
  }
  const l = line as Record<string, unknown>;

  if (!isNonEmptyString(l['lineId'])) {
    return [{ lineId: '<missing>', field: 'lineId', message: 'lineId must be a non-empty string' }];
  }
  const lineId = l['lineId'];
  const add = (field: string, message: string): void => {
    errors.push({ lineId, field, message });
  };

  for (const field of ['pricebookCode', 'chapter', 'group', 'description', 'edition'] as const) {
    if (!isNonEmptyString(l[field])) {
      add(field, `${field} must be a non-empty string`);
    }
  }

  const unit = l['unit'];
  if (typeof unit !== 'object' || unit === null) {
    add('unit', 'unit must be an object with label and code');
  } else {
    const u = unit as Record<string, unknown>;
    if (!isNonEmptyString(u['label'])) {
      add('unit.label', 'unit.label must be a non-empty string (printed label, verbatim)');
    }
    if (typeof u['code'] !== 'string' || !isUnitCode(u['code'])) {
      add('unit.code', 'unit.code must be a domain UnitCode');
    }
  }

  const quantity = l['quantity'];
  if (typeof quantity !== 'string' || !PRICE_DECIMAL_PATTERN.test(quantity)) {
    add(
      'quantity',
      'quantity must be an exact decimal string (deductions are negative; zero is allowed)',
    );
  }

  const basePrice = l['basePrice'];
  if (
    basePrice !== null &&
    (typeof basePrice !== 'string' || !PRICE_DECIMAL_PATTERN.test(basePrice))
  ) {
    add('basePrice', 'basePrice must be null or an exact decimal string');
  }

  const lineAmount = l['lineAmount'];
  if (
    lineAmount !== null &&
    (typeof lineAmount !== 'string' || !PRICE_DECIMAL_PATTERN.test(lineAmount))
  ) {
    add('lineAmount', 'lineAmount must be null or an exact decimal string');
  }

  const calculationStatus = l['calculationStatus'];
  const pricebookStatus = l['pricebookStatus'];
  if (calculationStatus === 'COMPLETE') {
    if (lineAmount === null) {
      add('calculationStatus', 'a COMPLETE line must carry a lineAmount');
    }
    if (pricebookStatus !== 'VERIFIED_SPEC_ONLY') {
      add(
        'calculationStatus',
        'only a VERIFIED_SPEC_ONLY row can produce a COMPLETE line; incomplete/external/unspecified rows never become complete',
      );
    }
  } else if (lineAmount !== null) {
    add(
      'calculationStatus',
      'a non-COMPLETE line must not carry a lineAmount (pending never looks priced)',
    );
  }

  const trace = l['trace'];
  if (typeof trace !== 'object' || trace === null) {
    add('trace', 'trace must be an object');
  } else {
    const t = trace as Record<string, unknown>;
    if (
      t['quantity'] !== quantity ||
      t['lineAmount'] !== lineAmount ||
      t['unitPrice'] !== basePrice
    ) {
      add('trace', 'trace must repeat quantity, unitPrice and lineAmount exactly');
    }
  }

  const dependencies = l['externalDependencies'];
  if (dependencies !== undefined && !Array.isArray(dependencies)) {
    add('externalDependencies', 'externalDependencies must be an array of strings');
  }

  for (const error of sourceReferenceErrors(l['sourceRef'])) {
    add('sourceRef', error);
  }

  return errors;
}

export interface BoqVersionValidationError {
  readonly versionId: string;
  readonly message: string;
}

/** Validates a version: per-line validation plus duplicate lineId detection. */
export function validateBoqLines(lines: readonly BoqLine[]): BoqVersionValidationError[] {
  const errors: BoqVersionValidationError[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    for (const error of validateBoqLine(line)) {
      errors.push({
        versionId: '<version>',
        message: `${error.lineId} ${error.field}: ${error.message}`,
      });
    }
    if (seen.has(line.lineId)) {
      errors.push({ versionId: '<version>', message: `duplicate lineId "${line.lineId}"` });
    }
    seen.add(line.lineId);
  }
  return errors;
}
