/**
 * Real-server concurrency, rollback and atomicity verification (Phase 16, §13–§16).
 *
 * These tests run ONLY against a real PostgreSQL server (node-postgres over TCP) and are
 * gated by `COSTGENIUS_SMOKE_DATABASE_URL` exactly like the vertical-slice smoke test.
 * Without the variable the suite is SKIPPED and reported NOT RUN — PGlite results are
 * never presented as server verification.
 *
 * Verified invariants:
 * - §13 cross-connection immutability: after connection #1 finalizes and closes,
 *   connection #2 cannot add lines, downgrade the status, rewrite the aggregate or
 *   change the finalized snapshot; the identical bundle re-save is a no-op.
 * - §14 concurrency: sequential mutate→finalize includes the appended line; a truly
 *   concurrent finalize-vs-append race always ends in a contract-consistent state (the
 *   persisted finalized snapshot always matches the version's stored boq_lines rows);
 *   concurrent identical finalizations all succeed with exactly one snapshot row;
 *   concurrent different finalizations have exactly one winner.
 * - §15 rollback: a transaction that fails after writing rolls back completely (no
 *   partial state survives on a new connection).
 * - §16 atomic finalization: version status + BOQ lines + finalized snapshot commit
 *   together or not at all — a failure after the aggregate writes leaves nothing.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  boqLines,
  canonicalJson,
  createDb,
  createDbPool,
  DrizzleEstimateRepository,
  DrizzleFinalizedEstimateRepository,
  DrizzleProjectRepository,
  estimateVersions,
  estimates,
  finalizedEstimates,
  migrateDatabase,
  type DbClient,
} from '@costgenius/db';
import { publishStagedImport } from '@costgenius/pricebook';
import type { PublishedDataset } from '@costgenius/pricebook';
import type { Estimate } from '@costgenius/boq';
import type { FinalizedEstimate } from '@costgenius/projects';
import {
  addEstimateLines,
  createEstimateForProject,
  createProject,
  finalizeEstimate,
  startEstimateVersion,
} from '@costgenius/projects';

const SMOKE_URL = process.env['COSTGENIUS_SMOKE_DATABASE_URL'];
const MIGRATIONS_FOLDER = new URL('../../../packages/db/migrations', import.meta.url).pathname;
const DATASET_PATH = new URL(
  '../../../packages/pricebook/data/verified-1404.staged.v0.1.0.json',
  import.meta.url,
).pathname;

const INSTANT = '2026-01-01T00:00:00Z';
const INSTANT_2 = '2026-01-01T00:00:01Z';
const BUILDING_ID = 'building-concurrency';

/** Two real 1404 rows (enough to observe append-vs-finalize interleavings). */
const LINE_1 = { lineId: 'l1', pricebookCode: '010101', quantity: '1000', unit: 'm2' } as const;
const LINE_2 = { lineId: 'l2', pricebookCode: '010517', quantity: '5', unit: 'm2' } as const;

const COEFFICIENTS = {
  floor: {
    buildingId: BUILDING_ID,
    groundFloorArea: '600',
    firstBasementArea: '400',
    aboveGroundFloors: [...Array.from({ length: 10 }, () => ({ area: '500' })), { area: '400' }],
    belowGroundFloors: Array.from({ length: 3 }, () => ({ area: '400' })),
    totalBuildingFloorArea: '7600',
  },
  overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' } as const,
  regional: { parts: [{ regionId: 'r-conc', coefficient: '1.1', executionCost: '1' }] },
  siteSetup: { lumpSumAmount: '12000000' },
};

interface Ids {
  readonly projectId: string;
  readonly estimateId: string;
  readonly versionId: string;
}

/** Deterministic UUID-shaped identities per scenario (4 hex chars tag). */
function idsFor(tag: string): Ids {
  if (!/^[0-9a-f]{4}$/.test(tag)) throw new Error(`tag must be 4 hex chars: ${tag}`);
  return {
    projectId: `${tag}aaaa-aa00-4000-8000-00000000aaaa`,
    estimateId: `${tag}bbbb-bb00-4000-8000-00000000bbbb`,
    versionId: `${tag}bbbb-bb00-4000-8000-00000000bbbb-v1`,
  };
}

/** The node-postgres pool type, derived from the factory (no direct pg dependency here). */
type PgPool = ReturnType<typeof createDbPool>;

interface Handle {
  readonly db: DbClient;
  readonly projects: DrizzleProjectRepository;
  readonly estimates: DrizzleEstimateRepository;
  readonly finalized: DrizzleFinalizedEstimateRepository;
  readonly close: () => Promise<void>;
}

