/**
 * @costgenius/reporting — stage 1 of the two-stage reporting design.
 *
 * Builds an immutable, rendering-independent ReportModel from a BOQ estimate version and
 * its authoritative rollup, and — D-016 Phase 6 (G6=A) — the TakeoffReportModel from a
 * FINALIZED takeoff snapshot (every value copied verbatim from the persisted engine
 * result). No Excel, no PDF, no UI, no I/O — renderers consume these models later.
 * Nothing is recalculated, invented, normalized or hidden here.
 */
export { ReportingError, type ReportingErrorCode } from './errors.js';
export {
  buildReportModel,
  type BuildReportInput,
  type ReportChapter,
  type ReportDependency,
  type ReportGroup,
  type ReportLine,
  type ReportMetadata,
  type ReportModel,
  type ReportProvenance,
  type ReportScopeBoundaries,
  type ReportSummary,
} from './report-model.js';
export {
  validateReportModel,
  type ReportValidationError,
  type ReportValidationSource,
} from './validation.js';
export {
  buildTakeoffReportModel,
  takeoffQuantityDisplay,
  type BuildTakeoffReportInput,
  type TakeoffReportDocument,
  type TakeoffReportLine,
  type TakeoffReportMetadata,
  type TakeoffReportModel,
  type TakeoffReportProvenance,
  type TakeoffReportRoundingRule,
  type TakeoffReportSheet,
  type TakeoffReportSheetTotal,
  type TakeoffReportSource,
  type TakeoffReportTotalRow,
} from './takeoff-report-model.js';
