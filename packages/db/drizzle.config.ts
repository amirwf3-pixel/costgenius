import { defineConfig } from 'drizzle-kit';

/**
 * Migration generation config. Offline and deterministic: `pnpm db:generate` reads the
 * schema in src/schema and writes versioned SQL to ./migrations. No database connection
 * and no environment variable are needed for generation; no pricebook or seed data of any
 * kind is ever written into a migration.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
});
