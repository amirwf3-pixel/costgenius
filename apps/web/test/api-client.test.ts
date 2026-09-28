/**
 * The single HTTP client: central JSON parsing, error contract mapping and network
 * failure semantics — exercised against a stubbed global fetch (no component involved).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, NetworkError, takeoffFactorHint } from '../src/api/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createApiClient error mapping', () => {
  it('maps a backend 409 finalized error to ApiError with the stable code and a Persian message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        jsonResponse(409, {
          error: { code: 'VERSION_FINALIZED', message: 'version is finalized' },
        }),
      ),
    );
    const api = createApiClient('/api');
    const error = await api.addLines('v', []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe('VERSION_FINALIZED');
    expect(apiError.userMessage).toContain('نسخه جدید');
  });

  it('maps a 403 FORBIDDEN to the Persian authorization message, echoing no role (P8-A S2)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        jsonResponse(403, {
          error: {
            code: 'FORBIDDEN',
            message: 'you do not have permission to perform this action',
            details: { requiredRole: 'estimator' },
          },
        }),
      ),
    );
    const api = createApiClient('/api');
    const error = await api.createProject({ title: 'x', metadata: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(403);
    expect(apiError.code).toBe('FORBIDDEN');
    expect(apiError.userMessage).toBe('شما مجوز انجام این عمل را ندارید.');
    // the UI never echoes which role would have been needed
    expect(apiError.userMessage).not.toMatch(/estimator|org_admin|reviewer|data_steward|viewer/);
  });

  it('maps 400 INVALID_REQUEST with details preserved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        jsonResponse(400, {
          error: {
            code: 'INVALID_REQUEST',
            message: 'schema violation',
            details: [{ path: 'title' }],
          },
        }),
      ),
    );
    const api = createApiClient('/api');
    const error = (await api
      .createProject({ title: 'x', metadata: {} })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(400);
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.details).toEqual([{ path: 'title' }]);
  });

  it('maps 404 NOT_FOUND and 500 INTERNAL_ERROR to distinct user messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'no project' } })),
    );
    const api = createApiClient('/api');
    const notFound = (await api.getProject('x').catch((e: unknown) => e)) as ApiError;
    expect(notFound.userMessage).toContain('پیدا نشد');

    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'unexpected' } })),
    );
    const serverError = (await api.listProjects().catch((e: unknown) => e)) as ApiError;
    expect(serverError.status).toBe(500);
    expect(serverError.userMessage).toContain('سرور');
  });

  it('a network failure becomes NetworkError (server unreachable, §49)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new TypeError('fetch failed');
      }),
    );
    const api = createApiClient('/api');
    const error = await api.listProjects().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).message).toContain('سرور');
  });

  it('sends decimals as exact strings and generates UUID identities (never a hardcoded id)', async () => {
    const fetchMock = vi.fn(() => jsonResponse(200, { versionId: 'v', lines: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createApiClient('/api');
    await api.addLines('v1', [{ pricebookCode: '010101', quantity: '1000', unit: 'm2' }]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      lines: Array<{ lineId: string; pricebookCode: string; quantity: string; unit: string }>;
    };
    expect(body.lines[0]?.pricebookCode).toBe('010101');
    expect(body.lines[0]?.quantity).toBe('1000'); // exact string, not a JSON number
    expect(body.lines[0]?.lineId).toMatch(/^l-[0-9a-f]{8}$/);
  });

  it('derives the report filename when the contract sends no content-disposition (§40)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Response(new Blob(['%PDF-1.4']), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          }),
      ),
    );
    const api = createApiClient('/api');
    const { filename, blob } = await api.downloadReport('v-1', 'pdf');
    expect(filename).toBe('costgenius-v-1.pdf');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('prefers the filename from content-disposition when the backend provides one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Response(new Blob(['PK']), {
            status: 200,
            headers: { 'content-disposition': 'attachment; filename="report.xlsx"' },
          }),
      ),
    );
    const api = createApiClient('/api');
    const { filename } = await api.downloadReport('v-1', 'excel');
    expect(filename).toBe('report.xlsx');
  });

  it('health() reports false on network failure without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new TypeError('fetch failed');
      }),
    );
    const api = createApiClient('/api');
    await expect(api.health()).resolves.toBe(false);
  });
});

describe('D-015: previewTakeoffQuantities and addLines takeoff payload', () => {
  it('posts the factors to /takeoff/quantities/preview and parses the exact result', async () => {
    const fetchMock = vi.fn(() =>
      jsonResponse(200, {
        specVersion: '0.1.0',
        engineVersion: '0.1.0',
        items: [
          {
            lineId: 'preview',
            quantity: '20',
            unit: 'm2',
            takeoff: {
              input: {},
              output: { qty: '20' },
              specVersion: '0.1.0',
              engineVersion: '0.1.0',
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createApiClient('/api');
    const result = await api.previewTakeoffQuantities([
      { itemKey: 'preview', kind: 'addition', unit: 'm2', count: '4', length: '2.5', width: '2' },
    ]);
    expect(result.items[0]?.quantity).toBe('20');
    const [url, init] = fetchMock.mock.calls[0] as unknown as readonly [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe('/api/takeoff/quantities/preview');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      items: [
        { itemKey: 'preview', kind: 'addition', unit: 'm2', count: '4', length: '2.5', width: '2' },
      ],
    });
  });

  it('maps TAKEOFF_QUANTITIES_REJECTED to ApiError with the Persian message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        jsonResponse(422, {
          error: {
            code: 'TAKEOFF_QUANTITIES_REJECTED',
            message: 'one or more takeoff items failed',
            details: { failures: [{ code: 'DIMENSION_UNIT_MISMATCH', itemKey: 'preview' }] },
          },
        }),
      ),
    );
    const api = createApiClient('/api');
    const error = (await api
      .previewTakeoffQuantities([{ itemKey: 'preview', kind: 'addition', unit: 'm2', count: '1' }])
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('TAKEOFF_QUANTITIES_REJECTED');
    expect(error.userMessage).toContain('متره‌ای');
    // the factor hint turns the engine code (details-only) into actionable Persian
    expect(takeoffFactorHint('DIMENSION_UNIT_MISMATCH')).toContain('ابعاد');
    expect(takeoffFactorHint('NON_INTEGER_COUNT')).toContain('صحیح');
    expect(takeoffFactorHint('NEGATIVE_INPUT')).toContain('نامنفی');
    expect(takeoffFactorHint('made-up-code')).toContain('پذیرفته نشد');
  });

  it('addLines sends exactly one of quantity or takeoff per line (never both, never neither)', async () => {
    const fetchMock = vi.fn(() => jsonResponse(200, { estimateId: 'e', versions: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createApiClient('/api');
    await api.addLines('v-1', [
      { pricebookCode: '010101', quantity: '1000', unit: 'm2' },
      {
        pricebookCode: '010101',
        unit: 'm2',
        takeoff: { kind: 'addition', unit: 'm2', count: '4', length: '2.5', width: '2' },
      },
    ]);
    const init = (
      fetchMock.mock.calls[0] as unknown as readonly [string, { method: string; body: string }]
    )[1];
    const body = JSON.parse(init.body) as { lines: Record<string, unknown>[] };
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]?.['quantity']).toBe('1000');
    expect('takeoff' in (body.lines[0] ?? {})).toBe(false);
    expect(body.lines[1]?.['takeoff']).toEqual({
      kind: 'addition',
      unit: 'm2',
      count: '4',
      length: '2.5',
      width: '2',
    });
    expect('quantity' in (body.lines[1] ?? {})).toBe(false);
    // every line carries a client-generated lineId (the server's takeoff itemKey)
    for (const line of body.lines) expect(typeof line['lineId']).toBe('string');
  });
});
