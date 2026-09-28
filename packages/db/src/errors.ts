/**
 * Persistence-layer errors of `@costgenius/db`.
 *
 * Stable codes only, all deterministic and testable:
 * - `FINALIZED_ESTIMATE_IMMUTABLE`: history was rewritten — a finalized version or
 *   finalized bundle was presented with different content than what is persisted
 *   (including a downgrade back to draft). Finalized data is never updated or deleted.
 * - `PERSISTENCE_CONFLICT`: an impossible-via-domain integrity violation (identity
 *   mismatch of a stored project/estimate, an attempt to rewrite draft-version lines,
 *   a missing prerequisite row). The message names the exact conflict.
 * - `TAKEOFF_DOCUMENT_IMMUTABLE` (D-016): a finalized takeoff document or snapshot was
 *   presented with different content than what is persisted. Finalized takeoffs are
 *   never rewritten; follow-up changes go through a new document revision.
 * - `TAKEOFF_INVALID_TRANSITION` (D-016): an illegal takeoff lifecycle transition
 *   (e.g. finalizing an archived draft, or a draft→finalized save outside the atomic
 *   finalized-takeoff writer).
 *
 * Engine/domain errors (BoqError, ProjectsError, DomainError, drizzle/pg errors)
 * propagate unchanged — never swallowed, never repaired.
 */
export type DbErrorCode =
  | 'FINALIZED_ESTIMATE_IMMUTABLE'
  | 'PERSISTENCE_CONFLICT'
  | 'TAKEOFF_DOCUMENT_IMMUTABLE'
  | 'TAKEOFF_INVALID_TRANSITION';

export class DbError extends Error {
  constructor(
    readonly code: DbErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DbError';
  }
}
