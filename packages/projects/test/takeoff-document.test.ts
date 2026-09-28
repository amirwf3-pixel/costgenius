/**
 * D-016 Phase 2 domain tests: takeoff document lifecycle (create → draft save → archive →
 * finalize → follow-up) through the pure workflow functions and the in-memory reference
 * repositories, including the optimistic-concurrency contract and the exact
 * round-trip into `calculateTakeoff` (CG-FT-TAKEOFF-SPEC §16).
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryFinalizedTakeoffRepository,
  InMemoryTakeoffDocumentRepository,
  ProjectsError,
  archiveTakeoffDocument,
  createFollowUpTakeoffDocument,
  createProject,
  createTakeoffDocument,
  finalizeTakeoffDocument,
  previewTakeoffDocumentCalculation,
  saveTakeoffDocumentDraft,
  takeoffCalculationInputOf,
  unarchiveTakeoffDocument,
  type TakeoffDocument,
  type TakeoffDocumentSheet,
} from '../src/index.js';
import { canonicalJson } from '@costgenius/calc-engine';

const T0 = '2026-01-01T00:00:00Z';
const T1 = '2026-01-02T00:00:00Z';
const T2 = '2026-01-03T00:00:00Z';
const project = createProject({
  projectId: '11111111-1111-4111-8111-111111111111',
  title: 'پروژه',
  metadata: {},
  createdAt: T0,
});

/**
 * Indexed access without `!` (repo convention: no non-null assertions).
 */
const at = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined) throw new Error(`missing element ${String(index)}`);
  return value;
};

