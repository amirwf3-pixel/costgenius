/**
 * @costgenius/db — the PostgreSQL/Drizzle persistence adapter (Phase 14).
 *
 * Implements the repository contracts of `@costgenius/projects` over PostgreSQL:
 * projects → estimates → estimate_versions → boq_lines, plus the immutable
 * finalized_estimates record. The verified 1404 pricebook dataset is NOT persisted here —
 * it remains the price source of truth; only application data and the snapshots created
 * from it are stored. Business numbers are exact decimal strings (numeric columns);
 * blank prices stay NULL; finalized history is append-only and byte-compared, never
 * updated or deleted.
 *
 * The client is injectable (`createDbPool`/`createDb`); migrations are versioned SQL in
 * ./migrations, applied by `migrateDatabase` (journal-based, idempotent, seed-free).
 */
export { DbError, type DbErrorCode } from './errors.js';
export { canonicalJson } from './canonical-json.js';
export { createDb, createDbPool, migrateDatabase, type DbClient } from './client.js';
export type { DbExecutor } from './db-executor.js';
export {
  projects,
  estimates,
  estimateVersions,
  boqLines,
  finalizedEstimates,
  finalizedTakeoffs,
  takeoffDocuments,
  takeoffLines,
  takeoffSheets,
  users,
  sessions,
  auditEvents,
} from './schema/index.js';
export { DrizzleProjectRepository } from './repositories/project-repository.js';
export { DrizzleEstimateRepository } from './repositories/estimate-repository.js';
export { DrizzleFinalizedEstimateRepository } from './repositories/finalized-estimate-repository.js';
export { DrizzleTakeoffDocumentRepository } from './repositories/takeoff-repository.js';
export { DrizzleFinalizedTakeoffRepository } from './repositories/takeoff-repository.js';
export { DrizzleSessionRepository, DrizzleUserRepository } from './repositories/user-repository.js';
