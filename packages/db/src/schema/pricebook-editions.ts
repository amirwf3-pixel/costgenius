/**
 * `pricebook_editions` — the persistent pricebook edition registry (P8-B S1,
 * CG-IR-PRICEBOOK-SPEC@0.2.0 §18, migration `0004_p8b_pricebook_editions`).
 *
 * One row per imported edition, immutable from the moment of import: everything except
 * the lifecycle columns (`status`, `activated_by`/`activated_at`, `archived_by`/
 * `archived_at`) never changes — a change is a NEW edition (new `content_hash`, new
 * row, `supersedes_edition_id` link). There is no delete: estimates reference editions
 * forever (reproducibility, D-005/§14).
 *
 * The `content` JSONB column stores the CANONICAL SEMANTIC CONTENT of the edition
 * (the validated staged-import payload: the edition metadata block and the rows, in
 * file order) — not the raw bytes of any file. Byte-level fidelity of the source
 * artifact is `source_file_hash` + operational custody (D-PB-5 = A); dataset identity
 * is `content_hash` (SHA-256 of `canonicalJson(content)`), recomputed from the stored
 * content at every load. The 1404 dataset carries no numeric leaves, so JSONB
 * round-trips its content exactly.
 *
 * Exactly 0-or-1 ACTIVE editions per discipline is enforced by the PARTIAL UNIQUE
 * INDEX below — the database, not application discipline, is the authority (§9).
 * The migration additionally installs BEFORE UPDATE/DELETE guards that make the
 * immutability hold even for the table owner (PostgreSQL ownership bypasses
 * GRANT/REVOKE — see migration 0004 and DEPLOYMENT.md).
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { CanonicalEditionContent, ImportReport } from '@costgenius/pricebook';
import { users } from './users.js';

export const pricebookEditions = pgTable(
  'pricebook_editions',
  {
    /** Stable handle: 'ir-1404-abniye', 'ir-1404-abniye-err1', … */
    editionId: text('edition_id').primaryKey(),
    /** V1 is ابنیه only (CHECK-constrained). */
    discipline: text('discipline').notNull(),
    /** Jalali year as published ('1404') — the human-facing label, never identity. */
    year: text('year').notNull(),
    /** Title as printed. */
    title: text('title').notNull(),
    /** Organization as printed. */
    organization: text('organization').notNull(),
    /** Notification number as printed; null when the source prints none. */
    notificationNumber: text('notification_number'),
    /** Notification date (Jalali) as printed; null when the source prints none. */
    notificationDate: text('notification_date'),
    /** Provenance: SHA-256 of the official source file — required to persist an edition. */
    sourceFileHash: text('source_file_hash').notNull(),
    /** Dataset identity (§5): SHA-256 of canonicalJson(content); UNIQUE across all editions. */
    contentHash: text('content_hash').notNull(),
    /** The canonical semantic content (§18) — immutable from import onward. */
    content: jsonb('content').$type<CanonicalEditionContent>().notNull(),
    /** The complete import-gate report at import time — immutable validation evidence. */
    importReport: jsonb('import_report').$type<ImportReport>().notNull(),
    /** The lifecycle state (§7) — one of exactly three values. */
    status: text('status').notNull(),
    /** The edition this one supersedes (erratum link), or null. */
    supersedesEditionId: text('supersedes_edition_id').references(
      (): AnyPgColumn => pricebookEditions.editionId,
    ),
    /** The importing user (the authenticated actor; the bootstrap admin for the seed). */
    importedBy: uuid('imported_by')
      .notNull()
      .references(() => users.userId),
    /** Domain Instant (UTC ISO string), stored verbatim — never database-generated. */
    importedAt: text('imported_at').notNull(),
    activatedBy: uuid('activated_by').references(() => users.userId),
    activatedAt: text('activated_at'),
    archivedBy: uuid('archived_by').references(() => users.userId),
    archivedAt: text('archived_at'),
  },
  (table) => [
    check('pricebook_editions_discipline_check', sql`${table.discipline} = 'abniye'`),
    check(
      'pricebook_editions_status_check',
      sql`${table.status} in ('DRAFT', 'ACTIVE', 'ARCHIVED')`,
    ),
    unique('pricebook_editions_content_hash_key').on(table.contentHash),
    // the 0..1 invariant: at most one ACTIVE edition per discipline (spec §9)
    uniqueIndex('pricebook_editions_one_active')
      .on(table.discipline)
      .where(sql`${table.status} = 'ACTIVE'`),
    index('pricebook_editions_status_idx').on(table.status),
  ],
);
