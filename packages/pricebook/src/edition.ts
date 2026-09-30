/**
 * The persistent pricebook-edition domain model (P8-B S1, CG-IR-PRICEBOOK-SPEC@0.2.0
 * §4/§5/§11/§18) — the minimal pure vocabulary edition persistence needs.
 *
 * Five concepts, never conflated (spec §4): edition identity (`editionId` +
 * `contentHash`), dataset content (the validated staged payload, stored as canonical
 * `content`), source/provenance (`sourceFileHash` + printed metadata + importer +
 * the stored `importReport`), publication metadata (printed notification number/date —
 * recorded, never an automation trigger), and status (the ONLY mutable field family,
 * and even that only through the lifecycle commands).
 *
 * Purity: no Fastify, no Drizzle, no HTTP, no UI, no filesystem. `node:crypto`'s
 * deterministic SHA-256 is a pure computation (no I/O, no clock, no randomness) and is
 * the only Node facility this module uses — the canonical-hash logic itself is the
 * existing `canonicalJson`, reused, never duplicated.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import type { EditionMetadata } from './provenance.js';
import type { ImportReport, StagedPricebookFile } from './staged-import.js';

/** The three lifecycle states of spec §7 (D-PB-2 = A) — exactly these, no others. */
export const PRICEBOOK_EDITION_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;

export type EditionStatus = (typeof PRICEBOOK_EDITION_STATUSES)[number];

export function isEditionStatus(value: unknown): value is EditionStatus {
  return (
    typeof value === 'string' && (PRICEBOOK_EDITION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The canonical semantic content of an edition (spec §18 content-storage semantics):
 * exactly what `createPublishedDataset` consumes — the edition metadata block and the
 * rows, in file order. Top-level annotations the typed staged shape does not carry
 * (e.g. `notice`) are excluded: a consumer can obtain everything here from the stored
 * `content`, and nothing else.
 */
export interface CanonicalEditionContent {
  readonly edition: EditionMetadata;
  readonly rows: readonly unknown[];
}

/** Extracts the canonical content of a validated staged-import file. */
export function canonicalContentOf(file: StagedPricebookFile): CanonicalEditionContent {
  return { edition: file.edition, rows: file.rows };
}

/**
 * The dataset identity of an edition (spec §5): SHA-256 over
 * `canonicalJson({edition, rows})`. Computed once at import, stored, and recomputed
 * from the stored content at every load — a mismatch is a fatal deployment integrity
 * error. Content never changes, so the hash is stable for life; any difference,
 * however small, is by definition a new edition.
 */
export function contentHashOf(content: CanonicalEditionContent): string {
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

/**
 * A persisted pricebook edition (spec §18) — one immutable row of `pricebook_editions`
 * plus its lifecycle columns. Everything except `status`, `activatedBy`/`activatedAt`
 * and `archivedBy`/`archivedAt` is immutable from the moment of import (spec §11).
 *
 * `sourceFileHash` is required here (the column is NOT NULL): an edition entering
 * persistence must carry established source provenance — the staged-file metadata may
 * leave it null while provenance is unestablished, but such a file can never be
 * persisted as an edition.
 */
export interface PricebookEdition {
  /** Stable handle, e.g. `ir-1404-abniye`; a corrected reprint is `ir-<year>-abniye-err<N>`. */
  readonly editionId: string;
  /** The discipline of the edition; V1 is ابنیه only (`'abniye'`). */
  readonly discipline: string;
  /** Jalali year as published (`'1404'`) — the human-facing label, never identity. */
  readonly year: string;
  /** Title as printed. */
  readonly title: string;
  /** Organization as printed. */
  readonly organization: string;
  /** Notification number as printed, or null. */
  readonly notificationNumber: string | null;
  /** Notification date (Jalali) as printed, or null. */
  readonly notificationDate: string | null;
  /** Provenance: SHA-256 of the official source file. Never null once persisted. */
  readonly sourceFileHash: string;
  /** Dataset identity (§5): SHA-256 of `canonicalJson(content)`, UNIQUE across editions. */
  readonly contentHash: string;
  /** The canonical semantic content (§18) — immutable from import onward. */
  readonly content: CanonicalEditionContent;
  /** The complete import-gate report produced at import time — immutable evidence. */
  readonly importReport: ImportReport;
  /** The lifecycle state (§7). */
  readonly status: EditionStatus;
  /** The edition this one supersedes (an erratum link), or null. */
  readonly supersedesEditionId: string | null;
  /** The importing user (the authenticated actor at import; the bootstrap admin for the seed). */
  readonly importedBy: string;
  /** Domain Instant of import, stored verbatim. */
  readonly importedAt: string;
  readonly activatedBy: string | null;
  readonly activatedAt: string | null;
  readonly archivedBy: string | null;
  readonly archivedAt: string | null;
}
