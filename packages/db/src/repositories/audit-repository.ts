/**
 * Drizzle/PostgreSQL implementation of `AuditEventRepository` (P8-A S3,
 * CG-GOV-SPEC@0.1.0 §4) — the canonical append-only audit writer.
 *
 * INSERT is the only operation this class can express: there is no update, no
 * delete and no read method (§4.2 — reads are a DB/ops concern in V1.1; the
 * migration additionally REVOKEs UPDATE/DELETE at the database level). The
 * executor is INJECTED (`DbExecutor`), so the writer always participates in the
 * CALLER'S transaction — the same `BEGIN … COMMIT` as the mutation itself
 * (§4.2/D-007: no audit gaps, no orphan events; a failed mutation leaves zero
 * events). Constructing it over the pool is only legitimate for standalone
 * events (§4.4 `auth.login_failed` — the single unauthenticated write path).
 */
import type { AuditEvent, AuditEventRepository } from '@costgenius/projects';
import type { DbExecutor } from '../db-executor.js';
import { auditEvents } from '../schema/index.js';

export class DrizzleAuditEventRepository implements AuditEventRepository {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async append(event: AuditEvent): Promise<void> {
    await this.#db.insert(auditEvents).values({
      eventId: event.eventId,
      at: event.at,
      actorUserId: event.actorUserId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      projectId: event.projectId,
      details: event.details,
    });
  }
}
