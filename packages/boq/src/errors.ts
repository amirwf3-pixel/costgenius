/** Error thrown for BOQ lifecycle and consistency violations. Codes are stable identifiers. */
export type BoqErrorCode =
  | 'INVALID_ESTIMATE'
  | 'INVALID_LINE'
  | 'LINE_MISMATCH'
  | 'DUPLICATE_LINE_ID'
  | 'DUPLICATE_VERSION_ID'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_FINALIZED'
  | 'EDITION_MISMATCH';

export class BoqError extends Error {
  readonly code: BoqErrorCode;
  readonly details: readonly string[];

  constructor(code: BoqErrorCode, message: string, details: readonly string[] = []) {
    super(details.length > 0 ? `${message}: ${details.join('; ')}` : message);
    this.name = 'BoqError';
    this.code = code;
    this.details = details;
  }
}
