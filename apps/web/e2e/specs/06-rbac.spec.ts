/**
 * P8-A S2 — RBAC in the real browser (CG-GOV-SPEC@0.1.0 §2/§3).
 *
 * Real users of every role are created through the REAL `POST /users` route by the
 * bootstrap org_admin; each scenario opens a FRESH anonymous browser context, logs in
 * through the REAL login page (the S1 UI), and then proves:
 *
 *  - estimator: may create a project through the UI; is denied user management (403)
 *    on a DIRECT API call — the server boundary, not hidden UI, is the enforcement;
 *  - reviewer: viewer-level reads and exports work; estimator+ mutations are denied
 *    (403 alert in the UI AND 403 on the direct API call);
 *  - viewer: reads and exports work; mutations are denied;
 *  - data_steward: exactly the viewer-class grants (reads yes, mutations no);
 *  - org_admin: the user-management surface answers (list + create);
 *  - anonymous: every protected API call is 401 — through the web proxy too.
 *
 * No authorization bypass exists through direct API calls: every denial is re-proven
 * with `page.request` carrying the very role's real session cookie.
 */
import { test, expect } from '../fixtures.js';
import { NoiseCollector } from '../fixtures.js';
import { E2E_API_URL, E2E_WEB_URL } from '../playwright.config.js';
import { apiCall, arrangeVersion, COMPLETE_LINES } from '../helpers.js';

/** Deterministic TEST-ONLY credentials of the four non-admin role users. */
const ROLE_USERS = {
  estimator: { username: 'e2e-estimator', password: 'e2e-estimator-password-123' },
  reviewer: { username: 'e2e-reviewer', password: 'e2e-reviewer-password-123' },
  viewer: { username: 'e2e-viewer', password: 'e2e-viewer-password-123' },
  data_steward: { username: 'e2e-steward', password: 'e2e-steward-password-123' },
} as const;

/** The golden S4 coefficients (the same attested values as the smoke) for the one
 * finalized version the export scenarios read. */
const GOLDEN_COEFF = {
  floor: {
    buildingId: 'building-main',
    groundFloorArea: '600',
    firstBasementArea: '400',
    aboveGroundFloors: [...Array.from({ length: 10 }, () => ({ area: '500' })), { area: '400' }],
    belowGroundFloors: Array.from({ length: 3 }, () => ({ area: '400' })),
    totalBuildingFloorArea: '7600',
  },
  overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
  regional: { parts: [{ regionId: 'r-e2e', coefficient: '1.1', executionCost: '51828473.788' }] },
  siteSetup: { lumpSumAmount: '12000000' },
};

let finalizedVersionId = '';

