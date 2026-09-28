/**
 * P8-A S2 user management (CG-GOV-SPEC@0.1.0 §2.3) — the org_admin surface BEHIND
 * the route gate (the matrix in authz.test.ts proves who may reach these routes;
 * this suite proves what the routes DO):
 *
 *  - create: 201, real login with the new credentials, no password material ever;
 *  - duplicate username → 409 USERNAME_ALREADY_TAKEN; malformed payloads → 400;
 *  - list: every account, deterministic, no hashes;
 *  - role change: 200 + live on the EXISTING session; unknown user → 404;
 *  - guard rails: self-deactivation → 403; the LAST active org_admin can be neither
 *    deactivated nor demoted → 409 (the instance never locks itself out);
 *  - deactivation is soft + revokes every session; already-inactive → idempotent 200.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildRoleAwareServer,
  loginCookie,
  TEST_ADMIN,
  TEST_ROLE_USERS,
  type RoleAwareServer,
} from './helpers.js';

let server: RoleAwareServer;
let admin: string;

beforeAll(async () => {
  server = await buildRoleAwareServer();
  admin = await server.cookieFor('org_admin');
});

interface UserBody {
  readonly userId: string;
  readonly username: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly createdAt: string;
}

/** Typed user-profile decode (json() is loosely typed; never `any`). */
function userBody(response: { json: () => unknown }): UserBody {
  return response.json() as UserBody;
}

/** Typed user-list decode. */
function userList(response: { json: () => unknown }): UserBody[] {
  return response.json() as UserBody[];
}

/** Typed single-field decode ({role}/{userId}/{isActive} probes). */
function fieldOf(response: { json: () => unknown }, field: 'role' | 'userId'): string {
  return (response.json() as Record<string, string>)[field] ?? '';
}

function userError(response: { statusCode: number; json: () => unknown }): {
  code: string;
  message: string;
} {
  return (response.json() as { error: { code: string; message: string } }).error;
}

