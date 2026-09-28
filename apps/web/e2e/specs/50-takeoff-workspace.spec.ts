/**
 * §27 (D-016 Phase 5 + Phase 6) — THE full takeoff lifecycle, 21 steps, entirely through
 * the real browser against the production build and the real API on PGlite:
 * create → sheets → dimensional/manual/reference lines → design rounding rule →
 * save (revision replaced) → archive → unarchive → finalize (engine result) →
 * follow-up (stable lineIds, server-issued number) → back to the finalized document →
 * PDF report download (real %PDF bytes) → Excel report download (zip read-back: exact /
 * rounded / effective + «بدون کد») → takeoff unchanged after both downloads →
 * transfer to BOQ (transferred + skipped) → BOQ row provenance → repeat transfer (exact
 * ALREADY_TRANSFERRED 422) → concurrent edit (exact 409 conflict message + نسخهٔ جدید).
 *
 * The two intentional 4xx responses (409 save conflict, 422 repeat transfer) are
 * allow-listed below and documented — everything else must be noise-free.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Download } from '@playwright/test';
import { test, expect } from '../fixtures.js';
import { apiCall } from '../helpers.js';

async function saveDownload(download: Download, name: string): Promise<Buffer> {
  const path = join(tmpdir(), `costgenius-e2e-${name}`);
  await download.saveAs(path);
  return await readFile(path);
}

/**
 * Minimal ZIP entry reader (store + deflate) — lets the E2E verify the downloaded
 * workbook's content without adding a dependency. Returns the raw entry bytes.
 */
