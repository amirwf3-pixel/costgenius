/**
 * P8-B S1 — pricebook-edition persistence verification (CG-IR-PRICEBOOK-SPEC@0.2.0
 * §18/§21) over the REAL in-process PostgreSQL (PGlite) with the actual migrations.
 *
 * Proves, at the database layer:
 * - SCHEMA   — the `pricebook_editions` table (13th table) with its exact constraint
 *              family: PK on edition_id, UNIQUE content_hash, discipline/status CHECKs,
 *              the 0-or-1-ACTIVE partial unique index, and the estimate_versions.edition_id
 *              additive FK column;
 * - REPO     — the Drizzle repository contract: lookups by id/content-hash/active
 *              discipline, the single insert write, duplicate refusal (PK + content),
 *              and the JSONB content round-trip that keeps `contentHash` stable;
 * - IMMUTABLE— the trigger guards: content/provenance/import-identity UPDATEs and ALL
 *              DELETEs fail for the connected (owner) role too — PostgreSQL ownership
 *              bypasses GRANT/REVOKE, so the triggers are the enforcement — while the
 *              lifecycle columns stay writable for the S2 routes;
 * - BINDING  — estimate-version edition bindings: stamped from the ACTIVE edition at
 *              insert, establishable from NULL exactly once (the backfill), and never
 *              changeable or clearable afterwards.
 *
 * The seed itself (first-boot, audit events, bootstrap actor) is verified at the API
 * layer (apps/api/test/pricebook-seed.test.ts); real-server privilege and concurrency
 * proofs live in the env-gated node-postgres suite.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  canonicalContentOf,
  contentHashOf,
  publishStagedImport,
  validateStagedImport,
  type PricebookEdition,
  type StagedPricebookFile,
} from '@costgenius/pricebook';
import {
  createEstimateForProject,
  createProject,
  startEstimateVersion,
} from '@costgenius/projects';
import {
  DrizzleEstimateRepository,
  DrizzlePricebookEditionRepository,
  DrizzleProjectRepository,
  type DbClient,
} from '../src/index.js';

const MIGRATIONS_FOLDER = new URL('../migrations', import.meta.url).pathname;
const STAGED_1404_PATH = new URL(
  '../../pricebook/data/verified-1404.staged.v0.1.0.json',
  import.meta.url,
).pathname;

const INSTANT = '2026-01-01T00:00:00Z';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const ESTIMATE_ID = '12345678-90ab-4cde-9f01-234567890abc';

/** The pinned identity of the in-repo verified staged dataset (test-pinned, §24). */
const PINNED_1404_CONTENT_HASH = 'a669ddd4c315ee26fda6e43cff56eeac05cc03178ed8a665a13f49ff814de786';
const PINNED_1404_SOURCE_FILE_HASH =
  'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f';

interface Fixture {
  readonly pg: PGlite;
  readonly db: DbClient;
  readonly editions: DrizzlePricebookEditionRepository;
  readonly adminId: string;
}

/**
 * Asserts that `work` rejects with an error whose message CHAIN (Drizzle wraps the
 * driver error, so the constraint/trigger name lives in the cause) matches `needle`.
 */
async function expectFailure(work: () => Promise<unknown>, needle: RegExp): Promise<void> {
  try {
    await work();
  } catch (error) {
    const chain: string[] = [];
    let current: unknown = error;
    while (typeof current === 'object' && current !== null) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === 'string') chain.push(message);
      current = (current as { cause?: unknown }).cause;
    }
    const all = chain.join(' | ');
    expect(all, `expected a failure matching ${String(needle)}, got: ${all}`).toMatch(needle);
    return;
  }
  throw new Error('expected the statement to fail, but it succeeded');
}

