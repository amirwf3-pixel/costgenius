export type DomainErrorCode =
  | 'INVALID_DECIMAL'
  | 'NON_FINITE'
  | 'UNSAFE_NUMBER'
  | 'CURRENCY_MISMATCH'
  | 'UNIT_MISMATCH'
  | 'UNKNOWN_UNIT'
  | 'INVALID_SCALE'
  | 'INVALID_ID'
  | 'INVALID_INSTANT'
  | 'DIVISION_BY_ZERO';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DomainError';
    this.code = code;
  }
}
