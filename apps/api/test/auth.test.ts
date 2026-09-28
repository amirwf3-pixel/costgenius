/**
 * P8-A S1 — the authentication & session core over the REAL stack (CG-GOV-SPEC@0.1.0
 * §1): PGlite + real migrations + the real Drizzle stores, real bootstrap, real login,
 * real cookie. Covers the S1 test contract: login success/failure uniformity, session
 * validity/expiry/invalidity, logout invalidation, password change, cookie attributes,
 * raw-token absence, bootstrap (creation / fail-closed / idempotence) and the
 * deactivated-user session rule. RBAC/audit/sign-off are OUT of scope (S2/S3/S4).
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { DrizzleSessionRepository, DrizzleUserRepository, type DbClient } from '@costgenius/db';
import {
  bindRepositories,
  buildAuthenticatedTestServer,
  FIXED_INSTANT,
  TEST_ADMIN,
  transactOver,
  type AuthenticatedTestServer,
} from './helpers.js';
import { createApiServer, ensureBootstrapAdmin } from '../src/index.js';

/** Decodes an error body without leaking `any` (json() is `any` in fastify's types). */
function errorCode(response: { json: () => unknown }): string {
  return (response.json() as { error: { code: string } }).error.code;
}

/** Decodes a login/session body without leaking `any`. */
function sessionBody(response: { json: () => unknown }): LoginResponse {
  return response.json() as LoginResponse;
}
import type { ApiDependencies } from '../src/index.js';
import { loadPublishedDataset } from '../src/dataset.js';

/** The shared raw-request server of the auth suite (NO cookie wrapper). */
async function buildRawServer(): Promise<{
  server: AuthenticatedTestServer;
  userStore: DrizzleUserRepository;
  sessionStore: DrizzleSessionRepository;
  db: DbClient;
  pg: PGlite;
}> {
  const pg = new PGlite();
  const raw = drizzle(pg);
  await migrate(raw, {
    migrationsFolder: new URL('../../../packages/db/migrations', import.meta.url).pathname,
  });
  const db = raw as unknown as DbClient;
  const userStore = new DrizzleUserRepository(db);
  const sessionStore = new DrizzleSessionRepository(db);
  const poolBound = bindRepositories(db);
  const deps: ApiDependencies = {
    repositories: {
      // the auth tests never touch the domain repositories; the real ones are injected
      projects: poolBound.projects,
      estimates: poolBound.estimates,
      finalized: poolBound.finalized,
      takeoffDocuments: poolBound.takeoffDocuments,
      finalizedTakeoffs: poolBound.finalizedTakeoffs,
    },
    governance: { users: userStore, sessions: sessionStore, audit: poolBound.audit },
    dataset: loadPublishedDataset(),
    clock: () => FIXED_INSTANT,
    transact: transactOver(db),
  };
  await ensureBootstrapAdmin(
    { users: userStore, sessions: sessionStore, clock: deps.clock },
    { bootstrapAdminUsername: TEST_ADMIN.username, bootstrapAdminPassword: TEST_ADMIN.password },
  );
  const app = createApiServer(deps);
  return {
    server: { app, cookie: '', rawInject: app.inject.bind(app) },
    userStore,
    sessionStore,
    db,
    pg,
  };
}

let server: AuthenticatedTestServer;
let userStore: DrizzleUserRepository;
let sessionStore: DrizzleSessionRepository;
let db: DbClient;
let pg: PGlite;

beforeAll(async () => {
  const built = await buildRawServer();
  server = built.server;
  userStore = built.userStore;
  sessionStore = built.sessionStore;
  db = built.db;
  pg = built.pg;
});

afterAll(async () => {
  await server.app.close();
  await pg.close();
});

interface LoginResponse {
  readonly userId: string;
  readonly username: string;
  readonly role: string;
  readonly expiresAt: string;
}

async function login(
  username: string,
  password: string,
): Promise<{ status: number; body: unknown; cookie: string | undefined }> {
  const response = await server.rawInject({
    method: 'POST',
    url: '/auth/login',
    payload: { username, password },
  });
  const setCookie = response.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return {
    status: response.statusCode,
    body: response.json(),
    cookie: first === undefined ? undefined : first.split(';')[0],
  };
}

function cookieAttributes(cookieHeader: string | undefined): string[] {
  const setCookie = cookieHeader;
  return setCookie === undefined ? [] : setCookie.split(';').map((part) => part.trim());
}

