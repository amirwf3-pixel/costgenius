/**
 * @costgenius/api — the minimal production API (Phase 15).
 *
 * HTTP → Zod → `@costgenius/projects` (application layer) → repository contracts →
 * `@costgenius/db` (Drizzle) → node-postgres → PostgreSQL. The server is pure
 * orchestration: no business calculation, no pricebook lookup, no direct database access.
 *
 * Programmatic use (tests/tools):
 *   `createApiServer(deps)` — inject repositories, dataset and clock.
 *
 * Production entry point:
 *   `main()` reads DATABASE_URL (+ optional PORT/HOST/DATASET_PATH), applies the Drizzle
 *   migrations, builds the PostgreSQL-backed repositories and listens. It is exported,
 *   not auto-executed — the deployment decides when to start the process.
 */
export {
  createApiServer,
  type ApiDependencies,
  XLSX_CONTENT_TYPE,
  PDF_CONTENT_TYPE,
} from './server.js';
export {
  bindRepositories,
  buildDependencies,
  transactOver,
  type ComposedApi,
} from './composition.js';
export { readApiConfig, type ApiConfig } from './config.js';
export { DEFAULT_DATASET_PATH, loadPublishedDataset } from './dataset.js';
export { seedPricebookEdition, type PricebookSeedDependencies } from './pricebook-seed.js';
export {
  activatePricebookEdition,
  archivePricebookEdition,
  importPricebookEdition,
  isUniqueViolation,
  type ImportedEdition,
  type PricebookLifecycleDependencies,
} from './pricebook-lifecycle.js';
export { ActiveEditionDatasets } from './edition-datasets.js';
export { mapError, notFound, type ApiErrorBody, type ApiErrorMapping } from './errors.js';
export {
  AuthError,
  ensureBootstrapAdmin,
  SESSION_TTL_MS,
  type AuthDependencies,
  type BootstrapEnv,
} from './auth.js';
export * as contracts from './schemas.js';

import type { FastifyInstance } from 'fastify';
import { ensureBootstrapAdmin } from './auth.js';
import { createApiServer } from './server.js';
import type { ApiDependencies } from './server.js';
import { buildDependencies } from './composition.js';
import { readApiConfig } from './config.js';
import type { ApiConfig } from './config.js';
import { seedPricebookEdition } from './pricebook-seed.js';

/** A running production API: the listening app plus the dependencies it was built from. */
export interface RunningApi {
  readonly app: FastifyInstance;
  readonly dependencies: ApiDependencies;
  /**
   * Graceful shutdown (Phase 16 §17/§18): stops accepting requests, closes Fastify —
   * which runs the onClose hook — and ends the PostgreSQL pool. After this resolves the
   * process holds no open database connections.
   */
  readonly stop: () => Promise<void>;
}

/**
 * Starts the production API: config → pool → migrations → bootstrap → pricebook seed
 * → listen. Startup fails closed (the promise rejects) when the database is
 * unreachable, when — P8-A S1 (CG-GOV §1.5) — the users table is empty and no
 * bootstrap admin credentials are configured, or when — P8-B S1 (D-PB-1 = B) — the
 * verified staged 1404 dataset fails the import gate at seed time: a half-started
 * process never accepts requests.
 */
export async function startApi(config: ApiConfig): Promise<RunningApi> {
  const { dependencies, close } = await buildDependencies(config);
  // Bootstrap (after migrations, before listening): exactly one initial org_admin on
  // an empty users table, or fail closed. Ignored once any user exists.
  await ensureBootstrapAdmin(
    {
      users: dependencies.governance.users,
      sessions: dependencies.governance.sessions,
      clock: dependencies.clock,
    },
    {
      bootstrapAdminUsername: config.bootstrapAdminUsername,
      bootstrapAdminPassword: config.bootstrapAdminPassword,
    },
  );
  // P8-B S1 (D-PB-1 = B): the first-boot pricebook seed — the verified 1404 edition
  // enters `pricebook_editions` through the normal import gate, directly ACTIVE, with
  // the bootstrap admin as actor, and the historical estimate-version bindings are
  // backfilled in the same transaction. A no-op on every later boot.
  await seedPricebookEdition({
    users: dependencies.governance.users,
    editions: dependencies.repositories.editions,
    transact: dependencies.transact,
    clock: dependencies.clock,
    datasetPath: config.datasetPath,
  });
  const app = createApiServer(dependencies);
  app.addHook('onClose', async () => {
    await close();
  });
  await app.listen({ port: config.port, host: config.host });
  return { app, dependencies, stop: () => app.close() };
}

/**
 * Production entry point (composition root; never auto-invoked on import).
 *
 * Lifecycle: startup (fail-closed) → listen → on SIGTERM/SIGINT: stop accepting
 * requests → close Fastify → close the PostgreSQL pool → exit. The exit code reports
 * whether the shutdown completed cleanly.
 */
export async function main(): Promise<void> {
  const config = readApiConfig(process.env);
  const api = await startApi(config);
  const shutdown = (): void => {
    api.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
