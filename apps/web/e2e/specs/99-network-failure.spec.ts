/**
 * §14 — network failure: the API process is REALLY stopped (SIGTERM to the managed
 * backend), then the browser must show the unreachable error state with a retry
 * button — no stuck spinner, no invented data. Runs last (alphabetical order, single
 * worker): after this spec the API stays down for the rest of the run.
 */
import { test, expect } from '../fixtures.js';

test.describe('network failure UX', () => {
  test('API down → error state, retry, no fake data, no stuck spinner', async ({ page, noise }) => {
    const pid = Number(process.env['COSTGENIUS_E2E_API_PID']);
    test.skip(!Number.isInteger(pid) || pid <= 0, 'API pid not exposed by the global setup');

    process.kill(pid, 'SIGTERM');
    // wait until the API is really gone
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await fetch(`${process.env['COSTGENIUS_E2E_API_URL'] ?? 'http://127.0.0.1:3101'}/health`, {
          signal: AbortSignal.timeout(1000),
        });
      } catch {
        break;
      }
      if (Date.now() > deadline) throw new Error('API did not stop');
      await new Promise((r) => {
        setTimeout(r, 250);
      });
    }

    await page.goto('/projects');
    await expect(page.getByText('CostGenius API در دسترس نیست.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'تلاش مجدد' })).toBeVisible();
    // no invented rows and no permanent spinner
    await expect(page.locator('table tbody tr')).toHaveCount(0);
    await expect(page.locator('.spinner')).toHaveCount(0);

    // the expected evidence of the dead API is tolerated noise (and nothing else):
    // the preview proxy answers 500 while the API process is down
    noise.assertClean(['net::ERR', 'Failed to load resource', 'ECONNREFUSED', /^5\d\d /, '500']);
  });
});
