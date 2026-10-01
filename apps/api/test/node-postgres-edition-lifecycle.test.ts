/**
 * P8-B S2 — the pricebook-edition lifecycle on a REAL PostgreSQL server
 * (CG-IR-PRICEBOOK-SPEC@0.2.0 §9/§17/§21).
 *
 * GATED BY ENVIRONMENT: runs only when `COSTGENIUS_SMOKE_DATABASE_URL` points at a
 * DISPOSABLE dedicated verification database (exactly like the other node-postgres
 * suites). Proves what only a real server can:
 *
 * - CONCURRENCY — two SIMULTANEOUS activations of different editions of the same
 *   discipline produce exactly ONE ACTIVE edition: the partial unique index
 *   `pricebook_editions_one_active` decides, the loser's transaction rolls back
 *   completely (zero partial state, zero events) and surfaces the deterministic
 *   contract conflict EDITION_ALREADY_ACTIVE. Same for two racing identical imports
 *   (exactly one row, exactly one event, the loser a clean EDITION_ALREADY_EXISTS).
 * - RUNBOOK GRANTS — the restricted application role of DEPLOYMENT.md (SELECT +
 *   INSERT + UPDATE of the lifecycle columns ONLY) can run the whole lifecycle
 *   through the real repositories, while its content UPDATE is still 42501 —
 *   S2 changes the lifecycle columns and nothing else, exactly as granted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  createDb,
  createDbPool,
  DrizzlePricebookEditionRepository,
  DrizzleSessionRepository,
  DrizzleUserRepository,
  migrateDatabase,
  type DbClient,
} from '@costgenius/db';
import {
  activatePricebookEdition,
  archivePricebookEdition,
  importPricebookEdition,
} from '../src/index.js';
import { ensureBootstrapAdmin, seedPricebookEdition } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { TEST_ADMIN, transactOver } from './helpers.js';
import type { Actor } from '@costgenius/projects';
import type { StagedPricebookFile } from '@costgenius/pricebook';
import { PricebookEditionError, validateStagedImport } from '@costgenius/pricebook';

const SMOKE_URL = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;
const STAGED_1404_PATH = new URL(
  '../../../packages/pricebook/data/verified-1404.staged.v0.1.0.json',
  import.meta.url,
).pathname;

const INSTANT = '2026-01-01T00:00:00Z';
const SEED_EDITION = 'ir-1404-abniye';

/** A synthetic staged file (passes the same gate; unique content per tag). */
function syntheticStagedFile(tag: string): StagedPricebookFile {
  const file = {
    formatVersion: '1',
    kind: 'staged-import',
    edition: {
      id: `ir-14rg-abniye-${tag}`,
      title: 'فهرست آزمونی رشته ابنیه',
      organization: 'سازمان برنامه و بودجه کشور',
      year: '1411',
      notificationNumber: null,
      notificationDate: null,
      sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
    },
    rows: [
      {
        code: '010101',
        chapter: 'chapter-1',
        group: '1',
        description: `شرح آزمون ${tag}`,
        unit: { label: 'مترمربع', code: 'm2' },
        basePrice: '2890',
        status: 'VERIFIED_SPEC_ONLY',
        sourceRef: {
          sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
          edition: '1404',
          printedPage: '11',
          section: 'Chapter 1, Group 1',
          sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
        },
      },
    ],
  } as const;
  const report = validateStagedImport(file);
  if (!report.ok) {
    throw new Error(`synthetic staged file must pass the gate: ${JSON.stringify(report.errors)}`);
  }
  return file;
}

/** PostgreSQL error code of a failed statement ('no-code' when none). */
function pgErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'no-code';
}

interface Fixture {
  readonly db: DbClient;
  readonly pool: Pool;
  readonly adminId: string;
  readonly steward: Actor;
  readonly close: () => Promise<void>;
}