function readZipEntry(zip: Buffer, entryName: string): Buffer {
  // locate the End Of Central Directory record (scan backwards for its signature)
  let eocd = -1;
  for (let i = zip.byteLength - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip EOCD not found');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8');
    if (name === entryName) {
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip method ${String(method)}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip entry not found: ${entryName}`);
}

/**
 * Allow-list for the two INTENTIONAL 4xx responses of this spec (documented):
 * the 409 save conflict (step 18) and the 422 repeat transfer (step 17) — both the
 * HTTP response itself and Chromium's console line for a failed resource load.
 */
const INTENTIONAL_4XX = [
  /409 .*\/takeoffs\/.+\/save$/,
  'status of 409',
  /422 .*\/takeoffs\/.+\/transfer-to-boq$/,
  'status of 422',
];

test.describe('full takeoff workspace (D-016 Phase 5)', () => {
  test('۲۱ گام کامل: ساخت تا انتقال به برآورد + گزارش‌ها + تعارض همزمانی', async ({
    page,
    noise,
  }) => {
    // (1) پروژهٔ واقعی از طریق API (آرایش) + برآورد/نسخهٔ پیش‌نویس «همان پروژه» برای انتقال
    const project = await apiCall<{ projectId: string }>('POST', '/projects', {
      projectId: crypto.randomUUID(),
      title: 'پروژهٔ صورت‌برداشت e2e',
    });
    const targetEstimate = await apiCall<{ estimateId: string }>(
      'POST',
      `/projects/${project.projectId}/estimates`,
      { estimateId: crypto.randomUUID(), title: 'برآورد انتقال متره' },
    );
    const targetVersion = await apiCall<{ versionId: string }>(
      'POST',
      `/estimates/${targetEstimate.estimateId}/versions`,
      { buildingId: 'building-main', versionId: crypto.randomUUID() },
    );

    // (2) ساخت سند صورت‌برداشت از رابط کاربری و ورود به میزکار
    await page.goto(`/projects/${project.projectId}`);
    await page.getByRole('button', { name: '+ صورت‌برداشت جدید' }).click();
    await page.getByLabel('عنوان سند *').fill('متره مرحله اول — e2e');
    await page.getByRole('button', { name: 'ایجاد سند' }).click();
    await expect(page.getByRole('heading', { name: 'متره مرحله اول — e2e' })).toBeVisible();
    await expect(page.getByText('پیش‌نویس', { exact: true })).toBeVisible();
    await expect(page.getByText('بدون تغییر', { exact: true })).toBeVisible();
    const documentId = new URL(page.url()).pathname.split('/').pop() ?? '';

    // (3) مدیریت برگه‌ها: افزودن برگهٔ «فونداسیون» (سند جدید بدون برگه شروع می‌شود)
    await page.getByRole('button', { name: 'مدیریت برگه‌ها' }).click();
    await page.getByLabel('نام برگهٔ جدید').fill('فونداسیون');
    await page.getByRole('button', { name: '+ افزودن برگه' }).click();
    await page.getByRole('button', { name: 'انجام شد' }).click();
    await expect(page.getByRole('tab', { name: 'فونداسیون (0)' })).toBeVisible();

    // (4) ردیف ابعادی با طبقات صریح و کد فهرست‌بها (L1)
    await page.getByRole('button', { name: '+ ردیف جدید' }).click();
    await page.getByLabel('شرح ردیف').fill('کندم و خارج کردن بوته و ریشه‌ها');
    await page.getByLabel('کد آیتم').fill('010101');
    await page.getByLabel('تعداد طبقات').fill('2');
    await page.getByLabel('طول', { exact: true }).fill('10');
    await page.getByLabel('عرض', { exact: true }).fill('5');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    await expect(page.getByText('کندم و خارج کردن بوته و ریشه‌ها')).toBeVisible();
    await expect(page.getByText('ابعادی (2 × 10 × 5)')).toBeVisible();

    // (5) ردیف دستی با دلیل الزامی و همان کد آیتم (L2)
    await page.getByRole('button', { name: '+ ردیف جدید' }).click();
    await page.getByLabel('شرح ردیف').fill('متره دستی بر اساس نقشه');
    await page.getByLabel('کد آیتم').fill('010101');
    await page.getByRole('combobox', { name: 'نوع مقدار' }).selectOption('manual');
    await page.getByLabel('مقدار دستی', { exact: true }).fill('12.5');
    await page.getByLabel('دلیل ثبت', { exact: true }).fill('مطابق نقشهٔ اجرایی شماره ۳');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    await expect(page.getByText('دستی 12.5')).toBeVisible();

    // (6) ردیف ارجاعی به L1 بدون کد (L3) — ارجاع با نشان وابستگی
    await page.getByRole('button', { name: '+ ردیف جدید' }).click();
    await page.getByLabel('شرح ردیف').fill('جمع مرجع چاهک‌ها');
    // V7 (CG-IR-MEASUREMENT-SPEC@0.2.0 §5): واحد ردیف ارجاع‌دهنده باید با ردیف مرجع
    // یکی باشد — ردیف مرجع L1 بر m2 است؛ واحد این ردیف صریحاً m2 انتخاب می‌شود.
    await page.getByLabel('واحد', { exact: true }).selectOption('m2');
    await page.getByRole('combobox', { name: 'نوع مقدار' }).selectOption('reference');
    await page.getByLabel('ردیف مرجع جملهٔ 1').selectOption('L1');
    await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
    await expect(page.getByText('ارجاع (1 × #L1)')).toBeVisible();

    // (7) قاعدهٔ گرد کردن طراحی روی جمع آیتم (دقت ۰، نصف به بالا)
    await page.getByRole('button', { name: '+ قاعدهٔ گرد کردن' }).click();
    await page.getByLabel('دقت گرد کردن').fill('0');
    await page.getByRole('button', { name: 'ثبت قاعده' }).click();
    await expect(page.getByText(/قواعد گرد کردن سند \(1\)/)).toBeVisible();
    await expect(page.getByText('منشأ: طراحی')).toBeVisible();

    // (8) ذخیرهٔ کل سند — نسخهٔ سرور جایگزین می‌شود (revision ← 2)
    await expect(page.getByText('تغییرات ذخیره‌نشده')).toBeVisible();
    await page.getByRole('button', { name: 'ذخیرهٔ تغییرات' }).click();
    await expect(page.getByText('ذخیره شد')).toBeVisible();
    await expect(page.getByText('نسخهٔ سند (revision)')).toBeVisible();
    await expect(page.locator('.info-row', { hasText: 'نسخهٔ سند (revision)' })).toContainText('2');

    // (9) ویرایش عنوان → dirty → ذخیرهٔ مجدد (revision ← 3)
    await page.getByLabel('عنوان سند').fill('متره مرحله اول — ویرایش‌شده');
    await expect(page.getByText('تغییرات ذخیره‌نشده')).toBeVisible();
    await page.getByRole('button', { name: 'ذخیرهٔ تغییرات' }).click();
    await expect(page.getByText('ذخیره شد')).toBeVisible();
    await expect(page.locator('.info-row', { hasText: 'نسخهٔ سند (revision)' })).toContainText('3');

    // (10) بایگانی: سند فقط-خواندنی می‌شود
    await page.getByRole('button', { name: 'بایگانی' }).click();
    await expect(page.getByText('بایگانی‌شده', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ ردیف جدید' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'بازگردانی از بایگانی' })).toBeVisible();

    // (11) بازگردانی: دوباره پیش‌نویسِ قابل ویرایش
    await page.getByRole('button', { name: 'بازگردانی از بایگانی' }).click();
    await expect(page.getByText('پیش‌نویس', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ ردیف جدید' })).toBeVisible();

    // (12) نهایی‌سازی: نتیجهٔ موتور در نمای فقط-خواندنی (112.5 → گردشده 113)
    await page.getByRole('button', { name: 'نهایی‌سازی' }).click();
    await page.getByRole('button', { name: 'نهایی‌سازی قطعی' }).click();
    await expect(page.getByText('جمع آیتم‌ها (بر پایهٔ کد)')).toBeVisible();
    await expect(page.getByText('نهایی‌شده', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ ردیف جدید' })).toHaveCount(0);
    // جمع آیتم 010101: (2×10×5) + 12.5 = 112.5 دقیق، 113 گردشده (qty مؤثر)
    const itemRow = page.locator('tr', { hasText: '010101' }).first();
    await expect(itemRow).toContainText('112.5');
    await expect(itemRow).toContainText('113');
    // ردیف بدون کد فقط در متره می‌ماند: 100
    await expect(page.locator('tr', { hasText: 'بدون کد' }).first()).toContainText('100');

    // (13) سند پیرو: شمارهٔ سند از سرور، ردیف‌ها با شناسهٔ پایدار کپی می‌شوند
    await page.getByRole('button', { name: 'ایجاد سند پیرو' }).click();
    await page.getByRole('button', { name: 'ساختن سند پیرو' }).click();
    await expect(page.getByText('پیش‌نویس', { exact: true })).toBeVisible();
    await expect(page.locator('.info-row', { hasText: 'شمارهٔ سند' })).toContainText('2');
    await expect(page.getByText('ارجاع (1 × #L1)')).toBeVisible();
    await expect(page.getByText('ابعادی (2 × 10 × 5)')).toBeVisible();
    const followUpUrl = page.url();

    // (14) بازگشت به سند نهایی‌شدهٔ اول با نشانی مستقیم (سند فهرست‌شدنی وجود ندارد)
    await page.goto(`/projects/${project.projectId}/takeoffs/${documentId}`);
    await expect(page.getByText('نهایی‌شده', { exact: true })).toBeVisible();
    await expect(page.getByText('جمع آیتم‌ها (بر پایهٔ کد)')).toBeVisible();

    // (15) گزارش PDF از سند نهایی‌شده: دانلود مرورگری با نام پایدار و بایت‌های واقعی
    const beforeReports = await apiCall<unknown>(
      'GET',
      `/projects/${project.projectId}/takeoffs/${documentId}`,
    );
    await expect(page.getByRole('heading', { name: 'گزارش‌ها' })).toBeVisible();
    const [pdf] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'دانلود PDF' }).click(),
    ]);
    expect(pdf.suggestedFilename()).toBe(`costgenius-takeoff-${documentId}.pdf`);
    const pdfBytes = await saveDownload(pdf, 'takeoff-report.pdf');
    expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdfBytes.byteLength).toBeGreaterThan(10000);
    await writeFile(join(tmpdir(), 'costgenius-e2e-takeoff-report.pdf'), pdfBytes);

    // (16) گزارش Excel: بازخوانی zip — مقدار دقیق/گردشده/مؤثر و «بدون کد» همه حاضرند
    const [excel] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'دانلود Excel' }).click(),
    ]);
    expect(excel.suggestedFilename()).toBe(`costgenius-takeoff-${documentId}.xlsx`);
    const xlsxBytes = await saveDownload(excel, 'takeoff-report.xlsx');
    expect(xlsxBytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(xlsxBytes.byteLength).toBeGreaterThan(1000);
    const sharedStrings = readZipEntry(xlsxBytes, 'xl/sharedStrings.xml').toString('utf-8');
    // 010101: exact 112.5, rounded/effective 113 (item-total rule scale 0)
    expect(sharedStrings).toContain('112.5');
    expect(sharedStrings).toContain('113');
    // the uncoded reference line stays visible: exact 100 + «بدون کد»
    expect(sharedStrings).toContain('100');
    expect(sharedStrings).toContain('بدون کد');
    // identity + canonical formula + unit columns survive into the workbook
    expect(sharedStrings).toContain(documentId);
    expect(sharedStrings).toContain('010101');
    expect(sharedStrings).toContain('(2 × 10 × 5)');
    expect(sharedStrings).toContain('(1 × #L1)');
    // the four fixed V1 sheet names live in the workbook manifest, not sharedStrings
    const workbookXml = readZipEntry(xlsxBytes, 'xl/workbook.xml').toString('utf-8');
    for (const sheetName of ['خلاصه', 'متره تفصیلی', 'جمع آیتم‌ها', 'جمع برگه‌ها']) {
      expect(workbookXml).toContain(sheetName);
    }
    // W: generating both reports left the finalized takeoff untouched
    const afterReports = await apiCall<unknown>(
      'GET',
      `/projects/${project.projectId}/takeoffs/${documentId}`,
    );
    expect(afterReports).toEqual(beforeReports);

    // (17) انتقال به برآورد: انتخاب برآورد/نسخهٔ پیش‌نویس و اجرای انتقال
    await page.getByRole('button', { name: 'انتقال به برآورد' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('برآورد مقصد').selectOption({ label: 'برآورد انتقال متره' });
    await dialog.getByLabel('نسخهٔ مقصد').selectOption(targetVersion.versionId);
    await dialog.getByRole('button', { name: 'انتقال به برآورد' }).click();
    await expect(dialog.getByText('نتیجهٔ انتقال')).toBeVisible();
    await expect(dialog.locator('tr', { hasText: '010101' })).toContainText('113');
    await expect(dialog.getByText(/اقلام بدون کد/)).toBeVisible();

    // (18) ردیف BOQ ساخته‌شده در نسخهٔ مقصد: شرح فهرست‌بها + مقدار مؤثر 113
    await page.goto(`/versions/${targetVersion.versionId}`);
    const boqRow = page.locator('tbody tr', { hasText: '010101' }).first();
    await expect(boqRow).toBeVisible();
    await expect(boqRow).toContainText('کندن و خارج کردن بوته');
    await expect(boqRow).toContainText('113');

    // (19) تکرار انتقال همان سند به همان نسخه: پیام قطعی 422 (بدون تکرار خودکار)
    await page.goto(`/projects/${project.projectId}/takeoffs/${documentId}`);
    await page.getByRole('button', { name: 'انتقال به برآورد' }).click();
    const repeatDialog = page.getByRole('dialog');
    await repeatDialog.getByLabel('برآورد مقصد').selectOption({ label: 'برآورد انتقال متره' });
    await repeatDialog.getByLabel('نسخهٔ مقصد').selectOption(targetVersion.versionId);
    await repeatDialog.getByRole('button', { name: 'انتقال به برآورد' }).click();
    await expect(
      repeatDialog.getByText('این صورت‌برداشت قبلاً به این برآورد منتقل شده است.'),
    ).toBeVisible();

    // (20) تعارض همزمانی روی سند پیرو: ویرایش موازی از طریق API، سپس ذخیرهٔ مرورگر → 409
    await page.goto(followUpUrl);
    // سند پیرو با نسخهٔ ۱ بارگذاری شده باشد تا ویرایش موازی قطعاً تعارض بسازد
    await expect(page.locator('.info-row', { hasText: 'نسخهٔ سند (revision)' })).toContainText('1');
    const followUpDocumentId = new URL(followUpUrl).pathname.split('/').pop() ?? '';
    const doc = await apiCall<{
      documentId: string;
      revision: number;
      sheets: { sheetId: string; name: string; lines: Record<string, unknown>[] }[];
      rounding: unknown[];
    }>('GET', `/projects/${project.projectId}/takeoffs/${followUpDocumentId}`);
    // همان شکل تجردیِ ذخیرهٔ رابط کاربری: فیلدهای اختیاریِ خالی حذف می‌شوند
    await apiCall('POST', `/projects/${project.projectId}/takeoffs/${doc.documentId}/save`, {
      expectedRevision: doc.revision,
      title: 'متره اصلاح سرور',
      sheets: doc.sheets.map((sheet) => ({
        sheetId: sheet.sheetId,
        name: sheet.name,
        lines: sheet.lines.map((line) => {
          const clean: Record<string, unknown> = { ...line };
          delete clean['origin'];
          delete clean['ruleRefs'];
          if (clean['itemCode'] == null) delete clean['itemCode'];
          if (clean['location'] == null) delete clean['location'];
          if (clean['notes'] == null) delete clean['notes'];
          return clean;
        }),
      })),
      rounding: doc.rounding,
    });
    await page.getByLabel('عنوان سند').fill('متره اصلاح مرورگر');
    await page.getByRole('button', { name: 'ذخیرهٔ تغییرات' }).click();
    await expect(
      page.getByText('این سند در جای دیگری تغییر کرده است. ابتدا نسخه جدید را دریافت کنید.'),
    ).toBeVisible();

    // (21) دریافت نسخهٔ جدید: محتوای سرور جایگزین می‌شود و سند دوباره تمیز است
    await page.getByRole('button', { name: 'دریافت نسخهٔ جدید' }).click();
    await expect(page.getByLabel('عنوان سند')).toHaveValue('متره اصلاح سرور');
    await expect(page.getByText('بدون تغییر', { exact: true })).toBeVisible();
    await expect(page.getByText('پیش‌نویس', { exact: true })).toBeVisible();

    // فقط دو 4xx عمدی این سناریو مجازند؛ هیچ نویز دیگری نباشد
    noise.assertClean(INTENTIONAL_4XX);
  });
});
