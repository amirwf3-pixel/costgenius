/**
 * The edition lifecycle decision layer (P8-B S2, CG-IR-PRICEBOOK-SPEC@0.2.0 §7/§8/§20).
 *
 * Exactly three states — DRAFT, ACTIVE, ARCHIVED (D-PB-2 = A) — and exactly these
 * transitions: import→DRAFT, DRAFT→ACTIVE, ARCHIVED→ACTIVE (re-activation), ACTIVE→
 * ARCHIVED, DRAFT→ARCHIVED (the discard path). Everything else — ACTIVE→DRAFT, any
 * content/metadata change, delete — is unrepresentable (no route, no grant; §11).
 *
 * The guards below are the PURE decision layer, exactly like the S4 sign-off guards
 * (`packages/projects/src/signoff.ts`): they decide legality from the read edition
 * row alone and throw the contract's own error codes (§20). The atomic writes (the
 * guarded UPDATEs that make the 0-or-1-ACTIVE invariant race-proof) live in the
 * persistence contracts (`PricebookEditionRepository.activateEdition`/`archiveEdition`)
 * and run in the SAME transaction as the lifecycle audit events (§16), wired at the
 * API boundary (`apps/api/src/pricebook-lifecycle.ts`). Nothing here performs I/O,
 * reads the clock or knows about HTTP, sessions or roles.
 */
import type { PricebookEdition } from './edition.js';

/** The §20 error codes of the edition lifecycle (SCREAMING_SNAKE, exact names). */
export type PricebookEditionErrorCode =
  /** The staged file failed the import gate; nothing stored, zero events (422). */
  | 'PRICEBOOK_IMPORT_REJECTED'
  /** An edition with the identical contentHash — or the same editionId — exists (409). */
  | 'EDITION_ALREADY_EXISTS'
  /** Unknown editionId (404). */
  | 'EDITION_NOT_FOUND'
  /** Activate an already-ACTIVE edition; also the unique-index race outcome (409). */
  | 'EDITION_ALREADY_ACTIVE'
  /** Archive an already-ARCHIVED edition (409). */
  | 'EDITION_ALREADY_ARCHIVED'
  /** Four-eyes: the importer cannot activate their own DRAFT import (403). */
  | 'EDITION_SELF_ACTIVATION_FORBIDDEN'
  /** An operation defaulting to the ACTIVE edition found zero ACTIVE editions (409). */
  | 'EDITION_NOT_ACTIVE';

/**
 * The error of every edition-lifecycle rule — discriminated by its stable `name`
 * for the API error mapper (`apps/api/src/errors.ts`), which surfaces `code`
 * verbatim and attaches `details` (e.g. the import gate's `failures`) when present.
 */
export class PricebookEditionError extends Error {
  readonly code: PricebookEditionErrorCode;
  readonly details?: unknown;

  constructor(code: PricebookEditionErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'PricebookEditionError'; // stable discriminator for the error mapper
    this.code = code;
    this.details = details;
  }
}

/**
 * The legality of ACTIVATE (§8): the target must not already be ACTIVE (the fast
 * 409 — the authoritative check is the guarded atomic write), and on DRAFT→ACTIVE
 * the four-eyes rule applies: the activator must differ from the importer
 * (`EDITION_SELF_ACTIVATION_FORBIDDEN`, mirroring the S4 sign-off pattern). It does
 * NOT apply to ARCHIVED→ACTIVE — re-activation imports nothing; the content was
 * already imported and audited (§8).
 */
export function ensureActivatable(edition: PricebookEdition, activatorUserId: string): void {
  if (edition.status === 'ACTIVE') {
    throw new PricebookEditionError(
      'EDITION_ALREADY_ACTIVE',
      `edition "${edition.editionId}" is already the ACTIVE edition of its discipline`,
    );
  }
  if (edition.status === 'DRAFT' && edition.importedBy === activatorUserId) {
    throw new PricebookEditionError(
      'EDITION_SELF_ACTIVATION_FORBIDDEN',
      'the user who imported an edition cannot activate it (four-eyes rule); another data steward must activate it',
    );
  }
}

/**
 * The legality of ARCHIVE (§8): DRAFT→ARCHIVED (the discard path) and ACTIVE→
 * ARCHIVED (legal even when it is the only ACTIVE edition — D-PB-4 = A, the
 * 0-active state) are allowed; ARCHIVED→ARCHIVED is the idempotent conflict 409.
 * The assertion narrows the surviving status to the two archivable states.
 */
export function ensureArchivable(
  edition: PricebookEdition,
): asserts edition is PricebookEdition & { status: 'DRAFT' | 'ACTIVE' } {
  if (edition.status === 'ARCHIVED') {
    throw new PricebookEditionError(
      'EDITION_ALREADY_ARCHIVED',
      `edition "${edition.editionId}" is already archived`,
    );
  }
}
