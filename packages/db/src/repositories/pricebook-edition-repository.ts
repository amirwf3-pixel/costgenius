/**
 * Drizzle/PostgreSQL implementation of `PricebookEditionRepository` (P8-B S1,
 * CG-IR-PRICEBOOK-SPEC@0.2.0 §18).
 *
 * Read paths are plain contract-faithful selects; `insertEdition` is the single import
 * write and runs on the CALLER'S executor (pool or open transaction) so the edition
 * row, its audit event and — for the seed — the estimate-version backfill commit in
 * ONE transaction. Duplicate identity or duplicate content surfaces as PostgreSQL's
 * unique-violation (23505): content-addressable semantics, nothing merged or updated.
 *
 * There is no update, no delete and no lifecycle method here: content and provenance
 * are immutable from import (§11 — the migration's trigger guards enforce it even for
 * the table owner), and activate/archive arrive with the S2 routes. The backfill is
 * the one deliberate write to another table: it only ever fills NULL bindings of
 * matching-year rows (the binding-immutable trigger refuses any change of a set
 * binding), so it can never rebind a version.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { PricebookEditionRepository } from '@costgenius/projects';
import { isEditionStatus, type PricebookEdition } from '@costgenius/pricebook';
import type { DbExecutor } from '../db-executor.js';
import { DbError } from '../errors.js';
import { estimateVersions, pricebookEditions } from '../schema/index.js';

/** The row shape `select().from(pricebookEditions)` infers (camelCase property names). */
interface PricebookEditionRow {
  readonly editionId: string;
  readonly discipline: string;
  readonly year: string;
  readonly title: string;
  readonly organization: string;
  readonly notificationNumber: string | null;
  readonly notificationDate: string | null;
  readonly sourceFileHash: string;
  readonly contentHash: string;
  readonly content: unknown;
  readonly importReport: unknown;
  readonly status: string;
  readonly supersedesEditionId: string | null;
  readonly importedBy: string;
  readonly importedAt: string;
  readonly activatedBy: string | null;
  readonly activatedAt: string | null;
  readonly archivedBy: string | null;
  readonly archivedAt: string | null;
}

function editionFromRow(row: PricebookEditionRow): PricebookEdition {
  if (!isEditionStatus(row.status)) {
    // unreachable behind the pricebook_editions_status_check constraint — fail loudly
    throw new DbError('PERSISTENCE_CONFLICT', `edition "${row.editionId}" has an invalid status`);
  }
  return {
    editionId: row.editionId,
    discipline: row.discipline,
    year: row.year,
    title: row.title,
    organization: row.organization,
    notificationNumber: row.notificationNumber,
    notificationDate: row.notificationDate,
    sourceFileHash: row.sourceFileHash,
    contentHash: row.contentHash,
    content: row.content as PricebookEdition['content'],
    importReport: row.importReport as PricebookEdition['importReport'],
    status: row.status,
    supersedesEditionId: row.supersedesEditionId,
    importedBy: row.importedBy,
    importedAt: row.importedAt,
    activatedBy: row.activatedBy,
    activatedAt: row.activatedAt,
    archivedBy: row.archivedBy,
    archivedAt: row.archivedAt,
  };
}

export class DrizzlePricebookEditionRepository implements PricebookEditionRepository {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async findByEditionId(editionId: string): Promise<PricebookEdition | undefined> {
    const row = (
      await this.#db
        .select()
        .from(pricebookEditions)
        .where(eq(pricebookEditions.editionId, editionId))
    )[0];
    return row === undefined ? undefined : editionFromRow(row);
  }

  async findByContentHash(contentHash: string): Promise<PricebookEdition | undefined> {
    const row = (
      await this.#db
        .select()
        .from(pricebookEditions)
        .where(eq(pricebookEditions.contentHash, contentHash))
    )[0];
    return row === undefined ? undefined : editionFromRow(row);
  }

  async findActiveByDiscipline(discipline: string): Promise<PricebookEdition | undefined> {
    const row = (
      await this.#db
        .select()
        .from(pricebookEditions)
        .where(
          and(eq(pricebookEditions.discipline, discipline), eq(pricebookEditions.status, 'ACTIVE')),
        )
    )[0];
    return row === undefined ? undefined : editionFromRow(row);
  }

  async insertEdition(edition: PricebookEdition): Promise<void> {
    await this.#db.insert(pricebookEditions).values({
      editionId: edition.editionId,
      discipline: edition.discipline,
      year: edition.year,
      title: edition.title,
      organization: edition.organization,
      notificationNumber: edition.notificationNumber,
      notificationDate: edition.notificationDate,
      sourceFileHash: edition.sourceFileHash,
      contentHash: edition.contentHash,
      content: edition.content,
      importReport: edition.importReport,
      status: edition.status,
      supersedesEditionId: edition.supersedesEditionId,
      importedBy: edition.importedBy,
      importedAt: edition.importedAt,
      activatedBy: edition.activatedBy,
      activatedAt: edition.activatedAt,
      archivedBy: edition.archivedBy,
      archivedAt: edition.archivedAt,
    });
  }

  async backfillVersionEditionBindings(edition: PricebookEdition): Promise<number> {
    const bound = await this.#db
      .update(estimateVersions)
      .set({ editionId: edition.editionId })
      .where(and(isNull(estimateVersions.editionId), eq(estimateVersions.edition, edition.year)))
      .returning({ versionId: estimateVersions.versionId });
    return bound.length;
  }
}
