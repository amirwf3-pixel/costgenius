/**
 * Real-server smoke verification of the node-postgres → PostgreSQL SERVER path.
 *
 * Phase 14 verified the repository code against real PostgreSQL semantics in-process
 * (PGlite). This suite verifies the remaining production leg — the `pg` driver against
 * an actual PostgreSQL server — end to end: connection → migration → the full estimate
 * workflow with real 1404 rows → finalize → persist → NEW connection → reload → snapshot
 * equality → data-integrity asserts → render.
 *
 * GATED BY ENVIRONMENT: it runs only when `COSTGENIUS_SMOKE_DATABASE_URL` is set (a
 * disposable database; the migrations and workflow write real rows). When the variable
 * is absent the suite is SKIPPED and reports `NOT RUN — environment not available`;
 * it is NEVER reported as passed, and PGlite results are never presented as server
 * verification.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createDb,
  createDbPool,
  DrizzleEstimateRepository,
  DrizzleFinalizedEstimateRepository,
  DrizzleProjectRepository,
  migrateDatabase,
  canonicalJson,
  type DbClient,
} from '@costgenius/db';
import { publishStagedImport } from '@costgenius/pricebook';
import {
  addEstimateLines,
  calculateEstimateVersion,
  createEstimateForProject,
  createProject,
  finalizeEstimate,
  renderEstimateExcel,
  renderEstimatePdf,
  startEstimateVersion,
} from '@costgenius/projects';
import type { FinalizedEstimate } from '@costgenius/projects';
import { COMPLETE_LINES, COMPLETE_S4_EXPECTED, TEST_ADMIN } from './helpers.js';
import { startApi } from '../src/index.js';

const SMOKE_URL = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];

const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;
const DATASET_PATH = new URL(
  '../../../packages/pricebook/data/verified-1404.staged.v0.1.0.json',
  import.meta.url,
).pathname;

const PROJECT_ID = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
const ESTIMATE_ID = '12345678-90ab-4cde-9f01-234567890abc';
const VERSION_ID = `${ESTIMATE_ID}-v1`;
const BUILDING_ID = 'building-smoke';
const INSTANT = '2026-01-01T00:00:00Z';
const SOURCE_HASH = 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f';

const LINES = [
  { lineId: 'l1', pricebookCode: '010101', quantity: '1000', unit: 'm2' },
  { lineId: 'l2', pricebookCode: '010517', quantity: '5', unit: 'm2' },
  { lineId: 'l3', pricebookCode: '240102', quantity: '0', unit: 'm2' },
  { lineId: 'l4', pricebookCode: '270101', quantity: '120', unit: 'kg' },
  { lineId: 'l5', pricebookCode: '270320', quantity: '10', unit: 'm3' },
  { lineId: 'l6', pricebookCode: '270403', quantity: '2', unit: 'm3' },
  { lineId: 'l7', pricebookCode: '280101', quantity: '500', unit: 'ton_km' },
  { lineId: 'big', pricebookCode: '010101', quantity: '123456789012345678000001', unit: 'm2' },
  { lineId: 'b1', pricebookCode: '220925', quantity: '40', unit: 'm2' },
  { lineId: 'b4', pricebookCode: '991001', quantity: '600', unit: 'm2_month' },
] as const;

const COEFFICIENTS = {
  floor: {
    buildingId: BUILDING_ID,
    groundFloorArea: '600',
    firstBasementArea: '400',
    aboveGroundFloors: [...Array.from({ length: 10 }, () => ({ area: '500' })), { area: '400' }],
    belowGroundFloors: Array.from({ length: 3 }, () => ({ area: '400' })),
    totalBuildingFloorArea: '7600',
  },
  overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' } as const,
  regional: { parts: [{ regionId: 'r-smoke', coefficient: '1.1', executionCost: '1' }] },
  siteSetup: { lumpSumAmount: '12000000' },
};

it('smoke availability report (never counted as server verification when absent)', () => {
  if (SMOKE_URL === undefined) {
    console.warn(
      '[NODE-POSTGRES SMOKE] NOT RUN — environment not available: COSTGENIUS_SMOKE_DATABASE_URL is not set. ' +
        'The node-postgres → PostgreSQL server path is NOT VERIFIED in this environment.',
    );
  } else {
    console.warn('[NODE-POSTGRES SMOKE] environment detected — running the real-server chain.');
  }
  expect(true).toBe(true);
});

describe.skipIf(SMOKE_URL === undefined)('node-postgres → real PostgreSQL server', () => {
  it('connection → migration → workflow → finalize → persist → NEW connection → reload → verify → render', async () => {
    const url = SMOKE_URL as string;

    // ---- connection #1: migrate + inspect schema + run the whole workflow + persist ----
    const runWorkflow = async (): Promise<FinalizedEstimate> => {
      const pool = createDbPool(url);
      const db: DbClient = createDb(pool);
      await migrateDatabase(db, MIGRATIONS_FOLDER);
      // Phase 16 §7 — migration idempotency on the real server: re-running the
      // journal-based migrations is a schema-preserving no-op.
      await migrateDatabase(db, MIGRATIONS_FOLDER);

      // Phase 16 §7 — schema inspection on the REAL server (parameterized catalog
      // queries only): the TWELVE tables of the three migrations (the five estimate-
      // family tables of 0000, the four takeoff-family tables of 0001_d016_takeoff, and
      // the three governance tables of 0002_p8_governance), their primary keys, their
      // foreign keys, the (estimate_id, version_number) uniqueness and the exact column
      // types the integrity guarantees depend on. (P7-S3 repaired the stale five-table
      // expectation to nine; P8-A S1 extends the verified schema to twelve.)
      const publicTables = (
        await pool.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
        )
      ).rows.map((row) => row.table_name);
      expect(publicTables).toEqual([
        'audit_events',
        'boq_lines',
        'estimate_versions',
        'estimates',
        'finalized_estimates',
        'finalized_takeoffs',
        'projects',
        'sessions',
        'takeoff_documents',
        'takeoff_lines',
        'takeoff_sheets',
        'users',
      ]);

      const pkOf = async (table: string): Promise<string[]> =>
        (
          await pool.query<{ column_name: string }>(
            `SELECT kcu.column_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON kcu.constraint_name = tc.constraint_name
                AND kcu.table_schema = tc.table_schema
              WHERE tc.table_schema = 'public'
                AND tc.table_name = $1
                AND tc.constraint_type = 'PRIMARY KEY'
              ORDER BY kcu.ordinal_position`,
            [table],
          )
        ).rows.map((row) => row.column_name);
      expect(await pkOf('projects')).toEqual(['project_id']);
      expect(await pkOf('estimates')).toEqual(['estimate_id']);
      expect(await pkOf('estimate_versions')).toEqual(['version_id']);
      expect(await pkOf('boq_lines')).toEqual(['version_id', 'line_id']);
      expect(await pkOf('finalized_estimates')).toEqual(['version_id']);
      expect(await pkOf('users')).toEqual(['user_id']);
      expect(await pkOf('sessions')).toEqual(['session_token_hash']);
      expect(await pkOf('audit_events')).toEqual(['event_id']);

      const fkCounts = (
        await pool.query<{ table_name: string; n: number }>(
          `SELECT tc.table_name, count(*)::int AS n
             FROM information_schema.table_constraints tc
            WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
            GROUP BY tc.table_name ORDER BY tc.table_name`,
        )
      ).rows;
      // (P7-S3 extended the stale five-table view to the nine-table schema; P8-A S1
      // extends it to twelve — sessions → users; audit_events → users AND → projects.
      // P8-A S4 adds the sign-off FKs on BOTH finalized tables — finalized_by and
      // approved_by → users, migration 0003, CG-GOV §7 item 4.)
      expect(fkCounts).toEqual([
        { table_name: 'audit_events', n: 2 },
        { table_name: 'boq_lines', n: 1 },
        { table_name: 'estimate_versions', n: 1 },
        { table_name: 'estimates', n: 1 },
        { table_name: 'finalized_estimates', n: 4 },
        { table_name: 'finalized_takeoffs', n: 3 },
        { table_name: 'sessions', n: 1 },
        { table_name: 'takeoff_documents', n: 1 },
        { table_name: 'takeoff_lines', n: 1 },
        { table_name: 'takeoff_sheets', n: 1 },
      ]);

      const uniqueIndex = (
        await pool.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'estimate_versions'
              AND indexname = 'estimate_versions_estimate_number_key'`,
        )
      ).rows[0]?.indexdef;
      expect(uniqueIndex).toContain('UNIQUE');
      expect(uniqueIndex).toContain('(estimate_id, version_number)');

      const columnType = async (table: string, column: string): Promise<string> =>
        (
          await pool.query<{ udt_name: string }>(
            `SELECT udt_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
            [table, column],
          )
        ).rows[0]?.udt_name ?? 'column-missing';
      expect(await columnType('boq_lines', 'quantity')).toBe('numeric');
      expect(await columnType('boq_lines', 'base_price')).toBe('numeric');
      expect(await columnType('boq_lines', 'line_amount')).toBe('numeric');
      expect(await columnType('boq_lines', 'pricebook_code')).toBe('text');
      expect(await columnType('boq_lines', 'edition')).toBe('text');
      expect(await columnType('boq_lines', 'source_ref')).toBe('jsonb');
      expect(await columnType('boq_lines', 'trace')).toBe('jsonb');
      expect(await columnType('boq_lines', 'notes')).toBe('jsonb');
      expect(await columnType('estimates', 'project_id')).toBe('uuid');
      expect(await columnType('estimate_versions', 'status')).toBe('text');
      expect(await columnType('finalized_estimates', 's4_result')).toBe('jsonb');
      expect(await columnType('finalized_estimates', 'finalized_at')).toBe('text');
      expect(await columnType('projects', 'created_at')).toBe('text');

      const dataset = publishStagedImport(JSON.parse(readFileSync(DATASET_PATH, 'utf8')));
      const projects = new DrizzleProjectRepository(db);
      const finalizedStore = new DrizzleFinalizedEstimateRepository(db);

      const project = createProject({
        projectId: PROJECT_ID,
        title: 'smoke',
        createdAt: INSTANT,
      });
      await projects.save(project);

      let estimate = createEstimateForProject(project, {
        estimateId: ESTIMATE_ID,
        title: 'smoke estimate',
      });
      estimate = startEstimateVersion(dataset, estimate, {
        createdAt: INSTANT,
        buildingId: BUILDING_ID,
      });
      const added = addEstimateLines(dataset, estimate, VERSION_ID, LINES);
      if (!added.ok) throw new Error(`lines must resolve: ${JSON.stringify(added.failures)}`);
      const finalized = finalizeEstimate(added.estimate, VERSION_ID, COEFFICIENTS, {
        reportId: 'rep-smoke',
        generatedAt: INSTANT,
        finalizedAt: INSTANT,
      });
      await finalizedStore.save(finalized);

      await pool.end();
      return finalized;
    };

    const finalizedBundle = await runWorkflow();

    // ---- NEW connection: reload and verify the immutable snapshot --------------------
    const pool2 = createDbPool(url);
    const db2: DbClient = createDb(pool2);
    const estimates2 = new DrizzleEstimateRepository(db2);
    const finalized2 = new DrizzleFinalizedEstimateRepository(db2);

    const reloaded = await finalized2.byVersionId(VERSION_ID);
    expect(reloaded).toBeDefined();
    expect(canonicalJson(reloaded?.calculation)).toBe(canonicalJson(finalizedBundle.calculation));
    expect(reloaded?.finalizedAt).toBe(INSTANT);
    expect(reloaded?.estimate.versions[0]?.status).toBe('finalized');

    // ---- data integrity on the reloaded snapshot ------------------------------------
    const lines = reloaded?.estimate.versions[0]?.lines ?? [];
    const byLine = new Map(lines.map((l) => [l.lineId, l]));

    // NULL semantics: 220925 and Appendix-5 991001 never become zero
    expect(byLine.get('b1')?.basePrice).toBeNull();
    expect(byLine.get('b1')?.lineAmount).toBeNull();
    expect(byLine.get('b1')?.notes[0]).toContain('کسر بها');
    expect(byLine.get('b4')?.basePrice).toBeNull();
    expect(byLine.get('b4')?.unit.code).toBe('m2_month');

    // negative prices survive the server round-trip
    expect(byLine.get('l5')?.basePrice).toBe('-1037000');
    expect(byLine.get('l5')?.lineAmount).toBe('-10370000');
    expect(byLine.get('l6')?.basePrice).toBe('-2131000');
    expect(byLine.get('l6')?.lineAmount).toBe('-4262000');

    // leading zero and exact decimals survive the server round-trip
    expect(byLine.get('l1')?.pricebookCode).toBe('010101');
    expect(byLine.get('big')?.quantity).toBe('123456789012345678000001');
    expect(byLine.get('big')?.lineAmount).toBe('356790120245679009420002890');
    expect(byLine.get('big')?.trace.unitPrice).toBe('2890');

    // the exact S4 coefficient chain survives as exact strings
    const stages = reloaded?.calculation.s4Result.stages ?? [];
    expect(stages.find((s) => s.stage === 'floor')?.coefficient).toBe('1.0451');
    expect(stages.find((s) => s.stage === 'overhead')?.coefficient).toBe('1.30');

    // provenance survives end-to-end
    const l1 = byLine.get('l1');
    expect(l1?.sourceRef.sourceDocument).toBe('فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴');
    expect(l1?.sourceRef.edition).toBe('1404');
    expect(l1?.sourceRef.printedPage).toBe('11');
    expect(l1?.sourceRef.section).toBe('Chapter 1, Group 1');
    expect(l1?.sourceRef.sourceFileHash).toBe(SOURCE_HASH);

    // ---- render from the reloaded snapshot ------------------------------------------
    const xlsx = await renderEstimateExcel(reloaded?.calculation ?? finalizedBundle.calculation);
    expect(xlsx.length).toBeGreaterThan(1000);
    expect(xlsx[0]).toBe(0x50);
    const pdf = await renderEstimatePdf(reloaded?.calculation ?? finalizedBundle.calculation);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');

    // Phase 16 §28 — determinism: the same reloaded snapshot renders byte-identically.
    const xlsxAgain = await renderEstimateExcel(
      reloaded?.calculation ?? finalizedBundle.calculation,
    );
    expect(Buffer.compare(Buffer.from(xlsxAgain), Buffer.from(xlsx))).toBe(0);
    const pdfAgain = await renderEstimatePdf(reloaded?.calculation ?? finalizedBundle.calculation);
    expect(Buffer.compare(Buffer.from(pdfAgain), Buffer.from(pdf))).toBe(0);

    // Phase 16 §28 + §7 — same input, same dataset file, same database state: re-running
    // the ENTIRE workflow is a value-idempotent no-op. The recomputed bundle is
    // byte-identical and no row count changes (nothing is double-written).
    const countsBefore = await rowCountSummary(pool2);
    const rerun = await runWorkflow();
    expect(canonicalJson(rerun.calculation)).toBe(canonicalJson(finalizedBundle.calculation));
    expect(canonicalJson(rerun.estimate)).toBe(canonicalJson(finalizedBundle.estimate));
    expect(await rowCountSummary(pool2)).toEqual(countsBefore);

    // ---- dataset mutation after finalization cannot change history -------------------
    const mutatedFile = JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as {
      rows: Array<{ code: string; basePrice: string | null }>;
    };
    const row = mutatedFile.rows.find((r) => r.code === '010101');
    if (row === undefined) throw new Error('010101 missing');
    row.basePrice = '999999';
    const mutated = publishStagedImport(mutatedFile);
    expect(mutated.getRow('010101')?.basePrice).toBe('999999');

    const again = await finalized2.byVersionId(VERSION_ID);
    expect(canonicalJson(again?.calculation)).toBe(canonicalJson(finalizedBundle.calculation));
    const v1 = await estimates2.findByVersionId(VERSION_ID);
    expect(v1?.versions[0]?.lines.find((l) => l.lineId === 'l1')?.basePrice).toBe('2890');

    await pool2.end();
  }, 180_000);

  it('§11 the attested Phase 15 golden chain computes and persists exactly on the real server', async () => {
    const url = SMOKE_URL as string;
    const dataset = publishStagedImport(
      JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as Parameters<typeof publishStagedImport>[0],
    );
    const pool = createDbPool(url);
    try {
      const db: DbClient = createDb(pool);
      await migrateDatabase(db, MIGRATIONS_FOLDER);
      const projects = new DrizzleProjectRepository(db);
      const finalizedStore = new DrizzleFinalizedEstimateRepository(db);

      const GOLDEN_IDS = {
        projectId: '901daaaa-aa00-4000-8000-00000000aaaa',
        estimateId: '901dbbbb-bb00-4000-8000-00000000bbbb',
      };
      const versionId = `${GOLDEN_IDS.estimateId}-v1`;

      const project = createProject({
        projectId: GOLDEN_IDS.projectId,
        title: 'golden chain',
        createdAt: INSTANT,
      });
      await projects.save(project);
      let estimate = createEstimateForProject(project, {
        estimateId: GOLDEN_IDS.estimateId,
        title: 'golden chain estimate',
      });
      estimate = startEstimateVersion(dataset, estimate, {
        createdAt: INSTANT,
        buildingId: 'building-main',
      });
      const added = addEstimateLines(dataset, estimate, versionId, COMPLETE_LINES);
      if (!added.ok)
        throw new Error(`golden lines must resolve: ${JSON.stringify(added.failures)}`);
      estimate = added.estimate;

      const calculation = calculateEstimateVersion(estimate, versionId, GOLDEN_COEFFICIENTS, {
        reportId: 'rep-golden',
        generatedAt: INSTANT,
      });
      const stageOf = (kind: string) => calculation.s4Result.stages.find((s) => s.stage === kind);
      // 38147600 → ×1.0451 → ×1.30 → ×1.1 → +12000000 → 69011321.1668 — exact strings.
      expect(stageOf('base-subtotal')?.output).toBe(COMPLETE_S4_EXPECTED.base);
      expect(stageOf('floor')?.coefficient).toBe('1.0451');
      expect(stageOf('floor')?.output).toBe(COMPLETE_S4_EXPECTED.afterFloor);
      expect(stageOf('overhead')?.coefficient).toBe('1.30');
      expect(stageOf('overhead')?.output).toBe(COMPLETE_S4_EXPECTED.afterOverhead);
      expect(stageOf('regional')?.coefficient).toBe('1.1');
      expect(stageOf('regional')?.output).toBe(COMPLETE_S4_EXPECTED.afterRegional);
      expect(stageOf('site-setup')?.output).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
      expect(calculation.s4Result.finalEstimate).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
      expect(calculation.rollup.amount).toBe(COMPLETE_S4_EXPECTED.base);

      const finalized = finalizeEstimate(estimate, versionId, GOLDEN_COEFFICIENTS, {
        reportId: 'rep-golden',
        generatedAt: INSTANT,
        finalizedAt: INSTANT,
      });
      await finalizedStore.save(finalized);
      const reloaded = await finalizedStore.byVersionId(versionId);
      expect(reloaded?.calculation.s4Result.finalEstimate).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
      expect(canonicalJson(reloaded?.calculation.s4Result)).toBe(
        canonicalJson(finalized.calculation.s4Result),
      );
      expect(reloaded?.estimate.versions[0]?.lines).toHaveLength(8);
      expect(reloaded?.estimate.versions[0]?.lines[0]?.pricebookCode).toBe('010101');
    } finally {
      await pool.end();
    }
  }, 180_000);

  it('§17/§18 production lifecycle: startApi listens, serves, and shuts down without leaking the pool', async () => {
    const url = SMOKE_URL as string;
    const api = await startApi({
      databaseUrl: url,
      port: 0, // ephemeral port — never collide with anything
      host: '127.0.0.1',
      datasetPath: DATASET_PATH,
      // P8-A S1 (CG-GOV §1.5): an empty users table without bootstrap credentials
      // fails closed — the deterministic TEST credentials come from test setup only.
      bootstrapAdminUsername: TEST_ADMIN.username,
      bootstrapAdminPassword: TEST_ADMIN.password,
    });
    try {
      const address = api.app.server.address();
      if (typeof address !== 'object' || address === null) {
        throw new Error('expected the listening TCP address');
      }
      const base = `http://127.0.0.1:${String(address.port)}`;

      // liveness over real TCP
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect((await health.json()) as { status: string }).toEqual({ status: 'ok' });

      // P8-A S1 — the auth gate is the FIRST contract over real TCP: an anonymous
      // database-backed route answers 401 (fail closed), never the data shape.
      const anonymous = await fetch(`${base}/projects/00000000-0000-4000-8000-000000000000`);
      expect(anonymous.status).toBe(401);
      expect(((await anonymous.json()) as { error: { code: string } }).error.code).toBe(
        'UNAUTHENTICATED',
      );

      // real login through the same session mechanism the product uses
      const login = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: TEST_ADMIN.username,
          password: TEST_ADMIN.password,
        }),
      });
      expect(login.status).toBe(200);
      const sessionCookie = login.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('cg_session='));
      expect(sessionCookie).toBeDefined();
      const adminCookie = sessionCookie?.split(';')[0] ?? '';

      // P8-A S2: the bootstrap admin is org_admin on the real server
      const session = await fetch(`${base}/auth/session`, { headers: { cookie: adminCookie } });
      expect(session.status).toBe(200);
      expect(((await session.json()) as { role: string }).role).toBe('org_admin');

      // P8-A S2: a real lower-role account, denied mutations over real TCP
      const viewer = await fetch(`${base}/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          username: 'node-pg-viewer',
          password: 'node-pg-viewer-password-123',
          role: 'viewer',
        }),
      });
      expect(viewer.status).toBe(201);
      const viewerLogin = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'node-pg-viewer',
          password: 'node-pg-viewer-password-123',
        }),
      });
      expect(viewerLogin.status).toBe(200);
      const viewerCookie =
        viewerLogin.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith('cg_session='))
          ?.split(';')[0] ?? '';
      const viewerRead = await fetch(`${base}/projects`, { headers: { cookie: viewerCookie } });
      expect(viewerRead.status).toBe(200);
      const viewerDenied = await fetch(`${base}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: viewerCookie },
        body: JSON.stringify({ projectId: crypto.randomUUID(), title: 'ممنوع' }),
      });
      expect(viewerDenied.status).toBe(403);
      expect(((await viewerDenied.json()) as { error: { code: string } }).error.code).toBe(
        'FORBIDDEN',
      );

      // a database-backed route answers over real TCP with the stable error contract
      const missing = await fetch(`${base}/projects/00000000-0000-4000-8000-000000000000`, {
        headers: { cookie: adminCookie },
      });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    } finally {
      await api.stop(); // stop accepting → close Fastify → end the pool (onClose hook)
    }

    // after stop(): the server no longer listens and the pool is ended — any further
    // repository call rejects instead of silently using a resurrected connection.
    expect(api.app.server.listening).toBe(false);
    await expect(api.dependencies.repositories.projects.findById(PROJECT_ID)).rejects.toThrow();
  }, 180_000);
});

/** Row counts of the five application tables (idempotent-rerun comparison, Phase 16 §28). */
async function rowCountSummary(
  pool: ReturnType<typeof createDbPool>,
): Promise<Record<string, number>> {
  const result = await pool.query<{ table_name: string; n: number }>(
    `SELECT 'projects' AS table_name, count(*)::int AS n FROM projects
      UNION ALL SELECT 'estimates', count(*)::int FROM estimates
      UNION ALL SELECT 'estimate_versions', count(*)::int FROM estimate_versions
      UNION ALL SELECT 'boq_lines', count(*)::int FROM boq_lines
      UNION ALL SELECT 'finalized_estimates', count(*)::int FROM finalized_estimates`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.table_name, row.n]));
}

/** The attested Phase 15 golden coefficient inputs (same values as the API fixture). */
const GOLDEN_COEFFICIENTS = {
  floor: {
    buildingId: 'building-main',
    groundFloorArea: '600',
    firstBasementArea: '400',
    aboveGroundFloors: [...Array.from({ length: 10 }, () => ({ area: '500' })), { area: '400' }],
    belowGroundFloors: Array.from({ length: 3 }, () => ({ area: '400' })),
    totalBuildingFloorArea: '7600',
  },
  overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' } as const,
  regional: {
    parts: [{ regionId: 'r-golden', coefficient: '1.1', executionCost: '51828473.788' }],
  },
  siteSetup: { lumpSumAmount: '12000000' },
};
