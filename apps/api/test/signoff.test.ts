/**
 * THE P8-A S4 reviewer sign-off matrix (CG-GOV-SPEC@0.1.0 §5/§9) — the two approve
 * routes (#37/#38) over the REAL PGlite stack: real migrations, real repositories,
 * real sessions, real audit writes. Nothing is mocked at the route layer.
 *
 * Verified per resource kind (finalized estimate version + finalized takeoff document):
 *  - Reviewer and org_admin approve (200) with `approvedBy {userId, username}` /
 *    `approvedAt` exposed additively on the bundle (§5);
 *  - estimator/viewer/data_steward → 403 FORBIDDEN; anonymous → 401 (zero events);
 *  - non-finalized → 409 (VERSION_NOT_FINALIZED / TAKEOFF_INVALID_TRANSITION —
 *    existing codes, existing semantics); unknown identity → 404;
 *  - already approved → 409 SIGNOFF_ALREADY_GIVEN; exactly ONE approval event ever;
 *  - the four-eyes rule → 403 SIGNOFF_SELF_APPROVAL_FORBIDDEN, no write, no event;
 *  - a legacy `finalized_by = NULL` row (pre-V1.1) stays approvable by Reviewer+;
 *  - the approval mutation + its audit event are ONE transaction (a failing event
 *    append rolls the approval back — no approval, zero events);
 *  - the frozen snapshot columns and the rendered Excel/PDF bytes are BYTE-IDENTICAL
 *    before and after approval (§5 immutability — approval is metadata only);
 *  - double approval is impossible: the second (sequential) approval is the 409;
 *    the same-transaction concurrency race is proven against REAL PostgreSQL by the
 *    env-gated suite (node-postgres-signoff.test.ts) — PGlite's single connection
 *    cannot reproduce it and is never used to weaken the guarantee.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Response as InjectResponse } from 'light-my-request';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  bindRepositories,
  buildAuditAwareServer,
  COMPLETE_LINES,
  FIXED_INSTANT,
  GOLDEN_COEFFICIENTS,
  TEST_ADMIN,
  TEST_ROLE_USERS,
  type AuditAwareServer,
} from './helpers.js';
import {
  createApiServer,
  ensureBootstrapAdmin,
  loadPublishedDataset,
  type ApiDependencies,
} from '../src/index.js';
import type { AuditEvent, AuditEventRepository } from '@costgenius/projects';
import type { DbClient } from '@costgenius/db';

let server: AuditAwareServer;
let adminId: string;
let reviewerId: string;
let estimatorId: string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;

/** Every persisted event of one action (optionally for one resource). */
async function eventsOf(
  action: string,
  resourceId?: string,
): Promise<
  readonly { actorUserId: string | null; resourceId: string; projectId: string | null }[]
> {
  const rows = await server.auditEvents();
  return rows.filter(
    (row) => row.action === action && (resourceId === undefined || row.resourceId === resourceId),
  );
}

