/**
 * The pure TakeoffReportModel → PDF-document-model mapping (stage 2a, takeoff branch —
 * D-016 Phase 6, G6=A).
 *
 * No business logic: no quantity resolution, no recalculation, no aggregation, no
 * rounding. Every value is copied verbatim from the takeoff report model; `null`/absent
 * values become `null` model cells (rendered as the '—' placeholder — never 0). The
 * structural validation mirrors the estimate renderer's contract: identity mirrors,
 * coverage, ordering and value shapes — WITHOUT source objects and without summing one
 * quantity.
 *
 * Section order is fixed (the standard V1 template): خلاصه (portrait, document metadata
 * + rounding rules) → متره تفصیلی (landscape, one block per sheet) → جمع‌ها (portrait,
 * item totals + per-sheet totals).
 */
import type { TakeoffReportModel, TakeoffReportTotalRow } from '@costgenius/reporting';
import { ReportingPdfError } from './errors.js';
import type { KeyValueRow, PdfDocumentModel, PdfSection, TableColumn } from './types.js';

/** Deterministic delimiter for multi-value cells (contributing lineIds). */
export const TAKEOFF_CELL_DELIMITER = '، ';

const KIND_LABELS: Readonly<Record<string, string>> = {
  addition: 'افزایش',
  deduction: 'کسر',
};

/** Exact decimal literal (mirrors the estimate renderer's local contract copy). */
const EXACT_DECIMAL = /^-?\d+(\.\d+)?$/;

// ---- structural validation (fail loudly; never repair) ----------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function checkDecimal(errors: string[], field: string, value: unknown, optional: boolean): void {
  if (value === null) {
    if (!optional) errors.push(`${field}: must carry an exact decimal string (never null)`);
    return;
  }
  if (!isNonEmptyString(value) || !EXACT_DECIMAL.test(value)) {
    const shown = typeof value === 'string' ? `"${value}"` : `a ${typeof value}`;
    errors.push(`${field}: ${shown} is not an exact decimal string`);
  }
}

/**
 * Validates the takeoff report's internal structure (no external sources are available
 * to a renderer). Returns every violation; empty array = renderable. Never mutates.
 */
