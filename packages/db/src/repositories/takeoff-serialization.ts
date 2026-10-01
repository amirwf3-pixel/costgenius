/**
 * Row ↔ domain serialization for the D-016 takeoff tables.
 *
 * Field-for-field and lossless (CG-FT §16 round-trip): the sheet/line rows ARE the engine
 * input shapes — `quantity` stays the verbatim closed expression tree, the rounding rule
 * set stays the verbatim §6 rule array, domain Instants round-trip byte-identically, and
 * optional fields stay absent (exactOptionalPropertyTypes) rather than becoming null on
 * the domain side. IDs and enums are re-validated on load so a corrupted row fails loudly.
 */
import type {
  TakeoffDocument,
  TakeoffDocumentSheet,
  TakeoffDocumentStatus,
} from '@costgenius/projects';
import type {
  finalizedTakeoffs,
  takeoffDocuments,
  takeoffLines,
  takeoffSheets,
} from '../schema/index.js';
import { validateInstant } from './serialization.js';

export type TakeoffDocumentRow = typeof takeoffDocuments.$inferSelect;
export type TakeoffDocumentInsert = typeof takeoffDocuments.$inferInsert;
export type TakeoffSheetRow = typeof takeoffSheets.$inferSelect;
export type TakeoffSheetInsert = typeof takeoffSheets.$inferInsert;
export type TakeoffLineRow = typeof takeoffLines.$inferSelect;
export type TakeoffLineInsert = typeof takeoffLines.$inferInsert;
export type FinalizedTakeoffRow = typeof finalizedTakeoffs.$inferSelect;
export type FinalizedTakeoffInsert = typeof finalizedTakeoffs.$inferInsert;

const STATUSES: readonly string[] = ['draft', 'archived', 'finalized'];

export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}

function parseStatus(value: string): TakeoffDocumentStatus {
  if (!STATUSES.includes(value)) {
    throw new Error(`persisted takeoff status "${value}" is not one of draft|archived|finalized`);
  }
  return value as TakeoffDocumentStatus;
}

export interface SheetWithLines {
  readonly sheet: TakeoffSheetRow;
  readonly lines: readonly TakeoffLineRow[];
}

export function takeoffDocumentFromRows(
  row: TakeoffDocumentRow,
  sheets: readonly SheetWithLines[],
): TakeoffDocument {
  const document: TakeoffDocument = {
    documentId: row.documentId,
    takeoffId: row.takeoffId,
    projectId: row.projectId,
    title: row.title,
    documentNumber: row.documentNumber,
    status: parseStatus(row.status),
    revision: row.revision,
    rounding: structuredClone(row.roundingRuleSet),
    sheets: sheets.map(({ sheet, lines }) => ({
      sheetId: sheet.sheetId,
      name: sheet.name,
      lines: lines.map((line) => ({
        lineId: line.lineId,
        rowNo: line.rowNo,
        description: line.description,
        ...(line.location !== null ? { location: line.location } : {}),
        ...(line.itemCode !== null ? { itemCode: line.itemCode } : {}),
        kind: line.kind as 'addition' | 'deduction',
        unit: line.unit,
        quantity: structuredClone(line.quantity),
        ...(line.notes !== null ? { notes: line.notes } : {}),
        ...(line.origin !== null
          ? { origin: line.origin as 'user' | 'import' | 'ai-accepted' }
          : {}),
        ...(line.ruleRefs !== null ? { ruleRefs: structuredClone(line.ruleRefs) } : {}),
      })),
    })),
    createdAt: validateInstant(row.createdAt, 'takeoffDocument.createdAt'),
    ...(row.archivedAt !== null
      ? { archivedAt: validateInstant(row.archivedAt, 'takeoffDocument.archivedAt') }
      : {}),
    ...(row.finalizedAt !== null
      ? { finalizedAt: validateInstant(row.finalizedAt, 'takeoffDocument.finalizedAt') }
      : {}),
  };
  return deepFreeze(document);
}

export function takeoffDocumentToRow(document: TakeoffDocument): TakeoffDocumentInsert {
  return {
    documentId: document.documentId,
    takeoffId: document.takeoffId,
    projectId: document.projectId,
    title: document.title,
    documentNumber: document.documentNumber,
    status: document.status,
    revision: document.revision,
    roundingRuleSet: structuredClone(document.rounding),
    createdAt: document.createdAt,
    archivedAt: document.archivedAt ?? null,
    finalizedAt: document.finalizedAt ?? null,
  };
}

export function takeoffSheetToRow(
  documentId: string,
  sheetOrder: number,
  sheet: TakeoffDocumentSheet,
): TakeoffSheetInsert {
  return {
    documentId,
    sheetId: sheet.sheetId,
    name: sheet.name,
    sheetOrder,
  };
}

export function takeoffLineToRow(
  documentId: string,
  sheetId: string,
  line: TakeoffDocumentSheet['lines'][number],
): TakeoffLineInsert {
  return {
    documentId,
    lineId: line.lineId,
    sheetId,
    rowNo: line.rowNo,
    description: line.description,
    location: line.location ?? null,
    itemCode: line.itemCode ?? null,
    kind: line.kind,
    unit: line.unit,
    quantity: structuredClone(line.quantity),
    notes: line.notes ?? null,
    origin: line.origin ?? null,
    ruleRefs: line.ruleRefs === undefined ? null : [...line.ruleRefs],
  };
}
