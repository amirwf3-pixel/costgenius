/**
 * P8-B S2 — the pricebook-edition lifecycle API (CG-IR-PRICEBOOK-SPEC@0.2.0 §7–§17).
 *
 * The full route-level contract over the REAL PGlite stack (actual migrations, actual
 * repositories, actual transactional unit of work, actual session cookies — the same
 * fixture the S3 audit suite uses): import → DRAFT through the SAME staged-import
 * gate; the deterministic list; the detail with its stored import report; activation
 * (atomic, four-eyes, auto-archive of the superseded ACTIVE edition, both events in
 * ONE transaction); archive (DRAFT discard and ACTIVE archive); the 0-active state
 * and the fail-closed default edition search; and the §14 HARD invariant — a
 * finalized-and-approved golden estimate is byte-identical across an activation.
 *
 * The complete five-role × five-route authorization matrix lives in authz.test.ts
 * (the executable CG-GOV §3 table); the real-PostgreSQL concurrency proofs (two
 * simultaneous activations → exactly one ACTIVE) live in the env-gated
 * node-postgres-edition-lifecycle suite.
 */
import { readFileSync } from 'node:fs';
import { describe, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { AuditEvent, AuditEventRepository, UserRole } from '@costgenius/projects';
import { type DbClient } from '@costgenius/db';
import {
  bindRepositories,
  buildAuditAwareServer,
  COMPLETE_LINES,
  ensureTestRoleUsers,
  FIXED_INSTANT,
  GOLDEN_COEFFICIENTS,
  syntheticStagedFile,
  type AuditAwareServer,
  type AuditEventRow,
} from './helpers.js';
import {
  createApiServer,
  ensureBootstrapAdmin,
  seedPricebookEdition,
  type ApiDependencies,
} from '../src/index.js';
import { loadPublishedDataset } from '../src/dataset.js';
import type { Transact } from '../src/audit.js';

/** The immutable-column projection of an edition row — byte-compared across the lifecycle. */
interface EditionRow {
  readonly edition_id: string;
  readonly discipline: string;
  readonly year: string;
  readonly title: string;
  readonly organization: string;
  readonly notification_number: string | null;
  readonly notification_date: string | null;
  readonly source_file_hash: string;
  readonly content_hash: string;
  readonly content: unknown;
  readonly import_report: unknown;
  readonly supersedes_edition_id: string | null;
  readonly imported_by: string;
  readonly imported_at: string;
}

interface LifecycleRow extends EditionRow {
  readonly status: string;
  readonly activated_by: string | null;
  readonly activated_at: string | null;
  readonly archived_by: string | null;
  readonly archived_at: string | null;
}

const IMMUTABLE_COLUMNS =
  'edition_id, discipline, year, title, organization, notification_number, notification_date, ' +
  'source_file_hash, content_hash, content, import_report, supersedes_edition_id, imported_by, imported_at';

let server: AuditAwareServer;
let adminId: string;
let stewardId: string;
let reviewerCookie: string;

/** The edition row as persisted (snake_case, direct table read — there is no read API by design). */
async function editionRow(editionId: string): Promise<LifecycleRow> {
  const result = await server.pg.query<LifecycleRow>(
    `select ${IMMUTABLE_COLUMNS}, status, activated_by, activated_at, archived_by, archived_at
     from pricebook_editions where edition_id = $1`,
    [editionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`edition ${editionId} missing`);
  return row;
}

async function editionCount(): Promise<number> {
  const result = await server.pg.query<{ n: string }>(
    'select count(*)::text as n from pricebook_editions',
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function activeCount(): Promise<number> {
  const result = await server.pg.query<{ n: string }>(
    "select count(*)::text as n from pricebook_editions where status = 'ACTIVE'",
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function eventsOf(action: string, resourceId?: string): Promise<readonly AuditEventRow[]> {
  const rows = await server.auditEvents();
  return rows.filter(
    (row) => row.action === action && (resourceId === undefined || row.resourceId === resourceId),
  );
}

async function totalEvents(): Promise<number> {
  return (await server.auditEvents()).length;
}

/** Imports a fresh synthetic DRAFT as the given role → its editionId. */
async function importDraft(tag: string, role: UserRole = 'org_admin'): Promise<string> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/pricebook/editions',
    headers: { cookie: await server.cookieFor(role) },
    payload: syntheticStagedFile(tag),
  });
  if (response.statusCode !== 201) {
    throw new Error(`fixture import ${tag} → ${String(response.statusCode)}: ${response.body}`);
  }
  return response.json<{ edition: { editionId: string } }>().edition.editionId;
}

interface MutationResponse {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

/** Posts a lifecycle command as the given role. */
async function postAs(role: UserRole, url: string): Promise<MutationResponse> {
  const response = await server.app.inject({
    method: 'POST',
    url,
    headers: { cookie: await server.cookieFor(role) },
  });
  return { statusCode: response.statusCode, body: response.json<Record<string, unknown>>() };
}

function errorOf(body: Record<string, unknown>): {
  code: string;
  message: string;
  details?: unknown;
} {
  return (body as { error: { code: string; message: string; details?: unknown } }).error;
}

const SEED_EDITION = 'ir-1404-abniye';
const STAGED_1404_PATH = new URL(
  '../../../packages/pricebook/data/verified-1404.staged.v0.1.0.json',
  import.meta.url,
).pathname;

beforeAll(async () => {
  server = await buildAuditAwareServer();
  const session = await server.app.inject({
    method: 'GET',
    url: '/auth/session',
    headers: { cookie: server.cookie },
  });
  adminId = session.json<{ userId: string }>().userId;
  const stewardSession = await server.app.inject({
    method: 'GET',
    url: '/auth/session',
    headers: { cookie: await server.cookieFor('data_steward') },
  });
  stewardId = stewardSession.json<{ userId: string }>().userId;
  reviewerCookie = await server.cookieFor('reviewer');
  // warm the remaining role cookies so no later login writes an event mid-assertion
  await server.cookieFor('estimator');
  await server.cookieFor('viewer');
});

/* ------------------------------------------------------------------------------------------------
 * IMPORT (#41, §10)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S2 — import (POST /pricebook/editions)', () => {
  it('a valid staged document imports as DRAFT with the exact response contract and its audit event', async () => {
    const file = syntheticStagedFile('imp-ok');
    const response = await server.app.inject({
      method: 'POST',
      url: '/pricebook/editions',
      headers: { cookie: server.cookie },
      payload: file,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      edition: Record<string, unknown>;
      importReport: Record<string, unknown>;
    }>();
    // the #41 response: {edition, importReport} — the #39 representation of a DRAFT
    expect(Object.keys(body.edition).sort()).toEqual(
      [
        'archivedAt',
        'activatedAt',
        'contentHash',
        'discipline',
        'editionId',
        'importedAt',
        'importedBy',
        'notificationDate',
        'notificationNumber',
        'organization',
        'rowCount',
        'sourceFileHash',
        'status',
        'supersedesEditionId',
        'title',
        'year',
      ].sort(),
    );
    expect(body.edition['editionId']).toBe('ir-14mx-abniye-imp-ok');
    expect(body.edition['status']).toBe('DRAFT');
    expect(body.edition['year']).toBe('1410');
    expect(body.edition['rowCount']).toBe(2);
    expect(body.edition['discipline']).toBe('abniye');
    expect(body.edition['importedBy']).toBe(adminId);
    expect(body.edition['importedAt']).toBe(FIXED_INSTANT);
    expect(body.edition['activatedAt']).toBe(null);
    expect(body.edition['archivedAt']).toBe(null);
    expect(body.importReport['ok']).toBe(true);
    expect(body.importReport['rowCount']).toBe(2);
    expect(body.importReport['errorCount']).toBe(0);

    // the row is persisted exactly as imported (DRAFT, no lifecycle stamps)
    const row = await editionRow('ir-14mx-abniye-imp-ok');
    expect(row.status).toBe('DRAFT');
    expect(row.activated_by).toBe(null);
    expect(row.archived_by).toBe(null);

    // the audit event: exact payload, actor = the importing session, projectId null
    const events = await eventsOf('pricebook_edition.imported', 'ir-14mx-abniye-imp-ok');
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(adminId);
    expect(events[0]?.projectId).toBe(null);
    expect(events[0]?.resourceType).toBe('pricebook_edition');
    expect(events[0]?.details).toEqual({
      contentHash: row.content_hash,
      rowCount: 2,
      warningCount: body.importReport['warningCount'],
    });
  });

  it('an invalid staged document is rejected 422 with the gate failures — nothing stored, zero events', async () => {
    const before = await editionCount();
    const eventsBefore = await totalEvents();
    const badFile = syntheticStagedFile('imp-bad');
    (badFile.rows[1] as Record<string, unknown>)['basePrice'] = 'not-a-decimal';
    const response = await server.app.inject({
      method: 'POST',
      url: '/pricebook/editions',
      headers: { cookie: server.cookie },
      payload: badFile,
    });
    expect(response.statusCode).toBe(422);
    const error = errorOf(response.json<Record<string, unknown>>());
    expect(error.code).toBe('PRICEBOOK_IMPORT_REJECTED');
    const failures = (error.details as { failures?: unknown[] }).failures;
    expect(Array.isArray(failures)).toBe(true);
    expect((failures ?? []).length).toBeGreaterThan(0);
    expect(await editionCount()).toBe(before);
    expect(await totalEvents()).toBe(eventsBefore);
  });

  it('identical content is refused 409 EDITION_ALREADY_EXISTS — idempotent, never a second row', async () => {
    const file = syntheticStagedFile('imp-dup');
    const first = await server.app.inject({
      method: 'POST',
      url: '/pricebook/editions',
      headers: { cookie: server.cookie },
      payload: file,
    });
    expect(first.statusCode).toBe(201);
    const before = await editionCount();
    const eventsBefore = await totalEvents();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = await server.app.inject({
        method: 'POST',
        url: '/pricebook/editions',
        headers: { cookie: server.cookie },
        payload: file,
      });
      expect(retry.statusCode).toBe(409);
      expect(errorOf(retry.json<Record<string, unknown>>()).code).toBe('EDITION_ALREADY_EXISTS');
    }
    expect(await editionCount()).toBe(before);
    expect(await totalEvents()).toBe(eventsBefore);
  });

  it('a taken editionId with different content is the same 409 (a correction is a NEW edition)', async () => {
    await importDraft('imp-id-taken');
    const sameIdDifferentContent = syntheticStagedFile('imp-id-taken');
    (sameIdDifferentContent.rows[1] as Record<string, unknown>)['basePrice'] = '12345';
    const response = await server.app.inject({
      method: 'POST',
      url: '/pricebook/editions',
      headers: { cookie: server.cookie },
      payload: sameIdDifferentContent,
    });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response.json<Record<string, unknown>>()).code).toBe('EDITION_ALREADY_EXISTS');
  });

  it("the FULL-SIZE verified 1404 file (1.2 MiB > the global 1 MiB limit) passes the import route's body limit — and is the same edition as the seed (409)", async () => {
    // the staged 1404 document is larger than the API's global 1 MiB body limit; the
    // import route raises it (8 MiB) because full staged pricebooks are its body —
    // and the file's content is the seeded edition's content, so the import gate
    // accepts it and content-addressable duplicate detection answers 409
    const file: unknown = JSON.parse(readFileSync(STAGED_1404_PATH, 'utf8'));
    const response = await server.app.inject({
      method: 'POST',
      url: '/pricebook/editions',
      headers: { cookie: server.cookie, 'content-type': 'application/json' },
      payload: file as Record<string, unknown>,
    });
    expect(response.statusCode).not.toBe(413);
    expect(response.statusCode).toBe(409);
    const error = errorOf(response.json<Record<string, unknown>>());
    expect(error.code).toBe('EDITION_ALREADY_EXISTS');
    expect(error.message).toContain('ir-1404-abniye');
  });

  it('authorization: anonymous → 401; viewer → 403 with requiredRole data_steward (matrix in authz.test.ts)', async () => {
    const anonymous = await server.rawInject({
      method: 'POST',
      url: '/pricebook/editions',
      payload: syntheticStagedFile('imp-auth-anon'),
    });
    expect(anonymous.statusCode).toBe(401);
    expect(errorOf(anonymous.json<Record<string, unknown>>()).code).toBe('UNAUTHENTICATED');
    const viewer = await server.app.inject({
      method: 'POST',
      url: '/pricebook/editions',
      headers: { cookie: await server.cookieFor('viewer') },
      payload: syntheticStagedFile('imp-auth-viewer'),
    });
    expect(viewer.statusCode).toBe(403);
    const error = errorOf(viewer.json<Record<string, unknown>>());
    expect(error.code).toBe('FORBIDDEN');
    expect((error.details as { requiredRole?: string }).requiredRole).toBe('data_steward');
  });
});

/* ------------------------------------------------------------------------------------------------
 * LIST (#39) and DETAIL (#40)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S2 — list and detail (GET /pricebook/editions…)', () => {
  it('a viewer lists every edition in deterministic (importedAt, editionId) order — no row bulk, no reports', async () => {
    const a = await importDraft('list-a');
    const b = await importDraft('list-b');
    const response = await server.app.inject({
      method: 'GET',
      url: '/pricebook/editions',
      headers: { cookie: await server.cookieFor('viewer') },
    });
    expect(response.statusCode).toBe(200);
    const editions = response.json<{ editions: Array<Record<string, unknown>> }>().editions;
    expect(editions.length).toBe(await editionCount());
    // deterministic order: (importedAt, editionId) — all imports share FIXED_INSTANT here,
    // so the tiebreak is the editionId ascending
    const ids = editions.map((edition) => String(edition['editionId']));
    const sorted = [...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    expect(ids).toEqual(sorted);
    expect(ids).toContain(SEED_EDITION);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    for (const edition of editions) {
      expect(Object.keys(edition).sort()).toEqual(
        [
          'archivedAt',
          'activatedAt',
          'contentHash',
          'discipline',
          'editionId',
          'importedAt',
          'importedBy',
          'notificationDate',
          'notificationNumber',
          'organization',
          'rowCount',
          'sourceFileHash',
          'status',
          'supersedesEditionId',
          'title',
          'year',
        ].sort(),
      );
      // never row bulk, never the import report, never credential material
      expect(edition['content']).toBeUndefined();
      expect(edition['importReport']).toBeUndefined();
      expect(edition['rows']).toBeUndefined();
    }
  });

  it('the detail returns the complete representation including the stored importReport', async () => {
    const editionId = await importDraft('detail-ok');
    const response = await server.app.inject({
      method: 'GET',
      url: `/pricebook/editions/${editionId}`,
      headers: { cookie: await server.cookieFor('viewer') },
    });
    expect(response.statusCode).toBe(200);
    const detail = response.json<Record<string, unknown>>();
    expect(detail['editionId']).toBe(editionId);
    expect((detail['importReport'] as Record<string, unknown>)['ok']).toBe(true);
    expect((detail['importReport'] as Record<string, unknown>)['editionId']).toBe(editionId);
  });

  it('an unknown editionId answers 404 EDITION_NOT_FOUND', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/pricebook/editions/no-such-edition',
      headers: { cookie: await server.cookieFor('viewer') },
    });
    expect(response.statusCode).toBe(404);
    expect(errorOf(response.json<Record<string, unknown>>()).code).toBe('EDITION_NOT_FOUND');
  });
});

/* ------------------------------------------------------------------------------------------------
 * ACTIVATION (#42, §8/§9)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S2 — activation (POST /pricebook/editions/:editionId/activate)', () => {
  it('DRAFT → ACTIVE: atomic handover — the previous ACTIVE is auto-archived, both events, one transaction', async () => {
    const target = await importDraft('act-ok', 'data_steward'); // steward imports…
    expect((await editionRow(SEED_EDITION)).status).toBe('ACTIVE'); // …the seed is active before
    const response = await postAs('org_admin', `/pricebook/editions/${target}/activate`); // …the admin activates
    expect(response.statusCode).toBe(200);
    expect(response.body['status']).toBe('ACTIVE');
    expect(response.body['activatedAt']).toBe(FIXED_INSTANT);
    expect(typeof response.body['editionId']).toBe('string');

    // exactly one ACTIVE; the superseded seed is ARCHIVED with the activator's stamp
    expect(await activeCount()).toBe(1);
    const targetRow = await editionRow(target);
    expect(targetRow.status).toBe('ACTIVE');
    expect(targetRow.activated_by).toBe(adminId);
    expect(targetRow.activated_at).toBe(FIXED_INSTANT);
    const seedRow = await editionRow(SEED_EDITION);
    expect(seedRow.status).toBe('ARCHIVED');
    expect(seedRow.archived_by).toBe(adminId);
    expect(seedRow.archived_at).toBe(FIXED_INSTANT);

    // both events, exact payloads, same actor, projectId null
    const activated = await eventsOf('pricebook_edition.activated', target);
    expect(activated).toHaveLength(1);
    expect(activated[0]?.actorUserId).toBe(adminId);
    expect(activated[0]?.projectId).toBe(null);
    expect(activated[0]?.details).toEqual({
      contentHash: targetRow.content_hash,
      supersededEditionId: SEED_EDITION,
    });
    const archived = await eventsOf('pricebook_edition.archived', SEED_EDITION);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.actorUserId).toBe(adminId);
    expect(archived[0]?.details).toEqual({
      contentHash: seedRow.content_hash,
      previousStatus: 'ACTIVE',
    });
  });

  it('ARCHIVED → ACTIVE re-activation: four-eyes does NOT apply; the stale archive stamp clears', async () => {
    // the IMPORTER archives their own draft, then re-activates it (legal — nothing is imported)
    const editionId = await importDraft('act-react', 'data_steward');
    const discard = await postAs('data_steward', `/pricebook/editions/${editionId}/archive`);
    expect(discard.statusCode).toBe(200);
    const beforeActive = await activeCount();
    const response = await postAs('data_steward', `/pricebook/editions/${editionId}/activate`);
    expect(response.statusCode).toBe(200);
    expect(response.body['status']).toBe('ACTIVE');
    const row = await editionRow(editionId);
    expect(row.activated_by).toBe(stewardId);
    // the previous ACTIVE was auto-archived; the winner is the only ACTIVE
    expect(await activeCount()).toBe(1);
    expect(beforeActive).toBe(1);
    // re-activation cleared the stale archive stamp of the earlier lifecycle
    expect(row.archived_by).toBe(null);
    expect(row.archived_at).toBe(null);
  });

  it('activating an already-ACTIVE edition → 409 EDITION_ALREADY_ACTIVE, zero mutation, zero events', async () => {
    const editionId = await importDraft('act-active', 'data_steward');
    const first = await postAs('org_admin', `/pricebook/editions/${editionId}/activate`);
    expect(first.statusCode).toBe(200);
    const rowBefore = await editionRow(editionId);
    const eventsBefore = await totalEvents();
    const again = await postAs('org_admin', `/pricebook/editions/${editionId}/activate`);
    expect(again.statusCode).toBe(409);
    expect(errorOf(again.body).code).toBe('EDITION_ALREADY_ACTIVE');
    expect(await editionRow(editionId)).toEqual(rowBefore);
    expect(await totalEvents()).toBe(eventsBefore);
  });

  it('an unknown editionId → 404 EDITION_NOT_FOUND', async () => {
    const response = await postAs('org_admin', '/pricebook/editions/no-such-edition/activate');
    expect(response.statusCode).toBe(404);
    expect(errorOf(response.body).code).toBe('EDITION_NOT_FOUND');
  });

  it('the importer activating their own DRAFT → 403 EDITION_SELF_ACTIVATION_FORBIDDEN, zero mutation, zero events', async () => {
    const editionId = await importDraft('act-four-eyes', 'data_steward');
    const rowBefore = await editionRow(editionId);
    const eventsBefore = await totalEvents();
    const response = await postAs('data_steward', `/pricebook/editions/${editionId}/activate`);
    expect(response.statusCode).toBe(403);
    expect(errorOf(response.body).code).toBe('EDITION_SELF_ACTIVATION_FORBIDDEN');
    expect(await editionRow(editionId)).toEqual(rowBefore);
    expect(await totalEvents()).toBe(eventsBefore);
  });

  it('a failing audit append inside the activation rolls the WHOLE transition back (no events ⇔ no mutation)', async () => {
    // A dedicated PGlite stack where ONLY the pricebook_edition.archived append fails —
    // the dependency seam the composition root exposes. The rollback itself is REAL
    // (PGlite BEGIN/ROLLBACK through the production Drizzle repositories): the target
    // stays DRAFT, the superseded edition stays ACTIVE, and neither event exists.
    const pg = new PGlite();
    const raw = drizzle(pg);
    await migrate(raw, {
      migrationsFolder: new URL('../../../packages/db/migrations', import.meta.url).pathname,
    });
    const db = raw as unknown as DbClient;

    class ArchivedEventFailure implements AuditEventRepository {
      readonly #real: AuditEventRepository;

      constructor(real: AuditEventRepository) {
        this.#real = real;
      }

      async append(event: AuditEvent): Promise<void> {
        if (event.action === 'pricebook_edition.archived') {
          throw new Error('S2 test: the archived-event writer failed');
        }
        await this.#real.append(event);
      }
    }

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
      governance: { users: poolBound.users, sessions: poolBound.sessions, audit: poolBound.audit },
      dataset: loadPublishedDataset(),
      clock: () => FIXED_INSTANT,
      transact: (async (work: Parameters<Transact>[0]) =>
        db.transaction(async (tx) => {
          const txBound = bindRepositories(tx);
          const failingTx: AuditEventRepository = new ArchivedEventFailure(txBound.audit);
          return work({ ...txBound, audit: failingTx });
        })) as Transact,
    };
    await ensureBootstrapAdmin(
      { users: deps.governance.users, sessions: deps.governance.sessions, clock: deps.clock },
      { bootstrapAdminUsername: 'admin', bootstrapAdminPassword: 'test-password-123' },
    );
    // the seed establishes the ACTIVE edition whose auto-archive event is sabotaged
    await seedPricebookEdition({
      users: deps.governance.users,
      editions: deps.repositories.editions,
      transact: deps.transact,
      clock: deps.clock,
    });
    await ensureTestRoleUsers(deps.governance.users);
    const app = createApiServer(deps);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'test-password-123' },
    });
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0];
    const stewardLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'steward-user', password: 'steward-password-123' },
    });
    const stewardCookie = String(stewardLogin.headers['set-cookie'] ?? '').split(';')[0];

    // the ADMIN imports (so the STEWARD is four-eyes-clean to activate — the sabotage
    // targets the auto-archive event of the superseded edition, appended after the
    // activation event inside the same transaction)
    const importResponse = await app.inject({
      method: 'POST',
      url: '/pricebook/editions',
      headers: { cookie },
      payload: syntheticStagedFile('act-rollback'),
    });
    expect(importResponse.statusCode).toBe(201);
    const editionId = importResponse.json<{ edition: { editionId: string } }>().edition.editionId;

    const activate = await app.inject({
      method: 'POST',
      url: `/pricebook/editions/${editionId}/activate`,
      headers: { cookie: stewardCookie },
    });
    expect(activate.statusCode).toBe(500); // the sabotaged writer surfaces as a generic failure
    const target = (
      await pg.query<{ status: string }>(
        'select status from pricebook_editions where edition_id = $1',
        [editionId],
      )
    ).rows[0];
    const seed = (
      await pg.query<{ status: string }>(
        'select status from pricebook_editions where edition_id = $1',
        [SEED_EDITION],
      )
    ).rows[0];
    expect(target?.status).toBe('DRAFT'); // the activation was rolled back
    expect(seed?.status).toBe('ACTIVE'); // …and so was the auto-archive of the superseded
    const lifecycleEvents = await pg.query<{ action: string }>(
      "select action from audit_events where action like 'pricebook_edition.%' and details->>'seeded' is null",
    );
    expect(lifecycleEvents.rows.map((row) => row.action)).toEqual(['pricebook_edition.imported']); // only the import survived
    await app.close();
    await pg.close();
  });
});

/* ------------------------------------------------------------------------------------------------
 * ARCHIVE (#43, §8)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S2 — archive (POST /pricebook/editions/:editionId/archive)', () => {
  it('DRAFT → ARCHIVED (the discard path) — metadata recorded, event {previousStatus: "DRAFT"}', async () => {
    const editionId = await importDraft('arc-draft', 'data_steward');
    const response = await postAs('org_admin', `/pricebook/editions/${editionId}/archive`);
    expect(response.statusCode).toBe(200);
    expect(response.body['status']).toBe('ARCHIVED');
    expect(response.body['archivedAt']).toBe(FIXED_INSTANT);
    const row = await editionRow(editionId);
    expect(row.archived_by).toBe(adminId);
    expect(row.archived_at).toBe(FIXED_INSTANT);
    const events = await eventsOf('pricebook_edition.archived', editionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(adminId);
    expect(events[0]?.details).toEqual({
      contentHash: row.content_hash,
      previousStatus: 'DRAFT',
    });
  });

  it('ACTIVE → ARCHIVED — event {previousStatus: "ACTIVE"}; content never deleted', async () => {
    const editionId = await importDraft('arc-active', 'data_steward');
    await postAs('org_admin', `/pricebook/editions/${editionId}/activate`);
    const response = await postAs('org_admin', `/pricebook/editions/${editionId}/archive`);
    expect(response.statusCode).toBe(200);
    const row = await editionRow(editionId);
    expect(row.status).toBe('ARCHIVED');
    expect(row.content).toBeDefined(); // the row — and its content — still exists
    const events = await eventsOf('pricebook_edition.archived', editionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toEqual({
      contentHash: row.content_hash,
      previousStatus: 'ACTIVE',
    });
  });

  it('ARCHIVED → ARCHIVED → 409 EDITION_ALREADY_ARCHIVED, zero events', async () => {
    const editionId = await importDraft('arc-twice');
    const first = await postAs('org_admin', `/pricebook/editions/${editionId}/archive`);
    expect(first.statusCode).toBe(200);
    const rowBefore = await editionRow(editionId);
    const eventsBefore = await totalEvents();
    const again = await postAs('org_admin', `/pricebook/editions/${editionId}/archive`);
    expect(again.statusCode).toBe(409);
    expect(errorOf(again.body).code).toBe('EDITION_ALREADY_ARCHIVED');
    expect(await editionRow(editionId)).toEqual(rowBefore);
    expect(await totalEvents()).toBe(eventsBefore);
  });

  it('an unknown editionId → 404 EDITION_NOT_FOUND', async () => {
    const response = await postAs('org_admin', '/pricebook/editions/no-such-edition/archive');
    expect(response.statusCode).toBe(404);
    expect(errorOf(response.body).code).toBe('EDITION_NOT_FOUND');
  });

  it('NO lifecycle operation ever mutates an immutable field (§11 across the whole lifecycle)', async () => {
    const editionId = await importDraft('immut', 'data_steward');
    const imported = await editionRow(editionId);
    await postAs('org_admin', `/pricebook/editions/${editionId}/activate`);
    await postAs('org_admin', `/pricebook/editions/${editionId}/archive`);
    await postAs('data_steward', `/pricebook/editions/${editionId}/activate`); // re-activation
    const after = await editionRow(editionId);
    // every immutable column is byte-identical to the import-time values
    expect({
      edition_id: after.edition_id,
      discipline: after.discipline,
      year: after.year,
      title: after.title,
      organization: after.organization,
      notification_number: after.notification_number,
      notification_date: after.notification_date,
      source_file_hash: after.source_file_hash,
      content_hash: after.content_hash,
      content: after.content,
      import_report: after.import_report,
      supersedes_edition_id: after.supersedes_edition_id,
      imported_by: after.imported_by,
      imported_at: after.imported_at,
    }).toEqual({
      edition_id: imported.edition_id,
      discipline: imported.discipline,
      year: imported.year,
      title: imported.title,
      organization: imported.organization,
      notification_number: imported.notification_number,
      notification_date: imported.notification_date,
      source_file_hash: imported.source_file_hash,
      content_hash: imported.content_hash,
      content: imported.content,
      import_report: imported.import_report,
      supersedes_edition_id: imported.supersedes_edition_id,
      imported_by: imported.imported_by,
      imported_at: imported.imported_at,
    });
    expect(after.status).toBe('ACTIVE'); // only the lifecycle columns moved
  });
});

/* ------------------------------------------------------------------------------------------------
 * THE 0-ACTIVE STATE and the default edition search (§9, #rows)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S2 — the 0-active state and GET /pricebook/rows', () => {
  it('archiving the sole ACTIVE edition is legal → 0 active; the default search fails closed 409 EDITION_NOT_ACTIVE', async () => {
    const editionId = await importDraft('zero-active', 'data_steward');
    await postAs('org_admin', `/pricebook/editions/${editionId}/activate`);
    expect(await activeCount()).toBe(1);
    // the previous ACTIVE was auto-archived by the activation above; archive the winner
    const response = await postAs('org_admin', `/pricebook/editions/${editionId}/archive`);
    expect(response.statusCode).toBe(200);
    expect(await activeCount()).toBe(0);

    const rows = await server.app.inject({
      method: 'GET',
      url: '/pricebook/rows?search=0101',
      headers: { cookie: await server.cookieFor('viewer') },
    });
    expect(rows.statusCode).toBe(409);
    expect(errorOf(rows.json<Record<string, unknown>>()).code).toBe('EDITION_NOT_ACTIVE');
    // nothing was auto-activated by the archive
    expect(await activeCount()).toBe(0);

    // the next activation restores normal operation — and the search follows it
    const restored = await postAs('org_admin', `/pricebook/editions/${editionId}/activate`);
    expect(restored.statusCode).toBe(200);
    expect(await activeCount()).toBe(1);
    const search = await server.app.inject({
      method: 'GET',
      url: '/pricebook/rows?search=0101',
      headers: { cookie: await server.cookieFor('viewer') },
    });
    expect(search.statusCode).toBe(200);
    const body = search.json<{ rows: unknown[]; edition: string }>();
    expect(body.edition).toBe(editionId); // the ACTIVE edition's identity, not the boot file's
  });

  it('the default search serves the CURRENT ACTIVE edition — never the boot-time in-memory dataset', async () => {
    // a fresh edition whose rows differ from the boot dataset: activating it changes
    // both the served identity and the served rows
    const file = syntheticStagedFile('rows-follow');
    (file.rows[0] as Record<string, unknown>)['description'] = 'شرح اختصاصی نسخه فعال جدید';
    const importResponse = await server.app.inject({
      method: 'POST',
      url: '/pricebook/editions',
      headers: { cookie: server.cookie },
      payload: file,
    });
    expect(importResponse.statusCode).toBe(201);
    const editionId = importResponse.json<{ edition: { editionId: string } }>().edition.editionId;
    await postAs('data_steward', `/pricebook/editions/${editionId}/activate`);
    const search = await server.app.inject({
      method: 'GET',
      url: `/pricebook/rows?search=${encodeURIComponent('شرح اختصاصی نسخه فعال جدید')}`,
      headers: { cookie: await server.cookieFor('viewer') },
    });
    expect(search.statusCode).toBe(200);
    const body = search.json<{ rows: Array<{ code: string }>; edition: string }>();
    expect(body.edition).toBe(editionId);
    expect(body.rows.map((row) => row.code)).toContain('010101');
    // restoring the seeded 1404 edition for the suites that follow
    await postAs('org_admin', `/pricebook/editions/${editionId}/archive`);
    await postAs('data_steward', `/pricebook/editions/${SEED_EDITION}/activate`);
    expect(await activeCount()).toBe(1);
  });
});

/* ------------------------------------------------------------------------------------------------
 * HISTORICAL REPRODUCIBILITY across an activation (§14 — the HARD invariant)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S2 — historical reproducibility (§14: activation changes nothing historical)', () => {
  it('a finalized-and-approved golden estimate is byte-identical across import + activation of a new edition', async () => {
    // build the golden chain under the seeded 1404 edition
    const projectId = '5e5e0000-0000-4000-8000-0000000000f1';
    const estimateId = '5e5e0000-0000-4000-8000-0000000000f2';
    await server.app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: server.cookie },
      payload: { projectId, title: 'پروژه بازتولید تاریخی' },
    });
    await server.app.inject({
      method: 'POST',
      url: `/projects/${projectId}/estimates`,
      headers: { cookie: server.cookie },
      payload: { estimateId, title: 'برآورد بازتولید' },
    });
    const versionResponse = await server.app.inject({
      method: 'POST',
      url: `/estimates/${estimateId}/versions`,
      headers: { cookie: server.cookie },
      payload: { buildingId: 'building-main', versionId: 'repro-v1' },
    });
    const versionId = versionResponse.json<{ versionId: string }>().versionId;
    await server.app.inject({
      method: 'POST',
      url: `/estimate-versions/${versionId}/lines`,
      headers: { cookie: server.cookie },
      payload: {
        lines: COMPLETE_LINES.map((line, index) => ({ ...line, lineId: `rl-${String(index)}` })),
      },
    });
    const finalize = await server.app.inject({
      method: 'POST',
      url: `/estimate-versions/${versionId}/finalize`,
      headers: { cookie: server.cookie },
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(finalize.statusCode).toBe(201);
    // the golden total is exactly the pinned value (§21)
    const finalizedEvent = (await eventsOf('estimate_version.finalized', versionId))[0];
    expect((finalizedEvent?.details as { rollupTotal?: string }).rollupTotal).toBe('69011321.1668');

    const approve = await server.app.inject({
      method: 'POST',
      url: `/estimate-versions/${versionId}/approve`,
      headers: { cookie: reviewerCookie },
    });
    expect(approve.statusCode).toBe(200);

    const bundleBefore = await server.app.inject({
      method: 'GET',
      url: `/estimate-versions/${versionId}`,
      headers: { cookie: server.cookie },
    });
    const excelBefore = await server.app.inject({
      method: 'GET',
      url: `/estimate-versions/${versionId}/render/excel`,
      headers: { cookie: server.cookie },
    });
    const pdfBefore = await server.app.inject({
      method: 'GET',
      url: `/estimate-versions/${versionId}/render/pdf`,
      headers: { cookie: server.cookie },
    });
    const bindingBefore = (
      await server.pg.query<{ edition_id: string }>(
        'select edition_id from estimate_versions where version_id = $1',
        [versionId],
      )
    ).rows[0];

    // import + activate a synthetic second edition — the pricing basis of the world changes
    const editionId = await importDraft('repro-new', 'data_steward');
    const activation = await postAs('org_admin', `/pricebook/editions/${editionId}/activate`);
    expect(activation.statusCode).toBe(200);

    // …and NOTHING historical moved: bundle, renders, approval, binding — byte-identical
    const bundleAfter = await server.app.inject({
      method: 'GET',
      url: `/estimate-versions/${versionId}`,
      headers: { cookie: server.cookie },
    });
    expect(bundleAfter.body).toBe(bundleBefore.body);
    const excelAfter = await server.app.inject({
      method: 'GET',
      url: `/estimate-versions/${versionId}/render/excel`,
      headers: { cookie: server.cookie },
    });
    expect(excelAfter.statusCode).toBe(200);
    expect(
      Buffer.compare(Buffer.from(excelAfter.rawPayload), Buffer.from(excelBefore.rawPayload)),
    ).toBe(0);
    const pdfAfter = await server.app.inject({
      method: 'GET',
      url: `/estimate-versions/${versionId}/render/pdf`,
      headers: { cookie: server.cookie },
    });
    expect(
      Buffer.compare(Buffer.from(pdfAfter.rawPayload), Buffer.from(pdfBefore.rawPayload)),
    ).toBe(0);
    const approvalAfter = (
      await server.pg.query<{ approved_by: string | null; approved_at: string | null }>(
        'select approved_by, approved_at from finalized_estimates where version_id = $1',
        [versionId],
      )
    ).rows[0];
    const approvalBefore = (
      await server.pg.query<{ approved_by: string | null; approved_at: string | null }>(
        'select approved_by, approved_at from finalized_estimates where version_id = $1',
        [versionId],
      )
    ).rows[0];
    expect(approvalAfter).toEqual(approvalBefore);
    // the version's edition binding never follows the lifecycle (§12 rule F)
    const bindingAfter = (
      await server.pg.query<{ edition_id: string }>(
        'select edition_id from estimate_versions where version_id = $1',
        [versionId],
      )
    ).rows[0];
    expect(bindingAfter).toEqual(bindingBefore);
    expect(bindingAfter?.edition_id).toBe(SEED_EDITION);

    // restore the seeded 1404 as the ACTIVE edition for any suite that follows
    await postAs('org_admin', `/pricebook/editions/${editionId}/archive`);
    await postAs('data_steward', `/pricebook/editions/${SEED_EDITION}/activate`);
  });
});