export function takeoffReportStructureErrors(report: TakeoffReportModel): string[] {
  const errors: string[] = [];
  const add = (message: string): void => {
    errors.push(message);
  };

  if (!isObject(report)) return ['report: must be an object'];
  if (!isNonEmptyString(report['reportId'])) add('reportId: must be a non-empty string');
  const metadata = report['metadata'];
  const sheets = report['sheets'];
  const itemTotals = report['itemTotals'];
  const sheetTotals = report['sheetTotals'];
  const rounding = report['rounding'];
  const provenance = report['generatedFrom'];
  if (
    !isObject(metadata) ||
    !Array.isArray(sheets) ||
    !Array.isArray(itemTotals) ||
    !Array.isArray(sheetTotals) ||
    !Array.isArray(rounding) ||
    !isObject(provenance)
  ) {
    if (!isObject(metadata)) add('metadata: must be an object');
    if (!Array.isArray(sheets)) add('sheets: must be an array');
    if (!Array.isArray(itemTotals)) add('itemTotals: must be an array');
    if (!Array.isArray(sheetTotals)) add('sheetTotals: must be an array');
    if (!Array.isArray(rounding)) add('rounding: must be an array');
    if (!isObject(provenance)) add('generatedFrom: must be an object');
    return errors;
  }

  // ---- metadata (identity + versions) ---------------------------------------------------------
  for (const field of [
    'reportId',
    'documentId',
    'takeoffId',
    'projectId',
    'title',
    'status',
    'createdAt',
    'finalizedAt',
    'specId',
    'specVersion',
    'engineVersion',
  ] as const) {
    if (!isNonEmptyString(metadata[field])) add(`metadata.${field}: must be a non-empty string`);
  }
  if (metadata['projectTitle'] !== null && !isNonEmptyString(metadata['projectTitle'])) {
    add('metadata.projectTitle: must be a non-empty string or null');
  }
  for (const field of ['documentNumber', 'revision', 'sheetCount', 'lineCount'] as const) {
    if (!isPositiveInteger(metadata[field])) add(`metadata.${field}: must be a positive integer`);
  }
  for (const field of ['codedItemCount', 'uncodedItemCount'] as const) {
    const value = metadata[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      add(`metadata.${field}: must be a non-negative integer`);
    }
  }
  if (isNonEmptyString(report['reportId']) && metadata['reportId'] !== report['reportId']) {
    add('metadata.reportId: must equal the report reportId');
  }
  if (isNonEmptyString(metadata['status']) && metadata['status'] !== 'finalized') {
    add('metadata.status: a takeoff report must be finalized (reports are finalized-only)');
  }

  // ---- sheets / lines ---------------------------------------------------------------------------
  const seenLineIds = new Set<string>();
  let lineCount = 0;
  for (const [s, sheetUnknown] of (sheets as unknown[]).entries()) {
    if (!isObject(sheetUnknown)) {
      add(`sheets[${String(s)}]: must be an object`);
      continue;
    }
    const sheet = sheetUnknown as unknown as TakeoffReportModel['sheets'][number];
    const sField = `sheets[${String(s)}]`;
    if (!isPositiveInteger(sheet.sheetOrder) || sheet.sheetOrder !== s + 1) {
      add(`${sField}.sheetOrder: must be the 1-based sheet position`);
    }
    if (!isNonEmptyString(sheet.sheetId)) add(`${sField}.sheetId: must be a non-empty string`);
    if (!isNonEmptyString(sheet.sheetName)) add(`${sField}.sheetName: must be a non-empty string`);
    if (!Array.isArray(sheet.lines)) {
      add(`${sField}.lines: must be an array`);
      continue;
    }
    lineCount += sheet.lines.length;
    for (const [l, lineUnknown] of sheet.lines.entries()) {
      if (!isObject(lineUnknown)) {
        add(`${sField}.lines[${String(l)}]: must be an object`);
        continue;
      }
      const line = lineUnknown as unknown as TakeoffReportModel['sheets'][number]['lines'][number];
      const lField = `line ${line.lineId}`;
      if (!isNonEmptyString(line.lineId)) {
        add(`${sField}.lines[${String(l)}].lineId: must be a non-empty string`);
        continue;
      }
      if (seenLineIds.has(line.lineId)) add(`${lField}: appears more than once in the report`);
      seenLineIds.add(line.lineId);
      if (!isPositiveInteger(line.rowNo)) add(`${lField}.rowNo: must be a positive integer`);
      if (!isNonEmptyString(line.description))
        add(`${lField}.description: must be a non-empty string`);
      if (!isNonEmptyString(line.unit)) add(`${lField}.unit: must be a non-empty string`);
      if (!isNonEmptyString(line.formula))
        add(`${lField}.formula: the §6.3 display must be a non-empty string`);
      if (!isNonEmptyString(line.quantityType))
        add(`${lField}.quantityType: must be a non-empty string`);
      if (!(line.kind === 'addition' || line.kind === 'deduction')) {
        add(`${lField}.kind: must be "addition" or "deduction"`);
      }
      checkDecimal(errors, `${lField}.exactMagnitude`, line.exactMagnitude, false);
      checkDecimal(errors, `${lField}.roundedMagnitude`, line.roundedMagnitude, true);
      checkDecimal(errors, `${lField}.signedValue`, line.signedValue, false);
      for (const factor of ['floorCount', 'similarCount'] as const) {
        if (line[factor] !== null && !isNonEmptyString(line[factor])) {
          add(`${lField}.${factor}: must be a non-empty string or null (never a hidden 1)`);
        }
      }
    }
  }
  if (isPositiveInteger(metadata['lineCount']) && lineCount !== metadata['lineCount']) {
    add(
      `metadata.lineCount: the sheets carry ${String(lineCount)} lines but metadata.lineCount says ${String(metadata['lineCount'])}`,
    );
  }

  // ---- totals (engine order, uncoded visible) ----------------------------------------------------
  const checkTotal = (total: unknown, field: string): total is TakeoffReportTotalRow => {
    if (!isObject(total)) {
      add(`${field}: must be an object`);
      return false;
    }
    const row = total as unknown as TakeoffReportTotalRow;
    if (row.itemCode !== null && !isNonEmptyString(row.itemCode)) {
      add(`${field}.itemCode: must be a non-empty string or null (never an invented code)`);
    }
    if (!isNonEmptyString(row.unit)) add(`${field}.unit: must be a non-empty string`);
    checkDecimal(errors, `${field}.exactQty`, row.exactQty, false);
    checkDecimal(errors, `${field}.roundedQty`, row.roundedQty, true);
    checkDecimal(errors, `${field}.qty`, row.qty, false);
    if (!Array.isArray(row.lineIds) || row.lineIds.length === 0) {
      add(`${field}.lineIds: must be a non-empty array (provenance preserved)`);
    }
    return true;
  };
  for (const [t, totalUnknown] of (itemTotals as unknown[]).entries()) {
    checkTotal(totalUnknown, `itemTotals[${String(t)}]`);
  }
  for (const [t, sheetTotalUnknown] of (sheetTotals as unknown[]).entries()) {
    if (!isObject(sheetTotalUnknown)) {
      add(`sheetTotals[${String(t)}]: must be an object`);
      continue;
    }
    const sheetTotal = sheetTotalUnknown as unknown as TakeoffReportModel['sheetTotals'][number];
    const tField = `sheetTotals[${String(t)}]`;
    if (!isNonEmptyString(sheetTotal.sheetId)) add(`${tField}.sheetId: must be a non-empty string`);
    if (!isNonEmptyString(sheetTotal.sheetName))
      add(`${tField}.sheetName: must be a non-empty string`);
    if (!isPositiveInteger(sheetTotal.sheetOrder))
      add(`${tField}.sheetOrder: must be a positive integer`);
    if (!Array.isArray(sheetTotal.byItem)) add(`${tField}.byItem: must be an array`);
  }
  if (
    isPositiveInteger(metadata['codedItemCount']) ||
    isPositiveInteger(metadata['uncodedItemCount'])
  ) {
    const coded = (itemTotals as unknown[]).filter(
      (total) => isObject(total) && (total as { itemCode: unknown }).itemCode !== null,
    ).length;
    if (isPositiveInteger(metadata['codedItemCount']) && coded !== metadata['codedItemCount']) {
      add(
        `metadata.codedItemCount: itemTotals carry ${String(coded)} coded rows but metadata says ${String(metadata['codedItemCount'])}`,
      );
    }
  }

  // ---- rounding rules ---------------------------------------------------------------------------
  for (const [r, ruleUnknown] of (rounding as unknown[]).entries()) {
    if (!isObject(ruleUnknown)) {
      add(`rounding[${String(r)}]: must be an object`);
      continue;
    }
    const rule = ruleUnknown as unknown as TakeoffReportModel['rounding'][number];
    const rField = `rounding[${String(r)}]`;
    if (!isNonEmptyString(rule.target)) add(`${rField}.target: must be a non-empty string`);
    if (!isNonEmptyString(rule.mode)) add(`${rField}.mode: must be a non-empty string`);
    if (!isNonEmptyString(rule.sourceStatus))
      add(`${rField}.sourceStatus: must be a non-empty string`);
    if (
      typeof rule.scale !== 'number' ||
      !Number.isInteger(rule.scale) ||
      rule.scale < 0 ||
      rule.scale > 20
    ) {
      add(`${rField}.scale: must be an integer 0..20`);
    }
  }

  // ---- provenance mirrors -------------------------------------------------------------------------
  const document = provenance['document'];
  const result = provenance['result'];
  if (!isObject(document) || document['documentId'] !== metadata['documentId']) {
    add('generatedFrom.document.documentId: must mirror metadata.documentId');
  }
  if (!isObject(result) || result['specVersion'] !== metadata['specVersion']) {
    add('generatedFrom.result.specVersion: must mirror metadata.specVersion');
  }

  return errors;
}

