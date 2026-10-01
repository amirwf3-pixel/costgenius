import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { UserRole, UserStore } from '@costgenius/projects';
import { type DbClient } from '@costgenius/db';
import { bindRepositories, transactOver } from '../src/composition.js';
import {
  createApiServer,
  ensureBootstrapAdmin,
  seedPricebookEdition,
  type ApiDependencies,
} from '../src/index.js';
import { hashPassword } from '../src/auth.js';

// The repository factory and the transaction capability are the CANONICAL ones from
// the production composition root — tests re-export them so the audit wiring under
// test is exactly the wiring production runs (never a parallel implementation).
export { bindRepositories, transactOver };

/** One audit_events row as persisted (the S3 tests read the table directly — there is no read API by design). */
export interface AuditEventRow {
  readonly eventId: string;
  readonly at: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly projectId: string | null;
  readonly details: unknown;
}

/** Reads every audit event in deterministic (at, eventId) order — test/ops inspection only. */
export async function readAuditEvents(pg: PGlite): Promise<readonly AuditEventRow[]> {
  const result = await pg.sql`select event_id as "eventId", at, actor_user_id as "actorUserId",
    action, resource_type as "resourceType", resource_id as "resourceId",
    project_id as "projectId", details from audit_events order by at, event_id`;
  return result.rows as readonly AuditEventRow[];
}

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
    governance: {
      users: poolBound.users,
      sessions: poolBound.sessions,
      audit: poolBound.audit,
    },
    clock: () => FIXED_INSTANT,
    transact: transactOver(db),
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
 * P8-B S2 — a SYNTHETIC staged-import document for the lifecycle routes (import /
 * activate / arrange fixtures). Passes the SAME `validateStagedImport` gate as every
 * edition: the first row is the verified 010101 anchor with its exact pinned values,
 * the second carries a tag-unique price so every file's contentHash is unique
 * (content-addressable identity — two files must never collide). The edition id is
 * deliberately NOT the official 1404 id (the verified-subset floor applies only to
 * it). Development/test ONLY — no real edition data.
 */
export function syntheticStagedFile(tag: string): {
  formatVersion: '1';
  kind: 'staged-import';
  edition: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
} {
  const safeTag = tag.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return {
    formatVersion: '1',
    kind: 'staged-import',
    edition: {
      id: `ir-14mx-abniye-${safeTag}`,
      title: 'فهرست آزمونی رشته ابنیه',
      organization: 'سازمان برنامه و بودجه کشور',
      year: '1410',
      notificationNumber: null,
      notificationDate: null,
      sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
    },
    rows: [
      {
        code: '010101',
        chapter: 'chapter-1',
        group: '1',
        description: 'خاکبرداری در زمین‌های نرم',
        unit: { label: 'مترمربع', code: 'm2' },
        basePrice: '2890',
        status: 'VERIFIED_SPEC_ONLY',
        sourceRef: {
          sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
          edition: '1404',
          printedPage: '11',
          section: 'Chapter 1, Group 1',
          sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
        },
      },
      {
        code: `01900${String(safeTag.length % 10)}`,
        chapter: 'chapter-19',
        group: '1',
        description: `قلم آزمون ${safeTag}`,
        unit: { label: 'مترمربع', code: 'm2' },
        basePrice: String(1000 + ((safeTag.length * 7) % 900)),
        status: 'VERIFIED_SPEC_ONLY',
        sourceRef: {
          sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
          edition: '1404',
          printedPage: '99',
          section: 'Chapter 19, Group 1',
          sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
        },
      },
    ],
  };
}

/**
 * P8-B S3 — a synthetic staged-import document whose DATASET is deliberately
 * distinguishable from the official 1404 edition (CG-IR-PB@0.2.0 §12/§21): every
 * row carries a distinct `sourceRef.edition` label (default '1410', so a version
 * bound to this edition gets a distinct year label), one row shares a code with the
 * official edition at a DIFFERENT price (010102 — the per-version resolution proof),
 * and one code exists ONLY here (019999 — the unknown-in-1404 proof). Passes the same
 * `validateStagedImport` gate (the 010101 anchor keeps its exact pinned values).
 * Development/test ONLY — no real edition data.
 */
