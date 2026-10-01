/**
 * P8-B S1 — pricebook-edition persistence on a REAL PostgreSQL server (env-gated
 * exactly like the other node-postgres suites: runs only when
 * `COSTGENIUS_SMOKE_DATABASE_URL` points at a DISPOSABLE dedicated verification
 * database; without the variable the suite is SKIPPED and PGlite results are never
 * presented as server verification).
 *
 * Proves on the real server what PGlite cannot (single connection, superuser-ish
 * semantics blur both):
 * - SEED        — the first-boot seed establishes exactly ONE ACTIVE 1404 edition with
 *                 the pinned identity; a repeated run is a no-op; TWO CONCURRENT seed
 *                 attempts over SEPARATE connections produce exactly one edition;
 * - IMMUTABILITY— the migration's trigger guards hold for the CONNECTED (table-owner)
 *                 role — PostgreSQL ownership bypasses GRANT/REVOKE, so this is the
 *                 honest owner-posture proof — while the lifecycle columns stay
 *                 writable for the S2 routes;
 * - PRIVILEGES  — the DEPLOYMENT.md restricted application role (column-limited
 *                 grants: SELECT + INSERT + UPDATE of the lifecycle columns only, no
 *                 DELETE) is denied content/provenance UPDATE (42501) and DELETE
 *                 (42501), may INSERT, and may UPDATE exactly the lifecycle columns;
 * - INVARIANT   — the 0-or-1-ACTIVE partial unique index makes two concurrent
 *                 activations of different editions produce exactly one winner;
 * - BINDING     — new estimate versions are stamped with the ACTIVE edition at insert.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  createDb,
  createDbPool,
  DrizzleEstimateRepository,
  DrizzlePricebookEditionRepository,
  DrizzleProjectRepository,
  DrizzleSessionRepository,
  DrizzleUserRepository,
  migrateDatabase,
  type DbClient,
} from '@costgenius/db';
import { createProject, startEstimateVersion } from '@costgenius/projects';
import { ensureBootstrapAdmin, loadPublishedDataset, seedPricebookEdition } from '../src/index.js';
import { TEST_ADMIN } from './helpers.js';
import { transactOver } from './helpers.js';

const SMOKE_URL = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;

const INSTANT = '2026-01-01T00:00:00Z';
const PINNED_CONTENT_HASH = 'a669ddd4c315ee26fda6e43cff56eeac05cc03178ed8a665a13f49ff814de786';
const PINNED_SOURCE_FILE_HASH = 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f';

/** PostgreSQL error code of a rejected statement, or 'unexpectedly-allowed'. */
function pgErrorCode(error: unknown): string {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return 'no-code';
}

async function attempt(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'unexpectedly-allowed';
  } catch (error) {
    return pgErrorCode(error);
  }
}

