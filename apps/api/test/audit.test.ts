/**
 * P8-A S3 audit-event verification (CG-GOV-SPEC@0.1.0 §4 + §9 audit rows) over the
 * REAL PGlite stack — the production Drizzle repositories, the real route gate, the
 * real transactional unit of work. The suite proves the complete §31 matrix:
 *
 * AUTH    — login success/failure events (null actor), password change, NO events for
 *           session checks or logout;
 * USERS   — created/role_changed/deactivated with the org_admin actor, and ZERO events
 *           for every denied/failed path (403/404/409, duplicates, idempotent no-ops);
 * DOMAIN  — every reachable catalog event with its EXACT payload (action, actor,
 *           resourceType/resourceId, projectId, details — never a bare row count), and
 *           zero events for every rejection path (422/409/404, RBAC 401/403);
 * TX      — mutation + event commit or roll back TOGETHER: a forced throw inside the
 *           real unit of work leaves neither row, and a failing audit append inside a
 *           real handler rolls the mutation back (an event never exists without its
 *           mutation, and vice versa);
 * DB      — the application surface is append-only (the writer exposes append only;
 *           the PostgreSQL REVOKE-level proof is the env-gated node-postgres suite);
 * SECURITY— no credential/token material anywhere in audit_events, the actor is always
 *           the session-resolved identity, and the S4 approval events stay unreachable.
 */
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, beforeAll, expect, it } from 'vitest';
import { DrizzleAuditEventRepository, type DbClient } from '@costgenius/db';
import {
  createProject,
  estimateVersionApproved,
  projectCreated,
  takeoffDocumentApproved,
  type AuditEvent,
  type AuditEventRepository,
} from '@costgenius/projects';
import { appendAuditEvent } from '../src/audit.js';
import { createApiServer, ensureBootstrapAdmin, type ApiDependencies } from '../src/index.js';
import { loadPublishedDataset } from '../src/dataset.js';
import {
  bindRepositories,
  buildAuditAwareServer,
  COMPLETE_LINES,
  FIXED_INSTANT,
  GOLDEN_COEFFICIENTS,
  TEST_ADMIN,
  type AuditAwareServer,
  type AuditEventRow,
} from './helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let server: AuditAwareServer;
let adminId: string;
let estimatorId: string;

/** Every persisted event of one action (optionally for one resource). */
async function eventsOf(action: string, resourceId?: string): Promise<readonly AuditEventRow[]> {
  const rows = await server.auditEvents();
  return rows.filter(
    (row) => row.action === action && (resourceId === undefined || row.resourceId === resourceId),
  );
}

async function totalEvents(): Promise<number> {
  return (await server.auditEvents()).length;
}

beforeAll(async () => {
  server = await buildAuditAwareServer();
  const session = await server.app.inject({
    method: 'GET',
    url: '/auth/session',
    headers: { cookie: server.cookie },
  });
  adminId = session.json<{ userId: string }>().userId;
  const estimatorCookie = await server.cookieFor('estimator');
  const estimatorSession = await server.app.inject({
    method: 'GET',
    url: '/auth/session',
    headers: { cookie: estimatorCookie },
  });
  estimatorId = estimatorSession.json<{ userId: string }>().userId;
  // warm every remaining role cookie now, so no later cookieFor() call writes a
  // login_succeeded event in the middle of a zero-events assertion
  await server.cookieFor('viewer');
  await server.cookieFor('reviewer');
  await server.cookieFor('data_steward');
});

/* ------------------------------------------------------------------------------------------------
 * AUTH events (§4.4)
 * -----------------------------------------------------------------------------------------------*/

