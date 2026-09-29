/**
 * The centralized RBAC policy (P8-A S2, CG-GOV-SPEC@0.1.0 §2/§3) — the ONE place a
 * route's required role is declared and decided. Authorization happens in the session
 * gate (server.ts) BEFORE any handler/domain work: fail fast, 401/403 without side
 * effects (CG-GOV §6). The pure calculation stack never sees roles; the handlers stay
 * role-free — they receive an already-authorized request.
 *
 * The lattice is exactly CG-GOV §2.2 (frozen):
 *   org_admin ⊇ {estimator, reviewer, viewer, data_steward}
 *   estimator ⊇ viewer;  reviewer ⊇ viewer;  data_steward ⊇ viewer
 * — estimator/reviewer/data_steward are INCOMPARABLE; this is a set-membership check,
 * never a numeric rank.
 *
 * Sign-off routes (#37/#38 of the §3 matrix, Reviewer+) joined this table with the
 * S4 sign-off stage — the two entries below are the ONLY S4 additions; every other
 * policy is unchanged since S2.
 */
import type { UserRole } from '@costgenius/projects';

/**
 * The minimum-capability class a route demands (CG-GOV §3). `'any'` = every
 * authenticated role (the S1 auth surface); the others name the MINIMUM role of their
 * class, so `requiredRoleFor` can answer the §2.2 `details:{requiredRole}` detail.
 */
export type RoleRequirement = 'any' | 'viewer' | 'estimator' | 'reviewer' | 'org_admin';

/** The role lattice as explicit grant sets (CG-GOV §2.2 — no numeric ranks). */
const ROLE_GRANTS: Readonly<Record<RoleRequirement, ReadonlySet<UserRole>>> = {
  any: new Set(['org_admin', 'estimator', 'reviewer', 'viewer', 'data_steward']),
  viewer: new Set(['org_admin', 'estimator', 'reviewer', 'viewer', 'data_steward']),
  estimator: new Set(['org_admin', 'estimator']),
  reviewer: new Set(['org_admin', 'reviewer']),
  org_admin: new Set(['org_admin']),
};

/** Does `role` satisfy `requirement`? The single authorization predicate of the API. */
export function roleSatisfies(role: UserRole, requirement: RoleRequirement): boolean {
  return ROLE_GRANTS[requirement].has(role);
}

/** The `details.requiredRole` of the §2.2 403 body (the minimum role of the class). */
export function requiredRoleFor(requirement: RoleRequirement): UserRole {
  return requirement === 'any' ? 'viewer' : requirement;
}

/**
 * THE route-policy mapping (CG-GOV §3, frozen matrix) — every protected route of the
 * API, keyed exactly as Fastify registers it (`${method} ${url}`). Auditable in one
 * place: this table IS the authorization matrix, in spec order (#2–#36).
 *
 * A route key missing from this table falls back to `org_admin` (fail closed) — a
 * forgotten policy can never widen access.
 */
export const ROUTE_POLICIES: Readonly<Record<string, RoleRequirement>> = {
  // #30–#32 — the S1 auth surface: any authenticated role (self-service)
  'POST /auth/logout': 'any',
  'GET /auth/session': 'any',
  'POST /auth/password': 'any',
  // #33–#36 — user management: org_admin only (CG-GOV §2.3)
  'POST /users': 'org_admin',
  'GET /users': 'org_admin',
  'POST /users/:userId/role': 'org_admin',
  'POST /users/:userId/deactivate': 'org_admin',
  // #2–#14 — the estimate vertical slice
  'POST /projects': 'estimator',
  'GET /projects': 'viewer',
  'GET /projects/:projectId': 'viewer',
  'GET /pricebook/rows': 'viewer',
  'GET /projects/:projectId/estimates': 'viewer',
  'POST /projects/:projectId/estimates': 'estimator',
  'GET /estimates/:estimateId': 'viewer',
  'POST /estimates/:estimateId/versions': 'estimator',
  'GET /estimate-versions/:versionId': 'viewer',
  'POST /estimate-versions/:versionId/lines': 'estimator',
  'POST /takeoff/quantities/preview': 'estimator',
  'POST /estimate-versions/:versionId/calculate': 'estimator',
  'POST /estimate-versions/:versionId/finalize': 'estimator',
  // #15/#16 — renders/exports are reads: Viewer+ (CG-GOV §3 rationale)
  'GET /estimate-versions/:versionId/render/excel': 'viewer',
  'GET /estimate-versions/:versionId/render/pdf': 'viewer',
  // #37 — estimate sign-off: Reviewer+ (CG-GOV §3/§5, S4)
  'POST /estimate-versions/:versionId/approve': 'reviewer',
  // #17–#28 — the D-016 takeoff family
  'POST /projects/:projectId/takeoffs': 'estimator',
  'GET /projects/:projectId/takeoffs': 'viewer',
  'GET /projects/:projectId/takeoffs/:documentId': 'viewer',
  'POST /projects/:projectId/takeoffs/:documentId/save': 'estimator',
  'POST /projects/:projectId/takeoffs/:documentId/archive': 'estimator',
  'POST /projects/:projectId/takeoffs/:documentId/unarchive': 'estimator',
  'POST /projects/:projectId/takeoffs/:documentId/finalize': 'estimator',
  'POST /projects/:projectId/takeoffs/:documentId/calculate': 'estimator',
  'POST /projects/:projectId/takeoffs/:documentId/follow-up': 'estimator',
  'POST /projects/:projectId/takeoffs/:documentId/transfer-to-boq': 'estimator',
  'GET /projects/:projectId/takeoffs/:documentId/render/excel': 'viewer',
  'GET /projects/:projectId/takeoffs/:documentId/render/pdf': 'viewer',
  // #38 — takeoff sign-off: Reviewer+ (CG-GOV §3/§5, S4)
  'POST /projects/:projectId/takeoffs/:documentId/approve': 'reviewer',
};

/** The policy of a request's route — missing keys fail closed to `org_admin`. */
export function routeRequirement(routeKey: string): RoleRequirement {
  return ROUTE_POLICIES[routeKey] ?? 'org_admin';
}

/**
 * The 403 of CG-GOV §2.2: authenticated but insufficient role. Same stable shape as
 * every CostGenius error, code `FORBIDDEN`, with the contract's machine-readable
 * `details.requiredRole` (the minimum role of the route's class). The MESSAGE is
 * generic on purpose — it never names roles, policies or route ids.
 */
export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  readonly status = 403;
  readonly requiredRole: UserRole;

  constructor(requiredRole: UserRole) {
    super('you do not have permission to perform this action');
    this.name = 'ForbiddenError'; // stable discriminator for the error mapper (errors.ts)
    this.requiredRole = requiredRole;
  }
}
