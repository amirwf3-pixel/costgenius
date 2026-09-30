/**
 * `estimate_versions` — one row per EstimateVersion. Version numbers are sequential per
 * estimate and unique together with the estimate (append-only history). `status` is the
 * domain lifecycle ('draft' | 'finalized'); a finalized row is never updated or deleted
 * again (enforced by the repositories). All timestamps are exact domain Instant strings.
 *
 * P8-B S1 adds the additive `edition_id` (nullable text FK → `pricebook_editions`):
 * the version's immutable edition binding. The legacy `edition` text column KEEPS its
 * year-label semantics and bytes exactly (ReportModel, UI and goldens untouched);
 * `edition_id` carries exact identity so a same-year erratum can never be conflated
 * with the original. A binding, once set, is never changed (a migration trigger
 * enforces it); rows with no binding (all pre-P8-B work) are backfilled exactly once
 * by the first-boot seed, and new rows are stamped with the ACTIVE edition at insert
 * by the same trigger family — see migration 0004 and DEPLOYMENT.md.
 */
import { integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { estimates } from './estimates.js';
import { pricebookEditions } from './pricebook-editions.js';

export const estimateVersions = pgTable(
  'estimate_versions',
  {
    versionId: text('version_id').primaryKey(),
    estimateId: text('estimate_id')
      .notNull()
      .references(() => estimates.estimateId),
    versionNumber: integer('version_number').notNull(),
    status: text('status').notNull(),
    /** Domain Instant, stored verbatim (never database-generated). */
    createdAt: text('created_at').notNull(),
    edition: text('edition').notNull(),
    /** P8-B S1: the immutable edition binding (exact identity; null only before the backfill). */
    editionId: text('edition_id').references(() => pricebookEditions.editionId),
    buildingId: text('building_id'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull(),
  },
  (table) => [
    uniqueIndex('estimate_versions_estimate_number_key').on(table.estimateId, table.versionNumber),
  ],
);