describe('P8-A S1 authentication & session core', () => {
  it('login succeeds with valid credentials and returns the session projection', async () => {
    const result = await login(TEST_ADMIN.username, TEST_ADMIN.password);
    expect(result.status).toBe(200);
    const body = result.body as LoginResponse;
    expect(body.username).toBe('admin');
    expect(body.role).toBe('org_admin');
    expect(typeof body.userId).toBe('string');
    // absolute 12h expiration from the fixed clock (CG-GOV §1.3)
    expect(body.expiresAt).toBe('2026-01-01T12:00:00.000Z');
    // the password / hash / token NEVER appear anywhere in the body
    expect(JSON.stringify(result.body)).not.toContain('password');
    expect(JSON.stringify(result.body)).not.toContain('scrypt');
  });

  it('wrong password and unknown username answer the IDENTICAL 401 (no enumeration)', async () => {
    const wrongPassword = await login(TEST_ADMIN.username, 'definitely-wrong');
    const unknownUser = await login('no-such-user', 'definitely-wrong');
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    const wp = wrongPassword.body as { error: { code: string; message: string } };
    const uu = unknownUser.body as { error: { code: string; message: string } };
    expect(wp.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(uu.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    // byte-identical bodies — no distinction in any field
    expect(JSON.stringify(wrongPassword.body)).toBe(JSON.stringify(unknownUser.body));
  });

  it('an inactive user cannot log in and gets the same uniform 401', async () => {
    // deactivate the admin directly at the store (user management is S2 — no route yet)
    const user = await userStore.findByUsername(TEST_ADMIN.username);
    expect(user).toBeDefined();
    // the S1 contract: isActive=false blocks login; flip it back afterwards
    const sessionBefore = await login(TEST_ADMIN.username, TEST_ADMIN.password);
    expect(sessionBefore.status).toBe(200);
    // direct store-level deactivation (the only S1 mechanism; re-activated below)
    await db.execute(
      sql`UPDATE users SET is_active = false WHERE username = ${TEST_ADMIN.username}`,
    );
    try {
      const result = await login(TEST_ADMIN.username, TEST_ADMIN.password);
      expect(result.status).toBe(401);
      expect((result.body as { error: { code: string } }).error.code).toBe(
        'AUTH_INVALID_CREDENTIALS',
      );
      // §1.6: the PRE-EXISTING session of the deactivated user is dead too
      const authed = await server.rawInject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: sessionBefore.cookie ?? '' },
      });
      expect(authed.statusCode).toBe(401);
      expect(errorCode(authed)).toBe('UNAUTHENTICATED');
    } finally {
      await db.execute(
        sql`UPDATE users SET is_active = true WHERE username = ${TEST_ADMIN.username}`,
      );
    }
  });

  it('the login cookie carries exactly the contract attributes (http)', async () => {
    const response = await server.rawInject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: TEST_ADMIN.username, password: TEST_ADMIN.password },
    });
    const setCookie = response.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const attrs = cookieAttributes(first);
    expect(first?.startsWith('cg_session=')).toBe(true);
    expect(attrs).toContain('HttpOnly');
    expect(attrs).toContain('SameSite=Strict');
    expect(attrs.some((a) => a.startsWith('Path=/'))).toBe(true);
    expect(attrs.some((a) => a.startsWith('Max-Age=43200'))).toBe(true); // 12h
    // Secure is set only when the deployment serves HTTPS (this request is http)
    expect(attrs.some((a) => a === 'Secure')).toBe(false);
    // SameSite=Strict + same-origin deployment ⇒ no CSRF token in V1.1 (CG-GOV §1.7)
  });

  it('the raw session token is never persisted — only its SHA-256 digest', async () => {
    const result = await login(TEST_ADMIN.username, TEST_ADMIN.password);
    expect(result.cookie).toBeDefined();
    const token = result.cookie?.split('=')[1] ?? '';
    expect(token).toHaveLength(64); // 256-bit hex
    // the DB row keyed by sha256(token), and the token itself appears in NO session row
    const rows = (await db.execute(sql`SELECT session_token_hash FROM sessions`)) as unknown as {
      rows: Array<{ session_token_hash: string }>;
    };
    const hashes = rows.rows.map((r) => r.session_token_hash);
    const expected = createHash('sha256').update(token).digest('hex');
    expect(hashes).toContain(expected);
    expect(JSON.stringify(rows.rows)).not.toContain(token);
    expect(hashes.every((h) => h !== token)).toBe(true);
  });

  it('GET /auth/session returns the current session; no/invalid cookie → 401 UNAUTHENTICATED', async () => {
    const result = await login(TEST_ADMIN.username, TEST_ADMIN.password);
    const ok = await server.rawInject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: result.cookie ?? '' },
    });
    expect(ok.statusCode).toBe(200);
    expect(sessionBody(ok).username).toBe('admin');

    const missing = await server.rawInject({ method: 'GET', url: '/auth/session' });
    expect(missing.statusCode).toBe(401);
    expect(errorCode(missing)).toBe('UNAUTHENTICATED');

    const invalid = await server.rawInject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `cg_session=${randomBytes(32).toString('hex')}` },
    });
    expect(invalid.statusCode).toBe(401);
    expect(errorCode(invalid)).toBe('UNAUTHENTICATED');
  });

  it('an EXPIRED session is rejected (and lazily cleaned up)', async () => {
    const token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    const user = await userStore.findByUsername(TEST_ADMIN.username);
    // a session that expired before the fixed clock
    await sessionStore.save({
      sessionTokenHash: hash,
      userId: user?.userId ?? '',
      createdAt: '2025-12-31T00:00:00.000Z',
      expiresAt: '2025-12-31T12:00:00.000Z',
    });
    const response = await server.rawInject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `cg_session=${token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe('UNAUTHENTICATED');
    // lazy cleanup deleted the expired row
    expect(await sessionStore.findByTokenHash(hash)).toBeUndefined();
  });

  it('every protected route answers 401 without a session; /health stays public', async () => {
    const health = await server.rawInject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const projects = await server.rawInject({ method: 'GET', url: '/projects' });
    expect(projects.statusCode).toBe(401);
    expect(errorCode(projects)).toBe('UNAUTHENTICATED');

    const createProject = await server.rawInject({
      method: 'POST',
      url: '/projects',
      payload: { title: 'x' },
    });
    expect(createProject.statusCode).toBe(401);

    // unknown routes keep the stable 404 contract (the auth gate never shadows it)
    const unknown = await server.rawInject({ method: 'GET', url: '/no-such-route' });
    expect(unknown.statusCode).toBe(404);
    expect(errorCode(unknown)).toBe('NOT_FOUND');
  });

  it('logout deletes the server-side session; afterwards the cookie is dead', async () => {
    const result = await login(TEST_ADMIN.username, TEST_ADMIN.password);
    const logout = await server.rawInject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: result.cookie ?? '' },
    });
    expect(logout.statusCode).toBe(204);
    // the cookie is cleared with the identical attributes
    const setCookie = logout.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(first?.startsWith('cg_session=;')).toBe(true);
    expect(cookieAttributes(first)).toContain('HttpOnly');

    const after = await server.rawInject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: result.cookie ?? '' },
    });
    expect(after.statusCode).toBe(401);

    // logout without a session → uniform 401 (CG-GOV §1.4)
    const bare = await server.rawInject({ method: 'POST', url: '/auth/logout' });
    expect(bare.statusCode).toBe(401);
  });

  it('password change: current verified, new accepted, other sessions revoked, current kept', async () => {
    const current = await login(TEST_ADMIN.username, TEST_ADMIN.password);
    const other = await login(TEST_ADMIN.username, TEST_ADMIN.password);

    // wrong current password → the uniform 401
    const wrong = await server.rawInject({
      method: 'POST',
      url: '/auth/password',
      headers: { cookie: current.cookie ?? '' },
      payload: { currentPassword: 'not-the-current-one', newPassword: 'brand-new-pass-456' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(errorCode(wrong)).toBe('AUTH_INVALID_CREDENTIALS');

    // a too-short new password → 400 INVALID_REQUEST (schema, before any store touch)
    const tooShort = await server.rawInject({
      method: 'POST',
      url: '/auth/password',
      headers: { cookie: current.cookie ?? '' },
      payload: { currentPassword: TEST_ADMIN.password, newPassword: 'short' },
    });
    expect(tooShort.statusCode).toBe(400);
    expect(errorCode(tooShort)).toBe('INVALID_REQUEST');

    // correct change
    const change = await server.rawInject({
      method: 'POST',
      url: '/auth/password',
      headers: { cookie: current.cookie ?? '' },
      payload: { currentPassword: TEST_ADMIN.password, newPassword: 'brand-new-pass-456' },
    });
    expect(change.statusCode).toBe(200);
    expect(sessionBody(change).username).toBe('admin');
    expect(JSON.stringify(sessionBody(change))).not.toContain('password');

    // the OTHER session was revoked…
    const otherAfter = await server.rawInject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: other.cookie ?? '' },
    });
    expect(otherAfter.statusCode).toBe(401);
    // …the CURRENT session stays valid…
    const currentAfter = await server.rawInject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: current.cookie ?? '' },
    });
    expect(currentAfter.statusCode).toBe(200);
    // …the old password no longer logs in, the new one does
    expect((await login(TEST_ADMIN.username, TEST_ADMIN.password)).status).toBe(401);
    const relogin = await login(TEST_ADMIN.username, 'brand-new-pass-456');
    expect(relogin.status).toBe(200);

    // restore the fixture password for the remaining tests
    const restore = await server.rawInject({
      method: 'POST',
      url: '/auth/password',
      headers: { cookie: relogin.cookie ?? '' },
      payload: { currentPassword: 'brand-new-pass-456', newPassword: TEST_ADMIN.password },
    });
    expect(restore.statusCode).toBe(200);
  });

  it('the fixture login of buildTestServer still works (the wrapped inject keeps real auth)', async () => {
    const fixture = await buildAuthenticatedTestServer();
    try {
      const projects = await fixture.app.inject({ method: 'GET', url: '/projects' });
      expect(projects.statusCode).toBe(200); // cookie attached by the real login
      const raw = await fixture.rawInject({ method: 'GET', url: '/projects' });
      expect(raw.statusCode).toBe(401); // raw = no cookie
    } finally {
      await fixture.app.close();
    }
  });
});

describe('P8-A S1 bootstrap (CG-GOV §1.5)', () => {
  async function freshDeps(): Promise<{
    deps: ApiDependencies;
    users: DrizzleUserRepository;
    sessions: DrizzleSessionRepository;
    pg: PGlite;
  }> {
    const pg = new PGlite();
    const raw = drizzle(pg);
    await migrate(raw, {
      migrationsFolder: new URL('../../../packages/db/migrations', import.meta.url).pathname,
    });
    const db = raw as unknown as DbClient;
    const users = new DrizzleUserRepository(db);
    const sessions = new DrizzleSessionRepository(db);
    const poolBound = bindRepositories(db);
    const deps: ApiDependencies = {
      repositories: {
        projects: poolBound.projects,
        estimates: poolBound.estimates,
        finalized: poolBound.finalized,
        takeoffDocuments: poolBound.takeoffDocuments,
        finalizedTakeoffs: poolBound.finalizedTakeoffs,
      },
      governance: { users, sessions, audit: poolBound.audit },
      dataset: loadPublishedDataset(),
      clock: () => FIXED_INSTANT,
      transact: transactOver(db),
    };
    return { deps, users, sessions, pg };
  }

  it('empty users + no bootstrap credentials → fail closed (throws, creates nothing)', async () => {
    const { users, sessions, pg } = await freshDeps();
    try {
      await expect(
        ensureBootstrapAdmin(
          { users, sessions, clock: () => FIXED_INSTANT },
          { bootstrapAdminUsername: undefined, bootstrapAdminPassword: undefined },
        ),
      ).rejects.toThrow(/bootstrap required/i);
      expect(await users.count()).toBe(0);
    } finally {
      await pg.close();
    }
  });

  it('empty users + invalid bootstrap credentials → fail closed (no default account)', async () => {
    const { users, sessions, pg } = await freshDeps();
    try {
      await expect(
        ensureBootstrapAdmin(
          { users, sessions, clock: () => FIXED_INSTANT },
          { bootstrapAdminUsername: 'A', bootstrapAdminPassword: 'valid-password-123' }, // invalid username shape
        ),
      ).rejects.toThrow(/bootstrap required/i);
      await expect(
        ensureBootstrapAdmin(
          { users, sessions, clock: () => FIXED_INSTANT },
          { bootstrapAdminUsername: 'admin', bootstrapAdminPassword: 'short' }, // invalid password shape
        ),
      ).rejects.toThrow(/bootstrap required/i);
      expect(await users.count()).toBe(0); // never a silently created default account
    } finally {
      await pg.close();
    }
  });

  it('empty users + valid credentials → exactly one org_admin; re-run is a no-op (env ignored)', async () => {
    const { deps, users, sessions, pg } = await freshDeps();
    try {
      await ensureBootstrapAdmin(
        { users, sessions, clock: () => FIXED_INSTANT },
        { bootstrapAdminUsername: 'bootstrap-admin', bootstrapAdminPassword: 'bootstrap-pass-1' },
      );
      expect(await users.count()).toBe(1);
      const admin = await users.findByUsername('bootstrap-admin');
      expect(admin?.role).toBe('org_admin');
      expect(admin?.isActive).toBe(true);
      expect(admin?.passwordHash.startsWith('scrypt$16384$8$1$')).toBe(true);

      // duplicate bootstrap behavior: with users present the env is IGNORED entirely —
      // a second, different credential set creates nothing
      await ensureBootstrapAdmin(
        { users, sessions, clock: () => FIXED_INSTANT },
        { bootstrapAdminUsername: 'another-admin', bootstrapAdminPassword: 'another-pass-123' },
      );
      expect(await users.count()).toBe(1);
      expect(await users.findByUsername('another-admin')).toBeUndefined();

      // the bootstrap password logs in (and the login never returns hash material)
      const app = createApiServer(deps);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { username: 'bootstrap-admin', password: 'bootstrap-pass-1' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain('scrypt');
        expect(response.body).not.toContain('bootstrap-pass-1');
      } finally {
        await app.close();
      }
    } finally {
      await pg.close();
    }
  });
});
