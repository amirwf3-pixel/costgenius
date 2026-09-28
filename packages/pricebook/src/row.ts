/**
 * The price-book row contract and its validation.
 *
 * Identity is the exact printed code string (leading zeros preserved, never numeric).
 * Prices are exact decimal strings (integer Rial in the 1404 dataset); a blank price is
 * `null` plus status INCOMPLETE — never zero. Unit labels map to domain codes only through
 * the explicit printed-unit table. External dependencies resolve only against the verified
 * registry. Nothing is trimmed, coerced or defaulted silently.
 */
import { type UnitCode } from '@costgenius/domain';
import { isVerifiedDependencyId } from './dependencies.js';
import { type SourceReference, sourceReferenceErrors } from './provenance.js';
import { type PricebookStatus, isPricebookStatus } from './status.js';
import { printedUnitMatches } from './units-map.js';

export interface PricebookRowUnit {
  /** Printed label, verbatim (including irregular spellings). */
  readonly label: string;
  readonly code: UnitCode;
}

export interface PricebookRow {
  /** Exact printed code; string identity, leading zeros preserved. */
  readonly code: string;
  readonly chapter: string;
  readonly group: string;
  /** Printed description, verbatim as recorded by the verified specification. */
  readonly description: string;
  readonly unit: PricebookRowUnit;
  /** Exact decimal string (integer Rial), or null when the source prints no price. */
  readonly basePrice: string | null;
  readonly status: PricebookStatus;
  readonly sourceRef: SourceReference;
  /** Ids into the verified external-dependency registry. */
  readonly externalDependencies: readonly string[];
  readonly notes: readonly string[];
}

/** Plain decimal literal; no exponent, no commas, no sign apart from a leading minus. */
export const PRICE_DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export interface RowValidationError {
  readonly rowCode: string;
  readonly field: string;
  readonly message: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Validates one staged row record. Returns every violation (no early exit) so an import
 * report is complete. `code` participates in every error for traceability.
 */
export function validatePricebookRow(row: unknown): RowValidationError[] {
  const errors: RowValidationError[] = [];
  if (typeof row !== 'object' || row === null) {
    return [{ rowCode: '<missing>', field: 'row', message: 'row must be an object' }];
  }
  const r = row as Record<string, unknown>;

  if (!isNonEmptyString(r['code'])) {
    return [{ rowCode: '<missing>', field: 'code', message: 'code must be a non-empty string' }];
  }
  const code = r['code'];
  const add = (field: string, message: string): void => {
    errors.push({ rowCode: code, field, message });
  };

  if (code !== code.trim() || /\s/.test(code)) {
    add('code', 'code must not contain surrounding or internal whitespace');
  }
  for (const field of ['chapter', 'group', 'description'] as const) {
    if (!isNonEmptyString(r[field])) {
      add(field, `${field} must be a non-empty string`);
    }
  }

  const unit = r['unit'];
  if (typeof unit !== 'object' || unit === null) {
    add('unit', 'unit must be an object with label and code');
  } else {
    const u = unit as Record<string, unknown>;
    if (!isNonEmptyString(u['label'])) {
      add('unit.label', 'unit.label must be a non-empty string');
    }
    if (typeof u['code'] !== 'string' || !printedUnitMatches(u['label'], u['code'])) {
      add(
        'unit',
        'unit.code must be the domain UnitCode its printed unit.label explicitly maps to (unknown label or inconsistent pair)',
      );
    }
  }

  const basePrice = r['basePrice'];
  if (basePrice !== null) {
    if (typeof basePrice !== 'string' || !PRICE_DECIMAL_PATTERN.test(basePrice)) {
      add(
        'basePrice',
        'basePrice must be null or an exact decimal string (no exponent, no commas, no float)',
      );
    }
  }

  const status = r['status'];
  if (!isPricebookStatus(status)) {
    add(
      'status',
      `status must be one of VERIFIED_SPEC_ONLY, EXTERNAL_DEPENDENCY, NOT_SPECIFIED_IN_1404_PRICEBOOK, INCOMPLETE (legacy UNRESOLVED is not a production status)`,
    );
  }

  if (isPricebookStatus(status)) {
    // A blank price is only legitimate where the value is not locally established
    // (INCOMPLETE blank cell, EXTERNAL_DEPENDENCY value outside the source, NOT_SPECIFIED).
    if (basePrice === null && status === 'VERIFIED_SPEC_ONLY') {
      add('status', 'a null (blank) price requires status INCOMPLETE; blank never becomes zero');
    }
    if (status === 'INCOMPLETE' && basePrice !== null) {
      const notes = r['notes'];
      if (!isStringArray(notes) || notes.length === 0) {
        add(
          'status',
          'status INCOMPLETE with a price requires a note recording what is incomplete',
        );
      }
    }
    if (status === 'EXTERNAL_DEPENDENCY') {
      const deps = r['externalDependencies'];
      if (!isStringArray(deps) || deps.length === 0) {
        add('status', 'status EXTERNAL_DEPENDENCY requires at least one registry dependency id');
      }
    }
  }

  const deps = r['externalDependencies'];
  if (deps !== undefined) {
    if (!isStringArray(deps)) {
      add('externalDependencies', 'externalDependencies must be an array of strings');
    } else {
      for (const id of deps) {
        if (!isVerifiedDependencyId(id)) {
          add(
            'externalDependencies',
            `unknown external dependency id "${id}" (not in the verified registry)`,
          );
        }
      }
    }
  }

  const notes = r['notes'];
  if (notes !== undefined && !isStringArray(notes)) {
    add('notes', 'notes must be an array of strings');
  }

  for (const error of sourceReferenceErrors(r['sourceRef'])) {
    add('sourceRef', error);
  }

  return errors;
}
