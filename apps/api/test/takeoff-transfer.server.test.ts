/**
 * D-016 Phase 4 — real-server (node-postgres over TCP) CONCURRENCY verification for the
 * Takeoff → BOQ transfer (G2=B, CG-FT §8.4/§20). Runs ONLY when
 * `COSTGENIUS_SMOKE_DATABASE_URL` points at a disposable PostgreSQL (exactly like the
 * other server suites); without the variable the suite is SKIPPED and PGlite results are
 * never presented as server verification.
 *
 * Verified invariants:
 * - two CONCURRENT transfers of the same finalized takeoff into the same draft version
 *   never create duplicate BOQ lines: the store's append-only writer serializes them
 *   under `SELECT … FOR UPDATE`; the deterministic transfer identity makes the second
 *   commit a byte-identical prefix (no-op) or a deterministic 409 — never a duplicate;
 * - the sequential repeat answers 422 TAKEOFF_TRANSFER_REJECTED / ALREADY_TRANSFERRED;
 * - a concurrent transfer vs. an unrelated line-append ends 409 or no-op for the
 *   transfer, never a partially-mutated version;
 * - after the dust settles the version contains exactly the expected lines, each with
 *   its §8.1 provenance, and the finalized takeoff snapshot is untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InjectPayload } from 'light-my-request';
import {
  createDb,
  createDbPool,
  DrizzleSessionRepository,
  DrizzleUserRepository,
  migrateDatabase,
  type DbClient,
} from '@costgenius/db';
import {
  createApiServer,
  ensureBootstrapAdmin,
  loadPublishedDataset,
  seedPricebookEdition,
} from '../src/index.js';
import {
  attachAuthenticatedServer,
  bindRepositories,
  TEST_ADMIN,
  transactOver,
} from './helpers.js';

const SMOKE_URL = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;
const INSTANT = '2026-01-01T00:00:00Z';

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

/** Creates project + finalized takeoff (one priced itemCode 010101 = 7 m2) + draft version. */
async function seed(
  app: App,
  ids: { projectId: string; documentId: string; takeoffId: string },
): Promise<string> {
  const project = await post(app, '/projects', { projectId: ids.projectId, title: 'پروژه' });
  expect(project.status).toBe(201);
  const estimateId = `${ids.projectId.slice(0, 8)}-eeee-4eee-8eee-eeeeeeeeeeee`;
  const estimate = await post(app, `/projects/${ids.projectId}/estimates`, {
    estimateId,
    title: 'برآورد',
  });
  expect(estimate.status).toBe(201);
  const version = await post(app, `/estimates/${estimateId}/versions`, {
    buildingId: 'b',
    versionId: `${estimateId}-v1`,
  });
  expect(version.status).toBe(201);
  const created = await post(app, `/projects/${ids.projectId}/takeoffs`, {
    takeoffId: ids.takeoffId,
    documentId: ids.documentId,
    title: 'ریز متره',
  });
  expect(created.status).toBe(201);
  const saved = await post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/save`, {
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
            description: 'کانال',
            itemCode: '010101',
            kind: 'addition',
            unit: 'm2',
            quantity: { type: 'dimensional', profile: 'LW', length: '2.1', width: '2' },
          },
          {
            lineId: 'B',
            rowNo: 2,
            description: 'کانال ۲',
            itemCode: '010101',
            kind: 'addition',
            unit: 'm2',
            quantity: { type: 'dimensional', profile: 'LW', length: '1.4', width: '2' },
          },
        ],
      },
    ],
  });
  expect(saved.status).toBe(200);
  const finalized = await post(
    app,
    `/projects/${ids.projectId}/takeoffs/${ids.documentId}/finalize`,
    {
      expectedRevision: 2,
    },
  );
  expect(finalized.status).toBe(201);
  return `${estimateId}-v1`;
}

describe.skipIf(SMOKE_URL === undefined)(
  'takeoff → BOQ transfer concurrency (real PostgreSQL server)',
  () => {
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
        {
          bootstrapAdminUsername: TEST_ADMIN.username,
          bootstrapAdminPassword: TEST_ADMIN.password,
        },
      );
      const poolBound = bindRepositories(db);
      // P8-B S1 (D-PB-1 = B): the first-boot pricebook seed — same boot order as
      // production; a no-op on the reused disposable database of a later run.
      await seedPricebookEdition({
        users: userStore,
        editions: poolBound.editions,
        transact: transactOver(db),
        clock: () => INSTANT,
      });
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
            dataset: loadPublishedDataset(),
            clock: () => INSTANT,
            transact: transactOver(db),
          }),
        )
      ).app;
      closePool = () => pool.end();
    });

    const lineCount = async (versionId: string): Promise<number> => {
      const version = await get(app, `/estimate-versions/${versionId}`);
      const lines = (version.body as { lines?: unknown[] }).lines;
      if (!Array.isArray(lines)) throw new Error('version not loadable');
      return lines.length;
    };

    it('two concurrent transfers of the same takeoff never duplicate lines (V)', async () => {
      const ids = idsFor('b001');
      const versionId = await seed(app, ids);
      const [a, b] = await Promise.all([
        post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/transfer-to-boq`, {
          versionId,
        }),
        post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/transfer-to-boq`, {
          versionId,
        }),
      ]);
      // One commits the lines; the other is a byte-identical no-op commit (idempotent) or a
      // deterministic conflict — never a 5xx, never a duplicate.
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(200);
      expect(statuses.every((status) => status === 200 || status === 409 || status === 422)).toBe(
        true,
      );
      expect(await lineCount(versionId)).toBe(1); // exactly ONE transferred line
      // the sequential repeat is the stable ALREADY_TRANSFERRED rejection
      const third = await post(
        app,
        `/projects/${ids.projectId}/takeoffs/${ids.documentId}/transfer-to-boq`,
        { versionId },
      );
      expect(third.status).toBe(422);
      expect((third.body as { error: { code: string } }).error.code).toBe(
        'TAKEOFF_TRANSFER_REJECTED',
      );
      expect(await lineCount(versionId)).toBe(1);
      // the persisted line carries the full provenance
      const version = await get(app, `/estimate-versions/${versionId}`);
      const line = ((version.body as { lines?: { lineId: string; quantity: string }[] }).lines ??
        [])[0];
      expect(line?.lineId).toBe(`tk-${ids.documentId}-010101`);
      expect(line?.quantity).toBe('7');
      // and the finalized takeoff snapshot is untouched by all of it
      const snapshot = await get(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}`);
      expect((snapshot.body as { document?: { status?: string } }).document?.status).toBe(
        'finalized',
      );
    });

    it('a concurrent transfer vs an unrelated append never corrupts the version (V)', async () => {
      const ids = idsFor('b002');
      const versionId = await seed(app, ids);
      const [transfer, append] = await Promise.all([
        post(app, `/projects/${ids.projectId}/takeoffs/${ids.documentId}/transfer-to-boq`, {
          versionId,
        }),
        post(app, `/estimate-versions/${versionId}/lines`, {
          lines: [{ lineId: 'manual-1', pricebookCode: '270101', quantity: '5', unit: 'kg' }],
        }),
      ]);
      // Both succeed (serialized appends) or the loser is a deterministic 409 — the version
      // ends with 1 or 2 lines, each intact, never a partial or duplicated state.
      for (const response of [transfer, append]) {
        expect([200, 409, 422].includes(response.status)).toBe(true);
      }
      const count = await lineCount(versionId);
      expect(count === 1 || count === 2).toBe(true);
      if (transfer.status === 200) {
        const version = await get(app, `/estimate-versions/${versionId}`);
        const lineIds = ((version.body as { lines?: { lineId: string }[] }).lines ?? []).map(
          (l) => l.lineId,
        );
        expect(lineIds).toContain(`tk-${ids.documentId}-010101`); // the transfer's line exists
        expect(new Set(lineIds).size).toBe(lineIds.length); // no duplicates
      }
    });

    afterAll(async () => {
      await closePool();
    });
  },
);
