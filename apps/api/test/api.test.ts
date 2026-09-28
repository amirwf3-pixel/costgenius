import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Response as InjectResponse } from 'light-my-request';
import { canonicalJson } from '@costgenius/db';
import type { Estimate, EstimateVersion } from '@costgenius/boq';
import type { EstimateCalculation, FinalizedEstimate, Project } from '@costgenius/projects';

type ApiErrorBody = { code: string; message: string; details?: unknown };

/** Typed decode of an error body (the stable API error contract). */
function errorOf(response: InjectResponse): ApiErrorBody {
  return response.json<{ error: ApiErrorBody }>().error;
}

/** Typed decode of a line-binding failure list. */
function failuresOf(response: InjectResponse): Array<{
  lineId: string;
  pricebookCode: string;
  errors: Array<{ code: string; message: string }>;
}> {
  const body = response.json<{
    error?: {
      details?: {
        failures?: Array<{
          lineId: string;
          pricebookCode: string;
          errors: Array<{ code: string; message: string }>;
        }>;
      };
    };
  }>();
  const failures = body.error?.details?.failures;
  if (failures === undefined) {
    throw new Error('expected a line-binding failure list in error details');
  }
  return failures;
}
import {
  BLOCKED_LINES,
  BUILDING_ID,
  COMPLETE_LINES,
  COMPLETE_S4_EXPECTED,
  ESTIMATE_ID,
  FIXED_INSTANT,
  GOLDEN_COEFFICIENTS,
  ORGANIZATION_ID,
  PROJECT_ID,
  VERSION_ID,
  buildServerWithClosableDatabase,
  buildTestServer,
  seedVerticalSlice,
} from './helpers.js';
import { readApiConfig } from '../src/config.js';

describe('health', () => {
  it('GET /health returns ok', async () => {
    const app = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>()).toEqual({ status: 'ok' });
  });
});

