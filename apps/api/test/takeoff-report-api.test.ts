/**
 * D-016 Phase 6 (G6=A) — the takeoff report HTTP routes, pinned here:
 *
 * - GET /projects/:projectId/takeoffs/:documentId/render/{excel,pdf} renders the
 *   FINALIZED snapshot only (the persisted engine result, never recalculated), through
 *   the same conventions as the estimate render routes (GET, content-type, no
 *   content-disposition — the web client derives the filename);
 * - finalized-only: a draft is a 409 TAKEOFF_NOT_FINALIZED (an unfinalized document has
 *   no immutable report), an unknown document is a 404;
 * - project isolation: a finalized document of project A is indistinguishable from a
 *   missing one through project B (404 — no cross-project existence disclosure), exactly
 *   like the rest of the family;
 * - rendering is read-only: the finalized document is byte-identical before and after
 *   both downloads (W).
 *
 * Content-level assertions (exact strings, sheet structure) live in the renderer package
 * tests, the projects pass-through tests and the e2e download flow — like the estimate
 * render routes, this file pins the HTTP contract.
 */
import type { InjectPayload } from 'light-my-request';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestServer, PROJECT_ID } from './helpers.js';

type App = Awaited<ReturnType<typeof buildTestServer>>;
type Injected = { status: number; headers: Record<string, unknown>; raw: Buffer; body: unknown };

let app: App;

const PROJECT_B_ID = 'bbbbbbbb-cccc-4ddd-9eee-ffffffffffff';
const DOC_ID = 'doc-report-1';
const DOC_URL = `/projects/${PROJECT_ID}/takeoffs/${DOC_ID}`;
const DRAFT_ID = 'doc-report-draft';
const DRAFT_URL = `/projects/${PROJECT_ID}/takeoffs/${DRAFT_ID}`;

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
        quantity: { type: 'reference', terms: [{ lineId: 'L1', factor: '1', use: 'signed' }] },
      },
      {
        lineId: 'L1',
        rowNo: 1,
        description: 'کانال فوتی',
        itemCode: 'SYN-1',
        kind: 'addition',
        unit: 'm3',
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

async function post(url: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return app
    .inject({ method: 'POST', url, payload: payload as InjectPayload })
    .then((r) => ({ status: r.statusCode, body: r.json<unknown>() }));
}

async function get(url: string): Promise<Injected> {
  const response = await app.inject({ method: 'GET', url });
  const contentTypeHeader = response.headers['content-type'];
  const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : '';
  return {
    status: response.statusCode,
    headers: response.headers,
    raw: response.rawPayload,
    // binary payloads (the reports) carry no JSON body — never parse them
    body: contentType.includes('json') ? response.json<unknown>() : null,
  };
}

async function seedDraft(documentId: string, takeoffId: string): Promise<void> {
  const created = await post(`/projects/${PROJECT_ID}/takeoffs`, {
    takeoffId,
    documentId,
    title: 'ریز متره',
  });
  expect(created.status).toBe(201);
  const saved = await post(`/projects/${PROJECT_ID}/takeoffs/${documentId}/save`, {
    expectedRevision: 1,
    title: 'ریز متره',
    sheets: SHEETS,
    rounding: ROUNDING,
  });
  expect(saved.status).toBe(200);
}

beforeAll(async () => {
  app = await buildTestServer();
  for (const projectId of [PROJECT_ID, PROJECT_B_ID]) {
    const response = await post('/projects', { projectId, title: 'پروژه متره' });
    expect(response.status).toBe(201);
  }
  await seedDraft(DOC_ID, `tk-${DOC_ID}`);
  const finalized = await post(`${DOC_URL}/finalize`, { expectedRevision: 2 });
  expect(finalized.status).toBe(201);
  await seedDraft(DRAFT_ID, `tk-${DRAFT_ID}`); // stays a draft for the 409 case
});

describe('takeoff report render routes (finalized-only, G6=A)', () => {
  it('GET render/excel returns real XLSX bytes with the XLSX content type', async () => {
    const response = await get(`${DOC_URL}/render/excel`);
    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.raw.length).toBeGreaterThan(1000);
    expect(response.raw[0]).toBe(0x50); // P
    expect(response.raw[1]).toBe(0x4b); // K
  });

  it('GET render/pdf returns real PDF bytes with the PDF content type', async () => {
    const response = await get(`${DOC_URL}/render/pdf`);
    expect(response.status).toBe(200);
    expect(String(response.headers['content-type'])).toBe('application/pdf');
    expect(response.raw.length).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(response.raw.subarray(0, 5))).toBe('%PDF-');
  });

  it('a draft is a 409 TAKEOFF_NOT_FINALIZED — no report exists before finalization (C)', async () => {
    for (const kind of ['excel', 'pdf'] as const) {
      const response = await get(`${DRAFT_URL}/render/${kind}`);
      expect(response.status).toBe(409);
      expect((response.body as { error: { code: string } }).error.code).toBe(
        'TAKEOFF_NOT_FINALIZED',
      );
      expect((response.body as { error: { message: string } }).error.message).toContain(
        'only a finalized takeoff',
      );
    }
  });

  it('an unknown document is a 404 for both kinds', async () => {
    for (const kind of ['excel', 'pdf'] as const) {
      const response = await get(`${DOC_URL}-missing/render/${kind}`);
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }
  });

  it('project isolation: another project gets a 404, never a report (V)', async () => {
    for (const kind of ['excel', 'pdf'] as const) {
      const response = await get(`/projects/${PROJECT_B_ID}/takeoffs/${DOC_ID}/render/${kind}`);
      expect(response.status).toBe(404);
      expect((response.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }
  });

  it('rendering never mutates the finalized document (W)', async () => {
    const before = await get(DOC_URL);
    expect(before.status).toBe(200);
    await get(`${DOC_URL}/render/excel`);
    await get(`${DOC_URL}/render/pdf`);
    const after = await get(DOC_URL);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
  });

  it('is deterministic: two downloads return byte-identical reports (K)', async () => {
    for (const kind of ['excel', 'pdf'] as const) {
      const first = await get(`${DOC_URL}/render/${kind}`);
      const second = await get(`${DOC_URL}/render/${kind}`);
      expect(first.raw.equals(second.raw)).toBe(true);
    }
  });
});
