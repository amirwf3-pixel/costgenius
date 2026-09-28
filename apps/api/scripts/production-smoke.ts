/**
 * PRODUCTION-PATH SMOKE TEST (Production Release Audit §4/§5/§10/§11).
 *
 * Boots a REAL PostgreSQL SERVER (16.9 GA binaries via @embedded-postgres — an npm
 * package, the only reachable channel in this environment; NOT PGlite, NOT a mock),
 * then runs the REAL production entry point (`src/index.ts` → `main()`) as a child
 * process against it and verifies the full production story over real HTTP:
 *
 *   startup (config validation + migrations) → /health
 *   → P8-A S1 authentication gate (401 when anonymous; login; DB-backed session
 *     that survives a restart; logout deletes the session row)
 *   → P8-A S2 RBAC: the bootstrap admin IS org_admin; a viewer-role account gets
 *     200 on reads/exports and 403 FORBIDDEN on mutations (with zero side
 *     effects); the §2.3 guard rails (self-deactivation, last-org_admin) hold
 *   → create project → estimate → version → real 1404 lines
 *   → calculate (golden chain) → finalize → reload (snapshot equality)
 *   → render Excel (PK bytes, deterministic) → render PDF (%PDF, deterministic)
 *   → error hygiene (malformed JSON 400, unknown route 404)
 *   → SIGTERM graceful shutdown (exit 0, no hang)
 *   → S3: the audit writer — governance + domain events with exact payloads, zero
 *     events for denied/failed mutations, history byte-identical across restart, and
 *     the RESTARTED API RUNNING AS A RESTRICTED non-owner role that can INSERT but
 *     never UPDATE/DELETE audit_events (the DEPLOYMENT.md runbook posture)
 *   → restart (migrations re-run idempotently; data persists)
 *   → schema assertions on the fresh database (exactly the TWELVE S1 tables — the
 *     nine domain tables plus users/sessions/audit_events — FKs, uniques, indexes,
 *     numeric precision, JSONB snapshots, migration journal; and ZERO domain rows
 *     before the workflow — no seed data, the 1404 pricebook is NOT copied into the
 *     database; the ONLY user is the bootstrap admin)
 *
 * It also proves (Release Audit §18/§20/§21):
 *   - fail-closed startup in a clean environment: missing DATABASE_URL, malformed
 *     DATABASE_URL and an unreachable database each exit non-zero, promptly, without
 *     an unhandled-rejection banner and without ever listening;
 *   - the §20 price mix on a second (append-only) version: a normal priced line, the
 *     NULL-price deduction 220925 and the star item 090320 — the incomplete mix halts
 *     with a NULL total (never 0) and v1's rendered Excel stays byte-identical;
 *   - the Excel workbook is readable and preserves the exact golden decimals inside
 *     xl/sharedStrings.xml, and the PDF carries a valid %%EOF trailer.
 *
 * Run:  pnpm --filter @costgenius/api run smoke:production
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 3210;
const BASE = `http://127.0.0.1:${String(PORT)}`;
/** Deterministic TEST-ONLY bootstrap credentials for this smoke (never production). */
const BOOTSTRAP_USERNAME = 'smoke-admin';
const BOOTSTRAP_PASSWORD = 'smoke-bootstrap-password-123';
/** Deterministic TEST-ONLY lower-role account for the P8-A S2 denial proofs. */
const VIEWER_USERNAME = 'smoke-viewer';
const VIEWER_PASSWORD = 'smoke-viewer-password-123';
/** The cg_session cookie value of the smoke's logged-in admin (set by loginOnce). */
let authCookie: string | undefined;
const PG_PORT = 54329;
/** The versioned Drizzle migrations the API applies at startup (§19). */
const MIGRATIONS_DIR = new URL('../../../packages/db/migrations', import.meta.url).pathname;
const MIGRATION_FILE_COUNT = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length;

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => {
      setTimeout(r, 300);
    });
  }
}

/** Logs in through the REAL session mechanism and keeps the cookie for call/authFetch. */
async function loginOnce(): Promise<string> {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: BOOTSTRAP_USERNAME,
      password: BOOTSTRAP_PASSWORD,
    }),
  });
  if (response.status !== 200) {
    throw new Error(`smoke login failed: ${String(response.status)}`);
  }
  const setCookie = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('cg_session='));
  if (setCookie === undefined) {
    throw new Error('smoke login returned no cg_session cookie');
  }
  // cookie hygiene on the production path (full contract is covered by unit tests)
  if (!/HttpOnly/i.test(setCookie) || !/SameSite=Strict/i.test(setCookie)) {
    throw new Error(`cg_session cookie flags wrong: ${setCookie.split(';').slice(1).join(';')}`);
  }
  authCookie = setCookie.split(';')[0];
  return setCookie;
}

/** Raw fetch with the session cookie attached (binary renders, raw bodies). */
async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      ...(authCookie === undefined ? {} : { cookie: authCookie }),
    },
  });
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const response = await authFetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data: unknown = text.length > 0 ? JSON.parse(text) : {};
  return { status: response.status, data };
}

/**
 * Minimal ZIP entry reader (store + deflate, central-directory based) — lets the smoke
 * verify the rendered workbook's CONTENT (§21) without adding a dependency. Returns
 * null when the entry cannot be located/decoded.
 */
