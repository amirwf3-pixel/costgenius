/**
 * Persistence contracts for the estimate workflow.
 *
 * The interfaces are the boundary the application layer programs against; the reference
 * in-memory adapters stay deterministic and side-effect free. Since Phase 14 the methods
 * are asynchronous: a real database adapter (`@costgenius/db`, Drizzle/PostgreSQL) performs
 * I/O, and no synchronous contract could honestly represent it. No ORM choice is locked in
 * here; the core calculation stays fully executable without any database.
 *
 * Everything a repository stores is already immutable (deep-frozen): a repository never
 * receives a mutable object it could corrupt. `save` semantics are idempotent by value —
 * saving the same aggregate again is a no-op — and history is append-only: replacing a
 * finalized version or bundle with different content is a stable, testable error
 * (`FINALIZED_ESTIMATE_IMMUTABLE` in the DB adapter), never an overwrite.
 */
import { canonicalJson } from '@costgenius/calc-engine';
import type { Estimate } from '@costgenius/boq';
import type { FinalizedEstimate } from './estimate-calculation.js';
import type { Project } from './project.js';
import type { FinalizedTakeoff, TakeoffDocument } from './takeoff-document.js';

/** Stores and loads projects by identity. */
export interface ProjectRepository {
  save(project: Project): Promise<void>;
  findById(projectId: string): Promise<Project | undefined>;
  /**
   * Lists every project in a deterministic order (added in Phase 18: the workflow UI
   * opens on the project list). Returns an empty array when none exist.
   */
  list(): Promise<readonly Project[]>;
}

/** Stores and loads estimate aggregates (with all their versions) by identity. */
export interface EstimateRepository {
  save(estimate: Estimate): Promise<void>;
  findById(estimateId: string): Promise<Estimate | undefined>;
  /**
   * Loads the aggregate that owns the given version (added in Phase 15: the API addresses
   * draft versions by version identity). Returns undefined for an unknown versionId.
   */
  findByVersionId(versionId: string): Promise<Estimate | undefined>;
  /**
   * Lists every estimate of a project, full aggregates, in a deterministic order
   * (added in Phase 17: the workflow lists a project's estimates). Returns an empty
   * array for a project with no estimates.
   */
  findByProjectId(projectId: string): Promise<readonly Estimate[]>;
}

/** Stores and loads finalized-estimate bundles by version identity (append-only by convention). */
export interface FinalizedEstimateRepository {
  save(finalized: FinalizedEstimate): Promise<void>;
  byVersionId(versionId: string): Promise<FinalizedEstimate | undefined>;
  /**
   * P8-A S4 (CG-GOV §5): atomically sets `approved_by`/`approved_at` — the single
   * irreversible FINALIZED → APPROVED/LOCKED write. Returns false when the version is
   * already approved (or missing), leaving the row untouched; the caller maps that to
   * 409 SIGNOFF_ALREADY_GIVEN. The WHERE `approved_by IS NULL` guard makes double
   * approval impossible even under concurrency: exactly one racing writer wins.
   */
  approve(versionId: string, approverUserId: string, approvedAt: string): Promise<boolean>;
}

/** Deterministic in-memory ProjectRepository (reference adapter; no persistence). */
export class InMemoryProjectRepository implements ProjectRepository {
  readonly #projects = new Map<string, Project>();

  save(project: Project): Promise<void> {
    this.#projects.set(project.projectId, project);
    return Promise.resolve();
  }

