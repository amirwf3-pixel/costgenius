/**
 * `finalized_estimates` — the immutable finalization record of one version: the exact
 * coefficient inputs and result of S4, the authoritative BOQ rollup, and the rendering-
 * independent ReportModel snapshot, all preserved verbatim as jsonb (the report and the
 * S4 result are pure data; nothing here is ever recomputed). A row is written once and
 * never updated or deleted; replacing it with different content is
 * FINALIZED_ESTIMATE_IMMUTABLE, not an overwrite.
 */
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type { BoqRollup } from '@costgenius/boq';
import type { EstimateInput, EstimateResult } from '@costgenius/cost-calculation';
import type { ReportModel } from '@costgenius/reporting';
import { estimateVersions } from './estimate-versions.js';
import { estimates } from './estimates.js';

export const finalizedEstimates = pgTable('finalized_estimates', {
  versionId: text('version_id')
    .primaryKey()
    .references(() => estimateVersions.versionId),
  estimateId: text('estimate_id')
    .notNull()
    .references(() => estimates.estimateId),
  /** Domain Instant, stored verbatim (never database-generated). */
  finalizedAt: text('finalized_at').notNull(),
  /** The exact S4 input that produced the result (full deterministic replay record). */
  s4Input: jsonb('s4_input').$type<EstimateInput>().notNull(),
  /** The S4 result, verbatim from the engine. */
  s4Result: jsonb('s4_result').$type<EstimateResult>().notNull(),
  /** The authoritative BOQ rollup of the frozen lines. */
  rollup: jsonb('rollup').$type<BoqRollup>().notNull(),
  /** The ReportModel snapshot handed to the renderers. */
  reportModel: jsonb('report_model').$type<ReportModel>().notNull(),
});
