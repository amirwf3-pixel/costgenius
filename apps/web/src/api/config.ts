/**
 * API base URL resolution (never hardcoded to a backend address).
 *
 * - Browser code uses SAME-ORIGIN relative URLs: the dev server proxies `/api` to the
 *   local API process (see vite.config.ts), and a production deployment serves the app
 *   behind the same origin (or sets VITE_API_BASE_URL at build time).
 * - No secret ever lives here — this is a public endpoint prefix, nothing else.
 */
export function resolveApiBaseUrl(): string {
  const configured: unknown = import.meta.env['VITE_API_BASE_URL'];
  return typeof configured === 'string' && configured.length > 0 ? configured : '/api';
}
