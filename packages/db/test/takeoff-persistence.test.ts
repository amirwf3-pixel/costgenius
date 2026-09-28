/**
 * D-016 Phase 2 persistence tests (task matrix A–V, W, X, Y) against REAL PostgreSQL
 * (PGlite in-process; actual migrations, actual repository code path — the same static
 * types as the production node-postgres driver). Concurrency against a real server
 * (parallel connections, FOR UPDATE serialization) is covered by the env-gated
 * `takeoff-concurrency.server.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DbError,
  DrizzleFinalizedTakeoffRepository,
  DrizzleProjectRepository,
  DrizzleTakeoffDocumentRepository,
  canonicalJson,
  takeoffLines,
  takeoffSheets,
  type DbClient,
} from '../src/index.js';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  archiveTakeoffDocument,
  createFollowUpTakeoffDocument,
  createProject,
  createTakeoffDocument,
  finalizeTakeoffDocument,
  saveTakeoffDocumentDraft,
  takeoffCalculationInputOf,
  unarchiveTakeoffDocument,
  calculateTakeoff,
  type FinalizedTakeoff,
  type TakeoffDocument,
  type TakeoffDocumentSheet,
} from '@costgenius/projects';

const T0 = '2026-01-01T00:00:00Z';
const T1 = '2026-01-02T00:00:00Z';
const T2 = '2026-01-03T00:00:00Z';

async function freshDb(): Promise<{
  pg: PGlite;
  db: DbClient;
  documents: DrizzleTakeoffDocumentRepository;
  finalized: DrizzleFinalizedTakeoffRepository;
  projects: DrizzleProjectRepository;
}> {
  const pg = new PGlite();
  const raw = drizzle(pg);
  await migrate(raw, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
  const db = raw as unknown as DbClient;
  return {
    pg,
    db,
    documents: new DrizzleTakeoffDocumentRepository(db),
    finalized: new DrizzleFinalizedTakeoffRepository(db),
    projects: new DrizzleProjectRepository(db),
  };
}

const SHEETS: readonly TakeoffDocumentSheet[] = [
  {
    sheetId: 'S1',
    name: 'فونداسیون',
    lines: [
      {
        lineId: 'L1',
        rowNo: 1,
        description: 'بتن منفی',
        location: 'محور A',
        itemCode: 'SYN-1001',
        kind: 'addition',
        unit: 'm3',
        origin: 'user',
        ruleRefs: ['IR-1404-M-CONC-01'],
        quantity: {
          type: 'dimensional',
          profile: 'LWH',
          floorCount: '2',
          similarCount: '4',
          length: '1.005',
          width: '2',
          height: '3',
        },
      },
      {
        lineId: 'L2',
        rowNo: 2,
        description: 'کسر بازشوها',
        kind: 'deduction',
        unit: 'm3',
        quantity: { type: 'manual', value: '0.5', justification: 'برآورد چشمی بازشوها' },
      },
    ],
  },
  {
    sheetId: 'S2',
    name: 'بدنه',
    lines: [
      {
        lineId: 'L3',
        rowNo: 1,
        description: 'متره ارجاعی',
        itemCode: 'SYN-1002',
        kind: 'addition',
        unit: 'm3',
        quantity: {
          type: 'reference',
          terms: [
            { lineId: 'L1', factor: '1', use: 'magnitude' },
            { lineId: 'L2', factor: '-1', use: 'magnitude' },
          ],
        },
      },
      {
        lineId: 'L4',
        rowNo: 2,
        description: 'عبارت محاسباتی',
        itemCode: 'SYN-1002',
        kind: 'addition',
        unit: 'm3',
        quantity: {
          type: 'expression',
          node: {
            op: 'round',
            arg: {
              op: 'sub',
              args: [
                { op: 'const', value: '50' },
                { op: 'ref', lineId: 'L3', use: 'magnitude' },
              ],
            },
            rule: { scale: 1, mode: 'HALF_UP' },
          },
        },
      },
    ],
  },
];

const ROUNDING = [
  {
    target: 'line' as const,
    selector: { lineIds: ['L1'] },
    scale: 0,
    mode: 'HALF_UP' as const,
    sourceStatus: 'design' as const,
  },
  {
    target: 'item-total' as const,
    selector: { itemCode: 'SYN-1002' },
    scale: 2,
    mode: 'HALF_UP' as const,
    sourceStatus: 'design' as const,
  },
  {
    target: 'sheet-total' as const,
    selector: { unit: 'm3' },
    scale: 1,
    mode: 'HALF_EVEN' as const,
    sourceStatus: 'verified' as const,
    source: {
      sourceDocument: 'فهرست بها ۱۴۰۴',
      edition: '1404',
      page: '61',
      section: 'clause 4',
      sourceFileHash: 'deadbeef',
    },
  },
];

async function seedProject(
  env: Awaited<ReturnType<typeof freshDb>>,
  projectId: string,
): Promise<void> {
  await env.projects.save(
    createProject({ projectId, title: 'پروژه آزمایشی', metadata: {}, createdAt: T0 }),
  );
}

const at = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined) throw new Error(`missing element ${String(index)}`);
  return value;
};

describe('A/B · create and load a draft', () => {
  it('persists and reassembles the document exactly (canonical round-trip)', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const doc = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره ساختمان', createdAt: T0 },
    );
    const withContent = saveTakeoffDocumentDraft(doc, {
      title: 'متره ساختمان',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(doc);
    await env.documents.save(withContent, doc.revision);

    const loaded = await env.documents.findById('doc-1');
    expect(loaded).toBeDefined();
    expect(canonicalJson(loaded)).toBe(canonicalJson(withContent));
    expect(loaded?.status).toBe('draft');
    expect(loaded?.revision).toBe(2);
    expect(loaded?.documentNumber).toBe(1);
    expect(Object.isFrozen(loaded)).toBe(true);
  });
});

describe('C/D · draft update and expectedRevision success', () => {
  it('replaces the content and increments the revision', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره', createdAt: T0 },
    );
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: [at(SHEETS, 0)],
      rounding: [],
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);

    const fewerSheets: readonly TakeoffDocumentSheet[] = [
      {
        sheetId: 'X1',
        name: 'تنها',
        lines: [
          {
            lineId: 'N1',
            rowNo: 5,
            description: 'خط جدید',
            kind: 'addition',
            unit: 'm2',
            quantity: { type: 'dimensional', profile: 'LW', length: '3', width: '4' },
          },
        ],
      },
    ];
    const v3 = saveTakeoffDocumentDraft(v2, {
      title: 'متره ویرایش‌شده',
      sheets: fewerSheets,
      rounding: [],
    });
    await env.documents.save(v3, v2.revision);

    const loaded = await env.documents.findById('doc-1');
    expect(loaded?.revision).toBe(3);
    expect(loaded?.title).toBe('متره ویرایش‌شده');
    expect(loaded?.sheets.map((s) => s.sheetId)).toEqual(['X1']);
    expect(loaded?.sheets[0]?.lines[0]?.rowNo).toBe(5);
    // replaced content is fully gone (no orphans, no leftovers)
    const lineRows = await env.db
      .select()
      .from(takeoffLines)
      .where(eq(takeoffLines.documentId, 'doc-1'));
    const sheetRows = await env.db
      .select()
      .from(takeoffSheets)
      .where(eq(takeoffSheets.documentId, 'doc-1'));
    expect(lineRows.map((r) => r.lineId)).toEqual(['N1']);
    expect(sheetRows.map((r) => r.sheetId)).toEqual(['X1']);
  });
});

describe('E · stale expectedRevision', () => {
  it('rejects a stale revision deterministically', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره', createdAt: T0 },
    );
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);
    const v3 = saveTakeoffDocumentDraft(v2, {
      title: 'متره v3',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.save(v3, v2.revision);
    // v2.revision is now stale (stored is 3)
    const v4 = saveTakeoffDocumentDraft(v3, {
      title: 'متره v4',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await expect(env.documents.save(v4, v2.revision)).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
    const loaded = await env.documents.findById('doc-1');
    expect(loaded?.revision).toBe(3); // untouched
  });

  it('rejects a revision jump (must increment by exactly one)', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره', createdAt: T0 },
    );
    await env.documents.create(base);
    const jumped: TakeoffDocument = { ...base, revision: 5 };
    await expect(env.documents.save(jumped, base.revision)).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
  });
});

describe('G/H/I · archive, visibility and lifecycle validation', () => {
  async function seededDraft() {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره', createdAt: T0 },
    );
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);
    return { env, doc: v2 };
  }

  it('archives a draft softly (status flip only; rows kept)', async () => {
    const { env, doc } = await seededDraft();
    const archived = archiveTakeoffDocument(doc, T1);
    await env.documents.save(archived, doc.revision);
    const loaded = await env.documents.findById('doc-1');
    expect(loaded?.status).toBe('archived');
    expect(loaded?.archivedAt).toBe(T1);
    expect(loaded?.revision).toBe(doc.revision); // unchanged
    expect(loaded?.sheets).toHaveLength(2); // content untouched
    const rows = await env.db
      .select()
      .from(takeoffLines)
      .where(eq(takeoffLines.documentId, 'doc-1'));
    expect(rows).toHaveLength(4); // nothing hard-deleted
  });

  it('unarchives back to draft with identical content and revision', async () => {
    const { env, doc } = await seededDraft();
    const archived = archiveTakeoffDocument(doc, T1);
    await env.documents.save(archived, doc.revision);
    const back = unarchiveTakeoffDocument(archived);
    await env.documents.save(back, archived.revision);
    const loaded = await env.documents.findById('doc-1');
    expect(loaded?.status).toBe('draft');
    expect(loaded?.archivedAt).toBeUndefined();
    expect(canonicalJson(loaded)).toBe(canonicalJson(doc));
  });

  it('rejects editing or finalizing an archived draft', async () => {
    const { env, doc } = await seededDraft();
    const archived = archiveTakeoffDocument(doc, T1);
    await env.documents.save(archived, doc.revision);

    // a raw-constructed illegal state (bypassing the domain guard) is rejected by the store too
    const edited: TakeoffDocument = {
      ...archived,
      revision: archived.revision + 1,
      title: 'x',
      sheets: [],
      rounding: [],
    };
    await expect(env.documents.save(edited, archived.revision)).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
    const finalized = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
    await expect(env.finalized.save(finalized, archived.revision)).rejects.toMatchObject({
      code: 'TAKEOFF_INVALID_TRANSITION',
    });
  });

  it('rejects illegal transitions: archive a non-draft, unarchive a draft, edit a finalized document', async () => {
    const { env, doc } = await seededDraft();
    expect(() => unarchiveTakeoffDocument(doc)).toThrow(/only an archived draft/);

    const finalized = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
    await env.finalized.save(finalized, doc.revision);
    expect(() => archiveTakeoffDocument(finalized.document, T2)).toThrow(/only a draft/);

    const edited: TakeoffDocument = {
      ...finalized.document,
      revision: finalized.document.revision + 1,
      title: 'x',
      sheets: [],
      rounding: [],
    };
    await expect(env.documents.save(edited, finalized.document.revision)).rejects.toMatchObject({
      code: 'TAKEOFF_DOCUMENT_IMMUTABLE',
    });
    // domain layer already refuses to produce these states
    expect(() =>
      saveTakeoffDocumentDraft(finalized.document, { title: 'x', sheets: [], rounding: [] }),
    ).toThrow(/only a draft/);
  });
});

describe('J/K/L · finalization', () => {
  async function seededDraft() {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره', createdAt: T0 },
    );
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);
    return { env, doc: v2 };
  }

  it('finalizes atomically: status flip + immutable snapshot in one transaction', async () => {
    const { env, doc } = await seededDraft();
    const bundle = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
    await env.finalized.save(bundle, doc.revision);

    const loaded = await env.documents.findById('doc-1');
    expect(loaded?.status).toBe('finalized');
    expect(loaded?.finalizedAt).toBe(T2);
    expect(loaded?.revision).toBe(doc.revision); // finalization freezes, it does not bump

    const snapshot = await env.finalized.byDocumentId('doc-1');
    expect(snapshot).toBeDefined();
    expect(canonicalJson(snapshot)).toBe(canonicalJson(bundle));
  });

  it('rejects finalizing a document that does not calculate (nothing persisted)', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-bad', title: 'متره', createdAt: T0 },
    );
    const broken = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: [
        {
          sheetId: 'S1',
          name: 'x',
          lines: [
            {
              lineId: 'L1',
              rowNo: 1,
              description: 'ارجاع ناموجود',
              kind: 'addition',
              unit: 'm',
              quantity: {
                type: 'reference',
                terms: [{ lineId: 'ghost', factor: '1', use: 'signed' }],
              },
            },
          ],
        },
      ],
      rounding: [],
    });
    await env.documents.create(base);
    await env.documents.save(broken, base.revision);
    expect(() => finalizeTakeoffDocument(broken, { finalizedAt: T2 })).toThrow(
      /does not calculate/,
    );
    const loaded = await env.documents.findById('doc-bad');
    expect(loaded?.status).toBe('draft'); // untouched
    expect(await env.finalized.byDocumentId('doc-bad')).toBeUndefined();
  });

  it('rolls back completely when the snapshot insert fails after the status flip', async () => {
    const { env, doc } = await seededDraft();
    // Pre-insert a conflicting finalized row directly, so the repository's snapshot
    // INSERT fails AFTER it has already flipped the document status inside the tx.
    await env.db.execute(
      "insert into finalized_takeoffs (document_id, takeoff_id, document_number, finalized_at, spec_version, engine_version, input, result) values ('doc-1', 'tk-1', 1, '2020-01-01T00:00:00Z', 'x', 'x', '{}', '{}')",
    );
    const bundle = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
    await expect(env.finalized.save(bundle, doc.revision)).rejects.toThrow();
    const loaded = await env.documents.findById('doc-1');
    expect(loaded?.status).toBe('draft'); // the flip rolled back
    expect(loaded?.finalizedAt).toBeUndefined();
  });
});

describe('M/N · snapshot immutability and round-trip', () => {
  it('never rewrites a finalized document or snapshot', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره', createdAt: T0 },
    );
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);
    const bundle = finalizeTakeoffDocument(v2, { finalizedAt: T2 });
    await env.finalized.save(bundle, v2.revision);

    // different snapshot content for the same document → immutable error
    const different: FinalizedTakeoff = { ...bundle, finalizedAt: T1 };
    await expect(env.finalized.save(different, v2.revision)).rejects.toMatchObject({
      code: 'TAKEOFF_DOCUMENT_IMMUTABLE',
    });
    // idempotent identical re-save is a no-op
    await expect(env.finalized.save(bundle, v2.revision)).resolves.toBeUndefined();
  });

  it('replays: the snapshot input reproduces the stored result byte-for-byte', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره', createdAt: T0 },
    );
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);
    await env.finalized.save(finalizeTakeoffDocument(v2, { finalizedAt: T2 }), v2.revision);

    const snapshot = await env.finalized.byDocumentId('doc-1');
    if (snapshot === undefined) throw new Error('doc-1 snapshot must be persisted');
    const replay = calculateTakeoff(snapshot.input);
    expect(replay.status).toBe('ok');
    expect(canonicalJson(replay)).toBe(canonicalJson(snapshot.result));
  });
});

describe('O/P/Q/R/S/T/U/V · content round-trip fidelity', () => {
  it('preserves expressions, references, count factors, rounding rules, ordering and provenance exactly', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره', createdAt: T0 },
    );
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);
    const loaded = await env.documents.findById('doc-1');
    expect(canonicalJson(loaded)).toBe(canonicalJson(v2));

    // O expression tree (round/sub/const) verbatim
    const l4 = loaded?.sheets[1]?.lines[1];
    expect(l4?.quantity.type).toBe('expression');
    expect(canonicalJson(l4?.quantity)).toBe(canonicalJson(SHEETS[1]?.lines[1]?.quantity));
    // P references (cross-sheet, forward) verbatim
    const l3 = loaded?.sheets[1]?.lines[0];
    expect(l3?.quantity.type).toBe('reference');
    expect(canonicalJson(l3?.quantity)).toBe(canonicalJson(SHEETS[1]?.lines[0]?.quantity));
    // Q floorCount/similarCount: present factors preserved, absent factors stay absent
    const l1 = loaded?.sheets[0]?.lines[0];
    expect(l1?.quantity).toMatchObject({ floorCount: '2', similarCount: '4' });
    const l2 = loaded?.sheets[0]?.lines[1];
    expect(l2?.quantity).toEqual({
      type: 'manual',
      value: '0.5',
      justification: 'برآورد چشمی بازشوها',
    });
    // R rounding rules (selectors, modes, sourceStatus, verified source) verbatim
    expect(canonicalJson(loaded?.rounding)).toBe(canonicalJson(ROUNDING));
    // S sheet ordering, T line ordering
    expect(loaded?.sheets.map((s) => s.sheetId)).toEqual(['S1', 'S2']);
    expect(loaded?.sheets[0]?.lines.map((l) => l.rowNo)).toEqual([1, 2]);
    // U provenance fields
    expect(l1?.origin).toBe('user');
    expect(l1?.ruleRefs).toEqual(['IR-1404-M-CONC-01']);
    expect(l1?.location).toBe('محور A');
    expect(l1?.itemCode).toBe('SYN-1001');
    // V exact and rounded outputs survive in the finalized snapshot
    const bundle = finalizeTakeoffDocument(v2, { finalizedAt: T2 });
    await env.finalized.save(bundle, v2.revision);
    const snapshot = await env.finalized.byDocumentId('doc-1');
    if (snapshot === undefined) throw new Error('doc-1 snapshot must be persisted');
    const lines = snapshot.result.lines;
    const lineL1 = lines.find((l) => l.lineId === 'L1');
    expect(lineL1?.exactMagnitude).toBe('48.24'); // 2×4×1.005×2×3
    expect(lineL1?.roundedMagnitude).toBe('48'); // line rule scale 0
    const item = snapshot.result.itemTotals.find((t) => t.itemCode === 'SYN-1002');
    expect(item?.roundedQty).toBeDefined(); // item-total rule scale 2
    expect(item?.qty).toBe(item?.roundedQty);
  });

  it('keeps deterministic ordering after renumbering rows and reordering sheets', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره', createdAt: T0 },
    );
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);
    // reverse sheet order and renumber rows
    const reversed = [...SHEETS].reverse().map((sheet, i) => ({
      ...sheet,
      lines: [...sheet.lines].reverse().map((line, j) => ({ ...line, rowNo: (i + 1) * 10 + j })),
    }));
    const v3 = saveTakeoffDocumentDraft(v2, {
      title: 'متره',
      sheets: reversed,
      rounding: ROUNDING,
    });
    await env.documents.save(v3, v2.revision);
    const loaded = await env.documents.findById('doc-1');
    if (loaded === undefined) throw new Error('doc-1 must be persisted');
    expect(loaded.sheets.map((s) => s.sheetId)).toEqual(['S2', 'S1']);
    expect(loaded.sheets[0]?.lines.map((l) => l.lineId)).toEqual(['L4', 'L3']);
    expect(loaded.sheets[1]?.lines.map((l) => l.lineId)).toEqual(['L2', 'L1']);
    // values are unchanged by renumbering/reordering (engine determinism §7.5)
    const a = calculateTakeoff(takeoffCalculationInputOf(v2));
    const b = calculateTakeoff(takeoffCalculationInputOf(loaded));
    const value = (r: typeof a) =>
      canonicalJson(Object.fromEntries(r.lines.map((l) => [l.lineId, l.signedValue])));
    expect(value(b)).toBe(value(a));
  });
});

describe('follow-up revisions', () => {
  it('creates a verbatim copy as the next chain member with stable lineIds', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const base = createTakeoffDocument(
      createProject({
        projectId: '11111111-1111-4111-8111-111111111111',
        title: 'پ',
        metadata: {},
        createdAt: T0,
      }),
      { takeoffId: 'tk-1', documentId: 'doc-1', title: 'متره', createdAt: T0 },
    );
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);
    await env.finalized.save(finalizeTakeoffDocument(v2, { finalizedAt: T2 }), v2.revision);

    const finalizedDoc = await env.documents.findById('doc-1');
    if (finalizedDoc === undefined) throw new Error('doc-1 must be finalized before follow-up');
    const followUp = createFollowUpTakeoffDocument(finalizedDoc, {
      documentId: 'doc-2',
      createdAt: T1,
    });
    await env.documents.create(followUp);
    const loaded = await env.documents.findById('doc-2');
    expect(loaded?.documentNumber).toBe(2);
    expect(loaded?.status).toBe('draft');
    expect(loaded?.revision).toBe(1);
    expect(canonicalJson(loaded?.sheets)).toBe(canonicalJson(SHEETS));
    expect(canonicalJson(loaded?.rounding)).toBe(canonicalJson(ROUNDING));
    const chain = await env.documents.findByTakeoffId('tk-1');
    expect(chain.map((d) => [d.documentId, d.documentNumber, d.status])).toEqual([
      ['doc-1', 1, 'finalized'],
      ['doc-2', 2, 'draft'],
    ]);
  });

  it('rejects a chain-number gap or reuse', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const project = createProject({
      projectId: '11111111-1111-4111-8111-111111111111',
      title: 'پ',
      metadata: {},
      createdAt: T0,
    });
    const doc1 = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    await env.documents.create(doc1);
    const doc3 = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-3',
      title: 'متره',
      createdAt: T0,
    });
    const forced: TakeoffDocument = { ...doc3, documentNumber: 3 };
    await expect(env.documents.create(forced)).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
    const doc1Again = createTakeoffDocument(project, {
      takeoffId: 'tk-2',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    await expect(env.documents.create(doc1Again)).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
  });
});

describe('W/X/Y · integrity', () => {
  const project = createProject({
    projectId: '11111111-1111-4111-8111-111111111111',
    title: 'پ',
    metadata: {},
    createdAt: T0,
  });

  it('rejects an unpersisted project (FK integrity)', async () => {
    const env = await freshDb();
    const doc = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    await expect(env.documents.create(doc)).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
  });

  it('isolates projects and lists deterministically', async () => {
    const env = await freshDb();
    await seedProject(env, project.projectId);
    await env.projects.save(
      createProject({
        projectId: '22222222-2222-4222-8222-222222222222',
        title: 'دوم',
        metadata: {},
        createdAt: T0,
      }),
    );
    await env.documents.create(
      createTakeoffDocument(project, {
        takeoffId: 'tk-1',
        documentId: 'doc-1',
        title: 'متره',
        createdAt: T0,
      }),
    );
    await env.documents.create(
      createTakeoffDocument(
        createProject({
          projectId: '22222222-2222-4222-8222-222222222222',
          title: 'دوم',
          metadata: {},
          createdAt: T0,
        }),
        { takeoffId: 'tk-2', documentId: 'doc-2', title: 'متره', createdAt: T0 },
      ),
    );
    const ofProject1 = await env.documents.findByProjectId(project.projectId);
    expect(ofProject1.map((d) => d.documentId)).toEqual(['doc-1']);
    const ofProject2 = await env.documents.findByProjectId('22222222-2222-4222-8222-222222222222');
    expect(ofProject2.map((d) => d.documentId)).toEqual(['doc-2']);
  });

  it('rejects duplicate identities inside a presented document', async () => {
    const env = await freshDb();
    await seedProject(env, project.projectId);
    const base = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    const dupLine = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: [
        {
          sheetId: 'S1',
          name: 'x',
          lines: [
            {
              lineId: 'L1',
              rowNo: 1,
              description: 'a',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'dimensional', profile: 'L', length: '1' },
            },
            {
              lineId: 'L1',
              rowNo: 2,
              description: 'b',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'dimensional', profile: 'L', length: '2' },
            },
          ],
        },
      ],
      rounding: [],
    });
    await expect(env.documents.create(dupLine)).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
    const dupRow = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: [
        {
          sheetId: 'S1',
          name: 'x',
          lines: [
            {
              lineId: 'L1',
              rowNo: 1,
              description: 'a',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'dimensional', profile: 'L', length: '1' },
            },
            {
              lineId: 'L2',
              rowNo: 1,
              description: 'b',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'dimensional', profile: 'L', length: '2' },
            },
          ],
        },
      ],
      rounding: [],
    });
    await expect(env.documents.create(dupRow)).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
    const dupSheet = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: [
        { sheetId: 'S1', name: 'x', lines: [] },
        { sheetId: 'S1', name: 'y', lines: [] },
      ],
      rounding: [],
    });
    await expect(env.documents.create(dupSheet)).rejects.toMatchObject({
      code: 'PERSISTENCE_CONFLICT',
    });
  });

  it('prevents orphaned sheets and lines (FKs; cascade on draft replace)', async () => {
    const env = await freshDb();
    await seedProject(env, project.projectId);
    // direct orphan insert is rejected by the FK
    await expect(
      env.db.execute(
        "insert into takeoff_sheets (document_id, sheet_id, name, sheet_order) values ('nope', 'S1', 'x', 1)",
      ),
    ).rejects.toThrow();
    await expect(
      env.db.execute(
        "insert into takeoff_lines (document_id, line_id, sheet_id, row_no, description, kind, unit, quantity) values ('nope', 'L1', 'S1', 1, 'x', 'addition', 'm', '{}')",
      ),
    ).rejects.toThrow();
    // cascade: replacing draft content leaves no stragglers (verified by row counts in C/D)
    const base = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);
    const v3 = saveTakeoffDocumentDraft(v2, {
      title: 'متره',
      sheets: [at(SHEETS, 0)],
      rounding: [],
    });
    await env.documents.save(v3, v2.revision);
    const lineRows = await env.db
      .select()
      .from(takeoffLines)
      .where(eq(takeoffLines.documentId, 'doc-1'));
    expect(lineRows.map((r) => r.lineId).sort()).toEqual(['L1', 'L2']);
  });
});

describe('DbError shape', () => {
  it('exposes the stable takeoff codes', async () => {
    const env = await freshDb();
    await seedProject(env, '11111111-1111-4111-8111-111111111111');
    const project = createProject({
      projectId: '11111111-1111-4111-8111-111111111111',
      title: 'پ',
      metadata: {},
      createdAt: T0,
    });
    const base = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await env.documents.create(base);
    await env.documents.save(v2, base.revision);
    const error = await env.documents.save(v2, 99).catch((e: unknown) => e as DbError);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('PERSISTENCE_CONFLICT');
  });
});
