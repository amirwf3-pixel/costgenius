/**
 * The pricebook-edition lifecycle service (P8-B S2, CG-IR-PRICEBOOK-SPEC@0.2.0
 * §10/§17 #41–#43) — import → DRAFT, activate (atomic, four-eyes), archive. It lives
 * at the API boundary exactly like the S1 seed (`pricebook-seed.ts`) and the S2 user
 * management service: authorization was already decided by the route gate (viewer+
 * reads, data_steward+ mutations — `authz.ts`), and this module owns the SEMANTIC
 * rules that depend on the target, not the route.
 *
 * Every mutation is ONE transaction (the S3 `deps.transact` unit of work): the state
 * change and its audit event(s) commit together or not at all — a failed or lost
 * mutation leaves zero events. The pure transition legality is decided by the guards
 * of `@costgenius/pricebook` (`ensureActivatable`/`ensureArchivable`); the atomic
 * writes are the repository's guarded UPDATEs; the 0-or-1-ACTIVE invariant's final
 * authority is the `pricebook_editions_one_active` partial unique index — a race
 * between two activations of different editions produces exactly one winner and one
 * deterministic `EDITION_ALREADY_ACTIVE` (§9).
 */
import type { Actor, PricebookEditionRepository } from '@costgenius/projects';
import {
  pricebookEditionActivated,
  pricebookEditionArchived,
  pricebookEditionImported,
} from '@costgenius/projects';
import {
  canonicalContentOf,
  contentHashOf,
  ensureActivatable,
  ensureArchivable,
  PricebookEditionError,
  validateStagedImport,
  V1_DISCIPLINE,
  type ImportReport,
  type PricebookEdition,
  type StagedPricebookFile,
} from '@costgenius/pricebook';
import { appendAuditEvent, type Transact } from './audit.js';

/** What every lifecycle command needs: the registry, the unit of work and the clock. */
export interface PricebookLifecycleDependencies {
  /** A pool-bound edition repository (reads + the pre-write duplicate checks). */
  readonly editions: PricebookEditionRepository;
  /** The S3 transactional unit of work — the atomic write and its event(s) commit together. */
  readonly transact: Transact;
  /** The injected clock (ISO instant) — the service never reads the clock itself. */
  readonly clock: () => string;
}

/** PostgreSQL unique-violation (Drizzle wraps the driver error — walk the cause chain). */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The result of a successful import: the persisted DRAFT edition and its gate report. */
export interface ImportedEdition {
  readonly edition: PricebookEdition;
  readonly importReport: ImportReport;
}

/**
 * IMPORT (§10, #41): the staged-import JSON document enters through the SAME gate as
 * everything else — `validateStagedImport`, unchanged; there is no other authoring
 * path and no client-narrated provenance. Validation is atomic inside the import: a
 * rejected file stores NOTHING and writes zero events (422 with the gate's failures
 * under `details`). Identical content (any status) is refused with 409
 * `EDITION_ALREADY_EXISTS` — content-addressable semantics: activate the existing
 * edition instead. A taken `editionId` is the same 409 (a corrected reprint is a NEW
 * edition — `ir-<year>-abniye-err<N>` — never a re-import of the same handle). New
 * imports begin as DRAFT; nothing is auto-activated.
 */
