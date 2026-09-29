/**
 * The P8-A S3 audit event contract (CG-GOV-SPEC@0.1.0 §4) — the canonical payload
 * shapes and the COMPLETE, CLOSED event catalog as pure builder functions.
 *
 * Layering (CG-GOV §6): this module is the application-layer vocabulary — the API
 * boundary resolves the actor from the authenticated session, calls exactly one
 * builder per successful mutation, and hands the spec to the transaction-bound
 * `AuditEventRepository` (`@costgenius/db`), which appends it in the SAME database
 * transaction as the mutation. The pure calculation stack never imports this module;
 * no builder reads the clock, generates ids or performs I/O — `eventId`/`at` are
 * stamped by the API boundary (injected clock, fresh UUID) exactly like every other
 * domain identity.
 *
 * The catalog is EXACTLY §4.3 + §4.4 — no additional actions, no renames, no generic
 * request/route events. The two approval events (`estimate_version.approved`,
 * `takeoff_document.approved`) belong to the S4 sign-off stage: their builders exist
 * so the writer contract is complete, but NO route reaches them until S4 — nothing
 * here invents an approval operation.
 *
 * Governance-event resources (§4.4 names no resource columns): the affected resource
 * of every user-management event is the TARGET user, and of every auth event the
 * authenticating principal — `resourceType: 'user'` with the canonical `userId`, or
 * the attempted username for `auth.login_failed`, where no user may be resolved
 * without distinguishing unknown-user from wrong-password (§1.4). `projectId` is
 * null for every governance event (they are not project resources).
 */
import type { Estimate, EstimateVersion } from '@costgenius/boq';
import type { FinalizedEstimate } from './estimate-calculation.js';
import type { Project } from './project.js';
import type { FinalizedTakeoff, TakeoffDocument } from './takeoff-document.js';
import type { UserRole } from './users.js';

/** The authenticated actor of a mutation — resolved by the API boundary, never client-supplied (§6). */
export interface Actor {
  readonly userId: string;
  readonly username: string;
}

/** The complete audit action catalog (CG-GOV §4.3 + §4.4) — exactly these twenty, nothing else. */
export type AuditAction =
  | 'project.created'
  | 'estimate.created'
  | 'estimate_version.created'
  | 'boq_lines.added'
  | 'estimate_version.finalized'
  | 'takeoff_document.created'
  | 'takeoff_document.saved'
  | 'takeoff_document.archived'
  | 'takeoff_document.unarchived'
  | 'takeoff_document.finalized'
  | 'takeoff_document.follow_up_created'
  | 'takeoff_document.transferred_to_boq'
  | 'estimate_version.approved'
  | 'takeoff_document.approved'
  | 'auth.login_succeeded'
  | 'auth.login_failed'
  | 'auth.password_changed'
  | 'user.created'
  | 'user.role_changed'
  | 'user.deactivated';

/** The resource kinds of the catalog: the §4.3 domain resources plus the governance user. */
export type AuditResourceType =
  'project' | 'estimate' | 'estimate_version' | 'takeoff_document' | 'user';

/** The append payload (§4.1 minus the boundary-stamped `eventId`/`at`). */
export interface AuditEventSpec {
  /** The authenticated actor; null ONLY for `auth.login_failed` (§4.4). */
  readonly actorUserId: string | null;
  readonly action: AuditAction;
  readonly resourceType: AuditResourceType;
  readonly resourceId: string;
  /** The owning project, or null when the resource is not a project resource (§4.4). */
  readonly projectId: string | null;
  /** Small, structured, contract-approved metadata ONLY (§4.1) — never stringified payloads. */
  readonly details: Readonly<Record<string, unknown>>;
}

/** The full audit record as persisted (§4.1) — `eventId`/`at` are stamped at the API boundary. */
export interface AuditEvent extends AuditEventSpec {
  readonly eventId: string;
  readonly at: string;
}

/**
 * The append-only audit writer contract (§4.2). `append` is the ONLY method: there is
 * deliberately no update, no delete and no read path — reads are a DB/ops concern in
 * V1.1 (no audit read API). Implementations MUST run on the caller's transaction
 * (the mutation's own transaction) so a failed mutation leaves zero events.
 */
