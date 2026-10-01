/**
 * The first-boot pricebook seed (P8-B S1, CG-IR-PRICEBOOK-SPEC@0.2.0 §24, D-PB-1 = B).
 *
 * The shipped 1404 edition enters the persistent system through the SAME import gate as
 * every future edition — there is NO special parser or shortcut: the staged file is
 * read, validated by `validateStagedImport`, hashed canonically, and inserted through
 * the one repository import write. It is inserted DIRECTLY AS ACTIVE (it is the edition
 * in production use; the DRAFT step is not performed for the seed), with the bootstrap
 * admin as importer/activator actor, and appends `pricebook_edition.imported` and
 * `pricebook_edition.activated` — both with `seeded: true` — in the SAME transaction.
 *
 * Ordering (§24, the nine-point contract): migrations first (the table exists), then
 * the bootstrap admin (the seed's actor and `imported_by` FK target), then this seed,
 * and the backfill of historical `estimate_versions.edition_id` runs INSIDE the seed
 * transaction — only after the edition row exists, so the FK never dangles.
 *
 * Idempotency and concurrency: a boot that finds the edition already present is a no-op
 * (an edition the operator archived is NEVER re-activated); two boots racing produce
 * exactly one edition — the loser's INSERT hits the primary key, its transaction (and
 * its events) roll back, and the re-check confirms the winner. A staged file that fails
 * the gate at seed time is a BOOT-FATAL error: a corrupted verified dataset must never
 * be served.
 */
import { readFileSync } from 'node:fs';
import type { Actor, PricebookEditionRepository, UserStore } from '@costgenius/projects';
import {
  canonicalContentOf,
  contentHashOf,
  OFFICIAL_EDITION_ID,
  validateStagedImport,
  type PricebookEdition,
  type StagedPricebookFile,
} from '@costgenius/pricebook';
import { appendAuditEvent, type Transact } from './audit.js';
import { isUniqueViolation } from './pricebook-lifecycle.js';
import { pricebookEditionActivated, pricebookEditionImported } from '@costgenius/projects';
import { DEFAULT_DATASET_PATH } from './dataset.js';

/** The V1 discipline of the official edition (ابنیه — the only discipline in V1). */
const SEED_DISCIPLINE = 'abniye';

export interface PricebookSeedDependencies {
  /** The user store — the seed actor is resolved from the persisted org_admins. */
  readonly users: UserStore;
  /** A pool-bound edition repository (the existence check; the insert runs on the transaction). */
  readonly editions: PricebookEditionRepository;
  /** The S3 transactional unit of work — insert, both events and the backfill commit together. */
  readonly transact: Transact;
  /** The injected clock (ISO instant) — the seed never reads the clock itself. */
  readonly clock: () => string;
  /** The staged-import JSON to seed (defaults to the in-repo verified 1404 dataset). */
  readonly datasetPath?: string;
}

/**
 * The seed actor (§24): the bootstrap admin. Deterministically the FIRST org_admin by
 * (createdAt, userId) — the account `ensureBootstrapAdmin` created on the empty table,
 * or the instance's original administrator on an already-populated one.
 */
async function resolveSeedActor(users: UserStore): Promise<Actor> {
  const all = await users.list();
  const admin = all.find((user) => user.role === 'org_admin');
  if (admin === undefined) {
    throw new Error(
      'pricebook seed required: no org_admin exists to act as the seed importer; ' +
        'the bootstrap admin (CG-GOV §1.5) must be created before the pricebook seed runs',
    );
  }
  return { userId: admin.userId, username: admin.username };
}

/**
 * Seeds the verified 1404 edition. No-op when the edition already exists (any status);
 * boot-fatal when the seed artifact fails the import gate or is not the official 1404
 * edition (a misconfigured `DATASET_PATH` must never seed something else silently).
 */
export async function seedPricebookEdition(deps: PricebookSeedDependencies): Promise<void> {
  // The fast path is also the idempotency contract: an archived edition is never re-activated.
  if ((await deps.editions.findByEditionId(OFFICIAL_EDITION_ID)) !== undefined) return;

  const path = deps.datasetPath ?? DEFAULT_DATASET_PATH;
  const file: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const report = validateStagedImport(file);
  if (!report.ok) {
    throw new Error(
      `pricebook seed refused: the staged dataset at ${path} failed the import gate ` +
        `(${String(report.errorCount)} error(s), first: ${report.errors[0]?.code ?? 'none'}); ` +
        'a corrupted verified dataset must never be served (boot fails closed)',
    );
  }
  const staged = file as StagedPricebookFile;
  if (staged.edition.id !== OFFICIAL_EDITION_ID) {
    throw new Error(
      `pricebook seed refused: the staged dataset at ${path} declares edition ` +
        `"${staged.edition.id}" but the seed establishes the official 1404 edition ` +
        `"${OFFICIAL_EDITION_ID}" (check DATASET_PATH)`,
    );
  }
  if (staged.edition.sourceFileHash === null || staged.edition.sourceFileHash.length === 0) {
    throw new Error(
      `pricebook seed refused: the staged dataset at ${path} carries no sourceFileHash; ` +
        'an edition entering persistence must carry established source provenance',
    );
  }

  const content = canonicalContentOf(staged);
  const actor = await resolveSeedActor(deps.users);
  const now = deps.clock();
  const edition: PricebookEdition = {
    editionId: staged.edition.id,
    discipline: SEED_DISCIPLINE,
    year: staged.edition.year,
    title: staged.edition.title,
    organization: staged.edition.organization,
    notificationNumber: staged.edition.notificationNumber,
    notificationDate: staged.edition.notificationDate,
    sourceFileHash: staged.edition.sourceFileHash,
    contentHash: contentHashOf(content),
    content,
    importReport: report,
    status: 'ACTIVE',
    supersedesEditionId: null,
    importedBy: actor.userId,
    importedAt: now,
    activatedBy: actor.userId,
    activatedAt: now,
    archivedBy: null,
    archivedAt: null,
  };

  try {
    await deps.transact(async (tx) => {
      await tx.editions.insertEdition(edition);
      await appendAuditEvent(tx.audit, pricebookEditionImported(actor, edition, true), deps.clock);
      await appendAuditEvent(
        tx.audit,
        pricebookEditionActivated(actor, edition, null, true),
        deps.clock,
      );
      // The backfill runs only now — the edition row exists, so the FK never dangles,
      // and only rows whose year label matches (all pre-P8-B work is 1404 by
      // construction) and whose binding is still NULL are bound (§24 point 7).
      await tx.editions.backfillVersionEditionBindings(edition);
    });
  } catch (error) {
    // A concurrent boot won the race: exactly one edition exists, the loser's
    // transaction (row + events + backfill) rolled back completely.
    if (
      isUniqueViolation(error) &&
      (await deps.editions.findByEditionId(OFFICIAL_EDITION_ID)) !== undefined
    ) {
      return;
    }
    throw error;
  }
}
