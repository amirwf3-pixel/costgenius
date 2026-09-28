/**
 * The execution handle the repository internals run on: either the pool-bound database
 * or an open transaction. Both expose the same PgDatabase protocol, so `syncEstimate`
 * and the loaders work identically inside and outside a transaction.
 */
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';

export type DbExecutor = NodePgDatabase | PgTransaction<NodePgQueryResultHKT>;
