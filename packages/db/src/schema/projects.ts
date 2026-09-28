/**
 * `projects` — the Project entity (identity + metadata only; it can never influence a
 * number). `created_at` is stored as the exact domain Instant string (ISO-8601 UTC) so
 * the database never generates or reformats a timestamp (§ Phase 14 rule: no silent
 * clock). `project_id`/`organization_id` are validated UUIDs at the domain boundary and
 * re-validated on load.
 */
import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const projects = pgTable('projects', {
  projectId: uuid('project_id').primaryKey(),
  organizationId: uuid('organization_id'),
  title: text('title').notNull(),
  metadata: jsonb('metadata').$type<Record<string, string>>().notNull(),
  /** Domain Instant, stored verbatim (never database-generated). */
  createdAt: text('created_at').notNull(),
});
