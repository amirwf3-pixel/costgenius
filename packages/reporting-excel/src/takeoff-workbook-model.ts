/**
 * The pure TakeoffReportModel → workbook-model mapping (stage 2a, takeoff branch —
 * D-016 Phase 6, G6=A).
 *
 * This module contains NO business logic: no quantity resolution, no recalculation, no
 * aggregation, no rounding, no repair. It copies the report's own values into
 * rendering-library-independent sheet descriptions:
 *
 * - business decimal strings (codes with leading zeros, quantities, magnitudes, totals)
 *   become `text` cells — never numbers, never floats;
 * - integers that are already numbers in the contract (sheet order, row number,
 *   document number, revision, scale) become `integer` cells;
 * - `null`/absent values become `empty` cells — never 0, never ''.
 *
 * Sheet order is fixed (the standard V1 template): خلاصه، متره تفصیلی، جمع آیتم‌ها،
 * جمع برگه‌ها. Uncoded items stay visible («بدون کد»); no itemCode is ever invented.
 */
import type { TakeoffReportModel, TakeoffReportTotalRow } from '@costgenius/reporting';
import { ReportingExcelError } from './errors.js';
import { takeoffReportStructureErrors } from './takeoff-structure.js';
import type {
  WorkbookCell,
  WorkbookColumn,
  WorkbookEntry,
  WorkbookModel,
  WorkbookSheetModel,
  WorkbookTableModel,
} from './types.js';

/** Deterministic delimiter for multi-value cells (contributing lineIds). */
export const TAKEOFF_CELL_DELIMITER = '، ';

const text = (value: string): WorkbookCell => ({ kind: 'text', value });
const int = (value: number): WorkbookCell => ({ kind: 'integer', value });
const EMPTY: WorkbookCell = { kind: 'empty' };

const textOrNull = (value: string | null): WorkbookCell => (value === null ? EMPTY : text(value));

const joined = (ids: readonly string[]): WorkbookCell =>
  ids.length === 0 ? EMPTY : text(ids.join(TAKEOFF_CELL_DELIMITER));

const UNCODED_LABEL = 'بدون کد';

// ---- sheets -------------------------------------------------------------------------------------

const summaryEntries = (report: TakeoffReportModel): readonly WorkbookEntry[] => [
  { field: 'شناسه گزارش', cell: text(report.metadata.reportId) },
  { field: 'عنوان سند', cell: text(report.metadata.title) },
  { field: 'پروژه', cell: textOrNull(report.metadata.projectTitle) },
  { field: 'شناسه پروژه', cell: text(report.metadata.projectId) },
  { field: 'شناسه سند', cell: text(report.metadata.documentId) },
  { field: 'زنجیرهٔ متره', cell: text(report.metadata.takeoffId) },
  { field: 'شمارهٔ سند', cell: int(report.metadata.documentNumber) },
  { field: 'وضعیت', cell: text(report.metadata.status) },
  { field: 'نسخهٔ سند (revision)', cell: int(report.metadata.revision) },
  { field: 'تاریخ ایجاد', cell: text(report.metadata.createdAt) },
  { field: 'زمان نهایی‌سازی', cell: text(report.metadata.finalizedAt) },
  {
    field: 'مشخصات اندازه‌گیری',
    cell: text(`${report.metadata.specId}@${report.metadata.specVersion}`),
  },
  { field: 'نسخهٔ موتور محاسبه', cell: text(report.metadata.engineVersion) },
  { field: 'تعداد برگه‌ها', cell: int(report.metadata.sheetCount) },
  { field: 'تعداد ردیف‌ها', cell: int(report.metadata.lineCount) },
  { field: 'اقلام کددار', cell: int(report.metadata.codedItemCount) },
  { field: 'اقلام بدون کد', cell: int(report.metadata.uncodedItemCount) },
];

const ROUNDING_COLUMNS: readonly WorkbookColumn[] = [
  { header: 'هدف', width: 16, wrap: true },
  { header: 'انتخاب‌گر', width: 28, wrap: true },
  { header: 'دقت', width: 8, wrap: false },
  { header: 'روش', width: 12, wrap: true },
  { header: 'منشأ', width: 14, wrap: true },
  { header: 'منبع', width: 30, wrap: true },
];

function summarySheet(report: TakeoffReportModel): WorkbookSheetModel {
  const table: WorkbookTableModel = {
    columns: ROUNDING_COLUMNS,
    rows: report.rounding.map((rule) => [
      text(rule.target),
      text(rule.selector ?? 'همه'),
      int(rule.scale),
      text(rule.mode),
      text(rule.sourceStatus),
      textOrNull(rule.source),
    ]),
  };
  return { name: 'خلاصه', entries: summaryEntries(report), table };
}

const DETAIL_COLUMNS: readonly WorkbookColumn[] = [
  { header: 'ترتیب برگه', width: 10, wrap: false },
  { header: 'نام برگه', width: 18, wrap: true },
  { header: 'شناسه برگه', width: 10, wrap: false },
  { header: 'ردیف', width: 8, wrap: false },
  { header: 'شناسه ردیف', width: 12, wrap: false },
  { header: 'شرح', width: 40, wrap: true },
  { header: 'محل', width: 14, wrap: true },
  { header: 'کد آیتم', width: 12, wrap: false },
  { header: 'نوع', width: 9, wrap: false },
  { header: 'نوع مقدار', width: 10, wrap: false },
  { header: 'واحد', width: 8, wrap: false },
  { header: 'فرمول (§6.3)', width: 34, wrap: true },
  { header: 'تعداد طبقات', width: 12, wrap: false },
  { header: 'تعداد مشابه', width: 12, wrap: false },
  { header: 'مقدار دقیق', width: 14, wrap: false },
  { header: 'مقدار گردشده', width: 14, wrap: false },
  { header: 'مقدار با علامت', width: 14, wrap: false },
  { header: 'دلیل دستی', width: 24, wrap: true },
  { header: 'یادداشت', width: 18, wrap: true },
  { header: 'لنگر ردیابی', width: 14, wrap: false },
];