describe('Project endpoints', () => {
  it('POST /projects creates and persists (201, exact echo, deterministic clock)', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: {
        projectId: PROJECT_ID,
        organizationId: ORGANIZATION_ID,
        title: 'برآورد اجرایی',
        metadata: { location: 'Tehran' },
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<Record<string, unknown>>();
    expect(body['projectId']).toBe(PROJECT_ID);
    expect(body['title']).toBe('برآورد اجرایی');
    expect(body['createdAt']).toBe(FIXED_INSTANT); // injected clock, never Date.now
    expect(body['metadata']).toEqual({ location: 'Tehran' });
  });

  it('GET /projects lists persisted projects deterministically; empty when none exist', async () => {
    const empty = await buildTestServer();
    const emptyList = await empty.inject({ method: 'GET', url: '/projects' });
    expect(emptyList.statusCode).toBe(200);
    expect(emptyList.json<unknown[]>()).toEqual([]);
    await empty.close();

    const app = await buildTestServer();
    await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'دوم' },
    });
    await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: PROJECT_ID, title: 'اول' },
    });
    const list = await app.inject({ method: 'GET', url: '/projects' });
    expect(list.statusCode).toBe(200);
    const projects = list.json<Array<{ projectId: string; title: string }>>();
    expect(projects.map((project) => project.projectId)).toEqual([
      PROJECT_ID, // deterministic: ascending id order regardless of creation order
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
  });

  it('GET /pricebook/rows finds codes by prefix and description by substring (capped, published order)', async () => {
    const app = await buildTestServer();
    const byPrefix = await app.inject({
      method: 'GET',
      url: '/pricebook/rows?search=0101',
    });
    expect(byPrefix.statusCode).toBe(200);
    const prefixBody = byPrefix.json<{
      rows: Array<{ code: string; unit: { code: string }; basePrice: string | null }>;
      edition: string;
    }>();
    expect(prefixBody.edition).toBe('ir-1404-abniye');
    expect(prefixBody.rows.length).toBeGreaterThan(0);
    expect(prefixBody.rows.every((row) => row.code.startsWith('0101'))).toBe(true);
    // the leading-zero fixture row is present with its exact identity and unit
    const exact = prefixBody.rows.find((row) => row.code === '010101');
    expect(exact?.basePrice).toBe('2890');
    expect(exact?.unit.code).toBe('m2');

    const byDescription = await app.inject({
      method: 'GET',
      url: `/pricebook/rows?search=${encodeURIComponent('ماسه نرم')}&limit=50`,
    });
    expect(byDescription.statusCode).toBe(200);
    const descBody = byDescription.json<{
      rows: Array<{ code: string; description: string; basePrice: string | null }>;
    }>();
    expect(descBody.rows.length).toBeGreaterThan(0);
    expect(descBody.rows.every((row) => row.description.includes('ماسه نرم'))).toBe(true);
    // the deduction fixture row is findable by its description and stays unpriced
    const deduction = descBody.rows.find((row) => row.code === '220925');
    expect(deduction?.basePrice).toBeNull();

    const bad = await app.inject({ method: 'GET', url: '/pricebook/rows?limit=999' });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe('INVALID_REQUEST');
  });

  it('GET /projects/:id reloads the persisted project', async () => {
    const app = await buildTestServer();
    await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: PROJECT_ID, title: 'p' },
    });
    const response = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}` });
    expect(response.statusCode).toBe(200);
    expect(response.json<Project>().projectId).toBe(PROJECT_ID);
  });

  it('GET /projects/:id of an unknown id is 404 NOT_FOUND', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: '/projects/00000000-0000-4000-8000-000000000000',
    });
    expect(response.statusCode).toBe(404);
    expect(errorOf(response).code).toBe('NOT_FOUND');
  });

  it('a malformed project uuid path parameter is a clean 400 (no DB error leak)', async () => {
    const app = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/projects/not-a-uuid' });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('INVALID_REQUEST');
  });

  it('an invalid project body (empty title) is 400 with Zod details', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: PROJECT_ID, title: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('INVALID_REQUEST');
    expect(Array.isArray(errorOf(response).details)).toBe(true);
  });

  it('an invalid projectId (not a UUID) is 400 with the domain code INVALID_ID', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: 'not-a-uuid', title: 'x' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('INVALID_ID');
  });

  it('rewriting a persisted project with different content is 409 PERSISTENCE_CONFLICT', async () => {
    const app = await buildTestServer();
    await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: PROJECT_ID, title: 'original' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: PROJECT_ID, title: 'rewritten' },
    });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('PERSISTENCE_CONFLICT');
  });
});

describe('Estimate endpoints', () => {
  it('POST /projects/:id/estimates creates an estimate (201)', async () => {
    const app = await buildTestServer();
    await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: PROJECT_ID, title: 'p' },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/estimates`,
      payload: { estimateId: ESTIMATE_ID, title: 'برآورد اولیه' },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json<Estimate>();
    expect(created.projectId).toBe(PROJECT_ID);
    expect(created.versions).toEqual([]);
  });

  it("GET /projects/:id/estimates lists the project's estimates; unknown project is 404", async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });

    const list = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}/estimates` });
    expect(list.statusCode).toBe(200);
    const listed = list.json<Array<{ estimateId: string; versions: Array<{ status: string }> }>>();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.estimateId).toBe(ESTIMATE_ID);
    expect(listed[0]?.versions).toHaveLength(1);
    expect(listed[0]?.versions[0]?.status).toBe('draft');

    const unknown = await app.inject({
      method: 'GET',
      url: '/projects/00000000-0000-4000-8000-000000000000/estimates',
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).code).toBe('NOT_FOUND');

    const fresh = await buildTestServer();
    await fresh.inject({
      method: 'POST',
      url: '/projects',
      payload: { projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'empty' },
    });
    const emptyList = await fresh.inject({
      method: 'GET',
      url: '/projects/cccccccc-cccc-4ccc-8ccc-cccccccccccc/estimates',
    });
    expect(emptyList.statusCode).toBe(200);
    expect(emptyList.json<unknown[]>()).toEqual([]);
    await fresh.close();
  });

  it('creating an estimate under a missing project is 404', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${PROJECT_ID}/estimates`,
      payload: { estimateId: ESTIMATE_ID, title: 'x' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('GET /estimates/:id returns the aggregate; unknown id is 404', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const found = await app.inject({ method: 'GET', url: `/estimates/${ESTIMATE_ID}` });
    expect(found.statusCode).toBe(200);
    expect(found.json<Estimate>().versions).toHaveLength(1);
    const missing = await app.inject({ method: 'GET', url: '/estimates/no-such' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('Version endpoints', () => {
  it('POST /estimates/:id/versions starts a draft bound to the 1404 edition', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const response = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: { buildingId: 'building-2' },
    });
    expect(response.statusCode).toBe(201);
    const version = response.json<EstimateVersion>();
    expect(version.versionNumber).toBe(2);
    expect(version.status).toBe('draft');
    expect(version.edition).toBe('1404');
    expect(version.buildingId).toBe('building-2');
    expect(version.versionId).toBe(`${ESTIMATE_ID}-v2`);
  });

  it('starting a version for an unknown estimate is 404', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: { buildingId: BUILDING_ID },
    });
    expect(response.statusCode).toBe(404);
  });

  it('GET /estimate-versions/:id returns the draft version; unknown is 404', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const found = await app.inject({ method: 'GET', url: `/estimate-versions/${VERSION_ID}` });
    expect(found.statusCode).toBe(200);
    expect(found.json<EstimateVersion>().versionId).toBe(VERSION_ID);
    expect(found.json<EstimateVersion>().status).toBe('draft');
    const missing = await app.inject({ method: 'GET', url: '/estimate-versions/no-such' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('Line endpoints (exact-code binding, price security)', () => {
  it('POST lines with real 1404 codes resolves and persists (incl. negatives + compound units)', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });
    expect(response.statusCode).toBe(200);
    const version = response.json<EstimateVersion>();
    expect(version.lines).toHaveLength(8);
    const lineOf = (lineId: string) => {
      const line = version.lines.find((l) => l.lineId === lineId);
      if (line === undefined) throw new Error(`line ${lineId} missing from the response`);
      return line;
    };
    const l1 = lineOf('l1');
    expect(l1.pricebookCode).toBe('010101'); // leading zero preserved end-to-end
    expect(l1.basePrice).toBe('2890');
    expect(l1.lineAmount).toBe('2890000');
    const l5 = lineOf('l5');
    expect(l5.basePrice).toBe('-1037000'); // 270320 negative price intact
    const l7 = lineOf('l7');
    expect(l7.unit.code).toBe('ton_km'); // compound unit never collapsed
    expect(l7.unit.label).toBe('تن - کیلومتر');
  });

  it('a missing pricebook code is 422 with the S2 code PRICEBOOK_ROW_NOT_FOUND in details', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: [{ lineId: 'x', pricebookCode: '999999', quantity: '1', unit: 'm2' }] },
    });
    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('BOQ_LINES_REJECTED');
    expect(failuresOf(response)[0]?.errors[0]?.code).toBe('PRICEBOOK_ROW_NOT_FOUND');
  });

  it('a zero-stripped code (70612) is NOT substituted for 010101', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: [{ lineId: 'x', pricebookCode: '70612', quantity: '1', unit: 'm2' }] },
    });
    expect(response.statusCode).toBe(422);
    expect(failuresOf(response)[0]?.errors[0]?.code).toBe('PRICEBOOK_ROW_NOT_FOUND');
  });

  it('a unit mismatch (ton_km row priced against t) is 422 UNIT_MISMATCH — no conversion', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: [{ lineId: 'x', pricebookCode: '280101', quantity: '5', unit: 't' }] },
    });
    expect(response.statusCode).toBe(422);
    expect(failuresOf(response)[0]?.errors[0]?.code).toBe('UNIT_MISMATCH');
  });

  it('an invalid decimal quantity is 422 INVALID_DECIMAL', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: {
        lines: [{ lineId: 'x', pricebookCode: '010101', quantity: '12.5.1', unit: 'm2' }],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(failuresOf(response)[0]?.errors[0]?.code).toBe('INVALID_DECIMAL');
  });

  it('a JSON-number quantity is rejected at the boundary (400) — decimals are strings', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: [{ lineId: 'x', pricebookCode: '010101', quantity: 12.5, unit: 'm2' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('INVALID_REQUEST');
  });

  it('a line payload carrying a client price (basePrice) is rejected (400) — price security', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: {
        lines: [
          { lineId: 'x', pricebookCode: '010101', quantity: '1', unit: 'm2', basePrice: '1' },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe('INVALID_REQUEST');
  });

  it('adding lines to an unknown version is 404; one bad line adds nothing (all-or-nothing)', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const unknown = await app.inject({
      method: 'POST',
      url: '/estimate-versions/no-such/lines',
      payload: { lines: COMPLETE_LINES.slice(0, 1) },
    });
    expect(unknown.statusCode).toBe(404);

    const mixed = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: {
        lines: [
          ...COMPLETE_LINES.slice(0, 2),
          { lineId: 'bad', pricebookCode: '999999', quantity: '1', unit: 'm2' },
        ],
      },
    });
    expect(mixed.statusCode).toBe(422);
    const reloaded = await app.inject({ method: 'GET', url: `/estimates/${ESTIMATE_ID}` });
    expect(reloaded.json<Estimate>().versions[0]?.lines).toHaveLength(0);
  });
});

