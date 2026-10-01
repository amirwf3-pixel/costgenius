/**
 * @costgenius/reporting-pdf — the ReportModel → PDF renderer (stage 2 of the reporting
 * design, PDF branch).
 *
 * `renderReportToPdf(report)` produces real PDF bytes (a Uint8Array, in memory) from a
 * validated ReportModel, and — D-016 Phase 6 (G6=A) — `renderTakeoffReportToPdf(report)`
 * does the same for a validated TakeoffReportModel through the SAME encoder: Persian RTL with real Arabic shaping (Vazirmatn embedded),
 * Summary / Chapters / Groups / Lines (+ provenance & trace) / S4 Trace sections, A4 with
 * deterministic portrait/landscape layout, repeated table headers, keep-together rows and
 * Persian page numbering. Presentation only — no business logic, no recalculation, no
 * pricebook lookup, no repair. Exact decimal strings stay exact text; `null` renders as
 * the '—' placeholder — never 0.
 */
export { ReportingPdfError, type ReportingPdfErrorCode } from './errors.js';
export { buildPdfDocumentModel, reportStructureErrors, CELL_DELIMITER } from './pdf-model.js';
export {
  buildTakeoffPdfDocumentModel,
  takeoffReportStructureErrors,
  TAKEOFF_CELL_DELIMITER,
} from './takeoff-pdf-model.js';
export {
  renderReportToPdf,
  renderTakeoffReportToPdf,
  type RenderPdfOptions,
} from './render-pdf.js';
export { loadBundledFonts, type PdfFonts } from './fonts.js';
export {
  shapeArabicPersian,
  toVisualString,
  wrapLogicalText,
  normalizePresentationForms,
} from './rtl.js';
export type {
  KeyValueRow,
  PdfBlock,
  PdfDocumentModel,
  PdfSection,
  TableColumn,
  TableModel,
} from './types.js';
