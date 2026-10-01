/**
 * THE Phase 18 workflow integration test (§50/§51): the web app's REAL typed client
 * drives the REAL API (Fastify + Zod + projects + Drizzle + PostgreSQL-in-process with
 * the actual migrations) over real HTTP — the full product story with the official
 * 1404 golden codes. No mock data anywhere in the chain.
 *
 * (A browser E2E runner would need a binary download this environment cannot perform;
 * this test exercises the exact code path the browser components use — same client,
 * same endpoints, same payloads — and is honestly reported as such.)
 */
/** @vitest-environment node */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  DrizzleAuditEventRepository,
  DrizzleEstimateRepository,
  DrizzleFinalizedEstimateRepository,
  DrizzleFinalizedTakeoffRepository,
  DrizzlePricebookEditionRepository,
  DrizzleProjectRepository,
  DrizzleSessionRepository,
  DrizzleTakeoffDocumentRepository,
  DrizzleUserRepository,
  type DbClient,
} from '@costgenius/db';
import {
  createApiServer,
  ensureBootstrapAdmin,
  seedPricebookEdition,
  transactOver,
} from '@costgenius/api';
import { createApiClient } from '../src/api/client.js';
import type { ApiClient } from '../src/api/context.js';

const FIXED_INSTANT = '2026-01-01T00:00:00Z';

let app: ReturnType<typeof createApiServer>;
let pg: PGlite;
let api: ApiClient;
let baseUrl: string;

beforeAll(async () => {
  pg = new PGlite();
  const raw = drizzle(pg);
  await migrate(raw, {
    migrationsFolder: new URL('../../../packages/db/migrations', import.meta.url).pathname,
  });
  const db = raw as unknown as DbClient;
  const userStore = new DrizzleUserRepository(db);
  const editionStore = new DrizzlePricebookEditionRepository(db);
  const sessionStore = new DrizzleSessionRepository(db);
  // P8-A S1: the REAL bootstrap + REAL login; the client then carries the session
  // cookie on every request (in a browser the cookie jar does this — node fetch does
  // not, so the client is built with a cookie-attaching fetch seam).
  await ensureBootstrapAdmin(
    { users: userStore, sessions: sessionStore, clock: () => FIXED_INSTANT },
    { bootstrapAdminUsername: 'admin', bootstrapAdminPassword: 'test-password-123' },
  );
  // P8-B S1 (D-PB-1 = B): the first-boot pricebook seed — same boot order as
  // production (migrations → bootstrap admin → seed → serve); no-op on later boots.
  const transact = transactOver(db);
  await seedPricebookEdition({
    users: userStore,
    editions: editionStore,
    transact,
    clock: () => FIXED_INSTANT,
  });
  app = createApiServer({
    repositories: {
      projects: new DrizzleProjectRepository(db),
      estimates: new DrizzleEstimateRepository(db),
      finalized: new DrizzleFinalizedEstimateRepository(db),
      takeoffDocuments: new DrizzleTakeoffDocumentRepository(db),
      finalizedTakeoffs: new DrizzleFinalizedTakeoffRepository(db),
      editions: editionStore,
    },
    governance: {
      users: userStore,
      sessions: sessionStore,
      audit: new DrizzleAuditEventRepository(db),
    },
    clock: () => FIXED_INSTANT,
    // S3: the audited mutations run on ONE transaction (the canonical factory).
    transact,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('expected a TCP address');
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password-123' }),
  });
  if (login.status !== 200)
    throw new Error(`integration-test login failed: ${String(login.status)}`);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const rawFetch = globalThis.fetch;
  const cookieFetch: typeof fetch = (input, init) =>
    rawFetch(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), cookie },
    });
  api = createApiClient(baseUrl, { fetchImpl: cookieFetch });
});

afterAll(async () => {
  await app.close();
  await pg.close();
});

