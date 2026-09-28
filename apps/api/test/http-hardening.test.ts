/**
 * HTTP transport hardening (Production Release Audit §7): framework-level errors —
 * malformed JSON, oversized bodies, unsupported media types, unknown routes — must
 * answer the SAME stable {error:{code,message}} contract with honest status codes,
 * never a misleading 500 and never Fastify's default shape. No stack traces, no
 * internals, no credentials in any body.
 */
import { describe, expect, it } from 'vitest';
import { buildTestServer } from './helpers.js';

describe('HTTP transport error hygiene', () => {
  it('malformed JSON answers 400 INVALID_REQUEST with the stable shape', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': 'application/json' },
      payload: '{"projectId": "x", ',
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(typeof body.error.message).toBe('string');
    expect(response.body).not.toMatch(/at .+\(/); // no stack trace
    await app.close();
  });

  it('an empty JSON body answers 400 with the stable shape', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_REQUEST');
    await app.close();
  });

  it('a body above the 1 MiB limit answers 413 PAYLOAD_TOO_LARGE', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'a'.repeat(2 * 1024 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('PAYLOAD_TOO_LARGE');
    await app.close();
  });

  it('an unsupported content type answers a 4xx stable shape (no 500)', async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { 'content-type': 'text/plain' },
      payload: 'not json',
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    const body = response.json<{ error: { code: string } }>();
    expect(typeof body.error.code).toBe('string');
    await app.close();
  });

  it('unknown routes answer 404 with the stable shape, not Fastify defaults', async () => {
    const app = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error?: { code?: string }; statusCode?: number }>();
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(body.statusCode).toBeUndefined(); // Fastify's default shape is absent
    await app.close();
  });
});