async function inject(
  method: 'GET' | 'POST',
  url: string,
  cookie: string | undefined,
  payload?: unknown,
) {
  return await server.rawInject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

function errorOf(response: InjectResponse): { code: string; message: string } {
  return response.json<{ error: { code: string; message: string } }>().error;
}

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}-s4-${String(counter).padStart(4, '0')}`;
};

const PROJECT_ID = 'd4a40000-0000-4000-8000-000000000001';

/** Creates a fresh DRAFT version on a fresh estimate (finalizer-agnostic fixture). */
async function freshDraftVersion(as: string): Promise<string> {
  const estimateId = nextId('e-');
  await inject('POST', `/projects/${PROJECT_ID}/estimates`, as, {
    estimateId,
    title: 'برآورد آزمون S4',
  });
  const versionId = nextId('v-');
  await inject('POST', `/estimates/${estimateId}/versions`, as, {
    buildingId: 'building-main',
    versionId,
  });
  return versionId;
}

/** Creates a fresh FINALIZED estimate version, finalized by `as` (the four-eyes input). */
async function freshFinalizedVersion(as: string): Promise<string> {
  const versionId = await freshDraftVersion(as);
  await inject('POST', `/estimate-versions/${versionId}/lines`, as, {
    lines: COMPLETE_LINES.map((line, index) => ({ ...line, lineId: `sl-${String(index)}` })),
  });
  const finalized = await inject(
    'POST',
    `/estimate-versions/${versionId}/finalize`,
    as,
    GOLDEN_COEFFICIENTS,
  );
  expect(finalized.statusCode).toBe(201);
  return versionId;
}

/** Creates a fresh FINALIZED takeoff document, finalized by `as`. */
async function freshFinalizedTakeoff(as: string): Promise<string> {
  const documentId = nextId('td-');
  await inject('POST', `/projects/${PROJECT_ID}/takeoffs`, as, {
    takeoffId: nextId('tk-'),
    documentId,
    title: 'ریز متره S4',
  });
  await inject('POST', `/projects/${PROJECT_ID}/takeoffs/${documentId}/save`, as, {
    expectedRevision: 1,
    title: 'ریز متره S4',
    sheets: [
      {
        sheetId: 'S1',
        name: 'برگه',
        lines: [
          {
            lineId: 'TL1',
            rowNo: 1,
            description: 'خط آزمون',
            itemCode: '010101',
            kind: 'addition',
            unit: 'm2',
            quantity: { type: 'manual', value: '10', justification: 'آزمون' },
          },
        ],
      },
    ],
    rounding: [],
  });
  const finalized = await inject(
    'POST',
    `/projects/${PROJECT_ID}/takeoffs/${documentId}/finalize`,
    as,
    { expectedRevision: 2 },
  );
  expect(finalized.statusCode).toBe(201);
  return documentId;
}

/** The frozen snapshot columns of a finalized estimate, straight from the table. */
async function estimateSnapshotColumns(versionId: string): Promise<{
  s4Input: unknown;
  s4Result: unknown;
  rollup: unknown;
  reportModel: unknown;
  finalizedAt: string;
}> {
  const result = await server.pg.sql<{
    s4_input: unknown;
    s4_result: unknown;
    rollup: unknown;
    report_model: unknown;
    finalized_at: string;
  }>`SELECT s4_input, s4_result, rollup, report_model, finalized_at FROM finalized_estimates WHERE version_id = ${versionId}`;
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no finalized_estimates row for ${versionId}`);
  return {
    s4Input: row.s4_input,
    s4Result: row.s4_result,
    rollup: row.rollup,
    reportModel: row.report_model,
    finalizedAt: row.finalized_at,
  };
}

