/**
 * Production composition root: builds the real persistence stack from configuration.
 *
 * environment → PostgreSQL pool (node-postgres) → Drizzle → migrations → repositories →
 * dataset → injected clock. This is the ONLY place the API touches `@costgenius/db`;
 * route handlers see nothing but the repository contracts. The connection string comes
 * from the environment (`DATABASE_URL`) — never from this repository.
 */
import {
  createDb,
  createDbPool,
  DrizzleAuditEventRepository,
  DrizzleEstimateRepository,
  DrizzleFinalizedEstimateRepository,
  DrizzleFinalizedTakeoffRepository,
  DrizzlePricebookEditionRepository,
  DrizzleProjectRepository,
  DrizzleSessionRepository,
  DrizzleTakeoffDocumentRepository,
  DrizzleUserRepository,
  migrateDatabase,
  type DbClient,
  type DbExecutor,
} from '@costgenius/db';
import type { TransactionalRepositories, Transact } from './audit.js';
import type { ApiDependencies } from './server.js';
import type { ApiConfig } from './config.js';
import { loadPublishedDataset } from './dataset.js';

/** Location of the versioned Drizzle migrations (the db package's ./migrations). */
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;

export interface ComposedApi {
  readonly dependencies: ApiDependencies;
  /** Ends the connection pool (graceful shutdown). */
  readonly close: () => Promise<void>;
}

/**
 * Binds the FULL repository set (domain + governance + the S3 append-only audit
 * writer) to any executor: the pool for reads and standalone events, an open
 * transaction for the audited mutations (CG-GOV §4.2 — mutation + event commit or
 * roll back together; the repositories' internal transactions become savepoints).
 * Exported so every composition site (production root, the PGlite dev/e2e backends,
 * the tests) builds the IDENTICAL set — there is exactly one canonical audit writer.
 */
export const bindRepositories = (executor: DbExecutor): TransactionalRepositories => ({
  projects: new DrizzleProjectRepository(executor),
  estimates: new DrizzleEstimateRepository(executor),
  finalized: new DrizzleFinalizedEstimateRepository(executor),
  takeoffDocuments: new DrizzleTakeoffDocumentRepository(executor),
  finalizedTakeoffs: new DrizzleFinalizedTakeoffRepository(executor),
  users: new DrizzleUserRepository(executor),
  sessions: new DrizzleSessionRepository(executor),
  audit: new DrizzleAuditEventRepository(executor),
  // P8-B S1: the edition repository (the seed's import write + the binding backfill).
  editions: new DrizzlePricebookEditionRepository(executor),
});

/** The S3 transactional unit of work over one Drizzle client (CG-GOV §4.2). */
export const transactOver = (db: DbClient): Transact => {
  return async <T>(work: (tx: TransactionalRepositories) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => work(bindRepositories(tx)));
};

/** Builds the production dependencies: pool → migrate → repositories + dataset + clock. */
export async function buildDependencies(config: ApiConfig): Promise<ComposedApi> {
  const pool = createDbPool(config.databaseUrl);
  const db = createDb(pool);
  await migrateDatabase(db, MIGRATIONS_FOLDER);
  const poolBound = bindRepositories(db);
  const dependencies: ApiDependencies = {
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
    dataset: loadPublishedDataset(config.datasetPath),
    // The real clock lives ONLY here, at the impure edge (business layers stay pure).
    clock: () => new Date().toISOString(),
    // S3: the transactional unit of work every audited mutation runs in.
    transact: transactOver(db),
  };
  return {
    dependencies,
    close: async () => {
      await pool.end();
    },
  };
}
