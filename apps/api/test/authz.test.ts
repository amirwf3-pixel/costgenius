/**
 * THE P8-A S2 route × role authorization matrix (CG-GOV-SPEC@0.1.0 §2/§3/§9).
 *
 * Every one of the 36 protected routes is probed against ALL SIX identities:
 * anonymous (→ 401 UNAUTHENTICATED) and one real DB-backed user per role
 * (org_admin, estimator, reviewer, viewer, data_steward — each with a REAL session
 * cookie from POST /auth/login; nothing is mocked at the route layer).
 *
 * For every route:
 *  - the permitted roles receive the route's NORMAL contract (200/201/204), with a
 *    fresh fixture arranged per probe where the route mutates state;
 *  - every other authenticated role receives 403 FORBIDDEN with the §2.2
 *    `details.requiredRole` of the route's class;
 *  - the denied probes (anonymous + forbidden) leave the affected state BIT-IDENTICAL
 *    — a forbidden role can never cause a mutation;
 *  - authorization happens BEFORE handler logic: a forbidden role on a bogus identity
 *    still gets 403 (never 404), and an anonymous probe on a bogus identity gets 401.
 *
 * The case table below is the executable copy of the §3 matrix and is cross-checked
 * against the ROUTE_POLICIES table in src/authz.ts — the two can never drift.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '@costgenius/projects';
import { ROUTE_POLICIES, type RoleRequirement } from '../src/authz.js';
import {
  buildRoleAwareServer,
  COMPLETE_LINES,
  GOLDEN_COEFFICIENTS,
  loginCookie,
  type RoleAwareServer,
} from './helpers.js';

const ALL_ROLES: readonly UserRole[] = [
  'org_admin',
  'estimator',
  'reviewer',
  'viewer',
  'data_steward',
];
const ESTIMATOR_PLUS: readonly UserRole[] = ['org_admin', 'estimator'];
const ORG_ADMIN_ONLY: readonly UserRole[] = ['org_admin'];

/** The §2.2 grant sets — the mirror of authz.ts for computing the forbidden set. */
const GRANTS: Record<RoleRequirement, readonly UserRole[]> = {
  any: [...ALL_ROLES],
  viewer: [...ALL_ROLES],
  estimator: [...ESTIMATOR_PLUS],
  reviewer: ['org_admin', 'reviewer'],
  org_admin: [...ORG_ADMIN_ONLY],
};

interface RouteCase {
  /** The ROUTE_POLICIES key — the case table is audited against that table. */
  readonly key: string;
  readonly method: 'GET' | 'POST';
  /** The §3 class; cross-checked against ROUTE_POLICIES[case.key]. */
  readonly requirement: RoleRequirement;
  /** Roles that must receive the route's normal contract. */
  readonly allowed: readonly UserRole[];
  /** Status the permitted roles must receive. */
  readonly allowedStatus: number;
  /** Stable URL (+ payload) for the denied probes — real fixtures, VALID bodies. */
  readonly deniedUrl: () => string;
  readonly deniedPayload?: unknown;
  /** Arranged per permitted-role probe (routes that consume shared state). */
  readonly arrange?: (
    cookie: string,
  ) => { url: string; payload?: unknown } | Promise<{ url: string; payload?: unknown }>;
  /** Shared URL/payload for permitted probes when nothing is consumed. */
  readonly url?: () => string;
  readonly payload?: unknown;
  /** Serializes the state a denied probe must not change (mutation routes). */
  readonly state?: () => Promise<string>;
}

// ─── shared fixtures (created once by the org_admin in beforeAll) ──────────────
const P0 = 'a5a5a5a5-0000-4000-8000-000000000001';
const E0 = 'a5a5a5a5-0000-4000-8000-000000000002';
let VD = ''; // draft version with the 8 golden lines (reads/previews)
let VF = ''; // FINALIZED version (renders)
let TV = ''; // transfer-target draft version
let DTD = ''; // takeoff draft (saved, revision 2)
let FTD = ''; // FINALIZED takeoff document
let VAP = ''; // S4: FINALIZED estimate version, never approved (approve denied-probe target)
let TAP = ''; // S4: FINALIZED takeoff document, never approved (approve denied-probe target)
let U0 = ''; // a viewer user id (user-management denied-probe target)

