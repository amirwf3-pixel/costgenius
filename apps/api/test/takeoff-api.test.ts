/**
 * D-016 Phase 3 — the Full Takeoff HTTP resource family (project-scoped, POST-only
 * mutations, optimistic concurrency). Pinned here:
 *
 * - the whole lifecycle over real HTTP against real in-process PostgreSQL (PGlite, actual
 *   migrations, the production Drizzle repositories, a fixed clock): create → save
 *   (full-document replace, revision +1) → archive/unarchive (content byte-identical) →
 *   finalize (engine via the domain, immutable snapshot, 201) → reload (finalized bundle)
 *   → follow-up (verbatim copy, documentNumber +1, stable lineIds);
 * - G4=B concurrency: a stale `expectedRevision` is a 409 PERSISTENCE_CONFLICT and two
 *   concurrent saves with the SAME expectedRevision have exactly one winner — the store,
 *   not the route, is the authority (no last-write-wins anywhere);
 * - the boundary contracts: decimals are STRINGS (a JSON number is a 400), the expression
 *   tree is a closed union (a `div` node is a 400 INVALID_REQUEST — unrepresentable at the
 *   edge, CG-FT §6.2), non-`design` rounding sourceStatus is an authoring-policy 422
 *   TAKEOFF_DOCUMENT_REJECTED (R3=A), V1 authors `origin: "user"` only (§13);
 * - project isolation: a document of project A is indistinguishable from a missing one
 *   through project B (404, no cross-project existence disclosure);
 * - D-015 stays untouched beside the new family (the stateless preview still answers and
 *   still rejects a `rounding` field).
 *
 * Real-server (node-postgres over TCP) HTTP concurrency is covered by the env-gated
 * `takeoff-api.server.test.ts` (COSTGENIUS_SMOKE_DATABASE_URL), never by this file.
 */
import type { InjectPayload } from 'light-my-request';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '@costgenius/db';
import { buildTestServer, FIXED_INSTANT, PROJECT_ID } from './helpers.js';

type App = Awaited<ReturnType<typeof buildTestServer>>;
type Json = Record<string, unknown>;

interface DocumentBody {
  documentId: string;
  takeoffId: string;
  projectId: string;
  title: string;
  documentNumber: number;
  status: 'draft' | 'archived' | 'finalized';
  revision: number;
  rounding: Json[];
  sheets: Json[];
  createdAt: string;
  archivedAt?: string;
  finalizedAt?: string;
}

interface FinalizedBody {
  document: DocumentBody;
  documentId: string;
  takeoffId: string;
  documentNumber: number;
  finalizedAt: string;
  input: { sheets: Json[]; rounding: Json[] };
  result: {
    status: string;
    specVersion: string;
    lines: {
      lineId: string;
      exactMagnitude: string;
      roundedMagnitude?: string;
      signedValue: string;
    }[];
    itemTotals: {
      itemCode: string | null;
      unit: string;
      exactQty: string;
      roundedQty?: string;
      qty: string;
    }[];
  };
}

interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

const PROJECT_B_ID = 'bbbbbbbb-cccc-4ddd-9eee-ffffffffffff';

/** The complete takeoff content: every quantity family, references, exact decimals. */
const SHEETS = [
  {
    sheetId: 'S2',
    name: 'اسکلت',
    lines: [
      {
        lineId: 'L5',
        rowNo: 2,
        description: 'دقت اعشار',
        itemCode: 'SYN-1002',
        kind: 'addition',
        unit: 'm3',
        quantity: {
          type: 'dimensional',
          profile: 'LWH',
          length: '2',
          width: '4',
          height: '1.005',
          floorCount: '2',
          similarCount: '3',
        },
      },
      {
        lineId: 'L4',
        rowNo: 1,
        description: 'کسر حجم',
        itemCode: 'SYN-1002',
        kind: 'deduction',
        unit: 'm3',
        quantity: {
          type: 'expression',
          node: {
            op: 'sub',
            args: [
              { op: 'const', value: '50' },
              { op: 'ref', lineId: 'L3', use: 'magnitude' },
            ],
          },
        },
      },
      {
        lineId: 'L6',
        rowNo: 3,
        description: 'شمارش',
        itemCode: 'SYN-3',
        kind: 'addition',
        unit: 'each',
        quantity: { type: 'dimensional', profile: 'count', floorCount: '4' },
      },
    ],
  },
  {
    sheetId: 'S1',
    name: 'فونداسیون',
    lines: [
      {
        lineId: 'L3',
        rowNo: 3,
        description: 'مرجع به کانال',
        itemCode: 'SYN-1',
        kind: 'addition',
        unit: 'm3',
        quantity: {
          type: 'reference',
          terms: [{ lineId: 'L1', factor: '1', use: 'signed' }],
        },
      },
      {
        lineId: 'L1',
        rowNo: 1,
        description: 'کانال فوتی',
        itemCode: 'SYN-1',
        kind: 'addition',
        unit: 'm3',
        origin: 'user',
        quantity: {
          type: 'dimensional',
          profile: 'LWH',
          length: '2',
          width: '3',
          height: '1.5',
          floorCount: '2',
          similarCount: '2',
        },
      },
      {
        lineId: 'L2',
        rowNo: 2,
        description: 'سطح بدون کد',
        kind: 'addition',
        unit: 'm2',
        quantity: { type: 'manual', value: '7', justification: 'برآورد دستی از نقشه ۳' },
      },
    ],
  },
] as const;

/** Explicit document rule set (R1=A: exact always computed; rounded derived, once). */
const ROUNDING = [
  {
    target: 'line',
    selector: { lineIds: ['L5'] },
    scale: 0,
    mode: 'HALF_UP',
    sourceStatus: 'design',
  },
  {
    target: 'item-total',
    selector: { itemCode: 'SYN-1002' },
    scale: 1,
    mode: 'HALF_UP',
    sourceStatus: 'design',
  },
] as const;

/** The exact engine math of the fixture (verified line by line at finalization). */
const L1_EXACT = '36'; // 2×3×1.5×2×2
const L5_EXACT = '48.24'; // 2×4×1.005×2×3 — the .005 proves exact decimal transport
const SYN1_TOTAL = '72'; // L1 + L3 (both exact 36)
const SYN1002_EXACT = '34.24'; // L5 48.24 + L4 (−14: 50 − |L3|)
const SYN1002_ROUNDED = '34.2'; // item-total rule scale 1 HALF_UP — one rounding, at the target

