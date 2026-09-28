/**
 * Playwright fixtures for the CostGenius E2E suite:
 * - `browser` is the REAL Chromium launched from the npm-distributed binary
 *   (see browser-launcher.ts) — never Playwright's bundled download;
 * - every `page` automatically collects console errors, page errors, HTTP >= 400
 *   responses and network failures (Phase 19 §18), asserted per-test via `noise`.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { launchRealChromium } from './browser-launcher.js';

/** Per-test collector of unexpected browser noise (§18). */
export class NoiseCollector {
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];
  readonly httpErrors: string[] = [];
  readonly requestFailures: string[] = [];

  attach(page: Page): void {
    page.on('console', (msg) => {
      if (msg.type() === 'error') this.consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => {
      this.pageErrors.push(String(error));
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        this.httpErrors.push(`${String(response.status())} ${response.url()}`);
      }
    });
    page.on('requestfailed', (request) => {
      this.requestFailures.push(`${request.failure()?.errorText ?? '?'} ${request.url()}`);
    });
  }

  /**
   * Asserts zero unexpected noise. `allow` patterns (matched as substrings or
   * regexes) must be narrow and documented — e.g. the intentional 4xx responses of
   * the error-UX spec, or the connection-refused lines of the network-failure spec.
   */
  assertClean(allow: readonly (string | RegExp)[] = []): void {
    const matches = (text: string): boolean =>
      allow.some((pattern) =>
        typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text),
      );
    const unexpected = {
      consoleErrors: this.consoleErrors.filter((t) => !matches(t)),
      pageErrors: this.pageErrors.filter((t) => !matches(t)),
      httpErrors: this.httpErrors.filter((t) => !matches(t)),
      requestFailures: this.requestFailures.filter((t) => !matches(t)),
    };
    const count =
      unexpected.consoleErrors.length +
      unexpected.pageErrors.length +
      unexpected.httpErrors.length +
      unexpected.requestFailures.length;
    if (count > 0) {
      throw new Error(
        `unexpected browser noise (${String(count)} entries):\n${JSON.stringify(unexpected, null, 2)}`,
      );
    }
  }
}

let current: NoiseCollector | undefined;

export const test = base.extend<{ noise: NoiseCollector }>({
  browser: [
    // playwright's fixture API mandates an object-destructuring first argument even
    // when the fixture has no dependencies — hence the empty pattern here.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const browser = await launchRealChromium();
      await use(browser);
      await browser.close();
    },
    { scope: 'worker' },
  ],
  noise: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const collector = new NoiseCollector();
      current = collector;
      await use(collector);
    },
    { auto: true },
  ],
  page: async ({ page }, use) => {
    if (current === undefined) throw new Error('noise fixture did not initialize');
    current.attach(page);
    await use(page);
  },
});

export { expect };
