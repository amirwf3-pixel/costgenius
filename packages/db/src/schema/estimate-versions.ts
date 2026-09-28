/**
 * `estimate_versions` — one row per EstimateVersion. Version numbers are sequential per
 * estimate and unique together with the estimate (append-only history). `status` is the
 * domain lifecycle ('draft' | 'finalized'); a finalized row is never updated or deleted
 * again (enforced by the repositories). All timestamps are exact domain Instant strings.
 */
import { integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { estimates } from './estimates.js';

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
    buildingId: text('building_id'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull(),
  },
  (table) => [
    uniqueIndex('estimate_versions_estimate_number_key').on(table.estimateId, table.versionNumber),
  ],
);