describe('browser workflow over the real API (client → HTTP → Fastify → Zod → projects → DB)', () => {
  it('health is reachable', async () => {
    await expect(api.health()).resolves.toBe(true);
  });

  it('pricebook lookup finds the golden codes with exact units and prices', async () => {
    const rows = await api.searchPricebook('010101');
    const row = rows.find((r) => r.code === '010101');
    expect(row?.unit.code).toBe('m2');
    expect(row?.basePrice).toBe('2890');
    // the printed text uses 'کسربها' without a space — search by code prefix and by a
    // word that really appears in the row's printed description
    const byCode = await api.searchPricebook('220925');
    expect(byCode.some((r) => r.code === '220925')).toBe(true);
    const byDescription = await api.searchPricebook('ماسه نرم', 50);
    expect(byDescription.some((r) => r.code === '220925')).toBe(true);
  });

  it('runs project → estimate → version → golden BOQ → calculate → finalize → reports', async () => {
    // ---- project ----
    const project = await api.createProject({
      title: 'ساختمان اداری — آزمون مرورگر',
      metadata: { location: 'تهران' },
    });
    expect(project.title).toBe('ساختمان اداری — آزمون مرورگر');
    expect(await api.listProjects()).toHaveLength(1);
    expect((await api.getProject(project.projectId)).projectId).toBe(project.projectId);

    // ---- estimate + version ----
    const estimate = await api.createEstimate(project.projectId, { title: 'برآورد اولیه' });
    expect((await api.listEstimates(project.projectId)).map((e) => e.estimateId)).toEqual([
      estimate.estimateId,
    ]);
    const version = await api.createVersion(estimate.estimateId, { buildingId: 'building-main' });
    expect(version.status).toBe('draft');
    expect(version.edition).toBe('1404');

    // ---- golden 1404 BOQ lines (exact codes/units from the verified dataset) ----
    const added = await api.addLines(version.versionId, [
      { pricebookCode: '010101', quantity: '1000', unit: 'm2' },
      { pricebookCode: '270320', quantity: '10', unit: 'm3' },
      { pricebookCode: '270403', quantity: '2', unit: 'm3' },
      { pricebookCode: '220925', quantity: '40', unit: 'm2' },
      { pricebookCode: '090320', quantity: '80', unit: 'kg' },
    ]);
    expect(added.lines).toHaveLength(5);
    const byId = new Map(added.lines.map((line) => [line.lineId, line]));
    expect(byId.get(added.lines[0]?.lineId ?? '')?.pricebookCode).toBe('010101');
    expect(added.lines.some((line) => line.basePrice === '-1037000')).toBe(true); // negative visible
    expect(added.lines.some((line) => line.basePrice === null)).toBe(true); // null never zero

    // ---- the add-line contract rejects an invented unit (ton_km ≠ t) ----
    await expect(
      api.addLines(version.versionId, [{ pricebookCode: '280101', quantity: '1', unit: 't' }]),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'BOQ_LINES_REJECTED' });

    // ---- calculate: the incomplete golden mix has a null total (never zero) ----
    const calculation = await api.calculate(version.versionId, {
      floor: {
        buildingId: 'building-main',
        groundFloorArea: '600',
        firstBasementArea: '400',
        aboveGroundFloors: [
          ...Array.from({ length: 10 }, () => ({ area: '500' })),
          { area: '400' },
        ],
        belowGroundFloors: Array.from({ length: 3 }, () => ({ area: '400' })),
        totalBuildingFloorArea: '7600',
      },
      overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
      regional: {
        parts: [{ regionId: 'r-test', coefficient: '1.1', executionCost: '51828473.788' }],
      },
      siteSetup: { lumpSumAmount: '12000000' },
    });
    expect(calculation.s4Result.finalEstimate).toBeNull();
    expect(calculation.rollup.amount).toBeNull();
    expect(calculation.s4Result.pending.incomplete.length).toBeGreaterThan(0);

    // ---- finalize: the exact bundle persists and the version becomes read-only ----
    const bundle = await api.finalize(version.versionId, {
      floor: {
        buildingId: 'building-main',
        groundFloorArea: '600',
        firstBasementArea: '400',
        aboveGroundFloors: [
          ...Array.from({ length: 10 }, () => ({ area: '500' })),
          { area: '400' },
        ],
        belowGroundFloors: Array.from({ length: 3 }, () => ({ area: '400' })),
        totalBuildingFloorArea: '7600',
      },
      overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
      regional: {
        parts: [{ regionId: 'r-test', coefficient: '1.1', executionCost: '51828473.788' }],
      },
      siteSetup: { lumpSumAmount: '12000000' },
    });
    expect(bundle.finalizedAt).toBe(FIXED_INSTANT);
    expect(bundle.calculation.s4Result.finalEstimate).toBeNull(); // exactness preserved

    // the API now answers the finalized bundle for this version
    const reloaded = await api.getVersion(version.versionId);
    expect(reloaded.kind).toBe('finalized');

    // mutation is refused with the stable 409 contract the UI maps to its Persian message
    await expect(
      api.addLines(version.versionId, [{ pricebookCode: '010101', quantity: '1', unit: 'm2' }]),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'VERSION_FINALIZED', status: 409 });

    // ---- reports download as real bytes ----
    const excel = await api.downloadReport(version.versionId, 'excel');
    expect(excel.filename).toMatch(/\.xlsx$/);
    const excelBytes = new Uint8Array(await excel.blob.arrayBuffer());
    expect(excelBytes[0]).toBe(0x50); // 'P' of the PK zip magic
    expect(excel.blob.size).toBeGreaterThan(1000);

    const pdf = await api.downloadReport(version.versionId, 'pdf');
    expect(pdf.filename).toMatch(/\.pdf$/);
    const pdfBytes = new Uint8Array(await pdf.blob.arrayBuffer());
    expect(new TextDecoder().decode(pdfBytes.subarray(0, 5))).toBe('%PDF-');

    // ---- v2: the only way forward after finalization (§69) ----
    const v2 = await api.createVersion(estimate.estimateId, { buildingId: 'building-main' });
    expect(v2.versionNumber).toBe(2);
    expect(v2.status).toBe('draft');
    const estimateAfter = await api.getEstimate(estimate.estimateId);
    expect(estimateAfter.versions.map((v) => v.status)).toEqual(['finalized', 'draft']);
    // v1 is byte-stable: the finalized bundle is unchanged after v2 exists
    const v1Again = await api.getVersion(version.versionId);
    expect(v1Again.kind).toBe('finalized');
  });
});

