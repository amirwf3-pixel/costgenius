/**
 * E2E-01/§14/§15/§16/§17 — empty states on a FRESH database, 404 error UX, RTL/LTR
 * isolation and the accessibility baseline, all in the real browser against the
 * production build.
 */
import { test, expect } from '../fixtures.js';
import { arrangeProject, arrangeVersion } from '../helpers.js';

test.describe('empty states, 404s, RTL and a11y baseline', () => {
  test('projects list shows the real empty state on a fresh database (no fake data)', async ({
    page,
  }) => {
    await page.goto('/projects');
    await expect(page.getByText('هنوز پروژه‌ای وجود ندارد.')).toBeVisible();
    // no fabricated rows anywhere
    await expect(page.locator('table tbody tr')).toHaveCount(0);
  });

  test('unknown project/estimate/version URLs show the retryable error state', async ({ page }) => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const path of [`/projects/${unknown}`, `/estimates/${unknown}`, `/versions/${unknown}`]) {
      await page.goto(path);
      await expect(page.getByText('خطا در دریافت اطلاعات')).toBeVisible();
      await expect(page.getByRole('button', { name: 'تلاش مجدد' })).toBeVisible();
    }
  });

  test('estimate and BOQ empty states on freshly arranged data (real API)', async ({ page }) => {
    // a project WITHOUT any estimate shows the estimates empty state
    const bare = await arrangeProject('پروژه بدون برآورد — e2e');
    await page.goto(`/projects/${bare.projectId}`);
    await expect(page.getByText('هنوز برآوردی برای این پروژه وجود ندارد.')).toBeVisible();

    // a version WITHOUT any lines shows the BOQ empty state
    const fixture = await arrangeVersion('پروژه با نسخه خالی — e2e');
    await page.goto(`/versions/${fixture.versionId}`);
    await expect(page.getByText(/هنوز ردیفی ثبت نشده است/)).toBeVisible();
  });

  test('pricebook lookup shows the no-result state for a nonsense search', async ({ page }) => {
    const fixture = await arrangeVersion('پروژه جستجو — e2e');
    await page.goto(`/versions/${fixture.versionId}`);
    await page.getByRole('button', { name: '+ افزودن ردیف' }).click();
    await page.getByLabel('جستجوی کد یا شرح *').fill('zzzzzz');
    await expect(page.getByText(/ردیفی با این جستجو پیدا نشد/)).toBeVisible({ timeout: 10_000 });
  });

  test('RTL document with LTR-isolated codes; no horizontal page overflow', async ({ page }) => {
    const fixture = await arrangeVersion('پروژه RTL — e2e');
    await page.goto(`/versions/${fixture.versionId}`);
    await page.getByRole('button', { name: '+ افزودن ردیف' }).click();
    await page.getByLabel('جستجوی کد یا شرح *').fill('010101');
    const codeCell = page.locator('.lookup-code .ltr').first();
    await expect(codeCell).toBeVisible({ timeout: 10_000 });

    // document is RTL Persian; technical text inside .ltr is LTR
    const dirs = await page.evaluate(() => ({
      htmlDir: document.documentElement.dir,
      lang: document.documentElement.lang,
      bodyDir: getComputedStyle(document.body).direction,
      codeDir: getComputedStyle(document.querySelector('.lookup-code .ltr') as Element).direction,
      editionDir: getComputedStyle(document.querySelector('.info-grid .ltr') as Element).direction,
    }));
    expect(dirs.htmlDir).toBe('rtl');
    expect(dirs.lang).toBe('fa');
    expect(dirs.bodyDir).toBe('rtl');
    expect(dirs.codeDir).toBe('ltr');
    expect(dirs.editionDir).toBe('ltr');

    // no layout-breaking horizontal overflow of the page itself
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('accessibility baseline: keyboard-opened dialog, labelled inputs, Escape close, disabled state', async ({
    page,
  }) => {
    const fixture = await arrangeVersion('پروژه a11y — e2e');
    await page.goto(`/versions/${fixture.versionId}`);

    // finalize stays disabled until a calculation exists (real disabled, not styling)
    await expect(page.getByRole('button', { name: 'نهایی‌سازی', exact: true })).toBeDisabled();

    // keyboard: focus the add button and activate with Enter
    const addButton = page.getByRole('button', { name: '+ افزودن ردیف' });
    await addButton.focus();
    await expect(addButton).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // inputs are labelled; the dialog itself took focus
    await expect(page.getByLabel('جستجوی کد یا شرح *')).toBeVisible();
    const dialogFocused = await page.evaluate(
      () => document.activeElement?.closest('[role="dialog"]') !== null,
    );
    expect(dialogFocused).toBe(true);

    // Escape closes the dialog and restores focus to the trigger
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(addButton).toBeFocused();
  });
});