  findById(projectId: string): Promise<Project | undefined> {
    return Promise.resolve(this.#projects.get(projectId));
  }

  list(): Promise<readonly Project[]> {
    return Promise.resolve([...this.#projects.values()]);
  }
}

/** Deterministic in-memory EstimateRepository (reference adapter; no persistence). */
export class InMemoryEstimateRepository implements EstimateRepository {
  readonly #estimates = new Map<string, Estimate>();

  save(estimate: Estimate): Promise<void> {
    this.#estimates.set(estimate.estimateId, estimate);
    return Promise.resolve();
  }

  findById(estimateId: string): Promise<Estimate | undefined> {
    return Promise.resolve(this.#estimates.get(estimateId));
  }

  findByVersionId(versionId: string): Promise<Estimate | undefined> {
    return Promise.resolve(
      [...this.#estimates.values()].find((estimate) =>
        estimate.versions.some((v) => v.versionId === versionId),
      ),
    );
  }

  findByProjectId(projectId: string): Promise<readonly Estimate[]> {
    return Promise.resolve(
      [...this.#estimates.values()].filter((estimate) => estimate.projectId === projectId),
    );
  }
}

/** Deterministic in-memory FinalizedEstimateRepository (reference adapter; no persistence). */
export class InMemoryFinalizedEstimateRepository implements FinalizedEstimateRepository {
  readonly #byVersion = new Map<string, FinalizedEstimate>();

  save(finalized: FinalizedEstimate): Promise<void> {
    const existing = this.#byVersion.get(finalized.versionId);
    if (existing !== undefined && existing !== finalized) {
      // A finalized version is history: a different bundle for the same versionId is a
      // contract violation, not an overwrite.
      return Promise.reject(
        new Error(
          `finalized estimate for version ${finalized.versionId} already exists and cannot be replaced`,
        ),
      );
    }
    this.#byVersion.set(finalized.versionId, finalized);
    return Promise.resolve();
  }

  byVersionId(versionId: string): Promise<FinalizedEstimate | undefined> {
    return Promise.resolve(this.#byVersion.get(versionId));
  }

  approve(versionId: string, approverUserId: string, approvedAt: string): Promise<boolean> {
    const existing = this.#byVersion.get(versionId);
    if (existing === undefined || (existing.approval ?? null) !== null) {
      return Promise.resolve(false);
    }
    this.#byVersion.set(versionId, {
      ...existing,
      approval: { approvedBy: approverUserId, approvedAt },
    });
    return Promise.resolve(true);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Full Takeoff persistence (D-016, CG-FT-TAKEOFF-SPEC@0.1.0 §3–§4)
 *
 * `TakeoffDocumentRepository.save` is the G4=B optimistic-concurrency writer: it takes the
 * next document state plus the `expectedRevision` the caller loaded. A stale revision, an
 * identity change or an illegal status transition is a deterministic error — never a
 * last-write-wins overwrite. `create` inserts a new chain member (documentNumber must
 * continue the chain). The finalized-takeoff repository performs the atomic
 * draft→finalized transition together with the immutable snapshot (write-once,
 * byte-compared), mirroring the finalized-estimate doctrine.
 * ------------------------------------------------------------------------------------------------- */

/** Stores and loads takeoff documents (all chain members and statuses). */
export interface TakeoffDocumentRepository {
  /** Inserts a new document (chain start or follow-up). `documentNumber` must continue its chain. */
  create(document: TakeoffDocument): Promise<void>;
  /**
   * Persists the next state of an existing document: draft content replace (`revision`
   * increments by exactly one), archive or unarchive (`revision` unchanged, content
   * identical). `expectedRevision` must equal the persisted revision. A finalized
   * document is immutable.
   */
  save(document: TakeoffDocument, expectedRevision: number): Promise<void>;
  findById(documentId: string): Promise<TakeoffDocument | undefined>;
  /** The full chain in `documentNumber` order (all revisions, any status). */
  findByTakeoffId(takeoffId: string): Promise<readonly TakeoffDocument[]>;
  /** Every takeoff document of a project, ordered by (`takeoffId`, `documentNumber`). */
  findByProjectId(projectId: string): Promise<readonly TakeoffDocument[]>;
}

/**
 * Stores the immutable finalization bundles (snapshot + the draft→finalized transition in
 * one atomic operation, exactly like `FinalizedEstimateRepository`).
 */
export interface FinalizedTakeoffRepository {
  /**
   * Finalizes atomically: the source must be the persisted draft at `expectedRevision`
   * with byte-identical content, the document flips to `finalized` and the snapshot is
   * written once. Re-saving the identical bundle is a no-op; different content for the
   * same `documentId` is an immutability error.
   */
  save(finalized: FinalizedTakeoff, expectedRevision: number): Promise<void>;
  byDocumentId(documentId: string): Promise<FinalizedTakeoff | undefined>;
  /**
   * P8-A S4 (CG-GOV §5): atomically sets `approved_by`/`approved_at` — the single
   * irreversible FINALIZED → APPROVED/LOCKED write. Returns false when the document is
   * already approved (or missing), leaving the row untouched; the caller maps that to
   * 409 SIGNOFF_ALREADY_GIVEN. The WHERE `approved_by IS NULL` guard makes double
   * approval impossible even under concurrency: exactly one racing writer wins.
   */
  approve(documentId: string, approverUserId: string, approvedAt: string): Promise<boolean>;
}

/**
 * Canonical JSON of the identity + content fields a lifecycle flip must leave
 * byte-identical (everything except `status`/`archivedAt`/`finalizedAt`).
 */
function takeoffContentJson(document: TakeoffDocument): string {
  return canonicalJson({
    documentId: document.documentId,
    takeoffId: document.takeoffId,
    projectId: document.projectId,
    documentNumber: document.documentNumber,
    title: document.title,
    revision: document.revision,
    rounding: document.rounding,
    sheets: document.sheets,
    createdAt: document.createdAt,
  });
}

/** Deterministic in-memory TakeoffDocumentRepository (reference adapter; no persistence). */
export class InMemoryTakeoffDocumentRepository implements TakeoffDocumentRepository {
  readonly #documents = new Map<string, TakeoffDocument>();

  create(document: TakeoffDocument): Promise<void> {
    if (this.#documents.has(document.documentId)) {
      return Promise.reject(
        new Error(`takeoff document "${document.documentId}" is already persisted`),
      );
    }
    const chain = [...this.#documents.values()].filter((d) => d.takeoffId === document.takeoffId);
    const maxNumber = chain.reduce((m, d) => Math.max(m, d.documentNumber), 0);
    if (document.documentNumber !== maxNumber + 1) {
      return Promise.reject(
        new Error(
          `takeoff chain "${document.takeoffId}" expects documentNumber ${String(maxNumber + 1)}, got ${String(document.documentNumber)}`,
        ),
      );
    }
    this.#documents.set(document.documentId, document);
    return Promise.resolve();
  }

  save(document: TakeoffDocument, expectedRevision: number): Promise<void> {
    const reject = (message: string): Promise<void> => Promise.reject(new Error(message));
    const stored = this.#documents.get(document.documentId);
    if (stored === undefined) {
      return reject(`takeoff document "${document.documentId}" is not persisted; create it first`);
    }
    if (expectedRevision !== stored.revision) {
      return reject(
        `stale expectedRevision ${String(expectedRevision)} for takeoff document "${document.documentId}" (persisted revision is ${String(stored.revision)})`,
      );
    }
    if (
      stored.takeoffId !== document.takeoffId ||
      stored.projectId !== document.projectId ||
      stored.documentNumber !== document.documentNumber ||
      stored.createdAt !== document.createdAt
    ) {
      return reject(
        `takeoff document "${document.documentId}" is already persisted with a different identity (takeoffId/projectId/documentNumber/createdAt); document identity is immutable`,
      );
    }
    if (stored.status === 'finalized') {
      if (canonicalJson(stored) === canonicalJson(document)) {
        return Promise.resolve(); // idempotent re-save
      }
      return reject(
        `takeoff document "${document.documentId}" is finalized and the incoming document differs; finalized documents are never rewritten`,
      );
    }
    if (stored.status === 'draft' && document.status === 'finalized') {
      return reject(
        `finalization must go through FinalizedTakeoffRepository.save (atomic snapshot), not the document writer`,
      );
    }
    if (stored.status === 'archived' && document.status === 'archived') {
      if (canonicalJson(stored) === canonicalJson(document)) {
        return Promise.resolve();
      }
      return reject(`an archived draft cannot be edited; unarchive it first`);
    }
    if (stored.status === 'archived' && document.status === 'finalized') {
      return reject(`an archived draft cannot be finalized; unarchive it first`);
    }
    if (document.status === 'archived') {
      // draft → archived: content and revision unchanged
      if (takeoffContentJson(document) !== takeoffContentJson(stored)) {
        return reject(`archiving must not change document content or revision`);
      }
      this.#documents.set(document.documentId, document);
      return Promise.resolve();
    }
    if (stored.status === 'archived' && document.status === 'draft') {
      // archived → draft (unarchive): content and revision unchanged
      if (takeoffContentJson(document) !== takeoffContentJson(stored)) {
        return reject(`unarchiving must not change document content or revision`);
      }
      this.#documents.set(document.documentId, document);
      return Promise.resolve();
    }
    // draft → draft: full content replace, revision increments by exactly one
    if (document.revision !== stored.revision + 1) {
      return reject(
        `a draft save must increment the revision by exactly one (${String(stored.revision)} → ${String(document.revision)})`,
      );
    }
    this.#documents.set(document.documentId, document);
    return Promise.resolve();
  }

  /** Internal: applies the finalized document state (used by the finalized adapter only). */
  applyFinalization(document: TakeoffDocument): void {
    this.#documents.set(document.documentId, document);
  }

  findById(documentId: string): Promise<TakeoffDocument | undefined> {
    return Promise.resolve(this.#documents.get(documentId));
  }

  findByTakeoffId(takeoffId: string): Promise<readonly TakeoffDocument[]> {
    return Promise.resolve(
      [...this.#documents.values()]
        .filter((d) => d.takeoffId === takeoffId)
        .sort((a, b) => a.documentNumber - b.documentNumber),
    );
  }

  findByProjectId(projectId: string): Promise<readonly TakeoffDocument[]> {
    return Promise.resolve(
      [...this.#documents.values()]
        .filter((d) => d.projectId === projectId)
        .sort(
          (a, b) => a.takeoffId.localeCompare(b.takeoffId) || a.documentNumber - b.documentNumber,
        ),
    );
  }
}

/** Deterministic in-memory FinalizedTakeoffRepository (reference adapter; no persistence). */
export class InMemoryFinalizedTakeoffRepository implements FinalizedTakeoffRepository {
  readonly #byDocument = new Map<string, FinalizedTakeoff>();
  readonly #documents: InMemoryTakeoffDocumentRepository;

  constructor(documents: InMemoryTakeoffDocumentRepository) {
    this.#documents = documents;
  }

  async save(finalized: FinalizedTakeoff, expectedRevision: number): Promise<void> {
    const stored = await this.#documents.findById(finalized.documentId);
    if (stored === undefined) {
      throw new Error(
        `takeoff document "${finalized.documentId}" is not persisted; create it first`,
      );
    }
    if (expectedRevision !== stored.revision) {
      throw new Error(
        `stale expectedRevision ${String(expectedRevision)} for takeoff document "${finalized.documentId}" (persisted revision is ${String(stored.revision)})`,
      );
    }
    if (stored.status === 'finalized') {
      // Idempotent re-save of the identical bundle is a no-op; different content is immutable.
      const existing = this.#byDocument.get(finalized.documentId);
      if (existing !== undefined) {
        if (canonicalJson(existing) === canonicalJson(finalized)) return;
        throw new Error(
          `a finalized takeoff for document "${finalized.documentId}" already exists with different content; finalized snapshots are never rewritten`,
        );
      }
      throw new Error(
        `takeoff document "${finalized.documentId}" is finalized without a persisted snapshot; the store is inconsistent`,
      );
    }
    if (stored.status !== 'draft') {
      throw new Error(
        `only a draft can be finalized (document "${finalized.documentId}" is ${stored.status})`,
      );
    }
    if (finalized.document.revision !== stored.revision) {
      throw new Error(
        `finalization freezes the draft as-is (revision ${String(stored.revision)}); the bundle carries revision ${String(finalized.document.revision)}`,
      );
    }
    if (takeoffContentJson(finalized.document) !== takeoffContentJson(stored)) {
      throw new Error(
        `the finalized bundle does not match the persisted draft of document "${finalized.documentId}"; finalize exactly the stored content`,
      );
    }
    const existing = this.#byDocument.get(finalized.documentId);
    if (existing !== undefined) {
      if (canonicalJson(existing) === canonicalJson(finalized)) return; // idempotent re-save
      throw new Error(
        `a finalized takeoff for document "${finalized.documentId}" already exists with different content; finalized snapshots are never rewritten`,
      );
    }
    this.#byDocument.set(finalized.documentId, finalized);
    this.#documents.applyFinalization(finalized.document);
  }

  byDocumentId(documentId: string): Promise<FinalizedTakeoff | undefined> {
    return Promise.resolve(this.#byDocument.get(documentId));
  }

  approve(documentId: string, approverUserId: string, approvedAt: string): Promise<boolean> {
    const existing = this.#byDocument.get(documentId);
    if (existing === undefined || (existing.approval ?? null) !== null) {
      return Promise.resolve(false);
    }
    this.#byDocument.set(documentId, {
      ...existing,
      approval: { approvedBy: approverUserId, approvedAt },
    });
    return Promise.resolve(true);
  }
}