let app: App;

function post(url: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return app
    .inject({ method: 'POST', url, payload: payload as InjectPayload })
    .then((r) => ({ status: r.statusCode, body: r.json<unknown>() }));
}

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json<unknown>() };
}

async function createProject(projectId: string): Promise<void> {
  const response = await post('/projects', { projectId, title: 'پروژه متره' });
  expect(response.status).toBe(201);
}

/** Creates a fresh chain and saves `sheets`/`rounding` as its first content revision. */
async function seedDraft(
  documentId: string,
  takeoffId: string,
  sheets: readonly unknown[] = SHEETS,
  rounding: readonly unknown[] = ROUNDING,
): Promise<DocumentBody> {
  const created = await post(`/projects/${PROJECT_ID}/takeoffs`, {
    takeoffId,
    documentId,
    title: 'ریز متره',
  });
  expect(created.status).toBe(201);
  const saved = await post(`/projects/${PROJECT_ID}/takeoffs/${documentId}/save`, {
    expectedRevision: 1,
    title: 'ریز متره',
    sheets,
    rounding,
  });
  expect(saved.status).toBe(200);
  return saved.body as DocumentBody;
}

function saveBody(
  expectedRevision: number,
  sheets: readonly unknown[] = SHEETS,
  rounding: readonly unknown[] = ROUNDING,
): Json {
  return { expectedRevision, title: 'ریز متره', sheets, rounding };
}

const collectionUrl = (projectId = PROJECT_ID): string => `/projects/${projectId}/takeoffs`;
const docUrl = (projectId = PROJECT_ID, documentId = 'doc-1'): string =>
  `/projects/${projectId}/takeoffs/${documentId}`;

beforeAll(async () => {
  app = await buildTestServer();
  await createProject(PROJECT_ID);
  await createProject(PROJECT_B_ID);
});