export function syntheticEditionStagedFile(
  tag: string,
  editionLabel = '1410',
): {
  formatVersion: '1';
  kind: 'staged-import';
  edition: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
} {
  const safeTag = tag.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const sourceRef = (printedPage: string, section: string): Record<string, unknown> => ({
    sourceDocument: `فهرست آزمونی رشته ابنیه ${editionLabel}`,
    edition: editionLabel,
    printedPage,
    section,
    sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
  });
  return {
    formatVersion: '1',
    kind: 'staged-import',
    edition: {
      id: `ir-${editionLabel}-abniye-${safeTag}`,
      title: `فهرست آزمونی ${editionLabel}`,
      organization: 'سازمان برنامه و بودجه کشور',
      year: editionLabel,
      notificationNumber: null,
      notificationDate: null,
      sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
    },
    rows: [
      {
        // the verified anchor — exact pinned values (the gate enforces them); the
        // row shape mirrors the official staged file exactly (deps/notes arrays
        // included — line binding copies them verbatim)
        code: '010101',
        chapter: 'chapter-1',
        group: '1',
        description: 'خاکبرداری در زمین‌های نرم',
        unit: { label: 'مترمربع', code: 'm2' },
        basePrice: '2890',
        status: 'VERIFIED_SPEC_ONLY',
        sourceRef: sourceRef('11', 'Chapter 1, Group 1'),
        externalDependencies: [],
        notes: [],
      },
      {
        // shared with the official 1404 edition (010301 = 3065000 there) at a
        // DIFFERENT price — proves which edition's dataset priced the line
        code: '010301',
        chapter: 'chapter-3',
        group: '1',
        description: `تخریب آزمونی ${safeTag}`,
        unit: { label: 'مترمربع', code: 'm2' },
        basePrice: '7777',
        status: 'VERIFIED_SPEC_ONLY',
        sourceRef: sourceRef('31', 'Chapter 3, Group 1'),
        externalDependencies: [],
        notes: [],
      },
      {
        // exists ONLY in this edition — unknown in the official 1404 dataset
        code: '019999',
        chapter: 'chapter-19',
        group: '1',
        description: `قلم اختصاصی ${safeTag}`,
        unit: { label: 'مترمربع', code: 'm2' },
        basePrice: '555',
        status: 'VERIFIED_SPEC_ONLY',
        sourceRef: sourceRef('99', 'Chapter 19, Group 1'),
        externalDependencies: [],
        notes: [],
      },
    ],
  };
}

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
  await seedPricebookEdition({
    users: deps.governance.users,
    editions: deps.repositories.editions,
    transact: deps.transact,
    clock: deps.clock,
  });
  return attachAuthenticatedServer(createApiServer(deps));
}

/**
 * P8-A S2 role fixtures: deterministic TEST credentials for one real DB-backed user
 * per NON-admin role (CG-GOV §2.1). Created through the REAL persistence path
 * (scrypt hash + UserStore.save — the same thing POST /users does); tests then log
 * in through the REAL /auth/login so every probe rides a genuine session cookie.
 * Development/test ONLY — never production credentials.
 */
export const TEST_ROLE_USERS = {
  estimator: { username: 'est-user', password: 'estimator-password-123', role: 'estimator' },
  reviewer: { username: 'rev-user', password: 'reviewer-password-123', role: 'reviewer' },
  viewer: { username: 'view-user', password: 'viewer-password-123', role: 'viewer' },
  data_steward: {
    username: 'steward-user',
    password: 'steward-password-123',
    role: 'data_steward',
  },
} as const;

export type TestRole = keyof typeof TEST_ROLE_USERS;

/** Creates the role users if absent (idempotent — safe on a shared fixture server). */
export async function ensureTestRoleUsers(users: UserStore): Promise<void> {
  for (const spec of Object.values(TEST_ROLE_USERS)) {
    if ((await users.findByUsername(spec.username)) === undefined) {
      await users.save({
        userId: randomUUID(),
        username: spec.username,
        passwordHash: await hashPassword(spec.password),
        role: spec.role,
        isActive: true,
        createdAt: FIXED_INSTANT,
      });
    }
  }
}

/** A REAL login through POST /auth/login → the cg_session cookie value. */
export async function loginCookie(
  app: ReturnType<typeof createApiServer>,
  username: string,
  password: string,
): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username, password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`login failed for "${username}": ${String(login.statusCode)}`);
  }
  const setCookie = login.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = first === undefined ? undefined : first.split(';')[0];
  if (cookie === undefined) throw new Error(`login for "${username}" returned no cookie`);
  return cookie;
}

