/**
 * Shared persistence internals for the Full Takeoff aggregate (D-016, CG-FT-TAKEOFF-SPEC
 * §2–§4). `syncTakeoffDocument` is the transactional writer; `finalizeTakeoffInStore`
 * performs the atomic draft→finalized transition together with the immutable snapshot;
 * `loadTakeoffDocument` reassembles the aggregate.
 *
 * Writer contract (deterministic, concurrency-safe via `SELECT … FOR UPDATE` on the
 * document row — the Phase 16 estimate-store pattern):
 * - INSERT path: nothing persisted yet; the new document must be chain member number
 *   max+1 of its `takeoffId` chain (or the first), a draft at revision 1.
 * - DRAFT: `save` replaces the complete content (title, sheets, lines, rounding) with
 *   `revision` incremented by exactly one; archive flips draft→archived with identical
 *   content and unchanged revision. Anything else is a conflict or an invalid transition.
 * - ARCHIVED: unarchive (archived→draft, identical content, unchanged revision) or an
 *   idempotent no-op. An archived draft is never edited or finalized in place.
 * - FINALIZED: byte-identical re-saves are no-ops; ANY difference is
 *   TAKEOFF_DOCUMENT_IMMUTABLE, never an update. Follow-up changes are new documents.
 * - A stale `expectedRevision` is always `PERSISTENCE_CONFLICT` (G4=B: no last-write-wins).
 * - Duplicate sheetId/rowNo/lineId inside a presented document are rejected before the
 *   inserts run (the unique indexes remain the safety net).
 * - Nothing in the takeoff family is ever hard-deleted (G1b=C).
 */
import { and, asc, eq, max } from 'drizzle-orm';
import type { FinalizedTakeoff, TakeoffDocument } from '@costgenius/projects';
import { canonicalJson } from '../canonical-json.js';
import type { DbExecutor } from '../db-executor.js';
import { DbError } from '../errors.js';
import {
  finalizedTakeoffs,
  takeoffDocuments,
  takeoffLines,
  takeoffSheets,
} from '../schema/index.js';
import { projects } from '../schema/index.js';
import {
  takeoffDocumentFromRows,
  takeoffLineToRow,
  takeoffSheetToRow,
  takeoffDocumentToRow,
  type TakeoffLineRow,
  type TakeoffSheetRow,
} from './takeoff-serialization.js';

/** Rejects duplicate identities inside a presented document (engine V1 mirrors, pre-insert). */
function validateNoDuplicates(document: TakeoffDocument): void {
  const sheetIds = new Set<string>();
  for (const sheet of document.sheets) {
    if (sheetIds.has(sheet.sheetId)) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `duplicate sheetId "${sheet.sheetId}" in takeoff document "${document.documentId}"`,
      );
    }
    sheetIds.add(sheet.sheetId);
  }
  const lineIds = new Set<string>();
  for (const sheet of document.sheets) {
    const rows = new Set<number>();
    for (const line of sheet.lines) {
      if (lineIds.has(line.lineId)) {
        throw new DbError(
          'PERSISTENCE_CONFLICT',
          `duplicate lineId "${line.lineId}" in takeoff document "${document.documentId}" (lineIds are document-unique)`,
        );
      }
      lineIds.add(line.lineId);
      if (rows.has(line.rowNo)) {
        throw new DbError(
          'PERSISTENCE_CONFLICT',
          `duplicate rowNo ${String(line.rowNo)} in sheet "${sheet.sheetId}" of takeoff document "${document.documentId}"`,
        );
      }
      rows.add(line.rowNo);
    }
  }
}

async function insertContent(db: DbExecutor, document: TakeoffDocument): Promise<void> {
  for (const [index, sheet] of document.sheets.entries()) {
    await db.insert(takeoffSheets).values(takeoffSheetToRow(document.documentId, index + 1, sheet));
    for (const line of sheet.lines) {
      await db
        .insert(takeoffLines)
        .values(takeoffLineToRow(document.documentId, sheet.sheetId, line));
    }
  }
}

/**
 * Content projection used by the no-change transitions (archive/unarchive) comparisons:
 * identity + content fields only — `status`/`archivedAt`/`finalizedAt` are excluded.
 */
