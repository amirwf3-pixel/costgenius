/**
 * P8-B S3 — edition binding & per-version resolution (CG-IR-PRICEBOOK-SPEC@0.2.0
 * §12/§13/§16/§17, D-PB-3 = B).
 *
 * The full route-level contract over the REAL PGlite stack (actual migrations,
 * actual repositories, actual transactional unit of work, actual session cookies):
 *
 * - VERSION CREATION — the selection matrix: omitted editionId → the ACTIVE edition
 *   (409 EDITION_NOT_ACTIVE in the 0-active state); explicit ACTIVE bound exactly;
 *   explicit ARCHIVED bound exactly (legal even at zero ACTIVE — the contract-edition
 *   driver); DRAFT → 409 EDITION_NOT_SELECTABLE (never selectable for new work);
 *   unknown → 404 EDITION_NOT_FOUND. Every denial: zero mutation, zero events.
 * - AUDIT — `estimate_version.created` details are exactly {versionNumber, editionId}
 *   (the additive §16 record of every version's edition binding).
 * - PER-VERSION RESOLUTION (§12, the draft-binding invariant) — with a second edition
 *   ACTIVE, a version bound to the first STILL resolves its lines against the first
 *   (shared code at the first edition's price; the other edition's only-code unknown),
 *   and an ARCHIVED bound edition remains usable forever.
 * - TAKEOFF TRANSFER (§13) — the target version's bound edition prices the transfer,
 *   never the currently ACTIVE edition.
 * - ROWS (§17) — the optional `editionId` query parameter: default ACTIVE (fail-closed
 *   at zero ACTIVE), explicit ACTIVE/ARCHIVED searched (the response's `edition` field
 *   identifies the searched edition), DRAFT → 409, unknown → 404.
 * - IMMUTABILITY — activation/archival never mutates an existing version's binding,
 *   and the database trigger refuses every rebinding/clear.
 *
 * The five-role × route authorization matrix lives in authz.test.ts (unchanged by
 * S3 — no new route, no new policy); the real-PostgreSQL proofs (the explicit
 * edition_id insert bypassing the NULL ACTIVE-stamp trigger on a real server) live
 * in the env-gated node-postgres-edition-binding suite.
 */
import { describe, beforeAll, expect, it } from 'vitest';
import type { Response as InjectResponse } from 'light-my-request';
import {
  buildAuditAwareServer,
  GOLDEN_COEFFICIENTS,
  syntheticEditionStagedFile,
  type AuditAwareServer,
  type AuditEventRow,
} from './helpers.js';
import type { UserRole } from '@costgenius/projects';

const SEED_EDITION = 'ir-1404-abniye';

function errorOf(body: unknown): { code: string; message: string; details?: unknown } {
  return (body as { error: { code: string; message: string; details?: unknown } }).error;
}

/** A created version as the API answers it (the fields the binding tests read). */
interface VersionBody {
  readonly versionId: string;
  readonly edition: string;
  readonly editionId?: string;
  readonly status: string;
  readonly lines: readonly {
    readonly lineId: string;
    readonly pricebookCode: string;
    readonly basePrice: string | null;
    readonly lineAmount: string | null;
  }[];
}

/** Posts with the given role's session cookie (no payload → no content-type). */
async function postAs(
  server: AuditAwareServer,
  role: UserRole,
  url: string,
  payload?: object,
): Promise<InjectResponse> {
  const cookie = await server.cookieFor(role);
  return payload === undefined
    ? server.app.inject({ method: 'POST', url, headers: { cookie } })
    : server.app.inject({ method: 'POST', url, headers: { cookie }, payload });
}

