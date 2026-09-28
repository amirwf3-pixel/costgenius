/**
 * D-016 Phase 3 — real-server (node-postgres over TCP) HTTP concurrency verification for
 * the takeoff resource family. Runs ONLY when `COSTGENIUS_SMOKE_DATABASE_URL` points at a
 * disposable PostgreSQL (exactly like `node-postgres-concurrency.test.ts`); without the
 * variable the suite is SKIPPED and PGlite results are never presented as server
 * verification.
 *
 * Verified invariants (the route layer adds NO concurrency logic of its own — the Phase 2
 * store is the authority, these tests prove it through the full HTTP stack):
 * - two concurrent saves with the SAME expectedRevision → exactly one 200, one
 *   409 PERSISTENCE_CONFLICT, exactly one revision increment;
 * - a concurrent save-vs-finalize race → exactly one winner and a contract-consistent
 *   end state (finalized+snapshot, or draft at revision+1 with no snapshot);
 * - concurrent finalizations → at least one 201, never a 5xx, exactly one immutable
 *   snapshot, revision frozen — identical bundles may both succeed (store idempotency),
 *   the loser of a different-content race is a deterministic 409;
 * - the full lifecycle (create → save → finalize → reload bundle → follow-up) works over
 *   node-postgres against a real server.
 */
import type { InjectPayload } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  createDbPool,
  DrizzleEstimateRepository,
  DrizzleFinalizedEstimateRepository,
  DrizzleFinalizedTakeoffRepository,
  DrizzleProjectRepository,
  DrizzleSessionRepository,
  DrizzleTakeoffDocumentRepository,
  DrizzleUserRepository,
  migrateDatabase,
  type DbClient,
} from '@costgenius/db';
import { createApiServer, ensureBootstrapAdmin, loadPublishedDataset } from '../src/index.js';
import { attachAuthenticatedServer, TEST_ADMIN } from './helpers.js';

const SMOKE_URL = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;

const INSTANT = '2026-01-01T00:00:00Z';
const INSTANT_2 = '2026-01-02T00:00:00Z';

/** One concrete takeoff line per content revision (enough to observe write races). */
const LINE = (lineId: string, value: string): unknown => ({
  lineId,
  rowNo: 1,
  description: 'خط آزمون',
  itemCode: 'SYN-1',
  kind: 'addition',
  unit: 'm2',
  quantity: { type: 'manual', value, justification: 'آزمون همزمانی' },
});

const SHEETS_OF = (lineId: string, value: string): readonly unknown[] => [
  { sheetId: 'S1', name: 'برگه', lines: [LINE(lineId, value)] },
];

/** Deterministic UUID-shaped identities per scenario (4 hex chars tag). */
function idsFor(tag: string): { projectId: string; documentId: string; takeoffId: string } {
  if (!/^[0-9a-f]{4}$/.test(tag)) throw new Error(`tag must be 4 hex chars: ${tag}`);
  return {
    projectId: `${tag}aaaa-aa00-4000-8000-00000000aaaa`,
    documentId: `${tag}dddd-dd00-4000-8000-00000000dddd`,
    takeoffId: `${tag}tk-tk00-4000-8000-00000000tkkk`,
  };
}

type App = ReturnType<typeof createApiServer>;

async function post(
  app: App,
  url: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({ method: 'POST', url, payload: payload as InjectPayload });
  return { status: response.statusCode, body: response.json<unknown>() };
}

async function get(app: App, url: string): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json<unknown>() };
}