async function openDb(url: string): Promise<Handle> {
  const pool: PgPool = createDbPool(url);
  const db = createDb(pool);
  await migrateDatabase(db, MIGRATIONS_FOLDER); // idempotent (journal-based)
  return {
    db,
    projects: new DrizzleProjectRepository(db),
    estimates: new DrizzleEstimateRepository(db),
    finalized: new DrizzleFinalizedEstimateRepository(db),
    close: () => pool.end(),
  };
}

function loadDataset(): PublishedDataset {
  return publishStagedImport(
    JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as Parameters<typeof publishStagedImport>[0],
  );
}

/** Persists project → estimate → draft version carrying LINE_1 only. */
async function seedDraft(h: Handle, dataset: PublishedDataset, ids: Ids): Promise<void> {
  const project = createProject({
    projectId: ids.projectId,
    title: 'concurrency',
    createdAt: INSTANT,
  });
  await h.projects.save(project);
  let estimate = createEstimateForProject(project, {
    estimateId: ids.estimateId,
    title: 'concurrency estimate',
  });
  estimate = startEstimateVersion(dataset, estimate, {
    createdAt: INSTANT,
    buildingId: BUILDING_ID,
  });
  const added = addEstimateLines(dataset, estimate, ids.versionId, [LINE_1]);
  if (!added.ok) throw new Error(`seed lines must resolve: ${JSON.stringify(added.failures)}`);
  await h.estimates.save(added.estimate);
}

/** Loads the aggregate owning the version or fails loudly (test scaffolding). */
async function estimateOf(h: Handle, ids: Ids): Promise<Estimate> {
  const estimate = await h.estimates.findByVersionId(ids.versionId);
  if (estimate === undefined) throw new Error(`estimate of ${ids.versionId} must exist`);
  return estimate;
}

function versionOf(estimate: Estimate, ids: Ids): Estimate['versions'][number] {
  const version = estimate.versions.find((v) => v.versionId === ids.versionId);
  if (version === undefined) throw new Error(`version ${ids.versionId} must exist`);
  return version;
}

async function bundleOf(h: Handle, ids: Ids): Promise<FinalizedEstimate> {
  const bundle = await h.finalized.byVersionId(ids.versionId);
  if (bundle === undefined) throw new Error(`finalized bundle of ${ids.versionId} must exist`);
  return bundle;
}

/** Stable error identity of a rejected concurrent operation (never exposes internals). */
function errorLike(reason: unknown): { name: string; code: string | undefined } {
  if (reason instanceof Error) {
    const code = (reason as { code?: unknown }).code;
    return { name: reason.name, code: typeof code === 'string' ? code : undefined };
  }
  return { name: 'not-an-error', code: undefined };
}