// ---- document model construction ---------------------------------------------------------------

const col = (header: string, width: number): TableColumn => ({ header, width });

/** Portrait خلاصه: the document-level rounding rule set. */
const ROUNDING_COLUMNS: readonly TableColumn[] = [
  col('هدف', 90),
  col('انتخاب‌گر', 120),
  col('دقت', 35),
  col('روش', 70),
  col('منشأ', 55),
  col('منبع', 110),
];

/** Landscape متره تفصیلی: one table per sheet (usable landscape width ≈ 762pt). */
const LINE_COLUMNS: readonly TableColumn[] = [
  col('ردیف', 26),
  col('شناسه', 40),
  col('شرح', 108),
  col('محل', 36),
  col('کد آیتم', 42),
  col('نوع', 30),
  col('نوع مقدار', 34),
  col('واحد', 30),
  col('فرمول (§6.3)', 96),
  col('طبقات', 26),
  col('مشابه', 26),
  col('مقدار دقیق', 40),
  col('مقدار گردشده', 40),
  col('با علامت', 40),
  col('دلیل دستی', 56),
  col('یادداشت', 40),
  col('لنگر ردیابی', 42),
];

/** Portrait جمع‌ها: item totals and per-sheet totals (usable portrait width ≈ 515pt). */
const TOTAL_COLUMNS: readonly TableColumn[] = [
  col('کد آیتم', 80),
  col('واحد', 45),
  col('مقدار دقیق', 62),
  col('مقدار گردشده', 62),
  col('مقدار مؤثر (انتقال)', 72),
  col('ردیف‌های مشارکت‌کننده', 130),
];

