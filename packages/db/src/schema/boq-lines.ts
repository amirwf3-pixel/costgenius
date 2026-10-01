/**
 * `boq_lines` — one row per BOQ line, the frozen S2/S3 snapshot of one pricebook row.
 *
 * Business numbers (`quantity`, `base_price`, `line_amount`) are PostgreSQL `numeric`
 * read/written as exact decimal STRINGS through Drizzle — no float, no rounding, no
 * coercion; `123456789012345678000001` round-trips losslessly. A blank price is NULL and
 * stays NULL (220925, Appendix-5 rows) — never 0. `pricebook_code` is text, so leading
 * zeros survive ('010101'). The embedded structures (sourceRef, trace, notes,
 * dependencies) are stored as jsonb snapshots, copied verbatim.
 */
import { boolean, integer, jsonb, numeric, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import type { BoqLineTrace } from '@costgenius/boq';
import type { SourceReference } from '@costgenius/pricebook';
import { estimateVersions } from './estimate-versions.js';

export const boqLines = pgTable(
  'boq_lines',
  {
    versionId: text('version_id')
      .notNull()
      .references(() => estimateVersions.versionId),
    /** Insertion order within the version (deterministic reload ordering). */
    lineIndex: integer('line_index').notNull(),
    lineId: text('line_id').notNull(),
    pricebookCode: text('pricebook_code').notNull(),
    chapter: text('chapter').notNull(),
    /** The pricebook group number as printed (text; `group` is a reserved SQL word). */
    groupNumber: text('group_number').notNull(),
    description: text('description').notNull(),
    unitLabel: text('unit_label').notNull(),
    unitCode: text('unit_code').notNull(),
    /** Exact decimal string (numeric column, string-typed). */
    quantity: numeric('quantity').notNull(),
    /** Exact decimal string, or NULL when the source prints no price (blank ≠ zero). */
    basePrice: numeric('base_price'),
    /** Exact decimal string, or NULL when the line is not priced (blocked rows). */
    lineAmount: numeric('line_amount'),
    pricebookStatus: text('pricebook_status').notNull(),
    calculationStatus: text('calculation_status').notNull(),
    sourceRef: jsonb('source_ref').$type<SourceReference>().notNull(),
    edition: text('edition').notNull(),
    externalDependencies: jsonb('external_dependencies').$type<string[]>().notNull(),
    notes: jsonb('notes').$type<string[]>().notNull(),
    trace: jsonb('trace').$type<BoqLineTrace>().notNull(),
    buildingId: text('building_id'),
    landscaping: boolean('landscaping'),
  },
  (table) => [primaryKey({ columns: [table.versionId, table.lineId] })],
);
