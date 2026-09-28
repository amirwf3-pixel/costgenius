/**
 * E2E-06 (D-015/D6-B) — dimensional entry in the real browser: the add-line dialog's
 * متره‌ای mode computes NOTHING client-side. The preview comes from the stateless S1
 * endpoint, the COMMIT payload carries ONLY the factors (captured from the real
 * request), and the quantity that lands in the BOQ table is the server's own
 * computation. Also pinned: the D2-A rule that a negative manual quantity is rejected
 * in the dialog, and that non-S1 units stay manual-only.
 */
import { test, expect } from '../fixtures.js';
import { arrangeVersion } from '../helpers.js';

test.describe('dimensional entry (D-015/D6-B)', () => {
  test('متره‌ای: preview shows the exact S1 quantity and commit sends ONLY the factors', async ({
    page,
    noise,
  }) => {
    const fixture = await arrangeVersion('پروژه متره‌ای — e2e');
    await page.goto(`/versions/${fixture.versionId}`);
    await page.getByRole('button', { name: '+ افزودن ردیف' }).click();

    // select the golden m2 row
    await page.getByLabel('جستجوی کد یا شرح *').fill('010101');
    const row = page.locator('.lookup-item', { hasText: '010101' }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await expect(page.getByText(/ردیف انتخابی:/)).toContainText('010101');

    // capture the REAL add-lines commit payload for the factors-only proof
    let captured: Record<string, unknown> | undefined;
    page.on('request', (request) => {
      if (request.url().includes(`/estimate-versions/${fixture.versionId}/lines`)) {
        const body = JSON.parse(request.postData() ?? '{}') as { lines?: unknown[] };
        const line = body.lines?.[0] as Record<string, unknown> | undefined;
        if (line !== undefined) captured = line;
      }
    });

    // switch to dimensional entry (m2 → count × length × width)
    await page.getByLabel('روش ورود *').selectOption('dimensional');
    await page.getByLabel('تعداد *').fill('4');
    await page.getByLabel('طول (متر) *').fill('2.5');
    await page.getByLabel('عرض (متر) *').fill('2');
    await page.getByRole('button', { name: 'محاسبهٔ مقدار' }).click();

    // the preview shows the exact quantity (20 m2) with the engine versions — S1 0.1.0
    const preview = page.getByTestId('takeoff-preview');
    await expect(preview).toBeVisible({ timeout: 10_000 });
    await expect(preview).toContainText('20');
    await expect(preview).toContainText('0.1.0');

    // commit: the payload carries the factors and NEVER a client-computed quantity
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    expect(captured).toBeDefined();
    expect(captured?.['pricebookCode']).toBe('010101');
    expect(captured?.['unit']).toBe('m2');
    expect(captured?.['takeoff']).toEqual({
      kind: 'addition',
      unit: 'm2',
      count: '4',
      length: '2.5',
      width: '2',
    });
    expect('quantity' in (captured ?? {})).toBe(false);

    // the BOQ shows the SERVER-computed quantity: 20 × 2,890 = 57,800
    await expect(page.locator('table').first()).toContainText('57,800');
    noise.assertClean();
  });

  test('a negative manual quantity is rejected in the dialog (D2-A: deduction = کسر بها row)', async ({
    page,
  }) => {
    const fixture = await arrangeVersion('پروژه منفی — e2e');
    await page.goto(`/versions/${fixture.versionId}`);
    await page.getByRole('button', { name: '+ افزودن ردیف' }).click();

    await page.getByLabel('جستجوی کد یا شرح *').fill('010101');
    const row = page.locator('.lookup-item', { hasText: '010101' }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await page.getByLabel('مقدار *').fill('-5');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();

    // the dialog stays open with the actionable Persian message; nothing is submitted
    await expect(page.getByText(/نامنفی/)).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('non-S1 units (kg) stay manual-only — the متره‌ای option is disabled', async ({ page }) => {
    const fixture = await arrangeVersion('پروژه kg — e2e');
    await page.goto(`/versions/${fixture.versionId}`);
    await page.getByRole('button', { name: '+ افزودن ردیف' }).click();

    await page.getByLabel('جستجوی کد یا شرح *').fill('090320');
    const row = page.locator('.lookup-item', { hasText: '090320' }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();

    const dimensionalOption = page.locator('option', { hasText: 'متره‌ای (محاسبه از ابعاد)' });
    await expect(dimensionalOption).toHaveAttribute('disabled');
    // the manual quantity field remains the active path
    await expect(page.getByLabel('مقدار *')).toBeVisible();
  });
});
