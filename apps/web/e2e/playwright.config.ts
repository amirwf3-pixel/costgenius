/**
 * Playwright config for the CostGenius browser E2E (Phase 19).
 *
 * Deterministic lifecycle (§3): the global setup builds the production web bundle,
 * then manages BOTH processes on fixed ports —
 *   API    : real createApiServer on PGlite + real migrations + 1404 dataset (127.0.0.1:3101)
 *   Web    : `vite preview` serving the PRODUCTION build (127.0.0.1:4173), /api proxied
 * and the teardown stops them. Single worker, no parallelism, no retries, no random
 * ports. The browser itself is the npm-distributed Chromium (see browser-launcher.ts).
 */
import { defineConfig } from '@playwright/test';

export const E2E_API_PORT = 3101;
export const E2E_WEB_PORT = 4173;
export const E2E_API_URL = `http://127.0.0.1:${String(E2E_API_PORT)}`;
export const E2E_WEB_URL = `http://127.0.0.1:${String(E2E_WEB_PORT)}`;
/**
 * P8-A S1: the authenticated session cookie the global setup acquires through the REAL
 * login route. Every spec starts authenticated; the auth spec opts out explicitly
 * (`test.use({ storageState: { cookies: [], origins: [] } })`).
 */
export const E2E_AUTH_STATE = './.auth/state.json';
export const E2E_ADMIN_USERNAME = 'admin';
export const E2E_ADMIN_PASSWORD = 'e2e-password-123'; // deterministic TEST credential, never production

export default defineConfig({
  testDir: 'specs',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: E2E_WEB_URL,
    headless: true,
    storageState: E2E_AUTH_STATE,
  },
  outputDir: './.playwright-artifacts',
});
