/**
 * THE Phase 17 production estimate workflow test (end-to-end, §29/§30).
 *
 * The full product story runs over real HTTP (Fastify inject → routing → Zod →
 * `@costgenius/projects` → repository contracts → `@costgenius/db` → Drizzle → database):
 *
 *   create project → view project → (empty) estimate list → create estimate → start v1 →
 *   add the 5-code golden 1404 lines → view version → calculate (review: null total,
 *   never 0, کسر بها, negative prices, external dependency) → finalize → reload
 *   (canonical snapshot equality) → render Excel + PDF (byte-deterministic) →
 *   finalized mutation rejected → create v2 → add the complete 8-line revision →
 *   calculate v2 (EXACT golden chain) → v1 byte-unchanged.
 *
 * It runs TWICE against two databases:
 * 1. always — PGlite (real PostgreSQL in-process), the CI posture; and
 * 2. when `COSTGENIUS_SMOKE_DATABASE_URL` is set — a REAL PostgreSQL server over TCP via
 *    node-postgres (the production path verified in Phase 16). Without the variable the
 *    second suite is skipped and reported NOT RUN — PGlite is never presented as the
 *    real-server verification.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  canonicalJson,
  createDb,
  createDbPool,
  DrizzleSessionRepository,
  DrizzleUserRepository,
  migrateDatabase,
  type DbClient,
} from '@costgenius/db';
import type { FinalizedEstimate } from '@costgenius/projects';
import { createApiServer, ensureBootstrapAdmin, seedPricebookEdition } from '../src/index.js';
import type { ApiDependencies } from '../src/index.js';
import {
  attachAuthenticatedServer,
  bindRepositories,
  buildTestServer,
  TEST_ADMIN,
  transactOver,
} from './helpers.js';
import { BUILDING_ID, FIXED_INSTANT, GOLDEN_COEFFICIENTS, ORGANIZATION_ID } from './helpers.js';
import {
  GOLDEN_V1_EXPECTED,
  GOLDEN_V2_EXPECTED,
  GOLDEN_WORKFLOW_LINES,
} from './golden-estimate.js';
import { GOLDEN_V2_LINES } from './golden-estimate.js';

const SMOKE = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;

/**
 * This suite's OWN identities (never the smoke/concurrency suites' ids): the real-server
 * suites share one disposable database, so each must write a disjoint id space to stay
 * order-independent.
 */
const PROJECT_ID = 'dddddddd-dddd-4ddd-8ddd-ffffffffffff';
const ESTIMATE_ID = '99999999-9999-4999-8999-999999999999';
const V1_ID = `${ESTIMATE_ID}-v1`;
const V2_ID = `${ESTIMATE_ID}-v2`;

type CalculationBody = {
  rollup: { amount: string | null; lineCount: number; status: string };
  s4Result: {
    calculationStatus: string;
    finalEstimate: string | null;
    stages: Array<{ stage: string; coefficient: string | null; output: string | null }>;
  };
};