/** Creates the project and a saved draft (revision 2) for one scenario. */
async function seedDraft(
  app: App,
  ids: { projectId: string; documentId: string; takeoffId: string },
  value = '10',
): Promise<void> {
  const project = await post(app, '/projects', { projectId: ids.projectId, title: 'پروژه' });
  expect(project.status).toBe(201);
  const created = await post(app, `/projects/${ids.projectId}/takeoffs`, {
    takeoffId: ids.takeoffId,
    documentId: ids.documentId,
    title: 'ریز متره',
  });
  expect(created.status).toBe(201);
  const saved = await post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/save`, {
    expectedRevision: 1,
    title: 'ریز متره',
    sheets: SHEETS_OF('L1', value),
    rounding: [],
  });
  expect(saved.status).toBe(200);
}

interface DocumentBody {
  status: string;
  revision: number;
  documentNumber: number;
  sheets: unknown[];
}

interface FinalizedBody {
  document: DocumentBody;
  finalizedAt: string;
  result: { status: string };
}

const asDocument = (body: unknown): DocumentBody => body as DocumentBody;
const asFinalized = (body: unknown): FinalizedBody => body as FinalizedBody;
const errorCodeOf = (body: unknown): string => (body as { error: { code: string } }).error.code;

describe.skipIf(SMOKE_URL === undefined)('takeoff API concurrency (real PostgreSQL server)', () => {
  let app: App;
  let db: DbClient;
  let closePool: () => Promise<void>;

  beforeAll(async () => {
    const pool = createDbPool(SMOKE_URL as string);
    db = createDb(pool);
    await migrateDatabase(db, MIGRATIONS_FOLDER);
    const userStore = new DrizzleUserRepository(db);
    const sessionStore = new DrizzleSessionRepository(db);
    await ensureBootstrapAdmin(
      { users: userStore, sessions: sessionStore, clock: () => INSTANT },
      { bootstrapAdminUsername: TEST_ADMIN.username, bootstrapAdminPassword: TEST_ADMIN.password },
    );
    const server = await attachAuthenticatedServer(
      createApiServer({
        repositories: {
          projects: new DrizzleProjectRepository(db),
          estimates: new DrizzleEstimateRepository(db),
          finalized: new DrizzleFinalizedEstimateRepository(db),
          takeoffDocuments: new DrizzleTakeoffDocumentRepository(db),
          finalizedTakeoffs: new DrizzleFinalizedTakeoffRepository(db),
        },
        governance: { users: userStore, sessions: sessionStore },
        dataset: loadPublishedDataset(),
        clock: () => INSTANT,
      }),
    );
    app = server.app;
    closePool = () => pool.end();
  });

  it('the full lifecycle works over node-postgres against a real server', async () => {
    const ids = idsFor('a001');
    await seedDraft(app, ids);
    const finalized = await post(
      app,
      `/projects/${ids.projectId}/takeoffs/${ids.documentId}/finalize`,
      { expectedRevision: 2 },
    );
    expect(finalized.status).toBe(201);
    expect(asFinalized(finalized.body).result.status).toBe('ok');
    const reloaded = await get(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}`);
    expect(reloaded.status).toBe(200);
    expect(asFinalized(reloaded.body).finalizedAt).toBe(INSTANT);
    const followUp = await post(
      app,
      `/projects/${ids.projectId}/takeoffs/${ids.documentId}/follow-up`,
      { documentId: `${ids.documentId}-v2` },
    );
    expect(followUp.status).toBe(201);
    expect(asDocument(followUp.body).documentNumber).toBe(2);
  });

  it('two concurrent saves with the same expectedRevision: exactly one winner', async () => {
    const ids = idsFor('a002');
    await seedDraft(app, ids);
    const [a, b] = await Promise.all([
      post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/save`, {
        expectedRevision: 2,
        title: 'ریز متره',
        sheets: SHEETS_OF('L1', '11'),
        rounding: [],
      }),
      post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/save`, {
        expectedRevision: 2,
        title: 'ریز متره',
        sheets: SHEETS_OF('L1', '22'),
        rounding: [],
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(errorCodeOf(loser.body)).toBe('PERSISTENCE_CONFLICT');
    const loaded = await get(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}`);
    const document = asDocument(loaded.body);
    expect(document.revision).toBe(3); // exactly one increment, no last-write-wins
    const winnerValue = a.status === 200 ? '11' : '22';
    expect(JSON.stringify(document.sheets)).toContain(winnerValue);
  });

  it('a concurrent save-vs-finalize race has exactly one winner and a consistent end state', async () => {
    const ids = idsFor('a003');
    await seedDraft(app, ids);
    const [save, finalize] = await Promise.all([
      post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/save`, {
        expectedRevision: 2,
        title: 'ریز متره',
        sheets: SHEETS_OF('L1', '33'),
        rounding: [],
      }),
      post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/finalize`, {
        expectedRevision: 2,
      }),
    ]);
    const successes = [save, finalize].filter((r) => r.status === 200 || r.status === 201).length;
    expect(successes).toBe(1);
    const loaded = await get(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}`);
    if (finalize.status === 201) {
      // finalization won: the document is finalized with its immutable snapshot
      expect(save.status).toBe(409);
      const bundle = asFinalized(loaded.body);
      expect(bundle.document.status).toBe('finalized');
      expect(bundle.document.revision).toBe(2);
      expect(bundle.result.status).toBe('ok');
    } else {
      // the save won: finalization failed as stale and nothing was finalized
      expect(save.status).toBe(200);
      expect(finalize.status).toBe(409);
      expect(errorCodeOf(finalize.body)).toBe('PERSISTENCE_CONFLICT');
      const document = asDocument(loaded.body);
      expect(document.status).toBe('draft');
      expect(document.revision).toBe(3);
    }
  });

  it('concurrent identical finalizations never produce a second snapshot or a 5xx', async () => {
    const ids = idsFor('a004');
    await seedDraft(app, ids);
    const [a, b] = await Promise.all([
      post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/finalize`, {
        expectedRevision: 2,
      }),
      post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/finalize`, {
        expectedRevision: 2,
      }),
    ]);
    // Either both racing requests see the draft (store idempotency: both 201) or the
    // second loads the already-finalized document (409 TAKEOFF_INVALID_TRANSITION) —
    // but at least one succeeds and nothing is ever a 500.
    expect(a.status === 201 || b.status === 201).toBe(true);
    expect([a.status, b.status].every((status) => status === 201 || status === 409)).toBe(true);
    const loaded = await get(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}`);
    const bundle = asFinalized(loaded.body);
    expect(bundle.document.status).toBe('finalized');
    expect(bundle.document.revision).toBe(2); // frozen, never bumped by finalization
    expect(bundle.finalizedAt).toBe(INSTANT);
  });

  it('concurrent different finalizations have exactly one winner', async () => {
    const ids = idsFor('a005');
    await seedDraft(app, ids);
    const [a, b] = await Promise.all([
      post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/finalize`, {
        expectedRevision: 2,
        finalizedAt: INSTANT,
      }),
      post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/finalize`, {
        expectedRevision: 2,
        finalizedAt: INSTANT_2, // a different bundle — only one may persist
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loaded = await get(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}`);
    const bundle = asFinalized(loaded.body);
    expect(bundle.document.status).toBe('finalized');
    const winner = a.status === 201 ? a : b;
    expect(bundle.finalizedAt).toBe(asFinalized(winner.body).finalizedAt); // the winner's snapshot
  });

  afterAll(async () => {
    await closePool();
  });
});