function readZipEntry(zip: Buffer, entryName: string): Buffer | null {
  let eocd = -1;
  for (let i = zip.byteLength - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) return null;
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
      return null;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/**
 * §18 — fail-closed startup verification: spawns the REAL production entry with a
 * deliberately broken environment and asserts the process exits non-zero, promptly
 * (waitForExit bounds it — null means it hung), with the expected diagnostic and no
 * unhandled-rejection noise. The API must never listen on a broken configuration.
 */
async function spawnExpectFailure(
  label: string,
  env: NodeJS.ProcessEnv,
  expectInOutput: RegExp,
): Promise<void> {
  const child: ChildProcess = spawn(
    'node',
    ['--conditions=source', '--import', 'tsx', 'src/main.ts'],
    {
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'], ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  const exitCode = await waitForExit(child, 30_000);
  check(
    label,
    exitCode !== null &&
      exitCode !== 0 &&
      expectInOutput.test(output) &&
      !/UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/.test(output),
    `exit=${String(exitCode)}`,
  );
}

/** §18 — the three fail-closed startup scenarios, run in a clean environment. */
async function verifyStartupFailures(): Promise<void> {
  console.log('[smoke] §18 fail-closed startup scenarios (clean environment, no dev server)…');
  await spawnExpectFailure(
    'missing DATABASE_URL → fail closed (non-zero exit, no listen, no unhandled rejection)',
    {},
    /DATABASE_URL/,
  );
  await spawnExpectFailure(
    'malformed DATABASE_URL → fail closed (must be postgres://, no fallback)',
    { DATABASE_URL: 'mysql://not-a-postgres-string' },
    /DATABASE_URL/,
  );
  await spawnExpectFailure(
    'unreachable database → fail closed, the process exits (no hang)',
    { DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:54330/unreachable' },
    /ECONNREFUSED|connect/i,
  );
}

function startApi(databaseUrl: string): ChildProcess {
  return spawn('node', ['--conditions=source', '--import', 'tsx', 'src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      // P8-A S1 bootstrap (CG-GOV §1.5): the fresh database has zero users, so the
      // initial org_admin MUST come from the environment — fail closed without it.
      // On restart the users table is non-empty and these are ignored.
      CG_BOOTSTRAP_ADMIN_USERNAME: BOOTSTRAP_USERNAME,
      CG_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolvePromise) => {
    child.once('exit', (code) => {
      resolvePromise(code);
    });
    setTimeout(() => {
      resolvePromise(null);
    }, timeoutMs);
  });
}

async function runWorkflow(): Promise<{
  projectId: string;
  estimateId: string;
  versionId: string;
  excelHash: string;
  pdfHash: string;
}> {
  const COEFF = {
    floor: {
      buildingId: 'building-main',
      groundFloorArea: '600',
      firstBasementArea: '400',
      aboveGroundFloors: [...Array.from({ length: 10 }, () => ({ area: '500' })), { area: '400' }],
      belowGroundFloors: Array.from({ length: 3 }, () => ({ area: '400' })),
      totalBuildingFloorArea: '7600',
    },
    overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
    regional: {
      parts: [{ regionId: 'r-test', coefficient: '1.1', executionCost: '51828473.788' }],
    },
    siteSetup: { lumpSumAmount: '12000000' },
  };
  const LINES = [
    { lineId: 's1', pricebookCode: '010101', quantity: '1000', unit: 'm2' },
    { lineId: 's2', pricebookCode: '010517', quantity: '5', unit: 'm2' },
    { lineId: 's3', pricebookCode: '240102', quantity: '0', unit: 'm2' },
    { lineId: 's4', pricebookCode: '270101', quantity: '120', unit: 'kg' },
    { lineId: 's5', pricebookCode: '270320', quantity: '10', unit: 'm3' },
    { lineId: 's6', pricebookCode: '270403', quantity: '2', unit: 'm3' },
    { lineId: 's7', pricebookCode: '280101', quantity: '500', unit: 'ton_km' },
    { lineId: 's8', pricebookCode: '280501', quantity: '3', unit: 'ton_nautical_mile' },
  ];

  const project = await call('POST', '/projects', {
    projectId: crypto.randomUUID(),
    title: 'پروژه آزمون تولیدی',
  });
  const projectId = (project.data as { projectId: string }).projectId;
  check(
    'create project over real HTTP (201)',
    project.status === 201,
    `status ${String(project.status)}`,
  );
  const estimate = await call('POST', `/projects/${projectId}/estimates`, {
    estimateId: crypto.randomUUID(),
    title: 'برآورد آزمون تولیدی',
  });
  const estimateId = (estimate.data as { estimateId: string }).estimateId;
  check('create estimate', estimate.status === 201, `status ${String(estimate.status)}`);
  const version = await call('POST', `/estimates/${estimateId}/versions`, {
    buildingId: 'building-main',
    versionId: crypto.randomUUID(),
  });
  const versionId = (version.data as { versionId: string }).versionId;
  check('create version', version.status === 201, `status ${String(version.status)}`);
  const added = await call('POST', `/estimate-versions/${versionId}/lines`, { lines: LINES });
  const addedLines = (added.data as { lines?: unknown[] }).lines;
  check(
    'add the eight real 1404 lines',
    added.status === 200 && addedLines?.length === 8,
    `status ${String(added.status)}`,
  );
  const calc = await call('POST', `/estimate-versions/${versionId}/calculate`, COEFF);
  const goldenTotal = (calc.data as { s4Result: { finalEstimate: string | null } }).s4Result
    .finalEstimate;
  check(
    'calculate → exact golden total 69011321.1668',
    calc.status === 200 && goldenTotal === '69011321.1668',
    `finalEstimate ${String(goldenTotal)}`,
  );
  const finalize = await call('POST', `/estimate-versions/${versionId}/finalize`, COEFF);
  check(
    'finalize persists the bundle (201)',
    finalize.status === 201,
    `status ${String(finalize.status)}`,
  );
  const reloaded = await call('GET', `/estimate-versions/${versionId}`);
  const reloadedData = reloaded.data as {
    finalizedAt?: string;
    estimate?: { versions?: unknown[] };
  };
  check(
    'reload answers the finalized bundle (finalizedAt + full estimate)',
    reloaded.status === 200 &&
      typeof reloadedData.finalizedAt === 'string' &&
      Array.isArray(reloadedData.estimate?.versions),
  );
  const conflict = await call('POST', `/estimate-versions/${versionId}/lines`, {
    lines: [{ lineId: 's9', pricebookCode: '010101', quantity: '1', unit: 'm2' }],
  });
  check(
    'finalized immutability (409 VERSION_FINALIZED)',
    conflict.status === 409 &&
      (conflict.data as { error: { code: string } }).error.code === 'VERSION_FINALIZED',
  );

  // D-016 Phase 3 — the Full Takeoff resource family on the production path (create →
  // full-document replace under expectedRevision → finalize → immutable snapshot →
  // follow-up revision). One chain, one sheet, a dimensional + a reference line, one
  // design rounding rule: itemTotal 010101 (real 1404 m2 row) = 36 + 36 = 72 exactly.
  const takeoffDocId = crypto.randomUUID();
  const takeoff = await call('POST', `/projects/${projectId}/takeoffs`, {
    takeoffId: crypto.randomUUID(),
    documentId: takeoffDocId,
    title: 'ریز متره آزمون تولیدی',
  });
  check(
    'takeoff draft created over real HTTP (201, revision 1)',
    takeoff.status === 201 && (takeoff.data as { revision?: number }).revision === 1,
    `status ${String(takeoff.status)}`,
  );
  const takeoffSave = await call('POST', `/projects/${projectId}/takeoffs/${takeoffDocId}/save`, {
    expectedRevision: 1,
    title: 'ریز متره آزمون تولیدی',
    rounding: [
      {
        target: 'item-total',
        selector: { itemCode: '010101' },
        scale: 0,
        mode: 'HALF_UP',
        sourceStatus: 'design',
      },
    ],
    sheets: [
      {
        sheetId: 'TS1',
        name: 'برگه آزمون',
        lines: [
          {
            lineId: 'TL1',
            rowNo: 1,
            description: 'کانال فوتی',
            itemCode: '010101',
            kind: 'addition',
            unit: 'm2',
            quantity: {
              type: 'dimensional',
              profile: 'LWH',
              length: '2',
              width: '3',
              height: '1.5',
              floorCount: '2',
              similarCount: '2',
            },
          },
          {
            lineId: 'TL2',
            rowNo: 2,
            description: 'مرجع به کانال',
            itemCode: '010101',
            kind: 'addition',
            unit: 'm2',
            quantity: {
              type: 'reference',
              terms: [{ lineId: 'TL1', factor: '1', use: 'signed' }],
            },
          },
        ],
      },
    ],
  });
  check(
    'takeoff full-document replace (revision 2)',
    takeoffSave.status === 200 && (takeoffSave.data as { revision?: number }).revision === 2,
    `status ${String(takeoffSave.status)}`,
  );
  const takeoffStale = await call('POST', `/projects/${projectId}/takeoffs/${takeoffDocId}/save`, {
    expectedRevision: 1,
    title: 'ریز متره آزمون تولیدی',
    rounding: [],
    sheets: [],
  });
  check(
    'stale takeoff expectedRevision → 409 PERSISTENCE_CONFLICT',
    takeoffStale.status === 409 &&
      (takeoffStale.data as { error: { code: string } }).error.code === 'PERSISTENCE_CONFLICT',
  );
  const takeoffFinalize = await call(
    'POST',
    `/projects/${projectId}/takeoffs/${takeoffDocId}/finalize`,
    { expectedRevision: 2 },
  );
  const takeoffTotals = (takeoffFinalize.data as { result?: { itemTotals?: { qty: string }[] } })
    .result?.itemTotals;
  check(
    'takeoff finalized with its immutable snapshot (201, itemTotal 010101 = 72 exact)',
    takeoffFinalize.status === 201 && takeoffTotals?.[0]?.qty === '72',
    `status ${String(takeoffFinalize.status)}`,
  );
  const takeoffReload = await call('GET', `/projects/${projectId}/takeoffs/${takeoffDocId}`);
  check(
    'takeoff reload answers the finalized bundle',
    takeoffReload.status === 200 &&
      typeof (takeoffReload.data as { finalizedAt?: string }).finalizedAt === 'string' &&
      (takeoffReload.data as { document?: { status?: string } }).document?.status === 'finalized',
  );
  const takeoffFollowUp = await call(
    'POST',
    `/projects/${projectId}/takeoffs/${takeoffDocId}/follow-up`,
    { documentId: crypto.randomUUID() },
  );
  check(
    'takeoff follow-up revision created (documentNumber 2, draft)',
    takeoffFollowUp.status === 201 &&
      (takeoffFollowUp.data as { documentNumber?: number }).documentNumber === 2 &&
      (takeoffFollowUp.data as { status?: string }).status === 'draft',
    `status ${String(takeoffFollowUp.status)}`,
  );

  // D-016 Phase 4 — the Takeoff → BOQ transfer on the production path (G2=B): the
  // FINALIZED document transfers into a DRAFT estimate version of the same project —
  // ONE BOQ line per itemCode itemTotal (010101 = 72 m2) through the existing S2/S3
  // path, with §8.1 provenance; the repeat is rejected with ALREADY_TRANSFERRED; the
  // transferred version still calculates through the unchanged S2/S3/S4 chain.
  const transferEstimateId = crypto.randomUUID();
  const transferEstimate = await call('POST', `/projects/${projectId}/estimates`, {
    estimateId: transferEstimateId,
    title: 'برآورد مقصد متره',
  });
  check(
    'transfer target estimate created',
    transferEstimate.status === 201,
    `status ${String(transferEstimate.status)}`,
  );
  const transferVersion = await call('POST', `/estimates/${transferEstimateId}/versions`, {
    buildingId: 'building-main',
    versionId: `${transferEstimateId}-v1`,
  });
  check(
    'transfer target draft version created',
    transferVersion.status === 201,
    `status ${String(transferVersion.status)}`,
  );
  const transferVersionId = `${transferEstimateId}-v1`;
  const transfer = await call(
    'POST',
    `/projects/${projectId}/takeoffs/${takeoffDocId}/transfer-to-boq`,
    { versionId: transferVersionId },
  );
  const transferData = transfer.data as {
    transferred?: { itemCode: string; quantity: string; lineId: string }[];
    skipped?: unknown[];
  };
  const transferItems = transferData.transferred ?? [];
  const transferItem = transferItems[0];
  check(
    'takeoff → BOQ transfer: one 010101 line of exactly 72 m2 (G2=B)',
    transfer.status === 200 &&
      transferItems.length === 1 &&
      transferItem !== undefined &&
      transferItem.itemCode === '010101' &&
      transferItem.quantity === '72',
    `status ${String(transfer.status)}`,
  );
  const transferRepeat = await call(
    'POST',
    `/projects/${projectId}/takeoffs/${takeoffDocId}/transfer-to-boq`,
    { versionId: transferVersionId },
  );
  check(
    'repeat transfer rejected with 422 TAKEOFF_TRANSFER_REJECTED',
    transferRepeat.status === 422 &&
      (transferRepeat.data as { error: { code: string } }).error.code ===
        'TAKEOFF_TRANSFER_REJECTED',
  );
  const transferredVersion = await call('GET', `/estimate-versions/${transferVersionId}`);
  const transferredLine = ((
    transferredVersion.data as { lines?: { lineId: string; quantity: string }[] }
  ).lines ?? [])[0];
  check(
    'the transferred BOQ line is persisted with its provenance identity',
    transferredVersion.status === 200 &&
      transferredLine !== undefined &&
      transferredLine.lineId === `tk-${takeoffDocId}-010101` &&
      transferredLine.quantity === '72',
  );
  const transferCalc = await call(
    'POST',
    `/estimate-versions/${transferVersionId}/calculate`,
    COEFF,
  );
  check(
    'the transferred version calculates through the unchanged S2/S3/S4 chain',
    transferCalc.status === 200 &&
      typeof (transferCalc.data as { s4Result?: { finalEstimate: string | null } }).s4Result
        ?.finalEstimate === 'string',
    `status ${String(transferCalc.status)}`,
  );

  const sha = async (buf: Buffer): Promise<string> =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', buf)).reduce(
      (acc, b) => acc + b.toString(16).padStart(2, '0'),
      '',
    );

  const excelA = await authFetch(`/estimate-versions/${versionId}/render/excel`);
  const excelBytesA = Buffer.from(await excelA.arrayBuffer());
  const excelB = await authFetch(`/estimate-versions/${versionId}/render/excel`);
  const excelBytesB = Buffer.from(await excelB.arrayBuffer());
  check(
    'Excel renders as a real XLSX, byte-deterministic',
    excelA.status === 200 &&
      excelBytesA.subarray(0, 2).toString('latin1') === 'PK' &&
      excelBytesA.equals(excelBytesB),
  );
  const excelHashA = await sha(excelBytesA);
  const pdfA = await authFetch(`/estimate-versions/${versionId}/render/pdf`);
  const pdfBytesA = Buffer.from(await pdfA.arrayBuffer());
  const pdfB = await authFetch(`/estimate-versions/${versionId}/render/pdf`);
  const pdfBytesB = Buffer.from(await pdfB.arrayBuffer());
  check(
    'PDF renders with %PDF magic, byte-deterministic',
    pdfA.status === 200 &&
      pdfBytesA.subarray(0, 4).toString('latin1') === '%PDF' &&
      pdfBytesA.equals(pdfBytesB),
  );

  // §21 — the workbook is READABLE and preserves the exact decimals (the same
  // sharedStrings assertions the browser E2E makes on its downloaded copy).
  const sharedStringsEntry = readZipEntry(excelBytesA, 'xl/sharedStrings.xml');
  const sharedStrings = sharedStringsEntry === null ? '' : sharedStringsEntry.toString('utf-8');
  check(
    'Excel workbook readable; sharedStrings preserve the exact golden decimals',
    sharedStringsEntry !== null &&
      [
        '69011321.1668',
        '57011321.1668',
        '51828473.788',
        '39868056.76',
        '38147600',
        '-1037000',
        '010101',
      ].every((exact) => sharedStrings.includes(exact)),
  );
  check(
    'PDF carries a valid document trailer (%%EOF)',
    pdfBytesA.subarray(-2048).includes('%%EOF'),
  );

  // error hygiene over the production process
  const malformed = await authFetch(`/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"broken": ',
  });
  const malformedBody = (await malformed.json()) as { error: { code: string } };
  check(
    'malformed JSON → 400 INVALID_REQUEST (not 500)',
    malformed.status === 400 && malformedBody.error.code === 'INVALID_REQUEST',
  );
  const unknown = await authFetch(`/no-such-route`);
  const unknownBody = (await unknown.json()) as { error: { code: string } };
  check(
    'unknown route → stable 404 shape',
    unknown.status === 404 && unknownBody.error.code === 'NOT_FOUND',
  );

  // §20 — the append-only story on the same estimate, with the price mix the product
  // has proven: a normal priced line (010101), the unpriced deduction 220925 (NULL
  // price) and the star item 090320. No invented prices — real 1404 rows only.
  const v2 = await call('POST', `/estimates/${estimateId}/versions`, {
    buildingId: 'building-main',
    versionId: crypto.randomUUID(),
  });
  const v2Id = (v2.data as { versionId: string }).versionId;
  check('v2 starts as a new draft on the same estimate (201)', v2.status === 201);
  const v2Lines = await call('POST', `/estimate-versions/${v2Id}/lines`, {
    lines: [
      { lineId: 'v2-1', pricebookCode: '010101', quantity: '1000', unit: 'm2' },
      { lineId: 'v2-2', pricebookCode: '220925', quantity: '40', unit: 'm2' },
      { lineId: 'v2-3', pricebookCode: '090320', quantity: '80', unit: 'kg' },
    ],
  });
  const v2Added = (v2Lines.data as { lines?: unknown[] }).lines;
  check(
    'v2 adds the priced + NULL-price + star-item mix (3 lines)',
    v2Lines.status === 200 && v2Added?.length === 3,
    `status ${String(v2Lines.status)}`,
  );
  const v2Calc = await call('POST', `/estimate-versions/${v2Id}/calculate`, COEFF);
  const v2Result = v2Calc.data as {
    rollup: { amount: string | null };
    s4Result: { finalEstimate: string | null };
  };
  check(
    'v2 calculate halts with a NULL total (NULL price ≠ 0, never faked)',
    v2Calc.status === 200 &&
      v2Result.rollup.amount === null &&
      v2Result.s4Result.finalEstimate === null,
    `finalEstimate ${String(v2Result.s4Result.finalEstimate)}`,
  );
  const v1Excel = await authFetch(`/estimate-versions/${versionId}/render/excel`);
  const v1ExcelBytes = Buffer.from(await v1Excel.arrayBuffer());
  check(
    'v1 Excel bytes unchanged after v2 (append-only, finalized snapshot)',
    v1Excel.status === 200 && (await sha(v1ExcelBytes)) === excelHashA,
  );

  return {
    projectId,
    estimateId,
    versionId,
    excelHash: excelHashA,
    pdfHash: await sha(pdfBytesA),
  };
}

async function assertSchema(pool: Pool): Promise<void> {
  const tables = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  const names = tables.rows.map((r) => r.table_name);
  check(
    'schema creates exactly the twelve S1 tables (nine domain + users/sessions/audit_events; no pricebook table)',
    names.length === 12 &&
      [
        'audit_events',
        'boq_lines',
        'estimates',
        'estimate_versions',
        'finalized_estimates',
        'finalized_takeoffs',
        'projects',
        'sessions',
        'takeoff_documents',
        'takeoff_lines',
        'takeoff_sheets',
        'users',
      ].every((t) => names.includes(t)),
    `tables: ${names.join(', ')}`,
  );
  // §19 — the migration journal must record exactly the shipped migration files
  const journal = await pool.query<{ count: string }>(
    'SELECT count(*) AS count FROM drizzle.__drizzle_migrations',
  );
  check(
    'migration journal records exactly the shipped migration files',
    Number(journal.rows[0]?.count ?? '-1') === MIGRATION_FILE_COUNT,
    `journal=${journal.rows[0]?.count ?? 'none'} files=${String(MIGRATION_FILE_COUNT)}`,
  );
  const fks = await pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public'",
  );
  check('foreign keys present', Number(fks.rows[0]?.count ?? 0) > 0);
  const uniques = await pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM information_schema.table_constraints WHERE constraint_type IN ('UNIQUE','PRIMARY KEY') AND table_schema = 'public'",
  );
  check('primary/unique constraints present', Number(uniques.rows[0]?.count ?? 0) > 0);
  const indexes = await pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM pg_indexes WHERE schemaname = 'public'",
  );
  check('indexes present', Number(indexes.rows[0]?.count ?? 0) >= 5);
  const numeric = await pool.query<{
    data_type: string;
    numeric_precision: string;
    numeric_scale: string;
  }>(
    "SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema='public' AND table_name='boq_lines' AND column_name='quantity'",
  );
  const quantityColumn = numeric.rows[0];
  check(
    'quantity stored as exact numeric (arbitrary precision, never float)',
    quantityColumn?.data_type === 'numeric',
    JSON.stringify(quantityColumn),
  );
  const jsonb = await pool.query<{ data_type: string }>(
    "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='finalized_estimates' AND column_name IN ('s4_input','s4_result','rollup','report_model')",
  );
  check(
    'finalized snapshots stored as JSONB (s4_input/s4_result/rollup/report_model)',
    jsonb.rows.length === 4 && jsonb.rows.every((r) => r.data_type === 'jsonb'),
  );
}

/**
 * pnpm's package extraction does not materialize the symlink list the platform
 * package ships (native/pg-symlinks.json), and the binaries need their bundled
 * shared libraries (libpq.so.5, libicuuc.so.60, …) on the loader path. This makes
 * the install self-contained: create missing symlinks once and export
 * LD_LIBRARY_PATH for the spawned initdb/postgres processes.
 */
function prepareEmbeddedPostgres(): void {
  const require = createRequire(import.meta.url);
  const binaries = require('@embedded-postgres/linux-x64') as { initdb: string };
  // initdb lives at <package>/native/bin/initdb; the symlink manifest's paths are
  // relative to the PACKAGE root (one level above native/).
  const packageRoot = dirname(dirname(dirname(binaries.initdb)));
  const links = JSON.parse(
    readFileSync(join(packageRoot, 'native', 'pg-symlinks.json'), 'utf-8'),
  ) as Array<{
    source: string;
    target: string;
  }>;
  for (const link of links) {
    const target = join(packageRoot, link.target);
    if (!existsSync(target)) {
      symlinkSync(relative(dirname(target), join(packageRoot, link.source)), target);
    }
  }
  const libDir = join(packageRoot, 'native', 'lib');
  process.env['LD_LIBRARY_PATH'] = [
    libDir,
    ...(process.env['LD_LIBRARY_PATH']?.split(':') ?? []),
  ].join(':');

  // The library spawns initdb/postgres with a REPLACED env (only LC_MESSAGES), which
  // would drop LD_LIBRARY_PATH/PATH. Wrap child_process.spawn — before the library is
  // imported — to merge the parent env into every spawned child instead.
  const childProcess = require('node:child_process') as unknown as {
    spawn: typeof spawn;
  };
  const realSpawn = childProcess.spawn;
  childProcess.spawn = ((
    command: Parameters<typeof spawn>[0],
    args: Parameters<typeof spawn>[1],
    options: Parameters<typeof spawn>[2],
  ) => {
    // widened to genuinely-optional so a two-argument spawn call stays safe
    const spawnOptions = options as Parameters<typeof spawn>[2] | undefined;
    return realSpawn(command, args, {
      ...spawnOptions,
      env: { ...process.env, ...(spawnOptions?.env ?? {}) },
    });
  }) as typeof spawn;
}

async function main(): Promise<void> {
  // §18 — prove fail-closed startup BEFORE anything healthy exists
  await verifyStartupFailures();
  prepareEmbeddedPostgres();
  const dataDir = mkdtempSync(join(tmpdir(), 'costgenius-smoke-'));
  console.log('[smoke] booting a REAL PostgreSQL 16.9 server (embedded-postgres, npm binaries)…');
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'smoke',
    password: 'smoke-password',
    port: PG_PORT,
    persistent: false,
    // the sandbox has no en_US.UTF-8 locale — C is always valid; appended AFTER the
    // library's own --lc-messages flag so it wins
    initdbFlags: ['--lc-messages=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('costgenius_smoke');
  const databaseUrl = `postgres://smoke:smoke-password@127.0.0.1:${String(PG_PORT)}/costgenius_smoke`;
  console.log('[smoke] PostgreSQL up; starting the PRODUCTION API process (src/index.ts)…');

  try {
    let api = startApi(databaseUrl);
    let apiLog = '';
    api.stdout?.on('data', (chunk) => {
      apiLog += String(chunk);
    });
    api.stderr?.on('data', (chunk) => {
      apiLog += String(chunk);
    });
    const healthy = await waitForHealth(60_000);
    check('production startup reaches /health (config + migrations OK)', healthy);
    if (!healthy) {
      console.log('--- API PROCESS LOG ---');
      console.log(apiLog.slice(-3000));
      throw new Error('API did not become healthy');
    }

    // fresh-database assertions BEFORE any workflow writes
    const pool = new Pool({ connectionString: databaseUrl });
    await assertSchema(pool);
    const rows = await pool.query<{ total: string }>(
      'SELECT (SELECT count(*) FROM projects) + (SELECT count(*) FROM estimates) + (SELECT count(*) FROM estimate_versions) + (SELECT count(*) FROM boq_lines) + (SELECT count(*) FROM finalized_estimates) + (SELECT count(*) FROM takeoff_documents) + (SELECT count(*) FROM takeoff_sheets) + (SELECT count(*) FROM takeoff_lines) + (SELECT count(*) FROM finalized_takeoffs) AS total',
    );
    check(
      'no seed data — the fresh database is empty (the 1404 pricebook is NOT a DB table)',
      Number(rows.rows[0]?.total ?? '-1') === 0,
    );
    const governance = await pool.query<{ users: string; sessions: string; audit_events: string }>(
      'SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM audit_events) AS audit_events',
    );
    const gov = governance.rows[0];
    check(
      'bootstrap created exactly ONE org_admin; no sessions yet; audit_events empty (bootstrap is NOT an audit event)',
      gov !== undefined && gov.users === '1' && gov.sessions === '0' && gov.audit_events === '0',
      JSON.stringify(gov ?? {}),
    );
    const passwordNeverStored = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE username = $1',
      [BOOTSTRAP_USERNAME],
    );
    check(
      'the stored password hash is a scrypt record, never the password itself',
      /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(
        passwordNeverStored.rows[0]?.password_hash ?? '',
      ),
    );

    // P8-A S1 — the authentication gate on the production path
    const anonymous = await call('GET', '/projects');
    check(
      'anonymous request → 401 UNAUTHENTICATED (fail closed, no data leak)',
      anonymous.status === 401 &&
        (anonymous.data as { error?: { code?: string } }).error?.code === 'UNAUTHENTICATED',
    );
    const wrongPassword = await call('POST', '/auth/login', {
      username: BOOTSTRAP_USERNAME,
      password: 'definitely-the-wrong-password',
    });
    check(
      'wrong password → uniform 401 AUTH_INVALID_CREDENTIALS (no enumeration)',
      wrongPassword.status === 401 &&
        (wrongPassword.data as { error?: { code?: string } }).error?.code ===
          'AUTH_INVALID_CREDENTIALS',
    );
    const badUsername = await call('POST', '/auth/login', {
      username: 'no-such-user-at-all',
      password: 'definitely-the-wrong-password',
    });
    check(
      'unknown username → the SAME uniform 401 (no user enumeration)',
      badUsername.status === 401 &&
        (badUsername.data as { error?: { code?: string } }).error?.code ===
          'AUTH_INVALID_CREDENTIALS',
    );
    await loginOnce();
    const currentSession = await call('GET', '/auth/session');
    const sessionData = currentSession.data as {
      username?: string;
      role?: string;
      userId?: string;
    };
    check(
      'login issues a cg_session cookie (HttpOnly, SameSite=Strict) and /auth/session answers the current user',
      currentSession.status === 200 && sessionData.username === BOOTSTRAP_USERNAME,
    );
    check(
      'the bootstrap admin IS org_admin (P8-A S2, CG-GOV §1.5)',
      sessionData.role === 'org_admin',
      `role=${String(sessionData.role)}`,
    );

    // P8-A S2 — the §2.3 guard rails on the production path
    const selfDeactivate = await call(
      'POST',
      `/users/${String(sessionData.userId)}/deactivate`,
      {},
    );
    check(
      'self-deactivation → 403 FORBIDDEN (guard rail)',
      selfDeactivate.status === 403 &&
        (selfDeactivate.data as { error?: { code?: string } }).error?.code === 'FORBIDDEN',
    );
    const selfDemote = await call('POST', `/users/${String(sessionData.userId)}/role`, {
      role: 'viewer',
    });
    check(
      'demoting the LAST active org_admin → 409 CANNOT_DEACTIVATE_LAST_ORG_ADMIN',
      selfDemote.status === 409 &&
        (selfDemote.data as { error?: { code?: string } }).error?.code ===
          'CANNOT_DEACTIVATE_LAST_ORG_ADMIN',
    );

    // P8-A S2 — a real lower-role account through the REAL user-management route
    const viewerCreated = await call('POST', '/users', {
      username: VIEWER_USERNAME,
      password: VIEWER_PASSWORD,
      role: 'viewer',
    });
    check(
      'org_admin creates a viewer account (201, no password material in the body)',
      viewerCreated.status === 201 &&
        !JSON.stringify(viewerCreated.data).toLowerCase().includes('password'),
    );
    const viewerDuplicate = await call('POST', '/users', {
      username: VIEWER_USERNAME,
      password: VIEWER_PASSWORD,
      role: 'viewer',
    });
    check(
      'duplicate username → 409 USERNAME_ALREADY_TAKEN',
      viewerDuplicate.status === 409 &&
        (viewerDuplicate.data as { error?: { code?: string } }).error?.code ===
          'USERNAME_ALREADY_TAKEN',
    );

    // the viewer logs in through the REAL session mechanism
    const viewerLogin = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: VIEWER_USERNAME, password: VIEWER_PASSWORD }),
    });
    const viewerSetCookie = viewerLogin.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('cg_session='));
    const viewerCookie = viewerSetCookie === undefined ? undefined : viewerSetCookie.split(';')[0];
    check('the viewer account really logs in (cg_session issued)', viewerLogin.status === 200);
    /** Raw fetch carrying the VIEWER's session (not the admin's). */
    const viewerFetch = (path: string, init?: RequestInit): Promise<Response> =>
      fetch(BASE + path, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(viewerCookie === undefined ? {} : { cookie: viewerCookie }),
        },
      });
    const authedViewer = await viewerFetch('/projects');
    const projectsBeforeCount = ((await authedViewer.json()) as unknown[]).length;
    check(
      'viewer-class READ is allowed (GET /projects → 200)',
      authedViewer.status === 200,
      `status ${String(authedViewer.status)}`,
    );
    const viewerMutation = await viewerFetch('/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: crypto.randomUUID(), title: 'ممنوع' }),
    });
    const viewerMutationBody = (await viewerMutation.json()) as {
      error?: { code?: string; details?: { requiredRole?: string } };
    };
    check(
      'viewer-class MUTATION is denied (403 FORBIDDEN, requiredRole estimator)',
      viewerMutation.status === 403 &&
        viewerMutationBody.error?.code === 'FORBIDDEN' &&
        viewerMutationBody.error.details?.requiredRole === 'estimator',
    );
    const projectsAfter = await viewerFetch('/projects');
    const projectsAfterCount = ((await projectsAfter.json()) as unknown[]).length;
    check(
      'the denied mutation had ZERO side effects (project count unchanged)',
      projectsBeforeCount === projectsAfterCount,
      `${String(projectsBeforeCount)} → ${String(projectsAfterCount)}`,
    );

    // P8-A S3 (CG-GOV §4.4) — the governance events the steps above MUST have
    // written, verified directly in the database (no audit read API exists by design)
    const auditViewerCreated = await pool.query<{
      actor_user_id: string | null;
      resource_id: string;
      details: { username?: string; role?: string };
    }>(
      "SELECT actor_user_id, resource_id, details FROM audit_events WHERE action = 'user.created'",
    );
    const viewerEvent = auditViewerCreated.rows[0];
    check(
      'user.created audit event exists — actor is the ADMIN, details carry username+role only',
      auditViewerCreated.rowCount === 1 &&
        viewerEvent !== undefined &&
        viewerEvent.actor_user_id === sessionData.userId &&
        viewerEvent.resource_id === (viewerCreated.data as { userId: string }).userId &&
        viewerEvent.details.username === VIEWER_USERNAME &&
        viewerEvent.details.role === 'viewer',
    );
    const auditLoginFailed = await pool.query<{
      actor_user_id: string | null;
      details: { username?: string };
    }>("SELECT actor_user_id, details FROM audit_events WHERE action = 'auth.login_failed'");
    const failedRows = auditLoginFailed.rows;
    check(
      'both failed logins wrote null-actor auth.login_failed events (username only, never a reason)',
      failedRows.length === 2 &&
        failedRows.every(
          (row) =>
            row.actor_user_id === null &&
            (row.details.username === BOOTSTRAP_USERNAME ||
              row.details.username === 'no-such-user-at-all'),
        ),
    );
    const auditAdminLogin = await pool.query<{ details: { username?: string } }>(
      "SELECT details FROM audit_events WHERE action = 'auth.login_succeeded' AND actor_user_id = $1",
      [sessionData.userId],
    );
    check(
      'the admin login wrote auth.login_succeeded (actor = the user)',
      (auditAdminLogin.rowCount ?? 0) >= 1 &&
        auditAdminLogin.rows[0]?.details.username === BOOTSTRAP_USERNAME,
    );
    // a denied/failed mutation wrote ZERO events (the duplicate 409 above, the
    // viewer 403 above): still exactly ONE user.created and ZERO project.created
    const auditProjectsDenied = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'project.created'",
    );
    check(
      'the RBAC-denied mutation wrote ZERO domain events (no project.created yet)',
      auditProjectsDenied.rows[0]?.count === '0',
    );
    const auditUsersTotal = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_events WHERE action = 'user.created'",
    );
    check(
      'the duplicate-username 409 wrote ZERO events (still exactly one user.created)',
      auditUsersTotal.rows[0]?.count === '1',
    );

    const first = await runWorkflow();
    // P8-A S3 (CG-GOV §4.3) — the workflow's five domain events, with exact payloads
    const auditProject = await pool.query<{
      actor_user_id: string | null;
      resource_id: string;
      project_id: string | null;
      details: { title?: string };
    }>(
      "SELECT actor_user_id, resource_id, project_id, details FROM audit_events WHERE action = 'project.created' AND resource_id = $1",
      [first.projectId],
    );
    const projectEvent = auditProject.rows[0];
    check(
      'project.created audit event — actor, resource and {title} details exact',
      auditProject.rowCount === 1 &&
        projectEvent !== undefined &&
        projectEvent.actor_user_id === sessionData.userId &&
        projectEvent.project_id === first.projectId &&
        projectEvent.details.title === 'پروژه آزمون تولیدی',
    );
    const auditVersion = await pool.query<{ details: { versionNumber?: number } }>(
      "SELECT details FROM audit_events WHERE action = 'estimate_version.created' AND resource_id = $1",
      [first.versionId],
    );
    check(
      'estimate_version.created audit event — {versionNumber: 1}',
      auditVersion.rowCount === 1 && auditVersion.rows[0]?.details.versionNumber === 1,
    );
    const auditLines = await pool.query<{ details: { count?: number; lineIds?: string[] } }>(
      "SELECT details FROM audit_events WHERE action = 'boq_lines.added' AND resource_id = $1",
      [first.versionId],
    );
    const linesEvent = auditLines.rows[0];
    check(
      'boq_lines.added audit event — ONE batch event with {count: 8, lineIds}',
      auditLines.rowCount === 1 &&
        linesEvent !== undefined &&
        linesEvent.details.count === 8 &&
        Array.isArray(linesEvent.details.lineIds) &&
        linesEvent.details.lineIds.length === 8,
    );
    const auditFinalized = await pool.query<{
      details: { rollupTotal?: string | null };
      event_id: string;
      at: string;
      actor_user_id: string | null;
    }>(
      "SELECT event_id, at, actor_user_id, details FROM audit_events WHERE action = 'estimate_version.finalized' AND resource_id = $1",
      [first.versionId],
    );
    const finalizedEvent = auditFinalized.rows[0];
    check(
      'estimate_version.finalized audit event — the golden rollup total',
      auditFinalized.rowCount === 1 &&
        finalizedEvent !== undefined &&
        finalizedEvent.details.rollupTotal === '69011321.1668' &&
        finalizedEvent.actor_user_id === sessionData.userId,
    );

    // P8-A S3 §4.4 — the viewer changes its OWN password: the event's actor is the
    // viewer; the CURRENT session survives (only other sessions are revoked)
    const viewerPasswordChange = await viewerFetch('/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        currentPassword: VIEWER_PASSWORD,
        newPassword: 'smoke-new-password-456',
      }),
    });
    const auditPassword = await pool.query<{
      actor_user_id: string | null;
      resource_id: string;
      details: Record<string, unknown>;
    }>(
      "SELECT actor_user_id, resource_id, details FROM audit_events WHERE action = 'auth.password_changed'",
    );
    const passwordEvent = auditPassword.rows[0];
    check(
      'password change → auth.password_changed (actor = the viewer, empty details, no credential material)',
      viewerPasswordChange.status === 200 &&
        auditPassword.rowCount === 1 &&
        passwordEvent !== undefined &&
        passwordEvent.actor_user_id === (viewerCreated.data as { userId: string }).userId &&
        JSON.stringify(passwordEvent.details) === '{}',
    );

    // the pre-restart audit snapshot (count + one full row, byte-compared after restart)
    const auditBeforeRestart = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM audit_events',
    );
    const auditCountBefore = auditBeforeRestart.rows[0]?.count ?? '-1';
    const finalizedEventId = finalizedEvent?.event_id ?? 'missing';

    check(
      'no stack traces or SQL in the API log',
      !/at .+\(.+\.ts:\d+\)/.test(apiLog) && !/SELECT |INSERT INTO/i.test(apiLog),
    );
    check(
      'no credential material (password/session token) in the API log',
      !apiLog.includes(BOOTSTRAP_PASSWORD) && !apiLog.includes(authCookie ?? 'cg_session='),
    );
    const sessionRow = await pool.query<{ users: string; sessions: string }>(
      'SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM sessions) AS sessions',
    );
    const liveSession = sessionRow.rows[0];
    check(
      'two users (bootstrap admin + the viewer) and two live sessions after the workflow',
      liveSession !== undefined && liveSession.users === '2' && liveSession.sessions === '2',
      JSON.stringify(liveSession ?? {}),
    );

    console.log('[smoke] SIGTERM → graceful shutdown…');
    api.kill('SIGTERM');
    const exitCode = await waitForExit(api, 30_000);
    check(
      'graceful shutdown exits cleanly with code 0',
      exitCode === 0,
      `exit=${String(exitCode)}`,
    );

    // P8-A S3 (CG-GOV §4.2/§7.3, the DEPLOYMENT.md runbook posture): provision the
    // dedicated non-owner application role and restart the API AS THAT ROLE — the
    // production process must run, serve and WRITE AUDIT EVENTS with the append-only
    // REVOKE binding it (UPDATE/DELETE on audit_events denied at the database level).
    const APP_ROLE = 'cg_smoke_app';
    const APP_ROLE_PASSWORD = 'cg-smoke-app-password-123';
    const roleExists = await pool.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      [APP_ROLE],
    );
    if (roleExists.rows[0]?.exists === true) {
      await pool.query(`DROP OWNED BY ${APP_ROLE}`);
      await pool.query(`DROP ROLE ${APP_ROLE}`);
    }
    await pool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    // the migrator's journal bootstrap (CREATE SCHEMA IF NOT EXISTS drizzle) needs
    // CREATE on the database; the grant does NOT weaken the append-only guarantee —
    // UPDATE/DELETE on audit_events are TABLE-level privileges and stay revoked
    await pool.query(`GRANT CREATE ON DATABASE costgenius_smoke TO ${APP_ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
    await pool.query(`GRANT USAGE, CREATE ON SCHEMA drizzle TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${APP_ROLE}`);
    // (CREATE on the drizzle schema: the migrator's `CREATE TABLE IF NOT EXISTS
    // __drizzle_migrations` checks the privilege even when the table exists — the
    // journal table itself stays owned by the migration role.)
    // the runbook's append-only line — everything granted, except audit history
    await pool.query(`REVOKE UPDATE, DELETE ON TABLE audit_events FROM ${APP_ROLE}`);
    const appRoleUrl = `postgres://${APP_ROLE}:${APP_ROLE_PASSWORD}@127.0.0.1:${String(PG_PORT)}/costgenius_smoke`;

    console.log('[smoke] restarting the API AS THE RESTRICTED APP ROLE (append-only binds)…');
    api = startApi(appRoleUrl);
    apiLog = '';
    api.stdout?.on('data', (chunk) => {
      apiLog += String(chunk);
    });
    api.stderr?.on('data', (chunk) => {
      apiLog += String(chunk);
    });
    const restartHealthy = await waitForHealth(60_000);
    check('restart healthy (re-running migrations is a no-op)', restartHealthy);
    if (!restartHealthy) {
      console.log('--- RESTARTED API PROCESS LOG ---');
      console.log(apiLog.slice(-3000));
      throw new Error('restricted-role API did not become healthy');
    }
    // §19 — the re-run must not duplicate schema (journal) or data (row counts)
    const journalAfter = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM drizzle.__drizzle_migrations',
    );
    check(
      'migration journal unchanged after restart (no duplicate application)',
      Number(journalAfter.rows[0]?.count ?? '-1') === MIGRATION_FILE_COUNT,
    );
    const governanceAfter = await pool.query<{ users: string; sessions: string }>(
      'SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM sessions) AS sessions',
    );
    const govAfter = governanceAfter.rows[0];
    check(
      'bootstrap ignored on restart — still exactly TWO users, and BOTH DB-backed sessions survived',
      govAfter !== undefined && govAfter.users === '2' && govAfter.sessions === '2',
      JSON.stringify(govAfter ?? {}),
    );
    const sessionAfterRestart = await call('GET', '/auth/session');
    check(
      'the pre-restart cg_session cookie still authenticates (sessions live in PostgreSQL)',
      sessionAfterRestart.status === 200 &&
        (sessionAfterRestart.data as { username?: string }).username === BOOTSTRAP_USERNAME,
    );
    const totalsAfter = await pool.query<{ total: string }>(
      'SELECT (SELECT count(*) FROM projects) + (SELECT count(*) FROM estimates) + (SELECT count(*) FROM estimate_versions) + (SELECT count(*) FROM boq_lines) + (SELECT count(*) FROM finalized_estimates) + (SELECT count(*) FROM takeoff_documents) + (SELECT count(*) FROM takeoff_sheets) + (SELECT count(*) FROM takeoff_lines) + (SELECT count(*) FROM finalized_takeoffs) AS total',
    );
    check(
      'row counts exactly as the workflow left them (no duplicate data)',
      // 1 project + 1 estimate + 2 versions (v1 finalized, v2 draft) + 8+3 lines + 1 finalized
      // + the takeoff family: 2 documents (finalized + follow-up draft), 2 sheets,
      // 2+2 lines, 1 finalized snapshot
      // + the transfer: 1 estimate + 1 version + 1 transferred BOQ line
      Number(totalsAfter.rows[0]?.total ?? '-1') === 28,
      `total=${totalsAfter.rows[0]?.total ?? 'none'}`,
    );
    const persisted = await call('GET', `/estimate-versions/${first.versionId}`);
    check(
      'finalized data persisted across restart',
      persisted.status === 200 &&
        typeof (persisted.data as { finalizedAt?: string }).finalizedAt === 'string',
    );
    const excel = await authFetch(`/estimate-versions/${first.versionId}/render/excel`);
    const excelBuf = Buffer.from(await excel.arrayBuffer());
    const excelHash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', excelBuf)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    check('Excel bytes identical across restart', excelHash === first.excelHash);

    // P8-A S2 — the VIEWER's DB-backed session also survived the restart, with
    // viewer-class rights intact: export allowed, mutation still denied
    const viewerExcel = await fetch(`${BASE}/estimate-versions/${first.versionId}/render/excel`, {
      headers: { cookie: viewerCookie ?? '' },
    });
    const viewerExcelHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', Buffer.from(await viewerExcel.arrayBuffer())),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    check(
      'viewer exports the IDENTICAL Excel bytes after restart (Viewer+ renders)',
      viewerExcel.status === 200 && viewerExcelHash === first.excelHash,
    );
    const viewerDeniedAfterRestart = await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: viewerCookie ?? '' },
      body: JSON.stringify({ projectId: crypto.randomUUID(), title: 'ممنوع' }),
    });
    check(
      'viewer is STILL denied mutations after restart (403 FORBIDDEN)',
      viewerDeniedAfterRestart.status === 403,
    );

    // P8-A S1 — logout revokes the session everywhere (row deleted, cookie cleared)
    const logout = await authFetch(`/auth/logout`, { method: 'POST' });
    const logoutClears = logout.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('cg_session='));
    check(
      'logout answers 204 and clears the cg_session cookie',
      logout.status === 204 && logoutClears !== undefined && /cg_session=;/.test(logoutClears),
    );
    const afterLogout = await call('GET', '/projects');
    check(
      'after logout the same requests are 401 again (session revoked server-side)',
      afterLogout.status === 401 &&
        (afterLogout.data as { error?: { code?: string } }).error?.code === 'UNAUTHENTICATED',
    );
    // P8-A S3 — the audit history survived the restart byte-identically, and the
    // restricted-role process still WRITES events (mutation + event, one transaction)
    const auditAfterRestart = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM audit_events',
    );
    check(
      'audit history survived the restart EXACTLY (count unchanged — no read API wrote, nothing lost)',
      auditAfterRestart.rows[0]?.count === auditCountBefore,
      `${auditCountBefore} → ${auditAfterRestart.rows[0]?.count ?? 'n/a'}`,
    );
    const finalizedEventAfter = await pool.query<{
      event_id: string;
      at: string;
      actor_user_id: string | null;
      details: { rollupTotal?: string | null };
    }>('SELECT event_id, at, actor_user_id, details FROM audit_events WHERE event_id = $1', [
      finalizedEventId,
    ]);
    check(
      'the finalized event is byte-identical after restart (append-only history)',
      JSON.stringify(finalizedEventAfter.rows[0]) === JSON.stringify(finalizedEvent),
    );
    // the S1 logout check above revoked the admin cookie, so log in again for the
    // write proof — the fresh login is itself audited (auth.login_succeeded), but it
    // happens AFTER the count/byte-identity checks above, so those snapshots stay exact
    await loginOnce();
    const postRestartProject = await call('POST', '/projects', {
      projectId: crypto.randomUUID(),
      title: 'پروژه پس از راه‌اندازی',
    });
    const postRestartEvent = await pool.query<{ actor_user_id: string | null }>(
      "SELECT actor_user_id FROM audit_events WHERE action = 'project.created' AND resource_id = $1",
      [(postRestartProject.data as { projectId: string }).projectId],
    );
    check(
      'the restricted-role API still WRITES audit events (INSERT allowed for the app role)',
      postRestartProject.status === 201 &&
        postRestartEvent.rowCount === 1 &&
        postRestartEvent.rows[0]?.actor_user_id === sessionData.userId,
      `status=${String(postRestartProject.status)} rows=${String(postRestartEvent.rowCount)} actor=${String(postRestartEvent.rows[0]?.actor_user_id)}`,
    );

    // the DB-level append-only proof, straight from the application role's connection
    const pgErrorCode = (error: unknown): string => {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string') return code;
      }
      return 'no-code';
    };
    const appPool = new Pool({ connectionString: appRoleUrl });
    try {
      const tamperUpdate = await appPool
        .query("UPDATE audit_events SET action = 'tampered' WHERE action = 'project.created'")
        .then(() => 'unexpectedly-allowed', pgErrorCode);
      check(
        'audit UPDATE is DENIED for the application role (PostgreSQL 42501)',
        tamperUpdate === '42501',
        `code=${tamperUpdate}`,
      );
      const tamperDelete = await appPool
        .query('DELETE FROM audit_events')
        .then(() => 'unexpectedly-allowed', pgErrorCode);
      check(
        'audit DELETE is DENIED for the application role (PostgreSQL 42501)',
        tamperDelete === '42501',
        `code=${tamperDelete}`,
      );
    } finally {
      await appPool.end();
    }

    // drop the re-created admin session again so the exact session-count check below
    // keeps its meaning (only the viewer's session remains)
    await authFetch('/auth/logout', { method: 'POST' });

    const sessionsAfterLogout = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM sessions',
    );
    check(
      "logout deleted the ADMIN session row (the viewer's session remains — logout is per-session)",
      sessionsAfterLogout.rows[0]?.count === '1',
    );

    api.kill('SIGTERM');
    const exitCode2 = await waitForExit(api, 30_000);
    check('second shutdown also clean (exit 0)', exitCode2 === 0, `exit=${String(exitCode2)}`);
    await pool.end();
  } finally {
    await pg.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('');
  if (failures > 0) {
    console.log(`SMOKE FAILED — ${String(failures)} check(s) failed`);
    process.exit(1);
  }
  console.log('SMOKE PASSED — production path verified against a real PostgreSQL server');
}

await main();
