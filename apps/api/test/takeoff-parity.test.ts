/**
 * D-015 golden parity: the SAME estimate built once with manually entered quantities and
 * once with server-computed dimensional (takeoff) quantities must produce IDENTICAL
 * downstream numbers — s4_result and rollup byte-identical after identity normalization,
 * and report_model identical modulo the `trace.takeoff` provenance the owner mandated
 * adding (report_model embeds BoqLine including its trace, so the dimensional report
 * necessarily carries the extra provenance — this is asserted EXPLICITLY here, never
 * silently).
 *
 * The golden chain is the COMPLETE vertical slice (base 38,147,600 → ×1.0451 → ×1.30 →
 * ×1.1 → +12,000,000 = 69,011,321.1668) with five lines dimensionally recomputed
 * (010101, 010517, 240102, 270320, 270403) and three compound/weight lines entered
 * manually in BOTH builds (kg / ton_km / ton_nautical_mile are not S1 units).
 */
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  BUILDING_ID,
  FIXED_INSTANT,
  GOLDEN_COEFFICIENTS,
  ORGANIZATION_ID,
  PROJECT_ID,
  buildTestServer,
} from './helpers.js';

const ESTIMATE_MANUAL = '12345678-90ab-4cde-9f01-234567890abc';
const VERSION_MANUAL = `${ESTIMATE_MANUAL}-v1`;
const ESTIMATE_DIMENSIONAL = '12345678-90ab-4cde-9f01-234567890def';
const VERSION_DIMENSIONAL = `${ESTIMATE_DIMENSIONAL}-v1`;

/** The five dimensional lines: factors chosen to reproduce the manual quantities EXACTLY. */
const DIMENSIONAL_LINES = [
  {
    lineId: 'l1',
    pricebookCode: '010101',
    unit: 'm2',
    takeoff: { kind: 'addition', unit: 'm2', count: '1000', length: '1', width: '1' },
  },
  {
    lineId: 'l2',
    pricebookCode: '010517',
    unit: 'm2',
    takeoff: { kind: 'addition', unit: 'm2', count: '5', length: '1', width: '1' },
  },
  {
    lineId: 'l3',
    pricebookCode: '240102',
    unit: 'm2',
    takeoff: { kind: 'addition', unit: 'm2', count: '0', length: '1', width: '1' },
  },
  {
    lineId: 'l5',
    pricebookCode: '270320',
    unit: 'm3',
    takeoff: { kind: 'addition', unit: 'm3', count: '10', length: '1', width: '1', height: '1' },
  },
  {
    lineId: 'l6',
    pricebookCode: '270403',
    unit: 'm3',
    takeoff: { kind: 'addition', unit: 'm3', count: '2', length: '1', width: '1', height: '1' },
  },
] as const;

/** The three non-S1 lines, entered manually in BOTH builds (identical payloads). */
const MANUAL_LINES = [
  { lineId: 'l4', pricebookCode: '270101', quantity: '120', unit: 'kg' },
  { lineId: 'l7', pricebookCode: '280101', quantity: '500', unit: 'ton_km' },
  { lineId: 'l8', pricebookCode: '280501', quantity: '3', unit: 'ton_nautical_mile' },
] as const;

/** The manual quantities the dimensional factors must reproduce exactly. */
const MANUAL_QUANTITIES = new Map([
  ['l1', '1000'],
  ['l2', '5'],
  ['l3', '0'],
  ['l5', '10'],
  ['l6', '2'],
]);

/** Removes every `takeoff` key (deep) — the ONLY structural difference between builds. */
function stripTakeoff(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTakeoff);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'takeoff') continue; // the D-015 provenance — everything else must match
      out[key] = stripTakeoff(entry);
    }
    return out;
  }
  return value;
}

/** Normalizes the dimensional build's identity to the manual build's, then canonicalizes. */
function normalized(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ESTIMATE_DIMENSIONAL, ESTIMATE_MANUAL)
    .replaceAll(VERSION_DIMENSIONAL, VERSION_MANUAL);
}

