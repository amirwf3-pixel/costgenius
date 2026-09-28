/**
 * D-015/D5-A: POST /takeoff/quantities/preview — the stateless dimensional quantity
 * preview. Pinned here: the happy path over all four S1 units, the stable public error
 * contract (engine codes NEVER public — only inside details), the exactness rules
 * (a `rounding` field is rejected; decimal factors must be strings, not JSON numbers)
 * and determinism.
 */
import { describe, expect, it } from 'vitest';
import { buildTestServer } from './helpers.js';

interface PreviewItem {
  readonly itemKey: string;
  readonly kind: 'addition' | 'deduction';
  readonly unit: string;
  readonly count: string;
  readonly length?: string;
  readonly width?: string;
  readonly height?: string;
}

async function preview(items: readonly unknown[], rounding?: unknown) {
  const app = await buildTestServer();
  const body: Record<string, unknown> = { items };
  if (rounding !== undefined) body['rounding'] = rounding;
  const response = await app.inject({
    method: 'POST',
    url: '/takeoff/quantities/preview',
    payload: body,
  });
  return {
    status: response.statusCode,
    body: response.json<PreviewBody>(),
    raw: response.body,
  };
}

interface PreviewBody {
  error?: { code: string; message: string; details?: { failures?: { code: string }[] } };
  items?: { lineId: string; quantity: string; unit: string; takeoff: unknown }[];
  specVersion?: string;
  engineVersion?: string;
}

const m2Item: PreviewItem = {
  itemKey: 'wall-a',
  kind: 'addition',
  unit: 'm2',
  count: '4',
  length: '2.5',
  width: '2',
};