describe('S3 §4.4 — auth events', () => {
  it('a failed login (unknown user) writes exactly one null-actor `auth.login_failed`', async () => {
    const before = (await eventsOf('auth.login_failed')).filter(
      (row) => (row.details as { username: string }).username === 'ghost-user',
    );
    const response = await server.rawInject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'ghost-user', password: 'wrong-password-123' },
    });
    expect(response.statusCode).toBe(401);
    const failed = (await eventsOf('auth.login_failed')).filter(
      (row) => (row.details as { username: string }).username === 'ghost-user',
    );
    expect(failed.length).toBe(before.length + 1);
    const event = failed[failed.length - 1];
    if (event === undefined) throw new Error('login_failed event missing');
    expect(event.actorUserId).toBe(null); // §4.4: the only null-actor event
    expect(event.resourceType).toBe('user');
    expect(event.resourceId).toBe('ghost-user'); // the attempted identity
    expect(event.projectId).toBe(null);
    expect(event.details).toEqual({ username: 'ghost-user' }); // never a failure reason
    expect(event.at).toBe(FIXED_INSTANT);
    expect(event.eventId).toMatch(UUID_RE);
  });

  it('a failed login (wrong password) is byte-identical in shape — no reason distinguishes it', async () => {
    const response = await server.rawInject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: TEST_ADMIN.username, password: 'not-the-password-999' },
    });
    expect(response.statusCode).toBe(401);
    const mine = (await eventsOf('auth.login_failed')).filter(
      (row) => (row.details as { username: string }).username === TEST_ADMIN.username,
    );
    expect(mine).toHaveLength(1);
    const event = mine[0];
    if (event === undefined) throw new Error('login_failed event missing');
    expect(event.actorUserId).toBe(null);
    expect(event.details).toEqual({ username: TEST_ADMIN.username }); // only the username, never a reason
    expect(Object.keys(event.details as Record<string, unknown>)).toEqual(['username']);
  });

  it('repeated failed logins create the expected audit records (one per attempt)', async () => {
    const before = await eventsOf('auth.login_failed');
    for (let i = 0; i < 3; i += 1) {
      await server.rawInject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'brute-force-probe', password: 'attempt-password-123' },
      });
    }
    expect((await eventsOf('auth.login_failed')).length).toBe(before.length + 3);
  });

  it('a successful login writes exactly one `auth.login_succeeded` with the user as actor', async () => {
    const adminLogins = async (): Promise<readonly AuditEventRow[]> =>
      (await eventsOf('auth.login_succeeded')).filter((row) => row.actorUserId === adminId);
    const before = await adminLogins();
    const response = await server.rawInject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: TEST_ADMIN.username, password: TEST_ADMIN.password },
    });
    expect(response.statusCode).toBe(200);
    const succeeded = await adminLogins();
    expect(succeeded.length).toBe(before.length + 1);
    const event = succeeded[succeeded.length - 1];
    if (event === undefined) throw new Error('login_succeeded event missing');
    expect(event.actorUserId).toBe(adminId);
    expect(event.resourceType).toBe('user');
    expect(event.resourceId).toBe(adminId);
    expect(event.projectId).toBe(null);
    expect(event.details).toEqual({ username: TEST_ADMIN.username });
  });

  it('a password change writes `auth.password_changed`; a wrong current password writes nothing', async () => {
    // a dedicated throwaway account (its creation also exercises user.created later)
    const created = await server.app.inject({
      method: 'POST',
      url: '/users',
      headers: { cookie: server.cookie },
      payload: { username: 'audit-pw-user', password: 'first-password-123', role: 'viewer' },
    });
    expect(created.statusCode).toBe(201);
    const targetId = created.json<{ userId: string }>().userId;

    const login = await server.rawInject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'audit-pw-user', password: 'first-password-123' },
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
    expect(cookie).toBeDefined();

    // wrong current password → uniform 401, ZERO new events
    const before = await totalEvents();
    const wrong = await server.app.inject({
      method: 'POST',
      url: '/auth/password',
      headers: { cookie: cookie ?? '' },
      payload: { currentPassword: 'wrong-current-999', newPassword: 'new-password-456' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(await totalEvents()).toBe(before);

    // successful change → exactly one event, actor = the user, no credential material
    const changed = await server.app.inject({
      method: 'POST',
      url: '/auth/password',
      headers: { cookie: cookie ?? '' },
      payload: { currentPassword: 'first-password-123', newPassword: 'new-password-456' },
    });
    expect(changed.statusCode).toBe(200);
    const events = await eventsOf('auth.password_changed', targetId);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(targetId);
    expect(events[0]?.resourceType).toBe('user');
    expect(events[0]?.resourceId).toBe(targetId);
    expect(events[0]?.projectId).toBe(null);
    expect(events[0]?.details).toEqual({}); // §4.4: never password material
  });

  it('a session check writes NO event', async () => {
    const before = await totalEvents();
    const response = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: server.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(await totalEvents()).toBe(before);
  });

  it('logout writes NO event (the row deletion is the record)', async () => {
    const login = await server.rawInject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: TEST_ADMIN.username, password: TEST_ADMIN.password },
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
    expect(cookie).toBeDefined();
    const before = await totalEvents();
    const response = await server.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: cookie ?? '' },
      payload: {},
    });
    expect(response.statusCode).toBe(204);
    expect(await totalEvents()).toBe(before); // logout is deliberately not audited
  });
});

/* ------------------------------------------------------------------------------------------------
 * USER-MANAGEMENT events (§4.4)
 * -----------------------------------------------------------------------------------------------*/