export interface RoleAwareServer {
  readonly app: ReturnType<typeof createApiServer>;
  /** raw inject with NO cookie (the anonymous probes). */
  readonly rawInject: ReturnType<typeof createApiServer>['inject'];
  /** A REAL session cookie for the role (org_admin = the bootstrap admin). Cached. */
  readonly cookieFor: (role: UserRole) => Promise<string>;
}

/**
 * The P8-A S2 fixture: bootstrapped org_admin + one real user per non-admin role,
 * every cookie obtained through a REAL login. Nothing is mocked at the route layer.
 */
export async function buildRoleAwareServer(): Promise<RoleAwareServer> {
  const { deps } = await buildPgliteDependencies();
  await ensureBootstrapAdmin(
    { users: deps.governance.users, sessions: deps.governance.sessions, clock: deps.clock },
    { bootstrapAdminUsername: TEST_ADMIN.username, bootstrapAdminPassword: TEST_ADMIN.password },
  );
  await seedPricebookEdition({
    users: deps.governance.users,
    editions: deps.repositories.editions,
    transact: deps.transact,
    clock: deps.clock,
  });
  await ensureTestRoleUsers(deps.governance.users);
  const app = createApiServer(deps);
  const cache = new Map<string, string>();
  const cookieFor = async (role: UserRole): Promise<string> => {
    const cached = cache.get(role);
    if (cached !== undefined) return cached;
    const cookie =
      role === 'org_admin'
        ? await loginCookie(app, TEST_ADMIN.username, TEST_ADMIN.password)
        : await loginCookie(app, TEST_ROLE_USERS[role].username, TEST_ROLE_USERS[role].password);
    cache.set(role, cookie);
    return cookie;
  };
  return { app, rawInject: app.inject.bind(app), cookieFor };
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

export interface AuditAwareServer {
  readonly app: ReturnType<typeof createApiServer>;
  /** raw inject with NO cookie (the anonymous probes). */
  readonly rawInject: ReturnType<typeof createApiServer>['inject'];
  /** The admin (org_admin) session cookie. */
  readonly cookie: string;
  /** A REAL session cookie for any of the five roles (cached per role). */
  readonly cookieFor: (role: UserRole) => Promise<string>;
  /** The underlying PGlite — direct table inspection for the S3 audit assertions. */
  readonly pg: PGlite;
  /** Every persisted audit event, deterministic (at, eventId) order. */
  readonly auditEvents: () => Promise<readonly AuditEventRow[]>;
  /** The wired dependencies (for the transactional unit-of-work proofs). */
  readonly deps: ApiDependencies;
}

/**
 * The P8-A S3 fixture: the REAL PGlite dependency stack (migrations, repositories,
 * the transactional audit wiring) + bootstrap admin + one real user per role, with
 * direct `audit_events` table inspection for the §4/§9 assertions.
 */
export async function buildAuditAwareServer(): Promise<AuditAwareServer> {
  const { deps, pg } = await buildPgliteDependencies();
  await ensureBootstrapAdmin(
    { users: deps.governance.users, sessions: deps.governance.sessions, clock: deps.clock },
    { bootstrapAdminUsername: TEST_ADMIN.username, bootstrapAdminPassword: TEST_ADMIN.password },
  );
  await seedPricebookEdition({
    users: deps.governance.users,
    editions: deps.repositories.editions,
    transact: deps.transact,
    clock: deps.clock,
  });
  await ensureTestRoleUsers(deps.governance.users);
  const app = createApiServer(deps);
  const cache = new Map<string, string>();
  const cookieFor = async (role: UserRole): Promise<string> => {
    const cached = cache.get(role);
    if (cached !== undefined) return cached;
    const cookie =
      role === 'org_admin'
        ? await loginCookie(app, TEST_ADMIN.username, TEST_ADMIN.password)
        : await loginCookie(app, TEST_ROLE_USERS[role].username, TEST_ROLE_USERS[role].password);
    cache.set(role, cookie);
    return cookie;
  };
  return {
    app,
    rawInject: app.inject.bind(app),
    cookie: await cookieFor('org_admin'),
    cookieFor,
    pg,
    auditEvents: () => readAuditEvents(pg),
    deps,
  };
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
  await seedPricebookEdition({
    users: deps.governance.users,
    editions: deps.repositories.editions,
    transact: deps.transact,
    clock: deps.clock,
  });
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
