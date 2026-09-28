import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Both the dev server AND `vite preview` (which serves the production build for the
// browser E2E suite) proxy `/api` to the local API process, so browser code only ever
// uses same-origin relative URLs (never a hardcoded backend address). Production builds
// override the base with VITE_API_BASE_URL at build time.
const apiProxy = {
  '/api': {
    target: process.env['VITE_API_PROXY_TARGET'] ?? 'http://127.0.0.1:3001',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `host: true` binds 0.0.0.0 so platform previews can reach the dev server;
    // `allowedHosts: true` lets it answer the proxied preview hostname. Dev-server
    // only — production builds are unaffected.
    host: true,
    allowedHosts: true,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    host: true,
    allowedHosts: true,
    proxy: apiProxy,
  },
  resolve: {
    // workspace packages expose their TS source through the `source` condition
    conditions: ['source'],
  },
  ssr: {
    // the node-environment integration test resolves through vite's SSR environment,
    // which does not inherit the client-side resolve.conditions
    resolve: { conditions: ['source'] },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 120_000,
  },
});
