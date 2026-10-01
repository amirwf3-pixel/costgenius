/**
 * The PDF encoder (stage 2b): document model → real PDF bytes, entirely in memory.
 *
 * This adapter holds no business logic — every value comes from the document model, which
 * copies the ReportModel. Determinism: the document metadata (Creator/Producer) is fixed
 * and the creation/modification dates are pinned to a constant epoch, so rendering the
 * same report twice yields byte-identical output. The renderer never touches the business
 * filesystem (the caller receives a Uint8Array; the only fs access in this package is the
 * bundled-font loader in fonts.ts).
 *
 * Layout: A4; portrait sections for Summary/Chapters/Groups and the S4 trace; LANDSCAPE
 * pages for the Lines + provenance tables (they carry too many columns for portrait).
 * Tables are laid out right-to-left (first logical column at the right edge), rows are
 * never split across pages, and the header row repeats on every page.
 */
import PDFDocument from 'pdfkit';
import type { ReportModel, TakeoffReportModel } from '@costgenius/reporting';
import { buildPdfDocumentModel } from './pdf-model.js';
import { buildTakeoffPdfDocumentModel } from './takeoff-pdf-model.js';
import { ReportingPdfError } from './errors.js';
import { loadBundledFonts, type PdfFonts } from './fonts.js';
import { toVisualString, wrapLogicalText } from './rtl.js';
import type { PdfDocumentModel, TableModel } from './types.js';

/** Fixed metadata timestamps (a constant, not a clock read). */
const EPOCH = new Date(0);
const PAGE_MARGIN = 40;
const CONTENT_TOP = 72; // below the fixed header zone
const FOOTER_RESERVE = 40; // above the footer zone
const CELL_PAD = 3;
const HEADER_FILL = '#eeeeee';
const RULE_COLOR = '#bbbbbb';

/** Typographic placeholder for a null/absent value — never 0, never ''. */
const NULL_PLACEHOLDER = '—';

const REGULAR = 'cg-regular';
const BOLD = 'cg-bold';

export interface RenderPdfOptions {
  /** Caller-supplied fonts (in-memory); defaults to the bundled Vazirmatn assets. */
  readonly fonts?: PdfFonts;
}

function pageBottom(doc: PDFKit.PDFDocument): number {
  return doc.page.height - PAGE_MARGIN - FOOTER_RESERVE;
}

function usableWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - 2 * PAGE_MARGIN;
}

/**
 * Renders a ReportModel to real PDF bytes. Pure with respect to the report (read-only,
 * never mutated) and deterministic with respect to metadata. Throws
 * `ReportingPdfError('INVALID_REPORT_MODEL')` for a structurally invalid report (nothing
 * is repaired) and `PDF_RENDER_FAILED` if the library fails to encode.
 */
export async function renderReportToPdf(
  report: ReportModel,
  options: RenderPdfOptions = {},
): Promise<Uint8Array> {
  // Validation first — an invalid report never produces a document.
  const model = buildPdfDocumentModel(report);
  return await encodePdfDocument(
    model,
    `${report.metadata.edition} — ${report.metadata.versionId}`,
    options,
  );
}

/**
 * Renders a TakeoffReportModel (D-016 Phase 6, G6=A) to real PDF bytes through the SAME
 * encoder: Persian RTL, A4 portrait/landscape sections, repeated table headers,
 * keep-together rows and pinned metadata dates (byte-deterministic). Pure with respect
 * to the report; structurally invalid input fails loudly (INVALID_REPORT_MODEL).
 */
export async function renderTakeoffReportToPdf(
  report: TakeoffReportModel,
  options: RenderPdfOptions = {},
): Promise<Uint8Array> {
  // Validation first — an invalid report never produces a document.
  const model = buildTakeoffPdfDocumentModel(report);
  return await encodePdfDocument(
    model,
    `${report.metadata.specId}@${report.metadata.specVersion} — ${report.metadata.documentId}`,
    options,
  );
}