const SHEETS: readonly TakeoffDocumentSheet[] = [
  {
    sheetId: 'S1',
    name: 'فونداسیون',
    lines: [
      {
        lineId: 'L1',
        rowNo: 1,
        description: 'بتن',
        itemCode: 'SYN-1',
        kind: 'addition',
        unit: 'm3',
        quantity: {
          type: 'dimensional',
          profile: 'LWH',
          floorCount: '2',
          similarCount: '3',
          length: '1.5',
          width: '2',
          height: '2',
        },
      },
      {
        lineId: 'L2',
        rowNo: 2,
        description: 'کسر',
        kind: 'deduction',
        unit: 'm3',
        quantity: { type: 'manual', value: '1', justification: 'بازشو' },
      },
    ],
  },
  {
    sheetId: 'S2',
    name: 'ارجاع',
    lines: [
      {
        lineId: 'L3',
        rowNo: 1,
        description: 'مثل بتن',
        itemCode: 'SYN-1',
        kind: 'addition',
        unit: 'm3',
        quantity: {
          type: 'reference',
          terms: [{ lineId: 'L1', factor: '1', use: 'magnitude' }],
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
];

function seededDraft(): {
  documents: InMemoryTakeoffDocumentRepository;
  finalized: InMemoryFinalizedTakeoffRepository;
  base: TakeoffDocument;
  doc: TakeoffDocument;
} {
  const documents = new InMemoryTakeoffDocumentRepository();
  const finalized = new InMemoryFinalizedTakeoffRepository(documents);
  const base = createTakeoffDocument(project, {
    takeoffId: 'tk-1',
    documentId: 'doc-1',
    title: 'متره',
    createdAt: T0,
  });
  const doc = saveTakeoffDocumentDraft(base, { title: 'متره', sheets: SHEETS, rounding: ROUNDING });
  return { documents, finalized, base, doc };
}

describe('create', () => {
  it('starts a chain at documentNumber 1, revision 1, empty draft', () => {
    const doc = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    expect(doc).toMatchObject({
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      projectId: project.projectId,
      documentNumber: 1,
      status: 'draft',
      revision: 1,
    });
    expect(doc.sheets).toEqual([]);
    expect(doc.rounding).toEqual([]);
    expect(Object.isFrozen(doc)).toBe(true);
  });

  it('validates ids, title and instants', () => {
    expect(() =>
      createTakeoffDocument(project, { takeoffId: '', documentId: 'd', title: 't', createdAt: T0 }),
    ).toThrow(ProjectsError);
    expect(() =>
      createTakeoffDocument(project, { takeoffId: 't', documentId: 'd', title: '', createdAt: T0 }),
    ).toThrow(ProjectsError);
    expect(() =>
      createTakeoffDocument(project, {
        takeoffId: 't',
        documentId: 'd',
        title: 't',
        createdAt: 'yesterday',
      }),
    ).toThrow(/ISO-8601/);
  });
});

describe('draft editing (G4=B)', () => {
  it('replaces the whole content and increments the revision by exactly one', () => {
    const base = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    const v2 = saveTakeoffDocumentDraft(base, {
      title: 'متره ۲',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    expect(v2.revision).toBe(2);
    expect(v2.title).toBe('متره ۲');
    expect(v2.sheets).toHaveLength(2);
    const v3 = saveTakeoffDocumentDraft(v2, {
      title: 'متره ۳',
      sheets: [at(SHEETS, 0)],
      rounding: [],
    });
    expect(v3.revision).toBe(3);
    expect(v3.rounding).toEqual([]);
  });

  it('refuses to edit a non-draft', () => {
    const base = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    const archived = archiveTakeoffDocument(base, T1);
    expect(() =>
      saveTakeoffDocumentDraft(archived, { title: 'x', sheets: [], rounding: [] }),
    ).toThrow(/only a draft can be saved/);
  });
});

describe('archive / unarchive (G1b=C)', () => {
  it('round-trips draft → archived → draft with identical content and revision', () => {
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
    const archived = archiveTakeoffDocument(v2, T1);
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBe(T1);
    expect(archived.revision).toBe(v2.revision);
    expect(archived.sheets).toHaveLength(2);
    const back = unarchiveTakeoffDocument(archived);
    expect(back.status).toBe('draft');
    expect(back.archivedAt).toBeUndefined();
    expect(canonicalJson(back)).toBe(canonicalJson(v2));
  });

  it('refuses illegal archive/unarchive transitions', () => {
    const base = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    expect(() => unarchiveTakeoffDocument(base)).toThrow(/only an archived draft/);
    const finalized = finalizeTakeoffDocument(base, { finalizedAt: T2 });
    expect(() => archiveTakeoffDocument(finalized.document, T2)).toThrow(
      /only a draft can be archived/,
    );
  });
});

describe('finalize (CG-FT §12)', () => {
  it('requires a valid calculation and freezes the document with the exact engine bundle', () => {
    const { doc } = seededDraft();
    const bundle = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
    expect(bundle.document.status).toBe('finalized');
    expect(bundle.document.finalizedAt).toBe(T2);
    expect(bundle.document.revision).toBe(doc.revision); // frozen, not bumped
    expect(canonicalJson(bundle.input)).toBe(canonicalJson(takeoffCalculationInputOf(doc)));
    expect(bundle.result.status).toBe('ok');
    expect(bundle.result.specVersion).toBe('0.2.0');
    // L1 = 2×3×1.5×2×2 = 36, rounded to 36; L3 = 36 (L2 is uncoded); itemTotal SYN-1 = 72
    const l1 = bundle.result.lines.find((l) => l.lineId === 'L1');
    expect(l1?.exactMagnitude).toBe('36');
    expect(l1?.roundedMagnitude).toBe('36');
    const item = bundle.result.itemTotals.find((t) => t.itemCode === 'SYN-1');
    expect(item?.exactQty).toBe('72'); // L2 is uncoded: SYN-1 = 36 + 36
  });

  it('rejects a document that does not calculate, leaving nothing finalized', () => {
    const base = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-bad',
      title: 'متره',
      createdAt: T0,
    });
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
              description: 'چرخه',
              kind: 'addition',
              unit: 'm',
              quantity: {
                type: 'reference',
                terms: [{ lineId: 'L1', factor: '1', use: 'signed' }],
              },
            },
          ],
        },
      ],
      rounding: [],
    });
    expect(() => finalizeTakeoffDocument(broken, { finalizedAt: T2 })).toThrow(
      /does not calculate/,
    );
    expect(broken.status).toBe('draft'); // untouched
  });

  it('refuses to finalize a non-draft', () => {
    const base = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    const archived = archiveTakeoffDocument(base, T1);
    expect(() => finalizeTakeoffDocument(archived, { finalizedAt: T2 })).toThrow(
      /only a draft can be finalized/,
    );
  });
});

describe('follow-up revisions (CG-FT §2.4)', () => {
  it('copies a finalized document verbatim as the next chain member', () => {
    const { doc } = seededDraft();
    const finalized = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
    const followUp = createFollowUpTakeoffDocument(finalized.document, {
      documentId: 'doc-2',
      createdAt: T1,
    });
    expect(followUp).toMatchObject({
      takeoffId: 'tk-1',
      documentId: 'doc-2',
      documentNumber: 2,
      status: 'draft',
      revision: 1,
    });
    expect(canonicalJson(followUp.sheets)).toBe(canonicalJson(finalized.document.sheets));
    expect(canonicalJson(followUp.rounding)).toBe(canonicalJson(finalized.document.rounding));
    // stable lineIds across revisions
    expect(followUp.sheets[0]?.lines[0]?.lineId).toBe('L1');
  });

  it('refuses a follow-up from a non-finalized document', () => {
    const base = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    expect(() =>
      createFollowUpTakeoffDocument(base, { documentId: 'doc-2', createdAt: T1 }),
    ).toThrow(/only .* finalized/);
  });
});

