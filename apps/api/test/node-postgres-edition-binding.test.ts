/**
 * P8-B S3 — edition binding on a REAL PostgreSQL server
 * (CG-IR-PRICEBOOK-SPEC@0.2.0 §12/§13/§17/§21, D-PB-3 = B).
 *
 * GATED BY ENVIRONMENT: runs only when `COSTGENIUS_SMOKE_DATABASE_URL` points at a
 * DISPOSABLE dedicated verification database (exactly like the other node-postgres
 * suites). The complete S3 selection/resolution matrix on a REAL server:
 *
 * A. DEFAULT BINDING — version creation with an omitted editionId binds the ACTIVE
 *    edition and persists `edition_id` (the API resolves; the stamp is only the net).
 * B. EXPLICIT ACTIVE — an explicit ACTIVE editionId is persisted verbatim.
 * C. EXPLICIT ARCHIVED — an explicit ARCHIVED editionId binds exactly it while
 *    another edition is ACTIVE.
 * D. EXPLICIT ARCHIVED AT ZERO ACTIVE — still binds (the contract-edition driver).
 * E. DRAFT REJECTION — a DRAFT editionId answers 409 EDITION_NOT_SELECTABLE with
 *    zero mutation and zero events.
 * F. UNKNOWN — 404 EDITION_NOT_FOUND, zero mutation, zero events.
 * G. ZERO-ACTIVE DEFAULT — an omitted editionId with zero ACTIVE editions answers
 *    409 EDITION_NOT_ACTIVE, zero mutation, zero events.
 * H. IMMUTABLE BINDING — the database trigger refuses rebinding and clearing.
 * I. SECOND EDITION ACTIVE — an existing version stays bound to the first edition.
 * J. LINE-ADD RESOLUTION — the target version's bound edition prices the lines.
 * K. ARCHIVED-USABLE — a version whose edition got archived keeps resolving it.
 * L. TAKEOFF TRANSFER — the target version's bound edition prices the transfer.
 * M. ROWS MATRIX — explicit ACTIVE/ARCHIVED searched, DRAFT refused, unknown 404.
 * N. AUDIT — estimate_version.created details carry {versionNumber, editionId}.
 * O. ZERO EVENTS — every denied operation writes no audit row.
 * P. THE STAMP TRIGGER — an insert carrying an EXPLICIT edition_id BYPASSES the
 *    NULL→ACTIVE stamp; a NULL insert is still stamped with the ACTIVE edition.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
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
import {
  createEstimateForProject,
  createProject,
  startEstimateVersion,
  type Actor,
} from '@costgenius/projects';
import {
  publishStagedImport,
  validateStagedImport,
  type StagedPricebookFile,
} from '@costgenius/pricebook';
import { createApiServer, ensureBootstrapAdmin, seedPricebookEdition } from '../src/index.js';
import { activatePricebookEdition, importPricebookEdition } from '../src/pricebook-lifecycle.js';
import {
  attachAuthenticatedServer,
  bindRepositories,
  TEST_ADMIN,
  transactOver,
} from './helpers.js';
import { readFileSync } from 'node:fs';

const SMOKE_URL = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;
const STAGED_1404_PATH = new URL(
  '../../../packages/pricebook/data/verified-1404.staged.v0.1.0.json',
  import.meta.url,
).pathname;

const INSTANT = '2026-01-01T00:00:00Z';
const SEED_EDITION = 'ir-1404-abniye';
const PROJECT_ID = 'a5b30000-0000-4000-8000-000000000001';
const ESTIMATE_ID = 'b6c40000-0000-4000-8000-000000000002';

/**
 * A synthetic staged file whose rows carry the '1412' edition label and a
 * distinguishable price for the shared code 010301 (official: 3065000; here: 7777).
 */
function syntheticStagedFile(tag: string): StagedPricebookFile {
  const file = {
    formatVersion: '1',
    kind: 'staged-import',
    edition: {
      id: `ir-1412-abniye-${tag}`,
      title: 'فهرست آزمونی رشته ابنیه',
      organization: 'سازمان برنامه و بودجه کشور',
      year: '1412',
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
          edition: '1412',
          printedPage: '11',
          section: 'Chapter 1, Group 1',
          sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
        },
        externalDependencies: [],
        notes: [],
      },
      {
        code: '010301',
        chapter: 'chapter-3',
        group: '1',
        description: `تخریب آزمونی ${tag}`,
        unit: { label: 'مترمربع', code: 'm2' },
        basePrice: '7777',
        status: 'VERIFIED_SPEC_ONLY',
        sourceRef: {
          sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
          edition: '1412',
          printedPage: '31',
          section: 'Chapter 3, Group 1',
          sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
        },
        externalDependencies: [],
        notes: [],
      },
    ],
  } as const;
  const report = validateStagedImport(file);
  if (!report.ok) {
    throw new Error(`synthetic staged file must pass the gate: ${JSON.stringify(report.errors)}`);
  }
  return file;
}

