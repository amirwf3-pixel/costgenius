/**
 * Reporting-layer errors.
 *
 * The builder reuses BOQ errors where they are precise (an unknown versionId propagates
 * the BOQ layer's `VERSION_NOT_FOUND`); these codes cover the reporting-specific
 * structural violations that have no upstream equivalent.
 */
export type ReportingErrorCode = 'INVALID_REPORT_INPUT' | 'S4_MISMATCH' | 'INVALID_REPORT';

export class ReportingError extends Error {
  constructor(
    readonly code: ReportingErrorCode,
    message: string,
    readonly details?: readonly string[],
  ) {
    super(message);
    this.name = 'ReportingError';
  }
}
