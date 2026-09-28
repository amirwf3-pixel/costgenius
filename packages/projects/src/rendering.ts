/**
 * Estimate + takeoff rendering — thin pass-throughs to the existing stage-2 renderers.
 *
 * The workflow hands the renderer the ReportModel it already produced; this layer adds
 * no formatting, no recalculation and no repair. Bytes are produced in memory (the
 * caller persists them); both renderers are deterministic with respect to the report
 * (metadata dates are pinned by the renderers themselves).
 *
 * D-016 Phase 6 (G6=A): the takeoff branch builds the TakeoffReportModel from the
 * FINALIZED snapshot (the persisted engine result — never recalculated here) and hands
 * it to the SAME renderers through their takeoff entry points. Reports are
 * finalized-only; a draft/archived source is rejected by the reporting layer itself.
 */
import { buildTakeoffReportModel, type TakeoffReportSource } from '@costgenius/reporting';
import { renderReportToXlsx, renderTakeoffReportToXlsx } from '@costgenius/reporting-excel';
import {
  renderReportToPdf,
  renderTakeoffReportToPdf,
  type RenderPdfOptions,
} from '@costgenius/reporting-pdf';
import type { EstimateCalculation } from './estimate-calculation.js';

/** Renders the calculation's ReportModel to real XLSX bytes (ExcelJS, in memory). */
export async function renderEstimateExcel(calculation: EstimateCalculation): Promise<Uint8Array> {
  return renderReportToXlsx(calculation.reportModel);
}

/** Renders the calculation's ReportModel to real PDF bytes (pdfkit, in memory). */
export async function renderEstimatePdf(
  calculation: EstimateCalculation,
  options: RenderPdfOptions = {},
): Promise<Uint8Array> {
  return renderReportToPdf(calculation.reportModel, options);
}

/** Options for the takeoff renderers: the project title when the caller knows it. */
export interface RenderTakeoffOptions {
  readonly projectTitle?: string | null;
}

/**
 * Renders the FINALIZED takeoff snapshot to real XLSX bytes (ExcelJS, in memory).
 * Every value comes from the snapshot's own engine result — nothing is recalculated.
 */
export async function renderTakeoffExcel(
  source: TakeoffReportSource,
  options: RenderTakeoffOptions = {},
): Promise<Uint8Array> {
  const { projectTitle } = options;
  return renderTakeoffReportToXlsx(
    buildTakeoffReportModel({ source, ...(projectTitle !== undefined ? { projectTitle } : {}) }),
  );
}

/**
 * Renders the FINALIZED takeoff snapshot to real PDF bytes (pdfkit, in memory).
 * Every value comes from the snapshot's own engine result — nothing is recalculated.
 */
export async function renderTakeoffPdf(
  source: TakeoffReportSource,
  options: RenderTakeoffOptions & RenderPdfOptions = {},
): Promise<Uint8Array> {
  const { projectTitle, ...pdfOptions } = options;
  return renderTakeoffReportToPdf(
    buildTakeoffReportModel({ source, ...(projectTitle !== undefined ? { projectTitle } : {}) }),
    pdfOptions,
  );
}
