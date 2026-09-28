/**
 * Shared helpers for the E2E specs. Arrangement happens through the REAL API over
 * real HTTP (never direct DB writes, never mocked data) — only the behavior under
 * test is driven through the browser UI.
 */
import type { Page } from '@playwright/test';
import { E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME, E2E_API_URL } from './playwright.config.js';

/**
 * Arrangement calls go over real HTTP without the browser, so they carry no
 * storage-state cookie — they must authenticate through the REAL session
 * mechanism (same login as global-setup) and reuse that cookie.
 */
let sessionCookie: string | undefined;

async function ensureSession(): Promise<void> {
  if (sessionCookie !== undefined) {
    return;
  }
  const response = await fetch(E2E_API_URL + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: E2E_ADMIN_USERNAME,
      password: E2E_ADMIN_PASSWORD,
    }),
  });
  if (!response.ok) {
    throw new Error(`arrangement login failed: ${String(response.status)}`);
  }
  const setCookie = response.headers.get('set-cookie');
  const match = /(?:^|;\s*)cg_session=([^;]+)/.exec(setCookie ?? '');
  if (match === null) {
    throw new Error('arrangement login returned no cg_session cookie');
  }
  sessionCookie = `cg_session=${match[1] ?? ''}`;
}

/** The COMPLETE vertical-slice lines (real 1404 codes/units, base 38,147,600). */
export const COMPLETE_LINES = [
  { pricebookCode: '010101', quantity: '1000', unit: 'm2' },
  { pricebookCode: '010517', quantity: '5', unit: 'm2' },
  { pricebookCode: '240102', quantity: '0', unit: 'm2' },
  { pricebookCode: '270101', quantity: '120', unit: 'kg' },
  { pricebookCode: '270320', quantity: '10', unit: 'm3' },
  { pricebookCode: '270403', quantity: '2', unit: 'm3' },
  { pricebookCode: '280101', quantity: '500', unit: 'ton_km' },
  { pricebookCode: '280501', quantity: '3', unit: 'ton_nautical_mile' },
] as const;

/** The golden S4 chain of the COMPLETE fixture (P=1.0451, 1.30, R=1.1, +12,000,000). */
export const GOLDEN_CHAIN = {
  base: '38,147,600',
  afterFloor: '39,868,056.76',
  afterOverhead: '51,828,473.788',
  afterRegional: '57,011,321.1668',
  finalEstimate: '69,011,321.1668',
} as const;

/** The exact coefficient form values that produce the golden chain. */
export const GOLDEN_FORM = {
  groundFloorArea: '600',
  firstBasementArea: '400',
  aboveGroundFloors: [...Array.from({ length: 10 }, () => '500'), '400'],
  belowGroundFloors: ['400', '400', '400'],
  totalBuildingFloorArea: '7600',
  regionId: 'r-test',
  regionalCoefficient: '1.1',
  executionCost: '51828473.788',
  lumpSumAmount: '12000000',
} as const;

export interface ApiFixture {
  readonly projectId: string;
  readonly estimateId: string;
  readonly versionId: string;
}

/** Fills the S4 coefficient form with the exact golden values (through the UI). */
export async function fillGoldenCoefficients(page: Page): Promise<void> {
  await page.getByLabel('مساحت همکف *').fill(GOLDEN_FORM.groundFloorArea);
  await page.getByLabel('مساحت زیرزمین اول *').fill(GOLDEN_FORM.firstBasementArea);
  await page.getByLabel('مساحت کل طبقات *').fill(GOLDEN_FORM.totalBuildingFloorArea);

  const above = page.getByRole('group', { name: 'طبقات فوق زمین' });
  for (const area of GOLDEN_FORM.aboveGroundFloors) {
    await above.getByRole('button', { name: '+ افزودن طبقه' }).click();
    const index = (await above.locator('.form-row').count()) - 1;
    await above.getByLabel(`مساحت طبقه ${String(index + 1)}`).fill(area);
  }
  const below = page.getByRole('group', { name: 'طبقات زیر زمین' });
  for (const area of GOLDEN_FORM.belowGroundFloors) {
    await below.getByRole('button', { name: '+ افزودن طبقه' }).click();
    const index = (await below.locator('.form-row').count()) - 1;
    await below.getByLabel(`مساحت طبقه ${String(index + 1)}`).fill(area);
  }

  await page.getByLabel('شناسه منطقه (اختیاری)').fill(GOLDEN_FORM.regionId);
  await page.getByLabel('ضریب منطقه').fill(GOLDEN_FORM.regionalCoefficient);
  await page.getByLabel('هزینه اجرای منطقه *').fill(GOLDEN_FORM.executionCost);
  await page.getByLabel('مبلغ مقطوع').fill(GOLDEN_FORM.lumpSumAmount);
}

async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  await ensureSession();
  const response = await fetch(E2E_API_URL + path, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookie ?? '',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${String(response.status)} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Creates project + estimate + version through the real API (arrangement only). */
export async function arrangeVersion(
  title: string,
  lines: readonly { pricebookCode: string; quantity: string; unit: string }[] = [],
): Promise<ApiFixture> {
  const project = await apiCall<{ projectId: string }>('POST', '/projects', {
    projectId: crypto.randomUUID(),
    title,
  });
  const estimate = await apiCall<{ estimateId: string }>(
    'POST',
    `/projects/${project.projectId}/estimates`,
    { estimateId: crypto.randomUUID(), title: 'برآورد آرایش' },
  );
  const version = await apiCall<{ versionId: string }>(
    'POST',
    `/estimates/${estimate.estimateId}/versions`,
    { buildingId: 'building-main', versionId: crypto.randomUUID() },
  );
  if (lines.length > 0) {
    await apiCall('POST', `/estimate-versions/${version.versionId}/lines`, {
      lines: lines.map((line, index) => ({
        lineId: `arrange-${Math.random().toString(36).slice(2, 10)}-${String(index)}`,
        ...line,
      })),
    });
  }
  return {
    projectId: project.projectId,
    estimateId: estimate.estimateId,
    versionId: version.versionId,
  };
}

/** Creates a project ONLY (for the estimates-empty state) through the real API. */
export async function arrangeProject(title: string): Promise<{ projectId: string }> {
  return await apiCall<{ projectId: string }>('POST', '/projects', {
    projectId: crypto.randomUUID(),
    title,
  });
}

export { apiCall };

/**
 * Authenticated raw call (same real session cookie) that does NOT throw on a
 * non-2xx answer — for specs that assert the error contract itself.
 */
export async function apiCallRaw(method: string, path: string, body?: unknown): Promise<Response> {
  await ensureSession();
  return await fetch(E2E_API_URL + path, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookie ?? '',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
