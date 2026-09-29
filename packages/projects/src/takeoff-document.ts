/**
 * Full Takeoff document model and lifecycle (D-016, CG-FT-TAKEOFF-SPEC@0.1.0 §2–§5).
 *
 * The document is the D-016 first-class persisted resource: a chain member identified by
 * `takeoffId` (chain) + `documentNumber` (sequential per chain) with a per-revision
 * `documentId`. Drafts are fully editable (G4=B): `saveTakeoffDocumentDraft` replaces the
 * complete content (title, sheets, lines, rounding rule set) and bumps `revision` — the
 * optimistic-concurrency counter the store checks against `expectedRevision`. Archive is
 * soft (G1b=C); finalization is the one-way transition that freezes the document and
 * records the immutable snapshot (G1=A, finalized_estimates pattern). Follow-up revisions
 * copy a finalized document verbatim with stable `lineId`s (§2.4).
 *
 * This layer owns no calculation: `finalizeTakeoffDocument` delegates to the pure engine
 * (`calculateTakeoff`, CG-IR-MEAS@0.2.0) and requires a valid result; the persisted line
 * and sheet shapes ARE the engine input shapes, so persistence round-trips without
 * semantic loss by construction.
 */
import {
  calculateTakeoff,
  type RoundingRuleSet,
  type TakeoffCalculationInput,
  type TakeoffLineInput,
  type TakeoffQuantity,
  type TakeoffResult,
  type TakeoffSheetInput,
} from '@costgenius/calc-engine';
import { parseInstant } from '@costgenius/domain';
import { ProjectsError } from './errors.js';
import type { ApprovalRecord } from './signoff.js';
import type { Project } from './project.js';

export type TakeoffDocumentStatus = 'draft' | 'archived' | 'finalized';

/**
 * A takeoff sheet/line in engine shape (CG-IR-MEAS@0.2.0 §2): the persisted
 * representation IS the calculation input, never a derived or flattened variant.
 */
export type TakeoffDocumentSheet = TakeoffSheetInput;
export type TakeoffDocumentLine = TakeoffLineInput;

export interface TakeoffDocument {
  /** Per-revision identity (API addressing and provenance use this). */
  readonly documentId: string;
  /** Chain identity — stable across all revisions of one takeoff. */
  readonly takeoffId: string;
  readonly projectId: string;
  readonly title: string;
  /** Sequential within the chain; unique together with `takeoffId`. */
  readonly documentNumber: number;
  readonly status: TakeoffDocumentStatus;
  /** Optimistic-concurrency counter; starts at 1, +1 per draft content save. */
  readonly revision: number;
  /** Document-level explicit rounding rules (§6); may be empty. */
  readonly rounding: RoundingRuleSet;
  /** Sheets in presentation order (`sheetOrder` is the array position). */
  readonly sheets: readonly TakeoffDocumentSheet[];
  /** Domain Instant, supplied by the caller (this layer reads no clock). */
  readonly createdAt: string;
  readonly archivedAt?: string;
  readonly finalizedAt?: string;
}

/** The complete editable content of a takeoff document (CG-FT §4: full-document replace). */
export interface TakeoffDocumentContent {
  readonly title: string;
  readonly sheets: readonly TakeoffDocumentSheet[];
  readonly rounding: RoundingRuleSet;
}

/** The immutable finalization record (CG-FT §2.3/§14): exact input + verbatim result. */
export interface FinalizedTakeoff {
  readonly document: TakeoffDocument;
  readonly documentId: string;
  readonly takeoffId: string;
  readonly documentNumber: number;
  /** Domain Instant. */
  readonly finalizedAt: string;
  /**
   * P8-A S4 (CG-GOV §5): who finalized — the actor stamped at finalization. NULL on
   * rows finalized before V1.1 (legacy; Reviewer+ may approve those).
   */
  readonly finalizedBy?: string | null;
  /**
   * P8-A S4 (CG-GOV §5): the approval record. Absent/NULL = not approved; set =
   * APPROVED/LOCKED (irreversible in this phase). Never part of the calculation
   * snapshot — approval leaves every frozen column byte-identical.
   */
  readonly approval?: ApprovalRecord | null;
  /** The exact engine input that produced the result (deterministic replay record). */
  readonly input: TakeoffCalculationInput;
  /** The engine result, verbatim. */
  readonly result: TakeoffResult;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}

/**
 * Runtime array guard that preserves the element type (a bare `Array.isArray` narrows
 * `readonly T[]` to `any[]`, which would poison every downstream spread).
 */
