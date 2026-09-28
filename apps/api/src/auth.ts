/**
 * The authentication & session core (P8-A S1, CG-GOV-SPEC@0.1.0 §1) — the ONLY place
 * credentials and session tokens are handled. Lives at the API boundary on purpose:
 * the pure calculation stack (calc-engine/domain/cost-calculation) never sees users,
 * roles or sessions (CG-GOV §6); this module talks to the `UserStore`/`SessionStore`
 * contracts (`@costgenius/projects`) implemented by `@costgenius/db`.
 *
 * Contract-faithful by construction:
 * - scrypt (node:crypto, no new dependency): N=16384, r=8, p=1, 64-byte key, 16-byte
 *   per-user salt, encoded `scrypt$N$r$p$salt$hash` (CG-GOV §1.2);
 * - constant-time verification (timingSafeEqual), a dummy verification when the
 *   username is unknown so login timing does not enumerate users (§1.4);
 * - opaque 256-bit session tokens; only SHA-256(token) is persisted (§1.3);
 * - absolute 12-hour expiration, no idle timeout (§1.3);
 * - deactivated users fail every existing session (§1.6) and fail login with the SAME
 *   uniform error as unknown users and wrong passwords (§1.4);
 * - bootstrap: exactly one initial org_admin from env vars, and fail-closed startup
 *   when the users table is empty and the vars are absent (§1.5).
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { SessionRecord, SessionStore, User, UserStore } from '@costgenius/projects';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** scrypt parameters of the closed contract (CG-GOV §1.2) — do not change. */
const SCRYPT = { N: 16384, r: 8, p: 1, KEY_LENGTH: 64, SALT_LENGTH: 16 } as const;

/** Absolute session lifetime: 12 hours from login (CG-GOV §1.3). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Username identity rule: 3–64 chars of `a-z 0-9 . _ -`, stored lowercase (§1.1). */
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;

export const SESSION_COOKIE_NAME = 'cg_session';

/** Passwords: 8–128 UTF-8 characters, any characters; length is the policy (§1.2). */
export function isValidPassword(password: string): boolean {
  return password.length >= 8 && password.length <= 128;
}

/** Normalizes then validates a username (§1.1); returns undefined when invalid. */
export function normalizeUsername(raw: string): string | undefined {
  const normalized = raw.toLowerCase();
  return USERNAME_PATTERN.test(normalized) ? normalized : undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Password hashing (scrypt, CG-GOV §1.2)
 * -----------------------------------------------------------------------------------------------*/

/** Hashes a password with a fresh cryptographically secure salt — `scrypt$N$r$p$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.SALT_LENGTH);
  const hash = await scrypt(password, salt, SCRYPT.KEY_LENGTH, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${String(SCRYPT.N)}$${String(SCRYPT.r)}$${String(SCRYPT.p)}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Constant-time verification against a stored `scrypt$…` encoding. A malformed stored
 * value simply fails (never throws, never logs) — verification is fall-closed.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number.parseInt(parts[1] ?? '', 10);
  const r = Number.parseInt(parts[2] ?? '', 10);
  const p = Number.parseInt(parts[3] ?? '', 10);
  const salt = Buffer.from(parts[4] ?? '', 'hex');
  const expected = Buffer.from(parts[5] ?? '', 'hex');
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scrypt(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Session tokens (CG-GOV §1.3) — opaque 256-bit; only SHA-256(token) is persisted
 * -----------------------------------------------------------------------------------------------*/

/** Generates a fresh opaque 256-bit session token (hex). */
export function newSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/** The persistence form of a token: its SHA-256 hex digest. */
export function tokenHashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Login `Set-Cookie` value — HttpOnly, SameSite=Strict, Path=/ (CG-GOV §1.3). */
export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${String(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** Logout `Set-Cookie` value — clears the cookie with the identical attributes. */
export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** Extracts the session token from a `cookie` header, if present. */
export function sessionTokenFromCookieHeader(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}

/* ------------------------------------------------------------------------------------------------
 * The service (login / resolve / logout / password change)
 * -----------------------------------------------------------------------------------------------*/

/** The stable public authentication error codes (CG-GOV §1.6/§8 — new codes only). */
export type AuthErrorCode = 'UNAUTHENTICATED' | 'AUTH_INVALID_CREDENTIALS';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: 401;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError'; // stable discriminator for the error mapper (errors.ts)
    this.code = code;
    this.status = 401;
  }
}

/** What the authenticated request context carries (never the password hash). */
export interface AuthenticatedRequest {
  readonly user: Omit<User, 'passwordHash'>;
  readonly session: SessionRecord;
}

export interface GovernanceStores {
  readonly users: UserStore;
  readonly sessions: SessionStore;
}

export interface AuthDependencies extends GovernanceStores {
  /** Injected clock (ISO instant) — session timestamps are deterministic in tests. */
  readonly clock: () => string;
}

/** A verified login result: the client token (returned exactly once, in the cookie). */
export interface LoginResult {
  readonly user: Omit<User, 'passwordHash'>;
  readonly token: string;
  readonly expiresAt: string;
}

// A fixed dummy hash so an unknown username burns the same scrypt verification as a
// wrong password — login timing cannot enumerate users (CG-GOV §1.4).
let dummyHash: string | undefined;

async function burnDummyVerification(password: string): Promise<void> {
  dummyHash ??= await hashPassword('timing-equalizer-dummy-password');
  await verifyPassword(password, dummyHash);
}

/**
 * Login (CG-GOV §1.4): unknown username, wrong password and deactivated user all fail
 * with the identical `AUTH_INVALID_CREDENTIALS` — never distinguishable in body, log
 * or timing. Success creates the server-side session and returns the token exactly
 * once (the caller sets the cookie; the token is never persisted raw).
 */
export async function loginUser(
  deps: AuthDependencies,
  rawUsername: string,
  password: string,
): Promise<LoginResult> {
  const username = normalizeUsername(rawUsername);
  const user = username === undefined ? undefined : await deps.users.findByUsername(username);
  if (user === undefined) {
    await burnDummyVerification(password);
    throw new AuthError(
      'AUTH_INVALID_CREDENTIALS',
      'the username or password is incorrect (no further detail is ever provided)',
    );
  }
  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk || !user.isActive) {
    // deactivated is indistinguishable from a wrong password (§1.4)
    throw new AuthError(
      'AUTH_INVALID_CREDENTIALS',
      'the username or password is incorrect (no further detail is ever provided)',
    );
  }
  const token = newSessionToken();
  const createdAt = deps.clock();
  const expiresAt = new Date(new Date(createdAt).getTime() + SESSION_TTL_MS).toISOString();
  await deps.sessions.save({
    sessionTokenHash: tokenHashOf(token),
    userId: user.userId,
    createdAt,
    expiresAt,
  });
  return { user: stripHash(user), token, expiresAt };
}