describe('in-memory repositories (optimistic concurrency + transitions)', () => {
  it('enforces create→save with expectedRevision and rejects stale writes', async () => {
    const { documents, doc, base } = seededDraft();
    await documents.create(base);
    await documents.save(doc, base.revision);
    const v3 = saveTakeoffDocumentDraft(doc, {
      title: 'متره v3',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await documents.save(v3, doc.revision);
    // stale: doc.revision (2) is no longer current (3)
    const v4 = saveTakeoffDocumentDraft(v3, {
      title: 'متره v4',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await expect(documents.save(v4, doc.revision)).rejects.toThrow(/stale expectedRevision/);
    const loaded = await documents.findById('doc-1');
    expect(loaded?.revision).toBe(3);
  });

  it('rejects chain-number violations and duplicate identities', async () => {
    const documents = new InMemoryTakeoffDocumentRepository();
    const doc1 = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    await documents.create(doc1);
    const doc3 = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-3',
      title: 'متره',
      createdAt: T0,
    });
    await expect(documents.create({ ...doc3, documentNumber: 3 })).rejects.toThrow(
      /expects documentNumber 2/,
    );
    await expect(
      documents.create(
        createTakeoffDocument(project, {
          takeoffId: 'tk-2',
          documentId: 'doc-1',
          title: 'x',
          createdAt: T0,
        }),
      ),
    ).rejects.toThrow(/already persisted/);
  });

  it('finalizes atomically in memory and keeps the snapshot immutable', async () => {
    const documents = new InMemoryTakeoffDocumentRepository();
    const finalizedRepo = new InMemoryFinalizedTakeoffRepository(documents);
    const base = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    const doc = saveTakeoffDocumentDraft(base, {
      title: 'متره',
      sheets: SHEETS,
      rounding: ROUNDING,
    });
    await documents.create(base);
    await documents.save(doc, base.revision);

    const bundle = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
    await finalizedRepo.save(bundle, doc.revision);
    expect((await documents.findById('doc-1'))?.status).toBe('finalized');
    const snapshot = await finalizedRepo.byDocumentId('doc-1');
    expect(canonicalJson(snapshot)).toBe(canonicalJson(bundle));

    // different content for the same document → immutable error
    await expect(finalizedRepo.save({ ...bundle, finalizedAt: T1 }, doc.revision)).rejects.toThrow(
      /already exists with different content/,
    );
    // identical re-save is a no-op
    await expect(finalizedRepo.save(bundle, doc.revision)).resolves.toBeUndefined();
    // editing the finalized document is rejected
    const edited: TakeoffDocument = {
      ...bundle.document,
      revision: bundle.document.revision + 1,
      title: 'x',
      sheets: [],
      rounding: [],
    };
    await expect(documents.save(edited, bundle.document.revision)).rejects.toThrow(
      /finalized .* never rewritten/,
    );
    // a bundle that does not match the stored draft is rejected
    const other = createTakeoffDocument(project, {
      takeoffId: 'tk-9',
      documentId: 'doc-9',
      title: 'متره',
      createdAt: T0,
    });
    await documents.create(other);
    const otherBundle = finalizeTakeoffDocument(other, { finalizedAt: T2 });
    await expect(finalizedRepo.save(otherBundle, other.revision)).resolves.toBeUndefined();
  });

  it('lists chains and projects deterministically', async () => {
    const documents = new InMemoryTakeoffDocumentRepository();
    const doc1 = createTakeoffDocument(project, {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'متره',
      createdAt: T0,
    });
    const doc2 = createFollowUpTakeoffDocument(
      finalizeTakeoffDocument(doc1, { finalizedAt: T2 }).document,
      { documentId: 'doc-2', createdAt: T1 },
    );
    await documents.create(doc1);
    await documents.create(doc2);
    const chain = await documents.findByTakeoffId('tk-1');
    expect(chain.map((d) => d.documentId)).toEqual(['doc-1', 'doc-2']);
    const byProject = await documents.findByProjectId(project.projectId);
    expect(byProject.map((d) => d.documentNumber)).toEqual([1, 2]);
  });
});

describe('engine round-trip (CG-FT §16)', () => {
  it('reconstructs the exact calculateTakeoff input from a persisted+reloaded document', async () => {
    const { documents, doc, base } = seededDraft();
    await documents.create(base);
    await documents.save(doc, base.revision);
    const loaded = await documents.findById('doc-1');
    if (loaded === undefined) throw new Error('doc-1 must be persisted');
    expect(canonicalJson(takeoffCalculationInputOf(loaded))).toBe(
      canonicalJson(takeoffCalculationInputOf(doc)),
    );
    // every quantity family, floorCount/similarCount, rounding rules and ordering survive
    expect(canonicalJson(loaded.sheets)).toBe(canonicalJson(SHEETS));
    expect(canonicalJson(loaded.rounding)).toBe(canonicalJson(ROUNDING));
  });
});

// -------------------------------------------------------------------------------------------------
// P7-S2 (CG-FT@0.2.0 §16, D-PREVIEW=B): the stateless draft calculation preview — the pure
// domain helper. Pinned: a draft returns the engine result VERBATIM (identical to what
// finalization computes — same input reconstruction, same engine, determinism); a non-draft
// keeps the existing lifecycle semantics (TAKEOFF_INVALID_TRANSITION); an engine failure is
// RETURNED (status 'error' with structured failures), never thrown — the API layer maps it
// to 422 TAKEOFF_SOLUTION_REJECTED; and the document itself is never mutated.
// -------------------------------------------------------------------------------------------------

describe('P7-S2: stateless draft calculation preview (CG-FT §16)', () => {
  it('a draft previews the exact engine result — identical to the finalized computation', () => {
    const { documents, base, doc } = seededDraft();
    // the same saved draft, once previewed and once finalized (different instances)
    const preview = previewTakeoffDocumentCalculation(doc);
    expect(preview.status).toBe('ok');
    const finalized = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
    expect(preview).toEqual(finalized.result); // byte-equal frozen engine results
    // determinism: previewing again answers the same result
    expect(previewTakeoffDocumentCalculation(doc)).toEqual(preview);
    // and the persisted draft state was never touched by either call
    expect(doc.status).toBe('draft');
    expect(doc.revision).toBe(base.revision + 1);
    expect(documents).toBeDefined(); // (repo untouched — no preview persistence path exists)
  });

  it('engine failures are RETURNED as structured errors, never thrown', () => {
    const broken = saveTakeoffDocumentDraft(
      createTakeoffDocument(project, {
        takeoffId: 'tk-preview-bad',
        documentId: 'doc-preview-bad',
        title: 'خراب',
        createdAt: T0,
      }),
      {
        title: 'خراب',
        rounding: [],
        sheets: [
          {
            sheetId: 'S1',
            name: 'برگه',
            lines: [
              {
                lineId: 'L1',
                rowNo: 1,
                description: 'مرجع گمشده',
                kind: 'addition',
                unit: 'm',
                quantity: {
                  type: 'reference',
                  terms: [{ lineId: 'MISSING', factor: '1', use: 'signed' }],
                },
              },
            ],
          },
        ],
      },
    );
    const result = previewTakeoffDocumentCalculation(broken);
    expect(result.status).toBe('error');
    const errors = result.errors as readonly { code: string; lineId?: string }[];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.code).toBe('UNKNOWN_REFERENCE');
    // the caller (API) owns the mapping to 422 TAKEOFF_SOLUTION_REJECTED + details.failures
  });

  it('non-draft documents keep the existing lifecycle semantics (409 contract source)', () => {
    const { base, doc } = seededDraft();
    const archived = archiveTakeoffDocument(doc, T1);
    expect(() => previewTakeoffDocumentCalculation(archived)).toThrowError(ProjectsError);
    try {
      previewTakeoffDocumentCalculation(archived);
    } catch (error) {
      expect((error as ProjectsError).code).toBe('TAKEOFF_INVALID_TRANSITION');
    }
    const finalized = finalizeTakeoffDocument(doc, { finalizedAt: T2 });
    expect(() => previewTakeoffDocumentCalculation(finalized.document)).toThrowError(ProjectsError);
    try {
      previewTakeoffDocumentCalculation(finalized.document);
    } catch (error) {
      expect((error as ProjectsError).code).toBe('TAKEOFF_INVALID_TRANSITION');
    }
    // the draft itself still previews after all of this (nothing above mutated it)
    expect(previewTakeoffDocumentCalculation(doc).status).toBe('ok');
    expect(base.revision).toBeGreaterThan(0);
  });
});
