/**
 * `takeoff_documents` / `takeoff_sheets` / `takeoff_lines` / `finalized_takeoffs` — the
 * D-016 Full Takeoff resource family (CG-FT-TAKEOFF-SPEC@0.1.0 §3). A document is one
 * member of a takeoff chain: (`takeoff_id`, `document_number`) is unique, `document_id`
 * is the per-revision identity used by the API and provenance, and `revision` is the
 * optimistic-concurrency counter of the editable draft (G4=B). Status is the three-state
 * lifecycle draft|archived|finalized (G1b=C soft archive; finalized is immutable). The
 * rounding rule set is the explicit document-level CG-IR-MEAS@0.2.0 §6 rule set, stored
 * verbatim as JSONB (never a derived or flattened variant).
 *
 * Sheets and lines store the ENGINE input shapes verbatim (the line `quantity` JSONB is
 * the closed expression tree), so loading a document reconstructs the exact
 * `calculateTakeoff` input without semantic loss. Draft content replacement deletes and
 * re-inserts the sheet/line rows of that draft inside the writing transaction (cascading
 * FKs prevent orphans); finalized and archived rows are never rewritten, and nothing in
 * the family is ever hard-deleted.
 *
 * `finalized_takeoffs` mirrors `finalized_estimates`: written once, byte-compared on
 * re-save, never updated or deleted. It carries the exact engine input and the verbatim
 * `TakeoffResult`, so the finalized takeoff is fully reproducible/reportable without
 * reading any mutable draft row.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  RoundingRuleSet,
  TakeoffCalculationInput,
  TakeoffLineInput,
  TakeoffResult,
} from '@costgenius/projects';
import { projects } from './projects.js';

export const takeoffDocuments = pgTable(
  'takeoff_documents',
  {
    documentId: text('document_id').primaryKey(),
    /** Chain identity — stable across all revisions of one takeoff. */
    takeoffId: text('takeoff_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId),
    title: text('title').notNull(),
    /** Sequential within the chain (follow-up revisions continue it). */
    documentNumber: integer('document_number').notNull(),
    /** 'draft' | 'archived' | 'finalized' (CG-FT §2.1; enforced by CHECK and the writer). */
    status: text('status').notNull(),
    /** Optimistic-concurrency counter; starts at 1, +1 per draft content save. */
    revision: integer('revision').notNull(),
    /** The document-level RoundingRuleSet (CG-IR-MEAS@0.2.0 §6), verbatim. */
    roundingRuleSet: jsonb('rounding_rule_set').$type<RoundingRuleSet>().notNull(),
    /** Domain Instant, stored verbatim (never database-generated). */
    createdAt: text('created_at').notNull(),
    /** Domain Instant of the soft archive (G1b=C), when archived. */
    archivedAt: text('archived_at'),
    /** Domain Instant of finalization, when finalized. */
    finalizedAt: text('finalized_at'),
  },
  (table) => [
    uniqueIndex('takeoff_documents_chain_number_key').on(table.takeoffId, table.documentNumber),
    check(
      'takeoff_documents_status_check',
      sql`${table.status} in ('draft', 'archived', 'finalized')`,
    ),
    check('takeoff_documents_revision_check', sql`${table.revision} >= 1`),
  ],
);

export const takeoffSheets = pgTable(
  'takeoff_sheets',
  {
    documentId: text('document_id')
      .notNull()
      .references(() => takeoffDocuments.documentId, { onDelete: 'cascade' }),
    /** Stable sheet identity, unique within the document (engine V1). */
    sheetId: text('sheet_id').notNull(),
    name: text('name').notNull(),
    /** Presentation order within the document (1-based array position on load). */
    sheetOrder: integer('sheet_order').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.sheetId] }),
    uniqueIndex('takeoff_sheets_document_order_key').on(table.documentId, table.sheetOrder),
  ],
);

export const takeoffLines = pgTable(
  'takeoff_lines',
  {
    documentId: text('document_id').notNull(),
    /** Stable line identity, unique within the document (engine V1; references use it). */
    lineId: text('line_id').notNull(),
    sheetId: text('sheet_id').notNull(),
    /** Display row number (ردیف); unique within the sheet (engine V1); may be renumbered. */
    rowNo: integer('row_no').notNull(),
    description: text('description').notNull(),
    location: text('location'),
    /** Opaque price-book code; S1 never interprets it (V12). */
    itemCode: text('item_code'),
    kind: text('kind').notNull(),
    unit: text('unit').notNull(),
    /** The closed quantity expression tree (CG-IR-MEAS@0.2.0 §4), stored verbatim. */
    quantity: jsonb('quantity').$type<TakeoffLineInput['quantity']>().notNull(),
    notes: text('notes'),
    origin: text('origin'),
    /** Claimed MeasurementRule ids (advisory, §9); echoed in the trace. */
    ruleRefs: jsonb('rule_refs').$type<string[]>(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.lineId] }),
    foreignKey({
      columns: [table.documentId, table.sheetId],
      foreignColumns: [takeoffSheets.documentId, takeoffSheets.sheetId],
      name: 'takeoff_lines_sheet_fk',
    }).onDelete('cascade'),
    uniqueIndex('takeoff_lines_sheet_row_key').on(table.documentId, table.sheetId, table.rowNo),
  ],
);

export const finalizedTakeoffs = pgTable('finalized_takeoffs', {
  documentId: text('document_id')
    .primaryKey()
    .references(() => takeoffDocuments.documentId),
  takeoffId: text('takeoff_id').notNull(),
  documentNumber: integer('document_number').notNull(),
  /** Domain Instant, stored verbatim (never database-generated). */
  finalizedAt: text('finalized_at').notNull(),
  /** CG-IR-MEAS spec version of the result (engine stamp). */
  specVersion: text('spec_version').notNull(),
  /** Engine version of the result (engine stamp). */
  engineVersion: text('engine_version').notNull(),
  /** The exact `calculateTakeoff` input that produced the result (replay record). */
  input: jsonb('input').$type<TakeoffCalculationInput>().notNull(),
  /** The engine result, verbatim (exact and rounded values, traces, totals). */
  result: jsonb('result').$type<TakeoffResult>().notNull(),
});
