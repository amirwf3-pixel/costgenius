/**
 * DEVELOPMENT-ONLY backend for the web dev server (NOT a production deployment).
 *
 * It boots the exact stack the workflow integration test exercises: the REAL API
 * (`createApiServer`: Fastify + Zod + projects + Drizzle) on PostgreSQL-in-process
 * (PGlite) with the REAL Drizzle migrations and the official published 1404 dataset.
 * Nothing is mocked; PGlite is used only because this dev process has no external
 * PostgreSQL — production runs `apps/api` against a real server (see apps/api/README).
 *
 * On boot it seeds one demo project through the real HTTP API (real pricebook codes,
 * real workflow): project → estimate → v1 with the five golden 1404 lines, left in
 * DRAFT so you can calculate, review and finalize it yourself in the UI.
 *
 * Run:  npx tsx apps/web/scripts/dev-backend.mts   (listens on 127.0.0.1:3001)
 */
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
import { createApiServer, ensureBootstrapAdmin, loadPublishedDataset } from '@costgenius/api';

const PORT = 3001;

const pg = new PGlite();
const raw = drizzle(pg);
await migrate(raw, {
  migrationsFolder: new URL('../../../packages/db/migrations', import.meta.url).pathname,
});
const db = raw as unknown as DbClient;

const userStore = new DrizzleUserRepository(db);
const sessionStore = new DrizzleSessionRepository(db);

// P8-A S1: DEVELOPMENT-ONLY bootstrap credentials (never a production secret — this
// script exists to run a local dev stack). Override via the standard env vars.
const DEV_ADMIN_USERNAME = process.env['CG_BOOTSTRAP_ADMIN_USERNAME'] ?? 'admin';
const DEV_ADMIN_PASSWORD = process.env['CG_BOOTSTRAP_ADMIN_PASSWORD'] ?? 'costgenius-dev';
await ensureBootstrapAdmin(
  { users: userStore, sessions: sessionStore, clock: () => new Date().toISOString() },
  {
    bootstrapAdminUsername: DEV_ADMIN_USERNAME,
    bootstrapAdminPassword: DEV_ADMIN_PASSWORD,
  },
);

const app = createApiServer({
  repositories: {
    projects: new DrizzleProjectRepository(db),
    estimates: new DrizzleEstimateRepository(db),
    finalized: new DrizzleFinalizedEstimateRepository(db),
    takeoffDocuments: new DrizzleTakeoffDocumentRepository(db),
    finalizedTakeoffs: new DrizzleFinalizedTakeoffRepository(db),
  },
  governance: { users: userStore, sessions: sessionStore },
  dataset: loadPublishedDataset(),
  // dev process: real wall clock (the production API injects its clock; see §clock)
  clock: () => new Date().toISOString(),
});

await app.listen({ port: PORT, host: '127.0.0.1' });
const base = `http://127.0.0.1:${String(PORT)}`;

// ---- seed the demo story through the real API (no direct DB writes) ----------------------
const projectId = crypto.randomUUID();
const estimateId = crypto.randomUUID();
const versionId = crypto.randomUUID();

// P8-A S1: log in through the REAL login route and attach the session cookie —
// the demo seeding is an authenticated client, exactly like the UI.
const loginResponse = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: DEV_ADMIN_USERNAME, password: DEV_ADMIN_PASSWORD }),
});
if (!loginResponse.ok) throw new Error(`dev login failed: ${String(loginResponse.status)}`);
const devCookie = loginResponse.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', cookie: devCookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${String(response.status)} ${await response.text()}`);
  }
  return response.json();
}

await call('POST', '/projects', {
  projectId,
  title: 'پروژه نمونه — دموی فاز ۱۸',
  metadata: { note: 'created by apps/web/scripts/dev-backend.mts (development seed)' },
});
await call('POST', `/projects/${projectId}/estimates`, { estimateId, title: 'برآورد اولیه' });
await call('POST', `/estimates/${estimateId}/versions`, { buildingId: 'b-1', versionId });
// the five golden 1404 lines (same codes the integration test pins):
await call('POST', `/estimate-versions/${versionId}/lines`, {
  lines: [
    { lineId: crypto.randomUUID(), pricebookCode: '010101', quantity: '1000', unit: 'm2' },
    { lineId: crypto.randomUUID(), pricebookCode: '270320', quantity: '120.5', unit: 'm3' },
    { lineId: crypto.randomUUID(), pricebookCode: '270403', quantity: '80', unit: 'm3' },
    { lineId: crypto.randomUUID(), pricebookCode: '220925', quantity: '300', unit: 'm2' },
    { lineId: crypto.randomUUID(), pricebookCode: '090320', quantity: '45', unit: 'kg' },
  ],
});

console.log(`[dev-backend] real API on ${base} (PGlite in-process, official 1404 dataset)`);
console.log(
  `[dev-backend] DEV login — username: ${DEV_ADMIN_USERNAME} (password: the dev default or your CG_BOOTSTRAP_ADMIN_PASSWORD; dev-only, never a production credential)`,
);
console.log('[dev-backend] seeded demo project (DRAFT v1, five golden lines) via the real API');
console.log('[dev-backend] start the UI with:  pnpm --filter @costgenius/web dev');

const shutdown = (): void => {
  void app
    .close()
    .then(() => pg.close())
    .finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
