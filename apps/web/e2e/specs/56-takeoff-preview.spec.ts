/**
 * P7-S2 (CG-FT@0.2.0 §16 + §12.2, D-PREVIEW=B/D-ERROR=C) — the stateless draft
 * calculation preview in the real browser: build a valid draft → save → preview → the
 * exact engine result renders (same math finalization produces) → break the document
 * semantically (a reference to a missing line) → save → preview again → the STRUCTURED
 * failure (422 TAKEOFF_SOLUTION_REJECTED, details.failures) renders as Persian hints →
 * the document is still editable → repair → finalize behaves exactly as before
 * (its own TAKEOFF_CALCULATION_FAILED contract is exercised by spec 50; here the happy
 * finalize proves the preview consumed nothing). The preview 422 is allow-listed.
 */
import { test, expect } from '../fixtures.js';
import { arrangeProject } from '../helpers.js';

test.describe('P7-S2 stateless draft calculation preview', () => {
  test('preview shows the engine result, structured failures, and never mutates the draft', async ({
    page,
    noise,
  }) => {
    const project = await arrangeProject('پروژه پیش‌نمایش محاسبه — e2e');
    await page.goto(`/projects/${project.projectId}`);
    await page.getByRole('button', { name: '+ صورت‌برداشت جدید' }).click();
    await page.getByLabel('عنوان سند *').fill('متره پیش‌نمایش — e2e');
    await page.getByRole('button', { name: 'ایجاد سند' }).click();
    await expect(page.getByRole('heading', { name: 'متره پیش‌نمایش — e2e' })).toBeVisible();

    // (1) a valid draft: one dimensional line 2×10×5 = 100 on item 010101
    await page.getByRole('button', { name: 'مدیریت برگه‌ها' }).click();
    await page.getByLabel('نام برگهٔ جدید').fill('فونداسیون');
    await page.getByRole('button', { name: '+ افزودن برگه' }).click();
    await page.getByRole('button', { name: 'انجام شد' }).click();
    await page.getByRole('button', { name: '+ ردیف جدید' }).click();
    await page.getByLabel('شرح ردیف').fill('بستن قالب فونداسیون');
    await page.getByLabel('کد آیتم').fill('010101');
    await page.getByLabel('تعداد طبقات').fill('2');
    await page.getByLabel('طول', { exact: true }).fill('10');
    await page.getByLabel('عرض', { exact: true }).fill('5');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    await expect(page.getByText('ابعادی (2 × 10 × 5)')).toBeVisible();
    await page.getByRole('button', { name: 'ذخیرهٔ تغییرات' }).click();
    await expect(page.getByText('ذخیره شد', { exact: true })).toBeVisible();

    // (2) preview: the exact engine result — 100, rendered from the server's answer
    await page.getByRole('button', { name: 'پیش‌نمایش محاسبه' }).click();
    await expect(page.getByText('جمع آیتم‌ها (بر پایهٔ کد)')).toBeVisible();
    const previewRow = page.locator('tr', { hasText: '010101' }).first();
    await expect(previewRow).toContainText('100');
    await expect(page.getByText(/نتیجهٔ پیش‌نمایش محاسبه است/)).toBeVisible();
    // the draft is untouched: still a draft, not dirty (the chip shows the last save
    // state — «ذخیره شد»), still editable
    await expect(page.getByText('تغییرات ذخیره‌نشده')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '+ ردیف جدید' })).toBeVisible();

    // (3) add a reference line to L1 (the referenced dimensional line), then save
    await page.getByRole('button', { name: '+ ردیف جدید' }).click();
    await page.getByLabel('شرح ردیف').fill('مانند ردیف قالب');
    await page.getByRole('combobox', { name: 'نوع مقدار' }).selectOption('reference');
    await page.getByLabel('ردیف مرجع جملهٔ 1').selectOption('L1');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    await expect(page.getByText('ارجاع (1 × #L1)')).toBeVisible();
    await page.getByRole('button', { name: 'ذخیرهٔ تغییرات' }).click();
    await expect(page.getByText('ذخیره شد', { exact: true })).toBeVisible();

    // (4) break it semantically: delete the REFERENCED line L1 — the UI warns that the
    // reference becomes dangling and finalization would be rejected, and allows it
    const sourceRow = page.locator('tr', { hasText: 'بستن قالب فونداسیون' }).first();
    await sourceRow.getByRole('button', { name: 'حذف' }).click();
    await expect(page.getByText(/به این ردیف ارجاع می‌دهند/)).toBeVisible();
    await page.getByRole('button', { name: 'حذف ردیف', exact: true }).click();
    // L1 is gone; the reference line REMAINS with its (now dangling) formula display
    await expect(page.locator('tr', { hasText: 'بستن قالب فونداسیون' })).toHaveCount(0);
    await expect(page.getByText('ارجاع (1 × #L1)')).toBeVisible();
    await page.getByRole('button', { name: 'ذخیرهٔ تغییرات' }).click();
    await expect(page.getByText('ذخیره شد', { exact: true })).toBeVisible();

    // (5) preview again: the structured 422 renders as the Persian hint, not raw codes
    await page.getByRole('button', { name: 'پیش‌نمایش محاسبه' }).click();
    await expect(page.getByText(/پیش‌نمایش محاسبهٔ صورت‌برداشت رد شد/)).toBeVisible();
    await expect(page.getByText('مرجع انتخاب‌شده وجود ندارد.')).toBeVisible();
    await expect(page.getByText('UNKNOWN_REFERENCE')).toHaveCount(0); // never raw engine codes
    // the previous successful result is gone — a failed preview renders no numbers
    await expect(page.locator('tr', { hasText: '010101' })).toHaveCount(0);

    // (6) the document remains editable: repair — remove the dangling reference line
    // and re-add the dimensional line it used to mirror
    const brokenRow = page.locator('tr', { hasText: 'مانند ردیف قالب' }).first();
    await brokenRow.getByRole('button', { name: 'حذف' }).click();
    await page.getByRole('button', { name: 'حذف ردیف', exact: true }).click();
    await page.getByRole('button', { name: '+ ردیف جدید' }).click();
    await page.getByLabel('شرح ردیف').fill('بستن قالب فونداسیون');
    await page.getByLabel('کد آیتم').fill('010101');
    await page.getByLabel('تعداد طبقات').fill('2');
    await page.getByLabel('طول', { exact: true }).fill('10');
    await page.getByLabel('عرض', { exact: true }).fill('5');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    await expect(page.getByText('ابعادی (2 × 10 × 5)')).toBeVisible();
    await page.getByRole('button', { name: 'ذخیرهٔ تغییرات' }).click();
    await expect(page.getByText('ذخیره شد', { exact: true })).toBeVisible();

    // (7) preview succeeds again after the repair — same exact math as before
    await page.getByRole('button', { name: 'پیش‌نمایش محاسبه' }).click();
    await expect(page.getByText('جمع آیتم‌ها (بر پایهٔ کد)')).toBeVisible();
    await expect(page.locator('tr', { hasText: '010101' }).first()).toContainText('100');

    // (8) finalize behaves exactly as before — the preview consumed nothing
    await page.getByRole('button', { name: 'نهایی‌سازی' }).click();
    await page.getByRole('button', { name: 'نهایی‌سازی قطعی' }).click();
    await expect(page.getByText('نهایی‌شده', { exact: true })).toBeVisible();
    const finalizedRow = page.locator('tr', { hasText: '010101' }).first();
    await expect(finalizedRow).toContainText('100');
    await expect(page.getByRole('button', { name: '+ ردیف جدید' })).toHaveCount(0);

    // the single intentional 4xx (the failed preview) is allow-listed; everything else
    // must be noise-free
    noise.assertClean([/^422 /, 'status of 422']);
  });
});
