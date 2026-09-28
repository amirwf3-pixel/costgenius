/**
 * §9/§14 — finalized immutability and error UX in the real browser.
 *
 * The 409 path is proven with a REAL stale-UI race: two pages hold the same draft
 * version; page A finalizes; page B (still showing the draft UI) then attempts to
 * add a line and to finalize again — the backend answers the real 409 contract and
 * the UI maps it to the Persian message. No optimistic fake state anywhere.
 */
import { test, expect } from '../fixtures.js';
import { apiCallRaw, arrangeVersion, fillGoldenCoefficients } from '../helpers.js';

test.describe('finalized immutability and error UX', () => {
  test('stale page mutations receive the real 409 and show the Persian message', async ({
    page,
    browser,
    noise,
  }) => {
    const fixture = await arrangeVersion('پروژه 409 — e2e', [
      { pricebookCode: '010101', quantity: '1000', unit: 'm2' },
    ]);

    // page B in its own context (a second real browser tab)
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    noise.attach(pageB);

    await page.goto(`/versions/${fixture.versionId}`);
    await pageB.goto(`/versions/${fixture.versionId}`);
    await expect(page.locator('table').first()).toContainText('010101');
    await expect(pageB.locator('table').first()).toContainText('010101');

    // both pages calculate (the finalize button needs a reviewed calculation);
    // this fixture has a single line, so assert the RESULT BLOCK, not the golden 8-line values
    await fillGoldenCoefficients(pageB);
    await pageB.getByRole('button', { name: 'محاسبه', exact: true }).click();
    await expect(pageB.getByText('جمع کل برآورد')).toBeVisible();

    await fillGoldenCoefficients(page);
    await page.getByRole('button', { name: 'محاسبه', exact: true }).click();
    await expect(page.getByText('جمع کل برآورد')).toBeVisible();

    // page A finalizes (confirm dialog first)
    await page.getByRole('button', { name: 'نهایی‌سازی', exact: true }).click();
    const dialogA = page.getByRole('dialog');
    await expect(dialogA).toContainText('غیرقابل تغییر');
    await dialogA.getByRole('button', { name: 'نهایی‌سازی' }).click();
    await expect(page.getByText('نهایی‌شده', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ افزودن ردیف' })).toHaveCount(0);

    // page B still shows the DRAFT UI — its add-line now hits the real 409
    await pageB.getByRole('button', { name: '+ افزودن ردیف' }).click();
    await pageB.getByLabel('جستجوی کد یا شرح *').fill('010101');
    await pageB.locator('.lookup-item', { hasText: '010101' }).first().click();
    await pageB.getByLabel('مقدار *').fill('1');
    await pageB.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    await expect(
      pageB.getByText('این نسخه نهایی شده و قابل تغییر نیست. برای تغییرات، نسخه جدید ایجاد کنید.'),
    ).toBeVisible();
    await pageB.getByRole('button', { name: 'لغو' }).click();

    // and the duplicate finalize on the stale page hits the same 409 contract
    await pageB.getByRole('button', { name: 'نهایی‌سازی', exact: true }).click();
    const dialogB = pageB.getByRole('dialog');
    await dialogB.getByRole('button', { name: 'نهایی‌سازی' }).click();
    await expect(
      dialogB.getByText(
        'این نسخه نهایی شده و قابل تغییر نیست. برای تغییرات، نسخه جدید ایجاد کنید.',
      ),
    ).toBeVisible();

    // after reload the truth comes from the API: read-only
    await pageB.reload();
    await expect(pageB.getByText('نهایی‌شده', { exact: true })).toBeVisible();
    await expect(pageB.getByRole('button', { name: '+ افزودن ردیف' })).toHaveCount(0);
    await contextB.close();

    // the only tolerated noise: the two intentional 409 responses
    noise.assertClean([/^409 /, '409']);
  });

  test('invalid unit over the API answers the stable error contract (UI cannot send it by design)', async () => {
    const fixture = await arrangeVersion('پروژه 422 — e2e');
    // arrangement AND the contract probe run through the real session mechanism
    const response = await apiCallRaw('POST', `/estimate-versions/${fixture.versionId}/lines`, {
      lines: [{ lineId: 'probe-1', pricebookCode: '280101', quantity: '1', unit: 't' }],
    });
    expect(response.status === 400 || response.status === 422).toBe(true);
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('BOQ_LINES_REJECTED');
    expect(typeof body.error?.message).toBe('string');
  });
});
