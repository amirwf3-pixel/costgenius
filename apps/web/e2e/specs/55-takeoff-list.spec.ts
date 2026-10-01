/**
 * P7-S1 (CG-FT@0.2.0 §15, D-LIST=B) — the project-scoped takeoff list is the normal
 * discovery path: an empty project shows the empty state → a takeoff created through
 * the UI → return to the project page → the document is listed with its status →
 * open it from the list → the existing workspace behaves exactly as before (create a
 * line, save, and the revision bump is visible). Arrangement happens through the real
 * API; only the list/open behavior is driven through the browser.
 */
import { test, expect } from '../fixtures.js';
import { arrangeProject } from '../helpers.js';

test.describe('P7-S1 project takeoff list', () => {
  test('a created takeoff is discoverable from the project page and opens from the list', async ({
    page,
  }) => {
    const project = await arrangeProject('پروژه فهرست متره — e2e');
    await page.goto(`/projects/${project.projectId}`);
    // the empty state (no fabricated rows)
    await expect(page.getByText('هنوز سند صورت‌برداشتی برای این پروژه وجود ندارد.')).toBeVisible();

    // create the first takeoff through the normal UI path (navigates to the workspace)
    await page.getByRole('button', { name: '+ صورت‌برداشت جدید' }).click();
    await page.getByLabel('عنوان سند *').fill('متره فهرست — e2e');
    await page.getByRole('button', { name: 'ایجاد سند' }).click();
    await expect(page.getByRole('heading', { name: 'متره فهرست — e2e' })).toBeVisible();
    await expect(page.getByText('پیش‌نویس', { exact: true })).toBeVisible();

    // back to the project page (browser back — the breadcrumb goes to the projects list)
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'پروژه فهرست متره — e2e' })).toBeVisible();
    const row = page.locator('li.card', { hasText: 'متره فهرست — e2e' });
    await expect(row).toBeVisible();
    await expect(row.getByText('پیش‌نویس', { exact: true })).toBeVisible();
    // the projection shows chain metadata (document number), never full content
    await expect(row.getByText('سند شمارهٔ')).toBeVisible();

    // open it through the list — the existing workspace behaves exactly as before:
    // a sheet, a dimensional line, and a save that bumps the revision
    await row.getByRole('link', { name: 'متره فهرست — e2e' }).click();
    await expect(page.getByRole('heading', { name: 'متره فهرست — e2e' })).toBeVisible();
    await page.getByRole('button', { name: 'مدیریت برگه‌ها' }).click();
    await page.getByLabel('نام برگهٔ جدید').fill('فونداسیون');
    await page.getByRole('button', { name: '+ افزودن برگه' }).click();
    await page.getByRole('button', { name: 'انجام شد' }).click();
    await expect(page.getByRole('tab', { name: 'فونداسیون (0)' })).toBeVisible();
    await page.getByRole('button', { name: '+ ردیف جدید' }).click();
    await page.getByLabel('شرح ردیف').fill('کندن چاهک فونداسیون');
    await page.getByLabel('کد آیتم').fill('010101');
    await page.getByLabel('طول', { exact: true }).fill('10');
    await page.getByLabel('عرض', { exact: true }).fill('5');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    await expect(page.getByText('کندن چاهک فونداسیون')).toBeVisible();
    await page.getByRole('button', { name: 'ذخیرهٔ تغییرات' }).click();
    await expect(page.getByText('ذخیره شد', { exact: true })).toBeVisible();

    // returning to the project page once more: the same document, still one row
    await page.goBack();
    await expect(page.locator('li.card', { hasText: 'متره فهرست — e2e' })).toHaveCount(1);
  });
});