function requireArray<T>(value: readonly T[], field: string): readonly T[] {
  // guard via an `unknown` alias: narrowing the alias leaves `value`'s type intact
  const opaque: unknown = value;
  if (!Array.isArray(opaque)) {
    throw new ProjectsError('INVALID_TAKEOFF_INPUT', `${field} must be an array`);
  }
  return value;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProjectsError('INVALID_TAKEOFF_INPUT', `${field} must be a non-empty string`);
  }
  return value;
}

function requireInstant(value: string, field: string): string {
  try {
    parseInstant(value);
  } catch {
    throw new ProjectsError(
      'INVALID_TAKEOFF_INPUT',
      `${field} must be a valid ISO-8601 instant: ${value}`,
    );
  }
  return value;
}

export interface CreateTakeoffDocumentInput {
  readonly takeoffId: string;
  readonly documentId: string;
  readonly title: string;
  /** Domain Instant (validated; this layer reads no clock). */
  readonly createdAt: string;
}

/** Creates a new takeoff chain's first document: `documentNumber` 1, `revision` 1, draft. */
export function createTakeoffDocument(
  project: Project,
  input: CreateTakeoffDocumentInput,
): TakeoffDocument {
  const takeoffId = requireNonEmpty(input.takeoffId, 'takeoffId');
  const documentId = requireNonEmpty(input.documentId, 'documentId');
  const title = requireNonEmpty(input.title, 'title');
  const createdAt = requireInstant(input.createdAt, 'createdAt');
  return deepFreeze({
    documentId,
    takeoffId,
    projectId: project.projectId,
    title,
    documentNumber: 1,
    status: 'draft',
    revision: 1,
    rounding: [],
    sheets: [],
    createdAt,
  });
}

/** Reconstructs the exact `calculateTakeoff` input of a document (sheets then rounding). */
export function takeoffCalculationInputOf(document: TakeoffDocument): TakeoffCalculationInput {
  return { sheets: [...document.sheets], rounding: [...document.rounding] };
}

/**
 * Replaces the complete content of a DRAFT document (title, sheets, lines, rounding) and
 * bumps `revision` by exactly one (CG-FT §4). The store enforces `expectedRevision`
 * against the persisted row; the caller passes the loaded revision there.
 */
export function saveTakeoffDocumentDraft(
  document: TakeoffDocument,
  content: TakeoffDocumentContent,
): TakeoffDocument {
  if (document.status !== 'draft') {
    throw new ProjectsError(
      'TAKEOFF_INVALID_TRANSITION',
      `only a draft can be saved (document "${document.documentId}" is ${document.status})`,
    );
  }
  const title = requireNonEmpty(content.title, 'title');
  const rounding = requireArray(content.rounding, 'rounding');
  const sheets = requireArray(content.sheets, 'sheets');
  return deepFreeze({
    ...document,
    title,
    rounding: [...rounding],
    sheets: [...sheets],
    revision: document.revision + 1,
  });
}

/** draft → archived (soft; content and revision unchanged; CG-FT §2.3/§2.5). */
export function archiveTakeoffDocument(
  document: TakeoffDocument,
  archivedAt: string,
): TakeoffDocument {
  if (document.status !== 'draft') {
    throw new ProjectsError(
      'TAKEOFF_INVALID_TRANSITION',
      `only a draft can be archived (document "${document.documentId}" is ${document.status})`,
    );
  }
  return deepFreeze({
    ...document,
    status: 'archived',
    archivedAt: requireInstant(archivedAt, 'archivedAt'),
  });
}

/** archived → draft (recoverable; content and revision unchanged; CG-FT §2.3/§2.5). */
export function unarchiveTakeoffDocument(document: TakeoffDocument): TakeoffDocument {
  if (document.status !== 'archived') {
    throw new ProjectsError(
      'TAKEOFF_INVALID_TRANSITION',
      `only an archived draft can be unarchived (document "${document.documentId}" is ${document.status})`,
    );
  }
  return deepFreeze({
    documentId: document.documentId,
    takeoffId: document.takeoffId,
    projectId: document.projectId,
    title: document.title,
    documentNumber: document.documentNumber,
    status: 'draft',
    revision: document.revision,
    rounding: document.rounding,
    sheets: document.sheets,
    createdAt: document.createdAt,
  });
}

export interface FinalizeTakeoffOptions {
  /** Domain Instant (validated; this layer reads no clock). */
  readonly finalizedAt: string;
  /**
   * P8-A S4 (CG-GOV §5): the finalizing actor, stamped as `finalized_by`. Optional so
   * pre-V1.1 callers and fixtures stay valid; the API always passes the authenticated
   * user (the four-eyes rule of §5 depends on it).
   */
  readonly finalizedBy?: string | null;
}

