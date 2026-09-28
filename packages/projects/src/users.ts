/**
 * Governance persistence contracts (P8-A, CG-GOV-SPEC@0.1.0 §1/§7) — the user and
 * session stores the API's authentication boundary depends on. These are CONTRACTS
 * ONLY in this package (types + repository interfaces, no behavior): the authentication
 * logic (scrypt hashing, token generation, login/logout) lives at the API boundary
 * (`apps/api/src/auth.ts`), and the Drizzle/PostgreSQL implementation lives in
 * `@costgenius/db` — the same contracts/adapter split every other resource family uses.
 *
 * The pure calculation stack (calc-engine, domain, cost-calculation) never imports this
 * module: actors, roles and sessions stop at the application/persistence boundary
 * (CG-GOV §6). Phase 8 S1 implements authentication only — RBAC enforcement, audit
 * events and reviewer sign-off are later stages; `role` exists here because it is part
 * of the closed users contract, not because any authorization logic exists yet.
 */

/** The five roles of PROJECT_SCOPE §4 — exactly these, no others (CG-GOV §2.1). */
export type UserRole = 'org_admin' | 'estimator' | 'reviewer' | 'viewer' | 'data_steward';

export const USER_ROLES: readonly UserRole[] = [
  'org_admin',
  'estimator',
  'reviewer',
  'viewer',
  'data_steward',
];

/**
 * A local account. `passwordHash` is the scrypt encoding of CG-GOV §1.2
 * (`scrypt$N$r$p$salt$hash`) — it never leaves the persistence/API boundary: no route,
 * log or report may serialize it.
 */
export interface User {
  readonly userId: string;
  /** Stored lowercase; unique case-insensitively (CG-GOV §1.1). */
  readonly username: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly isActive: boolean;
  /** Domain Instant (UTC ISO string), stored verbatim. */
  readonly createdAt: string;
}

/**
 * A server-side session. The client holds the opaque 256-bit token; only its SHA-256
 * hex digest is persisted (`sessionTokenHash`) — a leaked database does not yield
 * usable tokens (CG-GOV §1.3). Absolute expiration (12h); no idle timeout.
 */
export interface SessionRecord {
  readonly sessionTokenHash: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Persistence contract for `users` (implemented by `@costgenius/db`). */
export interface UserStore {
  readonly findByUsername: (username: string) => Promise<User | undefined>;
  readonly findById: (userId: string) => Promise<User | undefined>;
  /** Number of users — the bootstrap rule ("only when the table is empty") reads it. */
  readonly count: () => Promise<number>;
  readonly save: (user: User) => Promise<void>;
  readonly updatePasswordHash: (userId: string, passwordHash: string) => Promise<void>;
}

/** Persistence contract for `sessions` (implemented by `@costgenius/db`). */
export interface SessionStore {
  readonly save: (session: SessionRecord) => Promise<void>;
  readonly findByTokenHash: (sessionTokenHash: string) => Promise<SessionRecord | undefined>;
  /** Logout: deletes exactly this session row. */
  readonly deleteByTokenHash: (sessionTokenHash: string) => Promise<void>;
  /** Password change: revokes every session of the user EXCEPT `keepTokenHash`. */
  readonly deleteAllByUserExcept: (userId: string, keepTokenHash: string) => Promise<void>;
  /** Lazy cleanup of expired rows on lookup (CG-GOV §1.3). */
  readonly deleteExpiredBefore: (instant: string) => Promise<void>;
}