describe.skipIf(SMOKE_URL === undefined)('real-server concurrency, rollback, atomicity', () => {
  // Clean slate: the env-gated URL is, by the documented contract of
  // COSTGENIUS_SMOKE_DATABASE_URL, a DISPOSABLE dedicated verification database. These
  // scenarios persist finalized history under deterministic ids, so a re-run against
  // leftover state must start from an empty store. Only the TWELVE tables this
  // application owns (plus the Drizzle migration journal) are touched — the five
  // estimate-family tables of migration 0000, the four takeoff-family tables of
  // 0001_d016_takeoff and the three governance tables of 0002_p8_governance, children
  // before parents (P7-S3 repaired the stale five-table drop that failed with 42P07 on
  // used databases; P8-A S1 extends the list to the current twelve); any other content
  // of that database is left alone. The migrations are re-applied by openDb().
  beforeAll(async () => {
    const url = SMOKE_URL as string;
    const pool = createDbPool(url);
    try {
      await pool.query(
        'DROP TABLE IF EXISTS takeoff_lines, takeoff_sheets, finalized_takeoffs, takeoff_documents, boq_lines, finalized_estimates, estimate_versions, estimates, sessions, audit_events, users, projects CASCADE',
      );
      await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    } finally {
      await pool.end();
    }
  });

  it('§13 cross-connection immutability: a closed finalizer’s history cannot be changed', async () => {
    const url = SMOKE_URL as string;
    const dataset = loadDataset();
    const ids = idsFor('1301');
    const a = await openDb(url);
    try {
      await seedDraft(a, dataset, ids);
      const draft = await estimateOf(a, ids);
      const bundle = finalizeEstimate(draft, ids.versionId, COEFFICIENTS, {
        reportId: 'rep-imm',
        generatedAt: INSTANT,
        finalizedAt: INSTANT,
      });
      await a.finalized.save(bundle);
    } finally {
      await a.close(); // connection #1 is gone; everything below is a NEW connection
    }

    const b = await openDb(url);
    try {
      const reloaded = await bundleOf(b, ids);
      const version = versionOf(reloaded.estimate, ids);
      expect(version.status).toBe('finalized');

      // (1) add a line to the finalized version → aggregate rewrite is refused
      const first = version.lines[0];
      if (first === undefined) throw new Error('finalized version must carry its line');
      const withExtra: Estimate = {
        ...reloaded.estimate,
        versions: [{ ...version, lines: [...version.lines, { ...first, lineId: 'l-extra' }] }],
      };
      await expect(b.estimates.save(withExtra)).rejects.toMatchObject({
        name: 'DbError',
        code: 'FINALIZED_ESTIMATE_IMMUTABLE',
      });

      // (2) downgrade the status back to draft → refused
      const downgraded: Estimate = {
        ...reloaded.estimate,
        versions: [{ ...version, status: 'draft' }],
      };
      await expect(b.estimates.save(downgraded)).rejects.toMatchObject({
        name: 'DbError',
        code: 'FINALIZED_ESTIMATE_IMMUTABLE',
      });

      // (3) change the finalized snapshot (different finalization instant) → refused
      const changed: FinalizedEstimate = { ...structuredClone(reloaded), finalizedAt: INSTANT_2 };
      await expect(b.finalized.save(changed)).rejects.toMatchObject({
        name: 'DbError',
        code: 'FINALIZED_ESTIMATE_IMMUTABLE',
      });

      // (4) re-saving the IDENTICAL bundle is a documented no-op
      await expect(b.finalized.save(reloaded)).resolves.toBeUndefined();

      // (5) history is byte-identical to what connection #1 wrote
      const again = await bundleOf(b, ids);
      expect(canonicalJson(again)).toBe(canonicalJson(reloaded));
    } finally {
      await b.close();
    }
  });

  it('§14 sequential: a line appended by one connection is included by the next finalizer', async () => {
    const url = SMOKE_URL as string;
    const dataset = loadDataset();
    const ids = idsFor('1401');
    const a = await openDb(url);
    try {
      await seedDraft(a, dataset, ids);
    } finally {
      await a.close();
    }

    // connection B appends a line to the draft
    const b = await openDb(url);
    try {
      const draft = await estimateOf(b, ids);
      const added = addEstimateLines(dataset, draft, ids.versionId, [LINE_2]);
      if (!added.ok) throw new Error(`append must resolve: ${JSON.stringify(added.failures)}`);
      await b.estimates.save(added.estimate);
    } finally {
      await b.close();
    }

    // connection C finalizes from a FRESH reload (never a stale in-memory copy)
    const c = await openDb(url);
    try {
      const fresh = await estimateOf(c, ids);
      const bundle = finalizeEstimate(fresh, ids.versionId, COEFFICIENTS, {
        reportId: 'rep-seq',
        generatedAt: INSTANT,
        finalizedAt: INSTANT,
      });
      await c.finalized.save(bundle);
      const reloaded = await bundleOf(c, ids);
      expect(reloaded.calculation.rollup.lineCount).toBe(2);
      expect(reloaded.estimate.versions).toHaveLength(1);
      expect(versionOf(reloaded.estimate, ids).lines).toHaveLength(2);
    } finally {
      await c.close();
    }
  });

  it('§14 concurrent finalize vs append: the persisted snapshot always matches the stored lines', async () => {
    const url = SMOKE_URL as string;
    const dataset = loadDataset();
    const ROUNDS = 12;
    const a = await openDb(url);
    const b = await openDb(url);
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        const tag = round.toString(16).padStart(4, '0');
        const ids = idsFor(`2${tag.slice(1)}`); // 2000..200b — unique per round
        await seedDraft(a, dataset, ids);

        const finalize = async (): Promise<void> => {
          const fresh = await estimateOf(a, ids);
          const bundle = finalizeEstimate(fresh, ids.versionId, COEFFICIENTS, {
            reportId: `rep-race-${tag}`,
            generatedAt: INSTANT,
            finalizedAt: INSTANT,
          });
          await a.finalized.save(bundle);
        };
        const append = async (): Promise<void> => {
          const fresh = await estimateOf(b, ids);
          const added = addEstimateLines(dataset, fresh, ids.versionId, [LINE_2]);
          if (!added.ok) throw new Error(`append must resolve: ${JSON.stringify(added.failures)}`);
          await b.estimates.save(added.estimate);
        };

        const results = await Promise.allSettled([finalize(), append()]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBeGreaterThanOrEqual(1); // the race always makes progress

        for (const r of results) {
          if (r.status === 'rejected') {
            const e = errorLike(r.reason);
            // The losing operation may fail at EITHER layer, both stable 409-contract
            // outcomes: the application guard (BoqError VERSION_FINALIZED — it loaded a
            // version the winner had already finalized) or the persistence contract
            // (DbError FINALIZED_ESTIMATE_IMMUTABLE / PERSISTENCE_CONFLICT — the write
            // lost the version-row lock). Anything else (e.g. a raw driver error) fails.
            const legal =
              (e.name === 'DbError' &&
                (e.code === 'FINALIZED_ESTIMATE_IMMUTABLE' || e.code === 'PERSISTENCE_CONFLICT')) ||
              (e.name === 'BoqError' && e.code === 'VERSION_FINALIZED');
            expect(legal).toBe(true);
          }
        }

        // THE invariant: whenever a finalized snapshot exists, it accounts for exactly
        // the lines stored in boq_lines for that version (no snapshot/rows divergence).
        const snapshot = await b.finalized.byVersionId(ids.versionId);
        const storedRows = await b.db
          .select()
          .from(boqLines)
          .where(eq(boqLines.versionId, ids.versionId));
        const storedVersion = await b.db
          .select()
          .from(estimateVersions)
          .where(eq(estimateVersions.versionId, ids.versionId));
        expect(storedVersion).toHaveLength(1);
        if (snapshot !== undefined) {
          expect(snapshot.calculation.rollup.lineCount).toBe(storedRows.length);
          expect(versionOf(snapshot.estimate, ids).lines).toHaveLength(storedRows.length);
          expect(storedVersion[0]?.status).toBe('finalized');
        } else {
          expect(storedVersion[0]?.status).toBe('draft');
        }
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('§14 concurrent IDENTICAL finalization: both succeed, exactly one snapshot row', async () => {
    const url = SMOKE_URL as string;
    const dataset = loadDataset();
    const ids = idsFor('1402');
    const a = await openDb(url);
    const b = await openDb(url);
    try {
      await seedDraft(a, dataset, ids);
      const draftA = await estimateOf(a, ids);
      const draftB = await estimateOf(b, ids);
      const bundleA = finalizeEstimate(draftA, ids.versionId, COEFFICIENTS, {
        reportId: 'rep-same',
        generatedAt: INSTANT,
        finalizedAt: INSTANT,
      });
      const bundleB = finalizeEstimate(draftB, ids.versionId, COEFFICIENTS, {
        reportId: 'rep-same',
        generatedAt: INSTANT,
        finalizedAt: INSTANT,
      });
      expect(canonicalJson(bundleA.calculation)).toBe(canonicalJson(bundleB.calculation));

      const results = await Promise.allSettled([
        a.finalized.save(bundleA),
        b.finalized.save(bundleB),
      ]);
      for (const r of results) {
        if (r.status === 'rejected')
          throw new Error(`identical finalize must not fail: ${String(r.reason)}`);
      }
      const rows = await a.db
        .select()
        .from(finalizedEstimates)
        .where(eq(finalizedEstimates.versionId, ids.versionId));
      expect(rows).toHaveLength(1);
      const reloaded = await bundleOf(a, ids);
      expect(canonicalJson(reloaded.calculation)).toBe(canonicalJson(bundleA.calculation));
      expect(reloaded.finalizedAt).toBe(INSTANT);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('§14 concurrent DIFFERENT finalization: exactly one winner, deterministic contract error for the loser', async () => {
    const url = SMOKE_URL as string;
    const dataset = loadDataset();
    const ids = idsFor('1403');
    const a = await openDb(url);
    const b = await openDb(url);
    try {
      await seedDraft(a, dataset, ids);
      const winner = finalizeEstimate(await estimateOf(a, ids), ids.versionId, COEFFICIENTS, {
        reportId: 'rep-diff',
        generatedAt: INSTANT,
        finalizedAt: INSTANT,
      });
      const loser = finalizeEstimate(await estimateOf(b, ids), ids.versionId, COEFFICIENTS, {
        reportId: 'rep-diff',
        generatedAt: INSTANT,
        finalizedAt: INSTANT_2,
      });

      const results = await Promise.allSettled([a.finalized.save(winner), b.finalized.save(loser)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      expect(fulfilled).toBe(1);
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (rejected === undefined) throw new Error('exactly one rejection expected');
      const e = errorLike(rejected.reason);
      expect(e.name).toBe('DbError');
      expect(e.code).toBe('FINALIZED_ESTIMATE_IMMUTABLE');

      const persisted = await bundleOf(a, ids);
      expect([INSTANT, INSTANT_2]).toContain(persisted.finalizedAt);
      const rows = await a.db
        .select()
        .from(finalizedEstimates)
        .where(eq(finalizedEstimates.versionId, ids.versionId));
      expect(rows).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('§15 a transaction that fails after writing rolls back completely', async () => {
    const url = SMOKE_URL as string;
    const dataset = loadDataset();
    const ids = idsFor('1501');
    const idsX = idsFor('1502'); // owner of the colliding version
    const a = await openDb(url);
    try {
      await seedDraft(a, dataset, idsX);

      // E2 is a brand-new estimate whose version reuses X's versionId: syncEstimate
      // inserts the E2 estimate row, THEN hits the version-identity conflict — the
      // transaction must roll the insert back with it.
      const owner = await estimateOf(a, idsX);
      const ownerVersion = versionOf(owner, idsX);
      const e2: Estimate = {
        ...owner,
        estimateId: ids.estimateId,
        title: 'rollback probe',
        versions: [{ ...ownerVersion, estimateId: ids.estimateId }],
      };
      await expect(a.estimates.save(e2)).rejects.toMatchObject({
        name: 'DbError',
        code: 'PERSISTENCE_CONFLICT',
      });
    } finally {
      await a.close();
    }

    // a NEW connection verifies no partial state survived
    const b = await openDb(url);
    try {
      expect(await b.estimates.findById(ids.estimateId)).toBeUndefined();
      const ownerAgain = await estimateOf(b, idsX);
      expect(versionOf(ownerAgain, idsX).lines).toHaveLength(1);
      const rows = await b.db
        .select()
        .from(estimates)
        .where(eq(estimates.estimateId, ids.estimateId));
      expect(rows).toHaveLength(0);
    } finally {
      await b.close();
    }
  });

  it('§16 failed finalization leaves no partial state (status + lines + snapshot are atomic)', async () => {
    const url = SMOKE_URL as string;
    const dataset = loadDataset();
    const ids = idsFor('1601');
    const atom = idsFor('1602'); // the estimate whose aggregate writes will be rolled back
    const a = await openDb(url);
    try {
      await seedDraft(a, dataset, ids);

      // Build a legitimate finalized bundle for a NEW estimate/version, then point its
      // snapshot at a version that was never persisted: syncEstimate inserts the
      // estimate + version + lines, and the snapshot insert fails on the FK — everything
      // must roll back together.
      const draft = await estimateOf(a, ids);
      const draftVersion = versionOf(draft, ids);
      const fresh: Estimate = {
        ...draft,
        estimateId: atom.estimateId,
        title: 'atomicity probe',
        versions: [{ ...draftVersion, estimateId: atom.estimateId, versionId: atom.versionId }],
      };
      const bundle = finalizeEstimate(fresh, atom.versionId, COEFFICIENTS, {
        reportId: 'rep-atom',
        generatedAt: INSTANT,
        finalizedAt: INSTANT,
      });
      const broken: FinalizedEstimate = {
        ...structuredClone(bundle),
        versionId: 'atom-ghost-version',
      };
      await expect(a.finalized.save(broken)).rejects.toThrow();
    } finally {
      await a.close();
    }

    const b = await openDb(url);
    try {
      expect(await b.estimates.findById(atom.estimateId)).toBeUndefined();
      expect(await b.estimates.findByVersionId(atom.versionId)).toBeUndefined();
      const versionRows = await b.db
        .select()
        .from(estimateVersions)
        .where(eq(estimateVersions.versionId, atom.versionId));
      expect(versionRows).toHaveLength(0);
      const lineRows = await b.db
        .select()
        .from(boqLines)
        .where(eq(boqLines.versionId, atom.versionId));
      expect(lineRows).toHaveLength(0);
      expect(await b.finalized.byVersionId('atom-ghost-version')).toBeUndefined();
      // the original draft is untouched
      const original = await estimateOf(b, ids);
      expect(versionOf(original, ids).status).toBe('draft');
    } finally {
      await b.close();
    }
  });
});