const TAKEOFF_LINE = {
  lineId: 'AL1',
  rowNo: 1,
  description: 'خط آزمون',
  itemCode: '010101',
  kind: 'addition',
  unit: 'm2',
  quantity: { type: 'manual', value: '10', justification: 'آزمون' },
} as const;

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}${String(counter).padStart(6, '0')}`;
};

/** Fresh UUID-shaped id (the domain validates ProjectId/DocumentId shape). */
const nextUuid = (): string => {
  counter += 1;
  return `ce5e5e5e-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

let server: RoleAwareServer;

/** A fixture helper call that MUST succeed (arrangement failures abort the run). */
async function mustSucceed(cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await server.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { cookie },
  });
  if (response.statusCode >= 300) {
    throw new Error(`fixture ${method} ${url} → ${String(response.statusCode)} ${response.body}`);
  }
  return response;
}

/** Creates a fresh DRAFT takeoff (create + save ⇒ revision 2) on P0. */
async function freshTakeoffDraft(cookie: string): Promise<string> {
  const documentId = nextId('td-');
  await mustSucceed(cookie, 'POST', `/projects/${P0}/takeoffs`, {
    takeoffId: nextId('tk-'),
    documentId,
    title: 'ریز متره',
  });
  await mustSucceed(cookie, 'POST', `/projects/${P0}/takeoffs/${documentId}/save`, {
    expectedRevision: 1,
    title: 'ریز متره',
    sheets: [{ sheetId: 'S1', name: 'برگه', lines: [TAKEOFF_LINE] }],
    rounding: [],
  });
  return documentId;
}

/** Creates a fresh FINALIZED takeoff on P0 (create + save + finalize). */
async function freshTakeoffFinalized(cookie: string): Promise<string> {
  const documentId = await freshTakeoffDraft(cookie);
  await mustSucceed(cookie, 'POST', `/projects/${P0}/takeoffs/${documentId}/finalize`, {
    expectedRevision: 2,
  });
  return documentId;
}

/**
 * S4 (CG-GOV §5): creates a fresh FINALIZED estimate version finalized by the
 * ESTIMATOR — so ANY Reviewer+ approver (org_admin or reviewer) is four-eyes-clean
 * against the finalizer, and the approve route's normal contract (200) is observable.
 */
async function freshFinalizedVersionByEstimator(): Promise<string> {
  const estimator = await server.cookieFor('estimator');
  const versionId = await freshDraftVersion(estimator);
  await mustSucceed(estimator, 'POST', `/estimate-versions/${versionId}/lines`, {
    lines: [{ lineId: 'apl', pricebookCode: '010101', quantity: '10', unit: 'm2' }],
  });
  await mustSucceed(estimator, 'POST', `/estimate-versions/${versionId}/finalize`, {
    ...GOLDEN_COEFFICIENTS,
  });
  return versionId;
}

/** S4: a fresh FINALIZED takeoff finalized by the ESTIMATOR (four-eyes-clean). */
async function freshFinalizedTakeoffByEstimator(): Promise<string> {
  return await freshTakeoffFinalized(await server.cookieFor('estimator'));
}

/** Creates a fresh draft version (no lines) on E0. */
async function freshDraftVersion(cookie: string): Promise<string> {
  const response = await mustSucceed(cookie, 'POST', `/estimates/${E0}/versions`, {
    buildingId: 'building-main',
    versionId: nextId('vv-'),
  });
  return idOf(response, 'versionId');
}

async function adminCookie(): Promise<string> {
  return await server.cookieFor('org_admin');
}

interface Probe {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: unknown;
  readonly cookie?: string;
}

/** Typed id decode over an inject response (json() is loosely typed). */
function idOf(
  response: { json: () => unknown },
  field: 'versionId' | 'estimateId' | 'userId',
): string {
  return (response.json() as Record<string, string>)[field] ?? '';
}

