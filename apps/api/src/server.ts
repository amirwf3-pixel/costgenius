/**
 * The API server — a thin HTTP orchestration boundary over the `projects` application
 * layer (Phase 15). Every route is validation (Zod) → projects workflow → repository;
 * there is deliberately NO direct database access, no pricebook lookup, no calculation
 * and no rendering logic here: S2/S3/S4, the BOQ lifecycle and the renderers stay in
 * their owning layers, and this module only composes them.
 *
 * Dependency injection: repositories, dataset and clock are injected via
 * `createApiServer(deps)` — no global singleton, no hidden state. The production
 * composition root (composition.ts/index.ts) builds the real PostgreSQL stack; tests
 * inject PGlite-backed repositories and a fixed clock for determinism.
 *
 * Lifecycle exposed (exactly the `projects` surface, nothing invented):
 * createProject → createEstimateForProject → startEstimateVersion → addEstimateLines →
 * calculateEstimateVersion (preview, not persisted) → finalizeEstimate (persisted
 * atomically) → renderEstimateExcel/renderEstimatePdf (from the reloaded snapshot).
 */
import { ForbiddenError, requiredRoleFor, roleSatisfies, routeRequirement } from './authz.js';
import { appendAuditEvent, type Transact } from './audit.js';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type {
  EstimateRepository,
  FinalizedEstimate,
  FinalizedEstimateRepository,
  FinalizedTakeoff,
  FinalizedTakeoffRepository,
  PricebookEditionRepository,
  ProjectRepository,
  TakeoffDocument,
  TakeoffDocumentLine,
  TakeoffDocumentRepository,
  TakeoffDocumentSheet,
  TakeoffLineInput,
  RoundingRuleEntry,
} from '@costgenius/projects';
import type { PricebookEdition, PublishedDataset } from '@costgenius/pricebook';
import { PricebookEditionError } from '@costgenius/pricebook';
import type {
  Actor,
  AuditEventRepository,
  SessionRecord,
  SessionStore,
  User,
  UserStore,
} from '@costgenius/projects';
import {
  boqLinesAdded,
  ensureNotSelfApproval,
  ensureNotYetApproved,
  estimateCreated,
  estimateVersionApproved,
  estimateVersionCreated,
  estimateVersionFinalized,
  projectCreated,
  requireApprovalInstant,
  takeoffDocumentApproved,
  takeoffDocumentArchived,
  takeoffDocumentCreated,
  takeoffDocumentFinalized,
  takeoffDocumentFollowUpCreated,
  takeoffDocumentSaved,
  takeoffDocumentTransferredToBoq,
  takeoffDocumentUnarchived,
} from '@costgenius/projects';
import {
  AuthError,
  changePassword,
  clearedSessionCookie,
  loginUser,
  logoutUser,
  resolveAuthenticatedRequest,
  sessionCookie,
  sessionTokenFromCookieHeader,
  type AuthDependencies,
} from './auth.js';
import { createUser, changeUserRole, deactivateUser, listUsers } from './user-management.js';
import {
  addEstimateLines,
  archiveTakeoffDocument,
  calculateEstimateVersion,
  computeTakeoffQuantities,
  createEstimateForProject,
  createFollowUpTakeoffDocument,
  createProject,
  createTakeoffDocument,
  currentVersionOf,
  finalizeEstimate,
  finalizeTakeoffDocument,
  previewTakeoffDocumentCalculation,
  ProjectsError,
  renderEstimateExcel,
  renderEstimatePdf,
  renderTakeoffExcel,
  renderTakeoffPdf,
  saveTakeoffDocumentDraft,
  transferTakeoffToVersion,
  startEstimateVersion,
  takeoffInputOf,
  unarchiveTakeoffDocument,
  type EstimateCoefficientInputs,
  type EstimateLineInput,
  type TakeoffQuantity,
} from '@costgenius/projects';
import { mapError, notFound } from './errors.js';
import {
  activatePricebookEdition,
  archivePricebookEdition,
  importPricebookEdition,
  type PricebookLifecycleDependencies,
} from './pricebook-lifecycle.js';
import { ActiveEditionDatasets } from './edition-datasets.js';
import {
  addLinesSchema,
  archiveTakeoffSchema,
  calculateSchema,
  createEstimateSchema,
  createProjectSchema,
  createUserSchema,
  createTakeoffSchema,
  createVersionSchema,
  finalizeSchema,
  finalizeTakeoffSchema,
  followUpTakeoffSchema,
  loginSchema,
  passwordChangeSchema,
  editionIdParamSchema,
  pricebookImportBodySchema,
  pricebookLookupQuerySchema,
  projectIdParamSchema,
  saveTakeoffDraftSchema,
  takeoffDocumentParamsSchema,
  takeoffTransferSchema,
  takeoffPreviewSchema,
  unarchiveTakeoffSchema,
  type CoefficientInputsRequest,
  type RoundingRuleEntryRequest,
  type TakeoffLineRequest,
  type TakeoffQuantityRequest,
  type TakeoffSheetRequest,
} from './schemas.js';
import { roleChangeSchema, userIdParamSchema } from './schemas.js';

/** The authenticated request context set by the auth middleware (P8-A S1). */
export interface RequestContext {
  /** The acting user — never the password hash (CG-GOV §1.2). */
  readonly user: Omit<User, 'passwordHash'>;
  readonly session: SessionRecord;
  /** The opaque session token (needed by logout to delete the row). Never logged. */
  readonly token: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication middleware; undefined on public routes (P8-A S1). */
    auth?: RequestContext;
  }
}

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_CONTENT_TYPE = 'application/pdf';

export interface ApiDependencies {
  readonly repositories: {
    readonly projects: ProjectRepository;
    readonly estimates: EstimateRepository;
    readonly finalized: FinalizedEstimateRepository;
    readonly takeoffDocuments: TakeoffDocumentRepository;
    readonly finalizedTakeoffs: FinalizedTakeoffRepository;
    /**
     * P8-B S1: the pricebook-edition registry (CG-IR-PRICEBOOK-SPEC@0.2.0 §18). No S1
     * route consumes it yet (the lifecycle API is S2); the first-boot seed and the
     * S2/S3 edition work bind through here.
     */
    readonly editions: PricebookEditionRepository;
  };
  /**
   * Governance stores (P8-A S1, CG-GOV@0.1.0): authentication/session identity ONLY —
   * RBAC enforcement, audit events and reviewer sign-off are later stages and nothing
   * here authorizes by role yet.
   */
  readonly governance: {
    readonly users: UserStore;
    readonly sessions: SessionStore;
    /** S3: the append-only audit writer (pool-bound — standalone events like `auth.login_failed`). */
    readonly audit: AuditEventRepository;
  };
  readonly dataset: PublishedDataset;
  /** Injected clock (ISO instant) — the server never reads the clock itself. */
  readonly clock: () => string;
  /**
   * S3 (CG-GOV §4.2): the transactional unit of work — every audited mutation runs
   * its repository write and its audit append on ONE transaction (commit or roll
   * back together; a failed mutation leaves zero events).
   */
  readonly transact: Transact;
}

