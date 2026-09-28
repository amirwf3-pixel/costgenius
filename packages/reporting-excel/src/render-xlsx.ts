/**
 * The XLSX encoder (stage 2b): workbook model → real XLSX bytes, entirely in memory.
 *
 * This adapter holds no business logic — every cell comes from the workbook model, which
 * copies the ReportModel. The renderer never touches the filesystem (the caller receives
 * a Uint8Array and decides where it goes), never invents a filename or timestamp, and
 * pins the workbook documentation properties to a fixed epoch so no clock is read.
 *
 * Byte determinism (Phase 17 fix): ExcelJS's zip writer stamps every container entry
 * with the wall clock at write time, so two renders straddling a 2-second DOS-timestamp
 * boundary produced different bytes for the same report. The encoded container is
 * therefore re-zipped with every entry's date pinned to the fixed DOS epoch below —
 * same entries, same order, same DEFLATE compression, no clock anywhere in the output.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { ReportModel, TakeoffReportModel } from '@costgenius/reporting';
import { buildWorkbookModel } from './workbook-model.js';
import { buildTakeoffWorkbookModel } from './takeoff-workbook-model.js';
import { ReportingExcelError } from './errors.js';
import type { WorkbookCell, WorkbookModel } from './types.js';

/**
 * Fixed documentation timestamp (Unix epoch) — a constant, not a clock read. Business
 * values never pass through any Date; this only pins the workbook's doc properties so
 * rendering stays deterministic.
 */
const WORKBOOK_EPOCH = new Date(0);

/**
 * Fixed ZIP entry timestamp (the same epoch constant; JSZip clamps it to the DOS floor
 * 1980-01-01) — pins every container entry so the byte output is independent of the
 * rendering moment.
 */
const ZIP_ENTRY_EPOCH = WORKBOOK_EPOCH;

const KEY_VALUE_FIELD_WIDTH = 36;
const KEY_VALUE_VALUE_WIDTH = 72;

function writeCell(cell: ExcelJS.Cell, value: WorkbookCell): void {
  if (value.kind === 'text') {
    cell.value = value.value;
  } else if (value.kind === 'integer') {
    cell.value = value.value;
  }
  // 'empty' → the cell stays unset and reads back as null (never 0, never '')
}

/** Applies the workbook model to a fresh ExcelJS workbook (pure in-memory construction). */
export function applyWorkbookModel(model: WorkbookModel): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CostGenius';
  workbook.lastModifiedBy = 'CostGenius';
  workbook.created = WORKBOOK_EPOCH;
  workbook.modified = WORKBOOK_EPOCH;

  for (const sheet of model.sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    let rowNumber = 1;

    for (const entry of sheet.entries) {
      const row = worksheet.getRow(rowNumber);
      const fieldCell = row.getCell(1);
      fieldCell.value = entry.field;
      fieldCell.font = { bold: true };
      writeCell(row.getCell(2), entry.cell);
      rowNumber += 1;
    }

    if (sheet.table !== undefined) {
      if (sheet.entries.length > 0) rowNumber += 1; // one blank separator row
      const headerRowNumber = rowNumber;

      const headerRow = worksheet.getRow(headerRowNumber);
      sheet.table.columns.forEach((column, index) => {
        const cell = headerRow.getCell(index + 1);
        cell.value = column.header;
        cell.font = { bold: true };
      });
      rowNumber += 1;

      for (const dataRow of sheet.table.rows) {
        const row = worksheet.getRow(rowNumber);
        dataRow.forEach((cell, index) => {
          writeCell(row.getCell(index + 1), cell);
        });
        rowNumber += 1;
      }

      sheet.table.columns.forEach((column, index) => {
        const worksheetColumn = worksheet.getColumn(index + 1);
        worksheetColumn.width = column.width;
        if (column.wrap) {
          worksheetColumn.style = { alignment: { wrapText: true, vertical: 'top' } };
        }
      });

      // freeze everything above the first data row; autofilter over the header row
      worksheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
      worksheet.autoFilter = {
        from: { row: headerRowNumber, column: 1 },
        to: { row: headerRowNumber, column: sheet.table.columns.length },
      };
    } else {
      // key–value sheet (Summary): fixed widths, wrapped values, no autofilter
      worksheet.getColumn(1).width = KEY_VALUE_FIELD_WIDTH;
      worksheet.getColumn(2).width = KEY_VALUE_VALUE_WIDTH;
      worksheet.getColumn(2).style = { alignment: { wrapText: true, vertical: 'top' } };
    }
  }

  return workbook;
}

/**
 * Renders a ReportModel to real XLSX bytes. Pure with respect to the report (read-only,
 * never mutated) and to the environment (no filesystem, no clock, no randomness).
 *
 * Throws `ReportingExcelError('INVALID_REPORT_MODEL')` when the report fails structural
 * validation (nothing is repaired) and `XLSX_RENDER_FAILED` if the library fails to encode.
 */
export async function renderReportToXlsx(report: ReportModel): Promise<Uint8Array> {
  const model = buildWorkbookModel(report);
  return await encodeWorkbookModel(model);
}

/**
 * Renders a TakeoffReportModel (D-016 Phase 6, G6=A) to real XLSX bytes through the SAME
 * encoder: sheets خلاصه / متره تفصیلی / جمع آیتم‌ها / جمع برگه‌ها, exact decimals as
 * text cells, `null` → empty cells, zip entries pinned to the fixed epoch
 * (byte-deterministic). Structurally invalid input fails loudly (INVALID_REPORT_MODEL).
 */
export async function renderTakeoffReportToXlsx(report: TakeoffReportModel): Promise<Uint8Array> {
  const model = buildTakeoffWorkbookModel(report);
  return await encodeWorkbookModel(model);
}

/** The shared workbook-model encoder (byte-deterministic; no clock, no randomness). */
async function encodeWorkbookModel(model: WorkbookModel): Promise<Uint8Array> {
  const workbook = applyWorkbookModel(model);
  try {
    const buffer = await workbook.xlsx.writeBuffer();
    return await normalizeZipEntryDates(buffer);
  } catch (error) {
    throw new ReportingExcelError(
      'XLSX_RENDER_FAILED',
      `the XLSX library failed to encode the workbook: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Re-zips an encoded XLSX container with every entry's timestamp pinned to
 * `ZIP_ENTRY_EPOCH` (entry order, names, content and DEFLATE compression are preserved
 * verbatim). Pure byte-level container normalization: no report value is touched.
 */
async function normalizeZipEntryDates(raw: ExcelJS.Buffer): Promise<Uint8Array> {
  const source = await JSZip.loadAsync(raw);
  const normalized = new JSZip();
  for (const [name, entry] of Object.entries(source.files)) {
    if (entry.dir) {
      normalized.folder(name);
      continue;
    }
    normalized.file(name, await entry.async('nodebuffer'), { date: ZIP_ENTRY_EPOCH });
  }
  // JSZip lazily creates parent-folder entries (xl/, docProps/, …) WITHOUT the date
  // option, so they would still carry the wall clock — pin every entry explicitly.
  for (const entry of Object.values(normalized.files)) {
    entry.date = ZIP_ENTRY_EPOCH;
  }
  const out = await normalized.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return new Uint8Array(out);
}