/** The shared production workflow — every step is an HTTP call (§30). */
async function runProductionWorkflow(app: FastifyInstance): Promise<void> {
  // ---- Project: create, view, list its (still empty) estimates -------------------------
  const created = await app.inject({
    method: 'POST',
    url: '/projects',
    payload: {
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      title: 'ساختمان اداری فاز ۱۷',
      metadata: { location: 'Tehran', description: 'مرحله اول' },
    },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json<{ createdAt: string }>().createdAt).toBe(FIXED_INSTANT);

  const project = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}` });
  expect(project.statusCode).toBe(200);
  expect(project.json<{ title: string; metadata: Record<string, string> }>().metadata).toEqual({
    location: 'Tehran',
    description: 'مرحله اول',
  });

  const emptyList = await app.inject({
    method: 'GET',
    url: `/projects/${PROJECT_ID}/estimates`,
  });
  expect(emptyList.statusCode).toBe(200);
  expect(emptyList.json<unknown[]>()).toEqual([]);

  // ---- Estimate + v1 draft ---------------------------------------------------------------
  const estimate = await app.inject({
    method: 'POST',
    url: `/projects/${PROJECT_ID}/estimates`,
    payload: { estimateId: ESTIMATE_ID, title: 'برآورد اولیه' },
  });
  expect(estimate.statusCode).toBe(201);

  const v1 = await app.inject({
    method: 'POST',
    url: `/estimates/${ESTIMATE_ID}/versions`,
    payload: { buildingId: BUILDING_ID },
  });
  expect(v1.statusCode).toBe(201);
  expect(
    v1.json<{ versionNumber: number; status: string; edition: string; lines: unknown[] }>(),
  ).toEqual({
    versionId: V1_ID,
    estimateId: ESTIMATE_ID,
    versionNumber: 1,
    status: 'draft',
    createdAt: FIXED_INSTANT,
    edition: '1404',
    // P8-B S3: the version's edition binding rides additively on every version body
    editionId: 'ir-1404-abniye',
    buildingId: BUILDING_ID,
    metadata: {},
    lines: [],
  });

  // ---- BOQ: add the golden 1404 lines, then view them -------------------------------------
  const added = await app.inject({
    method: 'POST',
    url: `/estimate-versions/${V1_ID}/lines`,
    payload: { lines: GOLDEN_WORKFLOW_LINES },
  });
  expect(added.statusCode).toBe(200);
  expect(added.json<{ lines: unknown[] }>().lines).toHaveLength(GOLDEN_V1_EXPECTED.lineCount);

  const viewed = await app.inject({ method: 'GET', url: `/estimate-versions/${V1_ID}` });
  expect(viewed.statusCode).toBe(200);
  const viewedVersion = viewed.json<{
    status: string;
    lines: Array<{
      lineId: string;
      pricebookCode: string;
      basePrice: string | null;
      notes: string[];
      externalDependencies: string[];
    }>;
  }>();
  const byId = new Map(viewedVersion.lines.map((line) => [line.lineId, line]));
  expect(byId.get('g1')?.pricebookCode).toBe(GOLDEN_V1_EXPECTED.leadingZeroCode);
  expect(byId.get('g2')?.basePrice).toBe(GOLDEN_V1_EXPECTED.negativePrices[0]);
  expect(byId.get('g3')?.basePrice).toBe(GOLDEN_V1_EXPECTED.negativePrices[1]);
  expect(byId.get('g4')?.basePrice).toBeNull(); // deduction: null, never 0
  expect(byId.get('g4')?.notes[0]).toContain(GOLDEN_V1_EXPECTED.deductionNote);
  expect(byId.get('g5')?.basePrice).toBeNull(); // star item: unpriced
  expect(byId.get('g5')?.externalDependencies.length).toBeGreaterThan(0);

  // ---- Calculate (review): incomplete version → null total, never 0 ----------------------
  const calc = await app.inject({
    method: 'POST',
    url: `/estimate-versions/${V1_ID}/calculate`,
    payload: GOLDEN_COEFFICIENTS,
  });
  expect(calc.statusCode).toBe(200);
  const calculation = calc.json<CalculationBody>();
  expect(calculation.rollup.lineCount).toBe(GOLDEN_V1_EXPECTED.lineCount);
  expect(calculation.rollup.amount).toBeNull();
  expect(calculation.s4Result.finalEstimate).toBeNull();
  const floorCoefficient = calculation.s4Result.stages.find(
    (s) => s.stage === 'floor',
  )?.coefficient;
  expect(floorCoefficient).toBe('1.0451');

  // ---- Finalize + reload (canonical snapshot equality) ------------------------------------
  const finalize = await app.inject({
    method: 'POST',
    url: `/estimate-versions/${V1_ID}/finalize`,
    payload: GOLDEN_COEFFICIENTS,
  });
  expect(finalize.statusCode).toBe(201);
  const bundle = finalize.json<FinalizedEstimate>();
  expect(bundle.finalizedAt).toBe(FIXED_INSTANT);
  expect(bundle.estimate.versions[0]?.status).toBe('finalized');

  const reloaded = await app.inject({ method: 'GET', url: `/estimate-versions/${V1_ID}` });
  expect(reloaded.statusCode).toBe(200);
  expect(canonicalJson(reloaded.json<unknown>())).toBe(canonicalJson(bundle));

  // ---- Render from the persisted snapshot (no recalculation) ------------------------------
  const xlsx = await app.inject({ method: 'GET', url: `/estimate-versions/${V1_ID}/render/excel` });
  expect(xlsx.statusCode).toBe(200);
  expect(xlsx.headers['content-type']).toContain('spreadsheetml');
  expect(xlsx.rawPayload[0]).toBe(0x50); // 'P' of the PK zip magic
  expect(xlsx.rawPayload.length).toBeGreaterThan(1000);
  const pdf = await app.inject({ method: 'GET', url: `/estimate-versions/${V1_ID}/render/pdf` });
  expect(pdf.statusCode).toBe(200);
  expect(pdf.headers['content-type']).toContain('application/pdf');
  expect(new TextDecoder().decode(pdf.rawPayload.subarray(0, 5))).toBe('%PDF-');

  const xlsxAgain = await app.inject({
    method: 'GET',
    url: `/estimate-versions/${V1_ID}/render/excel`,
  });
  expect(Buffer.compare(xlsxAgain.rawPayload, xlsx.rawPayload)).toBe(0);
  const pdfAgain = await app.inject({
    method: 'GET',
    url: `/estimate-versions/${V1_ID}/render/pdf`,
  });
  expect(Buffer.compare(pdfAgain.rawPayload, pdf.rawPayload)).toBe(0);

  // ---- Finalized history is closed: the only way forward is a new version ------------------
  const rejected = await app.inject({
    method: 'POST',
    url: `/estimate-versions/${V1_ID}/lines`,
    payload: { lines: [{ lineId: 'g9', pricebookCode: '010101', quantity: '1', unit: 'm2' }] },
  });
  expect(rejected.statusCode).toBe(409);

  // ---- v2: the revision --------------------------------------------------------------------
  const v2 = await app.inject({
    method: 'POST',
    url: `/estimates/${ESTIMATE_ID}/versions`,
    payload: { buildingId: BUILDING_ID },
  });
  expect(v2.statusCode).toBe(201);
  expect(v2.json<{ versionNumber: number; status: string; lines: unknown[] }>()).toMatchObject({
    versionNumber: 2,
    status: 'draft',
  });

  const addedV2 = await app.inject({
    method: 'POST',
    url: `/estimate-versions/${V2_ID}/lines`,
    payload: { lines: GOLDEN_V2_LINES },
  });
  expect(addedV2.statusCode).toBe(200);
  expect(addedV2.json<{ lines: unknown[] }>().lines).toHaveLength(8);

  const calcV2 = await app.inject({
    method: 'POST',
    url: `/estimate-versions/${V2_ID}/calculate`,
    payload: GOLDEN_COEFFICIENTS,
  });
  expect(calcV2.statusCode).toBe(200);
  const calculationV2 = calcV2.json<CalculationBody>();
  expect(calculationV2.rollup.amount).toBe(GOLDEN_V2_EXPECTED.base);
  expect(calculationV2.s4Result.finalEstimate).toBe(GOLDEN_V2_EXPECTED.finalEstimate);
  const outputOf = (stage: string): string | null | undefined =>
    calculationV2.s4Result.stages.find((s) => s.stage === stage)?.output;
  expect(outputOf('base-subtotal')).toBe(GOLDEN_V2_EXPECTED.base);
  expect(outputOf('floor')).toBe(GOLDEN_V2_EXPECTED.afterFloor);
  expect(outputOf('overhead')).toBe(GOLDEN_V2_EXPECTED.afterOverhead);
  expect(outputOf('regional')).toBe(GOLDEN_V2_EXPECTED.afterRegional);
  expect(outputOf('site-setup')).toBe(GOLDEN_V2_EXPECTED.finalEstimate);

  // deterministic: the same draft calculation repeats byte-identically
  const calcV2Again = await app.inject({
    method: 'POST',
    url: `/estimate-versions/${V2_ID}/calculate`,
    payload: GOLDEN_COEFFICIENTS,
  });
  expect(canonicalJson(calcV2Again.json<unknown>())).toBe(canonicalJson(calculationV2));

  // ---- v1 isolation: history is byte-unchanged by everything v2 did ------------------------
  // (The reloaded bundle's estimate aggregate now also carries the v2 sibling — that is
  // the documented aggregate shape — so v1's OWN history is compared piece by piece.)
  const v1After = await app.inject({ method: 'GET', url: `/estimate-versions/${V1_ID}` });
  const bundleAfter = v1After.json<FinalizedEstimate>();
  expect(v1After.statusCode).toBe(200);
  expect(bundleAfter.finalizedAt).toBe(bundle.finalizedAt);
  expect(canonicalJson(bundleAfter.calculation)).toBe(canonicalJson(bundle.calculation));
  const v1VersionAfter = bundleAfter.estimate.versions.find((v) => v.versionId === V1_ID);
  const v1VersionAtFinalize = bundle.estimate.versions.find((v) => v.versionId === V1_ID);
  expect(canonicalJson(v1VersionAfter)).toBe(canonicalJson(v1VersionAtFinalize));
  expect(bundleAfter.estimate.versions.map((v) => v.versionId)).toEqual([V1_ID, V2_ID]);
  const pdfAfter = await app.inject({
    method: 'GET',
    url: `/estimate-versions/${V1_ID}/render/pdf`,
  });
  expect(Buffer.compare(pdfAfter.rawPayload, pdf.rawPayload)).toBe(0);

  // ---- The project now lists one estimate carrying both versions ---------------------------
  const list = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/estimates` });
  expect(list.statusCode).toBe(200);
  const listed = list.json<Array<{ estimateId: string; versions: Array<{ status: string }> }>>();
  expect(listed).toHaveLength(1);
  expect(listed[0]?.estimateId).toBe(ESTIMATE_ID);
  expect(listed[0]?.versions.map((version) => version.status)).toEqual(['finalized', 'draft']);
}