function contentOf(document: TakeoffDocument): unknown {
  return {
    documentId: document.documentId,
    takeoffId: document.takeoffId,
    projectId: document.projectId,
    documentNumber: document.documentNumber,
    title: document.title,
    revision: document.revision,
    rounding: document.rounding,
    sheets: document.sheets,
    createdAt: document.createdAt,
  };
}

export async function syncTakeoffDocument(
  db: DbExecutor,
  document: TakeoffDocument,
  expectedRevision: number,
): Promise<void> {
  validateNoDuplicates(document);

  const documentRow = (
    await db
      .select()
      .from(takeoffDocuments)
      .where(eq(takeoffDocuments.documentId, document.documentId))
      .for('update')
  )[0];

  if (documentRow === undefined) {
    // INSERT path — a brand-new chain member.
    if (expectedRevision !== 0) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `takeoff document "${document.documentId}" is not persisted yet; expectedRevision must be 0 for a create`,
      );
    }
    if (document.status !== 'draft' || document.revision !== 1) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `a new takeoff document must be a draft at revision 1 (got ${document.status}/${String(document.revision)})`,
      );
    }
    const projectRow = (
      await db.select().from(projects).where(eq(projects.projectId, document.projectId))
    )[0];
    if (projectRow === undefined) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `project "${document.projectId}" of takeoff document "${document.documentId}" is not persisted; persist the project first`,
      );
    }
    const chainMax = (
      await db
        .select({ maxNumber: max(takeoffDocuments.documentNumber) })
        .from(takeoffDocuments)
        .where(eq(takeoffDocuments.takeoffId, document.takeoffId))
    )[0];
    const nextNumber = (chainMax?.maxNumber ?? 0) + 1;
    if (document.documentNumber !== nextNumber) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `takeoff chain "${document.takeoffId}" expects documentNumber ${String(nextNumber)}, got ${String(document.documentNumber)}`,
      );
    }
    await db.insert(takeoffDocuments).values(takeoffDocumentToRow(document));
    await insertContent(db, document);
    return;
  }

  // UPDATE path — an existing document.
  if (expectedRevision !== documentRow.revision) {
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `stale expectedRevision ${String(expectedRevision)} for takeoff document "${document.documentId}" (persisted revision is ${String(documentRow.revision)})`,
    );
  }
  if (
    documentRow.takeoffId !== document.takeoffId ||
    documentRow.projectId !== document.projectId ||
    documentRow.documentNumber !== document.documentNumber ||
    documentRow.createdAt !== document.createdAt
  ) {
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `takeoff document "${document.documentId}" is already persisted with a different identity (takeoffId/projectId/documentNumber/createdAt); document identity is immutable`,
    );
  }

  if (documentRow.status === 'finalized') {
    const stored = await loadTakeoffDocument(db, document.documentId);
    if (stored !== undefined && canonicalJson(stored) === canonicalJson(document)) return;
    throw new DbError(
      'TAKEOFF_DOCUMENT_IMMUTABLE',
      `takeoff document "${document.documentId}" is finalized in the database and the incoming document differs; finalized documents are never rewritten (create a follow-up revision instead)`,
    );
  }

  if (documentRow.status === 'draft' && document.status === 'finalized') {
    throw new DbError(
      'TAKEOFF_INVALID_TRANSITION',
      `draft → finalized must go through the finalized-takeoff writer (atomic snapshot), not the document writer`,
    );
  }

  if (documentRow.status === 'archived' && document.status === 'archived') {
    const stored = await loadTakeoffDocument(db, document.documentId);
    if (stored !== undefined && canonicalJson(stored) === canonicalJson(document)) return;
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `an archived draft cannot be edited; unarchive it first (document "${document.documentId}")`,
    );
  }
  if (documentRow.status === 'archived' && document.status === 'finalized') {
    throw new DbError(
      'TAKEOFF_INVALID_TRANSITION',
      `an archived draft cannot be finalized; unarchive it first (document "${document.documentId}")`,
    );
  }

  if (document.status === 'archived') {
    // draft → archived: content and revision unchanged (G1b=C soft archive).
    const stored = await loadTakeoffDocument(db, document.documentId);
    if (
      stored === undefined ||
      canonicalJson(contentOf(stored)) !== canonicalJson(contentOf(document))
    ) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `archiving must not change document content or revision (document "${document.documentId}")`,
      );
    }
    await db
      .update(takeoffDocuments)
      .set({ status: 'archived', archivedAt: document.archivedAt ?? null })
      .where(eq(takeoffDocuments.documentId, document.documentId));
    return;
  }

  if (documentRow.status === 'archived' && document.status === 'draft') {
    // archived → draft (unarchive): content and revision unchanged.
    const stored = await loadTakeoffDocument(db, document.documentId);
    if (
      stored === undefined ||
      canonicalJson(contentOf(stored)) !== canonicalJson(contentOf(document))
    ) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `unarchiving must not change document content or revision (document "${document.documentId}")`,
      );
    }
    await db
      .update(takeoffDocuments)
      .set({ status: 'draft', archivedAt: null })
      .where(eq(takeoffDocuments.documentId, document.documentId));
    return;
  }

  // draft → draft: full content replace; revision increments by exactly one (G4=B).
  if (document.revision !== documentRow.revision + 1) {
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `a draft save must increment the revision by exactly one (${String(documentRow.revision)} → ${String(document.revision)})`,
    );
  }
  await db.delete(takeoffSheets).where(eq(takeoffSheets.documentId, document.documentId));
  await insertContent(db, document);
  await db
    .update(takeoffDocuments)
    .set({
      title: document.title,
      revision: document.revision,
      roundingRuleSet: structuredClone(document.rounding),
    })
    .where(eq(takeoffDocuments.documentId, document.documentId));
}

