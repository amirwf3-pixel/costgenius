import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  DrizzleEstimateRepository,
  DrizzleFinalizedEstimateRepository,
  DrizzleFinalizedTakeoffRepository,
  DrizzleProjectRepository,
  DrizzleSessionRepository,
  DrizzleTakeoffDocumentRepository,
  DrizzleUserRepository,
  type DbClient,
} from '@costgenius/db';
import { createApiServer, ensureBootstrapAdmin, type ApiDependencies } from '../src/index.js';
import { loadPublishedDataset } from '../src/dataset.js';

/**
 * Builds the API server wired to a REAL in-process PostgreSQL (PGlite — the same engine
 * the db package's integration suite uses) with the actual Drizzle migrations applied,
 * the official 1404 dataset, and a FIXED clock so every response is deterministic.
 * The repositories injected here are the production Drizzle implementations — the same
 * code path a PostgreSQL server takes via node-postgres.
 */
async function buildPgliteDependencies(): Promise<{
  deps: ApiDependencies;
  pg: PGlite;
}> {
  const pg = new PGlite();
  const raw = drizzle(pg);
  await migrate(raw, {
    migrationsFolder: new URL('../../../packages/db/migrations', import.meta.url).pathname,
  });
  const db = raw as unknown as DbClient;
  const deps: ApiDependencies = {
    repositories: {
      projects: new DrizzleProjectRepository(db),
      estimates: new DrizzleEstimateRepository(db),
      finalized: new DrizzleFinalizedEstimateRepository(db),
      takeoffDocuments: new DrizzleTakeoffDocumentRepository(db),
      finalizedTakeoffs: new DrizzleFinalizedTakeoffRepository(db),
    },
    governance: {
      users: new DrizzleUserRepository(db),
      sessions: new DrizzleSessionRepository(db),
    },
    dataset: loadPublishedDataset(),
    clock: () => FIXED_INSTANT,
  };
  return { deps, pg };
}

/**
 * Deterministic bootstrap credentials of the test admin (P8-A S1, CG-GOV §1.5).
 * Development/test ONLY — never a production credential; the password lives in this
 * test helper precisely so no real secret is ever committed.
 */
export const TEST_ADMIN = {
  username: 'admin',
  password: 'test-password-123',
} as const;

/**
 * P8-A S1 test-fixture migration: every existing API test assumes authenticated
 * access, so each test server gets (a) the bootstrap admin created through the REAL
 * `ensureBootstrapAdmin` startup path, and (b) a REAL login through `POST /auth/login`
 * whose session cookie is then attached to every `app.inject` call unless the caller
 * provides its own cookie. Nothing is bypassed: the real session middleware validates
 * the cookie on EVERY request. Tests that want NO cookie (the 401 cases) pass a
 * `cookie: ''` header or use `rawInject`.
 */
async function attachAuthenticatedSession(
  app: ReturnType<typeof createApiServer>,
): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: TEST_ADMIN.username, password: TEST_ADMIN.password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`test-fixture login failed: ${String(login.statusCode)} ${login.body}`);
  }
  const setCookie = login.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = first === undefined ? undefined : first.split(';')[0];
  if (cookie === undefined) throw new Error('test-fixture login returned no session cookie');
  return cookie;
}

export interface AuthenticatedTestServer {
  readonly app: ReturnType<typeof createApiServer>;
  /** The live admin session cookie (`cg_session=…`) used by the wrapped `inject`. */
  readonly cookie: string;
  /** The raw injector with NO cookie attached (the 401/unauthenticated cases). */
  readonly rawInject: ReturnType<typeof createApiServer>['inject'];
}

export async function buildTestServer(): Promise<AuthenticatedTestServer['app']> {
  const { app } = await buildAuthenticatedTestServer();
  return app;
}

/** The full P8-A S1 fixture: bootstrapped admin + real login + cookie-attached inject. */
export async function buildAuthenticatedTestServer(): Promise<AuthenticatedTestServer> {
  const { deps } = await buildPgliteDependencies();
  await ensureBootstrapAdmin(
    { users: deps.governance.users, sessions: deps.governance.sessions, clock: deps.clock },
    { bootstrapAdminUsername: TEST_ADMIN.username, bootstrapAdminPassword: TEST_ADMIN.password },
  );
  return attachAuthenticatedServer(createApiServer(deps));
}

/** Wraps an already-bootstrapped server: real login + cookie-attached inject. */
export async function attachAuthenticatedServer(
  app: ReturnType<typeof createApiServer>,
): Promise<AuthenticatedTestServer> {
  const cookie = await attachAuthenticatedSession(app);
  type RawInject = typeof app.inject;
  const rawInject: RawInject = app.inject.bind(app);
  const authedInject = ((opts?: string | Record<string, unknown>) => {
    const merged: Record<string, unknown> =
      typeof opts === 'string' ? { url: opts } : { ...(opts ?? {}) };
    const headers: Record<string, string> = {
      ...((merged['headers'] as Record<string, string> | undefined) ?? {}),
    };
    // only attach when the caller did not bring its own cookie (empty string = no auth)
    if (headers['cookie'] === undefined && headers['Cookie'] === undefined) {
      headers['cookie'] = cookie;
    }
    merged['headers'] = headers;
    return rawInject(merged as never);
  }) as RawInject;
  (app as { inject: RawInject }).inject = authedInject;
  return { app, cookie, rawInject };
}