export async function importPricebookEdition(
  deps: PricebookLifecycleDependencies,
  actor: Actor,
  file: unknown,
): Promise<ImportedEdition> {
  const report = validateStagedImport(file);
  if (!report.ok) {
    throw new PricebookEditionError(
      'PRICEBOOK_IMPORT_REJECTED',
      'the staged file failed the import gate; nothing was stored',
      { failures: report.errors },
    );
  }
  const staged = file as StagedPricebookFile;
  // Persistence requires established source provenance (the column is NOT NULL): a
  // staged file without a sourceFileHash is valid staged content but can never become
  // an edition — the gate's rejection shape answers it (§10/edition.ts).
  if (staged.edition.sourceFileHash === null || staged.edition.sourceFileHash.length === 0) {
    throw new PricebookEditionError(
      'PRICEBOOK_IMPORT_REJECTED',
      'the staged file carries no sourceFileHash; an edition entering persistence must carry established source provenance',
      {
        failures: [
          {
            code: 'MISSING_SOURCE_PROVENANCE',
            message: 'edition.sourceFileHash is null; provenance must be established before import',
          },
        ],
      },
    );
  }

  const content = canonicalContentOf(staged);
  const contentHash = contentHashOf(content);
  const existingContent = await deps.editions.findByContentHash(contentHash);
  if (existingContent !== undefined) {
    throw new PricebookEditionError(
      'EDITION_ALREADY_EXISTS',
      `an edition with this content already exists ("${existingContent.editionId}", status ${existingContent.status}); activate the existing edition instead — identical content is one edition`,
    );
  }
  const existingId = await deps.editions.findByEditionId(staged.edition.id);
  if (existingId !== undefined) {
    throw new PricebookEditionError(
      'EDITION_ALREADY_EXISTS',
      `the edition id "${staged.edition.id}" is already taken; a corrected reprint is a NEW edition (ir-<year>-abniye-err<N>), never a re-import of the same id`,
    );
  }

  const now = deps.clock();
  const edition: PricebookEdition = {
    editionId: staged.edition.id,
    discipline: V1_DISCIPLINE,
    year: staged.edition.year,
    title: staged.edition.title,
    organization: staged.edition.organization,
    notificationNumber: staged.edition.notificationNumber,
    notificationDate: staged.edition.notificationDate,
    sourceFileHash: staged.edition.sourceFileHash,
    contentHash,
    content,
    importReport: report,
    status: 'DRAFT',
    supersedesEditionId: null,
    importedBy: actor.userId,
    importedAt: now,
    activatedBy: null,
    activatedAt: null,
    archivedBy: null,
    archivedAt: null,
  };

  try {
    await deps.transact(async (tx) => {
      await tx.editions.insertEdition(edition);
      await appendAuditEvent(tx.audit, pricebookEditionImported(actor, edition), deps.clock);
    });
  } catch (error) {
    // Two identical imports raced: the loser's INSERT hits a unique constraint, its
    // transaction (row + event) rolled back completely — the deterministic 409.
    if (isUniqueViolation(error)) {
      const winner = await deps.editions.findByContentHash(contentHash);
      if (
        winner !== undefined ||
        (await deps.editions.findByEditionId(edition.editionId)) !== undefined
      ) {
        throw new PricebookEditionError(
          'EDITION_ALREADY_EXISTS',
          'an edition with this content or id already exists (concurrent import won); nothing was stored twice',
        );
      }
    }
    throw error;
  }
  return { edition, importReport: report };
}

/** Re-reads the edition after a successful mutation — the persisted truth, not the plan. */
async function mustReload(
  deps: PricebookLifecycleDependencies,
  editionId: string,
): Promise<PricebookEdition> {
  const reloaded = await deps.editions.findByEditionId(editionId);
  if (reloaded === undefined) {
    // Unreachable: editions are never deleted (§8) and the write just committed.
    throw new PricebookEditionError(
      'EDITION_NOT_FOUND',
      `pricebook edition "${editionId}" does not exist`,
    );
  }
  return reloaded;
}

/**
 * ACTIVATE (§8/§9, #42): DRAFT→ACTIVE or ARCHIVED→ACTIVE (re-activation — four-eyes
 * does not apply: nothing is imported). The previous ACTIVE edition of the discipline
 * is auto-archived in the SAME transaction, and both events (`activated` for the
 * target, `archived` for the superseded) commit with it. Guards: unknown edition 404;
 * already ACTIVE 409; the importer activating their own DRAFT 403 (zero mutation,
 * zero events). Under a race the partial unique index decides: exactly one 200, the
 * loser a deterministic 409 `EDITION_ALREADY_ACTIVE`, zero partial state.
 */
