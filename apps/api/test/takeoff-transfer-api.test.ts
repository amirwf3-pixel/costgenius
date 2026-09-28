/**
 * D-016 Phase 4 — the Takeoff → BOQ transfer over real HTTP (G2=B, CG-FT §8), against
 * real in-process PostgreSQL (PGlite, actual migrations, the production Drizzle
 * repositories, a fixed clock). Pinned here:
 *
 * - only a FINALIZED takeoff transfers: draft and archived sources are a stable 409
 *   TAKEOFF_INVALID_TRANSITION, and the immutable snapshot is the source (the reloaded
 *   bundle stays byte-identical after a transfer — the Takeoff itself never changes);
 * - the full success contract: one BOQ line per itemCode itemTotal, the deterministic
 *   line identity, the §8.1 provenance on the persisted line, uncoded items reported as
 *   skipped, and the target estimate version actually carrying the appended lines;
 * - all-or-nothing over HTTP: an unknown itemCode rejects the whole transfer (422
 *   TAKEOFF_TRANSFER_REJECTED, PRICEBOOK_ROW_NOT_FOUND in details) and the version keeps
 *   zero new lines;
 * - repeat protection: a second transfer of the same source is 422 with ALREADY_TRANSFERRED;
 * - project isolation: a takeoff of project A never transfers through project B, and the
 *   target version must belong to the same project (bare 404s, no disclosure);
 * - the existing estimate workflow stays intact: the transferred version calculates and
 *   finalizes through the unchanged S2/S3/S4 chain.
 *
 * Real-server (node-postgres over TCP) CONCURRENT transfer verification is the env-gated
 * `takeoff-transfer.server.test.ts`; this file never fakes that.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { InjectPayload } from 'light-my-request';
import { buildTestServer, PROJECT_ID } from './helpers.js';

type App = Awaited<ReturnType<typeof buildTestServer>>;

const PROJECT_B_ID = 'bbbbbbbb-cccc-4ddd-9eee-ffffffffffff';

interface TransferResponse {
  transferred?: { itemCode: string; lineId: string; quantity: string; lineIds: string[] }[];
  skipped?: { unit: string; lineIds: string[]; qty: string }[];
  lines?: { lineId: string; pricebookCode: string; quantity: string }[];
}
interface ApiError {
  error: {
    code: string;
    message: string;
    details?: { failures?: { itemCode: string; errors: { code: string }[] }[] };
  };
}

let app: App;
let seq = 0;

function post(url: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return app
    .inject({ method: 'POST', url, payload: payload as InjectPayload })
    .then((r) => ({ status: r.statusCode, body: r.json<unknown>() }));
}

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json<unknown>() };
}

/** Creates a takeoff, saves content, and finalizes it — the full domain chain over HTTP. */
async function finalizedTakeoff(documentId: string): Promise<string> {
  const created = await post(`/projects/${PROJECT_ID}/takeoffs`, {
    takeoffId: `tk-${documentId}`,
    documentId,
    title: 'ریز متره',
  });
  expect(created.status).toBe(201);
  const saved = await post(`/projects/${PROJECT_ID}/takeoffs/${documentId}/save`, {
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
          {
            lineId: 'U',
            rowNo: 3,
            description: 'بدون کد',
            kind: 'addition',
            unit: 'm',
            quantity: { type: 'manual', value: '5', justification: 'دستی' },
          },
        ],
      },
    ],
  });
  expect(saved.status).toBe(200);
  const finalized = await post(`/projects/${PROJECT_ID}/takeoffs/${documentId}/finalize`, {
    expectedRevision: 2,
  });
  expect(finalized.status).toBe(201);
  return documentId;
}

/** Creates a project + estimate + draft version; returns the versionId. */
async function draftVersion(projectId = PROJECT_ID): Promise<string> {
  seq += 1;
  const estimateId = `est-transfer-${String(seq)}-1111-4111-8111-111111111111`;
  const estimate = await post(`/projects/${projectId}/estimates`, {
    estimateId,
    title: 'برآورد مقصد',
  });
  expect(estimate.status).toBe(201);
  const version = await post(`/estimates/${estimateId}/versions`, {
    buildingId: 'building-transfer',
    versionId: `${estimateId}-v1`,
  });
  expect(version.status).toBe(201);
  return `${estimateId}-v1`;
}

const transferUrl = (projectId = PROJECT_ID, documentId = 'doc-x'): string =>
  `/projects/${projectId}/takeoffs/${documentId}/transfer-to-boq`;

beforeAll(async () => {
  app = await buildTestServer();
  for (const projectId of [PROJECT_ID, PROJECT_B_ID]) {
    const response = await post('/projects', { projectId, title: 'پروژه' });
    expect(response.status).toBe(201);
  }
});

