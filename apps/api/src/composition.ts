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
  DrizzleEstimateRepository,
  DrizzleFinalizedEstimateRepository,
  DrizzleFinalizedTakeoffRepository,
  DrizzleProjectRepository,
  DrizzleSessionRepository,
  DrizzleTakeoffDocumentRepository,
  DrizzleUserRepository,
  migrateDatabase,
} from '@costgenius/db';
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

/** Builds the production dependencies: pool → migrate → repositories + dataset + clock. */
export async function buildDependencies(config: ApiConfig): Promise<ComposedApi> {
  const pool = createDbPool(config.databaseUrl);
  const db = createDb(pool);
  await migrateDatabase(db, MIGRATIONS_FOLDER);
  const dependencies: ApiDependencies = {
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
    dataset: loadPublishedDataset(config.datasetPath),
    // The real clock lives ONLY here, at the impure edge (business layers stay pure).
    clock: () => new Date().toISOString(),
  };
  return {
    dependencies,
    close: async () => {
      await pool.end();
    },
  };
}