describe('Calculation endpoint (S4 preview through the workflow)', () => {
  it('calculates the complete fixture exactly (positives, negatives, zero quantity)', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/calculate`,
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(response.statusCode).toBe(200);
    const calculation = response.json<EstimateCalculation>();
    const stages = calculation.s4Result.stages;
    expect(stages.find((s) => s.stage === 'base-subtotal')?.output).toBe(COMPLETE_S4_EXPECTED.base);
    expect(stages.find((s) => s.stage === 'floor')?.coefficient).toBe('1.0451');
    expect(stages.find((s) => s.stage === 'floor')?.output).toBe(COMPLETE_S4_EXPECTED.afterFloor);
    expect(stages.find((s) => s.stage === 'overhead')?.coefficient).toBe('1.30');
    expect(stages.find((s) => s.stage === 'overhead')?.output).toBe(
      COMPLETE_S4_EXPECTED.afterOverhead,
    );
    expect(stages.find((s) => s.stage === 'regional')?.coefficient).toBe('1.1');
    expect(stages.find((s) => s.stage === 'regional')?.output).toBe(
      COMPLETE_S4_EXPECTED.afterRegional,
    );
    expect(stages.find((s) => s.stage === 'site-setup')?.output).toBe(
      COMPLETE_S4_EXPECTED.finalEstimate,
    );
    expect(calculation.s4Result.finalEstimate).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
    expect(calculation.rollup.amount).toBe('38147600');
  });

  it('an INCOMPLETE line (220925) blocks the total: null, never 0, deduction note present', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: [...COMPLETE_LINES, ...BLOCKED_LINES] },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/calculate`,
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(response.statusCode).toBe(200);
    const calculation = response.json<EstimateCalculation>();
    expect(calculation.s4Result.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(calculation.s4Result.finalEstimate).toBeNull();
    expect(calculation.rollup.amount).toBeNull();
    const b1 = (
      calculation.reportModel.chapters as unknown as Array<{
        groups: Array<{ lines: Array<{ lineId: string; basePrice: unknown; notes: string[] }> }>;
      }>
    )
      .flatMap((c) => c.groups)
      .flatMap((g) => g.lines)
      .find((l) => l.lineId === 'b1');
    expect(b1?.basePrice).toBeNull();
    expect(b1?.notes[0]).toContain('کسر بها');
  });

  it('an EXTERNAL_DEPENDENCY line (090320) exposes the dependency id', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: [{ lineId: 'b3', pricebookCode: '090320', quantity: '80', unit: 'kg' }] },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/calculate`,
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(response.statusCode).toBe(200);
    const calculation = response.json<EstimateCalculation>();
    expect(calculation.s4Result.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(
      (calculation.s4Result.pending.externalDependencies as string[]).some((d) =>
        d.includes('star-item-instruction'),
      ),
    ).toBe(true);
  });

  it('an Appendix-1 row as an estimate line is 422 ESTIMATE_INPUT_ERROR (ONSITE-01)', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: [{ lineId: 'o1', pricebookCode: '410202', quantity: '10', unit: 'm3' }] },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/calculate`,
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(response.statusCode).toBe(422);
    expect(errorOf(response).code).toBe('ESTIMATE_INPUT_ERROR');
    expect(errorOf(response).message).toContain('410202');
  });

  it('calculate is deterministic: identical requests produce identical calculations', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });
    const a = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/calculate`,
      payload: GOLDEN_COEFFICIENTS,
    });
    const b = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/calculate`,
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(canonicalJson(a.json())).toBe(canonicalJson(b.json()));
  });
});