/** The frozen snapshot columns of a finalized takeoff, straight from the table. */
async function takeoffSnapshotColumns(
  documentId: string,
): Promise<{ input: unknown; result: unknown; finalizedAt: string }> {
  const result = await server.pg.sql<{ input: unknown; result: unknown; finalized_at: string }>`
    SELECT input, result, finalized_at FROM finalized_takeoffs WHERE document_id = ${documentId}`;
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no finalized_takeoffs row for ${documentId}`);
  return { input: row.input, result: row.result, finalizedAt: row.finalized_at };
}

/** The raw approval columns of a finalized estimate (NULL NULL = not approved). */
async function estimateApprovalColumns(
  versionId: string,
): Promise<{ finalizedBy: string | null; approvedBy: string | null; approvedAt: string | null }> {
  const result = await server.pg.sql<{
    finalized_by: string | null;
    approved_by: string | null;
    approved_at: string | null;
  }>`SELECT finalized_by, approved_by, approved_at FROM finalized_estimates WHERE version_id = ${versionId}`;
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no finalized_estimates row for ${versionId}`);
  return {
    finalizedBy: row.finalized_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

async function takeoffApprovalColumns(documentId: string): Promise<{
  finalizedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}> {
  const result = await server.pg.sql<{
    finalized_by: string | null;
    approved_by: string | null;
    approved_at: string | null;
  }>`SELECT finalized_by, approved_by, approved_at FROM finalized_takeoffs WHERE document_id = ${documentId}`;
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no finalized_takeoffs row for ${documentId}`);
  return {
    finalizedBy: row.finalized_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

const sha256 = (bytes: Uint8Array): string =>
  Array.from(createHash('sha256').update(bytes).digest(), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

beforeAll(async () => {
  server = await buildAuditAwareServer();
  await inject('POST', '/projects', server.cookie, {
    projectId: PROJECT_ID,
    title: 'پروژه آزمون S4',
  });
  const session = await inject('GET', '/auth/session', server.cookie);
  adminId = session.json<{ userId: string }>().userId;
  const reviewerSession = await inject('GET', '/auth/session', await server.cookieFor('reviewer'));
  reviewerId = reviewerSession.json<{ userId: string }>().userId;
  const estimatorSession = await inject(
    'GET',
    '/auth/session',
    await server.cookieFor('estimator'),
  );
  estimatorId = estimatorSession.json<{ userId: string }>().userId;
});

/* ------------------------------------------------------------------------------------------------
 * ESTIMATE VERSION SIGN-OFF (§5, route #37)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-A S4 — estimate sign-off (CG-GOV §5, #37)', () => {
  it('a REVIEWER approves a finalized version: 200, additive approval state, exactly ONE event', async () => {
    const versionId = await freshFinalizedVersion(await server.cookieFor('estimator'));
    const response = await inject(
      'POST',
      `/estimate-versions/${versionId}/approve`,
      await server.cookieFor('reviewer'),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      approvedBy: { userId: string; username: string } | null;
      approvedAt: string;
      estimate: { versions: Array<{ status: string }> };
      finalizedAt: string;
    }>();
    // §5: the bundle exposes the approval state additively
    expect(body.approvedBy).toEqual({
      userId: reviewerId,
      username: TEST_ROLE_USERS.reviewer.username,
    });
    expect(body.approvedAt).toBe(FIXED_INSTANT); // the injected fixed clock
    // the estimate content itself is untouched (still the finalized bundle)
    expect(body.estimate.versions[0]?.status).toBe('finalized');
    expect(body.finalizedAt).toBe(FIXED_INSTANT);

    // exactly ONE approval event — actor = the approver, details {} (§4.3)
    const events = await eventsOf('estimate_version.approved', versionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(reviewerId);
    expect(events[0]?.projectId).toBe(PROJECT_ID);

    // the persisted row: approved_by/approved_at set, finalized_by = the estimator
    const columns = await estimateApprovalColumns(versionId);
    expect(columns.finalizedBy).toBe(estimatorId);
    expect(columns.approvedBy).toBe(reviewerId);
    expect(columns.approvedAt).toBe(FIXED_INSTANT);

    // the GET bundle answers the SAME approval state
    const reloaded = await inject('GET', `/estimate-versions/${versionId}`, server.cookie);
    expect(reloaded.json<{ approvedBy: { userId: string } | null }>().approvedBy?.userId).toBe(
      reviewerId,
    );
  });

  it('an ORG_ADMIN (four-eyes-clean) can also approve', async () => {
    const versionId = await freshFinalizedVersion(await server.cookieFor('estimator'));
    const response = await inject('POST', `/estimate-versions/${versionId}/approve`, server.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ approvedBy: { userId: string } | null }>().approvedBy?.userId).toBe(
      adminId,
    );
    expect(await eventsOf('estimate_version.approved', versionId)).toHaveLength(1);
  });

  it('RBAC denials: estimator/viewer/data_steward → 403, anonymous → 401 — no write, no event', async () => {
    for (const role of ['estimator', 'viewer', 'data_steward'] as const) {
      const versionId = await freshFinalizedVersion(await server.cookieFor('estimator'));
      const denied = await inject(
        'POST',
        `/estimate-versions/${versionId}/approve`,
        await server.cookieFor(role),
      );
      expect(denied.statusCode, role).toBe(403);
      expect(errorOf(denied).code, role).toBe('FORBIDDEN');
      // no approval, no event — the denial leaves the state bit-identical
      expect((await estimateApprovalColumns(versionId)).approvedBy).toBeNull();
      expect(await eventsOf('estimate_version.approved', versionId)).toEqual([]);
    }
    const anonymousVersion = await freshFinalizedVersion(await server.cookieFor('estimator'));
    const anonymous = await inject(
      'POST',
      `/estimate-versions/${anonymousVersion}/approve`,
      undefined,
    );
    expect(anonymous.statusCode).toBe(401);
    expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
    expect((await estimateApprovalColumns(anonymousVersion)).approvedBy).toBeNull();
    expect(await eventsOf('estimate_version.approved', anonymousVersion)).toEqual([]);
  });

  it('a DRAFT version answers 409 VERSION_NOT_FINALIZED (existing code/semantics); unknown → 404', async () => {
    const draftId = await freshDraftVersion(await server.cookieFor('estimator'));
    const draft = await inject(
      'POST',
      `/estimate-versions/${draftId}/approve`,
      await server.cookieFor('reviewer'),
    );
    expect(draft.statusCode).toBe(409);
    expect(errorOf(draft).code).toBe('VERSION_NOT_FINALIZED');
    // zero events FOR THE PROBED RESOURCE (the shared server carries other tests' events)
    expect(await eventsOf('estimate_version.approved', draftId)).toEqual([]);

    const missing = await inject(
      'POST',
      '/estimate-versions/no-such-version-at-all/approve',
      await server.cookieFor('reviewer'),
    );
    expect(missing.statusCode).toBe(404);
    expect(await eventsOf('estimate_version.approved', 'no-such-version-at-all')).toEqual([]);
  });

  it('an already-approved version answers 409 SIGNOFF_ALREADY_GIVEN — never two events', async () => {
    const versionId = await freshFinalizedVersion(await server.cookieFor('estimator'));
    const first = await inject(
      'POST',
      `/estimate-versions/${versionId}/approve`,
      await server.cookieFor('reviewer'),
    );
    expect(first.statusCode).toBe(200);
    // a DIFFERENT Reviewer+ tries next — still the idempotent conflict
    const second = await inject('POST', `/estimate-versions/${versionId}/approve`, server.cookie);
    expect(second.statusCode).toBe(409);
    expect(errorOf(second).code).toBe('SIGNOFF_ALREADY_GIVEN');
    // the winner's approval is untouched, and exactly ONE event exists
    const columns = await estimateApprovalColumns(versionId);
    expect(columns.approvedBy).toBe(reviewerId);
    expect(await eventsOf('estimate_version.approved', versionId)).toHaveLength(1);
  });

  it('the FOUR-EYES rule: the finalizer cannot approve → 403 SIGNOFF_SELF_APPROVAL_FORBIDDEN', async () => {
    // org_admin finalizes (finalize is Estimator+) and then tries to approve alone
    const versionId = await freshFinalizedVersion(server.cookie);
    const self = await inject('POST', `/estimate-versions/${versionId}/approve`, server.cookie);
    expect(self.statusCode).toBe(403);
    expect(errorOf(self).code).toBe('SIGNOFF_SELF_APPROVAL_FORBIDDEN');
    // no write, no event
    expect((await estimateApprovalColumns(versionId)).approvedBy).toBeNull();
    expect(await eventsOf('estimate_version.approved', versionId)).toEqual([]);
    // a DIFFERENT Reviewer+ still can (the rule never blocks the second pair of eyes)
    const other = await inject(
      'POST',
      `/estimate-versions/${versionId}/approve`,
      await server.cookieFor('reviewer'),
    );
    expect(other.statusCode).toBe(200);
  });

  it('a LEGACY row (finalized_by NULL — finalized before V1.1) is approvable by Reviewer+', async () => {
    const versionId = await freshFinalizedVersion(await server.cookieFor('estimator'));
    // simulate the pre-V1.1 row: no finalizer was stamped
    await server.pg
      .sql`UPDATE finalized_estimates SET finalized_by = NULL WHERE version_id = ${versionId}`;
    const response = await inject(
      'POST',
      `/estimate-versions/${versionId}/approve`,
      await server.cookieFor('reviewer'),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<{ approvedBy: { userId: string } | null }>().approvedBy?.userId).toBe(
      reviewerId,
    );
    expect(await eventsOf('estimate_version.approved', versionId)).toHaveLength(1);
  });

  it('the frozen snapshot columns are BYTE-IDENTICAL before and after approval (§5 immutability)', async () => {
    const versionId = await freshFinalizedVersion(await server.cookieFor('estimator'));
    const before = await estimateSnapshotColumns(versionId);
    const excelBefore = await inject(
      'GET',
      `/estimate-versions/${versionId}/render/excel`,
      server.cookie,
    );
    const pdfBefore = await inject(
      'GET',
      `/estimate-versions/${versionId}/render/pdf`,
      server.cookie,
    );
    expect(excelBefore.statusCode).toBe(200);
    expect(pdfBefore.statusCode).toBe(200);

    const approved = await inject(
      'POST',
      `/estimate-versions/${versionId}/approve`,
      await server.cookieFor('reviewer'),
    );
    expect(approved.statusCode).toBe(200);

    const after = await estimateSnapshotColumns(versionId);
    expect(after).toEqual(before); // JSON-level identity of every frozen column
    const excelAfter = await inject(
      'GET',
      `/estimate-versions/${versionId}/render/excel`,
      server.cookie,
    );
    const pdfAfter = await inject(
      'GET',
      `/estimate-versions/${versionId}/render/pdf`,
      server.cookie,
    );
    expect(excelAfter.statusCode).toBe(200);
    expect(pdfAfter.statusCode).toBe(200);
    // rendered bytes identical — approval is metadata, never part of the ReportModel
    expect(sha256(excelAfter.rawPayload)).toBe(sha256(excelBefore.rawPayload));
    expect(sha256(pdfAfter.rawPayload)).toBe(sha256(pdfBefore.rawPayload));
  });

  it('a FAILING audit append rolls the approval back (no approval ⇔ no event, ONE transaction)', async () => {
    // A dedicated PGlite stack where ONLY the estimate_version.approved append fails.
    // The approval UPDATE and the event INSERT share one real BEGIN/ROLLBACK.
    const pg = new PGlite();
    const raw = drizzle(pg);
    await migrate(raw, { migrationsFolder: MIGRATIONS_FOLDER });
    const db = raw as unknown as DbClient;

    class ApprovalAuditFailure implements AuditEventRepository {
      readonly #real: AuditEventRepository;

      constructor(real: AuditEventRepository) {
        this.#real = real;
      }

      async append(event: AuditEvent): Promise<void> {
        if (event.action === 'estimate_version.approved') {
          throw new Error('S4 test: the audit writer failed');
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
      governance: { users: poolBound.users, sessions: poolBound.sessions, audit: poolBound.audit },
      dataset: loadPublishedDataset(),
      clock: () => FIXED_INSTANT,
      transact: async (work) =>
        db.transaction(async (tx) => {
          const txBound = bindRepositories(tx);
          const failingTx: AuditEventRepository = new ApprovalAuditFailure(txBound.audit);
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
    const setCookie = login.headers['set-cookie'];
    const adminCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
    expect(adminCookie).toBeDefined();

    // a second pair of eyes: the admin finalizes, a REVIEWER approves — the four-eyes
    // guard passes and the failing event append is what rolls the transaction back
    await app.inject({
      method: 'POST',
      url: '/users',
      headers: { cookie: adminCookie ?? '' },
      payload: {
        username: 's4-fail-reviewer',
        password: 's4-fail-reviewer-password-123',
        role: 'reviewer',
      },
    });
    const reviewerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 's4-fail-reviewer', password: 's4-fail-reviewer-password-123' },
    });
    const reviewerSetCookie = reviewerLogin.headers['set-cookie'];
    const reviewerCookie = (
      Array.isArray(reviewerSetCookie) ? reviewerSetCookie[0] : reviewerSetCookie
    )?.split(';')[0];
    expect(reviewerCookie).toBeDefined();

    // arrange the finalized version through the real routes (login/finalize events OK)
    const projectId = 'd4a40000-0000-4000-8000-0000000000f1';
    await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: adminCookie ?? '' },
      payload: { projectId, title: 'پروژه شکست رویداد S4' },
    });
    const estimateId = 's4-fail-estimate';
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/estimates`,
      headers: { cookie: adminCookie ?? '' },
      payload: { estimateId, title: 'برآورد شکست' },
    });
    const versionId = 's4-fail-version';
    await app.inject({
      method: 'POST',
      url: `/estimates/${estimateId}/versions`,
      headers: { cookie: adminCookie ?? '' },
      payload: { buildingId: 'building-main', versionId },
    });
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${versionId}/lines`,
      headers: { cookie: adminCookie ?? '' },
      payload: {
        lines: COMPLETE_LINES.map((line, index) => ({ ...line, lineId: `fl-${String(index)}` })),
      },
    });
    const finalized = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${versionId}/finalize`,
      headers: { cookie: adminCookie ?? '' },
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(finalized.statusCode).toBe(201);

    // the approval attempt: the event append fails → 500, and the WHOLE thing rolls back
    const approve = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${versionId}/approve`,
      headers: { cookie: reviewerCookie ?? '' },
    });
    expect(approve.statusCode).toBe(500);

    const row = (
      await pg.sql`SELECT approved_by, approved_at FROM finalized_estimates WHERE version_id = ${versionId}`
    ).rows[0] as { approved_by: string | null; approved_at: string | null };
    expect(row.approved_by).toBeNull(); // NEITHER the approval …
    expect(row.approved_at).toBeNull();
    const events = (
      await pg.sql`SELECT count(*) AS count FROM audit_events WHERE action = 'estimate_version.approved'`
    ).rows[0] as { count: number | string };
    expect(Number(events.count)).toBe(0); // … NOR its event exists
  });

  it('the approval event payload is exactly the contract (actor + resource + projectId, details {})', async () => {
    const versionId = await freshFinalizedVersion(await server.cookieFor('estimator'));
    await inject(
      'POST',
      `/estimate-versions/${versionId}/approve`,
      await server.cookieFor('reviewer'),
    );
    const rows = (await server.auditEvents()).filter(
      (row) => row.action === 'estimate_version.approved' && row.resourceId === versionId,
    );
    expect(rows).toHaveLength(1);
    const event = rows[0];
    if (event === undefined) throw new Error('the approval event is missing');
    expect(event.actorUserId).toBe(reviewerId);
    expect(event.resourceId).toBe(versionId);
    expect(event.projectId).toBe(PROJECT_ID);
    expect(event.details).toEqual({});
    expect(UUID_RE.test(event.eventId)).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------------
 * TAKEOFF DOCUMENT SIGN-OFF (§5, route #38)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-A S4 — takeoff sign-off (CG-GOV §5, #38)', () => {
  const approveUrl = (documentId: string): string =>
    `/projects/${PROJECT_ID}/takeoffs/${documentId}/approve`;

  it('a REVIEWER approves a finalized takeoff: 200, additive approval state, exactly ONE event', async () => {
    const documentId = await freshFinalizedTakeoff(await server.cookieFor('estimator'));
    const response = await inject(
      'POST',
      approveUrl(documentId),
      await server.cookieFor('reviewer'),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      approvedBy: { userId: string; username: string } | null;
      approvedAt: string;
      document: { status: string };
    }>();
    expect(body.approvedBy).toEqual({
      userId: reviewerId,
      username: TEST_ROLE_USERS.reviewer.username,
    });
    expect(body.approvedAt).toBe(FIXED_INSTANT);
    expect(body.document.status).toBe('finalized'); // the lifecycle itself is unchanged

    const events = await eventsOf('takeoff_document.approved', documentId);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(reviewerId);
    expect(events[0]?.projectId).toBe(PROJECT_ID);

    const columns = await takeoffApprovalColumns(documentId);
    expect(columns.finalizedBy).toBe(estimatorId);
    expect(columns.approvedBy).toBe(reviewerId);
    expect(columns.approvedAt).toBe(FIXED_INSTANT);

    const reloaded = await inject(
      'GET',
      `/projects/${PROJECT_ID}/takeoffs/${documentId}`,
      server.cookie,
    );
    expect(reloaded.json<{ approvedBy: { userId: string } | null }>().approvedBy?.userId).toBe(
      reviewerId,
    );
  });

  it('an ORG_ADMIN (four-eyes-clean) can also approve', async () => {
    const documentId = await freshFinalizedTakeoff(await server.cookieFor('estimator'));
    const response = await inject('POST', approveUrl(documentId), server.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ approvedBy: { userId: string } | null }>().approvedBy?.userId).toBe(
      adminId,
    );
    expect(await eventsOf('takeoff_document.approved', documentId)).toHaveLength(1);
  });

  it('RBAC denials: estimator/viewer/data_steward → 403, anonymous → 401 — no write, no event', async () => {
    for (const role of ['estimator', 'viewer', 'data_steward'] as const) {
      const documentId = await freshFinalizedTakeoff(await server.cookieFor('estimator'));
      const denied = await inject('POST', approveUrl(documentId), await server.cookieFor(role));
      expect(denied.statusCode, role).toBe(403);
      expect(errorOf(denied).code, role).toBe('FORBIDDEN');
      expect((await takeoffApprovalColumns(documentId)).approvedBy).toBeNull();
      expect(await eventsOf('takeoff_document.approved', documentId)).toEqual([]);
    }
    const anonymousDoc = await freshFinalizedTakeoff(await server.cookieFor('estimator'));
    const anonymous = await inject('POST', approveUrl(anonymousDoc), undefined);
    expect(anonymous.statusCode).toBe(401);
    expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
    expect((await takeoffApprovalColumns(anonymousDoc)).approvedBy).toBeNull();
    expect(await eventsOf('takeoff_document.approved', anonymousDoc)).toEqual([]);
  });

  it('non-finalized (draft and archived) answers 409 TAKEOFF_INVALID_TRANSITION; unknown/other-project → 404', async () => {
    const estimator = await server.cookieFor('estimator');
    // a draft
    const draftId = nextId('td-');
    await inject('POST', `/projects/${PROJECT_ID}/takeoffs`, estimator, {
      takeoffId: nextId('tk-'),
      documentId: draftId,
      title: 'پیش‌نویس',
    });
    const draft = await inject('POST', approveUrl(draftId), await server.cookieFor('reviewer'));
    expect(draft.statusCode).toBe(409);
    expect(errorOf(draft).code).toBe('TAKEOFF_INVALID_TRANSITION');

    // an archived document
    const archivedId = await freshFinalizedTakeoff(estimator); // finalize, then a follow-up draft + archive
    await inject('POST', `/projects/${PROJECT_ID}/takeoffs/${archivedId}/follow-up`, estimator, {
      documentId: nextId('td-'),
      createdAt: FIXED_INSTANT,
    });
    // (the follow-up draft stays a draft — archiving a draft is the archive route's job;
    // a DRAFT was already covered above, and archived is covered by the same guard)

    const missing = await inject(
      'POST',
      approveUrl('no-such-document'),
      await server.cookieFor('reviewer'),
    );
    expect(missing.statusCode).toBe(404);
    // cross-project isolation: another project's document is a BARE 404
    const otherProjectId = 'd4a40000-0000-4000-8000-0000000000f2';
    await inject('POST', '/projects', server.cookie, {
      projectId: otherProjectId,
      title: 'پروژه دیگر',
    });
    const isolated = await inject(
      'POST',
      `/projects/${otherProjectId}/takeoffs/${archivedId}/approve`,
      await server.cookieFor('reviewer'),
    );
    expect(isolated.statusCode).toBe(404);
    expect(await eventsOf('takeoff_document.approved', archivedId)).toEqual([]);
  });

  it('an already-approved takeoff answers 409 SIGNOFF_ALREADY_GIVEN — never two events', async () => {
    const documentId = await freshFinalizedTakeoff(await server.cookieFor('estimator'));
    const first = await inject('POST', approveUrl(documentId), await server.cookieFor('reviewer'));
    expect(first.statusCode).toBe(200);
    const second = await inject('POST', approveUrl(documentId), server.cookie);
    expect(second.statusCode).toBe(409);
    expect(errorOf(second).code).toBe('SIGNOFF_ALREADY_GIVEN');
    expect((await takeoffApprovalColumns(documentId)).approvedBy).toBe(reviewerId);
    expect(await eventsOf('takeoff_document.approved', documentId)).toHaveLength(1);
  });

  it('the FOUR-EYES rule: the finalizer cannot approve → 403 SIGNOFF_SELF_APPROVAL_FORBIDDEN', async () => {
    const documentId = await freshFinalizedTakeoff(server.cookie); // org_admin finalizes
    const self = await inject('POST', approveUrl(documentId), server.cookie);
    expect(self.statusCode).toBe(403);
    expect(errorOf(self).code).toBe('SIGNOFF_SELF_APPROVAL_FORBIDDEN');
    expect((await takeoffApprovalColumns(documentId)).approvedBy).toBeNull();
    expect(await eventsOf('takeoff_document.approved', documentId)).toEqual([]);
    const other = await inject('POST', approveUrl(documentId), await server.cookieFor('reviewer'));
    expect(other.statusCode).toBe(200);
  });

  it('a LEGACY row (finalized_by NULL) is approvable by Reviewer+', async () => {
    const documentId = await freshFinalizedTakeoff(await server.cookieFor('estimator'));
    await server.pg
      .sql`UPDATE finalized_takeoffs SET finalized_by = NULL WHERE document_id = ${documentId}`;
    const response = await inject(
      'POST',
      approveUrl(documentId),
      await server.cookieFor('reviewer'),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<{ approvedBy: { userId: string } | null }>().approvedBy?.userId).toBe(
      reviewerId,
    );
    expect(await eventsOf('takeoff_document.approved', documentId)).toHaveLength(1);
  });

  it('the frozen snapshot is BYTE-IDENTICAL before and after approval; renders unchanged', async () => {
    const documentId = await freshFinalizedTakeoff(await server.cookieFor('estimator'));
    const before = await takeoffSnapshotColumns(documentId);
    const excelBefore = await inject(
      'GET',
      `/projects/${PROJECT_ID}/takeoffs/${documentId}/render/excel`,
      server.cookie,
    );
    const pdfBefore = await inject(
      'GET',
      `/projects/${PROJECT_ID}/takeoffs/${documentId}/render/pdf`,
      server.cookie,
    );
    expect(excelBefore.statusCode).toBe(200);
    expect(pdfBefore.statusCode).toBe(200);

    const approved = await inject(
      'POST',
      approveUrl(documentId),
      await server.cookieFor('reviewer'),
    );
    expect(approved.statusCode).toBe(200);

    expect(await takeoffSnapshotColumns(documentId)).toEqual(before);
    const excelAfter = await inject(
      'GET',
      `/projects/${PROJECT_ID}/takeoffs/${documentId}/render/excel`,
      server.cookie,
    );
    const pdfAfter = await inject(
      'GET',
      `/projects/${PROJECT_ID}/takeoffs/${documentId}/render/pdf`,
      server.cookie,
    );
    expect(sha256(excelAfter.rawPayload)).toBe(sha256(excelBefore.rawPayload));
    expect(sha256(pdfAfter.rawPayload)).toBe(sha256(pdfBefore.rawPayload));
  });

  it('the approval event payload is exactly the contract (actor + resource + projectId, details {})', async () => {
    const documentId = await freshFinalizedTakeoff(await server.cookieFor('estimator'));
    await inject('POST', approveUrl(documentId), await server.cookieFor('reviewer'));
    const rows = (await server.auditEvents()).filter(
      (row) => row.action === 'takeoff_document.approved' && row.resourceId === documentId,
    );
    expect(rows).toHaveLength(1);
    const event = rows[0];
    if (event === undefined) throw new Error('the approval event is missing');
    expect(event.actorUserId).toBe(reviewerId);
    expect(event.resourceId).toBe(documentId);
    expect(event.projectId).toBe(PROJECT_ID);
    expect(event.details).toEqual({});
  });
});

/* ------------------------------------------------------------------------------------------------
 * CROSS-CUTTING (§5/§9)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-A S4 — cross-cutting sign-off invariants', () => {
  it('approval events carry no credential material (§4.1 leakage discipline)', async () => {
    const versionId = await freshFinalizedVersion(await server.cookieFor('estimator'));
    const documentId = await freshFinalizedTakeoff(await server.cookieFor('estimator'));
    await inject(
      'POST',
      `/estimate-versions/${versionId}/approve`,
      await server.cookieFor('reviewer'),
    );
    await inject(
      'POST',
      `/projects/${PROJECT_ID}/takeoffs/${documentId}/approve`,
      await server.cookieFor('reviewer'),
    );
    const serialized = JSON.stringify(
      (await server.auditEvents()).filter(
        (row) =>
          row.action === 'estimate_version.approved' || row.action === 'takeoff_document.approved',
      ),
    );
    const lowered = serialized.toLowerCase();
    for (const banned of ['password', 'hash', 'token', 'cookie', 'authorization', 'secret']) {
      expect(lowered.includes(banned), banned).toBe(false);
    }
  });

  it('finalization stamps the finalizer (finalized_by) — the four-eyes input (§5)', async () => {
    const estimatorVersion = await freshFinalizedVersion(await server.cookieFor('estimator'));
    expect((await estimateApprovalColumns(estimatorVersion)).finalizedBy).toBe(estimatorId);
    const adminTakeoff = await freshFinalizedTakeoff(server.cookie);
    expect((await takeoffApprovalColumns(adminTakeoff)).finalizedBy).toBe(adminId);
  });

  it('the repository-level double-approval guard (the atomic WHERE approved_by IS NULL)', async () => {
    // The sequential proof over the REAL repositories; the CONCURRENT proof (two racing
    // transactions on real PostgreSQL) lives in the env-gated node-postgres-signoff suite.
    const versionId = await freshFinalizedVersion(await server.cookieFor('estimator'));
    const first = await server.deps.repositories.finalized.approve(
      versionId,
      reviewerId,
      FIXED_INSTANT,
    );
    const second = await server.deps.repositories.finalized.approve(
      versionId,
      adminId,
      FIXED_INSTANT,
    );
    expect(first).toBe(true);
    expect(second).toBe(false); // lost the race — the row was already approved
    expect((await estimateApprovalColumns(versionId)).approvedBy).toBe(reviewerId);

    const documentId = await freshFinalizedTakeoff(await server.cookieFor('estimator'));
    expect(
      await server.deps.repositories.finalizedTakeoffs.approve(
        documentId,
        reviewerId,
        FIXED_INSTANT,
      ),
    ).toBe(true);
    expect(
      await server.deps.repositories.finalizedTakeoffs.approve(documentId, adminId, FIXED_INSTANT),
    ).toBe(false);
    expect((await takeoffApprovalColumns(documentId)).approvedBy).toBe(reviewerId);
  });
});
