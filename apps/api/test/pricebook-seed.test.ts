/**
 * P8-B S1 — the first-boot pricebook seed (CG-IR-PRICEBOOK-SPEC@0.2.0 §24, D-PB-1 = B)
 * over the REAL PGlite stack: the actual migrations, the actual repository set, the
 * actual transactional unit of work — and the SAME `seedPricebookEdition` the
 * production boot (`startApi`) runs after `ensureBootstrapAdmin`.
 *
 * Proves the nine-point seed contract:
 * (1) the seed input is the verified staged 1404 dataset; (2) it passes through the
 * SAME import gate (a corrupted or foreign artifact is a boot-fatal error, never a
 * silent substitute); (3) idempotency — repeated seeds are no-ops; (4) exactly ONE
 * ACTIVE 1404 edition; (5) its contentHash is PINNED to the in-repo file; (6) repeated
 * startup never duplicates (concurrent attempts included); (7) the estimate-version
 * backfill runs only inside the seed transaction, AFTER the edition exists; (8) the
 * edition_id FK never dangles; (9) deterministic, transactional behaviour — both seed
 * events (`pricebook_edition.imported`/`.activated`, `seeded: true`, bootstrap-admin
 * actor) commit with the row or not at all.
 *
 * Also proves the runtime compatibility invariants of S1: the year-label column and
 * every existing workflow stay untouched, and new versions are bound to the seeded
 * ACTIVE edition at insert (the persistence-level D-PB-3 rule A).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createProject, startEstimateVersion } from '@costgenius/projects';
import { validateStagedImport } from '@costgenius/pricebook';
import { DrizzleEstimateRepository, DrizzleProjectRepository, type DbClient } from '@costgenius/db';
import {
  createApiServer,
  ensureBootstrapAdmin,
  seedPricebookEdition,
  type ApiDependencies,
} from '../src/index.js';
import {
  bindRepositories,
  FIXED_INSTANT,
  readAuditEvents,
  TEST_ADMIN,
  transactOver,
} from './helpers.js';
import { loadPublishedDataset } from '../src/dataset.js';

/** The pinned identity of the in-repo verified staged dataset (§24 hash pinning). */
const PINNED_CONTENT_HASH = 'a669ddd4c315ee26fda6e43cff56eeac05cc03178ed8a665a13f49ff814de786';
const PINNED_SOURCE_FILE_HASH = 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f';

const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;