describe('D-015: dimensional entry over the real API (preview → commit → provenance)', () => {
  it('previews exact quantities, commits factors only; the server computes quantity + provenance', async () => {
    const project = await api.createProject({ title: 'متره‌ای — آزمون', metadata: {} });
    const estimate = await api.createEstimate(project.projectId, { title: 'متره' });
    const version = await api.createVersion(estimate.estimateId, { buildingId: 'building-main' });

    // ---- stateless preview: 4 × 2.5 × 2 = 20 m2 exactly, with the provenance echo ----
    const preview = await api.previewTakeoffQuantities([
      { itemKey: 'p1', kind: 'addition', unit: 'm2', count: '4', length: '2.5', width: '2' },
    ]);
    expect(preview.items[0]?.quantity).toBe('20');
    const takeoff = preview.items[0]?.takeoff;
    expect(takeoff?.output.qty).toBe('20');
    expect(takeoff?.specVersion).toBe(preview.specVersion);
    expect(takeoff?.engineVersion).toBe(preview.engineVersion);

    // ---- an engine rule violation surfaces as the single public code (details-only) ----
    await expect(
      api.previewTakeoffQuantities([
        { itemKey: 'p2', kind: 'addition', unit: 'm2', count: '1', length: '2' },
      ]),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'TAKEOFF_QUANTITIES_REJECTED' });

    // ---- commit: factors only — the server computes the quantity and provenance ----
    const added = await api.addLines(version.versionId, [
      {
        pricebookCode: '010101',
        unit: 'm2',
        takeoff: { kind: 'addition', unit: 'm2', count: '4', length: '2.5', width: '2' },
      },
      { pricebookCode: '270320', quantity: '10', unit: 'm3' }, // manual lines unchanged
    ]);
    expect(added.lines).toHaveLength(2);
    const dimensional = added.lines.find((line) => line.pricebookCode === '010101');
    expect(dimensional?.quantity).toBe('20'); // server-computed, never client-sent
    expect(dimensional?.lineAmount).toBe('57800'); // 20 × 2890, exact
    // the provenance rides on the line's trace (absent from the web view type — narrowed)
    const trace = (
      dimensional as unknown as {
        trace: {
          takeoff?: {
            input: unknown;
            output: { qty: string };
            specVersion: string;
            engineVersion: string;
          };
        };
      }
    ).trace;
    expect(trace.takeoff?.output.qty).toBe('20');
    expect(typeof trace.takeoff?.specVersion).toBe('string');
    expect(typeof trace.takeoff?.engineVersion).toBe('string');
    const manual = added.lines.find((line) => line.pricebookCode === '270320');
    expect(manual?.quantity).toBe('10');
    expect('takeoff' in (manual as unknown as { trace: Record<string, unknown> }).trace).toBe(
      false,
    );

    // ---- quantity AND takeoff together is structurally rejected (exactly one of) ----
    await expect(
      api.addLines(version.versionId, [
        {
          pricebookCode: '010101',
          unit: 'm2',
          quantity: '999',
          takeoff: { kind: 'addition', unit: 'm2', count: '1', length: '1', width: '1' },
        },
      ]),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'INVALID_REQUEST' });
  });
});