/**
 * The atomic finalization (CG-FT §2.3/§12): locks the document, requires the persisted
 * draft at `expectedRevision` with byte-identical content, flips the status, and writes
 * the immutable snapshot — all in the caller's transaction, so a failure anywhere leaves
 * nothing finalized and no partial snapshot.
 */
/** Byte-compare of a persisted snapshot row against an incoming finalized bundle. */
function snapshotMatches(
  row: typeof finalizedTakeoffs.$inferSelect,
  finalized: FinalizedTakeoff,
): boolean {
  return (
    row.takeoffId === finalized.takeoffId &&
    row.documentNumber === finalized.documentNumber &&
    row.finalizedAt === finalized.finalizedAt &&
    row.specVersion === finalized.result.specVersion &&
    row.engineVersion === finalized.result.engineVersion &&
    canonicalJson(row.input) === canonicalJson(finalized.input) &&
    canonicalJson(row.result) === canonicalJson(finalized.result)
  );
}

export async function finalizeTakeoffInStore(
  db: DbExecutor,
  finalized: FinalizedTakeoff,
  expectedRevision: number,
): Promise<void> {
  const document = finalized.document;
  validateNoDuplicates(document);

  const documentRow = (
    await db
      .select()
      .from(takeoffDocuments)
      .where(eq(takeoffDocuments.documentId, finalized.documentId))
      .for('update')
  )[0];
  if (documentRow === undefined) {
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `takeoff document "${finalized.documentId}" is not persisted; a takeoff must be created and drafted before finalization`,
    );
  }
  if (expectedRevision !== documentRow.revision) {
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `stale expectedRevision ${String(expectedRevision)} for takeoff document "${finalized.documentId}" (persisted revision is ${String(documentRow.revision)})`,
    );
  }
  if (documentRow.status !== 'draft') {
    if (documentRow.status === 'finalized') {
      // Idempotent re-save of the identical bundle is a no-op (finalized_estimates doctrine).
      const existing = (
        await db
          .select()
          .from(finalizedTakeoffs)
          .where(eq(finalizedTakeoffs.documentId, finalized.documentId))
      )[0];
      if (existing !== undefined && snapshotMatches(existing, finalized)) return;
      throw new DbError(
        'TAKEOFF_DOCUMENT_IMMUTABLE',
        `takeoff document "${finalized.documentId}" is already finalized; finalized documents and snapshots are never rewritten`,
      );
    }
    throw new DbError(
      'TAKEOFF_INVALID_TRANSITION',
      `only a draft can be finalized (document "${finalized.documentId}" is ${documentRow.status})`,
    );
  }
  if (document.revision !== documentRow.revision) {
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `finalization freezes the draft as-is (revision ${String(documentRow.revision)}); the bundle carries revision ${String(document.revision)}`,
    );
  }
  if (
    documentRow.takeoffId !== document.takeoffId ||
    documentRow.projectId !== document.projectId ||
    documentRow.documentNumber !== document.documentNumber ||
    documentRow.createdAt !== document.createdAt
  ) {
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `the finalized bundle does not match the persisted identity of document "${finalized.documentId}"`,
    );
  }
  const stored = await loadTakeoffDocument(db, finalized.documentId);
  if (
    stored === undefined ||
    canonicalJson(contentOf(stored)) !== canonicalJson(contentOf(document))
  ) {
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `the finalized bundle does not match the persisted draft of document "${finalized.documentId}"; finalize exactly the stored content`,
    );
  }

  // Flip the status first, then write the snapshot: if the snapshot insert fails (e.g. a
  // conflicting finalized row already exists), the whole transaction rolls back and
  // nothing is finalized — the atomicity the specification requires.
  await db
    .update(takeoffDocuments)
    .set({ status: 'finalized', finalizedAt: finalized.finalizedAt })
    .where(eq(takeoffDocuments.documentId, finalized.documentId));

  const existing = (
    await db
      .select()
      .from(finalizedTakeoffs)
      .where(eq(finalizedTakeoffs.documentId, finalized.documentId))
  )[0];
  if (existing !== undefined) {
    throw new DbError(
      'TAKEOFF_DOCUMENT_IMMUTABLE',
      `a finalized takeoff for document "${finalized.documentId}" already exists; finalized snapshots are never rewritten`,
    );
  }
  await db.insert(finalizedTakeoffs).values({
    documentId: finalized.documentId,
    takeoffId: finalized.takeoffId,
    documentNumber: finalized.documentNumber,
    finalizedAt: finalized.finalizedAt,
    // S4 (CG-GOV §5): the finalizing actor; pre-V1.1 rows keep NULL (legacy).
    finalizedBy: finalized.finalizedBy ?? null,
    specVersion: finalized.result.specVersion,
    engineVersion: finalized.result.engineVersion,
    input: structuredClone(finalized.input),
    result: structuredClone(finalized.result),
  });
}