export interface AuditEventRepository {
  append(event: AuditEvent): Promise<void>;
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

function domainEvent(
  actor: Actor,
  action: AuditAction,
  resourceType: AuditResourceType,
  resourceId: string,
  projectId: string | null,
  details: Record<string, unknown>,
): AuditEventSpec {
  return deepFreeze({
    actorUserId: actor.userId,
    action,
    resourceType,
    resourceId,
    projectId,
    details,
  });
}

function userResourceEvent(
  actorUserId: string | null,
  action: AuditAction,
  resourceId: string,
  details: Record<string, unknown>,
): AuditEventSpec {
  return deepFreeze({
    actorUserId,
    action,
    resourceType: 'user' as const,
    resourceId,
    projectId: null,
    details,
  });
}

/* ------------------------------------------------------------------------------------------------
 * Domain-mutation events (§4.3 — exactly the inventory rows, exact details)
 * -----------------------------------------------------------------------------------------------*/

/** `project.created` — resource: the new project; `projectId`: self; details: `{title}`. */
export function projectCreated(actor: Actor, project: Project): AuditEventSpec {
  return domainEvent(actor, 'project.created', 'project', project.projectId, project.projectId, {
    title: project.title,
  });
}

/**
 * `estimate.created` — details `{estimateNumber?}` is OPTIONAL in the catalog and the
 * domain carries no estimate number, so the details are empty (nothing is invented).
 */
export function estimateCreated(actor: Actor, estimate: Estimate): AuditEventSpec {
  return domainEvent(
    actor,
    'estimate.created',
    'estimate',
    estimate.estimateId,
    estimate.projectId,
    {},
  );
}

/** `estimate_version.created` — details: `{versionNumber}`. */
export function estimateVersionCreated(
  actor: Actor,
  estimate: Estimate,
  version: EstimateVersion,
): AuditEventSpec {
  return domainEvent(
    actor,
    'estimate_version.created',
    'estimate_version',
    version.versionId,
    estimate.projectId,
    { versionNumber: version.versionNumber },
  );
}

/** `boq_lines.added` — ONE event per all-or-nothing batch; details: `{count, lineIds}`. */
export function boqLinesAdded(
  actor: Actor,
  estimate: Estimate,
  versionId: string,
  lineIds: readonly string[],
): AuditEventSpec {
  return domainEvent(actor, 'boq_lines.added', 'estimate_version', versionId, estimate.projectId, {
    count: lineIds.length,
    lineIds: [...lineIds],
  });
}

/** `estimate_version.finalized` — details: `{rollupTotal}` (the chained total, null-safe). */
export function estimateVersionFinalized(
  actor: Actor,
  estimate: Estimate,
  finalized: FinalizedEstimate,
): AuditEventSpec {
  return domainEvent(
    actor,
    'estimate_version.finalized',
    'estimate_version',
    finalized.versionId,
    estimate.projectId,
    { rollupTotal: finalized.calculation.s4Result.finalEstimate },
  );
}

/** `takeoff_document.created` — details: `{documentNumber, title}`. */
export function takeoffDocumentCreated(actor: Actor, document: TakeoffDocument): AuditEventSpec {
  return domainEvent(
    actor,
    'takeoff_document.created',
    'takeoff_document',
    document.documentId,
    document.projectId,
    { documentNumber: document.documentNumber, title: document.title },
  );
}

/** `takeoff_document.saved` — details: `{expectedRevision, revision}` (the new revision). */
export function takeoffDocumentSaved(
  actor: Actor,
  documentId: string,
  projectId: string,
  expectedRevision: number,
  revision: number,
): AuditEventSpec {
  return domainEvent(actor, 'takeoff_document.saved', 'takeoff_document', documentId, projectId, {
    expectedRevision,
    revision,
  });
}

/** `takeoff_document.archived` — the post-transition document; details: `{revision}`. */
export function takeoffDocumentArchived(actor: Actor, document: TakeoffDocument): AuditEventSpec {
  return domainEvent(
    actor,
    'takeoff_document.archived',
    'takeoff_document',
    document.documentId,
    document.projectId,
    { revision: document.revision },
  );
}

/** `takeoff_document.unarchived` — the post-transition document; details: `{revision}`. */
export function takeoffDocumentUnarchived(actor: Actor, document: TakeoffDocument): AuditEventSpec {
  return domainEvent(
    actor,
    'takeoff_document.unarchived',
    'takeoff_document',
    document.documentId,
    document.projectId,
    { revision: document.revision },
  );
}

/** `takeoff_document.finalized` — details: `{documentNumber}`. */
export function takeoffDocumentFinalized(
  actor: Actor,
  finalized: FinalizedTakeoff,
): AuditEventSpec {
  return domainEvent(
    actor,
    'takeoff_document.finalized',
    'takeoff_document',
    finalized.documentId,
    finalized.document.projectId,
    { documentNumber: finalized.documentNumber },
  );
}

/** `takeoff_document.follow_up_created` — resource: the NEW document; details: `{sourceDocumentId, documentNumber}`. */
export function takeoffDocumentFollowUpCreated(
  actor: Actor,
  followUp: TakeoffDocument,
  sourceDocumentId: string,
): AuditEventSpec {
  return domainEvent(
    actor,
    'takeoff_document.follow_up_created',
    'takeoff_document',
    followUp.documentId,
    followUp.projectId,
    { sourceDocumentId, documentNumber: followUp.documentNumber },
  );
}

/** `takeoff_document.transferred_to_boq` — details: `{targetVersionId, lineCount}`. */
export function takeoffDocumentTransferredToBoq(
  actor: Actor,
  documentId: string,
  projectId: string,
  targetVersionId: string,
  lineCount: number,
): AuditEventSpec {
  return domainEvent(
    actor,
    'takeoff_document.transferred_to_boq',
    'takeoff_document',
    documentId,
    projectId,
    { targetVersionId, lineCount },
  );
}

/* ------------------------------------------------------------------------------------------------
 * Approval events (§4.3 rows #37/#38) — S4 scope. The builders complete the writer
 * contract; NO route reaches them until the S4 sign-off stage exists. The payload is
 * actor + instant by design (§4.3: no details).
 * -----------------------------------------------------------------------------------------------*/

/** `estimate_version.approved` (S4 — written ONLY by the #37 approve route, in the same transaction as the approval). */
export function estimateVersionApproved(
  actor: Actor,
  versionId: string,
  projectId: string,
): AuditEventSpec {
  return domainEvent(
    actor,
    'estimate_version.approved',
    'estimate_version',
    versionId,
    projectId,
    {},
  );
}

/** `takeoff_document.approved` (S4 — written ONLY by the #38 approve route, in the same transaction as the approval). */
export function takeoffDocumentApproved(
  actor: Actor,
  documentId: string,
  projectId: string,
): AuditEventSpec {
  return domainEvent(
    actor,
    'takeoff_document.approved',
    'takeoff_document',
    documentId,
    projectId,
    {},
  );
}

/* ------------------------------------------------------------------------------------------------
 * Governance events (§4.4 — exact actors, exact details)
 * -----------------------------------------------------------------------------------------------*/

/** `auth.login_succeeded` — actor: the authenticated user; details: `{username}`. */
export function authLoginSucceeded(user: { userId: string; username: string }): AuditEventSpec {
  return userResourceEvent(user.userId, 'auth.login_succeeded', user.userId, {
    username: user.username,
  });
}

/**
 * `auth.login_failed` — the single null-actor event (§4.4). The resource is the
 * attempted principal identified by the (normalized when valid) username — the only
 * identifier available before authentication, and IDENTICAL for unknown-user and
 * wrong-password so the event never distinguishes them (§1.4).
 */
export function authLoginFailed(attemptedUsername: string): AuditEventSpec {
  return userResourceEvent(null, 'auth.login_failed', attemptedUsername, {
    username: attemptedUsername,
  });
}

/** `auth.password_changed` — actor: the authenticated user (self); no details (§4.4). */
export function authPasswordChanged(actor: Actor): AuditEventSpec {
  return userResourceEvent(actor.userId, 'auth.password_changed', actor.userId, {});
}

/** `user.created` — actor: the org_admin; resource: the NEW user; details: `{username, role}`. */
export function userCreated(
  actor: Actor,
  created: { userId: string; username: string; role: UserRole },
): AuditEventSpec {
  return userResourceEvent(actor.userId, 'user.created', created.userId, {
    username: created.username,
    role: created.role,
  });
}

/** `user.role_changed` — actor: the org_admin; resource: the TARGET user; details: `{from, to}`. */
export function userRoleChanged(
  actor: Actor,
  targetUserId: string,
  from: UserRole,
  to: UserRole,
): AuditEventSpec {
  return userResourceEvent(actor.userId, 'user.role_changed', targetUserId, { from, to });
}

/** `user.deactivated` — actor: the org_admin; resource: the TARGET user; details: `{username}`. */
export function userDeactivated(
  actor: Actor,
  target: { userId: string; username: string },
): AuditEventSpec {
  return userResourceEvent(actor.userId, 'user.deactivated', target.userId, {
    username: target.username,
  });
}