/** Creates a project + estimate (as the estimator) → the estimateId. */
async function createProjectAndEstimate(server: AuditAwareServer, tag: string): Promise<string> {
  const projectId = `a3b30000-0000-4000-8000-0000000000${tag.padStart(2, '0')}`;
  const estimateId = `b4c40000-0000-4000-8000-0000000000${tag.padStart(2, '0')}`;
  const project = await postAs(server, 'estimator', '/projects', {
    projectId,
    title: 'پروژه انتخاب فهرست',
  });
  if (project.statusCode !== 201)
    throw new Error(`project fixture failed: ${String(project.statusCode)}`);
  const estimate = await postAs(server, 'estimator', `/projects/${projectId}/estimates`, {
    estimateId,
    title: 'برآورد انتخاب فهرست',
  });
  if (estimate.statusCode !== 201)
    throw new Error(`estimate fixture failed: ${String(estimate.statusCode)}`);
  return estimate.json<{ estimateId: string }>().estimateId;
}

/** Creates one version (as the estimator) → status + the parsed version body. */
async function createVersion(
  server: AuditAwareServer,
  estimateId: string,
  versionId: string,
  editionId?: string,
): Promise<{ statusCode: number; body: VersionBody; version: VersionBody }> {
  const response = await postAs(server, 'estimator', `/estimates/${estimateId}/versions`, {
    buildingId: 'building-main',
    versionId,
    ...(editionId !== undefined ? { editionId } : {}),
  });
  const body = response.json<VersionBody>();
  return { statusCode: response.statusCode, body, version: body };
}

async function eventsOf(
  server: AuditAwareServer,
  action: string,
  resourceId?: string,
): Promise<readonly AuditEventRow[]> {
  const rows = await server.auditEvents();
  return rows.filter(
    (row) => row.action === action && (resourceId === undefined || row.resourceId === resourceId),
  );
}

async function totalEvents(server: AuditAwareServer): Promise<number> {
  return (await server.auditEvents()).length;
}

/** Imports a synthetic distinguishable edition as the steward (DRAFT) → its id. */
async function importEdition(server: AuditAwareServer, tag: string): Promise<string> {
  const file = syntheticEditionStagedFile(tag);
  const response = await postAs(server, 'data_steward', '/pricebook/editions', file);
  if (response.statusCode !== 201) {
    throw new Error(`edition import ${tag} failed: ${String(response.statusCode)}`);
  }
  return response.json<{ edition: { editionId: string } }>().edition.editionId;
}