describe.skipIf(SMOKE_URL === undefined)('P8-B S3 edition binding (real PostgreSQL server)', () => {
  let db: DbClient;
  let pool: Pool;
  let app: ReturnType<typeof createApiServer>;
  let steward: Actor;
  let admin: Actor;
  let closePool: () => Promise<void>;

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

    pool = createDbPool(SMOKE_URL as string);
    db = createDb(pool);
    await migrateDatabase(db, MIGRATIONS_FOLDER);
    const userStore = new DrizzleUserRepository(db);
    const sessionStore = new DrizzleSessionRepository(db);
    await ensureBootstrapAdmin(
      { users: userStore, sessions: sessionStore, clock: () => INSTANT },
      {
        bootstrapAdminUsername: TEST_ADMIN.username,
        bootstrapAdminPassword: TEST_ADMIN.password,
      },
    );
    await seedPricebookEdition({
      users: userStore,
      editions: new DrizzlePricebookEditionRepository(db),
      transact: transactOver(db),
      clock: () => INSTANT,
    });
    // a second REAL user — the importing steward (four-eyes counterpart of the admin)
    await pool.query(
      `insert into users (user_id, username, password_hash, role, is_active, created_at)
         values ('11111111-2222-4333-8444-555555555555', 'binding-steward', 'scrypt$x', 'data_steward', true, $1)`,
      [INSTANT],
    );
    steward = { userId: '11111111-2222-4333-8444-555555555555', username: 'binding-steward' };
    const adminRow = (
      await pool.query<{ user_id: string }>(
        `select user_id from users where username = '${TEST_ADMIN.username}'`,
      )
    ).rows[0];
    if (adminRow === undefined) throw new Error('bootstrap admin missing');
    admin = { userId: adminRow.user_id, username: TEST_ADMIN.username };

    const poolBound = bindRepositories(db);
    app = (
      await attachAuthenticatedServer(
        createApiServer({
          repositories: {
            projects: poolBound.projects,
            estimates: poolBound.estimates,
            finalized: poolBound.finalized,
            takeoffDocuments: poolBound.takeoffDocuments,
            finalizedTakeoffs: poolBound.finalizedTakeoffs,
            editions: poolBound.editions,
          },
          governance: { users: userStore, sessions: sessionStore, audit: poolBound.audit },
          clock: () => INSTANT,
          transact: transactOver(db),
        }),
      )
    ).app;
    closePool = () => pool.end();
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it('default binding: an omitted editionId binds the ACTIVE edition — response and row', async () => {
    await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: PROJECT_ID, title: 'پروژه' },
    });
    await app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/estimates`,
      payload: { estimateId: ESTIMATE_ID, title: 'برآورد' },
    });
    const created = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: { buildingId: 'b', versionId: 'rg-default-v1' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ editionId?: string }>().editionId).toBe(SEED_EDITION);
    const row = (
      await pool.query<{ edition_id: string | null }>(
        `select edition_id from estimate_versions where version_id = 'rg-default-v1'`,
      )
    ).rows[0];
    expect(row?.edition_id).toBe(SEED_EDITION);
  });

  it('DRAFT rejection: 409 EDITION_NOT_SELECTABLE, zero mutation', async () => {
    const draft = await importPricebookEdition(
      {
        editions: new DrizzlePricebookEditionRepository(db),
        transact: transactOver(db),
        clock: () => INSTANT,
      },
      steward,
      syntheticStagedFile('rg'),
    );
    const denied = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: {
        buildingId: 'b',
        versionId: 'rg-draft-denied-v2',
        editionId: draft.edition.editionId,
      },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe('EDITION_NOT_SELECTABLE');
    const count = (
      await pool.query<{ n: string }>(
        `select count(*)::text as n from estimate_versions where version_id = 'rg-draft-denied-v2'`,
      )
    ).rows[0];
    expect(count?.n).toBe('0');
    // O — the denial writes NO audit row (no event without its mutation)
    const deniedEvents = (
      await pool.query<{ n: string }>(
        `select count(*)::text as n from audit_events where resource_id = 'rg-draft-denied-v2'`,
      )
    ).rows[0];
    expect(deniedEvents?.n).toBe('0');
  });

  it('per-version resolution: with the second edition ACTIVE, the 1404-bound version still prices 1404', async () => {
    // the handover: the steward imported it, the ADMIN activates (four-eyes)
    await activatePricebookEdition(
      {
        editions: new DrizzlePricebookEditionRepository(db),
        transact: transactOver(db),
        clock: () => INSTANT,
      },
      admin,
      'ir-1412-abniye-rg',
    );
    const active = (
      await pool.query<{ edition_id: string }>(
        `select edition_id from pricebook_editions where status = 'ACTIVE'`,
      )
    ).rows[0];
    expect(active?.edition_id).toBe('ir-1412-abniye-rg');

    // the OLD version (bound to the now-ARCHIVED 1404) still resolves 1404 rows at
    // 1404 prices — 010301 is 3065000 in 1404 and 7777 in the ACTIVE 1412 edition
    const added = await app.inject({
      method: 'POST',
      url: '/estimate-versions/rg-default-v1/lines',
      payload: { lines: [{ lineId: 'l1', pricebookCode: '010301', quantity: '3', unit: 'm2' }] },
    });
    expect(added.statusCode).toBe(200);
    const line = added
      .json<{ lines: { lineId: string; basePrice: string | null }[] }>()
      .lines.find((l) => l.lineId === 'l1');
    expect(line?.basePrice).toBe('3065000');

    // a NEW version now defaults to the new ACTIVE edition (rows labelled '1412')
    const created = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: { buildingId: 'b', versionId: 'rg-new-active-v2' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ edition: string; editionId?: string }>();
    expect(body.editionId).toBe('ir-1412-abniye-rg');
    expect(body.edition).toBe('1412');
  });

  it('explicit ARCHIVED binding: bound exactly, while another edition is ACTIVE', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: { buildingId: 'b', versionId: 'rg-archived-v3', editionId: SEED_EDITION },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ editionId?: string }>().editionId).toBe(SEED_EDITION);
    const row = (
      await pool.query<{ edition_id: string | null }>(
        `select edition_id from estimate_versions where version_id = 'rg-archived-v3'`,
      )
    ).rows[0];
    expect(row?.edition_id).toBe(SEED_EDITION);
  });

  it('the stamp trigger on a real server: an EXPLICIT edition_id bypasses the stamp; a NULL insert is stamped', async () => {
    // ACTIVE is ir-1412-abniye-rg; an explicit insert bound to the ARCHIVED 1404
    // must persist 1404 VERBATIM — the NULL→ACTIVE stamp must NOT overwrite it
    const projects = new DrizzleProjectRepository(db);
    const estimates = new DrizzleEstimateRepository(db);
    const project = createProject({
      projectId: 'c7d50000-0000-4000-8000-000000000003',
      title: 't',
      createdAt: INSTANT,
    });
    await projects.save(project);
    const estimate = createEstimateForProject(project, {
      estimateId: 'd8e60000-0000-4000-8000-000000000004',
      title: 't',
    });
    const dataset = publishStagedImport(
      JSON.parse(readFileSync(STAGED_1404_PATH, 'utf8')) as unknown,
    );
    const explicit = startEstimateVersion(dataset, estimate, {
      createdAt: INSTANT,
      buildingId: 'b1',
      versionId: 'rg-explicit-stamp-v1',
      editionId: SEED_EDITION,
    });
    await estimates.save(explicit);
    const explicitRow = (
      await pool.query<{ edition_id: string | null }>(
        `select edition_id from estimate_versions where version_id = 'rg-explicit-stamp-v1'`,
      )
    ).rows[0];
    expect(explicitRow?.edition_id).toBe(SEED_EDITION); // NOT the ACTIVE 1412 edition

    // and the NULL insert is still stamped with the ACTIVE edition (the S1 net)
    const nullInserted = startEstimateVersion(dataset, explicit, {
      createdAt: INSTANT,
      buildingId: 'b1',
      versionId: 'rg-null-stamp-v2',
    });
    await estimates.save(nullInserted);
    const nullRow = (
      await pool.query<{ edition_id: string | null }>(
        `select edition_id from estimate_versions where version_id = 'rg-null-stamp-v2'`,
      )
    ).rows[0];
    expect(nullRow?.edition_id).toBe('ir-1412-abniye-rg');
  });

  it('B — an explicit ACTIVE editionId binds exactly it (persisted verbatim)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: {
        buildingId: 'b',
        versionId: 'rg-explicit-active-v4',
        editionId: 'ir-1412-abniye-rg',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ editionId?: string }>().editionId).toBe('ir-1412-abniye-rg');
    const row = (
      await pool.query<{ edition_id: string | null }>(
        `select edition_id from estimate_versions where version_id = 'rg-explicit-active-v4'`,
      )
    ).rows[0];
    expect(row?.edition_id).toBe('ir-1412-abniye-rg');
  });

  it('F — an unknown editionId is 404 EDITION_NOT_FOUND, zero mutation, zero events', async () => {
    const before = (await pool.query<{ n: string }>('select count(*)::text as n from audit_events'))
      .rows[0];
    const denied = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: { buildingId: 'b', versionId: 'rg-unknown-v5', editionId: 'ir-9999-abniye-none' },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe('EDITION_NOT_FOUND');
    const count = (
      await pool.query<{ n: string }>(
        `select count(*)::text as n from estimate_versions where version_id = 'rg-unknown-v5'`,
      )
    ).rows[0];
    expect(count?.n).toBe('0');
    const after = (await pool.query<{ n: string }>('select count(*)::text as n from audit_events'))
      .rows[0];
    expect(after?.n).toBe(before?.n);
  });

  it('N — estimate_version.created audits exactly {versionNumber, editionId}', async () => {
    const events = await pool.query<{ details: unknown }>(
      "SELECT details FROM audit_events WHERE action = 'estimate_version.created' AND resource_id = $1",
      ['rg-default-v1'],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.details).toEqual({ versionNumber: 1, editionId: SEED_EDITION });
    const explicitEvents = await pool.query<{ details: unknown }>(
      "SELECT details FROM audit_events WHERE action = 'estimate_version.created' AND resource_id = $1",
      ['rg-explicit-active-v4'],
    );
    expect(explicitEvents.rows).toHaveLength(1);
    expect(explicitEvents.rows[0]?.details).toEqual({
      versionNumber: 4,
      editionId: 'ir-1412-abniye-rg',
    });
  });

  it('M — rows?editionId=: ACTIVE and ARCHIVED searched, DRAFT refused, unknown 404', async () => {
    // a fresh DRAFT for the refusal leg
    const draft = await importPricebookEdition(
      {
        editions: new DrizzlePricebookEditionRepository(db),
        transact: transactOver(db),
        clock: () => INSTANT,
      },
      steward,
      syntheticStagedFile('rg2'),
    );
    const archived = await app.inject({
      method: 'GET',
      url: `/pricebook/rows?search=0103&editionId=${SEED_EDITION}`,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ edition: string }>().edition).toBe(SEED_EDITION);
    const active = await app.inject({
      method: 'GET',
      url: `/pricebook/rows?search=0103&editionId=ir-1412-abniye-rg`,
    });
    expect(active.statusCode).toBe(200);
    expect(active.json<{ edition: string }>().edition).toBe('ir-1412-abniye-rg');
    const draftRefused = await app.inject({
      method: 'GET',
      url: `/pricebook/rows?search=0101&editionId=${draft.edition.editionId}`,
    });
    expect(draftRefused.statusCode).toBe(409);
    expect(draftRefused.json<{ error: { code: string } }>().error.code).toBe(
      'EDITION_NOT_SELECTABLE',
    );
    const unknown = await app.inject({
      method: 'GET',
      url: '/pricebook/rows?search=0101&editionId=ir-9999-abniye-none',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('EDITION_NOT_FOUND');
  });

  it("L — takeoff transfer prices against the TARGET VERSION's bound edition", async () => {
    const projectId = 'e9f70000-0000-4000-8000-000000000005';
    const documentId = 'f1080000-0000-4000-8000-000000000006';
    const takeoffId = '02190000-0000-4000-8000-000000000007';
    const estimateId = '132a0000-0000-4000-8000-000000000008';
    await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId, title: 'پروژه انتقال' },
    });
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/estimates`,
      payload: { estimateId, title: 'برآورد انتقال' },
    });
    // one 010301 item, dimensional 2.1 × 2 = 4.2 m2
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/takeoffs`,
      payload: { takeoffId, documentId, title: 'ریز متره' },
    });
    const saved = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/takeoffs/${documentId}/save`,
      payload: {
        expectedRevision: 1,
        title: 'ریز متره',
        rounding: [],
        sheets: [
          {
            sheetId: 'S1',
            name: 'برگه',
            lines: [
              {
                lineId: 'A',
                rowNo: 1,
                description: 'تخریب',
                itemCode: '010301',
                kind: 'addition',
                unit: 'm2',
                quantity: { type: 'dimensional', profile: 'LW', length: '2.1', width: '2' },
              },
            ],
          },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    const finalized = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/takeoffs/${documentId}/finalize`,
      payload: { expectedRevision: 2 },
    });
    expect(finalized.statusCode).toBe(201);

    // the 1404-bound version (explicit ARCHIVED — 1412 is ACTIVE) prices 3065000 × 4.2
    const bound1404 = await app.inject({
      method: 'POST',
      url: `/estimates/${estimateId}/versions`,
      payload: { buildingId: 'b', versionId: 'rg-transfer-1404-v1', editionId: SEED_EDITION },
    });
    expect(bound1404.statusCode).toBe(201);
    const transfer1404 = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/takeoffs/${documentId}/transfer-to-boq`,
      payload: { versionId: 'rg-transfer-1404-v1' },
    });
    expect(transfer1404.statusCode).toBe(200);
    expect(
      transfer1404.json<{ lines: { lineAmount: string | null }[] }>().lines[0]?.lineAmount,
    ).toBe('12873000'); // 3065000 × 4.2 — NEVER the ACTIVE edition's 7777

    // the default (ACTIVE 1412) version prices 7777 × 4.2 — the symmetric proof
    const bound1412 = await app.inject({
      method: 'POST',
      url: `/estimates/${estimateId}/versions`,
      payload: { buildingId: 'b', versionId: 'rg-transfer-1412-v2' },
    });
    expect(bound1412.statusCode).toBe(201);
    const transfer1412 = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/takeoffs/${documentId}/transfer-to-boq`,
      payload: { versionId: 'rg-transfer-1412-v2' },
    });
    expect(transfer1412.statusCode).toBe(200);
    expect(
      transfer1412.json<{ lines: { lineAmount: string | null }[] }>().lines[0]?.lineAmount,
    ).toBe('32663.4'); // 7777 × 4.2
  });

  it('H — the database trigger refuses rebinding and clearing an existing binding', async () => {
    const rebind = await pool
      .query(
        `UPDATE estimate_versions SET edition_id = 'ir-1412-abniye-rg' WHERE version_id = 'rg-default-v1'`,
      )
      .then(
        () => 'unexpectedly-allowed',
        (e: unknown) => (e as Error).message,
      );
    expect(rebind).toMatch(/edition binding is immutable/i);
    const clear = await pool
      .query(`UPDATE estimate_versions SET edition_id = NULL WHERE version_id = 'rg-default-v1'`)
      .then(
        () => 'unexpectedly-allowed',
        (e: unknown) => (e as Error).message,
      );
    expect(clear).toMatch(/edition binding is immutable/i);
    const row = (
      await pool.query<{ edition_id: string | null }>(
        `select edition_id from estimate_versions where version_id = 'rg-default-v1'`,
      )
    ).rows[0];
    expect(row?.edition_id).toBe(SEED_EDITION);
  });

  it('G+D — zero ACTIVE: omitted → 409 EDITION_NOT_ACTIVE (zero mutation/zero events); explicit ARCHIVED still binds', async () => {
    const archivedEdition = await app.inject({
      method: 'POST',
      url: '/pricebook/editions/ir-1412-abniye-rg/archive',
    });
    expect(archivedEdition.statusCode).toBe(200);
    const before = (await pool.query<{ n: string }>('select count(*)::text as n from audit_events'))
      .rows[0];
    const denied = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: { buildingId: 'b', versionId: 'rg-zero-active-v6' },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe('EDITION_NOT_ACTIVE');
    const count = (
      await pool.query<{ n: string }>(
        `select count(*)::text as n from estimate_versions where version_id = 'rg-zero-active-v6'`,
      )
    ).rows[0];
    expect(count?.n).toBe('0');
    const after = (await pool.query<{ n: string }>('select count(*)::text as n from audit_events'))
      .rows[0];
    expect(after?.n).toBe(before?.n);

    // D — the contract-edition driver: an explicit ARCHIVED edition binds at zero ACTIVE
    const created = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: {
        buildingId: 'b',
        versionId: 'rg-zero-active-explicit-v6',
        editionId: SEED_EDITION,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ editionId?: string }>().editionId).toBe(SEED_EDITION);
    const row = (
      await pool.query<{ edition_id: string | null }>(
        `select edition_id from estimate_versions where version_id = 'rg-zero-active-explicit-v6'`,
      )
    ).rows[0];
    expect(row?.edition_id).toBe(SEED_EDITION);
  });
});