/**
 * Stateless draft calculation preview (CG-FT@0.2.0 §16, D-PREVIEW=B): calculates the
 * CURRENT persisted draft content through the existing engine — the very same input
 * reconstruction and the very same `calculateTakeoff` finalization runs — and returns
 * the engine result VERBATIM (ok or error; the caller maps failures to the structured
 * `TAKEOFF_SOLUTION_REJECTED` preview contract, never `TAKEOFF_CALCULATION_FAILED`).
 *
 * Pure and non-mutating by construction: no persistence, no revision change, no
 * snapshot, no BOQ effect; only a DRAFT may be previewed (archived/finalized documents
 * keep the existing `TAKEOFF_INVALID_TRANSITION` lifecycle semantics — a finalized
 * result already exists and is immutable).
 */
export function previewTakeoffDocumentCalculation(document: TakeoffDocument): TakeoffResult {
  if (document.status !== 'draft') {
    throw new ProjectsError(
      'TAKEOFF_INVALID_TRANSITION',
      `only a draft can be previewed (document "${document.documentId}" is ${document.status})`,
    );
  }
  return calculateTakeoff(takeoffCalculationInputOf(document));
}

/**
 * Finalizes a DRAFT takeoff (CG-FT §2.3/§12): reconstructs the canonical calculation
 * input, runs `calculateTakeoff`, and requires a valid result — any engine error rejects
 * the finalization (nothing is finalized; the document is returned untouched by the
 * caller's flow). On success the document becomes `finalized` (revision unchanged —
 * finalization freezes content, it does not mutate it) and the bundle carries the exact
 * input and the verbatim result for the immutable snapshot.
 */
export function finalizeTakeoffDocument(
  document: TakeoffDocument,
  options: FinalizeTakeoffOptions,
): FinalizedTakeoff {
  if (document.status !== 'draft') {
    throw new ProjectsError(
      'TAKEOFF_INVALID_TRANSITION',
      `only a draft can be finalized (document "${document.documentId}" is ${document.status})`,
    );
  }
  const finalizedAt = requireInstant(options.finalizedAt, 'finalizedAt');
  const input = takeoffCalculationInputOf(document);
  const result = calculateTakeoff(input);
  if (result.status !== 'ok') {
    throw new ProjectsError(
      'TAKEOFF_CALCULATION_FAILED',
      `takeoff document "${document.documentId}" does not calculate: ${result.errors
        .map((e) => `${e.code}(${e.lineId ?? e.sheetId ?? e.field ?? '*'})`)
        .join(', ')}`,
    );
  }
  const finalizedDocument: TakeoffDocument = deepFreeze({
    ...document,
    status: 'finalized',
    finalizedAt,
  });
  return deepFreeze({
    document: finalizedDocument,
    documentId: document.documentId,
    takeoffId: document.takeoffId,
    documentNumber: document.documentNumber,
    finalizedAt,
    // S4 (CG-GOV §5): the finalizing actor + the (initially absent) approval state.
    finalizedBy: options.finalizedBy ?? null,
    approval: null,
    input,
    result,
  });
}

export interface FollowUpTakeoffInput {
  readonly documentId: string;
  /** Domain Instant of the follow-up draft's creation. */
  readonly createdAt: string;
}

/**
 * Creates the follow-up revision of a FINALIZED document (CG-FT §2.3/§2.4): a verbatim
 * copy (same `sheetId`s, `lineId`s, `rowNo`s, expressions, rounding rules) as a new draft
 * with `documentNumber + 1` in the same chain and `revision` restarting at 1. Stable
 * `lineId`s give cross-revision traceability.
 */
export function createFollowUpTakeoffDocument(
  document: TakeoffDocument,
  input: FollowUpTakeoffInput,
): TakeoffDocument {
  if (document.status !== 'finalized') {
    throw new ProjectsError(
      'TAKEOFF_INVALID_TRANSITION',
      `a follow-up revision can only be created from a finalized document (document "${document.documentId}" is ${document.status})`,
    );
  }
  const documentId = requireNonEmpty(input.documentId, 'documentId');
  const createdAt = requireInstant(input.createdAt, 'createdAt');
  return deepFreeze({
    documentId,
    takeoffId: document.takeoffId,
    projectId: document.projectId,
    title: document.title,
    documentNumber: document.documentNumber + 1,
    status: 'draft',
    revision: 1,
    rounding: [...document.rounding],
    sheets: [...document.sheets],
    createdAt,
  });
}

/** Narrowed view of a takeoff line's quantity tree (persistence validation helper). */
export function takeoffQuantityOf(line: TakeoffDocumentLine): TakeoffQuantity {
  return line.quantity;
}