describe('Finalization endpoint (immutable persisted snapshot)', () => {
  it('finalizes, persists and reloads the exact bundle', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });
    const finalize = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/finalize`,
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(finalize.statusCode).toBe(201);
    const bundle = finalize.json<FinalizedEstimate>();
    expect(bundle.estimate.versions[0]?.status).toBe('finalized');
    expect(bundle.calculation.s4Result.finalEstimate).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
    expect(bundle.finalizedAt).toBe(FIXED_INSTANT);

    const reloaded = await app.inject({ method: 'GET', url: `/estimate-versions/${VERSION_ID}` });
    expect(reloaded.statusCode).toBe(200);
    expect(canonicalJson(reloaded.json<unknown>())).toBe(canonicalJson(bundle));
  });

  it('repeated finalization is 409 VERSION_FINALIZED', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/finalize`,
      payload: GOLDEN_COEFFICIENTS,
    });
    const again = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/finalize`,
      payload: GOLDEN_COEFFICIENTS,
    });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe('VERSION_FINALIZED');
  });

  it('adding a line to a finalized version is 409 — history is immutable', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/finalize`,
      payload: GOLDEN_COEFFICIENTS,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: [{ lineId: 'late', pricebookCode: '010101', quantity: '1', unit: 'm2' }] },
    });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).code).toBe('VERSION_FINALIZED');
  });

  it('after finalization, a new version is the only way forward (v2 starts empty)', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/finalize`,
      payload: GOLDEN_COEFFICIENTS,
    });
    const v2 = await app.inject({
      method: 'POST',
      url: `/estimates/${ESTIMATE_ID}/versions`,
      payload: { buildingId: BUILDING_ID },
    });
    expect(v2.statusCode).toBe(201);
    const v2Body = v2.json<EstimateVersion>();
    expect(v2Body.versionNumber).toBe(2);
    expect(v2Body.lines).toEqual([]);
    const estimateResponse = await app.inject({ method: 'GET', url: `/estimates/${ESTIMATE_ID}` });
    const estimateAggregate = estimateResponse.json<Estimate>();
    expect(estimateAggregate.versions[0]?.status).toBe('finalized');
    expect(estimateAggregate.versions[1]?.status).toBe('draft');
  });
});

describe('Rendering endpoints (from the reloaded snapshot)', () => {
  it('GET render/excel returns real XLSX bytes with the XLSX content type', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/finalize`,
      payload: GOLDEN_COEFFICIENTS,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/estimate-versions/${VERSION_ID}/render/excel`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.rawPayload.length).toBeGreaterThan(1000);
    expect(response.rawPayload[0]).toBe(0x50); // P
    expect(response.rawPayload[1]).toBe(0x4b); // K
  });

  it('GET render/pdf returns real PDF bytes with the PDF content type', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/finalize`,
      payload: GOLDEN_COEFFICIENTS,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/estimate-versions/${VERSION_ID}/render/pdf`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.rawPayload.length).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(response.rawPayload.subarray(0, 5))).toBe('%PDF-');
  });

  it('rendering a draft version is 409 VERSION_NOT_FINALIZED; unknown version is 404', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    const draft = await app.inject({
      method: 'GET',
      url: `/estimate-versions/${VERSION_ID}/render/excel`,
    });
    expect(draft.statusCode).toBe(409);
    expect(errorOf(draft).code).toBe('VERSION_NOT_FINALIZED');
    const unknown = await app.inject({
      method: 'GET',
      url: '/estimate-versions/no-such/render/pdf',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('rendered output is deterministic: two PDF renders are byte-identical', async () => {
    const app = await buildTestServer();
    await seedVerticalSlice(app);
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/lines`,
      payload: { lines: COMPLETE_LINES },
    });
    await app.inject({
      method: 'POST',
      url: `/estimate-versions/${VERSION_ID}/finalize`,
      payload: GOLDEN_COEFFICIENTS,
    });
    const a = await app.inject({
      method: 'GET',
      url: `/estimate-versions/${VERSION_ID}/render/pdf`,
    });
    const b = await app.inject({
      method: 'GET',
      url: `/estimate-versions/${VERSION_ID}/render/pdf`,
    });
    expect(Buffer.compare(Buffer.from(a.rawPayload), Buffer.from(b.rawPayload))).toBe(0);
  });
});

