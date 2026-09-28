/**
 * `estimates` — the Estimate aggregate root (identity + project relation). `estimate_id`
 * is a domain string identity (not necessarily a UUID), so it is stored as text. The
 * project row must exist first (relational integrity; the workflow persists the project
 * in its own transaction before any estimate).
 */
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

export const estimates = pgTable('estimates', {
  estimateId: text('estimate_id').primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.projectId),
  title: text('title').notNull(),
});