const UNCODED_LABEL = 'بدون کد';

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function joinedOr(ids: readonly string[]): string | null {
  return ids.length === 0 ? null : ids.join(TAKEOFF_CELL_DELIMITER);
}

function statusLabel(status: string): string {
  return status === 'finalized' ? 'نهایی‌شده (finalized)' : status;
}

function summaryRows(report: TakeoffReportModel): KeyValueRow[] {
  const m = report.metadata;
  return [
    { field: 'شناسه گزارش', value: m.reportId },
    { field: 'عنوان سند', value: m.title },
    { field: 'پروژه', value: m.projectTitle },
    { field: 'شناسه پروژه', value: m.projectId },
    { field: 'شناسه سند', value: m.documentId },
    { field: 'زنجیرهٔ متره', value: m.takeoffId },
    { field: 'شمارهٔ سند', value: String(m.documentNumber) },
    { field: 'وضعیت', value: statusLabel(m.status) },
    { field: 'نسخهٔ سند (revision)', value: String(m.revision) },
    { field: 'تاریخ ایجاد', value: m.createdAt },
    { field: 'زمان نهایی‌سازی', value: m.finalizedAt },
    { field: 'مشخصات اندازه‌گیری', value: `${m.specId}@${m.specVersion}` },
    { field: 'نسخهٔ موتور محاسبه', value: m.engineVersion },
    { field: 'تعداد برگه‌ها', value: String(m.sheetCount) },
    { field: 'تعداد ردیف‌ها', value: String(m.lineCount) },
    { field: 'اقلام کددار', value: String(m.codedItemCount) },
    { field: 'اقلام بدون کد', value: String(m.uncodedItemCount) },
  ];
}

function roundingRows(report: TakeoffReportModel): readonly (readonly (string | null)[])[] {
  return report.rounding.map((rule) => [
    rule.target,
    rule.selector ?? 'همه',
    String(rule.scale),
    rule.mode,
    rule.sourceStatus,
    rule.source,
  ]);
}

function totalRows(
  rows: readonly TakeoffReportTotalRow[],
): readonly (readonly (string | null)[])[] {
  return rows.map((row) => [
    row.itemCode === null ? UNCODED_LABEL : row.itemCode,
    row.unit,
    row.exactQty,
    row.roundedQty,
    row.qty,
    joinedOr(row.lineIds),
  ]);
}

/**
 * Builds the takeoff PDF document model: validates structure first and fails loudly
 * (INVALID_REPORT_MODEL). Section order is fixed — خلاصه (portrait) → متره تفصیلی
 * (landscape, per-sheet blocks) → جمع‌ها (portrait).
 */
