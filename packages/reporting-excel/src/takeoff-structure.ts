/**
 * Structural validation of a TakeoffReportModel (the Excel renderer's local mirror of
 * the PDF renderer's contract — the two renderer packages are intentionally siblings,
 * not a stack, exactly like the estimate branch's duplicated validators).
 *
 * No source objects, no recalculation, no summing of quantities: identity mirrors,
 * coverage, ordering, value shapes and finalized-only status. Returns every violation;
 * empty array = renderable. Never mutates, never repairs.
 */
import type { TakeoffReportModel } from '@costgenius/reporting';

/** Exact decimal literal (mirrors the estimate renderer's local contract copy). */
const EXACT_DECIMAL = /^-?\d+(\.\d+)?$/;

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

  const checkTotal = (total: unknown, field: string): void => {
    if (!isObject(total)) {
      add(`${field}: must be an object`);
      return;
    }
    const row = total as unknown as TakeoffReportModel['itemTotals'][number];
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
  const coded = (itemTotals as unknown[]).filter(
    (total) => isObject(total) && (total as { itemCode: unknown }).itemCode !== null,
  ).length;
  if (isPositiveInteger(metadata['codedItemCount']) && coded !== metadata['codedItemCount']) {
    add(
      `metadata.codedItemCount: itemTotals carry ${String(coded)} coded rows but metadata says ${String(metadata['codedItemCount'])}`,
    );
  }

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
