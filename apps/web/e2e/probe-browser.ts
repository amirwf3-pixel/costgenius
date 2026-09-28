/**
 * Dev-only probe: verifies the npm-distributed Chromium (@sparticuz/chromium — the only
 * browser-binary channel reachable in this environment; the Playwright CDN is blocked)
 * actually launches and drives a page with the installed @playwright/test runner.
 * Run: npx tsx apps/web/e2e/probe-browser.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { chromium as playwrightChromium } from '@playwright/test';
import chromium from '@sparticuz/chromium';

// The sparticuz package bundles the NSS/NSPR shared libraries Chromium needs on hosts
// that lack them (al2023.tar.br). It only extracts them automatically on Amazon Linux
// 2023 — on this Debian sandbox we extract them ourselves and export LD_LIBRARY_PATH
// (the browser process inherits the env).
const libDir = join(tmpdir(), 'al2023', 'lib');
if (!existsSync(libDir)) {
  const require = createRequire(import.meta.url);
  const entryPath = require.resolve('@sparticuz/chromium');
  const binPath = join(dirname(entryPath), '..', 'bin');
  const br = readFileSync(join(binPath, 'al2023.tar.br'));
  const tarPath = join(tmpdir(), 'al2023.tar');
  writeFileSync(tarPath, brotliDecompressSync(br));
  mkdirSync(join(tmpdir(), 'al2023'), { recursive: true });
  execFileSync('tar', ['-xf', tarPath, '-C', join(tmpdir(), 'al2023')]);
  console.log('extracted al2023 libs to', libDir);
}
process.env['LD_LIBRARY_PATH'] = [
  libDir,
  ...(process.env['LD_LIBRARY_PATH']?.split(':') ?? []),
].join(':');

const executablePath = await chromium.executablePath();
console.log('executable:', executablePath);

const browser = await playwrightChromium.launch({
  executablePath,
  args: [...chromium.args, '--no-sandbox'],
  headless: true,
});
const context = await browser.newContext();
const page = await context.newPage();
await page.setContent('<html><body><h1 id="t">سلام CostGenius</h1></body></html>');
const text = await page.textContent('#t');
const version = browser.version();
await browser.close();
console.log('browser version:', version);
console.log('page text:', text);
if (text !== 'سلام CostGenius') {
  throw new Error('probe failed: unexpected page text');
}
console.log('PROBE OK — real Chromium launched and driven');