export function buildTakeoffPdfDocumentModel(report: TakeoffReportModel): PdfDocumentModel {
  const errors = takeoffReportStructureErrors(report);
  if (errors.length > 0) {
    throw new ReportingPdfError(
      'INVALID_REPORT_MODEL',
      'the TakeoffReportModel failed the renderer structural validation; nothing is repaired',
      errors,
    );
  }
  const m = report.metadata;

  const summarySection: PdfSection = {
    orientation: 'portrait',
    blocks: [
      { kind: 'heading', level: 1, text: `گزارش صورت‌برداشت — ${m.title}` },
      { kind: 'heading', level: 2, text: 'مشخصات سند' },
      { kind: 'key-value', rows: summaryRows(report) },
      { kind: 'heading', level: 2, text: `قواعد گرد کردن سند (${String(report.rounding.length)})` },
      ...(report.rounding.length === 0
        ? [
            {
              kind: 'paragraph',
              text: 'قاعده‌ای تعریف نشده — همهٔ مقادیر دقیق می‌مانند و هیچ مقدار گردشده‌ای وجود ندارد.',
            } as const,
          ]
        : [
            {
              kind: 'table',
              title: 'قواعد گرد کردن',
              table: { columns: ROUNDING_COLUMNS, rows: roundingRows(report) },
            } as const,
          ]),
      {
        kind: 'paragraph',
        text: 'مقدار دقیق همیشه مرجع است؛ مقدار گردشده مشتق است و فقط وقتی ظاهر می‌شود که قاعده‌ای هم‌خوان شده باشد. «مقدار مؤثر» همان مقدار انتقال به برآورد است (R2=C) و تجمیع همیشه از مقادیر دقیق انجام می‌شود.',
      },
    ],
  };

  const detailSection: PdfSection = {
    orientation: 'landscape',
    blocks: [
      { kind: 'heading', level: 2, text: 'متره تفصیلی' },
      ...report.sheets.flatMap((sheet) => [
        {
          kind: 'heading',
          level: 3,
          text: `برگهٔ ${String(sheet.sheetOrder)} — ${sheet.sheetName} (${String(sheet.lines.length)} ردیف)`,
        } as const,
        {
          kind: 'table',
          title: `${sheet.sheetName} — ${sheet.sheetId}`,
          table: {
            columns: LINE_COLUMNS,
            rows: sheet.lines.map((line) => [
              String(line.rowNo),
              line.lineId,
              line.description,
              line.location,
              line.itemCode,
              kindLabel(line.kind),
              line.quantityType,
              line.unit,
              line.formula,
              line.floorCount,
              line.similarCount,
              line.exactMagnitude,
              line.roundedMagnitude,
              line.signedValue,
              line.manualJustification,
              line.notes,
              line.traceRuleId,
            ]),
          },
        } as const,
      ]),
    ],
  };

  const totalsSection: PdfSection = {
    orientation: 'portrait',
    blocks: [
      { kind: 'heading', level: 2, text: 'جمع آیتم‌ها (بر پایهٔ کد)' },
      {
        kind: 'table',
        title: 'جمع آیتم‌ها',
        table: { columns: TOTAL_COLUMNS, rows: totalRows(report.itemTotals) },
      },
      { kind: 'heading', level: 2, text: 'جمع برگه‌ها' },
      ...report.sheetTotals.flatMap((sheetTotal) => [
        {
          kind: 'heading',
          level: 3,
          text: `برگهٔ ${String(sheetTotal.sheetOrder)} — ${sheetTotal.sheetName}`,
        } as const,
        {
          kind: 'table',
          title: `${sheetTotal.sheetName} — ${sheetTotal.sheetId}`,
          table: { columns: TOTAL_COLUMNS, rows: totalRows(sheetTotal.byItem) },
        } as const,
      ]),
    ],
  };

  return {
    title: `گزارش صورت‌برداشت ${m.title} — ${m.documentId}`,
    sections: [summarySection, detailSection, totalsSection],
  };
}