/** The shared document-model encoder (every block renderer lives above this line). */
async function encodePdfDocument(
  model: PdfDocumentModel,
  headerLeft: string,
  options: RenderPdfOptions,
): Promise<Uint8Array> {
  const fonts = options.fonts ?? loadBundledFonts();

  try {
    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE_MARGIN,
      bufferPages: true,
      info: {
        Title: model.title,
        Creator: 'CostGenius',
        Producer: 'CostGenius',
        CreationDate: EPOCH,
        ModDate: EPOCH,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    const done = new Promise<void>((resolve) => {
      doc.on('end', () => {
        resolve();
      });
    });

    doc.registerFont(REGULAR, fonts.regular);
    doc.registerFont(BOLD, fonts.bold);

    doc.font(REGULAR).fontSize(9);
    doc.y = CONTENT_TOP;

    for (const [index, section] of model.sections.entries()) {
      if (index > 0) {
        doc.addPage({ size: 'A4', layout: section.orientation });
        doc.font(REGULAR).fontSize(9);
        doc.y = CONTENT_TOP;
      }
      for (const block of section.blocks) {
        if (block.kind === 'heading') renderHeading(doc, block.level, block.text);
        else if (block.kind === 'paragraph') renderParagraph(doc, block.text);
        else if (block.kind === 'key-value') renderKeyValue(doc, block.rows, section.orientation);
        else renderTable(doc, block.title, block.table, section.orientation);
      }
    }

    // Fixed header + numbered footer on every page (drawn after content, deterministically).
    const range = doc.bufferedPageRange();
    const total = range.start + range.count;
    for (let i = range.start; i < total; i += 1) {
      doc.switchToPage(i);
      renderRunningHeader(doc, model.title, headerLeft);
      renderFooter(doc, i + 1, total);
    }

    doc.end();
    await done;
    return new Uint8Array(Buffer.concat(chunks));
  } catch (error) {
    throw new ReportingPdfError(
      'PDF_RENDER_FAILED',
      `the PDF library failed to encode the document: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---- text primitives (all strings go through the RTL pipeline) ----------------------------------

function drawLineRight(doc: PDFKit.PDFDocument, text: string, right: number, y: number): void {
  const visual = toVisualString(text);
  const width = doc.widthOfString(visual);
  doc.text(visual, right - width, y, { lineBreak: false });
}

function drawLinesRight(
  doc: PDFKit.PDFDocument,
  lines: readonly string[],
  right: number,
  y: number,
  lineHeight: number,
): void {
  let cursor = y;
  for (const line of lines) {
    drawLineRight(doc, line, right, cursor);
    cursor += lineHeight;
  }
}

function cellLines(doc: PDFKit.PDFDocument, value: string | null, width: number): string[] {
  // null/absent → the typographic placeholder (never 0, never ''); '0' stays '0'
  if (value === null || value === '') return [NULL_PLACEHOLDER];
  return wrapLogicalText(value, width, (text) => doc.widthOfString(toVisualString(text)));
}

function lineHeight(doc: PDFKit.PDFDocument): number {
  return doc.currentLineHeight() + 1.5;
}

// ---- blocks ----------------------------------------------------------------------------------------

function renderHeading(doc: PDFKit.PDFDocument, level: 1 | 2 | 3, text: string): void {
  const size = level === 1 ? 15 : level === 2 ? 12 : 10;
  doc.font(BOLD).fontSize(size);
  const lines = wrapLogicalText(text, usableWidth(doc), (t) =>
    doc.widthOfString(toVisualString(t)),
  );
  const h = lineHeight(doc);
  doc.y += level === 1 ? 6 : 12;
  drawLinesRight(doc, lines, PAGE_MARGIN + usableWidth(doc), doc.y, h);
  doc.y += lines.length * h + 2;
  if (level <= 2) {
    doc
      .moveTo(PAGE_MARGIN, doc.y)
      .lineTo(PAGE_MARGIN + usableWidth(doc), doc.y)
      .strokeColor(RULE_COLOR)
      .stroke();
    doc.y += 8;
  }
  doc.font(REGULAR).fontSize(9);
}

function renderParagraph(doc: PDFKit.PDFDocument, text: string): void {
  doc.font(REGULAR).fontSize(9);
  const lines = wrapLogicalText(text, usableWidth(doc), (t) =>
    doc.widthOfString(toVisualString(t)),
  );
  const h = lineHeight(doc);
  drawLinesRight(doc, lines, PAGE_MARGIN + usableWidth(doc), doc.y, h);
  doc.y += lines.length * h + 4;
}

function renderKeyValue(
  doc: PDFKit.PDFDocument,
  rows: readonly { field: string; value: string | null }[],
  orientation: 'portrait' | 'landscape',
): void {
  const usable = usableWidth(doc);
  const fieldWidth = 170;
  const gap = 8;
  const valueWidth = usable - fieldWidth - gap;
  const right = PAGE_MARGIN + usable;
  const fieldRight = right;
  const valueRight = right - fieldWidth - gap;

  for (const row of rows) {
    doc.font(BOLD).fontSize(8.5);
    const fieldLines = cellLines(doc, row.field, fieldWidth);
    doc.font(REGULAR).fontSize(8.5);
    const valueLines = cellLines(doc, row.value, valueWidth);
    const h = lineHeight(doc);
    const rowHeight = Math.max(fieldLines.length, valueLines.length, 1) * h + 2;

    if (doc.y + rowHeight > pageBottom(doc)) {
      doc.addPage({ size: 'A4', layout: orientation });
      doc.font(REGULAR).fontSize(9);
      doc.y = CONTENT_TOP;
    }
    doc.font(BOLD).fontSize(8.5);
    drawLinesRight(doc, fieldLines, fieldRight, doc.y, h);
    doc.font(REGULAR).fontSize(8.5);
    drawLinesRight(doc, valueLines, valueRight, doc.y, h);
    doc.y += rowHeight;
  }
  doc.font(REGULAR).fontSize(9);
  doc.y += 4;
}

/** Right-edge x positions of each column (RTL layout: first column rightmost). */
function columnRights(doc: PDFKit.PDFDocument, table: TableModel): number[] {
  const usable = usableWidth(doc);
  const rights: number[] = [];
  let right = PAGE_MARGIN + usable;
  for (const column of table.columns) {
    rights.push(right);
    right -= column.width;
  }
  return rights;
}

function renderTableHeader(
  doc: PDFKit.PDFDocument,
  table: TableModel,
  rights: readonly number[],
): number {
  doc.font(BOLD).fontSize(6.5);
  const h = lineHeight(doc);
  const cellWidths = table.columns.map((c) => c.width - 2 * CELL_PAD);
  const headerLines = table.columns.map((c, i) => cellLines(doc, c.header, cellWidths[i] ?? 10));
  const height = Math.max(...headerLines.map((l) => l.length), 1) * h + 2 * CELL_PAD;

  const tableWidth = table.columns.reduce((sum, c) => sum + c.width, 0);
  doc
    .rect(rights[0] !== undefined ? rights[0] - tableWidth : PAGE_MARGIN, doc.y, tableWidth, height)
    .fill(HEADER_FILL);

  doc.fillColor('#000000');
  headerLines.forEach((lines, i) => {
    const right = rights[i];
    if (right === undefined) return;
    drawLinesRight(doc, lines, right - CELL_PAD, doc.y + CELL_PAD, h);
  });
  doc.y += height;
  return height;
}

function renderTable(
  doc: PDFKit.PDFDocument,
  title: string,
  table: TableModel,
  orientation: 'portrait' | 'landscape',
): void {
  renderParagraph(doc, title);
  const rights = columnRights(doc, table);
  const cellWidths = table.columns.map((c) => c.width - 2 * CELL_PAD);

  renderTableHeader(doc, table, rights);

  doc.font(REGULAR).fontSize(6.5);
  const h = lineHeight(doc);

  for (const row of table.rows) {
    // pre-wrap every cell first so the row height is known BEFORE drawing (keep-together)
    const cellTexts = row.map((value, i) => cellLines(doc, value, cellWidths[i] ?? 10));
    const rowHeight = Math.max(...cellTexts.map((l) => l.length), 1) * h + 2 * CELL_PAD;

    if (doc.y + rowHeight > pageBottom(doc)) {
      doc.addPage({ size: 'A4', layout: orientation });
      doc.font(REGULAR).fontSize(9);
      doc.y = CONTENT_TOP;
      renderTableHeader(doc, table, rights);
      doc.font(REGULAR).fontSize(6.5);
    }

    cellTexts.forEach((lines, i) => {
      const right = rights[i];
      if (right === undefined) return;
      drawLinesRight(doc, lines, right - CELL_PAD, doc.y + CELL_PAD, h);
    });

    doc.y += rowHeight;
    const tableWidth = table.columns.reduce((sum, c) => sum + c.width, 0);
    const leftEdge = (rights[0] ?? PAGE_MARGIN) - tableWidth;
    doc
      .moveTo(leftEdge, doc.y)
      .lineTo(rights[0] ?? PAGE_MARGIN, doc.y)
      .strokeColor(RULE_COLOR)
      .lineWidth(0.5)
      .stroke();
  }
  doc.y += 8;
}

// ---- running header / footer -------------------------------------------------------------------------

function renderRunningHeader(doc: PDFKit.PDFDocument, title: string, headerLeft: string): void {
  const y = 30;
  doc.font(BOLD).fontSize(7);
  drawLineRight(doc, title, PAGE_MARGIN + usableWidth(doc), y);
  doc.font(REGULAR).fontSize(7);
  doc.text(toVisualString(headerLeft), PAGE_MARGIN, y, { lineBreak: false });
}

function renderFooter(doc: PDFKit.PDFDocument, page: number, total: number): void {
  const y = doc.page.height - 28;
  doc.font(REGULAR).fontSize(7);
  // «صفحه i از n» — Persian, shaped and reordered like every other string
  drawLineRight(doc, `صفحه ${String(page)} از ${String(total)}`, PAGE_MARGIN + usableWidth(doc), y);
}