function coefficientsOf(body: CoefficientInputsRequest): EstimateCoefficientInputs {
  // Mechanical mapping from the parsed request to the engine input (no rule added):
  // optional fields are only carried when present (exactOptionalPropertyTypes).
  return {
    floor: body.floor,
    overhead: body.overhead,
    regional: {
      parts: body.regional.parts.map((part) => ({
        ...(part.regionId !== undefined ? { regionId: part.regionId } : {}),
        coefficient: part.coefficient,
        executionCost: part.executionCost,
      })),
    },
    siteSetup: body.siteSetup,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Full Takeoff request → engine-shape mappers (D-016). Mechanical field-for-field copies
 * that only carry optional fields when present (exactOptionalPropertyTypes) — no rule is
 * added, interpreted or defaulted here; the persisted line/sheet shapes ARE the engine
 * input shapes, so nothing is transformed on the way in or out.
 * -----------------------------------------------------------------------------------------------*/

function takeoffQuantityOf(quantity: TakeoffQuantityRequest): TakeoffLineInput['quantity'] {
  switch (quantity.type) {
    case 'dimensional':
      return {
        type: 'dimensional',
        profile: quantity.profile,
        ...(quantity.similarCount !== undefined ? { similarCount: quantity.similarCount } : {}),
        ...(quantity.floorCount !== undefined ? { floorCount: quantity.floorCount } : {}),
        ...(quantity.length !== undefined ? { length: quantity.length } : {}),
        ...(quantity.width !== undefined ? { width: quantity.width } : {}),
        ...(quantity.height !== undefined ? { height: quantity.height } : {}),
      };
    case 'reference':
      return {
        type: 'reference',
        terms: quantity.terms.map((term) => ({
          lineId: term.lineId,
          factor: term.factor,
          use: term.use,
        })),
      };
    case 'expression':
      return { type: 'expression', node: quantity.node };
    case 'manual':
      return {
        type: 'manual',
        value: quantity.value,
        justification: quantity.justification,
      };
  }
}

function takeoffLineOf(line: TakeoffLineRequest): TakeoffDocumentLine {
  return {
    lineId: line.lineId,
    rowNo: line.rowNo,
    description: line.description,
    ...(line.location !== undefined ? { location: line.location } : {}),
    ...(line.itemCode !== undefined ? { itemCode: line.itemCode } : {}),
    kind: line.kind,
    unit: line.unit,
    quantity: takeoffQuantityOf(line.quantity),
    ...(line.notes !== undefined ? { notes: line.notes } : {}),
    ...(line.origin !== undefined ? { origin: line.origin } : {}),
    ...(line.ruleRefs !== undefined ? { ruleRefs: line.ruleRefs } : {}),
  };
}

function takeoffSheetOf(sheet: TakeoffSheetRequest): TakeoffDocumentSheet {
  return {
    sheetId: sheet.sheetId,
    name: sheet.name,
    lines: sheet.lines.map(takeoffLineOf),
  };
}

function roundingRuleOf(entry: RoundingRuleEntryRequest): RoundingRuleEntry {
  return {
    target: entry.target,
    ...(entry.selector !== undefined
      ? {
          selector: {
            ...(entry.selector.itemCode !== undefined ? { itemCode: entry.selector.itemCode } : {}),
            ...(entry.selector.unit !== undefined ? { unit: entry.selector.unit } : {}),
            ...(entry.selector.lineIds !== undefined ? { lineIds: entry.selector.lineIds } : {}),
          },
        }
      : {}),
    scale: entry.scale,
    mode: entry.mode,
    sourceStatus: entry.sourceStatus,
    ...(entry.source !== undefined
      ? {
          source: {
            sourceDocument: entry.source.sourceDocument,
            edition: entry.source.edition,
            page: entry.source.page,
            section: entry.source.section,
            ...(entry.source.sourceFileHash !== undefined
              ? { sourceFileHash: entry.source.sourceFileHash }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Loads a takeoff document strictly inside its project scope: a document of ANOTHER
 * project is indistinguishable from a missing one (404) — the D-016 project-isolation
 * contract, with no cross-project existence disclosure.
 */
async function findProjectTakeoffDocument(
  deps: ApiDependencies,
  projectId: string,
  documentId: string,
): Promise<TakeoffDocument | undefined> {
  const document = await deps.repositories.takeoffDocuments.findById(documentId);
  return document !== undefined && document.projectId === projectId ? document : undefined;
}

/** Builds the Fastify instance with all routes (Phase 15 + D-016 takeoff). Pure composition. */
export function createApiServer(deps: ApiDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = mapError(error);
    reply.code(status).send(body);
  });

  // Unknown routes answer the same stable error contract (not Fastify's default shape).
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'no such route on this API' },
    });
  });

  // ---- Authentication + authorization (P8-A S1/S2, CG-GOV-SPEC@0.1.0) --------------------
  //
  // The gate: every route below except the two public ones (GET /health,
  // POST /auth/login) requires a valid server-side session (S1), and then the
  // CENTRALIZED RBAC policy (S2, `authz.ts`) decides whether the authenticated
  // user's role satisfies the route's class — BEFORE any handler/domain work
  // (CG-GOV §6: fail fast, 401/403 without side effects). Unknown routes are
  // skipped so the stable 404 contract is unchanged; a route key missing from
  // the policy table fails closed to org_admin.
  const authDeps: AuthDependencies = {
    users: deps.governance.users,
    sessions: deps.governance.sessions,
    clock: deps.clock,
  };
  // S3: the audited governance dependencies — the same stores plus the audit writer
  // and the transaction capability (CG-GOV §4.2/§4.4).
  const auditedAuthDeps = {
    users: deps.governance.users,
    sessions: deps.governance.sessions,
    clock: deps.clock,
    audit: deps.governance.audit,
    transact: deps.transact,
  };
  /** The audit actor is ALWAYS the gate-resolved identity — never a client-supplied value (§6). */
  const actorOf = (auth: RequestContext): Actor => ({
    userId: auth.user.userId,
    username: auth.user.username,
  });

  // P8-A S4 (CG-GOV §5): the finalized-bundle responses expose the approval state
  // ADDITIVELY — `approvedBy: {userId, username} | null` and `approvedAt: string | null`
  // — and nothing else changes. `finalized_by` stays server-internal (it feeds the
  // four-eyes rule; the contract exposes the approval, not the finalizer).
  const approvalFields = async (
    approval: FinalizedEstimate['approval'],
  ): Promise<{
    approvedBy: { userId: string; username: string } | null;
    approvedAt: string | null;
  }> => {
    if (approval === null || approval === undefined) return { approvedBy: null, approvedAt: null };
    const approver = await deps.governance.users.findById(approval.approvedBy);
    if (approver === undefined) {
      // The FK guarantees the row exists; missing here is store inconsistency, not a
      // client condition — the generic 500 leaks nothing.
      throw new Error(
        `approved_by "${approval.approvedBy}" does not resolve to a persisted user; the store is inconsistent`,
      );
    }
    return {
      approvedBy: { userId: approval.approvedBy, username: approver.username },
      approvedAt: approval.approvedAt,
    };
  };

  /** A finalized-estimate bundle as the API answers it (bundle + approval state, §5). */
  const estimateBundleBody = async (
    finalized: FinalizedEstimate,
  ): Promise<Record<string, unknown>> => ({
    estimate: finalized.estimate,
    versionId: finalized.versionId,
    calculation: finalized.calculation,
    finalizedAt: finalized.finalizedAt,
    ...(await approvalFields(finalized.approval)),
  });

  /** A finalized-takeoff bundle as the API answers it (bundle + approval state, §5). */
  const takeoffBundleBody = async (
    finalized: FinalizedTakeoff,
  ): Promise<Record<string, unknown>> => ({
    document: finalized.document,
    documentId: finalized.documentId,
    takeoffId: finalized.takeoffId,
    documentNumber: finalized.documentNumber,
    finalizedAt: finalized.finalizedAt,
    input: finalized.input,
    result: finalized.result,
    ...(await approvalFields(finalized.approval)),
  });
  const publicRoutes = new Set(['GET /health', 'POST /auth/login']);

  app.addHook('preHandler', async (request, reply) => {
    // The 404 lifecycle also runs instance hooks; keep unknown routes on the 404 path.
    if (request.is404 || request.routeOptions.url === undefined) return;
    const routeKey = `${request.method} ${request.routeOptions.url}`;
    if (publicRoutes.has(routeKey)) return;
    const token = sessionTokenFromCookieHeader(request.headers.cookie);
    const unauthenticated = (): void => {
      reply.code(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'a valid session is required' },
      });
    };
    if (token === undefined || token.length === 0) {
      unauthenticated();
      return;
    }
    const auth = await resolveAuthenticatedRequest(authDeps, token);
    if (auth === undefined) {
      unauthenticated();
      return;
    }
    request.auth = { user: auth.user, session: auth.session, token };
    // P8-A S2 (CG-GOV §2.2/§3): authorization — an authenticated user whose role is
    // below the route's class gets 403 FORBIDDEN (never a 401); the thrown error is
    // mapped by the canonical error handler with the §2.2 required-role detail.
    const requirement = routeRequirement(routeKey);
    if (!roleSatisfies(auth.user.role, requirement)) {
      throw new ForbiddenError(requiredRoleFor(requirement));
    }
  });

  const requireAuth = (request: FastifyRequest): RequestContext => {
    if (request.auth === undefined)
      throw new AuthError('UNAUTHENTICATED', 'a valid session is required');
    return request.auth;
  };

  const sessionProjection = (user: Omit<User, 'passwordHash'>, expiresAt: string) => ({
    userId: user.userId,
    username: user.username,
    role: user.role,
    expiresAt,
  });

  app.post('/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await loginUser(auditedAuthDeps, body.username, body.password);
    // the token exists exactly here, in the cookie (never in a body/log/DB row)
    reply.header('set-cookie', sessionCookie(result.token, request.protocol === 'https'));
    return sessionProjection(result.user, result.expiresAt);
  });

  app.post('/auth/logout', async (request, reply) => {
    const auth = requireAuth(request);
    await logoutUser(authDeps, auth.token);
    reply.header('set-cookie', clearedSessionCookie(request.protocol === 'https'));
    reply.code(204).send();
  });

  app.get('/auth/session', (request) => {
    const auth = requireAuth(request);
    return sessionProjection(auth.user, auth.session.expiresAt);
  });

  app.post('/auth/password', async (request) => {
    const auth = requireAuth(request);
    const body = passwordChangeSchema.parse(request.body);
    const user = await changePassword(
      auditedAuthDeps,
      auth,
      body.currentPassword,
      body.newPassword,
    );
    return { userId: user.userId, username: user.username, role: user.role };
  });

  // ---- User management (P8-A S2, CG-GOV §2.3 — org_admin only via the gate) --------------
  // The route gate has already established the caller is org_admin; these handlers
  // own the target-dependent guard rails (self-deactivation, last-active-admin).

  app.post('/users', async (request, reply) => {
    const actor = actorOf(requireAuth(request));
    const body = createUserSchema.parse(request.body);
    const user = await createUser(auditedAuthDeps, actor, body);
    return await reply.code(201).send(user);
  });

  app.get('/users', async () => {
    return await listUsers(auditedAuthDeps);
  });

  app.post('/users/:userId/role', async (request) => {
    const actor = actorOf(requireAuth(request)); // org_admin established by the gate
    const userId = userIdParamSchema.parse((request.params as { userId: unknown }).userId);
    const body = roleChangeSchema.parse(request.body);
    return await changeUserRole(auditedAuthDeps, actor, userId, body.role);
  });

  app.post('/users/:userId/deactivate', async (request) => {
    const actor = actorOf(requireAuth(request));
    const userId = userIdParamSchema.parse((request.params as { userId: unknown }).userId);
    return await deactivateUser(auditedAuthDeps, actor, userId);
  });

  app.get('/health', () => ({ status: 'ok' }));

  // ---- Project ---------------------------------------------------------------------------

  app.post('/projects', async (request, reply) => {
    const auth = requireAuth(request);
    const body = createProjectSchema.parse(request.body);
    const project = createProject({
      projectId: body.projectId,
      ...(body.organizationId !== undefined ? { organizationId: body.organizationId } : {}),
      title: body.title,
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      createdAt: body.createdAt ?? deps.clock(),
    });
    // S3 (CG-GOV §4.3 #2): `project.created` fires for a real creation only — an
    // already-persisted id keeps the store's exact pre-S3 semantics (identical
    // content = idempotent no-op, different content = 409) and emits no event.
    const isNew = (await deps.repositories.projects.findById(project.projectId)) === undefined;
    await deps.transact(async (tx) => {
      await tx.projects.save(project);
      if (isNew) {
        await appendAuditEvent(tx.audit, projectCreated(actorOf(auth), project), deps.clock);
      }
    });
    return await reply.code(201).send(project);
  });

  app.get('/projects', async () => {
    // The workflow UI opens on the project list (Phase 18); deterministic order.
    return await deps.repositories.projects.list();
  });

  app.get('/projects/:projectId', async (request, reply) => {
    const projectId = projectIdParamSchema.parse(
      (request.params as { projectId: unknown }).projectId,
    );
    const project = await deps.repositories.projects.findById(projectId);
    if (project === undefined)
      return await reply.code(404).send(notFound('project', projectId).body);
    return await reply.code(200).send(project);
  });

  // ---- Pricebook (Phase 18 lookup + the P8-B S2 edition lifecycle, #39–#43) ----------------
  //
  // GET /pricebook/rows (Phase 18 UI autocomplete; presentation only): a read-only
  // filter over the published dataset for the add-line dialog's search box — it never
  // resolves estimate lines (binding stays exact-code in POST /estimate-versions/:id/
  // lines). Since P8-B S2 the searched dataset is the discipline's PERSISTED ACTIVE
  // edition (CG-IR-PB@0.2.0 §9/§17): the database is the source of truth for editions,
  // never the boot-time in-memory file. Fail-closed in the 0-active state: 409
  // EDITION_NOT_ACTIVE, never a fallback to a DRAFT/ARCHIVED/latest edition and never
  // an empty 200. Deterministic: published order, capped results.
  const editionDatasets = new ActiveEditionDatasets(deps.repositories.editions);

  app.get('/pricebook/rows', async (request, reply) => {
    const query = pricebookLookupQuerySchema.parse(request.query);
    const dataset = await editionDatasets.activeDataset();
    if (dataset === null) {
      throw new PricebookEditionError(
        'EDITION_NOT_ACTIVE',
        'no ACTIVE pricebook edition exists for the discipline (the 0-active state is legal); activate an edition to restore the default search',
      );
    }
    const needle = query.search;
    const matches = dataset.rows
      .filter((row) => row.code.startsWith(needle) || row.description.includes(needle))
      .slice(0, query.limit)
      .map((row) => ({
        code: row.code,
        chapter: row.chapter,
        group: row.group,
        description: row.description,
        unit: { code: row.unit.code, label: row.unit.label },
        basePrice: row.basePrice,
        status: row.status,
      }));
    return await reply.code(200).send({ rows: matches, edition: dataset.edition.id });
  });

  // The #39 edition representation (§17): exactly the contract's fields — identity,
  // provenance, lifecycle state and the row count; never the row bulk, never the
  // import report (that is #40's detail), never credential material.
  const editionSummary = (edition: PricebookEdition): Record<string, unknown> => ({
    editionId: edition.editionId,
    discipline: edition.discipline,
    year: edition.year,
    title: edition.title,
    organization: edition.organization,
    notificationNumber: edition.notificationNumber,
    notificationDate: edition.notificationDate,
    sourceFileHash: edition.sourceFileHash,
    contentHash: edition.contentHash,
    rowCount: edition.importReport.rowCount,
    status: edition.status,
    supersedesEditionId: edition.supersedesEditionId,
    importedBy: edition.importedBy,
    importedAt: edition.importedAt,
    activatedAt: edition.activatedAt,
    archivedAt: edition.archivedAt,
  });

  // #39 — list every edition, deterministic (importedAt, editionId) order (Viewer+).
  app.get('/pricebook/editions', async (_request, reply) => {
    const editions = await deps.repositories.editions.listEditions();
    return await reply.code(200).send({ editions: editions.map(editionSummary) });
  });

  // #40 — the edition detail, including the stored importReport (the complete
  // validation evidence). Read-only; rows stay searchable via GET /pricebook/rows.
  app.get('/pricebook/editions/:editionId', async (request, reply) => {
    const editionId = editionIdParamSchema.parse(
      (request.params as { editionId: unknown }).editionId,
    );
    const edition = await deps.repositories.editions.findByEditionId(editionId);
    if (edition === undefined) {
      throw new PricebookEditionError(
        'EDITION_NOT_FOUND',
        `no pricebook edition "${editionId}" exists`,
      );
    }
    return await reply
      .code(200)
      .send({ ...editionSummary(edition), importReport: edition.importReport });
  });

  // The shared lifecycle dependencies of the three mutations (#41–#43).
  const lifecycleDeps: PricebookLifecycleDependencies = {
    editions: deps.repositories.editions,
    transact: deps.transact,
    clock: deps.clock,
  };

  // #41 — import a staged-import JSON document as a new DRAFT edition
  // (data_steward+). The route body limit is raised above the global 1 MiB default
  // because a full staged pricebook document is larger (the verified 1404 file is
  // ~1.3 MiB); every other route keeps the default.
  app.post('/pricebook/editions', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const auth = requireAuth(request);
    const file = pricebookImportBodySchema.parse(request.body);
    const imported = await importPricebookEdition(lifecycleDeps, actorOf(auth), file);
    return await reply
      .code(201)
      .send({ edition: editionSummary(imported.edition), importReport: imported.importReport });
  });

  // #42 — DRAFT→ACTIVE / ARCHIVED→ACTIVE (data_steward+, four-eyes on DRAFT→ACTIVE):
  // atomic; the previous ACTIVE edition of the discipline is auto-archived in the same
  // transaction; both events commit with it. Empty body.
  app.post('/pricebook/editions/:editionId/activate', async (request, reply) => {
    const auth = requireAuth(request);
    const editionId = editionIdParamSchema.parse(
      (request.params as { editionId: unknown }).editionId,
    );
    const edition = await activatePricebookEdition(lifecycleDeps, actorOf(auth), editionId);
    return await reply.code(200).send(editionSummary(edition));
  });

  // #43 — DRAFT→ARCHIVED (discard) / ACTIVE→ARCHIVED (data_steward+). Archiving the
  // only ACTIVE edition is legal (D-PB-4 = A — the 0-active state); nothing is
  // auto-activated. Empty body.
  app.post('/pricebook/editions/:editionId/archive', async (request, reply) => {
    const auth = requireAuth(request);
    const editionId = editionIdParamSchema.parse(
      (request.params as { editionId: unknown }).editionId,
    );
    const edition = await archivePricebookEdition(lifecycleDeps, actorOf(auth), editionId);
    return await reply.code(200).send(editionSummary(edition));
  });

  // ---- Estimate listing (Phase 17 workflow: a project's estimates) -----------------------

  app.get('/projects/:projectId/estimates', async (request, reply) => {
    const projectId = projectIdParamSchema.parse(
      (request.params as { projectId: unknown }).projectId,
    );
    const project = await deps.repositories.projects.findById(projectId);
    if (project === undefined)
      return await reply.code(404).send(notFound('project', projectId).body);
    const list = await deps.repositories.estimates.findByProjectId(projectId);
    return await reply.code(200).send(list);
  });

  // ---- Estimate --------------------------------------------------------------------------

  app.post('/projects/:projectId/estimates', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = projectIdParamSchema.parse(
      (request.params as { projectId: unknown }).projectId,
    );
    const body = createEstimateSchema.parse(request.body);
    const project = await deps.repositories.projects.findById(projectId);
    if (project === undefined)
      return await reply.code(404).send(notFound('project', projectId).body);
    const estimate = createEstimateForProject(project, {
      estimateId: body.estimateId,
      title: body.title,
    });
    // S3 (§4.3 #7): `estimate.created` fires for a real creation only (same guard
    // rationale as POST /projects — the store stays the idempotency authority).
    const isNew = (await deps.repositories.estimates.findById(estimate.estimateId)) === undefined;
    await deps.transact(async (tx) => {
      await tx.estimates.save(estimate);
      if (isNew) {
        await appendAuditEvent(tx.audit, estimateCreated(actorOf(auth), estimate), deps.clock);
      }
    });
    return await reply.code(201).send(estimate);
  });

  app.get('/estimates/:estimateId', async (request, reply) => {
    const estimateId = (request.params as { estimateId: string }).estimateId;
    const estimate = await deps.repositories.estimates.findById(estimateId);
    if (estimate === undefined)
      return await reply.code(404).send(notFound('estimate', estimateId).body);
    return await reply.code(200).send(estimate);
  });

  // ---- EstimateVersion -------------------------------------------------------------------

  app.post('/estimates/:estimateId/versions', async (request, reply) => {
    const auth = requireAuth(request);
    const estimateId = (request.params as { estimateId: string }).estimateId;
    const body = createVersionSchema.parse(request.body);
    const estimate = await deps.repositories.estimates.findById(estimateId);
    if (estimate === undefined)
      return await reply.code(404).send(notFound('estimate', estimateId).body);
    const updated = startEstimateVersion(deps.dataset, estimate, {
      createdAt: body.createdAt ?? deps.clock(),
      buildingId: body.buildingId,
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      ...(body.versionId !== undefined ? { versionId: body.versionId } : {}),
    });
    // S3 (§4.3 #9): the version row and its event commit together; a duplicate
    // versionId is rejected by the domain BEFORE any write (zero events).
    const version = currentVersionOf(updated);
    if (version === undefined) {
      // Unreachable: startEstimateVersion just appended it.
      throw new Error('the just-started version is missing from the aggregate');
    }
    await deps.transact(async (tx) => {
      await tx.estimates.save(updated);
      await appendAuditEvent(
        tx.audit,
        estimateVersionCreated(actorOf(auth), estimate, version),
        deps.clock,
      );
    });
    return await reply.code(201).send(version);
  });

  app.get('/estimate-versions/:versionId', async (request, reply) => {
    const versionId = (request.params as { versionId: string }).versionId;
    const finalized = await deps.repositories.finalized.byVersionId(versionId);
    if (finalized !== undefined)
      return await reply.code(200).send(await estimateBundleBody(finalized));
    const estimate = await deps.repositories.estimates.findByVersionId(versionId);
    const version = estimate?.versions.find((v) => v.versionId === versionId);
    if (version === undefined)
      return await reply.code(404).send(notFound('version', versionId).body);
    return await reply.code(200).send(version);
  });

  // ---- Takeoff preview (D-015/D5-A) -------------------------------------------------------
  // Stateless dimensional quantity preview: calc-engine only, no estimate context, no
  // persistence. Exact-only (a `rounding` field is REJECTED by the strict schema, per
  // D-015/D3-A). Engine error codes are never public — UNIT_MISMATCH/INVALID_DECIMAL
  // collide with existing public codes — so every engine failure is one stable public
  // code, TAKEOFF_QUANTITIES_REJECTED, with the engine's own errors under details only.

  app.post('/takeoff/quantities/preview', async (request, reply) => {
    const body = takeoffPreviewSchema.parse(request.body);
    const result = computeTakeoffQuantities(
      takeoffInputOf(
        body.items.map((item) => ({
          itemKey: item.itemKey,
          kind: item.kind,
          unit: item.unit,
          count: item.count,
          ...(item.length !== undefined ? { length: item.length } : {}),
          ...(item.width !== undefined ? { width: item.width } : {}),
          ...(item.height !== undefined ? { height: item.height } : {}),
        })),
      ),
    );
    if (!result.ok) {
      return await reply.code(422).send({
        error: {
          code: 'TAKEOFF_QUANTITIES_REJECTED',
          message:
            'one or more takeoff items failed the quantity calculation rules; nothing was computed',
          details: { failures: result.errors },
        },
      });
    }
    return await reply.code(200).send({
      specVersion: result.specVersion,
      engineVersion: result.engineVersion,
      items: result.items.map((item) => ({
        lineId: item.lineId,
        quantity: item.quantity,
        unit: item.unit,
        takeoff: item.takeoff,
      })),
    });
  });

  // ---- Lines (exact-code binding; no client prices) --------------------------------------

  app.post('/estimate-versions/:versionId/lines', async (request, reply) => {
    const auth = requireAuth(request);
    const versionId = (request.params as { versionId: string }).versionId;
    const body = addLinesSchema.parse(request.body);
    const estimate = await deps.repositories.estimates.findByVersionId(versionId);
    if (estimate === undefined)
      return await reply.code(404).send(notFound('version', versionId).body);
    // D-015: dimensional lines carry factors, never a computed quantity — the server
    // computes the quantity via calc-engine and attaches the provenance itself. The
    // client-supplied quantity (when present) is the only value used verbatim.
    const dimensional = body.lines.filter((line) => line.takeoff !== undefined);
    const computed = new Map<string, TakeoffQuantity>();
    if (dimensional.length > 0) {
      const result = computeTakeoffQuantities(
        takeoffInputOf(
          dimensional.map((line) => {
            const factors = line.takeoff;
            // Unreachable: this batch was filtered to lines that carry factors.
            if (factors === undefined) throw new Error('takeoff factors are missing');
            return {
              itemKey: line.lineId,
              kind: factors.kind,
              unit: factors.unit,
              count: factors.count,
              ...(factors.length !== undefined ? { length: factors.length } : {}),
              ...(factors.width !== undefined ? { width: factors.width } : {}),
              ...(factors.height !== undefined ? { height: factors.height } : {}),
            };
          }),
        ),
      );
      if (!result.ok) {
        return await reply.code(422).send({
          error: {
            code: 'TAKEOFF_QUANTITIES_REJECTED',
            message:
              'one or more takeoff items failed the quantity calculation rules; nothing was added',
            details: { failures: result.errors },
          },
        });
      }
      for (const item of result.items) computed.set(item.lineId, item);
    }
    const result = addEstimateLines(
      deps.dataset,
      estimate,
      versionId,
      // optional fields are only carried when present (exactOptionalPropertyTypes)
      body.lines.map((line): EstimateLineInput => {
        const computedLine = computed.get(line.lineId);
        if (computedLine !== undefined) {
          return {
            lineId: line.lineId,
            pricebookCode: line.pricebookCode,
            quantity: computedLine.quantity,
            unit: line.unit,
            ...(line.buildingId !== undefined ? { buildingId: line.buildingId } : {}),
            ...(line.landscaping !== undefined ? { landscaping: line.landscaping } : {}),
            takeoff: computedLine.takeoff,
          };
        }
        // Unreachable: the schema guarantees exactly one of quantity | takeoff per line.
        if (line.quantity === undefined) throw new Error('line quantity is missing');
        return {
          lineId: line.lineId,
          pricebookCode: line.pricebookCode,
          quantity: line.quantity,
          unit: line.unit,
          ...(line.buildingId !== undefined ? { buildingId: line.buildingId } : {}),
          ...(line.landscaping !== undefined ? { landscaping: line.landscaping } : {}),
        };
      }),
    );
    if (!result.ok) {
      return await reply.code(422).send({
        error: {
          code: 'BOQ_LINES_REJECTED',
          message: 'one or more lines failed to bind to the published pricebook; nothing was added',
          details: { failures: result.failures },
        },
      });
    }
    // S3 (§4.3 #11): ONE `boq_lines.added` event for the whole all-or-nothing batch
    // (count + lineIds of the lines the domain actually appended), committed with it.
    await deps.transact(async (tx) => {
      await tx.estimates.save(result.estimate);
      await appendAuditEvent(
        tx.audit,
        boqLinesAdded(
          actorOf(auth),
          estimate,
          versionId,
          result.lines.map((line) => line.lineId),
        ),
        deps.clock,
      );
    });
    return await reply
      .code(200)
      .send(result.estimate.versions.find((v) => v.versionId === versionId));
  });

  // ---- Calculation (preview of the draft; nothing persisted) ------------------------------

  app.post('/estimate-versions/:versionId/calculate', async (request, reply) => {
    const versionId = (request.params as { versionId: string }).versionId;
    const body = calculateSchema.parse(request.body);
    const estimate = await deps.repositories.estimates.findByVersionId(versionId);
    if (estimate === undefined)
      return await reply.code(404).send(notFound('version', versionId).body);
    const calculation = calculateEstimateVersion(estimate, versionId, coefficientsOf(body), {
      reportId: body.reportId ?? `report-${versionId}`,
      generatedAt: body.generatedAt ?? deps.clock(),
    });
    return await reply.code(200).send(calculation);
  });

  // ---- Finalization (persisted atomically with its snapshot) ------------------------------

  app.post('/estimate-versions/:versionId/finalize', async (request, reply) => {
    const auth = requireAuth(request);
    const versionId = (request.params as { versionId: string }).versionId;
    const body = finalizeSchema.parse(request.body);
    const estimate = await deps.repositories.estimates.findByVersionId(versionId);
    if (estimate === undefined)
      return await reply.code(404).send(notFound('version', versionId).body);
    const finalized = finalizeEstimate(estimate, versionId, coefficientsOf(body), {
      reportId: body.reportId ?? `report-${versionId}`,
      generatedAt: body.generatedAt ?? deps.clock(),
      finalizedAt: body.finalizedAt ?? deps.clock(),
      // S4 (CG-GOV §5): stamp the finalizing actor — the four-eyes rule reads it.
      finalizedBy: auth.user.userId,
    });
    // One transaction persists the finalization transition, the lines, the snapshot —
    // and, since S3, the `estimate_version.finalized` event with the rollup total
    // (CG-GOV §4.3 #14; an engine-rejected finalize never reaches this point).
    await deps.transact(async (tx) => {
      await tx.finalized.save(finalized);
      await appendAuditEvent(
        tx.audit,
        estimateVersionFinalized(actorOf(auth), estimate, finalized),
        deps.clock,
      );
    });
    return await reply.code(201).send(await estimateBundleBody(finalized));
  });

  // P8-A S4 (CG-GOV §3 #37/§5) — reviewer sign-off of a FINALIZED estimate version:
  // the single irreversible FINALIZED → APPROVED/LOCKED transition. Authorization
  // (Reviewer+) is decided by the gate BEFORE this handler; the four-eyes rule and the
  // already-approved conflict are decided on the loaded bundle BEFORE any write; the
  // atomic `approve` (guarded by `approved_by IS NULL`) + the `estimate_version.approved`
  // audit event commit in ONE transaction — a lost race or a failing event append
  // leaves the version unapproved with zero events (§4.2/§9).
  app.post('/estimate-versions/:versionId/approve', async (request, reply) => {
    const auth = requireAuth(request);
    const versionId = (request.params as { versionId: string }).versionId;
    const estimate = await deps.repositories.estimates.findByVersionId(versionId);
    if (estimate === undefined)
      return await reply.code(404).send(notFound('version', versionId).body);
    const finalized = await deps.repositories.finalized.byVersionId(versionId);
    if (finalized === undefined) {
      // A version that exists but is not finalized (existing code, existing semantics).
      return await reply.code(409).send({
        error: {
          code: 'VERSION_NOT_FINALIZED',
          message: `version ${versionId} is a draft; only a finalized version can be approved`,
        },
      });
    }
    // No write, no event on any denial path (§4.4/§6).
    ensureNotYetApproved(finalized.approval);
    ensureNotSelfApproval(finalized.finalizedBy, auth.user.userId);
    const approvedAt = requireApprovalInstant(deps.clock());
    await deps.transact(async (tx) => {
      if (!(await tx.finalized.approve(versionId, auth.user.userId, approvedAt))) {
        // Lost a race (or a between-read-and-write approval): the row is already
        // approved — the idempotent conflict of §5, never a silent 200.
        throw new ProjectsError(
          'SIGNOFF_ALREADY_GIVEN',
          'this estimate version is already approved; approval is irreversible and cannot be repeated',
        );
      }
      await appendAuditEvent(
        tx.audit,
        estimateVersionApproved(actorOf(auth), versionId, estimate.projectId),
        deps.clock,
      );
    });
    const approved = await deps.repositories.finalized.byVersionId(versionId);
    if (approved === undefined) {
      // Just approved and reloaded on the same store — unreachable defensive branch.
      throw new Error(`version ${versionId} cannot be reloaded after its approval`);
    }
    return await reply.code(200).send(await estimateBundleBody(approved));
  });

  // ---- Rendering (from the reloaded finalized snapshot; never recalculated) ---------------

  app.get('/estimate-versions/:versionId/render/excel', async (request, reply) => {
    const versionId = (request.params as { versionId: string }).versionId;
    const finalized = await deps.repositories.finalized.byVersionId(versionId);
    if (finalized === undefined) {
      const estimate = await deps.repositories.estimates.findByVersionId(versionId);
      if (estimate?.versions.some((v) => v.versionId === versionId) === true) {
        return await reply.code(409).send({
          error: {
            code: 'VERSION_NOT_FINALIZED',
            message: `version ${versionId} is a draft; only a finalized version has an immutable report to render`,
          },
        });
      }
      return await reply.code(404).send(notFound('version', versionId).body);
    }
    const bytes = await renderEstimateExcel(finalized.calculation);
    return await reply.code(200).header('content-type', XLSX_CONTENT_TYPE).send(Buffer.from(bytes));
  });

  app.get('/estimate-versions/:versionId/render/pdf', async (request, reply) => {
    const versionId = (request.params as { versionId: string }).versionId;
    const finalized = await deps.repositories.finalized.byVersionId(versionId);
    if (finalized === undefined) {
      const estimate = await deps.repositories.estimates.findByVersionId(versionId);
      if (estimate?.versions.some((v) => v.versionId === versionId) === true) {
        return await reply.code(409).send({
          error: {
            code: 'VERSION_NOT_FINALIZED',
            message: `version ${versionId} is a draft; only a finalized version has an immutable report to render`,
          },
        });
      }
      return await reply.code(404).send(notFound('version', versionId).body);
    }
    const bytes = await renderEstimatePdf(finalized.calculation);
    return await reply.code(200).header('content-type', PDF_CONTENT_TYPE).send(Buffer.from(bytes));
  });

  // ---- Full Takeoff documents (D-016 Phase 3, CG-FT-TAKEOFF-SPEC §2–§4/§12) -----------
  // A stateful, project-scoped resource family BESIDE the unchanged stateless D-015
  // preview (POST /takeoff/quantities/preview stays exactly as shipped). Addressing is by
  // `documentId` — the per-revision identity the approved spec fixes as the API identity
  // (§2.2); `takeoffId` is the chain a follow-up continues. Mutations are POST-only (§4)
  // and every mutation body carries `expectedRevision`; the Phase 2 store — not this
  // layer — is the concurrency and immutability authority. Handlers only orchestrate:
  // load (scoped) → domain transition → repository. No validation, calculation, snapshot
  // construction or transaction handling is duplicated here.

  app.post('/projects/:projectId/takeoffs', async (request, reply) => {
    const auth = requireAuth(request);
    const projectId = projectIdParamSchema.parse(
      (request.params as { projectId: unknown }).projectId,
    );
    const body = createTakeoffSchema.parse(request.body);
    const project = await deps.repositories.projects.findById(projectId);
    if (project === undefined)
      return await reply.code(404).send(notFound('project', projectId).body);
    const document = createTakeoffDocument(project, {
      takeoffId: body.takeoffId,
      documentId: body.documentId,
      title: body.title,
      createdAt: body.createdAt ?? deps.clock(),
    });
    // S3 (§4.3 #17): the document row and its event commit together; a duplicate
    // documentId fails the store's revision-0 insert (zero events).
    await deps.transact(async (tx) => {
      await tx.takeoffDocuments.create(document);
      await appendAuditEvent(tx.audit, takeoffDocumentCreated(actorOf(auth), document), deps.clock);
    });
    return await reply.code(201).send(document);
  });

  // P7-S1 (CG-FT@0.2.0 §15, D-LIST=B): the project-scoped list — a pure projection of
  // the existing findByProjectId repository capability. Never calculates, mutates,
  // exposes snapshot internals, touches the pricebook or transfers; the repositories
  // already answer in the deterministic (takeoffId, documentNumber) chain order, and
  // every follow-up document is its own row. Full content stays on the document route.
  app.get('/projects/:projectId/takeoffs', async (request, reply) => {
    const projectId = projectIdParamSchema.parse(
      (request.params as { projectId: unknown }).projectId,
    );
    const project = await deps.repositories.projects.findById(projectId);
    if (project === undefined)
      return await reply.code(404).send(notFound('project', projectId).body);
    const documents = await deps.repositories.takeoffDocuments.findByProjectId(projectId);
    return await reply.code(200).send(
      documents.map((document) => ({
        documentId: document.documentId,
        takeoffId: document.takeoffId,
        documentNumber: document.documentNumber,
        title: document.title,
        status: document.status,
        revision: document.revision,
        createdAt: document.createdAt,
        ...(document.finalizedAt !== undefined ? { finalizedAt: document.finalizedAt } : {}),
      })),
    );
  });

  // Finalized → the immutable snapshot bundle; draft/archived → the document itself
  // (exactly the GET /estimate-versions/:versionId convention).
  app.get('/projects/:projectId/takeoffs/:documentId', async (request, reply) => {
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const finalized = await deps.repositories.finalizedTakeoffs.byDocumentId(params.documentId);
    if (finalized !== undefined && finalized.document.projectId === params.projectId) {
      return await reply.code(200).send(await takeoffBundleBody(finalized));
    }
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    return await reply.code(200).send(document);
  });

  app.post('/projects/:projectId/takeoffs/:documentId/save', async (request, reply) => {
    const auth = requireAuth(request);
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const body = saveTakeoffDraftSchema.parse(request.body);
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    // R3=A (CG-FT §7): V1 authors only `sourceStatus: "design"` rounding rules; the
    // authoring API rejects the other enum values (422 TAKEOFF_DOCUMENT_REJECTED, §12 —
    // an authoring-policy rejection, not a schema error) and saves nothing.
    const rejected = body.rounding
      .map((entry, index) => ({ rule: index, sourceStatus: entry.sourceStatus }))
      .filter((entry) => entry.sourceStatus !== 'design');
    if (rejected.length > 0) {
      return await reply.code(422).send({
        error: {
          code: 'TAKEOFF_DOCUMENT_REJECTED',
          message:
            'in V1 a takeoff document may only carry sourceStatus "design" rounding rules; nothing was saved',
          details: { rules: rejected },
        },
      });
    }
    const next = saveTakeoffDocumentDraft(document, {
      title: body.title,
      sheets: body.sheets.map(takeoffSheetOf),
      rounding: body.rounding.map(roundingRuleOf),
    });
    // S3 (§4.3 #20): the save and its event commit together; a stale expectedRevision
    // fails the store's optimistic check inside the same transaction (zero events).
    await deps.transact(async (tx) => {
      await tx.takeoffDocuments.save(next, body.expectedRevision);
      await appendAuditEvent(
        tx.audit,
        takeoffDocumentSaved(
          actorOf(auth),
          params.documentId,
          params.projectId,
          body.expectedRevision,
          next.revision,
        ),
        deps.clock,
      );
    });
    return await reply.code(200).send(next);
  });

  app.post('/projects/:projectId/takeoffs/:documentId/archive', async (request, reply) => {
    const auth = requireAuth(request);
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const body = archiveTakeoffSchema.parse(request.body);
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    const archived = archiveTakeoffDocument(document, body.archivedAt ?? deps.clock());
    await deps.transact(async (tx) => {
      await tx.takeoffDocuments.save(archived, body.expectedRevision);
      await appendAuditEvent(
        tx.audit,
        takeoffDocumentArchived(actorOf(auth), archived),
        deps.clock,
      );
    });
    return await reply.code(200).send(archived);
  });

  app.post('/projects/:projectId/takeoffs/:documentId/unarchive', async (request, reply) => {
    const auth = requireAuth(request);
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const body = unarchiveTakeoffSchema.parse(request.body);
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    const restored = unarchiveTakeoffDocument(document);
    await deps.transact(async (tx) => {
      await tx.takeoffDocuments.save(restored, body.expectedRevision);
      await appendAuditEvent(
        tx.audit,
        takeoffDocumentUnarchived(actorOf(auth), restored),
        deps.clock,
      );
    });
    return await reply.code(200).send(restored);
  });

  // Finalization runs the domain path (which runs the engine): a non-calculating draft
  // is a 422 TAKEOFF_CALCULATION_FAILED with NOTHING persisted; the atomic transition +
  // immutable snapshot commit lives in the Phase 2 store's single transaction.
  app.post('/projects/:projectId/takeoffs/:documentId/finalize', async (request, reply) => {
    const auth = requireAuth(request);
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const body = finalizeTakeoffSchema.parse(request.body);
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    const finalized = finalizeTakeoffDocument(document, {
      finalizedAt: body.finalizedAt ?? deps.clock(),
      // S4 (CG-GOV §5): stamp the finalizing actor — the four-eyes rule reads it.
      finalizedBy: auth.user.userId,
    });
    // S3 (§4.3 #23): the atomic transition + snapshot + event commit together; a
    // non-calculating draft is rejected by the domain BEFORE any write (zero events).
    await deps.transact(async (tx) => {
      await tx.finalizedTakeoffs.save(finalized, body.expectedRevision);
      await appendAuditEvent(
        tx.audit,
        takeoffDocumentFinalized(actorOf(auth), finalized),
        deps.clock,
      );
    });
    return await reply.code(201).send(await takeoffBundleBody(finalized));
  });

  // P8-A S4 (CG-GOV §3 #38/§5) — reviewer sign-off of a FINALIZED takeoff document:
  // the single irreversible FINALIZED → APPROVED/LOCKED transition, project-scoped and
  // isolated exactly like every takeoff route (a document of another project is a bare
  // 404). Authorization (Reviewer+) is decided by the gate; the four-eyes rule and the
  // already-approved conflict are decided on the loaded bundle; the atomic `approve`
  // + the `takeoff_document.approved` audit event commit in ONE transaction (§4.2/§9).
  app.post('/projects/:projectId/takeoffs/:documentId/approve', async (request, reply) => {
    const auth = requireAuth(request);
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    if (document.status !== 'finalized') {
      // Existing code, existing semantics (the domain guard of every lifecycle route).
      throw new ProjectsError(
        'TAKEOFF_INVALID_TRANSITION',
        `only a finalized document can be approved (document "${params.documentId}" is ${document.status})`,
      );
    }
    const finalized = await deps.repositories.finalizedTakeoffs.byDocumentId(params.documentId);
    if (finalized === undefined) {
      // Unreachable on a consistent store: the document row says finalized, so the
      // snapshot exists (they commit together). Fail loudly, never partially.
      throw new Error(
        `document "${params.documentId}" is finalized without a snapshot; the store is inconsistent`,
      );
    }
    // No write, no event on any denial path (§4.4/§6).
    ensureNotYetApproved(finalized.approval);
    ensureNotSelfApproval(finalized.finalizedBy, auth.user.userId);
    const approvedAt = requireApprovalInstant(deps.clock());
    await deps.transact(async (tx) => {
      if (!(await tx.finalizedTakeoffs.approve(params.documentId, auth.user.userId, approvedAt))) {
        // Lost a race (or a between-read-and-write approval): the idempotent §5 conflict.
        throw new ProjectsError(
          'SIGNOFF_ALREADY_GIVEN',
          'this takeoff document is already approved; approval is irreversible and cannot be repeated',
        );
      }
      await appendAuditEvent(
        tx.audit,
        takeoffDocumentApproved(actorOf(auth), params.documentId, params.projectId),
        deps.clock,
      );
    });
    const approved = await deps.repositories.finalizedTakeoffs.byDocumentId(params.documentId);
    if (approved === undefined) {
      throw new Error(`document ${params.documentId} cannot be reloaded after its approval`);
    }
    return await reply.code(200).send(await takeoffBundleBody(approved));
  });

  // P7-S2 (CG-FT@0.2.0 §16 + §12.2, D-PREVIEW=B/D-ERROR=C): the STATELESS draft
  // calculation preview — no request body. The persisted draft is solved by the existing
  // engine (the same input reconstruction finalization uses); the result is returned
  // VERBATIM and nothing is persisted, mutated or transferred (a preview result is never
  // BOQ-transferable — transfer requires a finalized snapshot). Engine failures are the
  // structured preview contract: 422 TAKEOFF_SOLUTION_REJECTED with the engine's failures
  // under details.failures — a code DISTINCT from finalization's 422
  // TAKEOFF_CALCULATION_FAILED (codes in the message), which stays untouched above.
  // Archived/finalized documents keep the existing lifecycle semantics (409
  // TAKEOFF_INVALID_TRANSITION, surfaced verbatim by the error handler).
  app.post('/projects/:projectId/takeoffs/:documentId/calculate', async (request, reply) => {
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    const result = previewTakeoffDocumentCalculation(document);
    if (result.status !== 'ok') {
      return await reply.code(422).send({
        error: {
          code: 'TAKEOFF_SOLUTION_REJECTED',
          message:
            'the takeoff document does not calculate; nothing was persisted (stateless preview)',
          details: { failures: result.errors },
        },
      });
    }
    return await reply.code(200).send(result);
  });

  app.post('/projects/:projectId/takeoffs/:documentId/follow-up', async (request, reply) => {
    const auth = requireAuth(request);
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const body = followUpTakeoffSchema.parse(request.body);
    const source = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (source === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    const followUp = createFollowUpTakeoffDocument(source, {
      documentId: body.documentId,
      createdAt: body.createdAt ?? deps.clock(),
    });
    // S3 (§4.3 #25): resource = the NEW follow-up document; details carry the source.
    await deps.transact(async (tx) => {
      await tx.takeoffDocuments.create(followUp);
      await appendAuditEvent(
        tx.audit,
        takeoffDocumentFollowUpCreated(actorOf(auth), followUp, params.documentId),
        deps.clock,
      );
    });
    return await reply.code(201).send(followUp);
  });

  // ---- Takeoff → BOQ transfer (D-016 Phase 4, G2=B — CG-FT §8) ----------------------
  // Finalized takeoff → DRAFT estimate version of the SAME project. One BOQ line per
  // priced itemCode/itemTotal through the existing S2/S3 line-resolution path; uncoded
  // itemTotals are skipped and reported; all-or-nothing. The route only orchestrates —
  // aggregation, quantities, pricing and atomicity belong to the engine, the transfer
  // service and the store's single transaction.

  app.post('/projects/:projectId/takeoffs/:documentId/transfer-to-boq', async (request, reply) => {
    const auth = requireAuth(request);
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const body = takeoffTransferSchema.parse(request.body);
    // Project isolation first: a document of another project is indistinguishable from
    // a missing one (404, no cross-project existence disclosure) — before any lifecycle
    // information is revealed.
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    // Only a FINALIZED takeoff may transfer (§8.1) — the immutable snapshot is the source.
    const finalized = await deps.repositories.finalizedTakeoffs.byDocumentId(params.documentId);
    if (finalized === undefined) {
      return await reply.code(409).send({
        error: {
          code: 'TAKEOFF_INVALID_TRANSITION',
          message: `takeoff document "${params.documentId}" is ${document.status}; only a finalized takeoff can be transferred to BOQ`,
        },
      });
    }
    // The target version must exist within the same project (bare 404 on mismatch —
    // no cross-project disclosure of the estimate either).
    const estimate = await deps.repositories.estimates.findByVersionId(body.versionId);
    if (estimate === undefined || estimate.projectId !== params.projectId) {
      return await reply.code(404).send(notFound('version', body.versionId).body);
    }
    const transfer = transferTakeoffToVersion(deps.dataset, finalized, estimate, body.versionId);
    if (!transfer.ok) {
      // The stable transfer rejection (CG-FT §12): 422 TAKEOFF_TRANSFER_REJECTED with
      // the per-item failures (existing S2 codes or ALREADY_TRANSFERRED) in details.
      return await reply.code(422).send({
        error: {
          code: 'TAKEOFF_TRANSFER_REJECTED',
          message: transfer.message,
          details: { failures: transfer.failures, skipped: transfer.skipped },
        },
      });
    }
    // One transaction commits the appended lines (the store's append-only writer) —
    // and, since S3, the `takeoff_document.transferred_to_boq` event with the target
    // version and the transferred line count (CG-GOV §4.3 #26). A concurrent
    // identical transfer commits as a no-op there, never a duplicate line.
    await deps.transact(async (tx) => {
      await tx.estimates.save(transfer.estimate);
      await appendAuditEvent(
        tx.audit,
        takeoffDocumentTransferredToBoq(
          actorOf(auth),
          params.documentId,
          params.projectId,
          body.versionId,
          transfer.lines.length,
        ),
        deps.clock,
      );
    });
    return await reply.code(200).send({
      transferred: transfer.transferred,
      skipped: transfer.skipped,
      lines: transfer.lines.map((line) => ({
        lineId: line.lineId,
        pricebookCode: line.pricebookCode,
        quantity: line.quantity,
        unit: line.unit,
        lineAmount: line.lineAmount,
        calculationStatus: line.calculationStatus,
      })),
    });
  });

  // ---- Takeoff reporting (D-016 Phase 6, G6=A — CG-FT §9) ----------------------------
  // ONE standard report per finalized takeoff, rendered from the immutable snapshot
  // ONLY (the persisted engine result — never recalculated here), through the same
  // two-stage pipeline as the estimate reports. GET, like the estimate render routes:
  // rendering is read-only. Draft → 409; other project / missing → 404 (isolation
  // before lifecycle disclosure, mirroring the conventions above).

  app.get('/projects/:projectId/takeoffs/:documentId/render/excel', async (request, reply) => {
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const finalized = await deps.repositories.finalizedTakeoffs.byDocumentId(params.documentId);
    if (finalized !== undefined && finalized.document.projectId === params.projectId) {
      const project = await deps.repositories.projects.findById(params.projectId);
      const bytes = await renderTakeoffExcel(finalized, {
        projectTitle: project?.title ?? null,
      });
      return await reply
        .code(200)
        .header('content-type', XLSX_CONTENT_TYPE)
        .send(Buffer.from(bytes));
    }
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    return await reply.code(409).send({
      error: {
        code: 'TAKEOFF_NOT_FINALIZED',
        message: `takeoff document "${params.documentId}" is ${document.status}; only a finalized takeoff has an immutable report to render`,
      },
    });
  });

  app.get('/projects/:projectId/takeoffs/:documentId/render/pdf', async (request, reply) => {
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const finalized = await deps.repositories.finalizedTakeoffs.byDocumentId(params.documentId);
    if (finalized !== undefined && finalized.document.projectId === params.projectId) {
      const project = await deps.repositories.projects.findById(params.projectId);
      const bytes = await renderTakeoffPdf(finalized, {
        projectTitle: project?.title ?? null,
      });
      return await reply
        .code(200)
        .header('content-type', PDF_CONTENT_TYPE)
        .send(Buffer.from(bytes));
    }
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    return await reply.code(409).send({
      error: {
        code: 'TAKEOFF_NOT_FINALIZED',
        message: `takeoff document "${params.documentId}" is ${document.status}; only a finalized takeoff has an immutable report to render`,
      },
    });
  });

  return app;
}
