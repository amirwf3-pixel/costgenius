/**
 * `users` / `sessions` — the P8-A governance tables (CG-GOV-SPEC@0.1.0 §7, migration
 * `0002_p8_governance`). Phase 8 S1: authentication/session identity ONLY — the `role`
 * column is part of the closed users contract (CHECK-constrained to the five
 * PROJECT_SCOPE §4 values); RBAC enforcement is S2 and does not exist yet.
 *
 * `users.username` is stored lowercase and UNIQUE (case-insensitive identity,
 * CG-GOV §1.1). `sessions.session_token_hash` is the SHA-256 hex of the opaque client
 * token — the raw token is NEVER persisted (CG-GOV §1.3). Sessions are the only
 * governance rows with a delete path (logout / password-change revocation / lazy
 * expiry cleanup); `users` rows are never deleted (deactivation is a flag, S2).
 *
 * The third table of migration 0002, `audit_events`, has no runtime schema here yet —
 * its writer arrives with the S3 audit stage; the table exists from day one so the
 * migration shape matches the closed contract (9 → 12 tables).
 */
import { sql } from 'drizzle-orm';
import { projects } from './projects.js';
import { boolean, check, index, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    userId: uuid('user_id').primaryKey(),
    /** Stored lowercase; UNIQUE (identity is case-insensitive, CG-GOV §1.1). */
    username: text('username').notNull(),
    /** `scrypt$N$r$p$salt$hash` (CG-GOV §1.2) — never serialized by any API route. */
    passwordHash: text('password_hash').notNull(),
    /** One of the five PROJECT_SCOPE §4 roles; no authorization logic exists in S1. */
    role: text('role').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** Domain Instant (UTC ISO string), stored verbatim — never database-generated. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    unique('users_username_key').on(table.username),
    check(
      'users_role_check',
      sql`${table.role} in ('org_admin', 'estimator', 'reviewer', 'viewer', 'data_steward')`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 hex of the 256-bit opaque client token — the raw token is never stored. */
    sessionTokenHash: text('session_token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId),
    /** Domain Instant (UTC ISO string) of login. */
    createdAt: text('created_at').notNull(),
    /** Absolute expiration (login + 12h); no idle timeout (CG-GOV §1.3). */
    expiresAt: text('expires_at').notNull(),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * `audit_events` — append-only governance history (CG-GOV §4/§7). The runtime table
 * definition is declared here so the schema matches migration 0002 exactly, but NO
 * repository or writer exists in S1 (that is the S3 audit stage; the migration also
 * REVOKEs UPDATE/DELETE from PUBLIC as the day-one DB-level defense).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    eventId: uuid('event_id').primaryKey(),
    at: text('at').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.userId),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    projectId: uuid('project_id').references(() => projects.projectId),
    details: jsonb('details').notNull().default({}),
  },
  (table) => [
    index('audit_events_at_idx').on(table.at),
    index('audit_events_resource_idx').on(table.resourceType, table.resourceId),
    index('audit_events_actor_user_id_idx').on(table.actorUserId),
  ],
);

// The `audit_events.project_id` FK (→ projects) is declared here since S4 — it has
// existed in the database from migration 0002 (the S1 snapshot metadata omitted it);
// the migration's REVOKE remains migration-SQL-only by design.