export async function loadTakeoffDocument(
  db: DbExecutor,
  documentId: string,
): Promise<TakeoffDocument | undefined> {
  const documentRow = (
    await db.select().from(takeoffDocuments).where(eq(takeoffDocuments.documentId, documentId))
  )[0];
  if (documentRow === undefined) return undefined;

  const sheetRows = await db
    .select()
    .from(takeoffSheets)
    .where(eq(takeoffSheets.documentId, documentId))
    .orderBy(asc(takeoffSheets.sheetOrder));

  const lineRows = await db
    .select({ line: takeoffLines, sheetOrder: takeoffSheets.sheetOrder })
    .from(takeoffLines)
    .innerJoin(
      takeoffSheets,
      and(
        eq(takeoffLines.documentId, takeoffSheets.documentId),
        eq(takeoffLines.sheetId, takeoffSheets.sheetId),
      ),
    )
    .where(eq(takeoffLines.documentId, documentId))
    .orderBy(asc(takeoffSheets.sheetOrder), asc(takeoffLines.rowNo));

  const linesBySheet = new Map<string, { sheet: TakeoffSheetRow; lines: TakeoffLineRow[] }>();
  for (const sheet of sheetRows) {
    linesBySheet.set(sheet.sheetId, { sheet, lines: [] });
  }
  for (const { line, sheetOrder } of lineRows) {
    const bucket = linesBySheet.get(line.sheetId);
    if (bucket === undefined) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `takeoff line "${line.lineId}" references sheet "${line.sheetId}" (order ${String(sheetOrder)}) missing from document "${documentId}"; the store is inconsistent`,
      );
    }
    bucket.lines.push(line);
  }
  return takeoffDocumentFromRows(
    documentRow,
    sheetRows.map((sheet) => linesBySheet.get(sheet.sheetId) ?? { sheet, lines: [] }),
  );
}
