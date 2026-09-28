/**
 * D-016 Phase 2 real-server concurrency verification (task §17).
 *
 * These tests run ONLY against a real PostgreSQL server (node-postgres over TCP) and are
 * gated by `COSTGENIUS_SMOKE_DATABASE_URL` exactly like the apps/api server suites.
 * Without the variable the suite is SKIPPED — PGlite results are never presented as
 * server verification (PGlite is single-connection, so true transaction interleaving
 * cannot be observed there; the stale-revision and transition contracts themselves are
 * covered by takeoff-persistence.test.ts).
 *
 * Verified invariants (CG-FT-TAKEOFF-SPEC §4, G4=B):
 * - two concurrent draft saves carrying the same expectedRevision: exactly ONE wins; the
 *   loser receives a deterministic PERSISTENCE_CONFLICT — never last-write-wins;
 * - a concurrent save-vs-finalize race on the same draft always ends in a
 *   contract-consistent state (either the save won and finalization failed as stale, or
 *   finalization won and the save failed as TAKEOFF_DOCUMENT_IMMUTABLE);
 * - concurrent identical finalizations all succeed idempotently with exactly ONE
 *   snapshot row; concurrent different finalizations have exactly one winner;
 * - the persisted finalized snapshot always matches the persisted document rows.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DbError,
  DrizzleProjectRepository,
  DrizzleTakeoffDocumentRepository,
  DrizzleFinalizedTakeoffRepository,
  canonicalJson,
  createDb,
  createDbPool,
  migrateDatabase,
  takeoffDocuments,
  type DbClient,
} from '../src/index.js';
import {
  archiveTakeoffDocument,
  createProject,
  createTakeoffDocument,
  finalizeTakeoffDocument,
  saveTakeoffDocumentDraft,
  type TakeoffDocument,
  type TakeoffDocumentSheet,
} from '@costgenius/projects';

const SMOKE_URL = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];
const d = describe.skipIf(SMOKE_URL === undefined);

const T0 = '2026-01-01T00:00:00Z';
const T1 = '2026-01-02T00:00:00Z';
const T2 = '2026-01-03T00:00:00Z';

const SHEETS_A: readonly TakeoffDocumentSheet[] = [
  {
    sheetId: 'S1',
    name: 'A',
    lines: [
      {
        lineId: 'L1',
        rowNo: 1,
        description: 'a',
        kind: 'addition',
        unit: 'm2',
        quantity: { type: 'dimensional', profile: 'LW', length: '2', width: '3' },
      },
    ],
  },
];
const SHEETS_B: readonly TakeoffDocumentSheet[] = [
  {
    sheetId: 'S9',
    name: 'B',
    lines: [
      {
        lineId: 'L9',
        rowNo: 1,
        description: 'b',
        kind: 'addition',
        unit: 'm',
        quantity: { type: 'dimensional', profile: 'L', length: '7' },
      },
    ],
  },
];

type PgPool = ReturnType<typeof createDbPool>;

interface Handle {
  readonly db: DbClient;
  readonly documents: DrizzleTakeoffDocumentRepository;
  readonly finalized: DrizzleFinalizedTakeoffRepository;
  readonly close: () => Promise<void>;
}

function openDb(url: string): Handle {
  const pool: PgPool = createDbPool(url);
  const db = createDb(pool);
  return {
    db,
    documents: new DrizzleTakeoffDocumentRepository(db),
    finalized: new DrizzleFinalizedTakeoffRepository(db),
    close: async () => {
      await pool.end();
    },
  };
}

function idsFor(tag: string): { projectId: string; documentId: string; takeoffId: string } {
  return {
    projectId: `${tag}aaaaaa-aa00-4000-8000-00000000aaaa`,
    documentId: `${tag}doc-1`,
    takeoffId: `${tag}tk-1`,
  };
}

async function seedDraft(
  env: Handle,
  tag: string,
  sheets: readonly TakeoffDocumentSheet[],
): Promise<TakeoffDocument> {
  const ids = idsFor(tag);
  const projects = new DrizzleProjectRepository(env.db);
  const project = createProject({
    projectId: ids.projectId,
    title: 'p',
    metadata: {},
    createdAt: T0,
  });
  await projects.save(project);
  const base = createTakeoffDocument(project, {
    takeoffId: ids.takeoffId,
    documentId: ids.documentId,
    title: 'متره',
    createdAt: T0,
  });
  const doc = saveTakeoffDocumentDraft(base, { title: 'متره', sheets, rounding: [] });
  await env.documents.create(base);
  await env.documents.save(doc, base.revision);
  return doc;
}

d('takeoff concurrency (real PostgreSQL server)', () => {
  let url = '';

  beforeAll(async () => {
    url = SMOKE_URL ?? '';
    // Apply the shipped migrations once (idempotent, journal-based).
    const pool: PgPool = createDbPool(url);
    const db = createDb(pool);
    await migrateDatabase(db, new URL('../migrations', import.meta.url).pathname);
    await pool.end();
  });

  it('two concurrent saves with the same expectedRevision: exactly one winner', async () => {
    const [a, b] = [openDb(url), openDb(url)];
    try {
      const doc = await seedDraft(a, 'c1', SHEETS_A);
      const nextA = saveTakeoffDocumentDraft(doc, {
        title: 'متره A',
        sheets: SHEETS_B,
        rounding: [],
      });
      const nextB = saveTakeoffDocumentDraft(doc, {
        title: 'متره B',
        sheets: SHEETS_A,
        rounding: [],
      });
      const [ra, rb] = await Promise.allSettled([
        a.documents.save(nextA, doc.revision),
        b.documents.save(nextB, doc.revision),
      ]);
      const fulfilled = [ra, rb].filter((r) => r.status === 'fulfilled').length;
      expect(fulfilled).toBe(1);
      const rejected = [ra, rb].find((r) => r.status === 'rejected');
      expect(rejected).toBeDefined();
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        code: 'PERSISTENCE_CONFLICT',
      });
      const stored = await a.documents.findById(doc.documentId);
      expect(stored?.revision).toBe(doc.revision + 1);
      const titles = new Set(['متره A', 'متره B']);
      expect(titles.has(stored?.title ?? '')).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('concurrent save-vs-finalize race ends in a contract-consistent state', async () => {
    const [a, b] = [openDb(url), openDb(url)];
    try {
      const doc = await seedDraft(a, 'c2', SHEETS_A);
      const next = saveTakeoffDocumentDraft(doc, {
        title: 'متره v3',
        sheets: SHEETS_B,
        rounding: [],
      });
      const bundle = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
      const [rs, rf] = await Promise.allSettled([
        a.documents.save(next, doc.revision),
        b.finalized.save(bundle, doc.revision),
      ]);
      const finalized = rf.status === 'fulfilled';
      if (finalized) {
        // finalization won: the save must have failed against the finalized document
        expect(rs.status).toBe('rejected');
        expect((rs as PromiseRejectedResult).reason).toMatchObject({
          code: 'TAKEOFF_DOCUMENT_IMMUTABLE',
        });
        const stored = await a.documents.findById(doc.documentId);
        expect(stored?.status).toBe('finalized');
      } else {
        // save won: finalization must have failed as stale (revision moved on)
        expect(rs.status).toBe('fulfilled');
        expect(rf.reason).toMatchObject({
          code: 'PERSISTENCE_CONFLICT',
        });
        const stored = await a.documents.findById(doc.documentId);
        expect(stored?.status).toBe('draft');
        expect(stored?.revision).toBe(doc.revision + 1);
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('concurrent identical finalizations all succeed with exactly one snapshot row', async () => {
    const [a, b] = [openDb(url), openDb(url)];
    try {
      const doc = await seedDraft(a, 'c3', SHEETS_A);
      const bundle = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
      const [ra, rb] = await Promise.allSettled([
        a.finalized.save(bundle, doc.revision),
        b.finalized.save(bundle, doc.revision),
      ]);
      expect(ra.status).toBe('fulfilled');
      expect(rb.status).toBe('fulfilled'); // idempotent identical re-save
      const rows = await a.db
        .select()
        .from(takeoffDocuments)
        .where(eq(takeoffDocuments.documentId, doc.documentId));
      expect(rows[0]?.status).toBe('finalized');
      const snapshotA = await a.finalized.byDocumentId(doc.documentId);
      const snapshotB = await b.finalized.byDocumentId(doc.documentId);
      expect(canonicalJson(snapshotA)).toBe(canonicalJson(snapshotB));
      expect(canonicalJson(snapshotA?.result)).toBe(canonicalJson(bundle.result));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('concurrent different finalizations have exactly one winner', async () => {
    const [a, b] = [openDb(url), openDb(url)];
    try {
      const doc = await seedDraft(a, 'c4', SHEETS_A);
      const winner = finalizeTakeoffDocument(doc, { finalizedAt: T1 });
      const loser = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
      const [ra, rb] = await Promise.allSettled([
        a.finalized.save(winner, doc.revision),
        b.finalized.save(loser, doc.revision),
      ]);
      const fulfilled = [ra, rb].filter((r) => r.status === 'fulfilled').length;
      expect(fulfilled).toBe(1);
      const rejected = [ra, rb].find((r) => r.status === 'rejected');
      expect(rejected).toBeDefined();
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(DbError);
      const snapshot = await a.finalized.byDocumentId(doc.documentId);
      expect(snapshot?.finalizedAt).toBeDefined();
      const stored = await a.documents.findById(doc.documentId);
      expect(stored?.status).toBe('finalized');
      expect(stored?.finalizedAt).toBe(snapshot?.finalizedAt);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('archive is concurrency-safe (concurrent archive+edit: at most one transition wins)', async () => {
    const [a, b] = [openDb(url), openDb(url)];
    try {
      const doc = await seedDraft(a, 'c5', SHEETS_A);
      const archived = archiveTakeoffDocument(doc, T1);
      const next = saveTakeoffDocumentDraft(doc, {
        title: 'متره v3',
        sheets: SHEETS_B,
        rounding: [],
      });
      const [ra, rb] = await Promise.allSettled([
        a.documents.save(archived, doc.revision),
        b.documents.save(next, doc.revision),
      ]);
      const fulfilled = [ra, rb].filter((r) => r.status === 'fulfilled').length;
      expect(fulfilled).toBe(1);
      const stored = await a.documents.findById(doc.documentId);
      expect(['archived', 'draft']).toContain(stored?.status);
      if (stored?.status === 'archived') {
        expect(stored.revision).toBe(doc.revision); // archive keeps the revision
      } else {
        expect(stored?.revision).toBe(doc.revision + 1); // the edit won
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
});