describe.skipIf(SMOKE_URL === undefined)(
  'P8-B S2 edition lifecycle (real PostgreSQL server)',
  () => {
    let fixture: Fixture;

    /**
     * Full clean slate on a possibly-reused disposable database: the tables (children
     * before parents), the migration journal AND the 0004 trigger FUNCTIONS (which
     * survive the table drop and would make the re-applied migration fail with 42723).
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
      const setup = createDbPool(SMOKE_URL as string);
      await resetToPristine(setup);
      await setup.end();

      const pool = createDbPool(SMOKE_URL as string);
      const db = createDb(pool);
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
      await seedPricebookEdition({
        users: new DrizzleUserRepository(db),
        editions: new DrizzlePricebookEditionRepository(db),
        transact: transactOver(db),
        clock: () => INSTANT,
      });
      const admin = (
        await pool.query<{ user_id: string }>(
          `select user_id from users where username = '${TEST_ADMIN.username}'`,
        )
      ).rows[0];
      if (admin === undefined) throw new Error('bootstrap admin missing');
      // a second REAL user (the importer — four-eyes counterpart of the admin)
      await pool.query(
        `insert into users (user_id, username, password_hash, role, is_active, created_at)
         values ('11111111-2222-4333-8444-555555555555', 'race-steward', 'scrypt$x', 'data_steward', true, $1)`,
        [INSTANT],
      );
      fixture = {
        db,
        pool,
        adminId: admin.user_id,
        steward: { userId: '11111111-2222-4333-8444-555555555555', username: 'race-steward' },
        close: async () => {
          await pool.end();
        },
      };
    });

    afterAll(async () => {
      await fixture.close();
    });

    /** One activation over its OWN connection (a genuine concurrent transaction). */
    const activateOverConnection = async (editionId: string, actor: Actor): Promise<void> => {
      const own = createDbPool(SMOKE_URL as string);
      const ownDb = createDb(own);
      try {
        await activatePricebookEdition(
          {
            editions: new DrizzlePricebookEditionRepository(ownDb),
            transact: transactOver(ownDb),
            clock: () => INSTANT,
          },
          actor,
          editionId,
        );
      } finally {
        await own.end();
      }
    };

    it('two SIMULTANEOUS activations of different editions → exactly one ACTIVE, one deterministic loser, zero partial state', async () => {
      // two DRAFTs imported by the STEWARD (both four-eyes-clean for the admin)
      const a = await importPricebookEdition(
        {
          editions: new DrizzlePricebookEditionRepository(fixture.db),
          transact: transactOver(fixture.db),
          clock: () => INSTANT,
        },
        fixture.steward,
        syntheticStagedFile('race-a'),
      );
      const b = await importPricebookEdition(
        {
          editions: new DrizzlePricebookEditionRepository(fixture.db),
          transact: transactOver(fixture.db),
          clock: () => INSTANT,
        },
        fixture.steward,
        syntheticStagedFile('race-b'),
      );
      expect(a.edition.status).toBe('DRAFT');
      expect(b.edition.status).toBe('DRAFT');

      const admin: Actor = {
        userId: fixture.adminId,
        username: TEST_ADMIN.username,
      };
      const outcomes = await Promise.allSettled([
        activateOverConnection(a.edition.editionId, admin),
        activateOverConnection(b.edition.editionId, admin),
      ]);
      const codes = outcomes.map((outcome) =>
        outcome.status === 'fulfilled'
          ? 'won'
          : outcome.reason instanceof PricebookEditionError
            ? outcome.reason.code
            : `unexpected:${pgErrorCode(outcome.reason)}`,
      );
      expect(codes.sort()).toEqual(['EDITION_ALREADY_ACTIVE', 'won']);

      // exactly one ACTIVE edition — the database, not the application, decided
      const active = await fixture.pool.query<{ edition_id: string }>(
        "select edition_id from pricebook_editions where status = 'ACTIVE'",
      );
      expect(active.rows).toHaveLength(1);
      const winnerId = active.rows[0]?.edition_id;
      expect([a.edition.editionId, b.edition.editionId]).toContain(winnerId);
      if (winnerId === undefined) throw new Error('no ACTIVE edition after the race');
      const loserId = winnerId === a.edition.editionId ? b.edition.editionId : a.edition.editionId;

      // zero partial state: the loser is still a DRAFT, the superseded seed was archived
      // exactly once (by the winner), with the winner's stamp
      const statuses = (
        await fixture.pool.query<{
          edition_id: string;
          status: string;
          archived_by: string | null;
        }>('select edition_id, status, archived_by from pricebook_editions')
      ).rows;
      const byId = new Map(statuses.map((row) => [row.edition_id, row]));
      expect(byId.get(loserId)?.status).toBe('DRAFT');
      expect(byId.get(winnerId)?.status).toBe('ACTIVE');
      expect(byId.get(SEED_EDITION)?.status).toBe('ARCHIVED');
      expect(byId.get(SEED_EDITION)?.archived_by).toBe(fixture.adminId);

      // zero duplicate side effects: exactly ONE activated event for the winner (plus
      // the seed's), exactly ONE archived event for the superseded edition, and the
      // loser wrote NOTHING
      const winnerActivated = await fixture.pool.query<{ n: string }>(
        "select count(*)::text as n from audit_events where action = 'pricebook_edition.activated' and resource_id = $1",
        [winnerId],
      );
      expect(winnerActivated.rows[0]?.n).toBe('1');
      const seedArchived = await fixture.pool.query<{ n: string }>(
        "select count(*)::text as n from audit_events where action = 'pricebook_edition.archived' and resource_id = $1",
        [SEED_EDITION],
      );
      expect(seedArchived.rows[0]?.n).toBe('1');
      const loserEvents = await fixture.pool.query<{ n: string }>(
        'select count(*)::text as n from audit_events where resource_id = $1',
        [loserId],
      );
      expect(loserEvents.rows[0]?.n).toBe('1'); // only its import event — the lost race wrote none
    });

    it('two SIMULTANEOUS imports of identical content → exactly one edition row, one event, one clean 409', async () => {
      const file = syntheticStagedFile('race-import');
      const importOverConnection = async (): Promise<void> => {
        const own = createDbPool(SMOKE_URL as string);
        const ownDb = createDb(own);
        try {
          await importPricebookEdition(
            {
              editions: new DrizzlePricebookEditionRepository(ownDb),
              transact: transactOver(ownDb),
              clock: () => INSTANT,
            },
            fixture.steward,
            file,
          );
        } finally {
          await own.end();
        }
      };
      const outcomes = await Promise.allSettled([importOverConnection(), importOverConnection()]);
      const codes = outcomes.map((outcome) =>
        outcome.status === 'fulfilled'
          ? 'won'
          : outcome.reason instanceof PricebookEditionError
            ? outcome.reason.code
            : `unexpected:${pgErrorCode(outcome.reason)}`,
      );
      expect(codes.sort()).toEqual(['EDITION_ALREADY_EXISTS', 'won']);
      const rows = await fixture.pool.query<{ n: string }>(
        'select count(*)::text as n from pricebook_editions where edition_id = $1',
        ['ir-14rg-abniye-race-import'],
      );
      expect(rows.rows[0]?.n).toBe('1');
      const events = await fixture.pool.query<{ n: string }>(
        "select count(*)::text as n from audit_events where action = 'pricebook_edition.imported' and resource_id = $1",
        ['ir-14rg-abniye-race-import'],
      );
      expect(events.rows[0]?.n).toBe('1');
    });

    it('the DEPLOYMENT runbook application role runs the lifecycle through the real repositories — and still cannot touch content', async () => {
      const APP_ROLE = 'cg_lifecycle_app';
      const APP_ROLE_PASSWORD = 'cg-lifecycle-app-password-123';
      const exists = await fixture.pool.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
        [APP_ROLE],
      );
      if (exists.rows[0]?.exists === true) {
        await fixture.pool.query(`DROP OWNED BY ${APP_ROLE}`);
        await fixture.pool.query(`DROP ROLE ${APP_ROLE}`);
      }
      await fixture.pool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
      await fixture.pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
      await fixture.pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
      );
      await fixture.pool.query(
        `REVOKE UPDATE, DELETE ON TABLE pricebook_editions FROM ${APP_ROLE}`,
      );
      await fixture.pool.query(
        `GRANT UPDATE (status, activated_by, activated_at, archived_by, archived_at)
         ON TABLE pricebook_editions TO ${APP_ROLE}`,
      );

      const appUrl = (SMOKE_URL as string).replace(
        /^postgres(?:ql)?:\/\/[^@]*@/,
        `postgres://${APP_ROLE}:${APP_ROLE_PASSWORD}@`,
      );
      const appPool = createDbPool(appUrl);
      const appDb = createDb(appPool);
      try {
        // import (INSERT grant) as the steward, over the app-role connection
        const imported = await importPricebookEdition(
          {
            editions: new DrizzlePricebookEditionRepository(appDb),
            transact: transactOver(appDb),
            clock: () => INSTANT,
          },
          fixture.steward,
          syntheticStagedFile('app-role'),
        );
        expect(imported.edition.status).toBe('DRAFT');
        const admin: Actor = { userId: fixture.adminId, username: TEST_ADMIN.username };
        // activate + archive: exactly the granted lifecycle-column UPDATEs
        const activated = await activatePricebookEdition(
          {
            editions: new DrizzlePricebookEditionRepository(appDb),
            transact: transactOver(appDb),
            clock: () => INSTANT,
          },
          admin,
          'ir-14rg-abniye-app-role',
        );
        expect(activated.status).toBe('ACTIVE');
        const archived = await archivePricebookEdition(
          {
            editions: new DrizzlePricebookEditionRepository(appDb),
            transact: transactOver(appDb),
            clock: () => INSTANT,
          },
          admin,
          'ir-14rg-abniye-app-role',
        );
        expect(archived.status).toBe('ARCHIVED');
        // activate-then-archive of the only ACTIVE edition legally reaches the
        // 0-active state (D-PB-4 = A) — never two, and never an implicit restore
        const activeRows = await fixture.pool.query<{ n: string }>(
          "select count(*)::text as n from pricebook_editions where status = 'ACTIVE'",
        );
        expect(activeRows.rows[0]?.n).toBe('0');
        // content tampering is STILL denied for the application role (42501)
        const tamper = await appPool
          .query(
            `UPDATE pricebook_editions SET title = 'forged' WHERE edition_id = 'ir-14rg-abniye-app-role'`,
          )
          .then(() => 'unexpectedly-allowed', pgErrorCode);
        expect(tamper).toBe('42501');
      } finally {
        await appPool.end();
      }
    });

    it('the persisted editions hash-verify on the real server (§5 load identity)', async () => {
      // the staged 1404 file's canonical hash matches the seeded row exactly
      const staged = JSON.parse(readFileSync(STAGED_1404_PATH, 'utf8')) as StagedPricebookFile;
      const report = validateStagedImport(staged);
      expect(report.ok).toBe(true);
      const row = await fixture.pool.query<{ content_hash: string }>(
        'select content_hash from pricebook_editions where edition_id = $1',
        [SEED_EDITION],
      );
      expect(row.rows[0]?.content_hash).toBe(
        'a669ddd4c315ee26fda6e43cff56eeac05cc03178ed8a665a13f49ff814de786',
      );
    });
  },
);