/** A migrated PGlite database + one org_admin user (the FK target of imported_by). */
async function createFixture(): Promise<Fixture> {
  const pg = new PGlite();
  const raw = drizzle(pg);
  await migrate(raw, { migrationsFolder: MIGRATIONS_FOLDER });
  const db = raw as unknown as DbClient;
  await pg.query(
    "insert into users (user_id, username, password_hash, role, is_active, created_at) values (gen_random_uuid(), 'admin', 'scrypt$x', 'org_admin', true, $1)",
    [INSTANT],
  );
  const admin = (
    await pg.query<{ user_id: string }>("select user_id from users where username = 'admin'")
  ).rows[0];
  if (admin === undefined) throw new Error('fixture admin missing');
  return { pg, db, editions: new DrizzlePricebookEditionRepository(db), adminId: admin.user_id };
}

/** Reads the in-repo verified staged 1404 file. */
function readStaged1404(): StagedPricebookFile {
  return JSON.parse(readFileSync(STAGED_1404_PATH, 'utf8')) as StagedPricebookFile;
}

/**
 * A complete edition record derived from the verified staged file — through the SAME
 * import gate (the derived file must pass it, including the verified-subset floor when
 * the id is the official one, so the full row set is always carried); only the identity
 * block is relabeled so a second edition can exist in tests without inventing any price
 * (the rows are verified 1404 rows verbatim).
 */
function derivedEdition(
  base: StagedPricebookFile,
  editionId: string,
  year: string,
): PricebookEdition {
  const file: StagedPricebookFile = {
    formatVersion: '1',
    kind: 'staged-import',
    edition: {
      ...base.edition,
      id: editionId,
      year,
      notificationNumber: null,
      notificationDate: null,
    },
    rows: base.rows,
  };
  const report = validateStagedImport(file);
  if (!report.ok) {
    throw new Error(`derived edition must pass the gate: ${JSON.stringify(report.errors)}`);
  }
  const content = canonicalContentOf(file);
  return {
    editionId,
    discipline: 'abniye',
    year,
    title: file.edition.title,
    organization: file.edition.organization,
    notificationNumber: null,
    notificationDate: null,
    sourceFileHash: file.edition.sourceFileHash ?? PINNED_1404_SOURCE_FILE_HASH,
    contentHash: contentHashOf(content),
    content,
    importReport: report,
    status: 'DRAFT',
    supersedesEditionId: null,
    importedBy: '00000000-0000-4000-8000-000000000001',
    importedAt: INSTANT,
    activatedBy: null,
    activatedAt: null,
    archivedBy: null,
    archivedAt: null,
  };
}

/** Persists a project + a first estimate version (edition year label '1404'). */
async function persistDraftVersion(fixture: Fixture, versionId: string): Promise<void> {
  const projects = new DrizzleProjectRepository(fixture.db);
  const estimates = new DrizzleEstimateRepository(fixture.db);
  const project = createProject({ projectId: PROJECT_ID, title: 't', createdAt: INSTANT });
  await projects.save(project);
  const estimate = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 't' });
  const dataset = publishStagedImport(readStaged1404());
  const updated = startEstimateVersion(dataset, estimate, {
    createdAt: INSTANT,
    buildingId: 'b1',
    versionId,
  });
  await estimates.save(updated);
}