export interface DatabaseBackedServer {
  readonly app: ReturnType<typeof createApiServer>;
  /** Closes the underlying database — simulates the database going away after startup. */
  readonly closeDatabase: () => Promise<void>;
}

/** Like buildTestServer, but exposes a handle that shuts the database down mid-test. */
export async function buildServerWithClosableDatabase(): Promise<DatabaseBackedServer> {
  const { deps, pg } = await buildPgliteDependencies();
  await ensureBootstrapAdmin(
    { users: deps.governance.users, sessions: deps.governance.sessions, clock: deps.clock },
    { bootstrapAdminUsername: TEST_ADMIN.username, bootstrapAdminPassword: TEST_ADMIN.password },
  );
  const { app } = await attachAuthenticatedServer(createApiServer(deps));
  return { app, closeDatabase: () => pg.close() };
}

/** Fixed, deterministic identities and instants (UUID shape per the domain id module). */
export const ORGANIZATION_ID = '11111111-2222-4333-8444-555555555555';
export const PROJECT_ID = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
export const ESTIMATE_ID = '12345678-90ab-4cde-9f01-234567890abc';
export const VERSION_ID = `${ESTIMATE_ID}-v1`;
export const BUILDING_ID = 'building-main';
export const FIXED_INSTANT = '2026-01-01T00:00:00Z';

/**
 * The COMPLETE vertical-slice lines (all real 1404 rows, exact units) — the same fixture
 * as the Phase 13/14 suites: leading zero (010101), negative prices (010517, 270320,
 * 270403), zero quantity (240102), compound units (280101 ton_km, 280501
 * ton_nautical_mile). Base subtotal 38,147,600 Rial.
 */
export const COMPLETE_LINES = [
  { lineId: 'l1', pricebookCode: '010101', quantity: '1000', unit: 'm2' },
  { lineId: 'l2', pricebookCode: '010517', quantity: '5', unit: 'm2' },
  { lineId: 'l3', pricebookCode: '240102', quantity: '0', unit: 'm2' },
  { lineId: 'l4', pricebookCode: '270101', quantity: '120', unit: 'kg' },
  { lineId: 'l5', pricebookCode: '270320', quantity: '10', unit: 'm3' },
  { lineId: 'l6', pricebookCode: '270403', quantity: '2', unit: 'm3' },
  { lineId: 'l7', pricebookCode: '280101', quantity: '500', unit: 'ton_km' },
  { lineId: 'l8', pricebookCode: '280501', quantity: '3', unit: 'ton_nautical_mile' },
] as const;

/** Blocked lines: deduction 220925, blank 020105, star-item 090320, Appendix-5 991001. */
export const BLOCKED_LINES = [
  { lineId: 'b1', pricebookCode: '220925', quantity: '40', unit: 'm2' },
  { lineId: 'b2', pricebookCode: '020105', quantity: '25', unit: 'm3' },
  { lineId: 'b3', pricebookCode: '090320', quantity: '80', unit: 'kg' },
  { lineId: 'b4', pricebookCode: '991001', quantity: '600', unit: 'm2_month' },
] as const;

/** Golden S4 coefficient inputs as HTTP JSON (same attested values as Phase 13/14). */
export const GOLDEN_COEFFICIENTS = {
  floor: {
    buildingId: BUILDING_ID,
    groundFloorArea: '600',
    firstBasementArea: '400',
    aboveGroundFloors: [...Array.from({ length: 10 }, () => ({ area: '500' })), { area: '400' }],
    belowGroundFloors: Array.from({ length: 3 }, () => ({ area: '400' })),
    totalBuildingFloorArea: '7600',
  },
  overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
  regional: { parts: [{ regionId: 'r-test', coefficient: '1.1', executionCost: '51828473.788' }] },
  siteSetup: { lumpSumAmount: '12000000' },
} as const;

/** The exact S4 chain of the COMPLETE fixture (P=1.0451, overhead 1.30, R=1.1, +12,000,000). */
export const COMPLETE_S4_EXPECTED = {
  base: '38147600',
  afterFloor: '39868056.76',
  afterOverhead: '51828473.788',
  afterRegional: '57011321.1668',
  finalEstimate: '69011321.1668',
} as const;

/** Creates project + estimate + version through the API and returns the inject client. */
export async function seedVerticalSlice(app: ReturnType<typeof createApiServer>): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/projects',
    payload: {
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      title: 'برآورد اجرایی ساختمان اداری',
      metadata: { location: 'Tehran' },
    },
  });
  await app.inject({
    method: 'POST',
    url: `/projects/${PROJECT_ID}/estimates`,
    payload: { estimateId: ESTIMATE_ID, title: 'برآورد اولیه' },
  });
  await app.inject({
    method: 'POST',
    url: `/estimates/${ESTIMATE_ID}/versions`,
    payload: { buildingId: BUILDING_ID },
  });
}