describe('takeoff lifecycle over HTTP (the chained production story)', () => {
  it('create draft starts a new chain (documentNumber 1, revision 1, empty content)', async () => {
    // A — create through the domain/persistence layer
    const created = await post(collectionUrl(), {
      takeoffId: 'tk-1',
      documentId: 'doc-1',
      title: 'ریز متره',
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      documentId: 'doc-1',
      takeoffId: 'tk-1',
      projectId: PROJECT_ID,
      title: 'ریز متره',
      documentNumber: 1,
      status: 'draft',
      revision: 1,
      rounding: [],
      sheets: [],
      createdAt: FIXED_INSTANT, // the injected clock, never a server-side Date
    });

    // B — the canonical persisted representation
    const loaded = await get(docUrl());
    expect(loaded.status).toBe(200);
    expect(loaded.body).toEqual(created.body);
  });

  it('create rejects an unknown project, duplicate identity and malformed bodies', async () => {
    // T — unknown project (existing create convention: 404 before any write)
    const unknownProject = await post(collectionUrl('cccccccc-dddd-4eee-9fff-000000000000'), {
      takeoffId: 'tk-x',
      documentId: 'doc-x',
      title: 'غایب',
    });
    expect(unknownProject.status).toBe(404);
    expect((unknownProject.body as ApiError).error.code).toBe('NOT_FOUND');

    // duplicate documentId — the store is the identity authority (409, never an overwrite)
    const duplicate = await post(collectionUrl(), {
      takeoffId: 'tk-2',
      documentId: 'doc-1',
      title: 'تکراری',
    });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as ApiError).error.code).toBe('PERSISTENCE_CONFLICT');

    // a second chain member under the same takeoffId must continue the chain (docNo 2)
    const sameChain = await post(collectionUrl(), {
      takeoffId: 'tk-1',
      documentId: 'doc-other',
      title: 'ادامه زنجیره',
    });
    expect(sameChain.status).toBe(409);
    expect((sameChain.body as ApiError).error.code).toBe('PERSISTENCE_CONFLICT');

    // A5 — malformed payloads are a 400 at the edge (missing title, unexpected field)
    const missing = await post(collectionUrl(), { takeoffId: 'tk-3', documentId: 'doc-3' });
    expect(missing.status).toBe(400);
    expect((missing.body as ApiError).error.code).toBe('INVALID_REQUEST');
    const unexpected = await post(collectionUrl(), {
      takeoffId: 'tk-3',
      documentId: 'doc-3',
      title: 'x',
      status: 'finalized', // lifecycle fields are never client-supplied
    });
    expect(unexpected.status).toBe(400);
    expect((unexpected.body as ApiError).error.code).toBe('INVALID_REQUEST');
  });

  it('save replaces the complete document content and bumps the revision (D/C)', async () => {
    const saved = await post(`${docUrl()}/save`, saveBody(1));
    expect(saved.status).toBe(200);
    const document = saved.body as DocumentBody;
    expect(document.revision).toBe(2);
    expect(document.status).toBe('draft');
    expect(document.sheets).toHaveLength(2);
    expect(document.rounding).toHaveLength(2);
  });

  it('GET preserves sheet order (array position) and line order (rowNo) exactly (W/X)', async () => {
    const loaded = await get(docUrl());
    expect(loaded.status).toBe(200);
    const document = loaded.body as DocumentBody;
    // sheets stay in SUBMITTED order (S2 was sent first — sheetOrder is presentation)
    expect(document.sheets.map((sheet) => sheet['sheetId'])).toEqual(['S2', 'S1']);
    // lines come back in rowNo order per sheet, regardless of submission order
    const s1 = document.sheets.find((sheet) => sheet['sheetId'] === 'S1');
    const s2 = document.sheets.find((sheet) => sheet['sheetId'] === 'S2');
    expect((s1?.['lines'] as Json[]).map((line) => line['lineId'])).toEqual(['L1', 'L2', 'L3']);
    expect((s2?.['lines'] as Json[]).map((line) => line['lineId'])).toEqual(['L4', 'L5', 'L6']);
  });

  it('every quantity family round-trips byte-identically (Y/Z/AA/V)', async () => {
    const loaded = (await get(docUrl())).body as DocumentBody;
    const line = (id: string): Json => {
      for (const sheet of loaded.sheets) {
        const found = (sheet['lines'] as Json[]).find((l) => l['lineId'] === id);
        if (found !== undefined) return found;
      }
      throw new Error(`line ${id} missing`);
    };
    // V — exact decimal STRINGS never pass through a number: 1.005 stays 1.005
    expect(canonicalJson(line('L5')['quantity'])).toBe(
      canonicalJson({
        type: 'dimensional',
        profile: 'LWH',
        length: '2',
        width: '4',
        height: '1.005',
        floorCount: '2',
        similarCount: '3',
      }),
    );
    // AA — present factors stay present, absent factors stay ABSENT (never a written "1")
    expect(canonicalJson(line('L6')['quantity'])).toBe(
      canonicalJson({ type: 'dimensional', profile: 'count', floorCount: '4' }),
    );
    // Z — reference terms verbatim
    expect(canonicalJson(line('L3')['quantity'])).toBe(
      canonicalJson({
        type: 'reference',
        terms: [{ lineId: 'L1', factor: '1', use: 'signed' }],
      }),
    );
    // Y — the closed expression tree verbatim
    expect(canonicalJson(line('L4')['quantity'])).toBe(
      canonicalJson({
        type: 'expression',
        node: {
          op: 'sub',
          args: [
            { op: 'const', value: '50' },
            { op: 'ref', lineId: 'L3', use: 'magnitude' },
          ],
        },
      }),
    );
    // manual justification + the authored `origin` survive; absent optionals stay absent
    expect(canonicalJson(line('L2')['quantity'])).toBe(
      canonicalJson({ type: 'manual', value: '7', justification: 'برآورد دستی از نقشه ۳' }),
    );
    expect(line('L1')['origin']).toBe('user');
    expect(line('L2')['origin']).toBeUndefined();
    expect(line('L1')['itemCode']).toBe('SYN-1');
    expect(line('L2')['itemCode']).toBeUndefined();
  });

  it('a stale expectedRevision is a 409 PERSISTENCE_CONFLICT and changes nothing (E)', async () => {
    const stale = await post(`${docUrl()}/save`, saveBody(1)); // revision moved to 2
    expect(stale.status).toBe(409);
    expect((stale.body as ApiError).error.code).toBe('PERSISTENCE_CONFLICT');
    const loaded = (await get(docUrl())).body as DocumentBody;
    expect(loaded.revision).toBe(2); // no silent overwrite, no partial mutation
    expect(loaded.sheets).toHaveLength(2);
  });

  it('archive is a soft, content-identical flip (F)', async () => {
    const archived = await post(`${docUrl()}/archive`, { expectedRevision: 2 });
    expect(archived.status).toBe(200);
    const document = archived.body as DocumentBody;
    expect(document.status).toBe('archived');
    expect(document.archivedAt).toBe(FIXED_INSTANT);
    expect(document.revision).toBe(2); // archiving is not a content save
    const loaded = (await get(docUrl())).body as DocumentBody;
    expect(loaded.status).toBe('archived');
    expect(canonicalJson(loaded.sheets)).toBe(canonicalJson(document.sheets)); // G1b=C: nothing deleted
  });

  it('an archived draft is immutable until unarchived (U)', async () => {
    const save = await post(`${docUrl()}/save`, saveBody(2));
    expect(save.status).toBe(409);
    expect((save.body as ApiError).error.code).toBe('TAKEOFF_INVALID_TRANSITION');
    const finalize = await post(`${docUrl()}/finalize`, { expectedRevision: 2 });
    expect(finalize.status).toBe(409);
    expect((finalize.body as ApiError).error.code).toBe('TAKEOFF_INVALID_TRANSITION');
    const archiveAgain = await post(`${docUrl()}/archive`, { expectedRevision: 2 });
    expect(archiveAgain.status).toBe(409);
  });

  it('unarchive restores the draft with content and revision untouched (G)', async () => {
    const restored = await post(`${docUrl()}/unarchive`, { expectedRevision: 2 });
    expect(restored.status).toBe(200);
    const document = restored.body as DocumentBody;
    expect(document.status).toBe('draft');
    expect(document.revision).toBe(2);
    expect(document['archivedAt']).toBeUndefined();
    expect(document.sheets).toHaveLength(2);
    // G2 — unarchiving a draft is an invalid transition
    const again = await post(`${docUrl()}/unarchive`, { expectedRevision: 2 });
    expect(again.status).toBe(409);
    expect((again.body as ApiError).error.code).toBe('TAKEOFF_INVALID_TRANSITION');
  });

  it('finalize calculates through the domain and persists the immutable snapshot (H/AB)', async () => {
    const finalized = await post(`${docUrl()}/finalize`, { expectedRevision: 2 });
    expect(finalized.status).toBe(201);
    const bundle = finalized.body as FinalizedBody;
    expect(bundle.document.status).toBe('finalized');
    expect(bundle.document.revision).toBe(2); // finalization freezes; it does not bump
    expect(bundle.finalizedAt).toBe(FIXED_INSTANT);
    expect(bundle.document.finalizedAt).toBe(FIXED_INSTANT);
    // the snapshot input is exactly the saved engine input
    expect(bundle.input.rounding).toEqual([...ROUNDING]);
    expect(bundle.input.sheets).toHaveLength(2);
    // the verbatim engine result
    expect(bundle.result.status).toBe('ok');
    expect(bundle.result.specVersion).toBe('0.2.0');
    const line = (id: string): { exactMagnitude: string; roundedMagnitude?: string } => {
      const found = bundle.result.lines.find((l) => l.lineId === id);
      if (found === undefined) throw new Error(`line ${id} missing from the result`);
      return found;
    };
    expect(line('L1').exactMagnitude).toBe(L1_EXACT);
    expect(line('L1').roundedMagnitude).toBeUndefined(); // no line rule matched L1
    expect(line('L5').exactMagnitude).toBe(L5_EXACT); // exact always computed and retained
    expect(line('L5').roundedMagnitude).toBe('48'); // the line rule rounds ONCE, scale 0
    const item = (code: string): { exactQty: string; roundedQty?: string; qty: string } => {
      const found = bundle.result.itemTotals.find((t) => t.itemCode === code);
      if (found === undefined) throw new Error(`itemTotal ${code} missing`);
      return found;
    };
    expect(item('SYN-1').exactQty).toBe(SYN1_TOTAL);
    expect(item('SYN-1').roundedQty).toBeUndefined(); // no rule matched → qty is the exact value
    expect(item('SYN-1').qty).toBe(SYN1_TOTAL);
    expect(item('SYN-1002').exactQty).toBe(SYN1002_EXACT); // 48.24 − 14, from EXACT values
    expect(item('SYN-1002').roundedQty).toBe(SYN1002_ROUNDED); // one rounding at the target
    expect(item('SYN-1002').qty).toBe(SYN1002_ROUNDED); // qty = rounded iff a rule matched
  });

  it('GET of a finalized document answers the immutable snapshot bundle (J)', async () => {
    const loaded = await get(docUrl());
    expect(loaded.status).toBe(200);
    const bundle = loaded.body as FinalizedBody;
    expect(bundle.document.status).toBe('finalized');
    expect(bundle.finalizedAt).toBe(FIXED_INSTANT);
    const finalized = await post(`${docUrl()}/finalize`, { expectedRevision: 2 });
    // a sequential re-finalize is an invalid transition (the domain guard fires first)
    expect(finalized.status).toBe(409);
    expect((finalized.body as ApiError).error.code).toBe('TAKEOFF_INVALID_TRANSITION');
    // byte-identical to the finalize response (no recalculation, no mutable draft rows)
    const reloaded = (await get(docUrl())).body;
    expect(canonicalJson(reloaded)).toBe(canonicalJson(bundle));
  });

  it('a finalized document rejects every mutation (K)', async () => {
    const save = await post(`${docUrl()}/save`, saveBody(2));
    expect(save.status).toBe(409);
    expect((save.body as ApiError).error.code).toBe('TAKEOFF_INVALID_TRANSITION');
    const archive = await post(`${docUrl()}/archive`, { expectedRevision: 2 });
    expect(archive.status).toBe(409);
    const unarchive = await post(`${docUrl()}/unarchive`, { expectedRevision: 2 });
    expect(unarchive.status).toBe(409);
  });

  it('follow-up copies a finalized document verbatim into the next chain member (L)', async () => {
    const followUp = await post(`${docUrl()}/follow-up`, { documentId: 'doc-2' });
    expect(followUp.status).toBe(201);
    const document = followUp.body as DocumentBody;
    expect(document.documentId).toBe('doc-2');
    expect(document.takeoffId).toBe('tk-1'); // same chain
    expect(document.projectId).toBe(PROJECT_ID);
    expect(document.documentNumber).toBe(2);
    expect(document.status).toBe('draft');
    expect(document.revision).toBe(1); // the copy's own counter restarts
    expect(document.createdAt).toBe(FIXED_INSTANT);
    // verbatim copy: stable sheetIds/lineIds/rowNos, same rounding rules
    const source = ((await get(docUrl())).body as FinalizedBody).document;
    expect(canonicalJson(document.sheets)).toBe(canonicalJson(source.sheets));
    expect(canonicalJson(document.rounding)).toBe(canonicalJson(source.rounding));
    const lineIds = (sheets: readonly Json[]): string[] =>
      sheets.flatMap((sheet) => (sheet['lines'] as Json[]).map((line) => line['lineId'] as string));
    expect(lineIds(document.sheets)).toEqual(lineIds(source.sheets)); // cross-revision traceability

    // a follow-up cannot come from a draft — doc-2 is a draft now
    const fromDraft = await post(`${docUrl(PROJECT_ID, 'doc-2')}/follow-up`, {
      documentId: 'doc-3',
    });
    expect(fromDraft.status).toBe(409);
    expect((fromDraft.body as ApiError).error.code).toBe('TAKEOFF_INVALID_TRANSITION');
    // and the new documentId must be fresh
    const duplicate = await post(`${docUrl()}/follow-up`, { documentId: 'doc-2' });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as ApiError).error.code).toBe('PERSISTENCE_CONFLICT');
  });

  it('two concurrent saves with the same expectedRevision have exactly one winner (AD)', async () => {
    await seedDraft('doc-conc', 'tk-conc');
    const [a, b] = await Promise.all([
      post(`${docUrl(PROJECT_ID, 'doc-conc')}/save`, {
        ...saveBody(2),
        title: 'برنده الف',
      }),
      post(`${docUrl(PROJECT_ID, 'doc-conc')}/save`, {
        ...saveBody(2),
        title: 'برنده ب',
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]); // exactly one winner, no last-write-wins
    const loser = a.status === 409 ? a : b;
    expect((loser.body as ApiError).error.code).toBe('PERSISTENCE_CONFLICT');
    const loaded = (await get(docUrl(PROJECT_ID, 'doc-conc'))).body as DocumentBody;
    expect(loaded.revision).toBe(3); // exactly one increment
    expect(loaded.title).toBe('برنده الف'); // the 200 winner's content, deterministically
  });
});