interface CalculationResponse {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly s4Result: { estimateId: string; finalEstimate: string | null };
  readonly rollup: unknown;
  readonly reportModel: unknown;
}

async function injectJson(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  if (payload === undefined) {
    const response = await app.inject({ method, url });
    return { status: response.statusCode, body: response.json<unknown>() };
  }
  const response = await app.inject({ method, url, payload });
  return { status: response.statusCode, body: response.json<unknown>() };
}

describe('D-015 golden parity: manual vs dimensional entry (69,011,321.1668)', () => {
  it('produces identical s4_result/rollup and report_model modulo trace.takeoff', async () => {
    const app = await buildTestServer();

    // One project, two estimates: the manual build and the dimensional build.
    await injectJson(app, 'POST', '/projects', {
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      title: 'parity project',
      metadata: {},
    });
    for (const estimateId of [ESTIMATE_MANUAL, ESTIMATE_DIMENSIONAL]) {
      await injectJson(app, 'POST', `/projects/${PROJECT_ID}/estimates`, {
        estimateId,
        title: 'parity estimate',
      });
      await injectJson(app, 'POST', `/estimates/${estimateId}/versions`, {
        buildingId: BUILDING_ID,
      });
    }

    // Manual build: all eight lines with quantities.
    const manualResponse = await injectJson(
      app,
      'POST',
      `/estimate-versions/${VERSION_MANUAL}/lines`,
      {
        lines: [
          ...DIMENSIONAL_LINES.map((line) => ({
            lineId: line.lineId,
            pricebookCode: line.pricebookCode,
            quantity: MANUAL_QUANTITIES.get(line.lineId),
            unit: line.unit,
          })),
          ...MANUAL_LINES,
        ],
      },
    );
    expect(manualResponse.status).toBe(200);

    // Dimensional build: five lines carry factors (no quantity!), three stay manual.
    const dimensionalResponse = await injectJson(
      app,
      'POST',
      `/estimate-versions/${VERSION_DIMENSIONAL}/lines`,
      {
        lines: [
          ...DIMENSIONAL_LINES.map((line) => ({
            lineId: line.lineId,
            pricebookCode: line.pricebookCode,
            unit: line.unit,
            takeoff: line.takeoff,
          })),
          ...MANUAL_LINES,
        ],
      },
    );
    expect(dimensionalResponse.status).toBe(200);

    // Both calculations with the SAME coefficients, reportId and generatedAt.
    const calculatePayload = {
      ...GOLDEN_COEFFICIENTS,
      reportId: 'report-parity',
      generatedAt: FIXED_INSTANT,
    };
    const manualCalc = await injectJson(
      app,
      'POST',
      `/estimate-versions/${VERSION_MANUAL}/calculate`,
      calculatePayload,
    );
    const dimensionalCalc = await injectJson(
      app,
      'POST',
      `/estimate-versions/${VERSION_DIMENSIONAL}/calculate`,
      calculatePayload,
    );
    expect(manualCalc.status).toBe(200);
    expect(dimensionalCalc.status).toBe(200);
    const manual = manualCalc.body as CalculationResponse;
    const dimensional = dimensionalCalc.body as CalculationResponse;

    // 1. The golden chain lands on the same exact total in both builds.
    expect(manual.s4Result.finalEstimate).toBe('69011321.1668');
    expect(dimensional.s4Result.finalEstimate).toBe('69011321.1668');

    // 2. s4_result: byte-identical after identity normalization (estimateId only).
    expect(normalized(dimensional.s4Result)).toBe(JSON.stringify(manual.s4Result));

    // 3. rollup: byte-identical (no identity inside — replacement is a no-op safeguard).
    expect(normalized(dimensional.rollup)).toBe(JSON.stringify(manual.rollup));

    // 4. report_model: identical modulo the takeoff provenance and identity. The manual
    //    report_model is compared verbatim; the dimensional one only loses its
    //    `trace.takeoff` keys — every value field (quantities, amounts, statuses,
    //    descriptions, dependencies) must be untouched.
    expect(normalized(stripTakeoff(dimensional.reportModel))).toBe(
      JSON.stringify(manual.reportModel),
    );

    // 5. The dimensional report_model really does carry the provenance (not stripped
    //    into silence): exactly the five dimensional lines carry trace.takeoff.
    const reportLines = (
      (
        dimensional.reportModel as {
          chapters?: { groups?: { lines?: { trace?: { takeoff?: unknown } }[] }[] }[];
        }
      ).chapters ?? []
    ).flatMap((chapter) => (chapter.groups ?? []).flatMap((group) => group.lines ?? []));
    expect(reportLines.filter((line) => line.trace?.takeoff !== undefined)).toHaveLength(5);
  });

  it('persists the full provenance on draft lines and inside the finalized snapshot', async () => {
    const app = await buildTestServer();
    await injectJson(app, 'POST', '/projects', {
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      title: 'parity project',
      metadata: {},
    });
    await injectJson(app, 'POST', `/projects/${PROJECT_ID}/estimates`, {
      estimateId: ESTIMATE_DIMENSIONAL,
      title: 'parity estimate',
    });
    await injectJson(app, 'POST', `/estimates/${ESTIMATE_DIMENSIONAL}/versions`, {
      buildingId: BUILDING_ID,
    });
    const added = await injectJson(app, 'POST', `/estimate-versions/${VERSION_DIMENSIONAL}/lines`, {
      lines: [
        {
          lineId: 'l1',
          pricebookCode: '010101',
          unit: 'm2',
          takeoff: { kind: 'addition', unit: 'm2', count: '1000', length: '1', width: '1' },
        },
        ...MANUAL_LINES.slice(0, 1),
      ],
    });
    expect(added.status).toBe(200);

    // Draft GET: the line carries all four provenance fields.
    const draft = (await injectJson(app, 'GET', `/estimate-versions/${VERSION_DIMENSIONAL}`)) as {
      status: number;
      body: {
        lines: {
          lineId: string;
          quantity: string;
          trace: {
            takeoff?: {
              input: unknown;
              output: { qty: string };
              specVersion: string;
              engineVersion: string;
            };
          };
        }[];
      };
    };
    expect(draft.status).toBe(200);
    const line = draft.body.lines.find((l) => l.lineId === 'l1');
    expect(line?.quantity).toBe('1000'); // the server computed it from the factors
    const takeoff = line?.trace.takeoff;
    expect(takeoff).toBeDefined();
    const input = takeoff?.input as { lines?: { count?: string }[] } | undefined;
    expect(input?.lines?.[0]?.count).toBe('1000');
    expect(takeoff?.output.qty).toBe('1000');
    expect(typeof takeoff?.specVersion).toBe('string');
    expect(typeof takeoff?.engineVersion).toBe('string');
    // The manual line has no takeoff key on its trace (byte-compatible shape).
    const manualLine = draft.body.lines.find((l) => l.lineId === 'l4');
    expect('takeoff' in (manualLine?.trace ?? {})).toBe(false);

    // Finalize and reload the snapshot: the provenance survives in the persisted bundle.
    const finalizePayload = {
      ...GOLDEN_COEFFICIENTS,
      reportId: 'report-parity',
      generatedAt: FIXED_INSTANT,
      finalizedAt: FIXED_INSTANT,
    };
    const finalized = await injectJson(
      app,
      'POST',
      `/estimate-versions/${VERSION_DIMENSIONAL}/finalize`,
      finalizePayload,
    );
    expect(finalized.status).toBe(201);
    const reloaded = (await injectJson(
      app,
      'GET',
      `/estimate-versions/${VERSION_DIMENSIONAL}`,
    )) as {
      status: number;
      body: {
        calculation: {
          reportModel: {
            chapters: { groups: { lines: { lineId: string; trace: { takeoff?: unknown } }[] }[] }[];
          };
        };
      };
    };
    expect(reloaded.status).toBe(200);
    const snapshotLines = reloaded.body.calculation.reportModel.chapters
      .flatMap((chapter) => chapter.groups)
      .flatMap((group) => group.lines);
    const snapshotLine = snapshotLines.find((l) => l.lineId === 'l1');
    expect(snapshotLine?.trace.takeoff).toBeDefined();
  });
});
