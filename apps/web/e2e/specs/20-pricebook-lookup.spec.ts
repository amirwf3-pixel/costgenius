/**
 * E2E-03 — pricebook lookup in the real browser: code search, description search,
 * unit and price display, and the proof that the SUBMITTED line is the SELECTED API
 * row (code + unit captured from the actual request payload), never free text.
 */
import { test, expect } from '../fixtures.js';
import { arrangeVersion } from '../helpers.js';

test.describe('pricebook lookup (§4 E2E-03)', () => {
  test('code search finds the golden row with unit and price from the API', async ({ page }) => {
    const fixture = await arrangeVersion('پروژه lookup — e2e');
    await page.goto(`/versions/${fixture.versionId}`);
    await page.getByRole('button', { name: '+ افزودن ردیف' }).click();

    await page.getByLabel('جستجوی کد یا شرح *').fill('010101');
    const row = page.locator('.lookup-item', { hasText: '010101' }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    // unit label and the exact price come from the API row
    await expect(row.getByText('مترمربع')).toBeVisible();
    await expect(row.getByText('2,890')).toBeVisible();
  });

  test('description search finds the row and the submitted code is the API row, not the typed text', async ({
    page,
    noise,
  }) => {
    const fixture = await arrangeVersion('پروژه lookup2 — e2e');
    await page.goto(`/versions/${fixture.versionId}`);
    await page.getByRole('button', { name: '+ افزودن ردیف' }).click();

    // capture the REAL add-lines request payload for the binding proof
    let captured: { pricebookCode?: unknown; unit?: unknown; quantity?: unknown } | undefined;
    page.on('request', (request) => {
      if (request.url().includes(`/estimate-versions/${fixture.versionId}/lines`)) {
        const body = JSON.parse(request.postData() ?? '{}') as { lines?: unknown[] };
        const line = body.lines?.[0] as Record<string, unknown> | undefined;
        if (line !== undefined) captured = line;
      }
    });

    // search by DESCRIPTION — the typed text is a Persian phrase, not a code
    await page.getByLabel('جستجوی کد یا شرح *').fill('ماسه نرم');
    const row = page.locator('.lookup-item', { hasText: '220925' }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await expect(page.getByText(/ردیف انتخابی:/)).toContainText('220925');

    await page.getByLabel('مقدار *').fill('40');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();

    // the BOQ now carries the row with the API's exact code and unit
    await expect(page.locator('table').first()).toContainText('220925');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    // binding proof: submitted code/unit are the selected API row's values
    expect(captured).toBeDefined();
    expect(captured?.pricebookCode).toBe('220925');
    expect(captured?.unit).toBe('m2');
    expect(captured?.quantity).toBe('40');
    noise.assertClean();
  });

  test('invalid quantity is rejected client-side with a Persian message and no request', async ({
    page,
    noise,
  }) => {
    const fixture = await arrangeVersion('پروژه lookup3 — e2e');
    await page.goto(`/versions/${fixture.versionId}`);
    await page.getByRole('button', { name: '+ افزودن ردیف' }).click();

    let linesRequestSeen = false;
    page.on('request', (request) => {
      if (request.url().endsWith(`/estimate-versions/${fixture.versionId}/lines`)) {
        linesRequestSeen = true;
      }
    });

    await page.getByLabel('جستجوی کد یا شرح *').fill('010101');
    await page.locator('.lookup-item', { hasText: '010101' }).first().click();
    await page.getByLabel('مقدار *').fill('12.5.6');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    // D-015/D2-A (owner-approved re-baseline): the copy now also states non-negativity —
    // a negative quantity is rejected client-side; a deduction is a کسر بها row.
    await expect(
      page.getByText(
        'مقدار باید یک عدد اعشاری دقیق نامنفی باشد (مثلاً 1000 یا 12.5). کسر بها با ردیف مخصوص آن (مثل 010517) ثبت می‌شود، نه با مقدار منفی.',
      ),
    ).toBeVisible();
    expect(linesRequestSeen).toBe(false);

    // submit without selecting any row is also blocked (free text never becomes a code)
    await page.getByRole('button', { name: 'لغو' }).click();
    await page.getByRole('button', { name: '+ افزودن ردیف' }).click();
    await page.getByLabel('جستجوی کد یا شرح *').fill('010101');
    await page.locator('.lookup-item', { hasText: '010101' }).first().waitFor();
    await page.getByLabel('مقدار *').fill('1');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    await expect(
      page.getByText(/ابتدا یک ردیف فهرست‌بها را از نتایج جستجو انتخاب کنید/),
    ).toBeVisible();
    noise.assertClean();
  });
});