describe('§25/§26 safety scan of the API source', () => {
  /** Source with comments stripped (doc references must not trip code scans). */
  function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('no coercion, clock reads, randomness or secrets in apps/api/src', () => {
    const srcDir = new URL('../src/', import.meta.url);
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const banned = [
      'Number(',
      'parseFloat(',
      'parseInt(',
      'Math.round(',
      'Math.abs(',
      'Math.random',
      'Date.now',
      '|| 0',
      '?? 0',
      'DATABASE_URL =',
      'password',
    ];
    for (const file of files) {
      let code = codeOnly(readFileSync(new URL(file, srcDir), 'utf8'));
      if (file === 'config.ts') {
        // ONE documented infrastructure use (inspected, allowed by §26): parsing the TCP
        // PORT environment variable. It is not business logic — strip and count it.
        const portParses = code.split('Number.parseInt(').length - 1;
        expect(portParses).toBe(1); // exactly the port parse, nothing else
        code = code.replace('Number.parseInt(value, 10)', 'PORT_PARSE');
      }
      if (file === 'schemas.ts') {
        // P8-A S1 (inspected exception): the login body contract is exactly
        // { username, password } (CG-GOV@0.1.0 §1.4) and the password-change schema is
        // named passwordChangeSchema — the lowercase `password` occurrences in this
        // file are exactly that field and that schema name (twice); no VALUE ever
        // lives here (Zod validates shapes only).
        const passwordFields = code.split('password').length - 1;
        // P8-A S2 adds exactly one: the createUserSchema `password` field
        // (CG-GOV §2.3) — still shapes only, never a value.
        expect(passwordFields).toBe(4); // login field + schema name + create field
        code = code.replaceAll('password', 'LOGIN_CREDENTIAL_FIELD');
      }
      if (file === 'auth.ts') {
        // P8-A S1 (inspected exceptions — the authentication boundary IS this module):
        // - `password` identifiers are its vocabulary (parameters, hash field names,
        //   message text); the VALUES are scrypt hashes and never leave the module
        //   except into the users table (never a response body, log or audit detail);
        // - `Number.parseInt` parses the scrypt encoding's N/r/p parameters
        //   (CG-GOV §1.2) — hash-encoding infrastructure, not business coercion.
        //   Every other rule still applies (no Number(/parseFloat/Math.*/Date.now/
        //   Math.random/coercion defaults/secrets).
        const scryptParses = code.split('Number.parseInt(').length - 1;
        expect(scryptParses).toBe(3); // exactly N, r, p of the stored scrypt encoding
        code = code.replaceAll('Number.parseInt(', 'SCRYPT_PARAM_PARSE(');
        code = code.replaceAll('password', 'CREDENTIAL_FIELD');
      }
      if (file === 'authz.ts') {
        // P8-A S2 (inspected exception): the ONLY lowercase `password` in the
        // authorization policy is the '/auth/password' ROUTE KEY of the §3 matrix —
        // a path string, never a credential. Roles alone live here.
        const passwordFields = code.split('password').length - 1;
        expect(passwordFields).toBe(1); // the route key, nothing else
        code = code.replaceAll('password', 'ROUTE_KEY');
      }
      if (file === 'user-management.ts') {
        // P8-A S2 (inspected exceptions — this module IS the org_admin user-management
        // boundary, CG-GOV §2.3): the lowercase `password` occurrences are exactly the
        // createUser input field, its validation/hash calls and one error message; the
        // PublicUser Omit<> keeps the hash out of every response. No credential VALUE
        // is ever returned or logged (the same discipline as auth.ts).
        const passwordFields = code.split('password').length - 1;
        expect(passwordFields).toBe(6); // boundary vocabulary only (inspected above)
        code = code.replaceAll('password', 'ACCOUNT_CREDENTIAL_FIELD');
      }
      if (file === 'server.ts') {
        // P8-A S1 (inspected exception): the four /auth routes are wired HERE — the
        // lowercase `password` occurrences are exactly the login body field, the
        // password-change schema name, the '/auth/password' route path and the
        // passwordHash Omit<> types (so the hash can never reach a response). No
        // credential VALUE is ever handled in this file.
        const passwordFields = code.split('password').length - 1;
        expect(passwordFields).toBe(6); // auth wiring only (inspected above)
        code = code.replaceAll('password', 'AUTH_WIRING');
      }
      for (const pattern of banned) {
        expect(code.includes(pattern), `${file} must not contain "${pattern}"`).toBe(false);
      }
    }
  });

  it('no business-logic duplication: only the projects layer is orchestrated', () => {
    const srcDir = new URL('../src/', import.meta.url);
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const code = codeOnly(readFileSync(new URL(file, srcDir), 'utf8'));
      // the engines are never imported by the API (eslint-enforced; belt and braces here)
      for (const banned of [
        '@costgenius/cost-calculation',
        '@costgenius/boq',
        '@costgenius/reporting-excel',
        '@costgenius/reporting-pdf',
        '@costgenius/calc-engine',
      ]) {
        expect(code.includes(banned), `${file} must not import ${banned}`).toBe(false);
      }
      // direct database access lives ONLY in the composition root
      if (file !== 'composition.ts') {
        expect(code.includes('@costgenius/db'), `${file} must not touch the db adapter`).toBe(
          false,
        );
      }
      // no SQL anywhere in the API layer
      expect(code.includes('SELECT'), `${file} must not contain SQL`).toBe(false);
      expect(code.includes('select('), `${file} must not contain drizzle queries`).toBe(false);
    }
  });
});

