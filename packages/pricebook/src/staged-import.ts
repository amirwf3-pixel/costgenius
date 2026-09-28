/**
 * Staged-import boundary: raw records → validation → import report → explicit publication.
 *
 * Nothing auto-publishes. `publishStagedImport` re-validates the file itself and refuses
 * any file whose report has errors, so a dataset can only become published through this
 * gate. Validation enforces the verified anchors (row identity pinned to verified values),
 * the status semantics, unit-label mapping consistency, exact decimal prices and provenance.
 */
import { PRICE_DECIMAL_PATTERN, validatePricebookRow, type RowValidationError } from './row.js';
import { editionMetadataErrors, OFFICIAL_EDITION_ID, type EditionMetadata } from './provenance.js';
import { VERIFIED_SUBSET_REQUIRED_CODES, VERIFIED_VALUE_ANCHORS } from './verified-anchors.js';
import { createPublishedDataset, type PublishedDataset } from './dataset.js';

/** Shape of a staged import file (rows are `unknown` until validated). */
export interface StagedPricebookFile {
  readonly formatVersion: '1';
  readonly kind: 'staged-import';
  readonly edition: EditionMetadata;
  readonly rows: readonly unknown[];
}

export interface ImportIssue {
  readonly code: string;
  readonly rowCode?: string;
  readonly message: string;
}

export interface ImportReport {
  readonly ok: boolean;
  readonly editionId: string;
  readonly rowCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly errors: readonly ImportIssue[];
  readonly warnings: readonly ImportIssue[];
}

const ANCHOR_BY_CODE: ReadonlyMap<string, (typeof VERIFIED_VALUE_ANCHORS)[number]> = new Map(
  VERIFIED_VALUE_ANCHORS.map((a) => [a.code, a]),
);

function anchorErrors(row: Record<string, unknown>): ImportIssue[] {
  const code = row['code'];
  if (typeof code !== 'string') return [];
  const anchor = ANCHOR_BY_CODE.get(code);
  if (anchor === undefined) return [];
  const issues: ImportIssue[] = [];
  const expect = anchor.expect;
  if (expect !== null) {
    if (row['basePrice'] !== expect.basePrice) {
      issues.push({
        code: 'ANCHOR_VALUE_MISMATCH',
        rowCode: code,
        message: `row ${code} contradicts its verified anchor: basePrice must be ${expect.basePrice ?? 'null (blank)'}`,
      });
    }
    if (row['status'] !== expect.status) {
      issues.push({
        code: 'ANCHOR_STATUS_MISMATCH',
        rowCode: code,
        message: `row ${code} contradicts its verified anchor: status must be ${expect.status}`,
      });
    }
  }
  if (anchor.mustNotBeNegative) {
    const price = row['basePrice'];
    if (typeof price === 'string' && price.startsWith('-')) {
      issues.push({
        code: 'ANCHOR_NEGATIVE_FORBIDDEN',
        rowCode: code,
        message: `row ${code} is not a verified negative price; a negative sign is not recorded for it in the verified dataset`,
      });
    }
  }
  return issues;
}

function suspiciousPriceWarnings(row: Record<string, unknown>): ImportIssue[] {
  const code = row['code'];
  const price = row['basePrice'];
  if (typeof code !== 'string' || typeof price !== 'string') return [];
  if (price === '0') {
    return [
      {
        code: 'SUSPICIOUS_ZERO_PRICE',
        rowCode: code,
        message: `row ${code} carries price 0; a blank must be null, and zero is not a verified price for any known row`,
      },
    ];
  }
  if (price === '1') {
    return [
      {
        code: 'SUSPICIOUS_LITERAL_ONE',
        rowCode: code,
        message: `row ${code} carries the suspicious literal 1 as its price`,
      },
    ];
  }
  return [];
}

/**
 * Validates a staged import file and produces the import report. Pure: no I/O, no clock,
 * no mutation. The report is complete (every violation recorded), never partial.
 */
export function validateStagedImport(file: unknown): ImportReport {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];

  if (typeof file !== 'object' || file === null) {
    return {
      ok: false,
      editionId: '<missing>',
      rowCount: 0,
      errorCount: 1,
      warningCount: 0,
      errors: [{ code: 'INVALID_FILE', message: 'staged import must be an object' }],
      warnings,
    };
  }
  const f = file as Record<string, unknown>;

  if (f['formatVersion'] !== '1') {
    errors.push({ code: 'INVALID_FORMAT_VERSION', message: 'formatVersion must be "1"' });
  }
  if (f['kind'] !== 'staged-import') {
    errors.push({ code: 'INVALID_KIND', message: 'kind must be "staged-import"' });
  }

  const editionId =
    typeof (f['edition'] as Record<string, unknown> | undefined)?.['id'] === 'string'
      ? ((f['edition'] as Record<string, unknown>)['id'] as string)
      : '<missing>';
  for (const error of editionMetadataErrors(f['edition'])) {
    errors.push({ code: 'INVALID_EDITION', message: error });
  }

  const rows = f['rows'];
  if (!Array.isArray(rows)) {
    errors.push({ code: 'INVALID_ROWS', message: 'rows must be an array' });
    return {
      ok: false,
      editionId,
      rowCount: 0,
      errorCount: errors.length,
      warningCount: 0,
      errors,
      warnings,
    };
  }

  const seenCodes = new Set<string>();
  for (const row of rows) {
    for (const error of validatePricebookRow(row)) {
      errors.push({
        code: 'INVALID_ROW',
        rowCode: error.rowCode,
        message: `${error.field}: ${error.message}`,
      });
    }
    if (typeof row === 'object' && row !== null) {
      const r = row as Record<string, unknown>;
      if (typeof r['code'] === 'string') {
        if (seenCodes.has(r['code'])) {
          errors.push({
            code: 'DUPLICATE_CODE',
            rowCode: r['code'],
            message: `duplicate row code ${r['code']}`,
          });
        }
        seenCodes.add(r['code']);
        for (const issue of anchorErrors(r)) errors.push(issue);
        for (const issue of suspiciousPriceWarnings(r)) warnings.push(issue);
      }
    }
  }

  // The verified subset is a completeness floor for the official 1404 edition: any staged
  // import of this edition must carry the verified rows with their verified values.
  if (editionId === OFFICIAL_EDITION_ID) {
    for (const required of VERIFIED_SUBSET_REQUIRED_CODES) {
      if (!seenCodes.has(required)) {
        errors.push({
          code: 'VERIFIED_SUBSET_INCOMPLETE',
          rowCode: required,
          message: `the staged import of the official 1404 edition is missing verified row ${required}`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    editionId,
    rowCount: rows.length,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
  };
}

/** Thrown when publication of a staged import is refused. */
export class ImportValidationError extends Error {
  constructor(readonly report: ImportReport) {
    super(`staged import refused: ${String(report.errorCount)} error(s)`);
    this.name = 'ImportValidationError';
  }
}

/**
 * The only publication path. Re-validates the file (a forged report cannot publish data),
 * refuses any error, and returns an immutable published dataset.
 */
export function publishStagedImport(file: unknown): PublishedDataset {
  const report = validateStagedImport(file);
  if (!report.ok) {
    throw new ImportValidationError(report);
  }
  const f = file as StagedPricebookFile;
  return createPublishedDataset(f.edition, f.rows);
}

export type { RowValidationError };
export { PRICE_DECIMAL_PATTERN };