describe.skipIf(SMOKE_URL === undefined)(
  'P8-B S1 pricebook editions (real PostgreSQL server)',
  () => {
    let db: DbClient;
    let pool: Pool;
    let closePool: () => Promise<void>;
    let adminId: string;

    /**
     * Full clean slate on a possibly-reused disposable database: the tables
     * (children before parents), the migration journal — AND the 0004 trigger
     * FUNCTIONS, which survive the table drop and would make the re-applied
     * migration fail with 42723 (duplicate function). The migrations are then
     * re-applied by the caller.
     */
    const resetToPristine = async (target: Pool): Promise<void> => {
      await target.query(
        'DROP TABLE IF EXISTS takeoff_lines, takeoff_sheets, finalized_takeoffs, takeoff_documents, boq_lines, finalized_estimates, estimate_versions, pricebook_editions, estimates, sessions, audit_events, users, projects CASCADE',
      );
      await target.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
      await target.query(
        'DROP FUNCTION IF EXISTS pricebook_editions_guard_immutable_columns(), pricebook_editions_forbid_delete(), estimate_versions_guard_edition_binding(), estimate_versions_stamp_active_edition() CASCADE',
      );
    };

    beforeAll(async () => {
      // clean slate on a possibly-reused disposable database (children before parents)
      const setup = createDbPool(SMOKE_URL as string);
      await resetToPristine(setup);
      await setup.end();

      pool = createDbPool(SMOKE_URL as string);
      db = createDb(pool);
      await migrateDatabase(db, MIGRATIONS_FOLDER);
      await ensureBootstrapAdmin(
        {
          users: new DrizzleUserRepository(db),
          sessions: new DrizzleSessionRepository(db),
          clock: () => INSTANT,
        },
        {
          bootstrapAdminUsername: TEST_ADMIN.username,
          bootstrapAdminPassword: TEST_ADMIN.password,
        },
      );
      const admin = (
        await pool.query<{ user_id: string }>(
          `select user_id from users where username = '${TEST_ADMIN.username}'`,
        )
      ).rows[0];
      if (admin === undefined) throw new Error('bootstrap admin missing');
      adminId = admin.user_id;
      closePool = () => pool.end();
    });
    afterAll(async () => {
      await closePool();
    });

    it('the first-boot seed establishes exactly ONE ACTIVE 1404 edition with the pinned identity', async () => {
      await seedPricebookEdition({
        users: new DrizzleUserRepository(db),
        editions: new DrizzlePricebookEditionRepository(db),
        transact: transactOver(db),
        clock: () => INSTANT,
      });
      const rows = await pool.query<{
        edition_id: string;
        status: string;
        content_hash: string;
        source_file_hash: string;
        imported_by: string;
      }>(
        'select edition_id, status, content_hash, source_file_hash, imported_by from pricebook_editions',
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toEqual({
        edition_id: 'ir-1404-abniye',
        status: 'ACTIVE',
        content_hash: PINNED_CONTENT_HASH,
        source_file_hash: PINNED_SOURCE_FILE_HASH,
        imported_by: adminId,
      });
      const events = await pool.query<{ action: string; details: unknown }>(
        "select action, details from audit_events where action like 'pricebook_edition.%' order by action",
      );
      expect(events.rows.map((r) => r.action)).toEqual([
        'pricebook_edition.activated',
        'pricebook_edition.imported',
      ]);
      expect((events.rows[0]?.details as { seeded?: boolean }).seeded).toBe(true);
    });

    it('a repeated seed is a no-op (idempotency on the real server)', async () => {
      await seedPricebookEdition({
        users: new DrizzleUserRepository(db),
        editions: new DrizzlePricebookEditionRepository(db),
        transact: transactOver(db),
        clock: () => INSTANT,
      });
      const count = await pool.query<{ n: string }>(
        'select count(*)::text as n from pricebook_editions',
      );
      expect(count.rows[0]?.n).toBe('1');
      const events = await pool.query<{ n: string }>(
        "select count(*)::text as n from audit_events where action like 'pricebook_edition.%'",
      );
      expect(events.rows[0]?.n).toBe('2');
    });

    it('two CONCURRENT seeds over separate connections produce exactly one edition', async () => {
      // reset to the PRE-SEED state — a pristine schema with the bootstrap admin, but
      // no edition row yet — then race two first boots over separate connections
      await resetToPristine(pool);
      await migrateDatabase(db, MIGRATIONS_FOLDER);
      await ensureBootstrapAdmin(
        {
          users: new DrizzleUserRepository(db),
          sessions: new DrizzleSessionRepository(db),
          clock: () => INSTANT,
        },
        {
          bootstrapAdminUsername: TEST_ADMIN.username,
          bootstrapAdminPassword: TEST_ADMIN.password,
        },
      );
      const adminAgain = (
        await pool.query<{ user_id: string }>(
          `select user_id from users where username = '${TEST_ADMIN.username}'`,
        )
      ).rows[0];
      if (adminAgain === undefined) throw new Error('bootstrap admin missing after reset');
      adminId = adminAgain.user_id;
      const boot = async (): Promise<void> => {
        const bootPool = createDbPool(SMOKE_URL as string);
        const bootDb = createDb(bootPool);
        try {
          await seedPricebookEdition({
            users: new (await import('@costgenius/db')).DrizzleUserRepository(bootDb),
            editions: new DrizzlePricebookEditionRepository(bootDb),
            transact: transactOver(bootDb),
            clock: () => INSTANT,
          });
        } finally {
          await bootPool.end();
        }
      };
      await Promise.all([boot(), boot()]);
      const rows = await pool.query<{ n: string; events: string }>(
        `select (select count(*)::text from pricebook_editions) as n,
              (select count(*)::text from audit_events where action like 'pricebook_edition.%') as events`,
      );
      expect(rows.rows[0]).toEqual({ n: '1', events: '2' });
    });

    it('the trigger guards bind the CONNECTED owner: content/provenance UPDATE and DELETE fail', async () => {
      const attempts = await Promise.all([
        attempt(() =>
          pool.query(
            `update pricebook_editions set title = 'forged' where edition_id = 'ir-1404-abniye'`,
          ),
        ),
        attempt(() =>
          pool.query(
            `update pricebook_editions set content = '{"edition":{}}'::jsonb where edition_id = 'ir-1404-abniye'`,
          ),
        ),
        attempt(() =>
          pool.query(
            `update pricebook_editions set source_file_hash = 'forged' where edition_id = 'ir-1404-abniye'`,
          ),
        ),
        attempt(() => pool.query(`delete from pricebook_editions`)),
      ]);
      for (const code of attempts) {
        expect(code).toBe('P0001'); // the trigger's RAISE
      }
      // lifecycle columns remain writable
      await pool.query(
        `update pricebook_editions set status = 'ARCHIVED', archived_by = $1, archived_at = $2
       where edition_id = 'ir-1404-abniye'`,
        [adminId, INSTANT],
      );
      await pool.query(
        `update pricebook_editions set status = 'ACTIVE', archived_by = null, archived_at = null
       where edition_id = 'ir-1404-abniye'`,
      );
      const status = await pool.query<{ status: string }>(
        `select status from pricebook_editions where edition_id = 'ir-1404-abniye'`,
      );
      expect(status.rows[0]?.status).toBe('ACTIVE');
    });

    it('two concurrent ACTIVATIONS of different editions → exactly one winner (partial unique index)', async () => {
      const dataset = loadPublishedDataset();
      const insert = async (editionId: string): Promise<string> =>
        attempt(() =>
          pool.query(
            `insert into pricebook_editions
             (edition_id, discipline, year, title, organization, notification_number, notification_date,
              source_file_hash, content_hash, content, import_report, status, imported_by, imported_at)
           values ($1, 'abniye', $2, $3, $4, null, null, $5, $6, $7::jsonb, '{"ok":true}'::jsonb, 'ACTIVE', $8, $9)`,
            [
              editionId,
              dataset.edition.year,
              dataset.edition.title,
              dataset.edition.organization,
              PINNED_SOURCE_FILE_HASH,
              `hash-${editionId}`,
              JSON.stringify({ edition: { ...dataset.edition, id: editionId }, rows: [] }),
              adminId,
              INSTANT,
            ],
          ),
        );
      // the existing seeded edition is ACTIVE; archiving it first, then racing two new ones
      await pool.query(`update pricebook_editions set status = 'ARCHIVED'`);
      const [a, b] = await Promise.all([insert('race-edition-a'), insert('race-edition-b')]);
      expect([a, b].sort()).toEqual(['23505', 'unexpectedly-allowed']);
      const actives = await pool.query<{ n: string }>(
        `select count(*)::text as n from pricebook_editions where status = 'ACTIVE'`,
      );
      expect(actives.rows[0]?.n).toBe('1');
      // restore the seeded edition to ACTIVE for the binding test below (archive the winner)
      await pool.query(`update pricebook_editions set status = 'ARCHIVED' where status = 'ACTIVE'`);
      await pool.query(
        `update pricebook_editions set status = 'ACTIVE' where edition_id = 'ir-1404-abniye'`,
      );
    });

    it('stamps new estimate versions with the ACTIVE edition at insert (real server)', async () => {
      const projects = new DrizzleProjectRepository(db);
      const estimates = new DrizzleEstimateRepository(db);
      // file-unique ids: this suite shares the disposable database with the other
      // real-server suites, and estimate identity is immutable once persisted
      const PB_PROJECT_ID = '5b100001-0000-4000-8000-000000000001';
      const PB_ESTIMATE_ID = '5b100002-0000-4000-8000-000000000002';
      const PB_VERSION_ID = `${PB_ESTIMATE_ID}-v1`;
      const project = createProject({
        projectId: PB_PROJECT_ID,
        title: 't',
        createdAt: INSTANT,
      });
      await projects.save(project);
      const dataset = loadPublishedDataset();
      const estimate = {
        estimateId: PB_ESTIMATE_ID,
        projectId: PB_PROJECT_ID,
        title: 't',
        versions: [],
      };
      const updated = startEstimateVersion(dataset, estimate, {
        createdAt: INSTANT,
        buildingId: 'b1',
        versionId: PB_VERSION_ID,
      });
      await estimates.save(updated);
      const row = await pool.query<{ edition: string; edition_id: string | null }>(
        `select edition, edition_id from estimate_versions where version_id = $1`,
        [PB_VERSION_ID],
      );
      expect(row.rows[0]).toEqual({ edition: '1404', edition_id: 'ir-1404-abniye' });
    });

    it('the restricted application role (DEPLOYMENT runbook) touches exactly the permitted surface', async () => {
      const APP_ROLE = 'cg_pricebook_app';
      const APP_ROLE_PASSWORD = 'cg-pricebook-app-password-123';
      const exists = await pool.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
        [APP_ROLE],
      );
      if (exists.rows[0]?.exists === true) {
        await pool.query(`DROP OWNED BY ${APP_ROLE}`);
        await pool.query(`DROP ROLE ${APP_ROLE}`);
      }
      await pool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
      // the runbook grant set …
      await pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
      );
      // … except the pricebook edition registry: column-limited (§18/§11)
      await pool.query(`REVOKE UPDATE, DELETE ON TABLE pricebook_editions FROM ${APP_ROLE}`);
      await pool.query(
        `GRANT UPDATE (status, activated_by, activated_at, archived_by, archived_at)
         ON TABLE pricebook_editions TO ${APP_ROLE}`,
      );

      const appUrl = (SMOKE_URL as string).replace(
        /^postgres(?:ql)?:\/\/[^@]*@/,
        `postgres://${APP_ROLE}:${APP_ROLE_PASSWORD}@`,
      );
      const appPool = createDbPool(appUrl);
      try {
        // content/provenance columns: denied at the GRANT level (42501)
        expect(
          await attempt(() =>
            appPool.query(
              `update pricebook_editions set title = 'forged' where edition_id = 'ir-1404-abniye'`,
            ),
          ),
        ).toBe('42501');
        expect(
          await attempt(() =>
            appPool.query(
              `update pricebook_editions set content_hash = 'forged' where edition_id = 'ir-1404-abniye'`,
            ),
          ),
        ).toBe('42501');
        // DELETE: denied
        expect(await attempt(() => appPool.query(`delete from pricebook_editions`))).toBe('42501');
        // INSERT: allowed — a duplicate PK reaches the CONSTRAINT (23505), not a privilege denial
        expect(
          await attempt(() =>
            appPool.query(
              `insert into pricebook_editions (edition_id, discipline, year, title, organization,
               source_file_hash, content_hash, content, import_report, status, imported_by, imported_at)
             values ('ir-1404-abniye', 'abniye', '1404', 'x', 'x', 'x', 'x', '{}'::jsonb, '{}'::jsonb,
               'DRAFT', $1, $2)`,
              [adminId, INSTANT],
            ),
          ),
        ).toBe('23505');
        // lifecycle columns: allowed (a no-op UPDATE of the granted columns succeeds)
        const lifecycle = await appPool.query(
          `update pricebook_editions set status = status where edition_id = 'ir-1404-abniye'`,
        );
        expect(lifecycle.rowCount).toBe(1);
        // reading is allowed (the seed's existence check runs as this role)
        const read = await appPool.query<{ n: string }>(
          'select count(*)::text as n from pricebook_editions',
        );
        expect(read.rows[0]?.n).toBe('2'); // the seed + the one race winner
      } finally {
        await appPool.end();
        await pool.query(`DROP OWNED BY ${APP_ROLE}`);
        await pool.query(`DROP ROLE ${APP_ROLE}`);
      }
    });
  },
);
