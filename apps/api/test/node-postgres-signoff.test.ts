/**
 * P8-A S4 — REAL-PostgreSQL sign-off concurrency verification (CG-GOV §5/§12).
 *
 * GATED BY ENVIRONMENT: runs only when `COSTGENIUS_SMOKE_DATABASE_URL` is set (a
 * disposable database), exactly like the other node-postgres server suites. When the
 * variable is absent the suite is SKIPPED and PGlite results are never presented as
 * server verification.
 *
 * Verified invariants (the route layer adds NO concurrency logic of its own — the
 * `approved_by IS NULL`-guarded UPDATE of the finalized repositories is the authority):
 *  - two SIMULTANEOUS approvals of one finalized estimate version → exactly one 200
 *    and one 409 SIGNOFF_ALREADY_GIVEN, exactly ONE approval event, one `approved_by`;
 *  - the mirror race for a finalized takeoff document;
 *  - the same approver racing itself is equally safe (double-click protection);
 *  - the racing loser leaves no partial state: no event, no approved_at, and the
 *    winner's identity is the only one persisted.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  createDb,
  createDbPool,
  DrizzleSessionRepository,
  DrizzleUserRepository,
  migrateDatabase,
  type DbClient,
} from '@costgenius/db';
import {
  createApiServer,
  ensureBootstrapAdmin,
  loadPublishedDataset,
  seedPricebookEdition,
} from '../src/index.js';
import {
  bindRepositories,
  GOLDEN_COEFFICIENTS,
  loginCookie,
  TEST_ADMIN,
  transactOver,
} from './helpers.js';

const SMOKE_URL = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;
const INSTANT = '2026-01-01T00:00:00Z';

type App = ReturnType<typeof createApiServer>;

interface RaceResult {
  readonly statuses: number[];
  readonly codes: (string | undefined)[];
}

describe.skipIf(SMOKE_URL === undefined)('S4 sign-off concurrency (real PostgreSQL server)', () => {
  let app: App;
  let db: DbClient;
  let poolRef: Pool;
  let closePool: () => Promise<void>;
  let adminCookie: string;
  let reviewerCookie: string;
  let estimatorCookie: string;

  beforeAll(async () => {
    const pool = createDbPool(SMOKE_URL as string);
    poolRef = pool;
    db = createDb(pool);
    await migrateDatabase(db, MIGRATIONS_FOLDER);
    const userStore = new DrizzleUserRepository(db);
    const sessionStore = new DrizzleSessionRepository(db);
    await ensureBootstrapAdmin(
      { users: userStore, sessions: sessionStore, clock: () => INSTANT },
      { bootstrapAdminUsername: TEST_ADMIN.username, bootstrapAdminPassword: TEST_ADMIN.password },
    );
    const poolBound = bindRepositories(db);
    // P8-B S1 (D-PB-1 = B): the first-boot pricebook seed — same boot order as
    // production; a no-op on the reused disposable database of a later run.
    await seedPricebookEdition({
      users: userStore,
      editions: poolBound.editions,
      transact: transactOver(db),
      clock: () => INSTANT,
    });
    app = createApiServer({
      repositories: {
        projects: poolBound.projects,
        estimates: poolBound.estimates,
        finalized: poolBound.finalized,
        takeoffDocuments: poolBound.takeoffDocuments,
        finalizedTakeoffs: poolBound.finalizedTakeoffs,
        editions: poolBound.editions,
      },
      governance: { users: userStore, sessions: sessionStore, audit: poolBound.audit },
      dataset: loadPublishedDataset(),
      clock: () => INSTANT,
      transact: transactOver(db),
    });
    adminCookie = await loginCookie(app, TEST_ADMIN.username, TEST_ADMIN.password);
    // a reviewer (the second pair of eyes) and an estimator (the finalizer). The
    // disposable database may be REUSED by a later pass: a 409 USERNAME_ALREADY_TAKEN
    // is the same known user (same password, same role) — log in and continue.
    for (const [username, role] of [
      ['s4-race-reviewer', 'reviewer'],
      ['s4-race-estimator', 'estimator'],
    ] as const) {
      const created = await app.inject({
        method: 'POST',
        url: '/users',
        headers: { cookie: adminCookie },
        payload: { username, password: `${username}-password-123`, role },
      });
      expect(
        created.statusCode === 201 ||
          (created.statusCode === 409 &&
            created.json<{ error?: { code?: string } }>().error?.code === 'USERNAME_ALREADY_TAKEN'),
        `${username}: ${created.body}`,
      ).toBe(true);
    }
    reviewerCookie = await loginCookie(app, 's4-race-reviewer', 's4-race-reviewer-password-123');
    estimatorCookie = await loginCookie(app, 's4-race-estimator', 's4-race-estimator-password-123');
    closePool = () => pool.end();
  });

  afterAll(async () => {
    await closePool();
  });

  /** Fires two approvals SIMULTANEOUSLY and collects status + error code of each. */
  async function raceApprovals(url: string, cookieA: string, cookieB: string): Promise<RaceResult> {
    const fire = async (cookie: string) => {
      const response = await app.inject({ method: 'POST', url, headers: { cookie } });
      const body = response.json<{ error?: { code?: string } }>();
      return { status: response.statusCode, code: body.error?.code };
    };
    const [a, b] = await Promise.all([fire(cookieA), fire(cookieB)]);
    return {
      statuses: [a.status, b.status].sort(),
      codes: [a.code, b.code],
    };
  }

  /** The persisted approval columns of a finalized estimate (straight from the table). */
  async function estimateApproval(
    versionId: string,
  ): Promise<{ approvedBy: string | null; approvedAt: string | null }> {
    const result = await poolRef.query<{ approved_by: string | null; approved_at: string | null }>(
      'SELECT approved_by, approved_at FROM finalized_estimates WHERE version_id = $1',
      [versionId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`no finalized_estimates row for ${versionId}`);
    return { approvedBy: row.approved_by, approvedAt: row.approved_at };
  }

  it('two SIMULTANEOUS estimate approvals → exactly one 200, one 409, ONE event', async () => {
    // fixture: the ESTIMATOR finalizes (four-eyes-clean for both racers)
    const projectId = '540a0000-0000-4000-8000-000000000001';
    const estimateId = 's4-race-estimate-1';
    const versionId = 's4-race-version-1';
    const post = async (url: string, payload: unknown, cookie = estimatorCookie) => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: payload as Record<string, unknown>,
      });
      expect(response.statusCode, url).toBeLessThan(300);
    };
    await post('/projects', { projectId, title: 'پروژه همزمانی S4' }, adminCookie);
    await post(`/projects/${projectId}/estimates`, { estimateId, title: 'برآورد' });
    await post(`/estimates/${estimateId}/versions`, {
      buildingId: 'building-main',
      versionId,
    });
    await post(`/estimate-versions/${versionId}/lines`, {
      lines: [{ lineId: 'L1', pricebookCode: '010101', quantity: '10', unit: 'm2' }],
    });
    await post(`/estimate-versions/${versionId}/finalize`, GOLDEN_COEFFICIENTS);

    const race = await raceApprovals(
      `/estimate-versions/${versionId}/approve`,
      reviewerCookie,
      adminCookie,
    );
    // exactly one winner — never two 200s, never a 5xx
    expect(race.statuses).toEqual([200, 409]);
    expect(race.codes.includes('SIGNOFF_ALREADY_GIVEN')).toBe(true);

    // ONE approval, ONE event, ONE approved_by — the loser wrote nothing
    const approval = await estimateApproval(versionId);
    expect(approval.approvedBy).not.toBeNull();
    expect(approval.approvedAt).toBe(INSTANT);
    const events = await poolRef.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'estimate_version.approved' AND resource_id = $1",
      [versionId],
    );
    expect(Number(events.rows[0]?.count ?? -1)).toBe(1);
  });

  it('the SAME approver racing itself is equally safe (double-click)', async () => {
    const projectId = '540a0000-0000-4000-8000-000000000002';
    const estimateId = 's4-race-estimate-2';
    const versionId = 's4-race-version-2';
    const post = async (url: string, payload: unknown, cookie = estimatorCookie) => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: payload as Record<string, unknown>,
      });
      expect(response.statusCode, url).toBeLessThan(300);
    };
    await post('/projects', { projectId, title: 'پروژه همزمانی S4' }, adminCookie);
    await post(`/projects/${projectId}/estimates`, { estimateId, title: 'برآورد' });
    await post(`/estimates/${estimateId}/versions`, {
      buildingId: 'building-main',
      versionId,
    });
    await post(`/estimate-versions/${versionId}/lines`, {
      lines: [{ lineId: 'L1', pricebookCode: '010101', quantity: '10', unit: 'm2' }],
    });
    await post(`/estimate-versions/${versionId}/finalize`, GOLDEN_COEFFICIENTS);

    const race = await raceApprovals(
      `/estimate-versions/${versionId}/approve`,
      reviewerCookie,
      reviewerCookie,
    );
    expect(race.statuses).toEqual([200, 409]);
    // both racers are the SAME reviewer — whoever won, it is THAT reviewer
    const reviewerRow = await poolRef.query<{ user_id: string }>(
      "SELECT user_id FROM users WHERE username = 's4-race-reviewer'",
    );
    const winner = await estimateApproval(versionId);
    expect(winner.approvedBy).toBe(reviewerRow.rows[0]?.user_id);
    expect(winner.approvedAt).toBe(INSTANT);
  });

  it('the mirror race for a FINALIZED TAKEOFF document', async () => {
    const projectId = '540a0000-0000-4000-8000-000000000003';
    const documentId = 's4-race-takeoff-3';
    const takeoffId = 's4-race-chain-3';
    const post = async (url: string, payload: unknown, cookie = estimatorCookie) => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: payload as Record<string, unknown>,
      });
      expect(response.statusCode, url).toBeLessThan(300);
    };
    await post('/projects', { projectId, title: 'پروژه همزمانی S4' }, adminCookie);
    await post(`/projects/${projectId}/takeoffs`, {
      takeoffId,
      documentId,
      title: 'ریز متره',
    });
    await post(`/projects/${projectId}/takeoffs/${documentId}/save`, {
      expectedRevision: 1,
      title: 'ریز متره',
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
    await post(`/projects/${projectId}/takeoffs/${documentId}/finalize`, {
      expectedRevision: 2,
    });

    const race = await raceApprovals(
      `/projects/${projectId}/takeoffs/${documentId}/approve`,
      reviewerCookie,
      adminCookie,
    );
    expect(race.statuses).toEqual([200, 409]);
    expect(race.codes.includes('SIGNOFF_ALREADY_GIVEN')).toBe(true);

    const row = await poolRef.query<{ approved_by: string | null; approved_at: string | null }>(
      'SELECT approved_by, approved_at FROM finalized_takeoffs WHERE document_id = $1',
      [documentId],
    );
    expect(row.rows[0]?.approved_by).not.toBeNull();
    expect(row.rows[0]?.approved_at).toBe(INSTANT);
    const events = await poolRef.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'takeoff_document.approved' AND resource_id = $1",
      [documentId],
    );
    expect(Number(events.rows[0]?.count ?? -1)).toBe(1);
  });
});