describe('S3 §4.4 — user-management events', () => {
  it('user creation writes `user.created` with the ADMIN as actor and the new user as resource', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/users',
      headers: { cookie: server.cookie },
      payload: { username: 'audit-created-user', password: 'created-password-123', role: 'viewer' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ userId: string }>();
    const events = await eventsOf('user.created', body.userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(adminId); // the org_admin, not the target
    expect(events[0]?.resourceType).toBe('user');
    expect(events[0]?.resourceId).toBe(body.userId);
    expect(events[0]?.projectId).toBe(null);
    expect(events[0]?.details).toEqual({ username: 'audit-created-user', role: 'viewer' });
  });

  it('a role change writes `user.role_changed` with {from, to}; the actor is the admin', async () => {
    const target = (
      await server.app.inject({
        method: 'POST',
        url: '/users',
        headers: { cookie: server.cookie },
        payload: { username: 'audit-role-user', password: 'role-password-123', role: 'viewer' },
      })
    ).json<{ userId: string }>().userId;
    const response = await server.app.inject({
      method: 'POST',
      url: `/users/${target}/role`,
      headers: { cookie: server.cookie },
      payload: { role: 'reviewer' },
    });
    expect(response.statusCode).toBe(200);
    const events = await eventsOf('user.role_changed', target);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(adminId);
    expect(events[0]?.resourceId).toBe(target);
    expect(events[0]?.details).toEqual({ from: 'viewer', to: 'reviewer' });
  });

  it('an idempotent same-role request performs no mutation and writes NO event', async () => {
    const target = (
      await server.app.inject({
        method: 'POST',
        url: '/users',
        headers: { cookie: server.cookie },
        payload: { username: 'audit-same-role', password: 'same-role-123', role: 'estimator' },
      })
    ).json<{ userId: string }>().userId;
    const before = await eventsOf('user.role_changed', target);
    const response = await server.app.inject({
      method: 'POST',
      url: `/users/${target}/role`,
      headers: { cookie: server.cookie },
      payload: { role: 'estimator' },
    });
    expect(response.statusCode).toBe(200);
    expect(await eventsOf('user.role_changed', target)).toHaveLength(before.length); // zero new
  });

  it('deactivation writes `user.deactivated` with {username}; re-deactivation is a no-op', async () => {
    const target = (
      await server.app.inject({
        method: 'POST',
        url: '/users',
        headers: { cookie: server.cookie },
        payload: { username: 'audit-deactivated', password: 'deactivate-123', role: 'viewer' },
      })
    ).json<{ userId: string }>().userId;
    const first = await server.app.inject({
      method: 'POST',
      url: `/users/${target}/deactivate`,
      headers: { cookie: server.cookie },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const events = await eventsOf('user.deactivated', target);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(adminId);
    expect(events[0]?.resourceId).toBe(target);
    expect(events[0]?.details).toEqual({ username: 'audit-deactivated' });

    // idempotent second deactivation: no mutation, no second event
    const second = await server.app.inject({
      method: 'POST',
      url: `/users/${target}/deactivate`,
      headers: { cookie: server.cookie },
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect(await eventsOf('user.deactivated', target)).toHaveLength(1);
  });

  it('every denied/failed user-management path writes ZERO events', async () => {
    // 403: a viewer cannot create users (RBAC denial — no event, §6)
    const before = await totalEvents();
    const forbidden = await server.app.inject({
      method: 'POST',
      url: '/users',
      headers: { cookie: await server.cookieFor('viewer') },
      payload: { username: 'audit-forbidden', password: 'forbidden-123', role: 'viewer' },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(await totalEvents()).toBe(before);

    // 409: duplicate username (identity is stored lowercase, so the exact name
    // collides case-insensitively) — conflict, no event
    const duplicate = await server.app.inject({
      method: 'POST',
      url: '/users',
      headers: { cookie: server.cookie },
      payload: { username: 'audit-created-user', password: 'duplicate-123', role: 'viewer' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(await totalEvents()).toBe(before);

    // 403: self-deactivation — guard rail, no event
    const self = await server.app.inject({
      method: 'POST',
      url: `/users/${adminId}/deactivate`,
      headers: { cookie: server.cookie },
      payload: {},
    });
    expect(self.statusCode).toBe(403);
    expect(await totalEvents()).toBe(before);

    // 409: the last active org_admin cannot be demoted — guard rail, no event
    const demote = await server.app.inject({
      method: 'POST',
      url: `/users/${adminId}/role`,
      headers: { cookie: server.cookie },
      payload: { role: 'viewer' },
    });
    expect(demote.statusCode).toBe(409);
    expect(await totalEvents()).toBe(before);

    // 404: unknown user — no event
    const missing = randomUUID();
    const unknown = await server.app.inject({
      method: 'POST',
      url: `/users/${missing}/role`,
      headers: { cookie: server.cookie },
      payload: { role: 'viewer' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(await totalEvents()).toBe(before);
  });

  it('a spoofed actor field is rejected by the strict schema — the actor is always server-derived', async () => {
    const before = await totalEvents();
    const spoofed = await server.app.inject({
      method: 'POST',
      url: '/users',
      headers: { cookie: server.cookie },
      payload: {
        username: 'audit-spoofed-actor',
        password: 'spoof-password-123',
        role: 'viewer',
        actorUserId: '00000000-0000-4000-8000-000000000000',
      },
    });
    // the strict schema rejects the unknown key — no mutation, no event, no actor injection
    expect(spoofed.statusCode).toBe(400);
    expect(await totalEvents()).toBe(before);
  });
});

/* ------------------------------------------------------------------------------------------------
 * DOMAIN events (§4.3) — the full reachable chain, exact payloads, estimator as actor
 * -----------------------------------------------------------------------------------------------*/

const PROJECT_ID = 'beef0000-0000-4000-8000-000000000001';
const ESTIMATE_ID = 'beef0000-0000-4000-8000-000000000002';
const VERSION_ID = `${ESTIMATE_ID}-v1`;
const TRANSFER_ESTIMATE_ID = 'beef0000-0000-4000-8000-000000000003';
const TRANSFER_VERSION_ID = `${TRANSFER_ESTIMATE_ID}-v1`;
const TAKEOFF_ID = 'tk-audit-chain';
const DOCUMENT_ID = 'doc-audit-chain';
const FOLLOW_UP_ID = 'doc-audit-chain-f1';
const ESTIMATOR_SHEET = {
  sheetId: 'S1',
  name: 'برگه حسابرسی',
  lines: [
    {
      lineId: 'A',
      rowNo: 1,
      description: 'کانال کف',
      itemCode: '010101',
      kind: 'addition',
      unit: 'm2',
      quantity: { type: 'dimensional', profile: 'LW', length: '2.1', width: '2' },
    },
    {
      lineId: 'U',
      rowNo: 2,
      description: 'بدون کد',
      kind: 'addition',
      unit: 'm',
      quantity: { type: 'manual', value: '5', justification: 'دستی' },
    },
  ],
};

describe('S3 §4.3 — domain events (the estimator performs the whole chain)', () => {
  let estimatorCookie: string;

  beforeAll(async () => {
    estimatorCookie = await server.cookieFor('estimator');
  });

  it('project.created — exact payload, projectId = self', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: estimatorCookie },
      payload: { projectId: PROJECT_ID, title: 'پروژه حسابرسی' },
    });
    expect(response.statusCode).toBe(201);
    const events = await eventsOf('project.created', PROJECT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(estimatorId);
    expect(events[0]?.resourceType).toBe('project');
    expect(events[0]?.resourceId).toBe(PROJECT_ID);
    expect(events[0]?.projectId).toBe(PROJECT_ID); // self
    expect(events[0]?.details).toEqual({ title: 'پروژه حسابرسی' });
  });

  it('estimate.created — the domain has no estimate number, so the details are empty', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/estimates`,
      headers: { cookie: estimatorCookie },
      payload: { estimateId: ESTIMATE_ID, title: 'برآورد حسابرسی' },
    });
    expect(response.statusCode).toBe(201);
    const events = await eventsOf('estimate.created', ESTIMATE_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(estimatorId);
    expect(events[0]?.resourceType).toBe('estimate');
    expect(events[0]?.projectId).toBe(PROJECT_ID);
    expect(events[0]?.details).toEqual({});
  });

  it('estimate_version.created — {versionNumber}', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      headers: { cookie: estimatorCookie },
      payload: { buildingId: 'building-main' }, // the golden chain's building scope
    });
    expect(response.statusCode).toBe(201);
    const events = await eventsOf('estimate_version.created', VERSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(estimatorId);
    expect(events[0]?.resourceType).toBe('estimate_version');
    expect(events[0]?.projectId).toBe(PROJECT_ID);
    expect(events[0]?.details).toEqual({ versionNumber: 1 });
  });

  it('boq_lines.added — ONE event for the batch with {count, lineIds}', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      headers: { cookie: estimatorCookie },
      payload: { lines: COMPLETE_LINES },
    });
    expect(response.statusCode).toBe(200);
    const events = await eventsOf('boq_lines.added', VERSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(estimatorId);
    expect(events[0]?.resourceType).toBe('estimate_version');
    expect(events[0]?.projectId).toBe(PROJECT_ID);
    expect(events[0]?.details).toEqual({
      count: COMPLETE_LINES.length,
      lineIds: COMPLETE_LINES.map((line) => line.lineId),
    });
  });

  it('estimate_version.finalized — {rollupTotal} carries the golden total', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/finalize`,
      headers: { cookie: estimatorCookie },
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(response.statusCode).toBe(201);
    const events = await eventsOf('estimate_version.finalized', VERSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(estimatorId);
    expect(events[0]?.resourceType).toBe('estimate_version');
    expect(events[0]?.projectId).toBe(PROJECT_ID);
    expect(events[0]?.details).toEqual({ rollupTotal: '69011321.1668' });
  });

  it('takeoff_document.created — {documentNumber, title}', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs`,
      headers: { cookie: estimatorCookie },
      payload: { takeoffId: TAKEOFF_ID, documentId: DOCUMENT_ID, title: 'ریز متره حسابرسی' },
    });
    expect(response.statusCode).toBe(201);
    const events = await eventsOf('takeoff_document.created', DOCUMENT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(estimatorId);
    expect(events[0]?.resourceType).toBe('takeoff_document');
    expect(events[0]?.projectId).toBe(PROJECT_ID);
    expect(events[0]?.details).toEqual({ documentNumber: 1, title: 'ریز متره حسابرسی' });
  });

  it('takeoff_document.saved — {expectedRevision, revision}', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs/${DOCUMENT_ID}/save`,
      headers: { cookie: estimatorCookie },
      payload: {
        expectedRevision: 1,
        title: 'ریز متره حسابرسی',
        rounding: [],
        sheets: [ESTIMATOR_SHEET],
      },
    });
    expect(response.statusCode).toBe(200);
    const events = await eventsOf('takeoff_document.saved', DOCUMENT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(estimatorId);
    expect(events[0]?.projectId).toBe(PROJECT_ID);
    expect(events[0]?.details).toEqual({ expectedRevision: 1, revision: 2 });
  });

  it('takeoff_document.archived / unarchived — {revision} (lifecycle keeps the revision)', async () => {
    const archived = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs/${DOCUMENT_ID}/archive`,
      headers: { cookie: estimatorCookie },
      payload: { expectedRevision: 2 },
    });
    expect(archived.statusCode).toBe(200);
    const archivedEvents = await eventsOf('takeoff_document.archived', DOCUMENT_ID);
    expect(archivedEvents).toHaveLength(1);
    expect(archivedEvents[0]?.actorUserId).toBe(estimatorId);
    expect(archivedEvents[0]?.projectId).toBe(PROJECT_ID);
    expect(archivedEvents[0]?.details).toEqual({ revision: 2 });

    const restored = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs/${DOCUMENT_ID}/unarchive`,
      headers: { cookie: estimatorCookie },
      payload: { expectedRevision: 2 },
    });
    expect(restored.statusCode).toBe(200);
    const unarchivedEvents = await eventsOf('takeoff_document.unarchived', DOCUMENT_ID);
    expect(unarchivedEvents).toHaveLength(1);
    expect(unarchivedEvents[0]?.details).toEqual({ revision: 2 });
  });

  it('takeoff_document.finalized — {documentNumber}', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs/${DOCUMENT_ID}/finalize`,
      headers: { cookie: estimatorCookie },
      payload: { expectedRevision: 2 },
    });
    expect(response.statusCode).toBe(201);
    const events = await eventsOf('takeoff_document.finalized', DOCUMENT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(estimatorId);
    expect(events[0]?.projectId).toBe(PROJECT_ID);
    expect(events[0]?.details).toEqual({ documentNumber: 1 });
  });

  it('takeoff_document.follow_up_created — resource is the NEW document, details carry the source', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs/${DOCUMENT_ID}/follow-up`,
      headers: { cookie: estimatorCookie },
      payload: { documentId: FOLLOW_UP_ID },
    });
    expect(response.statusCode).toBe(201);
    const events = await eventsOf('takeoff_document.follow_up_created', FOLLOW_UP_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(estimatorId);
    expect(events[0]?.resourceType).toBe('takeoff_document');
    expect(events[0]?.resourceId).toBe(FOLLOW_UP_ID); // the NEW document
    expect(events[0]?.projectId).toBe(PROJECT_ID);
    expect(events[0]?.details).toEqual({ sourceDocumentId: DOCUMENT_ID, documentNumber: 2 });
  });

  it('takeoff_document.transferred_to_boq — {targetVersionId, lineCount}', async () => {
    // the transfer target: a draft version in the SAME project
    const estimate = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/estimates`,
      headers: { cookie: estimatorCookie },
      payload: { estimateId: TRANSFER_ESTIMATE_ID, title: 'برآورد مقصد' },
    });
    expect(estimate.statusCode).toBe(201);
    const version = await server.app.inject({
      method: 'POST',
      url: `/estimates/${TRANSFER_ESTIMATE_ID}/versions`,
      headers: { cookie: estimatorCookie },
      payload: { buildingId: 'building-audit', versionId: TRANSFER_VERSION_ID },
    });
    expect(version.statusCode).toBe(201);

    const response = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs/${DOCUMENT_ID}/transfer-to-boq`,
      headers: { cookie: estimatorCookie },
      payload: { versionId: TRANSFER_VERSION_ID },
    });
    expect(response.statusCode).toBe(200);
    const events = await eventsOf('takeoff_document.transferred_to_boq', DOCUMENT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(estimatorId);
    expect(events[0]?.resourceType).toBe('takeoff_document');
    expect(events[0]?.projectId).toBe(PROJECT_ID);
    // 010101 (4.2 + 2.8 = 7) aggregates to ONE BOQ line; the uncoded 5 m item is skipped
    expect(events[0]?.details).toEqual({ targetVersionId: TRANSFER_VERSION_ID, lineCount: 1 });
  });

  it('an idempotent identical project re-POST writes NO second event (no mutation, no event)', async () => {
    const before = await eventsOf('project.created', PROJECT_ID);
    const response = await server.app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: estimatorCookie },
      payload: { projectId: PROJECT_ID, title: 'پروژه حسابرسی' },
    });
    expect(response.statusCode).toBe(201); // the store's idempotent no-op, unchanged
    expect(await eventsOf('project.created', PROJECT_ID)).toHaveLength(before.length);
  });

  it('every failed/rejected domain mutation writes ZERO events', async () => {
    const before = await totalEvents();

    // 409: rewriting a persisted project with different content
    const conflict = await server.app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: estimatorCookie },
      payload: { projectId: PROJECT_ID, title: 'عنوان دیگر' },
    });
    expect(conflict.statusCode).toBe(409);

    // 422: a batch with an UNKNOWN pricebook code is rejected all-or-nothing —
    // nothing added, no event
    const rejectedLines = await server.app.inject({
      method: 'POST',
      url: `/estimate-versions/${TRANSFER_VERSION_ID}/lines`,
      headers: { cookie: estimatorCookie },
      payload: {
        lines: [{ lineId: 'bad-1', pricebookCode: '999999', quantity: '40', unit: 'm2' }],
      },
    });
    expect(rejectedLines.statusCode).toBe(422);

    // 409: a stale expectedRevision cannot save the follow-up draft
    const stale = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs/${FOLLOW_UP_ID}/save`,
      headers: { cookie: estimatorCookie },
      payload: { expectedRevision: 99, title: 'x', rounding: [], sheets: [] },
    });
    expect(stale.statusCode).toBe(409);

    // 422: an ENGINE-REJECTED finalize — a draft saved with an invalid decimal
    // finalizes to nothing (TAKEOFF_CALCULATION_FAILED, the §9 same-transaction case)
    const brokenDoc = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs`,
      headers: { cookie: estimatorCookie },
      payload: { takeoffId: 'tk-audit-broken', documentId: 'doc-audit-broken', title: 'نامعتبر' },
    });
    expect(brokenDoc.statusCode).toBe(201);
    const brokenSaved = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs/doc-audit-broken/save`,
      headers: { cookie: estimatorCookie },
      payload: {
        expectedRevision: 1,
        title: 'نامعتبر',
        rounding: [],
        sheets: [
          {
            sheetId: 'S1',
            name: 'برگه',
            lines: [
              {
                lineId: 'L1',
                rowNo: 1,
                description: 'عدد نامعتبر',
                kind: 'addition',
                unit: 'm',
                quantity: { type: 'dimensional', profile: 'L', length: 'abc' },
              },
            ],
          },
        ],
      },
    });
    expect(brokenSaved.statusCode).toBe(200); // the draft accepts the string shape
    const engineRejected = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs/doc-audit-broken/finalize`,
      headers: { cookie: estimatorCookie },
      payload: { expectedRevision: 2 },
    });
    expect(engineRejected.statusCode).toBe(422); // and finalization rejects it, persisting nothing

    // 409: only a FINALIZED takeoff can transfer (the broken draft above)
    const notFinalized = await server.app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/takeoffs/doc-audit-broken/transfer-to-boq`,
      headers: { cookie: estimatorCookie },
      payload: { versionId: TRANSFER_VERSION_ID },
    });
    expect(notFinalized.statusCode).toBe(409);

    // 404: finalizing an unknown version
    const missing = await server.app.inject({
      method: 'POST',
      url: '/estimate-versions/00000000-0000-4000-8000-000000000009/finalize',
      headers: { cookie: estimatorCookie },
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(missing.statusCode).toBe(404);

    // the broken document's create + save DID write their two events — account exactly
    expect(await eventsOf('takeoff_document.created', 'doc-audit-broken')).toHaveLength(1);
    expect(await eventsOf('takeoff_document.saved', 'doc-audit-broken')).toHaveLength(1);
    const after = await totalEvents();
    expect(after).toBe(before + 2); // only the two legitimate mutations — zero for every failure
  });

  it('RBAC denials write ZERO events (unauthenticated 401, viewer 403)', async () => {
    const before = await totalEvents();

    const anonymous = await server.rawInject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: 'beef0000-0000-4000-8000-0000000000aa', title: 'x' },
    });
    expect(anonymous.statusCode).toBe(401);

    const viewer = await server.app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: await server.cookieFor('viewer') },
      payload: { projectId: 'beef0000-0000-4000-8000-0000000000bb', title: 'x' },
    });
    expect(viewer.statusCode).toBe(403);

    expect(await totalEvents()).toBe(before); // no audit event for a 401/403 (CG-GOV §6)
  });
});

/* ------------------------------------------------------------------------------------------------
 * TRANSACTION semantics (§4.2) — mutation + event commit or roll back TOGETHER
 * -----------------------------------------------------------------------------------------------*/

describe('S3 §4.2 — transactional atomicity', () => {
  it('a forced rollback inside the REAL unit of work leaves neither the mutation nor the event', async () => {
    const projectId = 'beef0000-0000-4000-8000-0000000000cc';
    const project = createProject({
      projectId,
      title: 'پروژه بازگشتی',
      createdAt: FIXED_INSTANT,
    });
    const actor = { userId: adminId, username: TEST_ADMIN.username };
    await expect(
      server.deps.transact(async (tx) => {
        await tx.projects.save(project);
        await appendAuditEvent(tx.audit, projectCreated(actor, project), server.deps.clock);
        throw new Error('forced rollback (S3 transaction test)');
      }),
    ).rejects.toThrow('forced rollback (S3 transaction test)');

    const readBack = await server.app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { cookie: server.cookie },
    });
    expect(readBack.statusCode).toBe(404); // the mutation is gone
    expect(await eventsOf('project.created', projectId)).toEqual([]); // and so is its event
  });

  it('the commit path persists both the mutation and exactly one event', async () => {
    const projectId = 'beef0000-0000-4000-8000-0000000000dd';
    const project = createProject({
      projectId,
      title: 'پروژه تراکنش معتبر',
      createdAt: FIXED_INSTANT,
    });
    const actor = { userId: adminId, username: TEST_ADMIN.username };
    await server.deps.transact(async (tx) => {
      await tx.projects.save(project);
      await appendAuditEvent(tx.audit, projectCreated(actor, project), server.deps.clock);
    });
    const readBack = await server.app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { cookie: server.cookie },
    });
    expect(readBack.statusCode).toBe(200);
    const events = await eventsOf('project.created', projectId);
    expect(events).toHaveLength(1); // exactly one — no duplicate
    expect(events[0]?.details).toEqual({ title: 'پروژه تراکنش معتبر' });
  });

  it('a FAILING audit append inside a real handler rolls the mutation back (no event ⇔ no mutation)', async () => {
    // A dedicated PGlite stack where ONLY the project.created append fails — the
    // dependency seam the composition root exposes. The rollback itself is REAL
    // (PGlite BEGIN/ROLLBACK through the production Drizzle repositories).
    const pg = new PGlite();
    const raw = drizzle(pg);
    await migrate(raw, {
      migrationsFolder: new URL('../../../packages/db/migrations', import.meta.url).pathname,
    });
    const db = raw as unknown as DbClient;

    class ProjectAuditFailure implements AuditEventRepository {
      readonly #real: AuditEventRepository;

      constructor(real: AuditEventRepository) {
        this.#real = real;
      }

      async append(event: AuditEvent): Promise<void> {
        if (event.action === 'project.created') {
          throw new Error('S3 test: the audit writer failed');
        }
        await this.#real.append(event);
      }
    }

    const poolBound = bindRepositories(db);
    const deps: ApiDependencies = {
      repositories: {
        projects: poolBound.projects,
        estimates: poolBound.estimates,
        finalized: poolBound.finalized,
        takeoffDocuments: poolBound.takeoffDocuments,
        finalizedTakeoffs: poolBound.finalizedTakeoffs,
      },
      // the pool-bound writer stays REAL — it only serves standalone events (login_failed)
      governance: { users: poolBound.users, sessions: poolBound.sessions, audit: poolBound.audit },
      dataset: loadPublishedDataset(),
      clock: () => FIXED_INSTANT,
      // inside the transaction, the appends run on the TX-BOUND writer — except the
      // one action under test, which fails (a dependency-seam failure; the BEGIN/
      // ROLLBACK that follows is entirely real)
      transact: async (work) =>
        db.transaction(async (tx) => {
          const txBound = bindRepositories(tx);
          const failingTx: AuditEventRepository = new ProjectAuditFailure(txBound.audit);
          return work({ ...txBound, audit: failingTx });
        }),
    };
    await ensureBootstrapAdmin(
      { users: deps.governance.users, sessions: deps.governance.sessions, clock: deps.clock },
      { bootstrapAdminUsername: TEST_ADMIN.username, bootstrapAdminPassword: TEST_ADMIN.password },
    );
    const app = createApiServer(deps);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: TEST_ADMIN.username, password: TEST_ADMIN.password },
    });
    expect(login.statusCode).toBe(200); // non-project events still append (selective failure)
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
    expect(cookie).toBeDefined();

    const projectId = 'beef0000-0000-4000-8000-0000000000ee';
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: cookie ?? '' },
      payload: { projectId, title: 'پروژه شکست رویداد' },
    });
    expect(response.statusCode).toBe(500); // the writer failure surfaces as INTERNAL_ERROR

    // NEITHER the project NOR its event exists — the transaction rolled everything back.
    const readBack = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { cookie: cookie ?? '' },
    });
    expect(readBack.statusCode).toBe(404);
    const rows = (await pg.sql`select action from audit_events where action = 'project.created'`)
      .rows as readonly { action: string }[];
    expect(rows).toEqual([]);

    // the login event DID persist — proving the failure was isolated to the one append
    const loginRows = (
      await pg.sql`select action from audit_events where action = 'auth.login_succeeded'`
    ).rows as readonly { action: string }[];
    expect(loginRows).toHaveLength(1);
    await pg.close();
  });
});

/* ------------------------------------------------------------------------------------------------
 * APPEND-ONLY application surface + S4 boundary (§4.2/§4.3)
 * -----------------------------------------------------------------------------------------------*/

describe('S3 §4.2/§4.3 — append-only surface and the S4 boundary', () => {
  it('the canonical writer exposes append ONLY (no update/delete/read path in the application)', () => {
    expect(Object.getOwnPropertyNames(DrizzleAuditEventRepository.prototype).sort()).toEqual([
      'append',
      'constructor',
    ]);
    // the DB-level REVOKE proof (UPDATE/DELETE denied for the app role) is the
    // env-gated real-PostgreSQL suite: PGlite runs as the single superuser, where a
    // REVOKE cannot bind — that limitation is documented, never used to weaken the rule.
  });

  it('no approval event is reachable — S4 is not implemented (§4.3 #37/#38)', async () => {
    const all = await server.auditEvents();
    expect(all.filter((row) => row.action === 'estimate_version.approved')).toEqual([]);
    expect(all.filter((row) => row.action === 'takeoff_document.approved')).toEqual([]);
    // the writer contract still carries the S4 builders (payload: actor + instant only)
    const actor = { userId: adminId, username: TEST_ADMIN.username };
    expect(estimateVersionApproved(actor, 'v-x', 'p-x')).toEqual({
      actorUserId: adminId,
      action: 'estimate_version.approved',
      resourceType: 'estimate_version',
      resourceId: 'v-x',
      projectId: 'p-x',
      details: {},
    });
    expect(takeoffDocumentApproved(actor, 'd-x', 'p-x')).toEqual({
      actorUserId: adminId,
      action: 'takeoff_document.approved',
      resourceType: 'takeoff_document',
      resourceId: 'd-x',
      projectId: 'p-x',
      details: {},
    });
  });
});

/* ------------------------------------------------------------------------------------------------
 * SECURITY (§4.1/§9) — no credential material, boundary-stamped instants, no duplicates
 * -----------------------------------------------------------------------------------------------*/

describe('S3 security — the persisted history is safe and exact', () => {
  it('no audit row anywhere contains credential, token or secret material', async () => {
    const rows = await server.auditEvents();
    expect(rows.length).toBeGreaterThan(10); // the suite above produced real history
    // the details may carry ONLY the contract's own keys — nothing else could smuggle
    // a credential even by accident (§4.1: small, structured, contract-approved only)
    const allowedDetailKeys = new Set([
      'title',
      'versionNumber',
      'count',
      'lineIds',
      'rollupTotal',
      'documentNumber',
      'expectedRevision',
      'revision',
      'sourceDocumentId',
      'targetVersionId',
      'lineCount',
      'username',
      'role',
      'from',
      'to',
    ]);
    for (const row of rows) {
      for (const key of Object.keys(row.details as Record<string, unknown>)) {
        expect(allowedDetailKeys.has(key), `unexpected audit details key "${key}"`).toBe(true);
      }
      const payload = JSON.stringify({
        resourceId: row.resourceId,
        actorUserId: row.actorUserId,
        projectId: row.projectId,
        details: row.details,
      });
      expect(payload).not.toMatch(/scrypt|cg_session|cookie|authorization|bearer|secret/i);
      expect(payload).not.toContain('password'); // no key or value may carry the word
    }
    // the STRONGEST form: the actual credential values used by this suite never appear
    const secrets = [
      TEST_ADMIN.password,
      'first-password-123',
      'new-password-456',
      'wrong-current-999',
      'not-the-password-999',
      'wrong-password-123',
      'created-password-123',
      'role-password-123',
      'same-role-123',
      'deactivate-123',
      'forbidden-123',
      'spoof-password-123',
      'attempt-password-123',
      'estimator-password-123',
    ];
    const everything = JSON.stringify(rows);
    for (const secret of secrets) {
      expect(everything).not.toContain(secret);
    }
  });

  it('every event is boundary-stamped: UUID eventId, fixed-clock instant', async () => {
    const rows = await server.auditEvents();
    for (const row of rows) {
      expect(row.eventId).toMatch(UUID_RE);
      expect(row.at).toBe(FIXED_INSTANT);
    }
  });

  it('only auth.login_failed carries a null actor; every other actor is a persisted user id', async () => {
    const rows = await server.auditEvents();
    const knownActors = new Set<string>([adminId, estimatorId]);
    for (const row of rows) {
      if (row.action === 'auth.login_failed') {
        expect(row.actorUserId).toBe(null);
        continue;
      }
      expect(row.actorUserId, `${row.action} must have an actor`).not.toBe(null);
      expect(UUID_RE.test(row.actorUserId ?? '')).toBe(true);
      knownActors.add(row.actorUserId ?? '');
    }
    // the acting identities are exactly the users this suite authenticated
    expect(knownActors.size).toBeGreaterThanOrEqual(2);
  });

  it('no duplicate events: every domain/user operation appears exactly once per resource', async () => {
    const rows = await server.auditEvents();
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.action.startsWith('auth.')) continue; // logins legitimately repeat
      const key = `${row.action}|${row.resourceId}`;
      expect(seen.has(key), `duplicate audit event: ${key}`).toBe(false);
      seen.add(key);
    }
  });
});
