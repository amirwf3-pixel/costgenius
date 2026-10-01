/**
 * P8-A S4 — the reviewer sign-off contract pieces that live in the application layer
 * (CG-GOV-SPEC@0.1.0 §5). Sign-off applies to FINALIZED estimate versions and
 * FINALIZED takeoff documents only, and is a single irreversible transition:
 *
 *     FINALIZED → (Reviewer+ approve) → APPROVED/LOCKED
 *
 * Nothing more exists in this phase: no comments, no rejection, no review states, no
 * assignments, no delegation, no multi-reviewer, no withdraw. The frozen calculation
 * snapshots are byte-unchanged by an approval (§5 immutability) — sign-off is
 * metadata (`approved_by`/`approved_at`), never part of the ReportModel.
 *
 * The guards below are the pure decision layer; the atomic write (the
 * `approved_by IS NULL` guarded UPDATE that makes double approval impossible even
 * under concurrency) lives in the persistence contracts (`FinalizedEstimateRepository
 * .approve` / `FinalizedTakeoffRepository.approve`) and runs in the SAME transaction
 * as the approval audit event (§4.2/§9, wired at the API boundary).
 */
import { parseInstant } from '@costgenius/domain';
import { ProjectsError } from './errors.js';

/** The approval record on a finalized bundle: both set = APPROVED/LOCKED (§5). */
export interface ApprovalRecord {
  /** The approving user (Reviewer+; never the finalizer — the four-eyes rule). */
  readonly approvedBy: string;
  /** Domain Instant of the approval (validated, caller-supplied). */
  readonly approvedAt: string;
}

/**
 * The four-eyes rule (§5): the approver must differ from `finalizedBy`. A legacy row
 * (`finalizedBy` NULL — finalized before V1.1, when no actor was stamped) has no
 * finalizer to collide with and is approvable by any Reviewer+; the rule is total.
 */
export function ensureNotSelfApproval(
  finalizedBy: string | null | undefined,
  approverUserId: string,
): void {
  if (finalizedBy !== null && finalizedBy !== undefined && finalizedBy === approverUserId) {
    throw new ProjectsError(
      'SIGNOFF_SELF_APPROVAL_FORBIDDEN',
      'the user who finalized this resource cannot approve it (four-eyes rule)',
    );
  }
}

/**
 * Fast-path guard (§5): an already-approved bundle answers 409 SIGNOFF_ALREADY_GIVEN —
 * an idempotent conflict, never a silent 200. The authoritative check is the atomic
 * `approve` write (a lost race surfaces the same code); this guard only answers the
 * sequential re-approval attempt before any write is attempted.
 */
export function ensureNotYetApproved(approval: ApprovalRecord | null | undefined): void {
  if (approval !== null && approval !== undefined) {
    throw new ProjectsError(
      'SIGNOFF_ALREADY_GIVEN',
      'this resource is already approved; approval is irreversible and cannot be repeated',
    );
  }
}

/** Validates the approval instant; the value is stored VERBATIM (house convention). */
export function requireApprovalInstant(approvedAt: string): string {
  parseInstant(approvedAt); // validation only — no normalization on the wire
  return approvedAt;
}
