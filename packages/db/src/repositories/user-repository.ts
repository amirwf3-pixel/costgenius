/**
 * Drizzle/PostgreSQL implementation of the governance stores (P8-A S1,
 * CG-GOV-SPEC@0.1.0): `UserStore` over `users` and `SessionStore` over `sessions`.
 *
 * Plain, contract-faithful rows: no secrets are derived here (the scrypt/token logic
 * lives at the API boundary — `apps/api/src/auth.ts`), the stores only persist and
 * fetch. Sessions are the one governance family with delete paths (logout, password-
 * change revocation, lazy expiry cleanup); `users` rows are never deleted — the single
 * save is the bootstrap/creation write, and password changes update exactly the hash
 * column.
 */
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import {
  USER_ROLES,
  type SessionRecord,
  type SessionStore,
  type User,
  type UserRole,
  type UserStore,
} from '@costgenius/projects';
import type { DbClient } from '../client.js';
import { DbError } from '../errors.js';
import { sessions, users } from '../schema/index.js';

/** The row shape `select().from(users)` infers (camelCase property names). */
interface UserRow {
  readonly userId: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly createdAt: string;
}

interface SessionRow {
  readonly sessionTokenHash: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

function userFromRow(row: UserRow): User {
  if (!USER_ROLES.includes(row.role as UserRole)) {
    // unreachable behind the users_role_check constraint — fail loudly, never guess
    throw new DbError('PERSISTENCE_CONFLICT', `user "${row.userId}" has an invalid role`);
  }
  return {
    userId: row.userId,
    username: row.username,
    passwordHash: row.passwordHash,
    role: row.role as UserRole,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    sessionTokenHash: row.sessionTokenHash,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export class DrizzleUserRepository implements UserStore {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async findByUsername(username: string): Promise<User | undefined> {
    const row = (await this.#db.select().from(users).where(eq(users.username, username)))[0];
    return row === undefined ? undefined : userFromRow(row);
  }

  async findById(userId: string): Promise<User | undefined> {
    const row = (await this.#db.select().from(users).where(eq(users.userId, userId)))[0];
    return row === undefined ? undefined : userFromRow(row);
  }

  async count(): Promise<number> {
    const row = (await this.#db.select({ n: sql<number>`count(*)::int` }).from(users))[0];
    return row?.n ?? 0;
  }

  async save(user: User): Promise<void> {
    await this.#db.insert(users).values({
      userId: user.userId,
      username: user.username,
      passwordHash: user.passwordHash,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
    });
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.#db.update(users).set({ passwordHash }).where(eq(users.userId, userId));
  }
}

export class DrizzleSessionRepository implements SessionStore {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async save(session: SessionRecord): Promise<void> {
    await this.#db.insert(sessions).values({
      sessionTokenHash: session.sessionTokenHash,
      userId: session.userId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });
  }

  async findByTokenHash(sessionTokenHash: string): Promise<SessionRecord | undefined> {
    const row = (
      await this.#db.select().from(sessions).where(eq(sessions.sessionTokenHash, sessionTokenHash))
    )[0];
    return row === undefined ? undefined : sessionFromRow(row);
  }

  async deleteByTokenHash(sessionTokenHash: string): Promise<void> {
    await this.#db.delete(sessions).where(eq(sessions.sessionTokenHash, sessionTokenHash));
  }

  async deleteAllByUserExcept(userId: string, keepTokenHash: string): Promise<void> {
    await this.#db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.sessionTokenHash, keepTokenHash)));
  }

  async deleteExpiredBefore(instant: string): Promise<void> {
    await this.#db.delete(sessions).where(lt(sessions.expiresAt, instant));
  }
}
