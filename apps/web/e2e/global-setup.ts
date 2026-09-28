/**
 * Deterministic E2E lifecycle (§3): build the production web bundle, start the real
 * API (PGlite-backed, fresh, no seed) and `vite preview` on FIXED ports, wait for
 * readiness, and expose the API pid so the network-failure spec can stop it for real.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_API_PORT,
  E2E_API_URL,
  E2E_WEB_PORT,
  E2E_WEB_URL,
} from './playwright.config.js';

const APP_DIR = resolve(import.meta.dirname, '..');

let api: ChildProcess | undefined;
let web: ChildProcess | undefined;

async function waitFor(url: string, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${label} did not become ready at ${url}`);
    await new Promise((r) => {
      setTimeout(r, 250);
    });
  }
}

function stop(child: ChildProcess | undefined, name: string, timeoutMs = 10_000): void {
  if (child === undefined || child.exitCode !== null) return;
  const process = child;
  process.kill('SIGTERM');
  const exited = new Promise<void>((resolvePromise) => {
    process.once('exit', () => {
      resolvePromise();
    });
    setTimeout(() => {
      if (process.exitCode === null) process.kill('SIGKILL');
      resolvePromise();
    }, timeoutMs);
  });
  exited.then(
    () => {
      console.log(`[e2e] stopped ${name}`);
    },
    () => undefined,
  );
}

export async function startE2EStack(): Promise<void> {
  // 0) fail fast on leftover processes from a previous (killed) run — deterministic ports
  for (const port of [E2E_API_PORT, E2E_WEB_PORT]) {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/`, {
        signal: AbortSignal.timeout(500),
      });
      throw new Error(
        `port ${String(port)} is already in use — stop the previous E2E run first ` +
          `(pkill -f "e2e-backend[.]ts"; pkill -f "vite[.]js preview")`,
      );
    } catch (error) {
      if (error instanceof TypeError) continue; // connection refused = port free
      if (error instanceof Error && error.name === 'TimeoutError') continue;
      if (error instanceof Error && error.message.includes('already in use')) throw error;
    }
  }

  // 1) production web build (always rebuilt — deterministic artifacts)
  const { execFileSync } = await import('node:child_process');
  console.log('[e2e] building production web bundle…');
  execFileSync('node', ['--import', 'tsx', 'node_modules/vite/bin/vite.js', 'build'], {
    cwd: APP_DIR,
    stdio: 'inherit',
  });

  // 2) real API on PGlite — fresh, no seed, deterministic port. P8-A S1: the API now
  //    requires authentication, so the bootstrap admin credentials (deterministic TEST
  //    values) are provided through the standard env vars (CG-GOV §1.5).
  console.log('[e2e] starting real API (PGlite + real migrations + 1404 dataset)…');
  api = spawn('node', ['--conditions=source', '--import', 'tsx', 'scripts/e2e-backend.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      E2E_PORT: String(E2E_API_PORT),
      CG_BOOTSTRAP_ADMIN_USERNAME: E2E_ADMIN_USERNAME,
      CG_BOOTSTRAP_ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  api.once('exit', (code) => {
    if (code !== null && code !== 0) console.log(`[e2e] API exited code=${String(code)}`);
  });
  await waitFor(`${E2E_API_URL}/health`, 'API', 60_000);

  // 3) production build preview with the /api proxy (same-origin browser code)
  console.log('[e2e] starting vite preview (production build)…');
  web = spawn(
    'node',
    ['node_modules/vite/bin/vite.js', 'preview', '--port', String(E2E_WEB_PORT), '--strictPort'],
    {
      cwd: APP_DIR,
      env: { ...process.env, VITE_API_PROXY_TARGET: E2E_API_URL },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  await waitFor(`${E2E_WEB_URL}/`, 'web preview', 60_000);

  // expose the pids/urls to the specs (the runner passes env to workers)
  process.env['COSTGENIUS_E2E_API_PID'] = String(api.pid);
  process.env['COSTGENIUS_E2E_API_URL'] = E2E_API_URL;
  process.env['COSTGENIUS_E2E_WEB_URL'] = E2E_WEB_URL;

  // 4) P8-A S1: log in through the REAL login route and write the Playwright storage
  //    state — every spec then runs with a genuine server-side session cookie.
  const login = await fetch(`${E2E_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: E2E_ADMIN_USERNAME,
      password: E2E_ADMIN_PASSWORD,
    }),
  });
  if (login.status !== 200) throw new Error(`[e2e] login failed: ${String(login.status)}`);
  const setCookie = login.headers.getSetCookie();
  const token = setCookie
    .find((cookie) => cookie.startsWith('cg_session='))
    ?.split(';')[0]
    ?.split('=')[1];
  if (token === undefined) throw new Error('[e2e] login returned no cg_session cookie');
  rmSync(resolve(APP_DIR, '.auth/state.json'), { force: true });
  mkdirSync(resolve(APP_DIR, '.auth'), { recursive: true });
  writeFileSync(
    resolve(APP_DIR, '.auth/state.json'),
    `${JSON.stringify(
      {
        cookies: [
          {
            name: 'cg_session',
            value: token,
            domain: '127.0.0.1',
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'Strict',
          },
        ],
        origins: [],
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `[e2e] stack ready: web=${E2E_WEB_URL} api=${E2E_API_URL} (api pid ${String(api.pid)}, authenticated)`,
  );
}

export function stopE2EStack(): void {
  stop(web, 'web preview');
  stop(api, 'API');
}

export default async function globalSetup(): Promise<void> {
  await startE2EStack();
  // register teardown safety: if the runner dies without globalTeardown, children die too
  process.on('exit', () => {
    stop(web, 'web preview', 2000);
    stop(api, 'API', 2000);
  });
}
