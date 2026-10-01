/**
 * P8-B S4 (CG-IR-PRICEBOOK-SPEC@0.2.0 §19 bullet 1) — the editions management page
 * in the real browser, over the REAL API (PGlite + migrations + 1404 dataset):
 *
 *  - the admin sees the page and the seeded 1404 edition with its lifecycle metadata;
 *  - the data_steward imports a staged JSON document through the file picker → the
 *    inline import report → the list refresh shows the new DRAFT; then hits the
 *    four-eyes wall (the server's 403 EDITION_SELF_ACTIVATION_FORBIDDEN renders
 *    inline — the backend is authoritative, the UI never predicts);
 *  - a semantically invalid document is rejected 422 PRICEBOOK_IMPORT_REJECTED → the
 *    structured failures + the «nothing stored, no audit event» guarantee render
 *    inline, no fake success, and the real API confirms nothing was stored;
 *  - the admin activates the steward's import (the three-fact confirmation), the
 *    previous ACTIVE edition auto-archives in the same transaction, then the
 *    0-active-state archive is exercised and the seeded 1404 edition is re-activated
 *    (ARCHIVED→ACTIVE has no four-eyes rule — §8) to restore the shared baseline;
 *  - the estimator never sees the navigation entry; the direct URL is the read-only
 *    list (no mutation controls) — the role gating is UX, the API is the boundary.
 *
 * The intentional 4xx answers (four-eyes 403, import 422) and the anonymous-session
 * 401s of the fresh-context logins are the documented noise allowances below.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures.js';
import { NoiseCollector } from '../fixtures.js';
import { apiCall } from '../helpers.js';

/** Deterministic TEST-ONLY credentials of this spec's dedicated users. */
const STEWARD = { username: 'e2e-pb-steward', password: 'e2e-pb-steward-password-123' };
const ESTIMATOR = { username: 'e2e-pb-estimator', password: 'e2e-pb-estimator-password-123' };

/** The seeded 1404 edition — the card this spec must leave ACTIVE again at the end. */
const SEEDED_TITLE = 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴ (1404)';
const SYNTHETIC_TITLE = 'فهرست آزمونی رشته ابنیه (1411)';

/** A unique-per-run synthetic staged document (passes the same gate as the 1404 seed). */
function syntheticStagedFile(tag: string, basePrice = '2890'): Record<string, unknown> {
  return {
    formatVersion: '1',
    kind: 'staged-import',
    edition: {
      id: `ir-14rg-abniye-${tag}`,
      title: 'فهرست آزمونی رشته ابنیه',
      organization: 'سازمان برنامه و بودجه کشور',
      year: '1411',
      notificationNumber: null,
      notificationDate: null,
      sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
    },
    rows: [
      {
        code: '010101',
        chapter: 'chapter-1',
        group: '1',
        description: `شرح آزمون ${tag}`,
        unit: { label: 'مترمربع', code: 'm2' },
        basePrice,
        status: 'VERIFIED_SPEC_ONLY',
        sourceRef: {
          sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
          edition: '1404',
          printedPage: '11',
          section: 'Chapter 1, Group 1',
          sourceFileHash: 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f',
        },
      },
    ],
  };
}

/** The unique tag of this run's synthetic edition (shared by the serial tests). */
const tag = `e2e${Date.now().toString(36)}`;
const syntheticEditionId = `ir-14rg-abniye-${tag}`;

/** Logs a fresh anonymous context in through the REAL login page. */
async function loginAs(
  browser: Browser,
  credentials: { username: string; password: string },
): Promise<{ context: BrowserContext; page: Page; noise: NoiseCollector }> {
  const noise = new NoiseCollector();
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  noise.attach(page);
  await page.goto('/projects');
  await page.getByLabel('نام کاربری').fill(credentials.username);
  await page.getByLabel('گذرواژه').fill(credentials.password);
  await page.getByRole('button', { name: 'ورود' }).click();
  await expect(page.getByRole('heading', { name: 'پروژه‌ها' })).toBeVisible();
  return { context, page, noise };
}