interface SeedFixture {
  readonly pg: PGlite;
  readonly deps: ApiDependencies;
  readonly seed: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** A migrated, bootstrapped PGlite database with the seed UNRUN (the caller decides). */
async function createSeedFixture(): Promise<SeedFixture> {
  const pg = new PGlite();
  const raw = drizzle(pg);
  await migrate(raw, { migrationsFolder: MIGRATIONS_FOLDER });
  const db = raw as unknown as DbClient;
  const poolBound = bindRepositories(db);
  const deps: ApiDependencies = {
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
    dataset: loadPublishedDataset(),
    clock: () => FIXED_INSTANT,
    transact: transactOver(db),
  };
  await ensureBootstrapAdmin(
    { users: deps.governance.users, sessions: deps.governance.sessions, clock: deps.clock },
    { bootstrapAdminUsername: TEST_ADMIN.username, bootstrapAdminPassword: TEST_ADMIN.password },
  );
  return {
    pg,
    deps,
    seed: () =>
      seedPricebookEdition({
        users: deps.governance.users,
        editions: deps.repositories.editions,
        transact: deps.transact,
        clock: deps.clock,
      }),
    close: async () => {
      await pg.close();
    },
  };
}

/** The persisted edition row (straight from the table — no read API exists in S1). */
async function editionRow(pg: PGlite): Promise<{
  edition_id: string;
  discipline: string;
  year: string;
  status: string;
  source_file_hash: string;
  content_hash: string;
  imported_by: string;
  import_report_ok: boolean;
  row_count: number;
  warning_count: number;
  content_rows: number;
}> {
  const result = await pg.query<{
    edition_id: string;
    discipline: string;
    year: string;
    status: string;
    source_file_hash: string;
    content_hash: string;
    imported_by: string;
    import_report_ok: boolean;
    row_count: number;
    warning_count: number;
    content_rows: number;
  }>(
    `select edition_id, discipline, year, status, source_file_hash, content_hash, imported_by,
       (import_report->>'ok')::boolean as import_report_ok,
       (import_report->>'rowCount')::int as row_count,
       (import_report->>'warningCount')::int as warning_count,
       jsonb_array_length(content->'rows') as content_rows
     from pricebook_editions`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('no pricebook_editions row found');
  return row;
}

describe('P8-B S1 seed — first boot (clean database)', () => {
  let fixture: SeedFixture;
  beforeAll(async () => {
    fixture = await createSeedFixture();
    await fixture.seed();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('establishes exactly ONE edition row, directly ACTIVE, for discipline ابنیه', async () => {
    const count = (
      await fixture.pg.query<{ n: string }>('select count(*)::text as n from pricebook_editions')
    ).rows[0];
    expect(count?.n).toBe('1');
    const row = await editionRow(fixture.pg);
    expect(row.edition_id).toBe('ir-1404-abniye');
    expect(row.status).toBe('ACTIVE');
    expect(row.discipline).toBe('abniye');
    expect(row.year).toBe('1404');
  });

  it('carries the pinned contentHash and sourceFileHash of the in-repo verified dataset', async () => {
    const row = await editionRow(fixture.pg);
    expect(row.content_hash).toBe(PINNED_CONTENT_HASH);
    expect(row.source_file_hash).toBe(PINNED_SOURCE_FILE_HASH);
    expect(row.import_report_ok).toBe(true);
    expect(row.row_count).toBe(1564);
    expect(row.warning_count).toBe(11);
    expect(row.content_rows).toBe(1564);
    // the pinned hash equals the canonical hash of the staged file itself (§24 point 5)
    const dataset = loadPublishedDataset();
    expect(dataset.edition.sourceFileHash).toBe(PINNED_SOURCE_FILE_HASH);
  });

  it('records the bootstrap admin as importer and activator', async () => {
    const admin = (
      await fixture.pg.query<{ user_id: string }>(
        `select user_id from users where username = '${TEST_ADMIN.username}'`,
      )
    ).rows[0];
    expect(admin).toBeDefined();
    const row = await editionRow(fixture.pg);
    expect(row.imported_by).toBe(admin?.user_id);
  });

  it('appends exactly the two seeded audit events, with exact payloads and actor', async () => {
    const events = await readAuditEvents(fixture.pg);
    expect(events).toHaveLength(2);
    const admin = (
      await fixture.pg.query<{ user_id: string }>(
        `select user_id from users where username = '${TEST_ADMIN.username}'`,
      )
    ).rows[0];
    const [imported, activated] = events;
    expect(imported?.action).toBe('pricebook_edition.imported');
    expect(imported?.resourceType).toBe('pricebook_edition');
    expect(imported?.resourceId).toBe('ir-1404-abniye');
    expect(imported?.projectId).toBe(null);
    expect(imported?.actorUserId).toBe(admin?.user_id ?? null);
    expect(imported?.at).toBe(FIXED_INSTANT);
    expect(imported?.details).toEqual({
      contentHash: PINNED_CONTENT_HASH,
      rowCount: 1564,
      warningCount: 11,
      seeded: true,
    });
    expect(activated?.action).toBe('pricebook_edition.activated');
    expect(activated?.resourceId).toBe('ir-1404-abniye');
    expect(activated?.projectId).toBe(null);
    expect(activated?.actorUserId).toBe(admin?.user_id ?? null);
    expect(activated?.details).toEqual({
      contentHash: PINNED_CONTENT_HASH,
      supersededEditionId: null,
      seeded: true,
    });
  });
});

describe('P8-B S1 seed — idempotency and safety', () => {
  it('a repeated seed is a no-op: one row, two events, no re-activation', async () => {
    const fixture = await createSeedFixture();
    try {
      await fixture.seed();
      await fixture.seed();
      await fixture.seed();
      expect(
        (
          await fixture.pg.query<{ n: string }>(
            'select count(*)::text as n from pricebook_editions',
          )
        ).rows[0]?.n,
      ).toBe('1');
      expect(await readAuditEvents(fixture.pg)).toHaveLength(2);
      expect((await editionRow(fixture.pg)).status).toBe('ACTIVE');
    } finally {
      await fixture.close();
    }
  });

  it('NEVER re-activates an edition the operator archived (§24)', async () => {
    const fixture = await createSeedFixture();
    try {
      await fixture.seed();
      // simulate the S2 archive command (lifecycle columns are the writable ones)
      await fixture.pg.query(
        `update pricebook_editions set status = 'ARCHIVED', archived_at = $1
         where edition_id = 'ir-1404-abniye'`,
        [FIXED_INSTANT],
      );
      await fixture.seed();
      const row = await editionRow(fixture.pg);
      expect(row.status).toBe('ARCHIVED');
      expect(
        (
          await fixture.pg.query<{ n: string }>(
            'select count(*)::text as n from pricebook_editions',
          )
        ).rows[0]?.n,
      ).toBe('1');
      expect(await readAuditEvents(fixture.pg)).toHaveLength(2); // no new events
    } finally {
      await fixture.close();
    }
  });

  it('two SIMULTANEOUS seed attempts produce exactly one edition and one event pair', async () => {
    const fixture = await createSeedFixture();
    try {
      await Promise.all([fixture.seed(), fixture.seed()]);
      expect(
        (
          await fixture.pg.query<{ n: string }>(
            'select count(*)::text as n from pricebook_editions',
          )
        ).rows[0]?.n,
      ).toBe('1');
      const events = await readAuditEvents(fixture.pg);
      expect(events.filter((e) => e.action === 'pricebook_edition.imported')).toHaveLength(1);
      expect(events.filter((e) => e.action === 'pricebook_edition.activated')).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it('fails closed on a corrupted seed artifact (a failed gate never serves)', async () => {
    const fixture = await createSeedFixture();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'cg-seed-'));
      try {
        const badPath = join(dir, 'bad-staged.json');
        writeFileSync(badPath, JSON.stringify({ formatVersion: '1', kind: 'wrong-kind' }));
        await expect(
          seedPricebookEdition({
            users: fixture.deps.governance.users,
            editions: fixture.deps.repositories.editions,
            transact: fixture.deps.transact,
            clock: fixture.deps.clock,
            datasetPath: badPath,
          }),
        ).rejects.toThrow(/failed the import gate/i);
        // nothing stored, zero events
        expect(
          (
            await fixture.pg.query<{ n: string }>(
              'select count(*)::text as n from pricebook_editions',
            )
          ).rows[0]?.n,
        ).toBe('0');
        expect(await readAuditEvents(fixture.pg)).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await fixture.close();
    }
  });

  it('fails closed on a seed artifact that is not the official 1404 edition', async () => {
    const fixture = await createSeedFixture();
    try {
      // a VALID staged file of a different edition (passes the gate, wrong identity)
      const foreign = {
        formatVersion: '1',
        kind: 'staged-import',
        edition: {
          id: 'ir-1405-abniye',
          title: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
          organization: 'سازمان برنامه و بودجه کشور',
          year: '1405',
          notificationNumber: null,
          notificationDate: null,
          sourceFileHash: PINNED_SOURCE_FILE_HASH,
        },
        rows: [
          {
            code: '010101',
            chapter: 'chapter-1',
            group: '1',
            description: 'شرح',
            unit: { label: 'مترمربع', code: 'm2' },
            basePrice: '2890',
            status: 'VERIFIED_SPEC_ONLY',
            sourceRef: {
              sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
              edition: '1404',
              printedPage: '11',
              section: 'Chapter 1, Group 1',
              sourceFileHash: PINNED_SOURCE_FILE_HASH,
            },
          },
        ],
      };
      expect(validateStagedImport(foreign).ok).toBe(true);
      const dir = mkdtempSync(join(tmpdir(), 'cg-seed-'));
      try {
        const foreignPath = join(dir, 'foreign-staged.json');
        writeFileSync(foreignPath, JSON.stringify(foreign));
        await expect(
          seedPricebookEdition({
            users: fixture.deps.governance.users,
            editions: fixture.deps.repositories.editions,
            transact: fixture.deps.transact,
            clock: fixture.deps.clock,
            datasetPath: foreignPath,
          }),
        ).rejects.toThrow(/declares edition "ir-1405-abniye"/i);
        expect(
          (
            await fixture.pg.query<{ n: string }>(
              'select count(*)::text as n from pricebook_editions',
            )
          ).rows[0]?.n,
        ).toBe('0');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await fixture.close();
    }
  });

  it('fails closed when no org_admin exists to act as the seed actor', async () => {
    const pg = new PGlite();
    const raw = drizzle(pg);
    await migrate(raw, { migrationsFolder: MIGRATIONS_FOLDER });
    const db = raw as unknown as DbClient;
    const poolBound = bindRepositories(db);
    try {
      await expect(
        seedPricebookEdition({
          users: poolBound.users,
          editions: poolBound.editions,
          transact: transactOver(db),
          clock: () => FIXED_INSTANT,
        }),
      ).rejects.toThrow(/no org_admin exists/i);
      expect(
        (await pg.query<{ n: string }>('select count(*)::text as n from pricebook_editions'))
          .rows[0]?.n,
      ).toBe('0');
    } finally {
      await pg.close();
    }
  });
});

describe('P8-B S1 seed — backfill and runtime compatibility', () => {
  it('backfills pre-existing estimate_versions inside the seed transaction (FK never dangles)', async () => {
    const fixture = await createSeedFixture();
    try {
      // a pre-P8-B version exists BEFORE the seed: NULL binding (no ACTIVE edition)
      const projects = new DrizzleProjectRepository(drizzle(fixture.pg) as unknown as DbClient);
      const estimates = new DrizzleEstimateRepository(drizzle(fixture.pg) as unknown as DbClient);
      const project = createProject({
        projectId: '11111111-2222-4333-8444-555555555555',
        title: 't',
        createdAt: FIXED_INSTANT,
      });
      await projects.save(project);
      const dataset = loadPublishedDataset();
      const estimate = {
        estimateId: '12345678-90ab-4cde-9f01-234567890abc',
        projectId: '11111111-2222-4333-8444-555555555555',
        title: 't',
        versions: [],
      };
      const updated = startEstimateVersion(dataset, estimate, {
        createdAt: FIXED_INSTANT,
        buildingId: 'b1',
        versionId: 'v1',
      });
      await estimates.save(updated);
      const before = (
        await fixture.pg.query<{ edition: string; edition_id: string | null }>(
          `select edition, edition_id from estimate_versions where version_id = 'v1'`,
        )
      ).rows[0];
      expect(before).toEqual({ edition: '1404', edition_id: null });

      await fixture.seed();
      const after = (
        await fixture.pg.query<{ edition: string; edition_id: string | null }>(
          `select edition, edition_id from estimate_versions where version_id = 'v1'`,
        )
      ).rows[0];
      expect(after).toEqual({ edition: '1404', edition_id: 'ir-1404-abniye' });
    } finally {
      await fixture.close();
    }
  });

  it('binds NEW versions created through the API to the seeded ACTIVE edition', async () => {
    const fixture = await createSeedFixture();
    try {
      await fixture.seed();
      const app = createApiServer(fixture.deps);
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: TEST_ADMIN.username, password: TEST_ADMIN.password },
      });
      const setCookie = login.headers['set-cookie'];
      const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const cookie = first?.split(';')[0] ?? '';
      const projectId = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
      const estimateId = '12345678-90ab-4cde-9f01-234567890abc';
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/projects',
            headers: { cookie },
            payload: { projectId, title: 'پروژه' },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/projects/${projectId}/estimates`,
            headers: { cookie },
            payload: { estimateId, title: 'برآورد' },
          })
        ).statusCode,
      ).toBe(201);
      const version = await app.inject({
        method: 'POST',
        url: `/estimates/${estimateId}/versions`,
        headers: { cookie },
        payload: { buildingId: 'b1' },
      });
      expect(version.statusCode).toBe(201);
      const row = (
        await fixture.pg.query<{ edition: string; edition_id: string | null }>(
          `select edition, edition_id from estimate_versions where estimate_id = $1`,
          [estimateId],
        )
      ).rows[0];
      // the year label keeps its bytes; the exact binding is the seeded edition
      expect(row).toEqual({ edition: '1404', edition_id: 'ir-1404-abniye' });
      await app.close();
    } finally {
      await fixture.close();
    }
  });
});