describe('POST /takeoff/quantities/preview (D-015/D5-A)', () => {
  it('computes all four S1 units exactly, with the provenance echo and both versions', async () => {
    const { status, body } = await preview([
      m2Item, // 4 × 2.5 × 2 = 20
      { itemKey: 'beam', kind: 'addition', unit: 'm', count: '3', length: '2.5' }, // 7.5
      {
        itemKey: 'slab',
        kind: 'addition',
        unit: 'm3',
        count: '2',
        length: '3',
        width: '2',
        height: '0.5',
      }, // 6
      { itemKey: 'door', kind: 'addition', unit: 'each', count: '9' }, // 9
    ]);
    expect(status).toBe(200);
    const items = body.items ?? [];
    expect(new Map(items.map((i) => [i.lineId, i.quantity]))).toEqual(
      new Map([
        ['wall-a', '20'],
        ['beam', '7.5'],
        ['slab', '6'],
        ['door', '9'],
      ]),
    );
    expect(typeof body.specVersion).toBe('string');
    expect(typeof body.engineVersion).toBe('string');
    const wall = items.find((i) => i.lineId === 'wall-a');
    const takeoff = wall?.takeoff as Record<string, unknown>;
    expect(takeoff['input']).toEqual({
      itemKey: 'wall-a',
      unit: 'm2',
      lines: [
        { lineKey: 'wall-a', kind: 'addition', unit: 'm2', count: '4', length: '2.5', width: '2' },
      ],
    });
    expect((takeoff['output'] as Record<string, unknown>)['qty']).toBe('20');
    expect(takeoff['specVersion']).toBe(body.specVersion);
    expect(takeoff['engineVersion']).toBe(body.engineVersion);
  });

  it('is stateless and deterministic: identical requests yield identical bodies', async () => {
    const first = await preview([m2Item]);
    const second = await preview([m2Item]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.raw).toBe(second.raw);
  });

  // One row per reachable engine error class: the public code is ALWAYS
  // TAKEOFF_QUANTITIES_REJECTED; the engine code appears only in details.failures.
  const rejections: readonly {
    readonly name: string;
    readonly code: string;
    readonly item: unknown;
  }[] = [
    {
      name: 'INVALID_DECIMAL',
      code: 'INVALID_DECIMAL',
      item: { itemKey: 'a', kind: 'addition', unit: 'm', count: 'x', length: '1' },
    },
    {
      name: 'NEGATIVE_INPUT',
      code: 'NEGATIVE_INPUT',
      item: { itemKey: 'a', kind: 'addition', unit: 'm', count: '1', length: '-2' },
    },
    {
      name: 'NON_INTEGER_COUNT',
      code: 'NON_INTEGER_COUNT',
      item: { itemKey: 'a', kind: 'addition', unit: 'm', count: '1.5', length: '2' },
    },
    {
      name: 'DIMENSION_UNIT_MISMATCH',
      code: 'DIMENSION_UNIT_MISMATCH',
      item: { itemKey: 'a', kind: 'addition', unit: 'm2', count: '1', length: '2' },
    },
    {
      name: 'UNIT_MISMATCH (line vs item unit is impossible via this schema, non-S1 unit reaches it)',
      code: 'UNIT_MISMATCH',
      item: { itemKey: 'a', kind: 'addition', unit: 'kg', count: '1' },
    },
    {
      name: 'NEGATIVE_NET_QUANTITY (a standalone single-line deduction)',
      code: 'NEGATIVE_NET_QUANTITY',
      item: { itemKey: 'a', kind: 'deduction', unit: 'm2', count: '3', length: '1', width: '1' },
    },
    // EMPTY_ITEM and line-vs-item UNIT_MISMATCH are structurally unreachable through
    // this endpoint (the server always builds exactly one line per item, with the item's
    // own unit); they stay pinned by the adapter tests in packages/projects.
    {
      name: 'DUPLICATE_KEY (two items sharing an itemKey)',
      code: 'DUPLICATE_KEY',
      item: undefined, // handled by the dedicated test below
    },
  ];

  for (const rejection of rejections) {
    if (rejection.item === undefined) continue;
    it(`maps engine ${rejection.name} to 422 TAKEOFF_QUANTITIES_REJECTED (code only in details)`, async () => {
      const { status, body, raw } = await preview([rejection.item]);
      expect(status).toBe(422);
      expect(body.error?.code).toBe('TAKEOFF_QUANTITIES_REJECTED');
      // The engine code must NOT leak into the public code or message…
      expect(body.error?.code).not.toBe(rejection.code);
      expect(body.error?.message).not.toContain(rejection.code);
      // …only inside details.failures, mirroring the BOQ_LINES_REJECTED contract.
      const codes = (body.error?.details?.failures ?? []).map((f) => f.code);
      expect(codes).toContain(rejection.code);
      // The public message stays stable across all engine errors.
      expect(body.error?.message).toBe(
        'one or more takeoff items failed the quantity calculation rules; nothing was computed',
      );
      expect(raw).toContain('TAKEOFF_QUANTITIES_REJECTED');
    });
  }

  it('maps engine DUPLICATE_KEY (two items sharing an itemKey) to 422 with the code only in details', async () => {
    const { status, body } = await preview([
      { itemKey: 'dup', kind: 'addition', unit: 'each', count: '1' },
      { itemKey: 'dup', kind: 'addition', unit: 'each', count: '2' },
    ]);
    expect(status).toBe(422);
    expect(body.error?.code).toBe('TAKEOFF_QUANTITIES_REJECTED');
    const codes = (body.error?.details?.failures ?? []).map((f) => f.code);
    expect(codes).toContain('DUPLICATE_KEY');
  });

  it('rejects a rounding field (D-015/D3-A: exact-only, no rounding policy is accepted)', async () => {
    const { status, body } = await preview([m2Item], { stage: 'item', scale: 2, mode: 'half-up' });
    expect(status).toBe(400);
    expect(body.error?.code).toBe('INVALID_REQUEST');
  });

  it('rejects JSON-number factors (decimals must be exact strings)', async () => {
    const { status, body } = await preview([
      { itemKey: 'a', kind: 'addition', unit: 'm', count: 2, length: '3' },
    ]);
    expect(status).toBe(400);
    expect(body.error?.code).toBe('INVALID_REQUEST');
  });

  it('rejects an unknown field, an empty items array and a missing itemKey', async () => {
    const unknownField = await preview([{ ...m2Item, factor: 'x' }]);
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error?.code).toBe('INVALID_REQUEST');

    const empty = await preview([]);
    expect(empty.status).toBe(400);

    const missingKey = await preview([{ kind: 'addition', unit: 'each', count: '1' }]);
    expect(missingKey.status).toBe(400);
  });
});