describe('takeoff boundary and error contracts over HTTP', () => {
  it('malformed UUIDs and malformed decimals are rejected at the edge (M/N)', async () => {
    // M — the :projectId path parameter has a UUID shape (clean 400, not a DB error)
    const badProject = await get('/projects/not-a-uuid/takeoffs/doc-1');
    expect(badProject.status).toBe(400);
    expect((badProject.body as ApiError).error.code).toBe('INVALID_REQUEST');

    // N(a) — a decimal sent as a JSON NUMBER is a 400 before any layer sees it
    await seedDraft('doc-n', 'tk-n');
    const asNumber = await post(`${docUrl(PROJECT_ID, 'doc-n')}/save`, {
      ...saveBody(2),
      sheets: [
        {
          sheetId: 'S1',
          name: 'برگه',
          lines: [
            {
              lineId: 'L1',
              rowNo: 1,
              description: 'طول عددی',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'dimensional', profile: 'L', length: 2.5 },
            },
          ],
        },
      ],
    });
    expect(asNumber.status).toBe(400);
    expect((asNumber.body as ApiError).error.code).toBe('INVALID_REQUEST');
  });

  it('a semantically invalid decimal is saved as a draft but never finalizes (N/I/AE)', async () => {
    // N(b) — decimal SYNTAX is engine territory: the draft accepts the string shape…
    const saved = await post(`${docUrl(PROJECT_ID, 'doc-n')}/save`, {
      ...saveBody(2),
      sheets: [
        {
          sheetId: 'S1',
          name: 'برگه',
          lines: [
            {
              lineId: 'L1',
              rowNo: 1,
              description: 'عدد نامعتبر',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'dimensional', profile: 'L', length: 'abc' },
            },
          ],
        },
      ],
    });
    expect(saved.status).toBe(200);
    // …and finalization is where the engine rejects it — with NOTHING finalized
    const finalized = await post(`${docUrl(PROJECT_ID, 'doc-n')}/finalize`, {
      expectedRevision: 3,
    });
    expect(finalized.status).toBe(422);
    const error = (finalized.body as ApiError).error;
    expect(error.code).toBe('TAKEOFF_CALCULATION_FAILED');
    expect(error.message).toContain('INVALID_DECIMAL'); // engine codes ride in the message
    // AE — no partial finalization: the document is untouched and still editable
    const loaded = (await get(docUrl(PROJECT_ID, 'doc-n'))).body as DocumentBody;
    expect(loaded.status).toBe('draft');
    expect(loaded.revision).toBe(3);
    const repair = await post(`${docUrl(PROJECT_ID, 'doc-n')}/save`, saveBody(3));
    expect(repair.status).toBe(200);
  });

  it('a non-calculating draft (unknown reference) finalizes to a stable 422 (I/AE)', async () => {
    const broken = [
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
    ];
    const seeded = await seedDraft('doc-bad', 'tk-bad', broken, []);
    expect(seeded.revision).toBe(2);
    const finalized = await post(`${docUrl(PROJECT_ID, 'doc-bad')}/finalize`, {
      expectedRevision: 2,
    });
    expect(finalized.status).toBe(422);
    const error = (finalized.body as ApiError).error;
    expect(error.code).toBe('TAKEOFF_CALCULATION_FAILED');
    expect(error.message).toContain('UNKNOWN_REFERENCE');
    const loaded = (await get(docUrl(PROJECT_ID, 'doc-bad'))).body as DocumentBody;
    expect(loaded.status).toBe('draft'); // nothing was finalized, no snapshot exists
  });

  it('structurally invalid expressions are unrepresentable at the edge (O)', async () => {
    await seedDraft('doc-o', 'tk-o');
    const division = await post(`${docUrl(PROJECT_ID, 'doc-o')}/save`, {
      ...saveBody(2),
      sheets: [
        {
          sheetId: 'S1',
          name: 'برگه',
          lines: [
            {
              lineId: 'L1',
              rowNo: 1,
              description: 'تقسیم ممنوع',
              kind: 'addition',
              unit: 'm',
              quantity: {
                type: 'expression',
                node: {
                  op: 'div',
                  args: [
                    { op: 'const', value: '1' },
                    { op: 'const', value: '2' },
                  ],
                },
              },
            },
          ],
        },
      ],
    });
    expect(division.status).toBe(400); // closed union: `div` does not exist on the wire
    expect((division.body as ApiError).error.code).toBe('INVALID_REQUEST');
    const malformed = await post(`${docUrl(PROJECT_ID, 'doc-o')}/save`, {
      ...saveBody(2),
      sheets: [
        {
          sheetId: 'S1',
          name: 'برگه',
          lines: [
            {
              lineId: 'L1',
              rowNo: 1,
              description: 'گره ناقص',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'expression', node: { op: 'const' } }, // missing value
            },
          ],
        },
      ],
    });
    expect(malformed.status).toBe(400);
    expect((malformed.body as ApiError).error.code).toBe('INVALID_REQUEST');
  });

  it('rounding rules: closed targets at the edge, design-only authoring, engine semantics (P)', async () => {
    await seedDraft('doc-p', 'tk-p');
    // (a) an unknown target literal is a 400 (closed vocabulary)
    const badTarget = await post(`${docUrl(PROJECT_ID, 'doc-p')}/save`, {
      ...saveBody(2),
      rounding: [{ target: 'document', scale: 0, mode: 'HALF_UP', sourceStatus: 'design' }],
    });
    expect(badTarget.status).toBe(400);
    // (b) R3=A — authoring a non-"design" rule is a policy rejection, not a schema error
    const nonDesign = await post(`${docUrl(PROJECT_ID, 'doc-p')}/save`, {
      ...saveBody(2),
      rounding: [
        {
          target: 'line',
          scale: 0,
          mode: 'HALF_UP',
          sourceStatus: 'organization-policy',
        },
      ],
    });
    expect(nonDesign.status).toBe(422);
    const error = (nonDesign.body as ApiError).error;
    expect(error.code).toBe('TAKEOFF_DOCUMENT_REJECTED');
    expect(error.details).toEqual({ rules: [{ rule: 0, sourceStatus: 'organization-policy' }] });
    // (c) an engine-invalid rule (scale outside 0..20) saves as a draft, never finalizes
    const outOfRange = await post(`${docUrl(PROJECT_ID, 'doc-p')}/save`, {
      ...saveBody(2),
      rounding: [{ target: 'line', scale: 25, mode: 'HALF_UP', sourceStatus: 'design' }],
    });
    expect(outOfRange.status).toBe(200);
    const finalized = await post(`${docUrl(PROJECT_ID, 'doc-p')}/finalize`, {
      expectedRevision: 3,
    });
    expect(finalized.status).toBe(422);
    expect((finalized.body as ApiError).error.message).toContain('INVALID_ROUNDING_POLICY');
  });

  it('duplicate lineIds/sheetIds/rowNos are store-level 409 conflicts (Q/R)', async () => {
    await seedDraft('doc-q', 'tk-q');
    const duplicateLine = await post(`${docUrl(PROJECT_ID, 'doc-q')}/save`, {
      ...saveBody(2),
      sheets: [
        {
          sheetId: 'S1',
          name: 'برگه',
          lines: [
            {
              lineId: 'L1',
              rowNo: 1,
              description: 'اول',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'manual', value: '1', justification: 'دلیل' },
            },
            {
              lineId: 'L1', // duplicate — lineIds are document-unique
              rowNo: 2,
              description: 'تکراری',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'manual', value: '1', justification: 'دلیل' },
            },
          ],
        },
      ],
    });
    expect(duplicateLine.status).toBe(409);
    expect((duplicateLine.body as ApiError).error.code).toBe('PERSISTENCE_CONFLICT');
    const duplicateSheet = await post(`${docUrl(PROJECT_ID, 'doc-q')}/save`, {
      ...saveBody(2),
      sheets: [
        { sheetId: 'S1', name: 'برگه', lines: [] },
        { sheetId: 'S1', name: 'تکراری', lines: [] },
      ],
    });
    expect(duplicateSheet.status).toBe(409);
    expect((duplicateSheet.body as ApiError).error.code).toBe('PERSISTENCE_CONFLICT');
    const duplicateRowNo = await post(`${docUrl(PROJECT_ID, 'doc-q')}/save`, {
      ...saveBody(2),
      sheets: [
        {
          sheetId: 'S1',
          name: 'برگه',
          lines: [
            {
              lineId: 'L1',
              rowNo: 1,
              description: 'اول',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'manual', value: '1', justification: 'دلیل' },
            },
            {
              lineId: 'L2',
              rowNo: 1, // duplicate rowNo within the sheet
              description: 'دوم',
              kind: 'addition',
              unit: 'm',
              quantity: { type: 'manual', value: '1', justification: 'دلیل' },
            },
          ],
        },
      ],
    });
    expect(duplicateRowNo.status).toBe(409);
    expect((duplicateRowNo.body as ApiError).error.code).toBe('PERSISTENCE_CONFLICT');
  });

  it('V1 authors origin "user" only (closed authoring vocabulary)', async () => {
    await seedDraft('doc-origin', 'tk-origin');
    const imported = await post(`${docUrl(PROJECT_ID, 'doc-origin')}/save`, {
      ...saveBody(2),
      sheets: [
        {
          sheetId: 'S1',
          name: 'برگه',
          lines: [
            {
              lineId: 'L1',
              rowNo: 1,
              description: 'ورود داده',
              kind: 'addition',
              unit: 'm',
              origin: 'import', // reserved for a future pipeline (CG-FT §13)
              quantity: { type: 'manual', value: '1', justification: 'دلیل' },
            },
          ],
        },
      ],
    });
    expect(imported.status).toBe(400);
    expect((imported.body as ApiError).error.code).toBe('INVALID_REQUEST');
  });

  it('a takeoff of project A is invisible and immutable through project B (S)', async () => {
    // control: project B exists and can hold its own takeoff
    const own = await post(collectionUrl(PROJECT_B_ID), {
      takeoffId: 'tk-b',
      documentId: 'doc-b',
      title: 'متره پروژه ب',
    });
    expect(own.status).toBe(201);
    // every project-A route through project B answers a bare 404 — no existence disclosure
    const cases: Array<[string, unknown]> = [
      ['GET', undefined],
      ['POST/save', saveBody(2)],
      ['POST/archive', { expectedRevision: 2 }],
      ['POST/unarchive', { expectedRevision: 2 }],
      ['POST/finalize', { expectedRevision: 2 }],
      ['POST/follow-up', { documentId: 'doc-steal' }],
    ];
    for (const [route, payload] of cases) {
      const response =
        payload === undefined
          ? await get(docUrl(PROJECT_B_ID, 'doc-1'))
          : await post(`${docUrl(PROJECT_B_ID, 'doc-1')}${route.slice('POST'.length)}`, payload);
      expect(response.status).toBe(404);
      expect((response.body as ApiError).error.code).toBe('NOT_FOUND');
    }
  });

  it('unknown identities are a stable 404 (T)', async () => {
    const missing = await get(docUrl(PROJECT_ID, 'no-such-document'));
    expect(missing.status).toBe(404);
    const error = (missing.body as ApiError).error;
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('no takeoff document');
  });

  it('the D-015 stateless preview stays unchanged beside the new family (AC)', async () => {
    const preview = await post('/takeoff/quantities/preview', {
      items: [
        {
          itemKey: 'q1',
          kind: 'addition',
          unit: 'm2',
          count: '2',
          length: '3',
          width: '4',
        },
      ],
    });
    expect(preview.status).toBe(200);
    expect((preview.body as { items: { quantity: string }[] }).items[0]?.quantity).toBe('24');
    const withRounding = await post('/takeoff/quantities/preview', {
      items: [{ itemKey: 'q1', kind: 'addition', unit: 'm2', count: '2', length: '3', width: '4' }],
      rounding: [], // D-015/D3-A: exact-only, a rounding field is still rejected
    });
    expect(withRounding.status).toBe(400);
    expect((withRounding.body as ApiError).error.code).toBe('INVALID_REQUEST');
  });
});