/** Typed full error-body decode (code + message + details, for the leak test). */
function errorBodyOf(response: { json: () => unknown }): {
  code: string;
  message: string;
  details?: unknown;
} {
  return (response.json() as { error: { code: string; message: string; details?: unknown } }).error;
}

/** Typed error-code decode over an inject response (json() is loosely typed). */
function errorCodeOf(response: { json: () => unknown }): string {
  return (response.json() as { error: { code: string } }).error.code;
}

/** Typed FORBIDDEN-body decode (code + the §2.2 required-role detail). */
function forbiddenBodyOf(response: { json: () => unknown }): {
  code: string;
  requiredRole: string | undefined;
} {
  const error = (
    response.json() as { error: { code: string; details?: { requiredRole?: string } } }
  ).error;
  return { code: error.code, requiredRole: error.details?.requiredRole };
}

async function probe(options: Probe) {
  return await server.rawInject({
    method: options.method,
    url: options.url,
    ...(options.payload === undefined
      ? {}
      : { payload: options.payload as Record<string, unknown> }),
    ...(options.cookie === undefined ? {} : { headers: { cookie: options.cookie } }),
  });
}

beforeAll(async () => {
  server = await buildRoleAwareServer();
  const admin = await adminCookie();

  await mustSucceed(admin, 'POST', '/projects', {
    projectId: P0,
    title: 'پروژه ماتریس نقش‌ها',
  });
  await mustSucceed(admin, 'POST', `/projects/${P0}/estimates`, {
    estimateId: E0,
    title: 'برآورد ماتریس',
  });

  // draft version + the 8 golden lines (reads and stateless previews)
  VD = await freshDraftVersion(admin);
  await mustSucceed(admin, 'POST', `/estimate-versions/${VD}/lines`, {
    lines: COMPLETE_LINES.map((line, index) => ({ ...line, lineId: `ml-${String(index)}` })),
  });

  // finalized version (renders): draft + lines + finalize
  const toFinalize = await freshDraftVersion(admin);
  await mustSucceed(admin, 'POST', `/estimate-versions/${toFinalize}/lines`, {
    lines: COMPLETE_LINES.map((line, index) => ({ ...line, lineId: `fl-${String(index)}` })),
  });
  await mustSucceed(
    admin,
    'POST',
    `/estimate-versions/${toFinalize}/finalize`,
    GOLDEN_COEFFICIENTS,
  );
  VF = toFinalize;

  // transfer target: a second estimate with an empty draft version
  const targetEstimate = await mustSucceed(admin, 'POST', `/projects/${P0}/estimates`, {
    estimateId: nextId('te-'),
    title: 'برآورد مقصد',
  });
  const targetVersion = await mustSucceed(
    admin,
    'POST',
    `/estimates/${idOf(targetEstimate, 'estimateId')}/versions`,
    { buildingId: 'building-main', versionId: nextId('tv-') },
  );
  TV = idOf(targetVersion, 'versionId');

  // takeoff fixtures
  DTD = await freshTakeoffDraft(admin);
  FTD = await freshTakeoffFinalized(admin);

  // S4 fixtures — finalized but NEVER approved (the approve routes' denied probes)
  VAP = await freshFinalizedVersionByEstimator();
  TAP = await freshFinalizedTakeoffByEstimator();

  // a viewer user — the target of the user-management denied probes
  const viewer = await mustSucceed(admin, 'POST', '/users', {
    username: 'matrix-target',
    password: 'matrix-target-password-123',
    role: 'viewer',
  });
  U0 = idOf(viewer, 'userId');
});

/** GET a url as the admin → serialized status+body (the state snapshots). */
async function snapshot(url: string): Promise<string> {
  const response = await server.app.inject({
    method: 'GET',
    url,
    headers: { cookie: await adminCookie() },
  });
  return `${String(response.statusCode)}:${response.body}`;
}