describe('takeoff → BOQ transfer over HTTP (G2=B)', () => {
  it('transfers a finalized takeoff: one line per itemTotal, uncoded skipped (A/D/E/H)', async () => {
    await finalizedTakeoff('doc-a');
    const versionId = await draftVersion();
    const transfer = await post(transferUrl(PROJECT_ID, 'doc-a'), { versionId });
    expect(transfer.status).toBe(200);
    const body = transfer.body as TransferResponse;
    // 010101 = 4.2 + 2.8 = 7 → ONE line; the uncoded 5 m item is skipped, not failed
    expect(body.transferred).toEqual([
      {
        itemCode: '010101',
        unit: 'm2',
        lineId: 'tk-doc-a-010101',
        quantity: '7',
        lineIds: ['A', 'B'],
        exactQty: '7',
      },
    ]);
    expect(body.skipped).toEqual([
      { itemCode: null, unit: 'm', lineIds: ['U'], exactQty: '5', qty: '5' },
    ]);
    expect(body.lines?.map((l) => l.pricebookCode)).toEqual(['010101']);
    // the target version actually carries the appended line with its provenance
    const version = await get(`/estimate-versions/${versionId}`);
    expect(version.status).toBe(200);
    const line = ((
      version.body as {
        lines?: {
          lineId: string;
          quantity: string;
          trace?: { takeoffDocument?: { takeoffDocumentId: string; lineIds: string[] } };
        }[];
      }
    ).lines ?? [])[0];
    expect(line?.lineId).toBe('tk-doc-a-010101');
    expect(line?.quantity).toBe('7');
    expect(line?.trace?.takeoffDocument).toMatchObject({
      takeoffDocumentId: 'doc-a',
      takeoffId: 'tk-doc-a',
      documentNumber: 1,
      itemCode: '010101',
      lineIds: ['A', 'B'],
      qty: '7',
    });
  });

  it('rejects a draft source (409) and an archived source (409) — finalized only (B/C)', async () => {
    // a draft takeoff
    const created = await post(`/projects/${PROJECT_ID}/takeoffs`, {
      takeoffId: 'tk-draft',
      documentId: 'doc-draft',
      title: 'ریز متره',
    });
    expect(created.status).toBe(201);
    const versionId = await draftVersion();
    const draft = await post(transferUrl(PROJECT_ID, 'doc-draft'), { versionId });
    expect(draft.status).toBe(409);
    expect((draft.body as ApiError).error.code).toBe('TAKEOFF_INVALID_TRANSITION');
    // an archived takeoff (draft → archived)
    const archived = await post(`/projects/${PROJECT_ID}/takeoffs/doc-draft/archive`, {
      expectedRevision: 1,
    });
    expect(archived.status).toBe(200);
    const transfer = await post(transferUrl(PROJECT_ID, 'doc-draft'), { versionId });
    expect(transfer.status).toBe(409);
    expect((transfer.body as ApiError).error.code).toBe('TAKEOFF_INVALID_TRANSITION');
    // and nothing was appended to the target
    const version = await get(`/estimate-versions/${versionId}`);
    expect((version.body as { lines?: unknown[] }).lines).toEqual([]);
  });

  it('rejects an unknown itemCode atomically — zero lines committed (I/R)', async () => {
    const created = await post(`/projects/${PROJECT_ID}/takeoffs`, {
      takeoffId: 'tk-bad',
      documentId: 'doc-bad',
      title: 'ریز متره',
    });
    expect(created.status).toBe(201);
    const saved = await post(`/projects/${PROJECT_ID}/takeoffs/doc-bad/save`, {
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
              description: 'خوب',
              itemCode: '010101',
              kind: 'addition',
              unit: 'm2',
              quantity: { type: 'dimensional', profile: 'LW', length: '2', width: '3' },
            },
            {
              lineId: 'X',
              rowNo: 2,
              description: 'ناموجود',
              itemCode: '999999',
              kind: 'addition',
              unit: 'm2',
              quantity: { type: 'dimensional', profile: 'LW', length: '1', width: '1' },
            },
          ],
        },
      ],
    });
    expect(saved.status).toBe(200);
    const finalized = await post(`/projects/${PROJECT_ID}/takeoffs/doc-bad/finalize`, {
      expectedRevision: 2,
    });
    expect(finalized.status).toBe(201);
    const versionId = await draftVersion();
    const transfer = await post(transferUrl(PROJECT_ID, 'doc-bad'), { versionId });
    expect(transfer.status).toBe(422);
    const error = (transfer.body as ApiError).error;
    expect(error.code).toBe('TAKEOFF_TRANSFER_REJECTED');
    expect(error.details?.failures?.[0]?.errors.map((e) => e.code)).toContain(
      'PRICEBOOK_ROW_NOT_FOUND',
    );
    // atomic over HTTP too: the version still has zero lines
    const version = await get(`/estimate-versions/${versionId}`);
    expect((version.body as { lines?: unknown[] }).lines).toEqual([]);
  });

  it('rejects a second transfer of the same source (ALREADY_TRANSFERRED) (S)', async () => {
    await finalizedTakeoff('doc-again');
    const versionId = await draftVersion();
    const first = await post(transferUrl(PROJECT_ID, 'doc-again'), { versionId });
    expect(first.status).toBe(200);
    const second = await post(transferUrl(PROJECT_ID, 'doc-again'), { versionId });
    expect(second.status).toBe(422);
    const error = (second.body as ApiError).error;
    expect(error.code).toBe('TAKEOFF_TRANSFER_REJECTED');
    expect(error.details?.failures?.[0]?.errors.map((e) => e.code)).toContain(
      'ALREADY_TRANSFERRED',
    );
    // still exactly one transferred line
    const version = await get(`/estimate-versions/${versionId}`);
    expect((version.body as { lines?: unknown[] }).lines).toHaveLength(1);
  });

  it('enforces project isolation on both sides (W)', async () => {
    await finalizedTakeoff('doc-iso');
    const ownVersion = await draftVersion(PROJECT_B_ID);
    // the takeoff of project A through project B → bare 404, no existence disclosure
    const crossSource = await post(transferUrl(PROJECT_B_ID, 'doc-iso'), {
      versionId: ownVersion,
    });
    expect(crossSource.status).toBe(404);
    expect((crossSource.body as ApiError).error.code).toBe('NOT_FOUND');
    // the takeoff is fine, but the TARGET version belongs to project B → bare 404 too
    const crossTarget = await post(transferUrl(PROJECT_ID, 'doc-iso'), {
      versionId: ownVersion,
    });
    expect(crossTarget.status).toBe(404);
    expect((crossTarget.body as ApiError).error.code).toBe('NOT_FOUND');
    // unknown takeoff / unknown version → the same stable 404
    const noTakeoff = await post(transferUrl(PROJECT_ID, 'no-such-doc'), {
      versionId: ownVersion,
    });
    expect(noTakeoff.status).toBe(404);
    const noVersion = await post(transferUrl(PROJECT_ID, 'doc-iso'), {
      versionId: 'no-such-version',
    });
    expect(noVersion.status).toBe(404);
  });

  it('rejects a finalized target with the existing 409 family', async () => {
    await finalizedTakeoff('doc-final');
    const versionId = await draftVersion();
    const transfer = await post(transferUrl(PROJECT_ID, 'doc-final'), { versionId });
    expect(transfer.status).toBe(200);
    const finalize = await post(`/estimate-versions/${versionId}/finalize`, {
      floor: {
        buildingId: 'building-transfer',
        groundFloorArea: '600',
        firstBasementArea: '400',
        aboveGroundFloors: [{ area: '500' }],
        belowGroundFloors: [],
        totalBuildingFloorArea: '1500',
      },
      overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
      regional: { parts: [{ regionId: 'r', coefficient: '1.1', executionCost: '1000' }] },
      siteSetup: { lumpSumAmount: '1000' },
    });
    expect(finalize.status).toBe(201);
    const again = await post(transferUrl(PROJECT_ID, 'doc-final'), { versionId });
    expect(again.status).toBe(409);
    expect((again.body as ApiError).error.code).toBe('VERSION_FINALIZED');
  });

  it('leaves the finalized takeoff byte-identical after the transfer (X/Y)', async () => {
    await finalizedTakeoff('doc-imm');
    const before = await get(`/projects/${PROJECT_ID}/takeoffs/doc-imm`);
    expect(before.status).toBe(200);
    const versionId = await draftVersion();
    const transfer = await post(transferUrl(PROJECT_ID, 'doc-imm'), { versionId });
    expect(transfer.status).toBe(200);
    const after = await get(`/projects/${PROJECT_ID}/takeoffs/doc-imm`);
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).toBe(JSON.stringify(before.body)); // snapshot untouched
    // and the transferred version still calculates + finalizes through unchanged S2/S3/S4
    const calc = await post(`/estimate-versions/${versionId}/calculate`, {
      floor: {
        buildingId: 'building-transfer',
        groundFloorArea: '600',
        firstBasementArea: '400',
        aboveGroundFloors: [{ area: '500' }],
        belowGroundFloors: [],
        totalBuildingFloorArea: '1500',
      },
      overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
      regional: { parts: [{ regionId: 'r', coefficient: '1.1', executionCost: '1000' }] },
      siteSetup: { lumpSumAmount: '1000' },
    });
    expect(calc.status).toBe(200);
    const finalize = await post(`/estimate-versions/${versionId}/finalize`, {
      floor: {
        buildingId: 'building-transfer',
        groundFloorArea: '600',
        firstBasementArea: '400',
        aboveGroundFloors: [{ area: '500' }],
        belowGroundFloors: [],
        totalBuildingFloorArea: '1500',
      },
      overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
      regional: { parts: [{ regionId: 'r', coefficient: '1.1', executionCost: '1000' }] },
      siteSetup: { lumpSumAmount: '1000' },
    });
    expect(finalize.status).toBe(201);
  });
});
