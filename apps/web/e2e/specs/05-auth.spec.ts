/**
 * P8-A S1 (CG-GOV-SPEC@0.1.0 §1) — the REAL authentication UX in a real browser:
 * the app gates every route behind the session (401 → login page), a wrong password
 * shows the uniform Persian message (never an enumeration hint), a correct login
 * enters the app, the current user is displayed, and logout returns to the login
 * page. This spec deliberately opts OUT of the shared storage state — it is the only
 * spec that starts unauthenticated.
 */
import { test, expect } from '../fixtures.js';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('P8-A S1 authentication', () => {
  test('gate → wrong password (uniform 401) → login → app → logout → gate again', async ({
    page,
    noise,
  }) => {
    // (1) unauthenticated: any route shows the login page, not app content
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'ورود به CostGenius' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'ناوبری اصلی' })).toHaveCount(0);

    // (2) empty submission is rejected client-side — no HTTP call
    await page.getByRole('button', { name: 'ورود' }).click();
    await expect(page.getByText('نام کاربری و گذرواژه را وارد کنید.')).toBeVisible();

    // (3) wrong password → the ONE uniform message (no username/password distinction)
    await page.getByLabel('نام کاربری').fill('admin');
    await page.getByLabel('گذرواژه').fill('definitely-wrong');
    await page.getByRole('button', { name: 'ورود' }).click();
    await expect(page.getByText('نام کاربری یا گذرواژه نادرست است.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ورود به CostGenius' })).toBeVisible();

    // (4) correct credentials → the app loads with the current user displayed
    await page.getByLabel('گذرواژه').fill('e2e-password-123');
    await page.getByRole('button', { name: 'ورود' }).click();
    await expect(page.getByRole('navigation', { name: 'ناوبری اصلی' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'پروژه‌ها' })).toBeVisible();
    await expect(page.getByText('کاربر: admin')).toBeVisible();

    // (5) logout → back to the gate; the session is gone for real
    await page.getByRole('button', { name: 'خروج' }).click();
    await expect(page.getByRole('heading', { name: 'ورود به CostGenius' })).toBeVisible();
    await expect(page.getByText('نشست شما پایان یافت.')).toBeVisible();
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'ورود به CostGenius' })).toBeVisible();

    // intentional 401s: the wrong-password login attempt and the session-gate probes
    // of the unauthenticated page loads (the gate design, CG-GOV §1.6)
    noise.assertClean([/401 .*\/auth\/(login|session)$/, 'status of 401']);
  });
});