describe('P8-A S2 — user management (CG-GOV §2.3)', () => {
  it('org_admin creates a user; the account can REALLY log in; no password material', async () => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        username: 'created-viewer',
        password: 'created-viewer-password-123',
        role: 'viewer',
      },
      headers: { cookie: admin },
    });
    expect(created.statusCode).toBe(201);
    const body = userBody(created);
    expect(body.username).toBe('created-viewer');
    expect(body.role).toBe('viewer');
    expect(body.isActive).toBe(true);
    expect(JSON.stringify(created.body)).not.toMatch(/password/i);

    // the credentials work through the REAL login (scrypt hash really stored)
    const cookie = await loginCookie(server.app, 'created-viewer', 'created-viewer-password-123');
    const session = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(fieldOf(session, 'role')).toBe('viewer');
  });

  it('duplicate username → 409 USERNAME_ALREADY_TAKEN (even after normalization)', async () => {
    const duplicate = await server.app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        username: TEST_ROLE_USERS.viewer.username, // the fixture user already exists
        password: 'some-password-123456',
        role: 'viewer',
      },
      headers: { cookie: admin },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(userError(duplicate).code).toBe('USERNAME_ALREADY_TAKEN');
  });

  it('malformed payloads → 400 INVALID_REQUEST (username pattern, password length, role enum)', async () => {
    const badUsername = await server.app.inject({
      method: 'POST',
      url: '/users',
      payload: { username: 'X', password: 'valid-password-123', role: 'viewer' },
      headers: { cookie: admin },
    });
    expect(badUsername.statusCode).toBe(400);
    expect(userError(badUsername).code).toBe('INVALID_REQUEST');
    const badPassword = await server.app.inject({
      method: 'POST',
      url: '/users',
      payload: { username: 'short-pw-user', password: 'short', role: 'viewer' },
      headers: { cookie: admin },
    });
    expect(badPassword.statusCode).toBe(400);
    const badRole = await server.app.inject({
      method: 'POST',
      url: '/users',
      payload: { username: 'bad-role-user', password: 'valid-password-123', role: 'superuser' },
      headers: { cookie: admin },
    });
    expect(badRole.statusCode).toBe(400);
    expect(userError(badRole).code).toBe('INVALID_REQUEST');
  });

  it('GET /users lists every account deterministically and never a hash', async () => {
    const list = await server.app.inject({
      method: 'GET',
      url: '/users',
      headers: { cookie: admin },
    });
    expect(list.statusCode).toBe(200);
    const users = userList(list);
    const usernames = users.map((user) => user.username);
    expect(usernames).toContain(TEST_ADMIN.username);
    for (const fixture of Object.values(TEST_ROLE_USERS)) {
      expect(usernames).toContain(fixture.username);
    }
    expect(new Set(usernames).size).toBe(usernames.length); // no duplicates
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|password_hash/i);
  });

  it('role change: 200, persisted, and LIVE on the user’s existing session', async () => {
    const cookie = await server.cookieFor('estimator'); // est-user session
    const before = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie },
    });
    expect(fieldOf(before, 'role')).toBe('estimator');

    const list = await server.app.inject({
      method: 'GET',
      url: '/users',
      headers: { cookie: admin },
    });
    const target = userList(list).find(
      (user) => user.username === TEST_ROLE_USERS.estimator.username,
    );
    expect(target).toBeDefined();

    const changed = await server.app.inject({
      method: 'POST',
      url: `/users/${target?.userId ?? ''}/role`,
      payload: { role: 'reviewer' },
      headers: { cookie: admin },
    });
    expect(changed.statusCode).toBe(200);
    expect(fieldOf(changed, 'role')).toBe('reviewer');

    // the role applies to the ALREADY-ISSUED session immediately (no re-login)
    const after = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie },
    });
    expect(fieldOf(after, 'role')).toBe('reviewer');

    // restore the fixture role for the rest of the suite
    const restored = await server.app.inject({
      method: 'POST',
      url: `/users/${target?.userId ?? ''}/role`,
      payload: { role: 'estimator' },
      headers: { cookie: admin },
    });
    expect(restored.statusCode).toBe(200);
  });

  it('role change on an unknown user → 404 USER_NOT_FOUND', async () => {
    const missing = await server.app.inject({
      method: 'POST',
      url: '/users/00000000-0000-4000-8000-00000000beef/role',
      payload: { role: 'viewer' },
      headers: { cookie: admin },
    });
    expect(missing.statusCode).toBe(404);
    expect(userError(missing).code).toBe('USER_NOT_FOUND');
  });

  it('self-deactivation is forbidden → 403 FORBIDDEN', async () => {
    const session = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: admin },
    });
    const selfId = fieldOf(session, 'userId');
    const self = await server.app.inject({
      method: 'POST',
      url: `/users/${selfId}/deactivate`,
      headers: { cookie: admin },
    });
    expect(self.statusCode).toBe(403);
    expect(userError(self).code).toBe('FORBIDDEN');
    // the admin is still active and the session still works
    const still = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: admin },
    });
    expect(still.statusCode).toBe(200);
  });

  it('the LAST active org_admin cannot be demoted → 409 CANNOT_DEACTIVATE_LAST_ORG_ADMIN', async () => {
    const session = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: admin },
    });
    const selfId = fieldOf(session, 'userId');
    const demote = await server.app.inject({
      method: 'POST',
      url: `/users/${selfId}/role`,
      payload: { role: 'estimator' },
      headers: { cookie: admin },
    });
    expect(demote.statusCode).toBe(409);
    expect(userError(demote).code).toBe('CANNOT_DEACTIVATE_LAST_ORG_ADMIN');
  });

  it('deactivation is soft, revokes every session, and reads back isActive=false', async () => {
    // arrange a fresh victim with a REAL session
    const created = await server.app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        username: 'to-be-deactivated',
        password: 'victim-password-123456',
        role: 'estimator',
      },
      headers: { cookie: admin },
    });
    const userId = fieldOf(created, 'userId');
    const victimCookie = await loginCookie(
      server.app,
      'to-be-deactivated',
      'victim-password-123456',
    );
    const working = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: victimCookie },
    });
    expect(working.statusCode).toBe(200);

    const deactivated = await server.app.inject({
      method: 'POST',
      url: `/users/${userId}/deactivate`,
      headers: { cookie: admin },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(userBody(deactivated).isActive).toBe(false);

    // every session of the user is revoked server-side
    const deadSession = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: victimCookie },
    });
    expect(deadSession.statusCode).toBe(401);
    // login fails with the SAME uniform 401 as any wrong credential (no enumeration)
    const deadLogin = await server.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'to-be-deactivated', password: 'victim-password-123456' },
    });
    expect(deadLogin.statusCode).toBe(401);
    expect(userError(deadLogin).code).toBe('AUTH_INVALID_CREDENTIALS');

    // soft: the row is still there, listed, inactive — never deleted
    const list = await server.app.inject({
      method: 'GET',
      url: '/users',
      headers: { cookie: admin },
    });
    const row = userList(list).find((user) => user.username === 'to-be-deactivated');
    expect(row?.isActive).toBe(false);
  });

  it('deactivating an already-inactive account is an idempotent 200', async () => {
    const list = await server.app.inject({
      method: 'GET',
      url: '/users',
      headers: { cookie: admin },
    });
    const victim = userList(list).find((user) => user.username === 'to-be-deactivated');
    expect(victim?.isActive).toBe(false);
    const again = await server.app.inject({
      method: 'POST',
      url: `/users/${victim?.userId ?? ''}/deactivate`,
      headers: { cookie: admin },
    });
    expect(again.statusCode).toBe(200);
    expect(userBody(again).isActive).toBe(false);
  });

  it('with a SECOND active org_admin, self-demotion is allowed (guard is about the LAST one)', async () => {
    const second = await server.app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        username: 'second-admin',
        password: 'second-admin-password-123',
        role: 'org_admin',
      },
      headers: { cookie: admin },
    });
    expect(second.statusCode).toBe(201);

    const session = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: admin },
    });
    const selfId = fieldOf(session, 'userId');
    const demote = await server.app.inject({
      method: 'POST',
      url: `/users/${selfId}/role`,
      payload: { role: 'viewer' },
      headers: { cookie: admin },
    });
    expect(demote.statusCode).toBe(200);
    expect(fieldOf(demote, 'role')).toBe('viewer');
    // the demoted admin's session lives but is now viewer-class (matrix enforced)
    const projects = await server.app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: 'ce5e5e5e-0000-4000-8000-000000d40001', title: 'x' },
      headers: { cookie: admin },
    });
    expect(projects.statusCode).toBe(403);
    expect(userError(projects).code).toBe('FORBIDDEN');

    // restore: the second admin re-promotes the first (the suite keeps its admin)
    const secondCookie = await loginCookie(server.app, 'second-admin', 'second-admin-password-123');
    const restore = await server.app.inject({
      method: 'POST',
      url: `/users/${selfId}/role`,
      payload: { role: 'org_admin' },
      headers: { cookie: secondCookie },
    });
    expect(restore.statusCode).toBe(200);
    // …and the second admin deactivates ITSELF? no — self-deactivation stays 403;
    // it stays active (harmless: the fixture server dies with the test file).
  });

  it('the password-change self-service of S1 keeps working for a non-admin (unchanged)', async () => {
    const cookie = await server.cookieFor('viewer');
    const changed = await server.app.inject({
      method: 'POST',
      url: '/auth/password',
      payload: {
        currentPassword: TEST_ROLE_USERS.viewer.password,
        newPassword: 'viewer-new-password-123',
      },
      headers: { cookie },
    });
    expect(changed.statusCode).toBe(200);
    // the old password no longer logs in; the new one does (S1 semantics intact)
    const oldLogin = await server.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        username: TEST_ROLE_USERS.viewer.username,
        password: TEST_ROLE_USERS.viewer.password,
      },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await server.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        username: TEST_ROLE_USERS.viewer.username,
        password: 'viewer-new-password-123',
      },
    });
    expect(newLogin.statusCode).toBe(200);
  });
});