test.describe('P8-B S4 editions management UI (steward import, four-eyes, admin lifecycle)', () => {
  test.describe.configure({ mode: 'serial' });

  test('setup — the admin creates this spec’s steward and estimator through the real API', async () => {
    for (const [role, user] of [
      ['data_steward', STEWARD],
      ['estimator', ESTIMATOR],
    ] as const) {
      const created = await apiCall<{ userId: string }>('POST', '/users', {
        username: user.username,
        password: user.password,
        role,
      });
      expect(created.userId).toBeTruthy();
    }
  });

  test('admin — the page lists the seeded 1404 edition with its lifecycle metadata', async ({
    page,
    noise,
  }) => {
    await page.goto('/pricebook/editions');
    await expect(page.getByRole('heading', { name: 'فهرست‌بهاها', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'فهرست‌بهاها' })).toBeVisible();

    const seededCard = page.locator('li.card', { hasText: SEEDED_TITLE });
    await expect(seededCard).toBeVisible();
    await expect(seededCard.getByText('جاری (فعال)')).toBeVisible(); // status badge
    await expect(seededCard.getByText('742948')).toBeVisible(); // circular number
    await expect(seededCard.getByText('1564')).toBeVisible(); // rowCount
    await expect(seededCard.getByText('اثر انگشت محتوا')).toBeVisible(); // short contentHash
    // the ACTIVE edition offers no activation, only the archive command
    await expect(seededCard.getByRole('button', { name: 'فعال‌سازی' })).toHaveCount(0);
    await expect(seededCard.getByRole('button', { name: 'بایگانی' })).toBeVisible();

    noise.assertClean();
  });

  test('steward — imports a staged file (inline report), then hits the four-eyes wall', async ({
    browser,
  }) => {
    const { context, page, noise } = await loginAs(browser, STEWARD);

    // the navigation entry is visible for the data_steward
    await expect(page.getByRole('link', { name: 'فهرست‌بهاها' })).toBeVisible();
    await page.getByRole('link', { name: 'فهرست‌بهاها' }).click();
    await expect(page.getByRole('heading', { name: 'فهرست‌بهاها', level: 1 })).toBeVisible();

    // import through the file picker → the inline import report of the 201 answer
    await page.getByRole('button', { name: '+ درون‌ریزی فهرست‌بها' }).click();
    const dialog = page.getByRole('dialog', { name: 'درون‌ریزی فهرست‌بها' });
    await expect(dialog.getByRole('button', { name: 'درون‌ریزی' })).toBeDisabled();
    await dialog.getByLabel('پروندهٔ سند پلکانی فهرست‌بها').setInputFiles({
      name: 'staged.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(syntheticStagedFile(tag)), 'utf8'),
    });
    await dialog.getByRole('button', { name: 'درون‌ریزی' }).click();
    const report = dialog.getByLabel('گزارش درون‌ریزی');
    await expect(report).toBeVisible();
    await expect(report).toContainText('درون‌ریزی پذیرفته شد');
    await expect(report).toContainText(syntheticEditionId);
    await expect(report).toContainText('1'); // rowCount
    await expect(report).toContainText('پیش‌نویس'); // nothing is auto-activated

    // refresh → the new DRAFT card
    await dialog.getByRole('button', { name: 'نوسازی فهرست' }).click();
    const draftCard = page.locator('li.card', { hasText: SYNTHETIC_TITLE });
    await expect(draftCard.getByText('پیش‌نویس')).toBeVisible();

    // the steward tries to activate their own import → the server's four-eyes 403
    await draftCard.getByRole('button', { name: 'فعال‌سازی' }).click();
    const confirm = page.getByRole('dialog', { name: 'فعال‌سازی فهرست‌بها' });
    await expect(confirm).toContainText('این فهرست‌بها جاری (فعال) می‌شود.');
    await expect(confirm).toContainText('فهرست‌بهای جاری قبلی (در صورت وجود) بایگانی خواهد شد.');
    await expect(confirm).toContainText(
      'نسخه‌های جدید برآورد از این پس به‌طور پیش‌فرض به همین فهرست‌بها',
    );
    await confirm.getByRole('button', { name: 'فعال‌سازی', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('four-eyes rule');
    // nothing changed: the card is still a DRAFT (no fake success, no refresh)
    await expect(draftCard.getByText('پیش‌نویس')).toBeVisible();

    await context.close();
    noise.assertClean([
      /401 .*\/auth\/session$/,
      'status of 401',
      /403 .*\/pricebook\/editions\/.+\/activate$/,
      'status of 403', // the browser console line of the intentional four-eyes denial
    ]);
  });

  test('steward — a rejected import renders the structured failures inline; nothing is stored', async ({
    browser,
  }) => {
    const { context, page, noise } = await loginAs(browser, STEWARD);
    await page.goto('/pricebook/editions');
    const editionsBefore = (
      await apiCall<{ editions: { editionId: string }[] }>('GET', '/pricebook/editions')
    ).editions.length;

    // a semantically invalid staged document (a non-decimal base price)
    await page.getByRole('button', { name: '+ درون‌ریزی فهرست‌بها' }).click();
    const dialog = page.getByRole('dialog', { name: 'درون‌ریزی فهرست‌بها' });
    await dialog.getByLabel('پروندهٔ سند پلکانی فهرست‌بها').setInputFiles({
      name: 'staged.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify(syntheticStagedFile(`${tag}-bad`, 'not-a-decimal')),
        'utf8',
      ),
    });
    await dialog.getByRole('button', { name: 'درون‌ریزی' }).click();

    // the 422 answer's structured failures + the guarantee, verbatim — never a fake success
    const failures = dialog.getByLabel('خطاهای اعتبارسنجی درون‌ریزی');
    await expect(failures).toBeVisible();
    await expect(failures).toContainText('هیچ چیزی ذخیره نشد و هیچ رویداد حسابرسی ثبت نشد');
    await expect(failures).toContainText('INVALID_ROW');
    await expect(dialog.getByRole('button', { name: 'نوسازی فهرست' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'انصراف' })).toBeVisible();
    await dialog.getByRole('button', { name: 'انصراف' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // the real API confirms nothing was stored and no fake card appeared
    const editionsAfter = (
      await apiCall<{ editions: { editionId: string }[] }>('GET', '/pricebook/editions')
    ).editions.length;
    expect(editionsAfter).toBe(editionsBefore);
    await expect(page.locator('li.card', { hasText: `شرح آزمون ${tag}-bad` })).toHaveCount(0);

    await context.close();
    // 'status of 422' — the browser console line of the intentional import rejection
    noise.assertClean([
      /401 .*\/auth\/session$/,
      'status of 401',
      /422 .*\/pricebook\/editions$/,
      'status of 422',
    ]);
  });

  test('admin — activates the steward’s import (previous ACTIVE auto-archives), then restores the baseline', async ({
    page,
    noise,
  }) => {
    await page.goto('/pricebook/editions');
    const draftCard = page.locator('li.card', { hasText: SYNTHETIC_TITLE });
    await draftCard.getByRole('button', { name: 'فعال‌سازی' }).click();

    // the three §19 facts are stated before the call
    const confirm = page.getByRole('dialog', { name: 'فعال‌سازی فهرست‌بها' });
    await expect(confirm).toContainText('این فهرست‌بها جاری (فعال) می‌شود.');
    await expect(confirm).toContainText('فهرست‌بهای جاری قبلی (در صورت وجود) بایگانی خواهد شد.');
    await confirm.getByRole('button', { name: 'فعال‌سازی', exact: true }).click();

    // the result: the new edition is ACTIVE and the seeded 1404 auto-archived with it
    await expect(page.getByText(/فعال شد/)).toBeVisible();
    await expect(draftCard.getByText('جاری (فعال)')).toBeVisible();
    const seededCard = page.locator('li.card', { hasText: SEEDED_TITLE });
    await expect(seededCard.getByText('بایگانی‌شده')).toBeVisible();

    // the 0-active-state archive (D-PB-4 = A): the warning is stated up front
    await draftCard.getByRole('button', { name: 'بایگانی' }).click();
    const archiveConfirm = page.getByRole('dialog', { name: 'بایگانی فهرست‌بها' });
    await expect(archiveConfirm).toContainText('بدون فهرست‌بهای فعال');
    await archiveConfirm.getByRole('button', { name: 'بایگانی', exact: true }).click();
    await expect(page.getByText(/بایگانی شد/)).toBeVisible();
    await expect(draftCard.getByText('بایگانی‌شده')).toBeVisible();

    // restore the shared baseline: the seeded 1404 becomes ACTIVE again
    // (ARCHIVED→ACTIVE re-activates audited content — §8, no four-eyes rule there)
    await seededCard.getByRole('button', { name: 'فعال‌سازی' }).click();
    const restoreConfirm = page.getByRole('dialog', { name: 'فعال‌سازی فهرست‌بها' });
    await restoreConfirm.getByRole('button', { name: 'فعال‌سازی', exact: true }).click();
    await expect(seededCard.getByText('جاری (فعال)')).toBeVisible();

    noise.assertClean();
  });

  test('estimator — the navigation entry is hidden; the direct URL is the read-only list', async ({
    browser,
  }) => {
    const { context, page, noise } = await loginAs(browser, ESTIMATOR);

    await expect(page.getByRole('link', { name: 'فهرست‌بهاها' })).toHaveCount(0);

    // the page itself renders (GET #39 is Viewer+) — with zero mutation controls
    await page.goto('/pricebook/editions');
    await expect(page.getByRole('heading', { name: 'فهرست‌بهاها', level: 1 })).toBeVisible();
    await expect(page.locator('li.card', { hasText: SEEDED_TITLE })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ درون‌ریزی فهرست‌بها' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'فعال‌سازی' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'بایگانی' })).toHaveCount(0);

    await context.close();
    noise.assertClean([/401 .*\/auth\/session$/, 'status of 401']);
  });
});
