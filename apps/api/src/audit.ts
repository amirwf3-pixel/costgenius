/**
 * The S3 audit boundary helpers (P8-A S3, CG-GOV-SPEC@0.1.0 §4/§6) — the unit of
 * work every audited mutation runs in, and the event stamper.
 *
 * `TransactionalRepositories` is the full repository set re-bound to ONE database
 * transaction: the handler (or governance service) performs the mutation and then
 * appends the audit event on the SAME transaction object, so the pair commits or
 * rolls back together (§4.2/D-007 — a failed mutation leaves zero events; an event
 * never exists without its mutation). The repositories' own internal transactions
 * become savepoints of this outer transaction — one connection, one commit
 * boundary, no second persistence architecture.
 *
 * `appendAuditEvent` stamps the two boundary-owned fields — `eventId` (fresh UUID,
 * like every domain identity) and `at` (the injected clock, never a wall-clock read
 * here) — and appends through the transaction-bound writer. The actor is ALWAYS the
 * authenticated identity resolved by the route gate, never a client-supplied value;
 * the one exception is `auth.login_failed`, the contract's single null-actor event
 * (§4.4), which is appended standalone (pool-bound) because there is no other
 * mutation to share a transaction with.
 */
import { randomUUID } from 'node:crypto';
import type {
  AuditEventRepository,
  AuditEventSpec,
  EstimateRepository,
  FinalizedEstimateRepository,
  FinalizedTakeoffRepository,
  PricebookEditionRepository,
  ProjectRepository,
  SessionStore,
  TakeoffDocumentRepository,
  UserStore,
} from '@costgenius/projects';

/** Every repository, re-bound to one transaction (the S3 audit unit of work). */
export interface TransactionalRepositories {
  readonly projects: ProjectRepository;
  readonly estimates: EstimateRepository;
  readonly finalized: FinalizedEstimateRepository;
  readonly takeoffDocuments: TakeoffDocumentRepository;
  readonly finalizedTakeoffs: FinalizedTakeoffRepository;
  readonly users: UserStore;
  readonly sessions: SessionStore;
  readonly audit: AuditEventRepository;
  /** P8-B S1: the edition repository joins the unit of work (the seed's insert + events + backfill). */
  readonly editions: PricebookEditionRepository;
}

/** The transaction capability injected into the API (pool-bound reads stay on `repositories`/`governance`). */
export type Transact = <T>(work: (tx: TransactionalRepositories) => Promise<T>) => Promise<T>;

/**
 * Stamps the boundary-owned identity fields and appends the event through the
 * caller's (transaction-bound) audit writer. One call per catalog event — exactly
 * after the mutation succeeded inside the same transaction (§4.2/§4.3).
 */
export async function appendAuditEvent(
  audit: AuditEventRepository,
  spec: AuditEventSpec,
  clock: () => string,
): Promise<void> {
  await audit.append({ eventId: randomUUID(), at: clock(), ...spec });
}
