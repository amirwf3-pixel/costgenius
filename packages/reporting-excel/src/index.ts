/**
 * @costgenius/reporting-excel — the ReportModel → XLSX renderer (stage 2 of the reporting
 * design, Excel branch).
 *
 * `renderReportToXlsx(report)` produces real XLSX bytes (a Uint8Array, in memory) from a
 * validated ReportModel: sheets Summary / Chapters / Groups / Lines (+ S4 Trace when the
 * report carries an S4 estimate result), and — D-016 Phase 6 (G6=A) —
 * `renderTakeoffReportToXlsx(report)` does the same for a validated TakeoffReportModel
 * (sheets خلاصه / متره تفصیلی / جمع آیتم‌ها / جمع برگه‌ها) through the SAME encoder. The renderer is presentation only — no business
 * logic, no recalculation, no pricebook lookup, no repair. Business decimal strings stay
 * text (leading zeros, negatives, zero and null all preserved exactly); `null` renders as
 * an empty cell, never 0.
 */
export { ReportingExcelError, type ReportingExcelErrorCode } from './errors.js';
export { buildWorkbookModel, reportStructureErrors, CELL_DELIMITER } from './workbook-model.js';
export { buildTakeoffWorkbookModel, TAKEOFF_CELL_DELIMITER } from './takeoff-workbook-model.js';
export { takeoffReportStructureErrors } from './takeoff-structure.js';
export {
  applyWorkbookModel,
  renderReportToXlsx,
  renderTakeoffReportToXlsx,
} from './render-xlsx.js';
export type {
  WorkbookCell,
  WorkbookColumn,
  WorkbookEntry,
  WorkbookModel,
  WorkbookSheetModel,
  WorkbookTableModel,
} from './types.js';
