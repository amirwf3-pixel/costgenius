/**
 * §2/§5/§6/§7/§8/§10/§11/§12/§13 — THE golden product workflow, entirely through the
 * real browser against the production build: project → estimate → version → BOQ →
 * calculate → review S4 → finalize → reload → Excel/PDF downloads (byte-verified) →
 * v2 append-only → v1 provably unchanged. Precision is asserted at BOTH ends: the
 * exact decimal strings sent to the backend and the exact strings rendered.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Download, Page } from '@playwright/test';
import { test, expect } from '../fixtures.js';
import { COMPLETE_LINES, GOLDEN_CHAIN, fillGoldenCoefficients } from '../helpers.js';

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

const state: {
  versionId: string | undefined;
  estimateId: string | undefined;
  projectId: string | undefined;
  v1PdfHash: string | undefined;
} = { versionId: undefined, estimateId: undefined, projectId: undefined, v1PdfHash: undefined };

async function addLineThroughDialog(
  page: Page,
  search: string,
  code: string,
  quantity: string,
): Promise<void> {
  await page.getByRole('button', { name: '+ افزودن ردیف' }).click();
  await page.getByLabel('جستجوی کد یا شرح *').fill(search);
  await page.locator('.lookup-item', { hasText: code }).first().click();
  await page.getByLabel('مقدار *').fill(quantity);
  await page.getByRole('button', { name: 'افزودن ردیف', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}

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

test.describe.serial('golden workflow in a real browser', () => {
  test('create project → estimate → version through the UI (URLs are real)', async ({ page }) => {
    await page.goto('/projects');
    await page.getByRole('button', { name: '+ پروژه جدید' }).click();
    await page.getByLabel('عنوان پروژه *').fill('ساختمان اداری — آزمون مرورگر');
    await page.getByLabel('محل (اختیاری)').fill('تهران');
    await page.getByRole('button', { name: 'ایجاد پروژه', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ساختمان اداری — آزمون مرورگر' })).toBeVisible();
    expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:4173\/projects\/[0-9a-f-]{36}$/);
    state.projectId = page.url().split('/').pop();

    await page.getByRole('button', { name: '+ برآورد جدید' }).click();
    await page.getByLabel('عنوان برآورد *').fill('برآورد اولیه');
    await page.getByRole('button', { name: 'ایجاد برآورد', exact: true }).click();
    // the dialog stays on the project page; the new estimate appears in the list
    const estimateLink = page.getByRole('link', { name: 'برآورد اولیه' });
    await expect(estimateLink).toBeVisible();
    await estimateLink.click();
    await expect(page.getByRole('heading', { name: 'برآورد اولیه' })).toBeVisible();
    expect(page.url()).toMatch(/\/estimates\/[0-9a-zA-Z-]+$/);
    state.estimateId = page.url().split('/').pop();

    await page.getByRole('button', { name: 'نسخه جدید' }).click();
    await page.getByLabel('شناسه ساختمان *').fill('building-main');
    await page.getByRole('button', { name: 'ایجاد نسخه', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'نسخه 1' })).toBeVisible();
    expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:4173\/versions\/[0-9a-f-]{36}-v1$/);
    state.versionId = page.url().split('/').pop() ?? '';
    await expect(page.getByText('پیش‌نویس', { exact: true })).toBeVisible();
  });

  test('add the eight real 1404 lines through the pricebook dialog; negatives stay visible', async ({
    page,
  }) => {
    await page.goto(`/versions/${state.versionId ?? ''}`);
    for (const line of COMPLETE_LINES) {
      await addLineThroughDialog(page, line.pricebookCode, line.pricebookCode, line.quantity);
    }
    const table = page.locator('table').first();
    await expect(table.locator('tbody tr')).toHaveCount(8);
    for (const line of COMPLETE_LINES) {
      await expect(table).toContainText(line.pricebookCode);
    }
    // §6 — real negatives, never clamped/absed/zeroed
    await expect(table).toContainText('-1,037,000');
    await expect(table).toContainText('-2,131,000');
    // zero quantity stays a real zero (240102); units render as the API's unit labels
    await expect(table).toContainText('تن - مایل دریایی');
    await expect(table).toContainText('تن - کیلومتر');
  });

  test('calculate with the golden coefficients → the exact S4 chain renders (§5/§7)', async ({
    page,
    noise,
  }) => {
    await page.goto(`/versions/${state.versionId ?? ''}`);

    // precision over the wire: the calculate payload carries EXACT decimal strings
    let calculateBody: Record<string, unknown> | undefined;
    page.on('request', (request) => {
      if (request.url().endsWith('/calculate')) {
        calculateBody = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      }
    });

    await fillGoldenCoefficients(page);
    await page.getByRole('button', { name: 'محاسبه', exact: true }).click();

    // the five real stages with their Persian labels and exact outputs
    // (stage names asserted as table cells — the coefficient form uses similar words)
    await expect(page.getByRole('cell', { name: 'جمع ردیف‌های قیمت‌خورده' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'ضریب طبقات (F)' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'سربار' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'ضریب منطقه (R)' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'تأسیسات سایت' })).toBeVisible();
    // exact outputs (some appear in both the stage table and the summary block)
    await expect(page.getByText(GOLDEN_CHAIN.base).first()).toBeVisible();
    await expect(page.getByText(GOLDEN_CHAIN.afterFloor).first()).toBeVisible();
    await expect(page.getByText(GOLDEN_CHAIN.afterOverhead).first()).toBeVisible();
    await expect(page.getByText(GOLDEN_CHAIN.afterRegional).first()).toBeVisible();
    await expect(page.getByText(GOLDEN_CHAIN.finalEstimate).first()).toBeVisible();

    // no rounding, no scientific notation anywhere on the page
    const pageText = await page.evaluate(() => document.body.textContent);
    expect(/\d[eE][+-]\d/.test(pageText)).toBe(false);

    // the backend received the exact strings (never numbers)
    expect(calculateBody).toBeDefined();
    const floor = (calculateBody?.['floor'] ?? {}) as Record<string, unknown>;
    const siteSetup = (calculateBody?.['siteSetup'] ?? {}) as Record<string, unknown>;
    const regional = (calculateBody?.['regional'] ?? {}) as {
      parts?: Array<Record<string, unknown>>;
    };
    expect(floor['groundFloorArea']).toBe('600');
    expect(floor['totalBuildingFloorArea']).toBe('7600');
    expect(siteSetup['lumpSumAmount']).toBe('12000000');
    expect(regional.parts?.[0]?.['coefficient']).toBe('1.1');
    expect(regional.parts?.[0]?.['executionCost']).toBe('51828473.788');
    noise.assertClean();
  });

  test('finalize needs confirmation, then the version is read-only with reports enabled (§8)', async ({
    page,
  }) => {
    await page.goto(`/versions/${state.versionId ?? ''}`);
    await fillGoldenCoefficients(page);
    await page.getByRole('button', { name: 'محاسبه', exact: true }).click();
    await expect(page.getByText(GOLDEN_CHAIN.finalEstimate).first()).toBeVisible();

    // finalize only happens after the explicit confirmation dialog
    await page.getByRole('button', { name: 'نهایی‌سازی', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('غیرقابل تغییر');
    await expect(page.getByText('نهایی‌شده', { exact: true })).toHaveCount(0); // not yet
    await dialog.getByRole('button', { name: 'نهایی‌سازی' }).click();

    await expect(page.getByText('نهایی‌شده', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ افزودن ردیف' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'محاسبه', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'دانلود Excel' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'دانلود PDF' })).toBeEnabled();
    // the finalized calculation still shows the exact chain
    await expect(page.getByText(GOLDEN_CHAIN.finalEstimate).first()).toBeVisible();

    // reload: the state comes from the API, not from memory
    await page.reload();
    await expect(page.getByText('نهایی‌شده', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ افزودن ردیف' })).toHaveCount(0);
    await expect(page.getByText(GOLDEN_CHAIN.finalEstimate).first()).toBeVisible();
  });

  test('Excel and PDF download as real browser downloads with exact filenames (§10/§11)', async ({
    page,
  }) => {
    await page.goto(`/versions/${state.versionId ?? ''}`);
    const versionId = state.versionId ?? '';

    const [excel1] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'دانلود Excel' }).click(),
    ]);
    expect(excel1.suggestedFilename()).toBe(`costgenius-${versionId}.xlsx`);
    const xlsxBytes = await saveDownload(excel1, 'v1-a.xlsx');
    expect(xlsxBytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(xlsxBytes.byteLength).toBeGreaterThan(1000);
    await writeFile(join(tmpdir(), 'costgenius-e2e-v1-a.xlsx'), xlsxBytes);

    const [pdf1] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'دانلود PDF' }).click(),
    ]);
    expect(pdf1.suggestedFilename()).toBe(`costgenius-${versionId}.pdf`);
    const pdfBytes = await saveDownload(pdf1, 'v1-a.pdf');
    expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    state.v1PdfHash = sha256(pdfBytes);
  });

  test('two independent Excel downloads are byte-identical and carry the exact decimals (§12)', async ({
    page,
  }) => {
    await page.goto(`/versions/${state.versionId ?? ''}`);
    const [excel2] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'دانلود Excel' }).click(),
    ]);
    const second = await saveDownload(excel2, 'v1-b.xlsx');
    const first = await readFile(join(tmpdir(), 'costgenius-e2e-v1-a.xlsx'));
    expect(sha256(second)).toBe(sha256(first));

    // §10 — parse the workbook (a minimal pure-zip reader, no extra dependency) and
    // verify the exact golden decimals are stored verbatim, as the engine emitted them
    const sharedStrings = readZipEntry(second, 'xl/sharedStrings.xml').toString('utf-8');
    for (const exact of [
      '69011321.1668',
      '57011321.1668',
      '51828473.788',
      '39868056.76',
      '38147600',
      '-1037000',
      '010101',
    ]) {
      expect(sharedStrings).toContain(exact);
    }
  });

  test('v2 through the append-only workflow; v1 stays unchanged including its PDF (§13)', async ({
    page,
  }) => {
    // new version is the only way forward
    await page.goto(`/versions/${state.versionId ?? ''}`);
    await page.getByRole('button', { name: 'ایجاد نسخه جدید' }).click();
    await expect(page.getByRole('heading', { name: 'برآورد اولیه' })).toBeVisible();
    await page.getByRole('button', { name: 'نسخه جدید' }).click();
    await page.getByLabel('شناسه ساختمان *').fill('building-main');
    await page.getByRole('button', { name: 'ایجاد نسخه', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'نسخه 2' })).toBeVisible();
    const v2Url = page.url();
    const v2Id = v2Url.split('/').pop() ?? '';

    // v2: priced line + the unpriced deduction (220925) and star item (090320)
    await addLineThroughDialog(page, '010101', '010101', '1000');
    await addLineThroughDialog(page, '220925', '220925', '40');
    await addLineThroughDialog(page, '090320', '090320', '80');
    const table = page.locator('table').first();
    await expect(table.locator('tbody tr')).toHaveCount(3);

    // §6 — null is «ثبت نشده», never zero
    await expect(table.getByText('ثبت نشده').first()).toBeVisible();

    // calculate v2: the incomplete mix halts with a null total (never zero)
    await fillGoldenCoefficients(page);
    await page.getByRole('button', { name: 'محاسبه', exact: true }).click();
    await expect(page.locator('.calc-total-value').first()).toContainText('ثبت نشده');

    // v1 is untouched: status, lines, calculation and its PDF bytes
    await page.goto(`/versions/${state.versionId ?? ''}`);
    await expect(page.getByText('نهایی‌شده', { exact: true })).toBeVisible();
    await expect(page.locator('table').first().locator('tbody tr')).toHaveCount(8);
    await expect(page.getByText(GOLDEN_CHAIN.finalEstimate).first()).toBeVisible();
    const [pdfAgain] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'دانلود PDF' }).click(),
    ]);
    expect(pdfAgain.suggestedFilename()).toBe(`costgenius-${state.versionId ?? ''}.pdf`);
    const pdfBytes2 = await saveDownload(pdfAgain, 'v1-b.pdf');
    expect(sha256(pdfBytes2)).toBe(state.v1PdfHash);
    expect(v2Id).not.toBe(state.versionId);
  });
});