/** The persisted edition_id of a version row (direct table read). */
async function storedBinding(server: AuditAwareServer, versionId: string): Promise<string | null> {
  const result = await server.pg.query<{ edition_id: string | null }>(
    'select edition_id from estimate_versions where version_id = $1',
    [versionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`version ${versionId} missing`);
  return row.edition_id;
}

async function versionRowCount(server: AuditAwareServer, versionId: string): Promise<number> {
  const result = await server.pg.query<{ n: string }>(
    'select count(*)::text as n from estimate_versions where version_id = $1',
    [versionId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/* ------------------------------------------------------------------------------------------------
 * A/B/C/D/E/F/K/L — version creation: the selection matrix, audit, RBAC
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S3 — version creation: the edition selection matrix', () => {
  let server: AuditAwareServer;
  let estimateId: string;
  let draftEditionId: string;

  beforeAll(async () => {
    server = await buildAuditAwareServer();
    // warm every role cookie so no later login writes an event mid-assertion
    await server.cookieFor('estimator');
    await server.cookieFor('viewer');
    await server.cookieFor('reviewer');
    await server.cookieFor('data_steward');
    estimateId = await createProjectAndEstimate(server, '01');
    // a synthetic DRAFT edition (rows labelled '1410') — DRAFT for the rejection test
    // until the activation test turns it ACTIVE (the steward imports; the admin
    // activates — four-eyes)
    draftEditionId = await importEdition(server, 's3-draft');
  });

  it('omitted editionId binds the ACTIVE edition — response, DB row and audit all record it (A)', async () => {
    const created = await createVersion(server, estimateId, 'binding-default-v1');
    expect(created.statusCode).toBe(201);
    expect(created.version.editionId).toBe(SEED_EDITION);
    expect(created.version.edition).toBe('1404'); // the year label derives from the bound edition's rows
    expect(await storedBinding(server, 'binding-default-v1')).toBe(SEED_EDITION);

    const events = await eventsOf(server, 'estimate_version.created', 'binding-default-v1');
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toEqual({ versionNumber: 1, editionId: SEED_EDITION });
  });

  it('an explicit ACTIVE editionId binds exactly that edition (B)', async () => {
    const created = await createVersion(
      server,
      estimateId,
      'binding-explicit-active-v2',
      SEED_EDITION,
    );
    expect(created.statusCode).toBe(201);
    expect(created.version.editionId).toBe(SEED_EDITION);
    expect(await storedBinding(server, 'binding-explicit-active-v2')).toBe(SEED_EDITION);
    const events = await eventsOf(server, 'estimate_version.created', 'binding-explicit-active-v2');
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toEqual({ versionNumber: 2, editionId: SEED_EDITION });
  });

  it('RBAC is unchanged: anonymous 401, viewer/reviewer 403 with requiredRole estimator, estimator 201 (L)', async () => {
    const anonymous = await server.rawInject({
      method: 'POST',
      url: `/estimates/${estimateId}/versions`,
      payload: { buildingId: 'b' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(errorOf(anonymous.json<Record<string, unknown>>()).code).toBe('UNAUTHENTICATED');

    for (const role of ['viewer', 'reviewer'] as const) {
      const denied = await postAs(server, role, `/estimates/${estimateId}/versions`, {
        buildingId: 'b',
        versionId: `binding-rbac-${role}-v3`,
      });
      expect(denied.statusCode).toBe(403);
      const error = errorOf(denied.json<Record<string, unknown>>());
      expect(error.code).toBe('FORBIDDEN');
      expect(error.details).toEqual({ requiredRole: 'estimator' });
    }
    expect(await versionRowCount(server, 'binding-rbac-viewer-v3')).toBe(0);
    expect(await versionRowCount(server, 'binding-rbac-reviewer-v3')).toBe(0);

    // the estimator creates with the default AND an explicit selection — both succeed
    const defaulted = await createVersion(server, estimateId, 'binding-rbac-estimator-v3');
    expect(defaulted.statusCode).toBe(201);
    const explicit = await createVersion(
      server,
      estimateId,
      'binding-rbac-estimator-v4',
      SEED_EDITION,
    );
    expect(explicit.statusCode).toBe(201);
  });

  it('a DRAFT edition is never selectable: 409 EDITION_NOT_SELECTABLE, zero mutation, zero events (D)', async () => {
    const before = await totalEvents(server);
    const denied = await createVersion(
      server,
      estimateId,
      'binding-draft-denied-v5',
      draftEditionId,
    );
    expect(denied.statusCode).toBe(409);
    expect(errorOf(denied.body)).toMatchObject({ code: 'EDITION_NOT_SELECTABLE' });
    expect(errorOf(denied.body).message).toContain('DRAFT');
    // zero mutation, zero events
    expect(await versionRowCount(server, 'binding-draft-denied-v5')).toBe(0);
    expect(await totalEvents(server)).toBe(before);
    expect(
      await eventsOf(server, 'estimate_version.created', 'binding-draft-denied-v5'),
    ).toHaveLength(0);
  });

  it('an unknown editionId is 404 EDITION_NOT_FOUND, zero mutation, zero events (E)', async () => {
    const before = await totalEvents(server);
    const denied = await createVersion(
      server,
      estimateId,
      'binding-unknown-v6',
      'ir-9999-abniye-none',
    );
    expect(denied.statusCode).toBe(404);
    expect(errorOf(denied.body)).toMatchObject({ code: 'EDITION_NOT_FOUND' });
    expect(await versionRowCount(server, 'binding-unknown-v6')).toBe(0);
    expect(await totalEvents(server)).toBe(before);
  });

  it('an explicit ARCHIVED edition binds exactly it — including while another is ACTIVE (C)', async () => {
    // activate the synthetic edition as the admin (four-eyes: the steward imported it)
    // → the seeded 1404 edition auto-archives
    const activated = await postAs(
      server,
      'org_admin',
      `/pricebook/editions/${draftEditionId}/activate`,
    );
    expect(activated.statusCode).toBe(200);
    expect(activated.json<{ status: string }>().status).toBe('ACTIVE');

    // versions so far: 1 (default) + 2 (explicit) + 3,4 (RBAC estimator) → this is #5
    const created = await createVersion(server, estimateId, 'binding-archived-v5', SEED_EDITION);
    expect(created.statusCode).toBe(201);
    expect(created.version.editionId).toBe(SEED_EDITION);
    expect(await storedBinding(server, 'binding-archived-v5')).toBe(SEED_EDITION);
    const events = await eventsOf(server, 'estimate_version.created', 'binding-archived-v5');
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toEqual({ versionNumber: 5, editionId: SEED_EDITION });
  });

  it('zero ACTIVE + omitted editionId → 409 EDITION_NOT_ACTIVE, zero mutation, zero events (F)', async () => {
    // archive the only ACTIVE edition (legal — D-PB-4 = A) → the 0-active state
    const archived = await postAs(
      server,
      'org_admin',
      `/pricebook/editions/${draftEditionId}/archive`,
    );
    expect(archived.statusCode).toBe(200);

    const before = await totalEvents(server);
    const denied = await createVersion(server, estimateId, 'binding-zero-active-v6');
    expect(denied.statusCode).toBe(409);
    expect(errorOf(denied.body)).toMatchObject({ code: 'EDITION_NOT_ACTIVE' });
    expect(await versionRowCount(server, 'binding-zero-active-v6')).toBe(0);
    expect(await totalEvents(server)).toBe(before);
  });

  it('an explicit ARCHIVED edition still binds at zero ACTIVE — the contract-edition driver (C)', async () => {
    const created = await createVersion(
      server,
      estimateId,
      'binding-archived-zero-active-v6',
      SEED_EDITION,
    );
    expect(created.statusCode).toBe(201);
    expect(created.version.editionId).toBe(SEED_EDITION);
    expect(await storedBinding(server, 'binding-archived-zero-active-v6')).toBe(SEED_EDITION);
    const events = await eventsOf(
      server,
      'estimate_version.created',
      'binding-archived-zero-active-v6',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toEqual({ versionNumber: 6, editionId: SEED_EDITION });
  });
});

/* ------------------------------------------------------------------------------------------------
 * H — per-version line resolution (§12, the draft-binding invariant)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S3 — line-add resolves against the version’s bound edition (§12)', () => {
  let server: AuditAwareServer;
  let estimateId: string;
  let otherEditionId: string;

  beforeAll(async () => {
    server = await buildAuditAwareServer();
    await server.cookieFor('estimator');
    await server.cookieFor('data_steward');
    estimateId = await createProjectAndEstimate(server, '02');
    // a second, distinguishable edition (rows labelled '1410'; 010301 priced 7777
    // instead of the official 3065000; 019999 exists only there) becomes ACTIVE —
    // the seeded 1404 edition auto-archives
    otherEditionId = await importEdition(server, 's3-resolution');
    const activated = await postAs(
      server,
      'org_admin',
      `/pricebook/editions/${otherEditionId}/activate`,
    );
    if (activated.statusCode !== 200) throw new Error('fixture activation failed');
  });

  it('a version bound to the ARCHIVED 1404 edition keeps resolving 1404 rows at 1404 prices', async () => {
    const created = await createVersion(server, estimateId, 'resolution-1404-v1', SEED_EDITION);
    expect(created.statusCode).toBe(201);
    expect(created.version.edition).toBe('1404');
    expect(created.version.editionId).toBe(SEED_EDITION);

    // 010301 is shared: 3065000 in the official 1404 dataset, 7777 in the ACTIVE 1410
    // edition — the line must price at the BOUND edition's 101000
    const added = await postAs(server, 'estimator', '/estimate-versions/resolution-1404-v1/lines', {
      lines: [{ lineId: 'l1', pricebookCode: '010301', quantity: '3', unit: 'm2' }],
    });
    expect(added.statusCode).toBe(200);
    const line = added.json<VersionBody>().lines.find((l) => l.lineId === 'l1');
    expect(line?.basePrice).toBe('3065000'); // NOT the ACTIVE edition's 7777
    expect(line?.lineAmount).toBe('9195000');

    // an official-only code that the ACTIVE edition does not carry still resolves
    const addedOfficial = await postAs(
      server,
      'estimator',
      '/estimate-versions/resolution-1404-v1/lines',
      { lines: [{ lineId: 'l2', pricebookCode: '010517', quantity: '2', unit: 'm2' }] },
    );
    expect(addedOfficial.statusCode).toBe(200);
  });

  it('a code that exists only in the ACTIVE edition does not resolve in the 1404-bound version', async () => {
    const rejected = await postAs(
      server,
      'estimator',
      '/estimate-versions/resolution-1404-v1/lines',
      { lines: [{ lineId: 'l3', pricebookCode: '019999', quantity: '1', unit: 'm2' }] },
    );
    expect(rejected.statusCode).toBe(422);
    const error = errorOf(rejected.json<Record<string, unknown>>());
    expect(error.code).toBe('BOQ_LINES_REJECTED');
    expect(JSON.stringify(error.details)).toContain('019999');
  });

  it('a new version defaults to the ACTIVE edition and prices with ITS dataset', async () => {
    const created = await createVersion(server, estimateId, 'resolution-1410-v2');
    expect(created.statusCode).toBe(201);
    expect(created.version.editionId).toBe(otherEditionId);
    // the year label derives from the ACTIVE edition's rows — '1410', not '1404'
    expect(created.version.edition).toBe('1410');

    const added = await postAs(server, 'estimator', '/estimate-versions/resolution-1410-v2/lines', {
      lines: [{ lineId: 'l1', pricebookCode: '010301', quantity: '3', unit: 'm2' }],
    });
    expect(added.statusCode).toBe(200);
    const line = added.json<VersionBody>().lines.find((l) => l.lineId === 'l1');
    expect(line?.basePrice).toBe('7777'); // the ACTIVE (bound) edition's price
    expect(line?.lineAmount).toBe('23331');

    // the official-only code 010517 does NOT exist in the 1410 edition's dataset
    const rejected = await postAs(
      server,
      'estimator',
      '/estimate-versions/resolution-1410-v2/lines',
      { lines: [{ lineId: 'l2', pricebookCode: '010517', quantity: '2', unit: 'm2' }] },
    );
    expect(rejected.statusCode).toBe(422);
  });
});

/* ------------------------------------------------------------------------------------------------
 * I — takeoff → BOQ transfer prices against the TARGET VERSION's bound edition (§13)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S3 — takeoff transfer prices against the target version’s bound edition (§13)', () => {
  let server: AuditAwareServer;
  let otherEditionId: string;

  /** project + estimate + version bound to `editionId` (as the estimator). */
  async function fixture(
    tag: string,
    editionId: string | undefined,
  ): Promise<{
    projectId: string;
    estimateId: string;
    versionId: string;
    documentId: string;
  }> {
    const projectId = `c5d60000-0000-4000-8000-0000000000${tag.padStart(2, '0')}`;
    const estimateId = `d6e70000-0000-4000-8000-0000000000${tag.padStart(2, '0')}`;
    const documentId = `e7f80000-0000-4000-8000-0000000000${tag.padStart(2, '0')}`;
    const takeoffId = `f8090000-0000-4000-8000-0000000000${tag.padStart(2, '0')}`;
    await postAs(server, 'estimator', '/projects', { projectId, title: 'پروژه انتقال' });
    await postAs(server, 'estimator', `/projects/${projectId}/estimates`, {
      estimateId,
      title: 'برآورد انتقال',
    });
    const versionId = `${estimateId}-v1`;
    const created = await createVersion(server, estimateId, versionId, editionId);
    if (created.statusCode !== 201) throw new Error('fixture version failed');
    // a finalized takeoff carrying one 010301 item (4.2 m2 dimensional)
    const createdDoc = await postAs(server, 'estimator', `/projects/${projectId}/takeoffs`, {
      takeoffId,
      documentId,
      title: 'ریز متره',
    });
    if (createdDoc.statusCode !== 201) throw new Error('fixture takeoff failed');
    const saved = await postAs(
      server,
      'estimator',
      `/projects/${projectId}/takeoffs/${documentId}/save`,
      {
        expectedRevision: 1,
        title: 'ریز متره',
        rounding: [],
        sheets: [
          {
            sheetId: 'S1',
            name: 'برگه',
            lines: [
              {
                lineId: 'A',
                rowNo: 1,
                description: 'متره آزمونی',
                itemCode: '010301',
                kind: 'addition',
                unit: 'm2',
                quantity: { type: 'dimensional', profile: 'LW', length: '2.1', width: '2' },
              },
            ],
          },
        ],
      },
    );
    if (saved.statusCode !== 200)
      throw new Error(
        `fixture save failed: ${JSON.stringify(saved.json<Record<string, unknown>>())}`,
      );
    const finalized = await postAs(
      server,
      'estimator',
      `/projects/${projectId}/takeoffs/${documentId}/finalize`,
      { expectedRevision: 2 },
    );
    if (finalized.statusCode !== 201) throw new Error('fixture finalize failed');
    return { projectId, estimateId, versionId, documentId };
  }

  beforeAll(async () => {
    server = await buildAuditAwareServer();
    await server.cookieFor('estimator');
    await server.cookieFor('data_steward');
    otherEditionId = await importEdition(server, 's3-transfer');
    const activated = await postAs(
      server,
      'org_admin',
      `/pricebook/editions/${otherEditionId}/activate`,
    );
    if (activated.statusCode !== 200) throw new Error('fixture activation failed');
  });

  it('transfers into a 1404-bound version with 1404 prices — never the ACTIVE edition’s', async () => {
    const { projectId, versionId, documentId } = await fixture('03', SEED_EDITION); // 1404 is ARCHIVED now
    const transfer = await postAs(
      server,
      'estimator',
      `/projects/${projectId}/takeoffs/${documentId}/transfer-to-boq`,
      { versionId },
    );
    expect(transfer.statusCode).toBe(200);
    const body = transfer.json<{ transferred: unknown[]; lines: { lineAmount: string }[] }>();
    expect(body.transferred).toHaveLength(1);
    // 010301 × 4.2: the BOUND 1404 edition prices 3065000 → 12873000 (the ACTIVE 1410
    // edition would price 7777 → 32663.4 — exactly what must NOT happen)
    expect(body.lines[0]?.lineAmount).toBe('12873000');

    const version = await server.app.inject({
      method: 'GET',
      url: `/estimate-versions/${versionId}`,
      headers: { cookie: await server.cookieFor('estimator') },
    });
    const line = version.json<VersionBody>().lines.find((l) => l.pricebookCode === '010301');
    expect(line?.basePrice).toBe('3065000');
  });

  it('transfers into an ACTIVE-edition-bound version with that edition’s prices (the symmetric proof)', async () => {
    const { projectId, versionId, documentId } = await fixture('04', undefined); // default = ACTIVE 1410
    const transfer = await postAs(
      server,
      'estimator',
      `/projects/${projectId}/takeoffs/${documentId}/transfer-to-boq`,
      { versionId },
    );
    expect(transfer.statusCode).toBe(200);
    const body = transfer.json<{ lines: { lineAmount: string }[] }>();
    expect(body.lines[0]?.lineAmount).toBe('32663.4'); // 7777 × 4.2 — the bound edition
  });
});

/* ------------------------------------------------------------------------------------------------
 * J — GET /pricebook/rows: the optional editionId parameter (§17)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S3 — rows search: the optional editionId parameter (§17)', () => {
  let server: AuditAwareServer;
  let otherEditionId: string;
  let draftEditionId: string;

  interface RowsBody {
    readonly edition: string;
    readonly rows: readonly { code: string; basePrice: string | null }[];
  }

  async function rows(query: string): Promise<{ statusCode: number; body: RowsBody }> {
    const response = await server.app.inject({
      method: 'GET',
      url: `/pricebook/rows${query}`,
      headers: { cookie: await server.cookieFor('viewer') },
    });
    return { statusCode: response.statusCode, body: response.json<RowsBody>() };
  }

  beforeAll(async () => {
    server = await buildAuditAwareServer();
    await server.cookieFor('viewer');
    await server.cookieFor('data_steward');
    otherEditionId = await importEdition(server, 's3-rows');
    draftEditionId = await importEdition(server, 's3-rows-draft');
  });

  it('omitted editionId searches the ACTIVE edition (the seeded 1404)', async () => {
    const response = await rows('?search=010301');
    expect(response.statusCode).toBe(200);
    expect(response.body.edition).toBe(SEED_EDITION);
    expect(response.body.rows.find((r) => r.code === '010301')?.basePrice).toBe('3065000');
  });

  it('an explicit ACTIVE editionId searches exactly that edition', async () => {
    const response = await rows(`?search=010301&editionId=${SEED_EDITION}`);
    expect(response.statusCode).toBe(200);
    expect(response.body.edition).toBe(SEED_EDITION);
    expect(response.body.rows.find((r) => r.code === '010301')?.basePrice).toBe('3065000');
  });

  it('a DRAFT editionId is never searchable: 409 EDITION_NOT_SELECTABLE', async () => {
    const response = await rows(`?search=0101&editionId=${draftEditionId}`);
    expect(response.statusCode).toBe(409);
    expect(errorOf(response.body)).toMatchObject({ code: 'EDITION_NOT_SELECTABLE' });
  });

  it('an unknown editionId is 404 EDITION_NOT_FOUND', async () => {
    const response = await rows('?search=0101&editionId=ir-9999-abniye-none');
    expect(response.statusCode).toBe(404);
    expect(errorOf(response.body)).toMatchObject({ code: 'EDITION_NOT_FOUND' });
  });

  it('after the handover: an explicit ARCHIVED editionId searches the archived edition; the default follows the new ACTIVE', async () => {
    const activated = await postAs(
      server,
      'org_admin',
      `/pricebook/editions/${otherEditionId}/activate`,
    );
    expect(activated.statusCode).toBe(200);

    // explicit ARCHIVED (the seeded 1404) — the dialog of a 1404-bound version
    const archived = await rows(`?search=010301&editionId=${SEED_EDITION}`);
    expect(archived.statusCode).toBe(200);
    expect(archived.body.edition).toBe(SEED_EDITION);
    expect(archived.body.rows.find((r) => r.code === '010301')?.basePrice).toBe('3065000');

    // omitted — the default is now the new ACTIVE edition
    const defaulted = await rows('?search=010301');
    expect(defaulted.statusCode).toBe(200);
    expect(defaulted.body.edition).toBe(otherEditionId);
    expect(defaulted.body.rows.find((r) => r.code === '010301')?.basePrice).toBe('7777');
  });

  it('zero ACTIVE + omitted editionId fails closed: 409 EDITION_NOT_ACTIVE', async () => {
    const archived = await postAs(
      server,
      'org_admin',
      `/pricebook/editions/${otherEditionId}/archive`,
    );
    expect(archived.statusCode).toBe(200);
    const response = await rows('?search=0101');
    expect(response.statusCode).toBe(409);
    expect(errorOf(response.body)).toMatchObject({ code: 'EDITION_NOT_ACTIVE' });
    // an explicit editionId still searches (fail-closed is the DEFAULT's rule only)
    const explicit = await rows(`?search=010301&editionId=${SEED_EDITION}`);
    expect(explicit.statusCode).toBe(200);
    expect(explicit.body.edition).toBe(SEED_EDITION);
  });
});

/* ------------------------------------------------------------------------------------------------
 * G — the immutable binding (§12-E/§12-F): lifecycle churn never mutates it
 * -----------------------------------------------------------------------------------------------*/

describe('P8-B S3 — the bound edition is immutable for the version’s life (§12-E/F)', () => {
  let server: AuditAwareServer;
  let estimateId: string;
  let otherEditionId: string;

  beforeAll(async () => {
    server = await buildAuditAwareServer();
    await server.cookieFor('estimator');
    await server.cookieFor('data_steward');
    estimateId = await createProjectAndEstimate(server, '05');
    otherEditionId = await importEdition(server, 's3-immutable');
  });

  it('activation and archival of editions never change a version’s binding; the DB trigger refuses rebinding', async () => {
    // a version bound to the seeded 1404 edition (then ACTIVE)
    const created = await createVersion(server, estimateId, 'immutable-v1', SEED_EDITION);
    expect(created.statusCode).toBe(201);

    // the lifecycle churns underneath: 1404 → ARCHIVED, the synthetic → ACTIVE → ARCHIVED
    const activated = await postAs(
      server,
      'org_admin',
      `/pricebook/editions/${otherEditionId}/activate`,
    );
    expect(activated.statusCode).toBe(200);
    const archived = await postAs(
      server,
      'org_admin',
      `/pricebook/editions/${otherEditionId}/archive`,
    );
    expect(archived.statusCode).toBe(200);

    // the binding is untouched — API view and stored row alike
    const version = await server.app.inject({
      method: 'GET',
      url: '/estimate-versions/immutable-v1',
      headers: { cookie: await server.cookieFor('estimator') },
    });
    expect(version.statusCode).toBe(200);
    expect(version.json<VersionBody>().editionId).toBe(SEED_EDITION);
    expect(await storedBinding(server, 'immutable-v1')).toBe(SEED_EDITION);

    // the database trigger refuses every rebinding and every clear
    await expect(() =>
      server.pg.query(
        `update estimate_versions set edition_id = '${otherEditionId}' where version_id = 'immutable-v1'`,
      ),
    ).rejects.toThrow(/edition binding is immutable/i);
    await expect(() =>
      server.pg.query(
        `update estimate_versions set edition_id = null where version_id = 'immutable-v1'`,
      ),
    ).rejects.toThrow(/edition binding is immutable/i);
    expect(await storedBinding(server, 'immutable-v1')).toBe(SEED_EDITION);
  });

  it('the bound version still accepts its own edition’s lines and finalizes unchanged (§14 posture)', async () => {
    // zero ACTIVE editions right now (both archived above) — the 1404-bound version
    // still resolves 1404 rows: an archived edition remains usable by its versions
    const added = await postAs(server, 'estimator', '/estimate-versions/immutable-v1/lines', {
      lines: [{ lineId: 'l1', pricebookCode: '010101', quantity: '10', unit: 'm2' }],
    });
    expect(added.statusCode).toBe(200);
    const line = added.json<VersionBody>().lines.find((l) => l.lineId === 'l1');
    expect(line?.basePrice).toBe('2890');

    // finalize works and the binding survives into the finalized representation
    const finalized = await postAs(
      server,
      'estimator',
      '/estimate-versions/immutable-v1/finalize',
      GOLDEN_COEFFICIENTS,
    );
    expect(finalized.statusCode).toBe(201);
    expect(
      finalized.json<{ estimate: { versions: VersionBody[] } }>().estimate.versions[0]?.editionId,
    ).toBe(SEED_EDITION);
  });
});