// ─── THE §3 MATRIX (executable copy — cross-checked against ROUTE_POLICIES) ───
const CASES: readonly RouteCase[] = [
  // #30–#32 — the auth surface: any authenticated role (self-service)
  {
    key: 'POST /auth/logout',
    method: 'POST',
    requirement: 'any',
    allowed: ALL_ROLES,
    allowedStatus: 204,
    deniedUrl: () => '/auth/logout',
  },
  {
    key: 'GET /auth/session',
    method: 'GET',
    requirement: 'any',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => '/auth/session',
  },
  {
    key: 'POST /auth/password',
    method: 'POST',
    requirement: 'any',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => '/auth/password',
    deniedPayload: { currentPassword: 'probe-password-123', newPassword: 'probe-password-456' },
  },
  // #33–#36 — user management: org_admin only (CG-GOV §2.3)
  {
    key: 'POST /users',
    method: 'POST',
    requirement: 'org_admin',
    allowed: ORG_ADMIN_ONLY,
    allowedStatus: 201,
    deniedUrl: () => '/users',
    deniedPayload: {
      username: 'denied-probe-user',
      password: 'denied-probe-password-123',
      role: 'viewer',
    },
    state: () => snapshot('/users'),
    arrange: () => ({
      url: '/users',
      payload: { username: nextId('mu-'), password: 'created-user-password-123', role: 'reviewer' },
    }),
  },
  {
    key: 'GET /users',
    method: 'GET',
    requirement: 'org_admin',
    allowed: ORG_ADMIN_ONLY,
    allowedStatus: 200,
    deniedUrl: () => '/users',
  },
  {
    key: 'POST /users/:userId/role',
    method: 'POST',
    requirement: 'org_admin',
    allowed: ORG_ADMIN_ONLY,
    allowedStatus: 200,
    deniedUrl: () => `/users/${U0}/role`,
    // a role the target does NOT hold — a gate-less run would really mutate
    deniedPayload: { role: 'reviewer' },
    state: () => snapshot('/users'),
    arrange: async (cookie) => {
      const created = await mustSucceed(cookie, 'POST', '/users', {
        username: nextId('ru-'),
        password: 'role-target-password-123',
        role: 'viewer',
      });
      return {
        url: `/users/${idOf(created, 'userId')}/role`,
        payload: { role: 'reviewer' },
      };
    },
  },
  {
    key: 'POST /users/:userId/deactivate',
    method: 'POST',
    requirement: 'org_admin',
    allowed: ORG_ADMIN_ONLY,
    allowedStatus: 200,
    deniedUrl: () => `/users/${U0}/deactivate`,
    state: () => snapshot('/users'),
    arrange: async (cookie) => {
      const created = await mustSucceed(cookie, 'POST', '/users', {
        username: nextId('du-'),
        password: 'deact-target-password-123',
        role: 'viewer',
      });
      return { url: `/users/${idOf(created, 'userId')}/deactivate` };
    },
  },
  // #2–#16 — the estimate vertical slice
  {
    key: 'POST /projects',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 201,
    deniedUrl: () => '/projects',
    deniedPayload: { projectId: nextUuid(), title: 'پروژه ممنوع' },
    state: () => snapshot('/projects'),
    arrange: () => ({
      url: '/projects',
      payload: { projectId: nextUuid(), title: 'پروژه مجاز' },
    }),
  },
  {
    key: 'GET /projects',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => '/projects',
  },
  {
    key: 'GET /projects/:projectId',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}`,
  },
  {
    key: 'GET /pricebook/rows',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => '/pricebook/rows?search=010101&limit=5',
  },
  {
    key: 'GET /projects/:projectId/estimates',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/estimates`,
  },
  {
    key: 'POST /projects/:projectId/estimates',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 201,
    deniedUrl: () => `/projects/${P0}/estimates`,
    deniedPayload: { estimateId: 'denied-probe-estimate', title: 'برآورد ممنوع' },
    state: () => snapshot(`/projects/${P0}/estimates`),
    arrange: () => ({
      url: `/projects/${P0}/estimates`,
      payload: { estimateId: nextId('ne-'), title: 'برآورد مجاز' },
    }),
  },
  {
    key: 'GET /estimates/:estimateId',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => `/estimates/${E0}`,
  },
  {
    key: 'POST /estimates/:estimateId/versions',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 201,
    deniedUrl: () => `/estimates/${E0}/versions`,
    deniedPayload: { buildingId: 'building-main', versionId: 'denied-probe-version' },
    state: () => snapshot(`/estimates/${E0}`),
    arrange: () => ({
      url: `/estimates/${E0}/versions`,
      payload: { buildingId: 'building-main', versionId: nextId('nv-') },
    }),
  },
  {
    key: 'GET /estimate-versions/:versionId',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => `/estimate-versions/${VD}`,
  },
  {
    key: 'POST /estimate-versions/:versionId/lines',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 200,
    deniedUrl: () => `/estimate-versions/${VD}/lines`,
    deniedPayload: {
      lines: [{ lineId: 'denied-probe-line', pricebookCode: '010101', quantity: '1', unit: 'm2' }],
    },
    state: () => snapshot(`/estimate-versions/${VD}`),
    arrange: () => ({
      url: `/estimate-versions/${VD}/lines`,
      payload: {
        lines: [{ lineId: nextId('nl-'), pricebookCode: '010101', quantity: '1', unit: 'm2' }],
      },
    }),
  },
  {
    key: 'POST /takeoff/quantities/preview',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 200,
    deniedUrl: () => '/takeoff/quantities/preview',
    deniedPayload: {
      items: [{ itemKey: 'q1', kind: 'addition', unit: 'm2', count: '2', length: '3', width: '4' }],
    },
    url: () => '/takeoff/quantities/preview',
    payload: {
      items: [{ itemKey: 'q1', kind: 'addition', unit: 'm2', count: '2', length: '3', width: '4' }],
    },
  },
  {
    key: 'POST /estimate-versions/:versionId/calculate',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 200,
    deniedUrl: () => `/estimate-versions/${VD}/calculate`,
    deniedPayload: GOLDEN_COEFFICIENTS,
    url: () => `/estimate-versions/${VD}/calculate`,
    payload: GOLDEN_COEFFICIENTS,
  },
  {
    key: 'POST /estimate-versions/:versionId/finalize',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 201,
    deniedUrl: () => `/estimate-versions/${VD}/finalize`,
    deniedPayload: GOLDEN_COEFFICIENTS,
    state: () => snapshot(`/estimate-versions/${VD}`),
    arrange: async (cookie) => {
      const versionId = await freshDraftVersion(cookie);
      await mustSucceed(cookie, 'POST', `/estimate-versions/${versionId}/lines`, {
        lines: [{ lineId: 'fl1', pricebookCode: '010101', quantity: '10', unit: 'm2' }],
      });
      return { url: `/estimate-versions/${versionId}/finalize`, payload: GOLDEN_COEFFICIENTS };
    },
  },
  // #37 — S4 estimate sign-off: Reviewer+ (CG-GOV §3/§5)
  {
    key: 'POST /estimate-versions/:versionId/approve',
    method: 'POST',
    requirement: 'reviewer',
    allowed: ['org_admin', 'reviewer'],
    allowedStatus: 200,
    deniedUrl: () => `/estimate-versions/${VAP}/approve`,
    state: () => snapshot(`/estimate-versions/${VAP}`),
    // finalized by the ESTIMATOR per probe — the approver is never the finalizer
    arrange: async () => ({
      url: `/estimate-versions/${await freshFinalizedVersionByEstimator()}/approve`,
    }),
  },
  {
    key: 'GET /estimate-versions/:versionId/render/excel',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => `/estimate-versions/${VF}/render/excel`,
  },
  {
    key: 'GET /estimate-versions/:versionId/render/pdf',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => `/estimate-versions/${VF}/render/pdf`,
  },
  // #17–#28 — the D-016 takeoff family
  {
    key: 'POST /projects/:projectId/takeoffs',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 201,
    deniedUrl: () => `/projects/${P0}/takeoffs`,
    deniedPayload: {
      takeoffId: 'denied-probe-takeoff',
      documentId: 'denied-probe-document',
      title: 'ممنوع',
    },
    state: () => snapshot(`/projects/${P0}/takeoffs`),
    arrange: () => ({
      url: `/projects/${P0}/takeoffs`,
      payload: { takeoffId: nextId('nt-'), documentId: nextId('nd-'), title: 'مجاز' },
    }),
  },
  {
    key: 'GET /projects/:projectId/takeoffs',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/takeoffs`,
  },
  {
    key: 'GET /projects/:projectId/takeoffs/:documentId',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/takeoffs/${DTD}`,
  },
  {
    key: 'POST /projects/:projectId/takeoffs/:documentId/save',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/takeoffs/${DTD}/save`,
    deniedPayload: { expectedRevision: 2, title: 'ریز متره', sheets: [], rounding: [] },
    state: () => snapshot(`/projects/${P0}/takeoffs/${DTD}`),
    arrange: async (cookie) => {
      const documentId = await freshTakeoffDraft(cookie);
      return {
        url: `/projects/${P0}/takeoffs/${documentId}/save`,
        payload: {
          expectedRevision: 2,
          title: 'ریز متره',
          sheets: [{ sheetId: 'S1', name: 'برگه', lines: [TAKEOFF_LINE] }],
          rounding: [],
        },
      };
    },
  },
  {
    key: 'POST /projects/:projectId/takeoffs/:documentId/archive',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/takeoffs/${DTD}/archive`,
    deniedPayload: { expectedRevision: 2 },
    state: () => snapshot(`/projects/${P0}/takeoffs/${DTD}`),
    arrange: async (cookie) => {
      const documentId = await freshTakeoffDraft(cookie);
      return {
        url: `/projects/${P0}/takeoffs/${documentId}/archive`,
        payload: { expectedRevision: 2 },
      };
    },
  },
  {
    key: 'POST /projects/:projectId/takeoffs/:documentId/unarchive',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/takeoffs/${DTD}/unarchive`,
    deniedPayload: { expectedRevision: 2 },
    state: () => snapshot(`/projects/${P0}/takeoffs/${DTD}`),
    arrange: async (cookie) => {
      const documentId = await freshTakeoffDraft(cookie);
      await mustSucceed(cookie, 'POST', `/projects/${P0}/takeoffs/${documentId}/archive`, {
        expectedRevision: 2,
      });
      return {
        url: `/projects/${P0}/takeoffs/${documentId}/unarchive`,
        payload: { expectedRevision: 2 },
      };
    },
  },
  {
    key: 'POST /projects/:projectId/takeoffs/:documentId/finalize',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 201,
    deniedUrl: () => `/projects/${P0}/takeoffs/${DTD}/finalize`,
    deniedPayload: { expectedRevision: 2 },
    state: () => snapshot(`/projects/${P0}/takeoffs/${DTD}`),
    arrange: async (cookie) => {
      const documentId = await freshTakeoffDraft(cookie);
      return {
        url: `/projects/${P0}/takeoffs/${documentId}/finalize`,
        payload: { expectedRevision: 2 },
      };
    },
  },
  // #38 — S4 takeoff sign-off: Reviewer+ (CG-GOV §3/§5)
  {
    key: 'POST /projects/:projectId/takeoffs/:documentId/approve',
    method: 'POST',
    requirement: 'reviewer',
    allowed: ['org_admin', 'reviewer'],
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/takeoffs/${TAP}/approve`,
    state: () => snapshot(`/projects/${P0}/takeoffs/${TAP}`),
    // finalized by the ESTIMATOR per probe — the approver is never the finalizer
    arrange: async () => ({
      url: `/projects/${P0}/takeoffs/${await freshFinalizedTakeoffByEstimator()}/approve`,
    }),
  },
  {
    key: 'POST /projects/:projectId/takeoffs/:documentId/calculate',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/takeoffs/${DTD}/calculate`,
    url: () => `/projects/${P0}/takeoffs/${DTD}/calculate`,
  },
  {
    key: 'POST /projects/:projectId/takeoffs/:documentId/follow-up',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 201,
    deniedUrl: () => `/projects/${P0}/takeoffs/${FTD}/follow-up`,
    deniedPayload: { documentId: 'denied-probe-followup' },
    state: () => snapshot(`/projects/${P0}/takeoffs/${FTD}`),
    arrange: async (cookie) => {
      const documentId = await freshTakeoffFinalized(cookie);
      return {
        url: `/projects/${P0}/takeoffs/${documentId}/follow-up`,
        payload: { documentId: nextId('fu-') },
      };
    },
  },
  {
    key: 'POST /projects/:projectId/takeoffs/:documentId/transfer-to-boq',
    method: 'POST',
    requirement: 'estimator',
    allowed: ESTIMATOR_PLUS,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/takeoffs/${FTD}/transfer-to-boq`,
    deniedPayload: { versionId: TV },
    state: async () =>
      [
        await snapshot(`/estimate-versions/${TV}`),
        await snapshot(`/projects/${P0}/takeoffs/${FTD}`),
      ].join('|'),
    arrange: async (cookie) => {
      const documentId = await freshTakeoffFinalized(cookie);
      const estimate = await mustSucceed(cookie, 'POST', `/projects/${P0}/estimates`, {
        estimateId: nextId('xe-'),
        title: 'مقصد مجاز',
      });
      const version = await mustSucceed(
        cookie,
        'POST',
        `/estimates/${idOf(estimate, 'estimateId')}/versions`,
        { buildingId: 'building-main', versionId: nextId('xv-') },
      );
      return {
        url: `/projects/${P0}/takeoffs/${documentId}/transfer-to-boq`,
        payload: { versionId: idOf(version, 'versionId') },
      };
    },
  },
  {
    key: 'GET /projects/:projectId/takeoffs/:documentId/render/excel',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/takeoffs/${FTD}/render/excel`,
  },
  {
    key: 'GET /projects/:projectId/takeoffs/:documentId/render/pdf',
    method: 'GET',
    requirement: 'viewer',
    allowed: ALL_ROLES,
    allowedStatus: 200,
    deniedUrl: () => `/projects/${P0}/takeoffs/${FTD}/render/pdf`,
  },
];

describe('P8-A S2 — the route × role authorization matrix (CG-GOV §3)', () => {
  it('the case table IS the policy table (36 protected routes, no drift)', () => {
    expect(Object.keys(ROUTE_POLICIES).length).toBe(CASES.length);
    for (const routeCase of CASES) {
      expect(ROUTE_POLICIES[routeCase.key], routeCase.key).toBe(routeCase.requirement);
    }
    // every policy key is a REAL registered route (no dead or typo'd policy entries)
    for (const key of Object.keys(ROUTE_POLICIES)) {
      const method = key.slice(0, key.indexOf(' '));
      const url = key.slice(key.indexOf(' ') + 1);
      expect(server.app.hasRoute({ method, url }), key).toBe(true);
    }
  });

  for (const routeCase of CASES) {
    it(`${routeCase.key} — ${routeCase.requirement}+`, async () => {
      const forbidden = ALL_ROLES.filter((role) => !GRANTS[routeCase.requirement].includes(role));

      // ── denied probes: anonymous → 401; forbidden roles → 403, zero mutations ──
      const before = routeCase.state === undefined ? undefined : await routeCase.state();
      const anonymous = await probe({
        method: routeCase.method,
        url: routeCase.deniedUrl(),
        ...(routeCase.deniedPayload === undefined ? {} : { payload: routeCase.deniedPayload }),
      });
      expect(anonymous.statusCode, routeCase.key).toBe(401);
      expect(errorCodeOf(anonymous)).toBe('UNAUTHENTICATED');

      for (const role of forbidden) {
        const denied = await probe({
          method: routeCase.method,
          url: routeCase.deniedUrl(),
          ...(routeCase.deniedPayload === undefined ? {} : { payload: routeCase.deniedPayload }),
          cookie: await server.cookieFor(role),
        });
        expect(denied.statusCode, `${role} on ${routeCase.key}`).toBe(403);
        const body = forbiddenBodyOf(denied);
        expect(body.code, `${role} on ${routeCase.key}`).toBe('FORBIDDEN');
        expect(body.requiredRole, `${role} on ${routeCase.key}`).toBe(
          routeCase.requirement === 'any' ? 'viewer' : routeCase.requirement,
        );
      }
      if (routeCase.state !== undefined) {
        expect(await routeCase.state(), `${routeCase.key} denied probes mutated state`).toBe(
          before,
        );
      }

      // ── permitted roles → the route's normal contract ──────────────────────────
      for (const role of routeCase.allowed) {
        let url = routeCase.url?.() ?? routeCase.deniedUrl();
        let payload = routeCase.payload ?? routeCase.deniedPayload;
        let cookie = await server.cookieFor(role);
        if (routeCase.key === 'POST /auth/logout' || routeCase.key === 'POST /auth/password') {
          // self-service probes ride a THROWAWAY session of the very role, so the
          // shared role cookies are never consumed or revoked
          const username = nextId('so-');
          await mustSucceed(await adminCookie(), 'POST', '/users', {
            username,
            password: 'self-serve-password-123',
            role,
          });
          cookie = await loginCookie(server.app, username, 'self-serve-password-123');
          if (routeCase.key === 'POST /auth/password') {
            payload = {
              currentPassword: 'self-serve-password-123',
              newPassword: 'self-serve-password-456',
            };
          }
        }
        if (routeCase.arrange !== undefined) {
          const arranged = await routeCase.arrange(await adminCookie());
          url = arranged.url;
          payload = arranged.payload;
        }
        const allowed = await probe({
          method: routeCase.method,
          url,
          ...(payload === undefined ? {} : { payload }),
          cookie,
        });
        expect(
          allowed.statusCode,
          `${role} on ${routeCase.key} → ${String(allowed.statusCode)}: ${allowed.body}`,
        ).toBe(routeCase.allowedStatus);
      }
    });
  }

  it('authorization is decided BEFORE handler logic (401/403 win over 404 on bogus ids)', async () => {
    const bogus = '00000000-0000-4000-8000-000000000000';
    // anonymous read of a bogus project → 401 (the gate runs before the 404)
    const anonymous = await probe({ method: 'GET', url: `/projects/${bogus}` });
    expect(anonymous.statusCode).toBe(401);
    // a reviewer on an estimator+ mutation of a bogus project → 403, never 404
    const reviewer = await probe({
      method: 'POST',
      url: `/projects/${bogus}/estimates`,
      payload: { estimateId: 'bogus-probe', title: 'x' },
      cookie: await server.cookieFor('reviewer'),
    });
    expect(reviewer.statusCode).toBe(403);
    expect(errorCodeOf(reviewer)).toBe('FORBIDDEN');
    // an estimator on an org_admin route with a bogus user id → 403, never 404
    const estimator = await probe({
      method: 'POST',
      url: `/users/${bogus}/role`,
      payload: { role: 'viewer' },
      cookie: await server.cookieFor('estimator'),
    });
    expect(estimator.statusCode).toBe(403);
    expect(errorCodeOf(estimator)).toBe('FORBIDDEN');
  });

  it('the 403 body never leaks roles in the message; the detail is exactly §2.2', async () => {
    const denied = await probe({
      method: 'POST',
      url: '/projects',
      payload: { projectId: 'leak-probe-project', title: 'x' },
      cookie: await server.cookieFor('viewer'),
    });
    const body = errorBodyOf(denied);
    expect(body.code).toBe('FORBIDDEN');
    expect(body.message).not.toMatch(
      /estimator|org_admin|reviewer|data_steward|\bviewer\b|role|policy/i,
    );
    // the ONLY role information is the contract-mandated details.requiredRole
    expect(JSON.stringify(body.details)).toBe(JSON.stringify({ requiredRole: 'estimator' }));
  });
});
