/**
 * Provenance model of the price-book data layer.
 *
 * Every published value must trace to its source record. Fields the verified specification
 * does not establish stay explicitly null — a missing hash is never invented and a missing
 * printed page identity is never guessed.
 */

/** Reference to the exact place in the printed source a record came from. */
export interface SourceReference {
  /** Document title as verified (never an invented variant). */
  readonly sourceDocument: string;
  /** Edition identifier, e.g. "1404". */
  readonly edition: string;
  /** Printed page number (the PDF is cited by printed page, not viewer index). */
  readonly printedPage: string;
  /** Printed section/table identity. */
  readonly section: string;
  /**
   * SHA-256 of the official source file. Null until the official file hash is established;
   * never fabricated.
   */
  readonly sourceFileHash: string | null;
}

/** Immutable edition identity. Only verified metadata is populated; the rest stays null. */
export interface EditionMetadata {
  readonly id: string;
  readonly title: string;
  readonly organization: string;
  readonly year: string;
  /** Notification number as printed, or null. */
  readonly notificationNumber: string | null;
  /** Notification date as printed, or null. */
  readonly notificationDate: string | null;
  /** Null until the official source file hash is established. */
  readonly sourceFileHash: string | null;
}

/** The official 1404 ابنیه edition identity, exactly as verified (specification section 3.1). */
export const OFFICIAL_1404_EDITION: EditionMetadata = Object.freeze({
  id: 'ir-1404-abniye',
  title: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
  organization: 'سازمان برنامه و بودجه کشور',
  year: '1404',
  notificationNumber: '1403/742948',
  notificationDate: '1403/12/29',
  sourceFileHash: null,
});

export const OFFICIAL_EDITION_ID = OFFICIAL_1404_EDITION.id;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Structural validation of a source reference. Returns field-level error messages. */
export function sourceReferenceErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['sourceRef must be an object'];
  }
  const ref = value as Record<string, unknown>;
  for (const field of ['sourceDocument', 'edition', 'printedPage', 'section'] as const) {
    if (!isNonEmptyString(ref[field])) {
      errors.push(`sourceRef.${field} must be a non-empty string`);
    }
  }
  const hash = ref['sourceFileHash'];
  if (hash !== null && !isNonEmptyString(hash)) {
    errors.push('sourceRef.sourceFileHash must be a non-empty string or null');
  }
  return errors;
}

/** Structural validation of edition metadata. Returns field-level error messages. */
export function editionMetadataErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['edition must be an object'];
  }
  const edition = value as Record<string, unknown>;
  for (const field of ['id', 'title', 'organization', 'year'] as const) {
    if (!isNonEmptyString(edition[field])) {
      errors.push(`edition.${field} must be a non-empty string`);
    }
  }
  for (const field of ['notificationNumber', 'notificationDate', 'sourceFileHash'] as const) {
    const v = edition[field];
    if (v !== null && !isNonEmptyString(v)) {
      errors.push(`edition.${field} must be a non-empty string or null`);
    }
  }
  return errors;
}