function detailSheet(report: TakeoffReportModel): WorkbookSheetModel {
  const rows: WorkbookCell[][] = report.sheets.flatMap((sheet) =>
    sheet.lines.map((line): WorkbookCell[] => [
      int(sheet.sheetOrder),
      text(sheet.sheetName),
      text(sheet.sheetId),
      int(line.rowNo),
      text(line.lineId),
      text(line.description),
      textOrNull(line.location),
      textOrNull(line.itemCode),
      text(line.kind === 'addition' ? 'افزایش' : line.kind === 'deduction' ? 'کسر' : line.kind),
      text(line.quantityType),
      text(line.unit),
      text(line.formula),
      textOrNull(line.floorCount),
      textOrNull(line.similarCount),
      text(line.exactMagnitude),
      textOrNull(line.roundedMagnitude),
      text(line.signedValue),
      textOrNull(line.manualJustification),
      textOrNull(line.notes),
      textOrNull(line.traceRuleId),
    ]),
  );
  return { name: 'متره تفصیلی', entries: [], table: { columns: DETAIL_COLUMNS, rows } };
}

const TOTAL_COLUMNS: readonly WorkbookColumn[] = [
  { header: 'کد آیتم', width: 14, wrap: false },
  { header: 'واحد', width: 9, wrap: false },
  { header: 'مقدار دقیق', width: 14, wrap: false },
  { header: 'مقدار گردشده', width: 14, wrap: false },
  { header: 'مقدار مؤثر (انتقال)', width: 18, wrap: false },
  { header: 'ردیف‌های مشارکت‌کننده', width: 30, wrap: true },
];

function totalRows(rows: readonly TakeoffReportTotalRow[]): readonly WorkbookCell[][] {
  return rows.map((row) => [
    row.itemCode === null ? text(UNCODED_LABEL) : text(row.itemCode),
    text(row.unit),
    text(row.exactQty),
    textOrNull(row.roundedQty),
    text(row.qty),
    joined(row.lineIds),
  ]);
}

function itemTotalsSheet(report: TakeoffReportModel): WorkbookSheetModel {
  return {
    name: 'جمع آیتم‌ها',
    entries: [
      { field: 'شناسه سند', cell: text(report.metadata.documentId) },
      { field: 'زنجیرهٔ متره', cell: text(report.metadata.takeoffId) },
    ],
    table: { columns: TOTAL_COLUMNS, rows: totalRows(report.itemTotals) },
  };
}

const SHEET_TOTAL_COLUMNS: readonly WorkbookColumn[] = [
  { header: 'ترتیب برگه', width: 10, wrap: false },
  { header: 'نام برگه', width: 18, wrap: true },
  { header: 'شناسه برگه', width: 10, wrap: false },
  { header: 'کد آیتم', width: 14, wrap: false },
  { header: 'واحد', width: 9, wrap: false },
  { header: 'مقدار دقیق', width: 14, wrap: false },
  { header: 'مقدار گردشده', width: 14, wrap: false },
  { header: 'مقدار مؤثر (انتقال)', width: 18, wrap: false },
  { header: 'ردیف‌های مشارکت‌کننده', width: 30, wrap: true },
];

function sheetTotalsSheet(report: TakeoffReportModel): WorkbookSheetModel {
  const rows: WorkbookCell[][] = report.sheetTotals.flatMap((sheetTotal) =>
    sheetTotal.byItem.map((row): WorkbookCell[] => [
      int(sheetTotal.sheetOrder),
      text(sheetTotal.sheetName),
      text(sheetTotal.sheetId),
      row.itemCode === null ? text(UNCODED_LABEL) : text(row.itemCode),
      text(row.unit),
      text(row.exactQty),
      textOrNull(row.roundedQty),
      text(row.qty),
      joined(row.lineIds),
    ]),
  );
  return { name: 'جمع برگه‌ها', entries: [], table: { columns: SHEET_TOTAL_COLUMNS, rows } };
}

/**
 * Builds the takeoff workbook model: validates the report's structure first and fails
 * loudly (INVALID_REPORT_MODEL) on any violation. Sheet order is fixed: خلاصه، متره
 * تفصیلی، جمع آیتم‌ها، جمع برگه‌ها.
 */
export function buildTakeoffWorkbookModel(report: TakeoffReportModel): WorkbookModel {
  const errors = takeoffReportStructureErrors(report);
  if (errors.length > 0) {
    throw new ReportingExcelError(
      'INVALID_REPORT_MODEL',
      'the TakeoffReportModel failed the renderer structural validation; nothing is repaired',
      errors,
    );
  }
  return {
    sheets: [
      summarySheet(report),
      detailSheet(report),
      itemTotalsSheet(report),
      sheetTotalsSheet(report),
    ],
  };
}