describe('P8-B S1 schema — pricebook_editions and estimate_versions.edition_id', () => {
  it('creates the thirteenth table with the exact constraint family', async () => {
    const { pg } = await createFixture();
    const tables = (
      await pg.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      )
    ).rows.map((r) => r.tablename);
    expect(tables).toEqual([
      'audit_events',
      'boq_lines',
      'estimate_versions',
      'estimates',
      'finalized_estimates',
      'finalized_takeoffs',
      'pricebook_editions',
      'projects',
      'sessions',
      'takeoff_documents',
      'takeoff_lines',
      'takeoff_sheets',
      'users',
    ]);

    const columns = (
      await pg.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `select column_name, data_type, is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = 'pricebook_editions' order by ordinal_position`,
      )
    ).rows;
    expect(columns.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`)).toEqual([
      'edition_id:text:NO',
      'discipline:text:NO',
      'year:text:NO',
      'title:text:NO',
      'organization:text:NO',
      'notification_number:text:YES',
      'notification_date:text:YES',
      'source_file_hash:text:NO',
      'content_hash:text:NO',
      'content:jsonb:NO',
      'import_report:jsonb:NO',
      'status:text:NO',
      'supersedes_edition_id:text:YES',
      'imported_by:uuid:NO',
      'imported_at:text:NO',
      'activated_by:uuid:YES',
      'activated_at:text:YES',
      'archived_by:uuid:YES',
      'archived_at:text:YES',
    ]);

    const constraints = (
      await pg.query<{ constraint_name: string; constraint_type: string }>(
        `select constraint_name, constraint_type from information_schema.table_constraints
         where table_schema = 'public' and table_name = 'pricebook_editions'`,
      )
    ).rows;
    expect(constraints).toContainEqual({
      constraint_name: 'pricebook_editions_pkey',
      constraint_type: 'PRIMARY KEY',
    });
    expect(constraints).toContainEqual({
      constraint_name: 'pricebook_editions_content_hash_key',
      constraint_type: 'UNIQUE',
    });
    expect(constraints).toContainEqual({
      constraint_name: 'pricebook_editions_discipline_check',
      constraint_type: 'CHECK',
    });
    expect(constraints).toContainEqual({
      constraint_name: 'pricebook_editions_status_check',
      constraint_type: 'CHECK',
    });
    // the FK family: the supersedes self-reference (PostgreSQL truncates its long
    // generated name at 63 chars) + the three user references
    const fks = constraints
      .filter((c) => c.constraint_type === 'FOREIGN KEY')
      .map((c) => c.constraint_name)
      .sort();
    expect(fks).toEqual([
      'pricebook_editions_activated_by_users_user_id_fk',
      'pricebook_editions_archived_by_users_user_id_fk',
      'pricebook_editions_imported_by_users_user_id_fk',
      'pricebook_editions_supersedes_edition_id_pricebook_editions_edi',
    ]);

    const indexes = (
      await pg.query<{ indexname: string; indexdef: string }>(
        "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'pricebook_editions'",
      )
    ).rows;
    const oneActive = indexes.find((i) => i.indexname === 'pricebook_editions_one_active');
    expect(oneActive?.indexdef).toContain('UNIQUE INDEX');
    expect(oneActive?.indexdef).toContain('(discipline)');
    expect(oneActive?.indexdef).toContain("'ACTIVE'"); // the partial predicate is present
    expect(indexes.some((i) => i.indexname === 'pricebook_editions_status_idx')).toBe(true);
    await pg.close();
  });

  it('adds the additive estimate_versions.edition_id FK column (nullable; year label untouched)', async () => {
    const { pg } = await createFixture();
    const column = (
      await pg.query<{ data_type: string; is_nullable: string }>(
        `select data_type, is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = 'estimate_versions' and column_name = 'edition_id'`,
      )
    ).rows[0];
    expect(column).toEqual({ data_type: 'text', is_nullable: 'YES' });
    const fk = (
      await pg.query<{ constraint_name: string }>(
        `select constraint_name from information_schema.table_constraints
         where table_schema = 'public' and table_name = 'estimate_versions' and constraint_type = 'FOREIGN KEY'
         and constraint_name = 'estimate_versions_edition_id_pricebook_editions_edition_id_fk'`,
      )
    ).rows;
    expect(fk).toHaveLength(1);
    // the legacy year-label column is exactly its pre-P8-B shape
    const yearColumn = (
      await pg.query<{ data_type: string; is_nullable: string }>(
        `select data_type, is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = 'estimate_versions' and column_name = 'edition'`,
      )
    ).rows[0];
    expect(yearColumn).toEqual({ data_type: 'text', is_nullable: 'NO' });
    await pg.close();
  });

  it('enforces the CHECK constraints (V1 discipline = abniye; exactly three statuses)', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    const badDiscipline = {
      ...derivedEdition(base, 'bad-discipline', '1404'),
      discipline: 'electrical',
    };
    await expectFailure(
      () => editions.insertEdition(badDiscipline),
      /pricebook_editions_discipline_check/,
    );
    const badStatus = {
      ...derivedEdition(base, 'bad-status', '1404'),
      status: 'PUBLISHED' as unknown as PricebookEdition['status'],
    };
    await expectFailure(() => editions.insertEdition(badStatus), /pricebook_editions_status_check/);
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      importedBy: adminId,
    });
    expect(
      (await pg.query<{ n: string }>('select count(*)::text as n from pricebook_editions')).rows[0]
        ?.n,
    ).toBe('1');
    await pg.close();
  });
});

describe('P8-B S1 repository — lookups, the single insert write, content round-trip', () => {
  it('inserts once and finds by id, content hash and active discipline', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    const edition = {
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      status: 'ACTIVE' as const,
      importedBy: adminId,
    };
    await editions.insertEdition(edition);

    const byId = await editions.findByEditionId('ir-1404-abniye');
    expect(byId?.editionId).toBe('ir-1404-abniye');
    expect(byId?.status).toBe('ACTIVE');
    expect(byId?.discipline).toBe('abniye');
    expect(byId?.year).toBe('1404');
    expect(byId?.contentHash).toBe(edition.contentHash);
    expect(byId?.sourceFileHash).toBe(PINNED_1404_SOURCE_FILE_HASH);
    expect(byId?.importReport.ok).toBe(true);
    expect(byId?.importReport.rowCount).toBe(1564);

    expect(await editions.findByContentHash(edition.contentHash)).toBeDefined();
    expect(await editions.findByContentHash('0000')).toBeUndefined();

    const active = await editions.findActiveByDiscipline('abniye');
    expect(active?.editionId).toBe('ir-1404-abniye');
    expect(await editions.findActiveByDiscipline('electrical')).toBeUndefined();
    await pg.close();
  });

  it('refuses duplicate identity AND duplicate content (content-addressable semantics)', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    const first = { ...derivedEdition(base, 'ir-1404-abniye', '1404'), importedBy: adminId };
    await editions.insertEdition(first);
    await expectFailure(() => editions.insertEdition(first), /pricebook_editions_pkey/);
    // same content, different id → the UNIQUE content_hash refuses it
    const sameContent = {
      ...first,
      editionId: 'ir-1404-abniye-err1',
      supersedesEditionId: 'ir-1404-abniye',
    };
    await expectFailure(
      () => editions.insertEdition(sameContent),
      /pricebook_editions_content_hash_key/,
    );
    expect(
      (await pg.query<{ n: string }>('select count(*)::text as n from pricebook_editions')).rows[0]
        ?.n,
    ).toBe('1');
    await pg.close();
  });

  it('keeps contentHash stable across the JSONB round-trip (the §5 load identity)', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    // the FULL verified file: the exact content the seed persists
    const report = validateStagedImport(base);
    if (!report.ok) throw new Error('the verified staged file must pass the gate');
    const content = canonicalContentOf(base);
    const edition: PricebookEdition = {
      editionId: 'ir-1404-abniye',
      discipline: 'abniye',
      year: '1404',
      title: base.edition.title,
      organization: base.edition.organization,
      notificationNumber: base.edition.notificationNumber,
      notificationDate: base.edition.notificationDate,
      sourceFileHash: base.edition.sourceFileHash ?? PINNED_1404_SOURCE_FILE_HASH,
      contentHash: contentHashOf(content),
      content,
      importReport: report,
      status: 'ACTIVE',
      supersedesEditionId: null,
      importedBy: adminId,
      importedAt: INSTANT,
      activatedBy: adminId,
      activatedAt: INSTANT,
      archivedBy: null,
      archivedAt: null,
    };
    expect(edition.contentHash).toBe(PINNED_1404_CONTENT_HASH);
    await editions.insertEdition(edition);

    const reloaded = await editions.findByEditionId('ir-1404-abniye');
    if (reloaded === undefined) throw new Error('edition missing after insert');
    // recompute from the STORED content: identical hash — the §5 load identity holds
    expect(contentHashOf(reloaded.content)).toBe(PINNED_1404_CONTENT_HASH);
    expect(reloaded.content.rows).toHaveLength(1564);
    expect(reloaded.importReport.warningCount).toBe(11);
    await pg.close();
  });
});

describe('P8-B S1 immutability — the trigger guards hold for the connected owner too', () => {
  it('refuses UPDATEs of content, provenance and import-identity columns', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      importedBy: adminId,
    });
    const attempts = [
      `update pricebook_editions set title = 'forged' where edition_id = 'ir-1404-abniye'`,
      `update pricebook_editions set organization = 'forged' where edition_id = 'ir-1404-abniye'`,
      `update pricebook_editions set year = '1405' where edition_id = 'ir-1404-abniye'`,
      `update pricebook_editions set discipline = 'electrical' where edition_id = 'ir-1404-abniye'`,
      `update pricebook_editions set source_file_hash = 'forged' where edition_id = 'ir-1404-abniye'`,
      `update pricebook_editions set content_hash = 'forged' where edition_id = 'ir-1404-abniye'`,
      `update pricebook_editions set content = '{"edition":{}}'::jsonb where edition_id = 'ir-1404-abniye'`,
      `update pricebook_editions set import_report = '{"ok":false}'::jsonb where edition_id = 'ir-1404-abniye'`,
      `update pricebook_editions set imported_by = gen_random_uuid() where edition_id = 'ir-1404-abniye'`,
      `update pricebook_editions set imported_at = '2027-01-01T00:00:00Z' where edition_id = 'ir-1404-abniye'`,
      `update pricebook_editions set supersedes_edition_id = 'x' where edition_id = 'ir-1404-abniye'`,
    ];
    for (const statement of attempts) {
      await expectFailure(() => pg.query(statement), /is immutable/i);
    }
    expect(
      (await pg.query<{ n: string }>('select count(*)::text as n from pricebook_editions')).rows[0]
        ?.n,
    ).toBe('1');
    await pg.close();
  });

  it('refuses DELETE outright (editions are append-only)', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      importedBy: adminId,
    });
    await expectFailure(() => pg.query('delete from pricebook_editions'), /is never deleted/i);
    expect(
      (await pg.query<{ n: string }>('select count(*)::text as n from pricebook_editions')).rows[0]
        ?.n,
    ).toBe('1');
    await pg.close();
  });

  it('keeps the lifecycle columns writable for the later S2 routes', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    const inserted = { ...derivedEdition(base, 'ir-1404-abniye', '1404'), importedBy: adminId };
    await editions.insertEdition(inserted);
    await pg.query(
      `update pricebook_editions set status = 'ACTIVE', activated_by = $1, activated_at = $2
       where edition_id = 'ir-1404-abniye'`,
      [adminId, INSTANT],
    );
    const active = (
      await pg.query<{ status: string; activated_by: string | null }>(
        `select status, activated_by from pricebook_editions where edition_id = 'ir-1404-abniye'`,
      )
    ).rows[0];
    expect(active).toEqual({ status: 'ACTIVE', activated_by: adminId });

    await pg.query(
      `update pricebook_editions set status = 'ARCHIVED', archived_by = $1, archived_at = $2
       where edition_id = 'ir-1404-abniye'`,
      [adminId, INSTANT],
    );
    const archived = (
      await pg.query<{ status: string }>(
        `select status from pricebook_editions where edition_id = 'ir-1404-abniye'`,
      )
    ).rows[0];
    expect(archived?.status).toBe('ARCHIVED');

    // content untouched by every lifecycle write
    const reloaded = await editions.findByEditionId('ir-1404-abniye');
    expect(reloaded?.contentHash).toBe(inserted.contentHash);
    await pg.close();
  });

  it('enforces 0-or-1 ACTIVE per discipline through the partial unique index', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      status: 'ACTIVE',
      importedBy: adminId,
    });
    await expectFailure(
      () =>
        editions.insertEdition({
          ...derivedEdition(base, 'ir-1405-abniye', '1405'),
          status: 'ACTIVE',
          importedBy: adminId,
        }),
      /pricebook_editions_one_active/,
    );
    // ARCHIVED coexistence is fine; after archiving, a new ACTIVE is accepted
    await pg.query(`update pricebook_editions set status = 'ARCHIVED'`);
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1405-abniye', '1405'),
      status: 'ACTIVE',
      importedBy: adminId,
    });
    expect(
      (await pg.query<{ n: string }>('select count(*)::text as n from pricebook_editions')).rows[0]
        ?.n,
    ).toBe('2');
    await pg.close();
  });
});

describe('P8-B S1 version binding — stamp at insert, backfill once, immutable after', () => {
  it('leaves the binding NULL when no edition is active (nothing is guessed)', async () => {
    const fixture = await createFixture();
    await persistDraftVersion(fixture, 'v1');
    const row = (
      await fixture.pg.query<{ edition: string; edition_id: string | null }>(
        `select edition, edition_id from estimate_versions where version_id = 'v1'`,
      )
    ).rows[0];
    expect(row).toEqual({ edition: '1404', edition_id: null });
    await fixture.pg.close();
  });

  it('stamps a new version row with the ACTIVE edition (D-PB-3 rule A at persistence level)', async () => {
    const fixture = await createFixture();
    const base = readStaged1404();
    await fixture.editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      status: 'ACTIVE',
      importedBy: fixture.adminId,
    });
    await persistDraftVersion(fixture, 'v1');
    const row = (
      await fixture.pg.query<{ edition: string; edition_id: string | null }>(
        `select edition, edition_id from estimate_versions where version_id = 'v1'`,
      )
    ).rows[0];
    expect(row).toEqual({ edition: '1404', edition_id: 'ir-1404-abniye' });
    await fixture.pg.close();
  });

  it('backfills NULL bindings of matching-year rows exactly once; never rebinds', async () => {
    const fixture = await createFixture();
    // a pre-P8-B version exists BEFORE the edition (NULL binding, no ACTIVE edition yet)
    await persistDraftVersion(fixture, 'v1');
    // … and a second, different-year row that must NOT be bound by the 1404 backfill
    await fixture.pg.query(
      `insert into estimate_versions (version_id, estimate_id, version_number, status, created_at, edition, metadata)
       values ('v2', $1, 2, 'draft', $2, '1403', '{}')`,
      [ESTIMATE_ID, INSTANT],
    );
    const base = readStaged1404();
    const seeded = {
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      status: 'ACTIVE' as const,
      importedBy: fixture.adminId,
    };
    // the edition exists FIRST (the FK never dangles), then the backfill
    await fixture.editions.insertEdition(seeded);
    expect(await fixture.editions.backfillVersionEditionBindings(seeded)).toBe(1);
    const bound = (
      await fixture.pg.query<{ edition: string; edition_id: string | null }>(
        `select edition, edition_id from estimate_versions where version_id = 'v1'`,
      )
    ).rows[0];
    expect(bound).toEqual({ edition: '1404', edition_id: 'ir-1404-abniye' });
    const notBound = (
      await fixture.pg.query<{ edition: string; edition_id: string | null }>(
        `select edition, edition_id from estimate_versions where version_id = 'v2'`,
      )
    ).rows[0];
    expect(notBound).toEqual({ edition: '1403', edition_id: null });

    // idempotent: nothing left to bind
    expect(await fixture.editions.backfillVersionEditionBindings(seeded)).toBe(0);

    // the matching edition of the OTHER year binds exactly its own rows
    const edition1403 = {
      ...derivedEdition(base, 'test-1403-edition', '1403'),
      importedBy: fixture.adminId,
    };
    await fixture.editions.insertEdition(edition1403);
    expect(await fixture.editions.backfillVersionEditionBindings(edition1403)).toBe(1);
    const bound1403 = (
      await fixture.pg.query<{ edition: string; edition_id: string | null }>(
        `select edition, edition_id from estimate_versions where version_id = 'v2'`,
      )
    ).rows[0];
    expect(bound1403).toEqual({ edition: '1403', edition_id: 'test-1403-edition' });
    await fixture.pg.close();
  });

  it('makes a set binding immutable: no change, no clear', async () => {
    const fixture = await createFixture();
    await persistDraftVersion(fixture, 'v1');
    const base = readStaged1404();
    const seeded = {
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      status: 'ACTIVE' as const,
      importedBy: fixture.adminId,
    };
    await fixture.editions.insertEdition(seeded);
    await fixture.editions.backfillVersionEditionBindings(seeded);
    await expectFailure(
      () =>
        fixture.pg.query(
          `update estimate_versions set edition_id = 'ir-1405-abniye' where version_id = 'v1'`,
        ),
      /edition binding is immutable/i,
    );
    await expectFailure(
      () =>
        fixture.pg.query(`update estimate_versions set edition_id = null where version_id = 'v1'`),
      /edition binding is immutable/i,
    );
    const row = (
      await fixture.pg.query<{ edition_id: string | null }>(
        `select edition_id from estimate_versions where version_id = 'v1'`,
      )
    ).rows[0];
    expect(row?.edition_id).toBe('ir-1404-abniye');
    await fixture.pg.close();
  });
});

/* ------------------------------------------------------------------------------------------------
 * P8-B S2 — the lifecycle repository writes: list, guarded activate, guarded archive
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S2 repository — listEditions and the two guarded lifecycle writes', () => {
  it('lists every edition in the deterministic (importedAt, editionId) order', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    // three editions with deliberately shuffled insertion order and distinct importedAt
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1405-abniye', '1405'),
      importedBy: adminId,
      importedAt: '2026-03-01T00:00:00Z',
    });
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      importedBy: adminId,
      importedAt: '2026-01-01T00:00:00Z',
    });
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye-err1', '1404'),
      importedBy: adminId,
      importedAt: '2026-01-01T00:00:00Z', // SAME instant as 1404 → editionId breaks the tie
    });
    const list = await editions.listEditions();
    expect(list.map((edition) => edition.editionId)).toEqual([
      'ir-1404-abniye',
      'ir-1404-abniye-err1',
      'ir-1405-abniye',
    ]);
    await pg.close();
  });

  it('activateEdition archives the still-ACTIVE previous edition and stamps the target (clearing stale archive columns)', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      status: 'ACTIVE',
      importedBy: adminId,
    });
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1405-abniye', '1405'),
      importedBy: adminId,
      // a stale archive stamp from an earlier lifecycle of the same immutable content
      archivedBy: adminId,
      archivedAt: '2025-12-01T00:00:00Z',
    });
    const won = await editions.activateEdition(
      'ir-1405-abniye',
      adminId,
      '2026-06-01T00:00:00Z',
      'ir-1404-abniye',
    );
    expect(won).toBe(true);
    const rows = (
      await pg.query<{
        edition_id: string;
        status: string;
        activated_by: string | null;
        activated_at: string | null;
        archived_by: string | null;
        archived_at: string | null;
      }>(
        'select edition_id, status, activated_by, activated_at, archived_by, archived_at from pricebook_editions order by edition_id',
      )
    ).rows;
    expect(rows).toEqual([
      {
        edition_id: 'ir-1404-abniye',
        status: 'ARCHIVED',
        activated_by: null,
        activated_at: null,
        archived_by: adminId,
        archived_at: '2026-06-01T00:00:00Z',
      },
      {
        edition_id: 'ir-1405-abniye',
        status: 'ACTIVE',
        activated_by: adminId,
        activated_at: '2026-06-01T00:00:00Z',
        archived_by: null, // the stale stamp of the earlier lifecycle is cleared
        archived_at: null,
      },
    ]);
    await pg.close();
  });

  it('activateEdition returns false for an already-ACTIVE target (the sequential 409) and leaves everything untouched', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      status: 'ACTIVE',
      importedBy: adminId,
    });
    const before = (
      await pg.query('select * from pricebook_editions order by edition_id')
    ).rows.map((row) => JSON.stringify(row));
    const won = await editions.activateEdition(
      'ir-1404-abniye',
      adminId,
      '2026-06-01T00:00:00Z',
      null,
    );
    expect(won).toBe(false);
    const after = (await pg.query('select * from pricebook_editions order by edition_id')).rows.map(
      (row) => JSON.stringify(row),
    );
    expect(after).toEqual(before); // zero mutation, zero events is the caller's contract
    await pg.close();
  });

  it("activateEdition surfaces the one_active unique violation when the caller's previous-active read went stale (the §9 race outcome)", async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      status: 'ACTIVE',
      importedBy: adminId,
    });
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1405-abniye', '1405'),
      importedBy: adminId,
    });
    // The race: this caller read NO previous active edition (another activation won
    // and committed in between), so it archives nothing and activates its target —
    // the partial unique index refuses the second ACTIVE row, deterministically.
    await expectFailure(
      () => editions.activateEdition('ir-1405-abniye', adminId, '2026-06-01T00:00:00Z', null),
      /pricebook_editions_one_active/,
    );
    // the winner is untouched — still the only ACTIVE edition
    expect(
      (
        await pg.query<{ edition_id: string }>(
          "select edition_id from pricebook_editions where status = 'ACTIVE'",
        )
      ).rows.map((row) => row.edition_id),
    ).toEqual(['ir-1404-abniye']);
    await pg.close();
  });

  it('archiveEdition guards the already-ARCHIVED target (false, zero mutation) and stamps DRAFT/ACTIVE alike', async () => {
    const { pg, editions, adminId } = await createFixture();
    const base = readStaged1404();
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1404-abniye', '1404'),
      status: 'ACTIVE',
      importedBy: adminId,
    });
    await editions.insertEdition({
      ...derivedEdition(base, 'ir-1405-abniye', '1405'),
      importedBy: adminId,
    });
    const first = await editions.archiveEdition('ir-1405-abniye', adminId, '2026-06-01T00:00:00Z');
    expect(first).toBe(true);
    const second = await editions.archiveEdition('ir-1405-abniye', adminId, '2026-06-02T00:00:00Z');
    expect(second).toBe(false); // already archived — the sequential 409
    const row = (
      await pg.query<{ status: string; archived_by: string | null; archived_at: string | null }>(
        'select status, archived_by, archived_at from pricebook_editions where edition_id = $1',
        ['ir-1405-abniye'],
      )
    ).rows[0];
    expect(row).toEqual({
      status: 'ARCHIVED',
      archived_by: adminId,
      archived_at: '2026-06-01T00:00:00Z',
    });
    // ACTIVE → ARCHIVED (the 0-active path)
    const active = await editions.archiveEdition('ir-1404-abniye', adminId, '2026-06-03T00:00:00Z');
    expect(active).toBe(true);
    expect(
      (
        await pg.query<{ n: string }>(
          "select count(*)::text as n from pricebook_editions where status = 'ACTIVE'",
        )
      ).rows[0]?.n,
    ).toBe('0');
    await pg.close();
  });
});
