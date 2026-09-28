/**
 * Renderer error taxonomy — deliberately minimal.
 *
 * `INVALID_REPORT_MODEL`: the input report failed the renderer's structural validation
 * (fail loudly; never repair). `XLSX_RENDER_FAILED`: the XLSX library itself failed while
 * encoding the (already validated) workbook model.
 */
export type ReportingExcelErrorCode = 'INVALID_REPORT_MODEL' | 'XLSX_RENDER_FAILED';

export class ReportingExcelError extends Error {
  constructor(
    readonly code: ReportingExcelErrorCode,
    message: string,
    readonly details?: readonly string[],
  ) {
    super(message);
    this.name = 'ReportingExcelError';
  }
}
