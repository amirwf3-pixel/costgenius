/**
 * Database client construction (production path: node-postgres pool → Drizzle).
 *
 * The client is injectable by the caller (app/tests) — there is no global singleton and
 * no hidden connection state. `migrateDatabase` applies the versioned SQL migrations in
 * ./migrations through Drizzle's journal-based migrator; it creates the schema
 * reproducibly and contains no seed data.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/** The Drizzle handle the repositories operate on (a pool-bound database or a transaction). */
export type DbClient = NodePgDatabase;

/** Creates a pg connection pool. The caller owns its lifecycle (and supplies the secret). */
export function createDbPool(connectionString: string): Pool {
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new Error('connectionString must be a non-empty string (never hardcode secrets)');
  }
  return new Pool({ connectionString });
}

/** Binds a Drizzle client to an existing pool. */
export function createDb(pool: Pool): DbClient {
  return drizzle(pool);
}

/** Applies the versioned migrations in `migrationsFolder` (idempotent via the journal). */
export async function migrateDatabase(db: DbClient, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
