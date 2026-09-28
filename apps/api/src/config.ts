/**
 * API configuration (composition root reads the environment; no secret ever lives here).
 *
 * `DATABASE_URL` is the only required setting — a PostgreSQL connection string supplied
 * by the deployment environment. Tests never hardcode it: they inject PGlite-backed
 * repositories directly, and the real-server smoke test reads its own dedicated
 * `COSTGENIUS_SMOKE_DATABASE_URL` variable and reports NOT RUN when it is absent.
 */
export interface ApiConfig {
  /** PostgreSQL connection string (from the environment; never stored in the repo). */
  readonly databaseUrl: string;
  readonly port: number;
  readonly host: string;
  /** Path to the staged 1404 pricebook JSON (defaults to the in-repo verified dataset). */
  readonly datasetPath: string;
  /**
   * Initial org_admin credentials (P8-A S1 bootstrap, CG-GOV §1.5) — used ONLY when the
   * users table is empty at startup; otherwise ignored. Startup fails closed when the
   * table is empty and either is absent (no default account is ever created). Format
   * rules are enforced at use (the account must satisfy §1.1/§1.2), not here, so an
   * unused malformed variable never blocks an already-bootstrapped instance.
   */
  readonly bootstrapAdminUsername: string | undefined;
  readonly bootstrapAdminPassword: string | undefined;
}

function requiredString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`environment variable ${key} is required (it is never hardcoded in the repo)`);
  }
  return value;
}

function optionalInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`environment variable ${key} must be a TCP port number`);
  }
  return parsed;
}

/**
 * DATABASE_URL must be a PostgreSQL connection string. There is no fallback database
 * and no default secret: anything else fails closed at startup (Phase 16 §20).
 */
function requiredDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = requiredString(env, 'DATABASE_URL');
  if (!/^postgres(?:ql)?:\/\//.test(value)) {
    throw new Error(
      'environment variable DATABASE_URL must be a PostgreSQL connection string ' +
        '(postgres:// or postgresql://); no database fallback exists',
    );
  }
  return value;
}

/** Reads the API configuration from an environment (injectable for tests). */
export function readApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  return {
    databaseUrl: requiredDatabaseUrl(env),
    port: optionalInt(env, 'PORT', 3000),
    host: env['HOST'] ?? '0.0.0.0',
    datasetPath:
      env['DATASET_PATH'] ??
      new URL('../../../packages/pricebook/data/verified-1404.staged.v0.1.0.json', import.meta.url)
        .pathname,
    bootstrapAdminUsername: nonEmptyOrUndefined(env['CG_BOOTSTRAP_ADMIN_USERNAME']),
    bootstrapAdminPassword: nonEmptyOrUndefined(env['CG_BOOTSTRAP_ADMIN_PASSWORD']),
  };
}

function nonEmptyOrUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
