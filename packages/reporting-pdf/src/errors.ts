/**
 * Renderer error taxonomy — deliberately minimal, mirroring the Excel renderer.
 *
 * `INVALID_REPORT_MODEL`: the input report failed the renderer's structural validation
 * (fail loudly; never repair). `PDF_RENDER_FAILED`: the PDF library itself failed while
 * encoding the (already validated) document model.
 */
export type ReportingPdfErrorCode = 'INVALID_REPORT_MODEL' | 'PDF_RENDER_FAILED';

export class ReportingPdfError extends Error {
  constructor(
    readonly code: ReportingPdfErrorCode,
    message: string,
    readonly details?: readonly string[],
  ) {
    super(message);
    this.name = 'ReportingPdfError';
  }
}
