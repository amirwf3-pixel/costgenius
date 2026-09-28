/**
 * Drizzle/PostgreSQL implementation of the D-016 takeoff repository contracts
 * (CG-FT-TAKEOFF-SPEC §3–§4).
 *
 * `DrizzleTakeoffDocumentRepository` persists the whole document (row + sheets + lines)
 * in ONE transaction through the shared `syncTakeoffDocument` (optimistic concurrency,
 * full draft replace, soft archive, immutable finalized). `create` inserts a new chain
 * member; `save` mutates an existing one under `expectedRevision`. Loaders reassemble the
 * aggregate exactly: sheets in `sheetOrder`, lines in `(sheetOrder, rowNo)`, quantity
 * trees verbatim, everything deep-frozen.
 *
 * `DrizzleFinalizedTakeoffRepository` mirrors `DrizzleFinalizedEstimateRepository`: the
 * draft→finalized transition and the immutable snapshot commit atomically; re-saving the
 * identical bundle is a no-op; different content is `TAKEOFF_DOCUMENT_IMMUTABLE`.
 * `byDocumentId` reloads the bundle without reading mutable draft state (the document row
 * is only consistency-checked, never a content source — the snapshot is authoritative).
 */
import { asc, eq } from 'drizzle-orm';
import type {
  FinalizedTakeoff,
  FinalizedTakeoffRepository,
  TakeoffDocument,
  TakeoffDocumentRepository,
} from '@costgenius/projects';
import { canonicalJson } from '../canonical-json.js';
import type { DbExecutor } from '../db-executor.js';
import { DbError } from '../errors.js';
import { finalizedTakeoffs, takeoffDocuments } from '../schema/index.js';
import { deepFreeze } from './takeoff-serialization.js';
import {
  finalizeTakeoffInStore,
  loadTakeoffDocument,
  syncTakeoffDocument,
} from './takeoff-store.js';

export class DrizzleTakeoffDocumentRepository implements TakeoffDocumentRepository {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async create(document: TakeoffDocument): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await syncTakeoffDocument(tx, document, 0);
    });
  }

  async save(document: TakeoffDocument, expectedRevision: number): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await syncTakeoffDocument(tx, document, expectedRevision);
    });
  }

  async findById(documentId: string): Promise<TakeoffDocument | undefined> {
    return loadTakeoffDocument(this.#db, documentId);
  }

  async findByTakeoffId(takeoffId: string): Promise<readonly TakeoffDocument[]> {
    const rows = await this.#db
      .select({ documentId: takeoffDocuments.documentId })
      .from(takeoffDocuments)
      .where(eq(takeoffDocuments.takeoffId, takeoffId))
      .orderBy(asc(takeoffDocuments.documentNumber));
    return this.#loadAll(rows.map((r) => r.documentId));
  }

  async findByProjectId(projectId: string): Promise<readonly TakeoffDocument[]> {
    const rows = await this.#db
      .select({ documentId: takeoffDocuments.documentId })
      .from(takeoffDocuments)
      .where(eq(takeoffDocuments.projectId, projectId))
      .orderBy(asc(takeoffDocuments.takeoffId), asc(takeoffDocuments.documentNumber));
    return this.#loadAll(rows.map((r) => r.documentId));
  }

  async #loadAll(documentIds: readonly string[]): Promise<readonly TakeoffDocument[]> {
    const loaded: TakeoffDocument[] = [];
    for (const documentId of documentIds) {
      const document = await loadTakeoffDocument(this.#db, documentId);
      if (document !== undefined) {
        loaded.push(document);
      }
    }
    return loaded;
  }
}

export class DrizzleFinalizedTakeoffRepository implements FinalizedTakeoffRepository {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async save(finalized: FinalizedTakeoff, expectedRevision: number): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await finalizeTakeoffInStore(tx, finalized, expectedRevision);
    });
  }

  async byDocumentId(documentId: string): Promise<FinalizedTakeoff | undefined> {
    const row = (
      await this.#db
        .select()
        .from(finalizedTakeoffs)
        .where(eq(finalizedTakeoffs.documentId, documentId))
    )[0];
    if (row === undefined) return undefined;

    // The finalized document rows are immutable history (never rewritten after
    // finalization), so loading them is not a dependence on mutable draft state. The
    // snapshot remains the authoritative calculation record: the loader verifies the
    // document content still matches it byte-for-byte and fails loudly otherwise.
    const document = await loadTakeoffDocument(this.#db, documentId);
    if (document === undefined || document.status !== 'finalized') {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `finalized takeoff for document "${documentId}" references a document that is missing or not finalized; the store is inconsistent`,
      );
    }
    const input = structuredClone(row.input);
    if (
      canonicalJson({ sheets: document.sheets, rounding: document.rounding }) !==
        canonicalJson(input) ||
      document.takeoffId !== row.takeoffId ||
      document.documentNumber !== row.documentNumber ||
      document.finalizedAt !== row.finalizedAt
    ) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `finalized takeoff for document "${documentId}" does not match the persisted finalized document; the store is inconsistent`,
      );
    }

    const finalizedBundle: FinalizedTakeoff = deepFreeze({
      document,
      documentId: row.documentId,
      takeoffId: row.takeoffId,
      documentNumber: row.documentNumber,
      finalizedAt: row.finalizedAt,
      input,
      result: structuredClone(row.result),
    });
    return finalizedBundle;
  }
}

/** Exposed for tests: canonical serialization of a finalized bundle (byte-compare helper). */
export function finalizedTakeoffCanonicalJson(finalized: FinalizedTakeoff): string {
  return canonicalJson({
    documentId: finalized.documentId,
    takeoffId: finalized.takeoffId,
    documentNumber: finalized.documentNumber,
    finalizedAt: finalized.finalizedAt,
    input: finalized.input,
    result: finalized.result,
  });
}
