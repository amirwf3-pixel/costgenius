/**
 * E2E-only backend (Phase 19): the REAL API (`createApiServer`: Fastify + Zod +
 * projects + Drizzle) on PostgreSQL-in-process (PGlite) with the REAL Drizzle
 * migrations and the official published 1404 dataset — the same stack the workflow
 * integration test uses, started as a managed process by the Playwright global
 * setup on a DETERMINISTIC port (default 3101) with NO seed data, so browser specs
 * create their own state through the real UI/API.
 *
 * NOT a production deployment — production runs `apps/api` against a real
 * PostgreSQL server (see apps/api/README).
 *
 * Run: E2E_PORT=3101 node --import tsx scripts/e2e-backend.ts
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  DrizzleAuditEventRepository,
  DrizzleEstimateRepository,
  DrizzleFinalizedEstimateRepository,
  DrizzleFinalizedTakeoffRepository,
  DrizzleProjectRepository,
  DrizzleSessionRepository,
  DrizzleTakeoffDocumentRepository,
  DrizzleUserRepository,
  type DbClient,
} from '@costgenius/db';
import {
  createApiServer,
  ensureBootstrapAdmin,
  loadPublishedDataset,
  transactOver,
} from '@costgenius/api';

const PORT = Number(process.env['E2E_PORT'] ?? 3101);

const pg = new PGlite();
const raw = drizzle(pg);
await migrate(raw, {
  migrationsFolder: new URL('../../../packages/db/migrations', import.meta.url).pathname,
});
const db = raw as unknown as DbClient;

const userStore = new DrizzleUserRepository(db);
const sessionStore = new DrizzleSessionRepository(db);
// P8-A S1 (CG-GOV §1.5): bootstrap exactly one admin on the empty users table, from
// the environment (the Playwright global setup passes deterministic E2E credentials).
await ensureBootstrapAdmin(
  { users: userStore, sessions: sessionStore, clock: () => new Date().toISOString() },
  {
    bootstrapAdminUsername: process.env['CG_BOOTSTRAP_ADMIN_USERNAME'],
    bootstrapAdminPassword: process.env['CG_BOOTSTRAP_ADMIN_PASSWORD'],
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
  governance: {
    users: userStore,
    sessions: sessionStore,
    audit: new DrizzleAuditEventRepository(db),
  },
  dataset: loadPublishedDataset(),
  clock: () => new Date().toISOString(),
  // S3: the audited mutations run on ONE transaction (the canonical factory).
  transact: transactOver(db),
});

await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`[e2e-backend] real API on http://127.0.0.1:${String(PORT)} (PGlite, fresh, no seed)`);

const shutdown = (): void => {
  void app
    .close()
    .then(() => pg.close())
    .finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