/**
 * Resolves an authenticated request (CG-GOV §1.3/§1.6): session row found by token
 * hash, not expired (expired rows are lazily deleted), user still active. Anything
 * else is unauthenticated — callers answer 401 UNAUTHENTICATED.
 */
export async function resolveAuthenticatedRequest(
  deps: AuthDependencies,
  token: string,
): Promise<AuthenticatedRequest | undefined> {
  const hash = tokenHashOf(token);
  const session = await deps.sessions.findByTokenHash(hash);
  if (session === undefined) return undefined;
  const now = deps.clock();
  if (session.expiresAt <= now) {
    await deps.sessions.deleteExpiredBefore(now); // lazy cleanup (§1.3)
    return undefined;
  }
  const user = await deps.users.findById(session.userId);
  if (user === undefined || !user.isActive) return undefined; // §1.6: deactivated ⇒ no session
  return { user: stripHash(user), session };
}

/** Logout (CG-GOV §1.4): deletes the server-side session row. */
export async function logoutUser(deps: AuthDependencies, token: string): Promise<void> {
  await deps.sessions.deleteByTokenHash(tokenHashOf(token));
}

/**
 * Password change (CG-GOV §1.2): verifies the current password (wrong ⇒ the uniform
 * AUTH_INVALID_CREDENTIALS), stores the new scrypt hash, and revokes every OTHER
 * session of the user — the current session stays valid so the user is not logged out
 * mid-change. No credential material is ever returned.
 */
export async function changePassword(
  deps: AuthDependencies,
  auth: AuthenticatedRequest,
  currentPassword: string,
  newPassword: string,
): Promise<Omit<User, 'passwordHash'>> {
  const user = await deps.users.findById(auth.user.userId);
  if (user === undefined || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AuthError(
      'AUTH_INVALID_CREDENTIALS',
      'the username or password is incorrect (no further detail is ever provided)',
    );
  }
  await deps.users.updatePasswordHash(user.userId, await hashPassword(newPassword));
  await deps.sessions.deleteAllByUserExcept(user.userId, auth.session.sessionTokenHash);
  return stripHash(user);
}

function stripHash(user: User): Omit<User, 'passwordHash'> {
  return {
    userId: user.userId,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Bootstrap (CG-GOV §1.5) — exactly one initial org_admin, or fail closed
 * -----------------------------------------------------------------------------------------------*/

export interface BootstrapEnv {
  readonly bootstrapAdminUsername: string | undefined;
  readonly bootstrapAdminPassword: string | undefined;
}

/**
 * The bootstrap rule (CG-GOV §1.5), run at startup after migrations:
 * - users table EMPTY + both valid credentials → create exactly one `org_admin`;
 * - users table EMPTY + anything else → THROW (fail closed; the caller exits non-zero
 *   before listening — like a missing DATABASE_URL);
 * - users table non-empty → the environment variables are ignored entirely.
 *
 * The error message never contains the bootstrap password.
 */
export async function ensureBootstrapAdmin(
  deps: AuthDependencies,
  env: BootstrapEnv,
): Promise<void> {
  const count = await deps.users.count();
  if (count > 0) return;
  const username =
    env.bootstrapAdminUsername === undefined
      ? undefined
      : normalizeUsername(env.bootstrapAdminUsername);
  const password = env.bootstrapAdminPassword;
  if (username === undefined || password === undefined || !isValidPassword(password)) {
    throw new Error(
      'bootstrap required: the users table is empty, so CG_BOOTSTRAP_ADMIN_USERNAME (3–64 chars of a-z 0-9 . _ -) ' +
        'and CG_BOOTSTRAP_ADMIN_PASSWORD (8–128 chars) must be set to create the initial org_admin; ' +
        'startup fails closed otherwise (no default account is ever created)',
    );
  }
  await deps.users.save({
    userId: randomUUID(),
    username,
    passwordHash: await hashPassword(password),
    role: 'org_admin',
    isActive: true,
    createdAt: deps.clock(),
  });
}