// -------------------------------------------------------------------------------------------------
// P7-S1 (CG-FT@0.2.0 §15, D-LIST=B): the project-scoped takeoff list — a pure projection of
// findByProjectId. Pinned: empty project → []; all three statuses listed; follow-up documents
// are independent rows; deterministic (takeoffId, documentNumber) ordering; unknown project →
// 404; cross-project isolation; the projection carries exactly the §15.2 fields and nothing
// else (no sheets, no rounding, no snapshot internals, no finalizedAt on non-finalized rows).
// -------------------------------------------------------------------------------------------------

const PROJECT_LIST_ID = 'dddddddd-eeee-4fff-8aaa-111111111111';
const PROJECT_ISOLATION_ID = 'eeeeeeee-ffff-4aaa-8bbb-222222222222';

describe('P7-S1: project-scoped takeoff list over HTTP', () => {
  // DEDICATED projects: the outer suite shares one server and the earlier describes have
  // already created documents in PROJECT_ID and PROJECT_B — the list is project-scoped.
  beforeAll(async () => {
    await createProject(PROJECT_LIST_ID);
    await createProject(PROJECT_ISOLATION_ID);
  });

  /** Creates a chain in PROJECT_LIST_ID and saves one (empty-content) draft revision. */
  async function seedListDraft(documentId: string, takeoffId: string): Promise<void> {
    const created = await post(`/projects/${PROJECT_LIST_ID}/takeoffs`, {
      takeoffId,
      documentId,
      title: 'ریز متره',
    });
    expect(created.status).toBe(201);
    const saved = await post(`/projects/${PROJECT_LIST_ID}/takeoffs/${documentId}/save`, {
      expectedRevision: 1,
      title: 'ریز متره',
      sheets: [],
      rounding: [],
    });
    expect(saved.status).toBe(200);
  }

  it('an empty project answers 200 with []', async () => {
    const empty = await get(collectionUrl(PROJECT_ISOLATION_ID));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
  });

  it('lists every status; follow-ups are independent rows; order is (takeoffId, documentNumber)', async () => {
    // chain tk-list-b: draft → finalized → follow-up draft (independent rows)
    await seedListDraft('doc-lb1', 'tk-list-b');
    const finalized = await post(`${docUrl(PROJECT_LIST_ID, 'doc-lb1')}/finalize`, {
      expectedRevision: 2,
    });
    expect(finalized.status).toBe(201);
    const followUp = await post(`${docUrl(PROJECT_LIST_ID, 'doc-lb1')}/follow-up`, {
      documentId: 'doc-lb2',
    });
    expect(followUp.status).toBe(201);
    // chain tk-list-a: draft → archived
    await seedListDraft('doc-la1', 'tk-list-a');
    const archived = await post(`${docUrl(PROJECT_LIST_ID, 'doc-la1')}/archive`, {
      expectedRevision: 2,
    });
    expect(archived.status).toBe(200);
    // chain tk-list-c: plain draft
    await seedListDraft('doc-lc1', 'tk-list-c');

    const list = await get(collectionUrl(PROJECT_LIST_ID));
    expect(list.status).toBe(200);
    const rows = list.body as Json[];
    // deterministic chain-grouped order (tk-list-a < tk-list-b < tk-list-c); within
    // tk-list-b the follow-up (documentNumber 2) follows its finalized source
    expect(rows.map((row) => row['documentId'])).toEqual([
      'doc-la1',
      'doc-lb1',
      'doc-lb2',
      'doc-lc1',
    ]);
    const byId = new Map(rows.map((row) => [row['documentId'] as string, row]));
    expect((byId.get('doc-la1') as Json)['status']).toBe('archived');
    expect((byId.get('doc-lb1') as Json)['status']).toBe('finalized');
    expect((byId.get('doc-lb2') as Json)['status']).toBe('draft');
    expect((byId.get('doc-lc1') as Json)['status']).toBe('draft');
    // finalizedAt rides ONLY on the finalized row (§15.2: optional/nullable)
    expect((byId.get('doc-lb1') as Json)['finalizedAt']).toBe(FIXED_INSTANT);
    expect('finalizedAt' in (byId.get('doc-la1') as Json)).toBe(false);
    expect('finalizedAt' in (byId.get('doc-lb2') as Json)).toBe(false);
    expect('finalizedAt' in (byId.get('doc-lc1') as Json)).toBe(false);
  });

  it('each row is exactly the §15.2 projection — no content, no snapshot internals', async () => {
    await seedListDraft('doc-lp', 'tk-list-p');
    const list = await get(collectionUrl(PROJECT_LIST_ID));
    const row = (list.body as Json[]).find((r) => r['documentId'] === 'doc-lp');
    expect(row).toBeDefined();
    expect(Object.keys(row as Json).sort()).toEqual([
      'createdAt',
      'documentId',
      'documentNumber',
      'revision',
      'status',
      'takeoffId',
      'title',
    ]);
    expect((row as Json)['revision']).toBe(2); // create (1) + the seeded save (2)
    expect((row as Json)['documentNumber']).toBe(1);
    expect((row as Json)['takeoffId']).toBe('tk-list-p');
    expect((row as Json)['title']).toBe('ریز متره');
  });

  it("unknown project → 404; a project never lists another project's documents", async () => {
    const unknown = await get(collectionUrl('cccccccc-dddd-4eee-9fff-000000000000'));
    expect(unknown.status).toBe(404);
    expect((unknown.body as ApiError).error.code).toBe('NOT_FOUND');

    // the isolation project has exactly its own document — PROJECT_LIST_ID's never leak
    const created = await post(`/projects/${PROJECT_ISOLATION_ID}/takeoffs`, {
      takeoffId: 'tk-iso-only',
      documentId: 'doc-iso-only',
      title: 'متره ایزوله',
    });
    expect(created.status).toBe(201);
    const isolated = await get(collectionUrl(PROJECT_ISOLATION_ID));
    expect(isolated.status).toBe(200);
    expect(isolated.body).toEqual([
      {
        documentId: 'doc-iso-only',
        takeoffId: 'tk-iso-only',
        documentNumber: 1,
        title: 'متره ایزوله',
        status: 'draft',
        revision: 1,
        createdAt: FIXED_INSTANT,
      },
    ]);
    // and PROJECT_LIST_ID still answers only its own four chains
    const listIds = (await get(collectionUrl(PROJECT_LIST_ID))).body as Json[];
    expect(listIds.map((row) => row['documentId'])).toEqual([
      'doc-la1',
      'doc-lb1',
      'doc-lb2',
      'doc-lc1',
      'doc-lp',
    ]);
  });
});