describe('config validation (readApiConfig)', () => {
  it('DATABASE_URL is required and must be a PostgreSQL connection string (no fallback)', () => {
    expect(() => readApiConfig({})).toThrow('DATABASE_URL is required');
    expect(() => readApiConfig({ DATABASE_URL: 'mysql://user@host/db' })).toThrow(
      'must be a PostgreSQL connection string',
    );
    expect(readApiConfig({ DATABASE_URL: 'postgresql://user@host:5432/db' }).databaseUrl).toBe(
      'postgresql://user@host:5432/db',
    );
    expect(readApiConfig({ DATABASE_URL: 'postgres://user@host/db' }).databaseUrl).toBe(
      'postgres://user@host/db',
    );
  });

  it('PORT must be a TCP port; PORT/HOST/DATASET_PATH keep their documented defaults', () => {
    expect(() => readApiConfig({ DATABASE_URL: 'postgresql://u@h/db', PORT: 'nope' })).toThrow(
      'TCP port',
    );
    expect(() => readApiConfig({ DATABASE_URL: 'postgresql://u@h/db', PORT: '70000' })).toThrow(
      'TCP port',
    );
    const defaults = readApiConfig({ DATABASE_URL: 'postgresql://u@h/db' });
    expect(defaults.port).toBe(3000);
    expect(defaults.host).toBe('0.0.0.0');
    expect(defaults.datasetPath).toContain('verified-1404');
    expect(
      readApiConfig({ DATABASE_URL: 'postgresql://u@h/db', PORT: '8080', HOST: '127.0.0.1' }).host,
    ).toBe('127.0.0.1');
  });
});

describe('database unavailability (deterministic graceful failure)', () => {
  it('data routes answer the stable 500 contract; /health stays liveness-only; no internals leak', async () => {
    const { app, closeDatabase } = await buildServerWithClosableDatabase();
    await seedVerticalSlice(app);
    await closeDatabase(); // the database goes away AFTER a healthy startup

    const data = await app.inject({ method: 'GET', url: `/projects/${PROJECT_ID}` });
    expect(data.statusCode).toBe(500);
    expect(errorOf(data).code).toBe('INTERNAL_ERROR');
    expect(errorOf(data).message).not.toMatch(/pglite|postgres|econn|connect|closed/i);

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json<{ status: string }>()).toEqual({ status: 'ok' });
  });
});