export async function activatePricebookEdition(
  deps: PricebookLifecycleDependencies,
  actor: Actor,
  editionId: string,
): Promise<PricebookEdition> {
  const target = await deps.editions.findByEditionId(editionId);
  if (target === undefined) {
    throw new PricebookEditionError(
      'EDITION_NOT_FOUND',
      `pricebook edition "${editionId}" does not exist`,
    );
  }
  ensureActivatable(target, actor.userId);
  const previous = await deps.editions.findActiveByDiscipline(target.discipline);
  const supersededEditionId = previous === undefined ? null : previous.editionId;

  let won: boolean;
  try {
    won = await deps.transact(async (tx) => {
      const activated = await tx.editions.activateEdition(
        editionId,
        actor.userId,
        deps.clock(),
        supersededEditionId,
      );
      if (!activated) return false; // the guarded write matched nothing — nothing happened
      await appendAuditEvent(
        tx.audit,
        pricebookEditionActivated(actor, target, supersededEditionId),
        deps.clock,
      );
      if (previous !== undefined) {
        await appendAuditEvent(
          tx.audit,
          pricebookEditionArchived(actor, previous, 'ACTIVE'),
          deps.clock,
        );
      }
      return true;
    });
  } catch (error) {
    // The §9 race outcome: another activation of a DIFFERENT edition won the partial
    // unique index — exactly one ACTIVE remains, this transaction (and its events)
    // rolled back completely.
    if (isUniqueViolation(error)) {
      throw new PricebookEditionError(
        'EDITION_ALREADY_ACTIVE',
        'another edition became ACTIVE first; exactly one ACTIVE edition per discipline is allowed',
      );
    }
    throw error;
  }
  if (!won) {
    // The sequential loss: the target was already ACTIVE when the guarded write ran.
    const current = await deps.editions.findByEditionId(editionId);
    if (current === undefined) {
      throw new PricebookEditionError(
        'EDITION_NOT_FOUND',
        `pricebook edition "${editionId}" does not exist`,
      );
    }
    throw new PricebookEditionError(
      'EDITION_ALREADY_ACTIVE',
      `edition "${editionId}" is already the ACTIVE edition of its discipline`,
    );
  }
  return await mustReload(deps, editionId);
}

/**
 * ARCHIVE (§8, #43): DRAFT→ARCHIVED (the discard path — retire a bad import without
 * ever activating it) or ACTIVE→ARCHIVED. Archiving the only ACTIVE edition is legal
 * (D-PB-4 = A): the 0-active state is reachable, nothing is auto-activated, and the
 * operations that need a default ACTIVE edition fail closed with 409
 * `EDITION_NOT_ACTIVE` until the next activation. Guards: unknown 404; already
 * archived 409. Content is never deleted and immutable fields never change (§11).
 */
export async function archivePricebookEdition(
  deps: PricebookLifecycleDependencies,
  actor: Actor,
  editionId: string,
): Promise<PricebookEdition> {
  const target = await deps.editions.findByEditionId(editionId);
  if (target === undefined) {
    throw new PricebookEditionError(
      'EDITION_NOT_FOUND',
      `pricebook edition "${editionId}" does not exist`,
    );
  }
  ensureArchivable(target);
  const previousStatus = target.status; // 'DRAFT' | 'ACTIVE' (the guard refused ARCHIVED)

  const won = await deps.transact(async (tx) => {
    const archived = await tx.editions.archiveEdition(editionId, actor.userId, deps.clock());
    if (!archived) return false; // the guarded write matched nothing — nothing happened
    await appendAuditEvent(
      tx.audit,
      pricebookEditionArchived(actor, target, previousStatus),
      deps.clock,
    );
    return true;
  });
  if (!won) {
    throw new PricebookEditionError(
      'EDITION_ALREADY_ARCHIVED',
      `edition "${editionId}" is already archived`,
    );
  }
  return await mustReload(deps, editionId);
}
