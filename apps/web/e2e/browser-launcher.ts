/**
 * Real-browser launcher for the E2E suite (Phase 19 §3).
 *
 * This environment cannot reach the Playwright browser CDN (cdn.playwright.dev,
 * playwright.azureedge.net and Google's chrome-for-testing storage are all blocked),
 * so the browser binary comes from the npm registry instead:
 *
 *   @playwright/test@1.63.0   — the runner (never downloads browsers by itself)
 *   @sparticuz/chromium@153   — Chromium 153.0.8010 packaged INSIDE the npm tarball
 *
 * Playwright 1.63 drives Chromium 153 natively (its own bundled revision is 1243 =
 * Chromium 153.0.8010.12), so the versions are matched by design.
 *
 * The sparticuz package also ships the NSS/NSPR shared libraries Chromium needs on
 * hosts that lack them (bin/al2023.tar.br) but only extracts them automatically on
 * Amazon Linux 2023 — on this Debian sandbox we extract them ourselves and export
 * LD_LIBRARY_PATH, which the spawned browser process inherits.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { chromium as playwrightChromium, type Browser } from '@playwright/test';
import chromium from '@sparticuz/chromium';

const libDir = join(tmpdir(), 'al2023', 'lib');

/** Extracts the bundled NSS/NSPR libs once (idempotent) and exports LD_LIBRARY_PATH. */
export function prepareBrowserLibraries(): string {
  if (!existsSync(libDir)) {
    const require = createRequire(import.meta.url);
    const entryPath = require.resolve('@sparticuz/chromium');
    const binPath = join(dirname(entryPath), '..', 'bin');
    const tarPath = join(tmpdir(), 'al2023.tar');
    writeFileSync(tarPath, brotliDecompressSync(readFileSync(join(binPath, 'al2023.tar.br'))));
    mkdirSync(join(tmpdir(), 'al2023'), { recursive: true });
    execFileSync('tar', ['-xf', tarPath, '-C', join(tmpdir(), 'al2023')]);
  }
  process.env['LD_LIBRARY_PATH'] = [
    libDir,
    ...(process.env['LD_LIBRARY_PATH']?.split(':') ?? []),
  ].join(':');
  return libDir;
}

/** Launches the real Chromium (npm-distributed binary). */
export async function launchRealChromium(): Promise<Browser> {
  prepareBrowserLibraries();
  return await playwrightChromium.launch({
    executablePath: await chromium.executablePath(),
    // Minimal, stable flag set. The sparticuz default args target AWS Lambda
    // (single-process etc.) which is fragile for a long interactive E2E session —
    // a normal headless Chromium is what we want to test against.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });
}