// -------------------------------------------------------------------------------------------------
// P7-S2 (CG-FT@0.2.0 §16 + §12.2, D-PREVIEW=B/D-ERROR=C): the stateless draft calculation
// preview over HTTP. Pinned: draft → 200 with the engine result VERBATIM (the exact fixture
// math finalization produces); the persisted document is byte-unchanged (no revision bump,
// no snapshot, still a draft — the list agrees); archived/finalized → 409
// TAKEOFF_INVALID_TRANSITION; engine failure → 422 TAKEOFF_SOLUTION_REJECTED with STRUCTURED
// details.failures and a generic message (engine codes never stringified into it); the
// finalize contract stays untouched (TAKEOFF_CALCULATION_FAILED, codes in the message);
// project isolation (404 through another project); preview never affects BOQ/transfer.
// -------------------------------------------------------------------------------------------------

describe('P7-S2: stateless draft calculation preview over HTTP', () => {
  it('a saved draft previews the verbatim engine result and NOTHING is persisted', async () => {
    await seedDraft('doc-calc', 'tk-calc');
    const before = await get(docUrl(PROJECT_ID, 'doc-calc'));

    const preview = await post(`${docUrl(PROJECT_ID, 'doc-calc')}/calculate`, {});
    expect(preview.status).toBe(200);
    const result = preview.body as Json;
    // the engine result contract, verbatim: versions stamped, statuses, exact/rounded math
    expect(result['specId']).toBe('CG-IR-MEAS');
    expect(result['status']).toBe('ok');
    expect(typeof result['specVersion']).toBe('string');
    expect(typeof result['engineVersion']).toBe('string');
    const itemTotals = result['itemTotals'] as Json[];
    const byCode = new Map(itemTotals.map((t) => [t['itemCode'] as string, t]));
    expect((byCode.get('SYN-1') as Json)['exactQty']).toBe(SYN1_TOTAL); // 36 + 36 (reference)
    expect((byCode.get('SYN-1002') as Json)['exactQty']).toBe(SYN1002_EXACT); // 48.24 − 14
    expect((byCode.get('SYN-1002') as Json)['roundedQty']).toBe(SYN1002_ROUNDED); // scale-1 rule
    expect((byCode.get('SYN-3') as Json)['exactQty']).toBe('4'); // count profile, floorCount 4

    // CRITICAL NON-MUTATION: the persisted document is byte-identical, still a draft,
    // same revision — and the list still shows it as a draft (no snapshot anywhere)
    const after = await get(docUrl(PROJECT_ID, 'doc-calc'));
    expect(after.status).toBe(200);
    expect(canonicalJson(after.body)).toBe(canonicalJson(before.body));
    expect((after.body as DocumentBody).status).toBe('draft');
    expect((after.body as DocumentBody).revision).toBe(2);
    const listRow = ((await get(collectionUrl(PROJECT_ID))).body as Json[]).find(
      (r) => r['documentId'] === 'doc-calc',
    );
    expect((listRow as Json)['status']).toBe('draft');
    // no finalized snapshot exists: the plain document endpoint answered the draft itself
    expect('result' in (after.body as Json)).toBe(false);

    // and finalization still works exactly as before after a preview (nothing consumed)
    const finalized = await post(`${docUrl(PROJECT_ID, 'doc-calc')}/finalize`, {
      expectedRevision: 2,
    });
    expect(finalized.status).toBe(201);
    expect((finalized.body as FinalizedBody).result.itemTotals.length).toBe(4);
  });

  it('archived and finalized documents → 409 TAKEOFF_INVALID_TRANSITION (existing semantics)', async () => {
    await seedDraft('doc-calc-arch', 'tk-calc-arch');
    await post(`${docUrl(PROJECT_ID, 'doc-calc-arch')}/archive`, { expectedRevision: 2 });
    const archivedPreview = await post(`${docUrl(PROJECT_ID, 'doc-calc-arch')}/calculate`, {});
    expect(archivedPreview.status).toBe(409);
    expect((archivedPreview.body as ApiError).error.code).toBe('TAKEOFF_INVALID_TRANSITION');

    await seedDraft('doc-calc-fin', 'tk-calc-fin');
    await post(`${docUrl(PROJECT_ID, 'doc-calc-fin')}/finalize`, { expectedRevision: 2 });
    const finalizedPreview = await post(`${docUrl(PROJECT_ID, 'doc-calc-fin')}/calculate`, {});
    expect(finalizedPreview.status).toBe(409);
    expect((finalizedPreview.body as ApiError).error.code).toBe('TAKEOFF_INVALID_TRANSITION');
  });

  it('engine failure → 422 TAKEOFF_SOLUTION_REJECTED with STRUCTURED details.failures', async () => {
    // a draft that saves fine but does not calculate (unresolved reference)
    const broken = [
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
    ];
    await seedDraft('doc-calc-bad', 'tk-calc-bad', broken, []);

    const preview = await post(`${docUrl(PROJECT_ID, 'doc-calc-bad')}/calculate`, {});
    expect(preview.status).toBe(422);
    const error = (preview.body as ApiError).error;
    expect(error.code).toBe('TAKEOFF_SOLUTION_REJECTED');
    // the failures are STRUCTURED under details.failures — engine codes never ride in the message
    const failures = (error.details as { failures: Json[] }).failures;
    expect(Array.isArray(failures)).toBe(true);
    expect(failures.length).toBeGreaterThan(0);
    expect((failures[0] as Json)['code']).toBe('UNKNOWN_REFERENCE');
    expect((failures[0] as Json)['lineId']).toBe('L1');
    expect(error.message).not.toContain('UNKNOWN_REFERENCE');
    expect(error.message).toContain('nothing was persisted');

    // nothing was persisted on failure either — the draft is untouched and editable
    const loaded = await get(docUrl(PROJECT_ID, 'doc-calc-bad'));
    expect((loaded.body as DocumentBody).status).toBe('draft');
    expect((loaded.body as DocumentBody).revision).toBe(2);

    // THE TWO-LAYER CONTRACT (D-ERROR=C): finalization of the SAME broken draft keeps its
    // own unchanged code — TAKEOFF_CALCULATION_FAILED, engine codes IN the message
    const finalize = await post(`${docUrl(PROJECT_ID, 'doc-calc-bad')}/finalize`, {
      expectedRevision: 2,
    });
    expect(finalize.status).toBe(422);
    const finalizeError = (finalize.body as ApiError).error;
    expect(finalizeError.code).toBe('TAKEOFF_CALCULATION_FAILED');
    expect(finalizeError.message).toContain('UNKNOWN_REFERENCE');
    expect(finalizeError.code).not.toBe(error.code); // never aliased
  });

  it('project isolation: another project cannot preview a foreign document', async () => {
    const foreign = await post(`${docUrl(PROJECT_B_ID, 'doc-calc')}/calculate`, {});
    expect(foreign.status).toBe(404);
    expect((foreign.body as ApiError).error.code).toBe('NOT_FOUND');
  });
});