describe('production estimate workflow (HTTP → Fastify → Zod → projects → db)', () => {
  it('real-server availability report (never counted as server verification when absent)', () => {
    if (SMOKE === undefined) {
      console.warn(
        '[WORKFLOW REAL-SERVER] NOT RUN — environment not available: COSTGENIUS_SMOKE_DATABASE_URL is not set. ' +
          'The real-server workflow run is NOT VERIFIED in this environment.',
      );
    }
    expect(true).toBe(true);
  });

  it('runs the full golden workflow against in-process PostgreSQL (PGlite)', async () => {
    const app = await buildTestServer();
    await runProductionWorkflow(app);
    await app.close();
  });
});

describe.skipIf(SMOKE === undefined)('production workflow on a REAL PostgreSQL server', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createDbPool>;

  beforeAll(async () => {
    // The env-gated URL names a DISPOSABLE dedicated verification database (documented
    // contract): reset ALL current application tables so the deterministic ids start
    // clean — children before parents. (P8-A §12 hygiene repair of the P7-S3 defect
    // class: this leg previously dropped only the five estimate-family tables, so a
    // re-run on a used database failed with 42P07 `finalized_takeoffs already exists`;
    // the list now covers the nine domain tables plus the three governance tables of
    // migration 0002. Test semantics are otherwise unchanged. P8-B S3 extends the
    // same repair to the S1 world: the 13th table `pricebook_editions` of migration
    // 0004 AND its trigger functions — without them, a re-run on a used database
    // fails 42P07 `pricebook_editions already exists` / 42723, because functions
    // survive the table drop.)
    pool = createDbPool(SMOKE as string);
    await pool.query(
      'DROP TABLE IF EXISTS takeoff_lines, takeoff_sheets, finalized_takeoffs, takeoff_documents, boq_lines, finalized_estimates, estimate_versions, pricebook_editions, estimates, sessions, audit_events, users, projects CASCADE',
    );
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query(
      'DROP FUNCTION IF EXISTS pricebook_editions_guard_immutable_columns(), pricebook_editions_forbid_delete(), estimate_versions_guard_edition_binding(), estimate_versions_stamp_active_edition() CASCADE',
    );
    await pool.end();

    pool = createDbPool(SMOKE as string);
    const db: DbClient = createDb(pool);
    await migrateDatabase(db, MIGRATIONS_FOLDER);
    const userStore = new DrizzleUserRepository(db);
    const sessionStore = new DrizzleSessionRepository(db);
    const poolBound = bindRepositories(db);
    const deps: ApiDependencies = {
      repositories: {
        projects: poolBound.projects,
        estimates: poolBound.estimates,
        finalized: poolBound.finalized,
        takeoffDocuments: poolBound.takeoffDocuments,
        finalizedTakeoffs: poolBound.finalizedTakeoffs,
        editions: poolBound.editions,
      },
      governance: { users: userStore, sessions: sessionStore, audit: poolBound.audit },
      clock: () => FIXED_INSTANT,
      transact: transactOver(db),
    };
    // P8-A S1: the real-server leg runs behind the real authentication gate too
    // (bootstrap admin + real login; the session cookie rides every inject call).
    await ensureBootstrapAdmin(
      { users: userStore, sessions: sessionStore, clock: deps.clock },
      {
        bootstrapAdminUsername: TEST_ADMIN.username,
        bootstrapAdminPassword: TEST_ADMIN.password,
      },
    );
    // P8-B S3: the golden workflow creates a version, and version creation binds the
    // ACTIVE edition from the persisted registry (D-PB-1 = B) — the same first-boot
    // seed step production runs after migrations.
    await seedPricebookEdition({
      users: userStore,
      editions: deps.repositories.editions,
      transact: deps.transact,
      clock: deps.clock,
    });
    app = (await attachAuthenticatedServer(createApiServer(deps))).app;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('runs the same golden workflow over node-postgres → the real server', async () => {
    await runProductionWorkflow(app);
  });
});