test.describe('P8-A S2 RBAC (real roles, real sessions, real API boundary)', () => {
  test.describe.configure({ mode: 'serial' });

  test('setup — the org_admin creates one real user per role and a finalized version', async () => {
    for (const [role, user] of Object.entries(ROLE_USERS)) {
      const created = await apiCall<{ userId: string }>('POST', '/users', {
        username: user.username,
        password: user.password,
        role,
      });
      expect(created.userId).toBeTruthy();
    }
    // the org_admin-only listing answers and contains every account
    const users = await apiCall<{ username: string }[]>('GET', '/users');
    const usernames = users.map((user) => user.username);
    for (const user of Object.values(ROLE_USERS)) {
      expect(usernames).toContain(user.username);
    }
    expect(usernames).toContain('admin');

    // a finalized version for the export scenarios (golden chain unchanged)
    const fixture = await arrangeVersion('پروژه نقش‌ها — e2e', COMPLETE_LINES);
    const finalized = await apiCall<{
      calculation: { s4Result: { finalEstimate: string | null } };
    }>('POST', `/estimate-versions/${fixture.versionId}/finalize`, GOLDEN_COEFF);
    expect(finalized.calculation.s4Result.finalEstimate).toBe('69011321.1668');
    finalizedVersionId = fixture.versionId;
  });

  test('anonymous — every protected API call answers 401 (also through the web proxy)', async () => {
    const direct = await fetch(`${E2E_API_URL}/projects`);
    expect(direct.status).toBe(401);
    expect(((await direct.json()) as { error: { code: string } }).error.code).toBe(
      'UNAUTHENTICATED',
    );
    const proxied = await fetch(`${E2E_WEB_URL}/api/projects`);
    expect(proxied.status).toBe(401);
    expect(((await proxied.json()) as { error: { code: string } }).error.code).toBe(
      'UNAUTHENTICATED',
    );
  });

  test('estimator — may mutate through the UI; user management is 403 on the direct API', async ({
    browser,
  }) => {
    const noise = new NoiseCollector();
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    noise.attach(page);
    await page.goto('/projects');
    await page.getByLabel('نام کاربری').fill(ROLE_USERS.estimator.username);
    await page.getByLabel('گذرواژه').fill(ROLE_USERS.estimator.password);
    await page.getByRole('button', { name: 'ورود' }).click();
    await expect(page.getByRole('heading', { name: 'پروژه‌ها' })).toBeVisible();

    // estimator CAN create a project through the real UI (Estimator+ mutation)
    await page.getByRole('button', { name: '+ پروژه جدید' }).click();
    await page.getByLabel('عنوان پروژه *').fill('پروژه برآوردکار — e2e');
    await page.getByRole('button', { name: 'ایجاد پروژه', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'پروژه برآوردکار — e2e' })).toBeVisible();

    // direct API call with the very same session: org_admin surface → 403 (no bypass)
    const denied = await page.request.post(`${E2E_WEB_URL}/api/users`, {
      data: { username: 'should-never-exist', password: 'never-created-123456', role: 'viewer' },
    });
    expect(denied.status()).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    // …and it really did not create anything
    const users = await apiCall<{ username: string }[]>('GET', '/users');
    expect(users.map((user) => user.username)).not.toContain('should-never-exist');

    await context.close();
    noise.assertClean([/401 .*\/auth\/session$/, 'status of 401']);
  });

  for (const role of ['reviewer', 'viewer', 'data_steward'] as const) {
    test(`${role} — viewer-class reads/exports yes; estimator+ mutations no (UI + direct API)`, async ({
      browser,
    }) => {
      const noise = new NoiseCollector();
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const page = await context.newPage();
      noise.attach(page);
      await page.goto('/projects');
      await page.getByLabel('نام کاربری').fill(ROLE_USERS[role].username);
      await page.getByLabel('گذرواژه').fill(ROLE_USERS[role].password);
      await page.getByRole('button', { name: 'ورود' }).click();
      await expect(page.getByRole('heading', { name: 'پروژه‌ها' })).toBeVisible();

      // viewer-class READ: the project page of the arranged project renders
      const projects = await page.request.get(`${E2E_WEB_URL}/api/projects`);
      expect(projects.status()).toBe(200);
      const list = (await projects.json()) as { projectId: string }[];
      expect(list.length).toBeGreaterThan(0);
      await page.goto(`/projects/${list[0]?.projectId ?? ''}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // viewer-class EXPORT: the Excel render answers 200 with the real workbook
      const excel = await page.request.get(
        `${E2E_WEB_URL}/api/estimate-versions/${finalizedVersionId}/render/excel`,
      );
      expect(excel.status()).toBe(200);

      // estimator+ MUTATION through the UI → the Persian 403 message (the API is
      // authoritative; the UI does not predict roles, it renders the denial)
      await page.goto('/projects');
      await page.getByRole('button', { name: '+ پروژه جدید' }).click();
      await page.getByLabel('عنوان پروژه *').fill(`پروژه ممنوع ${role}`);
      await page.getByRole('button', { name: 'ایجاد پروژه', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('شما مجوز انجام این عمل را ندارید.');

      // the same denial on the direct API call with this very session — no bypass
      const denied = await page.request.post(`${E2E_WEB_URL}/api/projects`, {
        data: { projectId: crypto.randomUUID(), title: `direct-${role}` },
      });
      expect(denied.status()).toBe(403);
      expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
      // …and nothing was created
      const after = await apiCall<{ title: string }[]>('GET', '/projects');
      expect(after.map((project) => project.title)).not.toContain(`direct-${role}`);

      await context.close();
      noise.assertClean([
        /401 .*\/auth\/session$/,
        'status of 401',
        /403 .*\/api\/projects$/,
        'status of 403',
      ]);
    });
  }

  test('org_admin — the user-management surface answers (list + create + role change)', async ({
    page,
  }) => {
    // the default page rides the admin storageState from the real global-setup login
    const users = await page.request.get(`${E2E_WEB_URL}/api/users`);
    expect(users.status()).toBe(200);
    expect(((await users.json()) as { username: string }[]).map((u) => u.username)).toContain(
      'e2e-viewer',
    );
    const created = await page.request.post(`${E2E_WEB_URL}/api/users`, {
      data: { username: 'e2e-temp-user', password: 'e2e-temp-password-123', role: 'viewer' },
    });
    expect(created.status()).toBe(201);
    const body = (await created.json()) as { userId: string };
    expect(JSON.stringify(body)).not.toMatch(/password/i);
    // role change on the created user → 200
    const changed = await page.request.post(`${E2E_WEB_URL}/api/users/${body.userId}/role`, {
      data: { role: 'reviewer' },
    });
    expect(changed.status()).toBe(200);
    // self-deactivation stays forbidden even for the admin (§2.3 guard rail)
    const session = await page.request.get(`${E2E_WEB_URL}/api/auth/session`);
    const selfId = ((await session.json()) as { userId: string }).userId;
    const selfDeactivate = await page.request.post(`${E2E_WEB_URL}/api/users/${selfId}/deactivate`);
    expect(selfDeactivate.status()).toBe(403);
  });
});
