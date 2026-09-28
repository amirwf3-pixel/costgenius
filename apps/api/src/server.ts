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
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type {
  EstimateRepository,
  FinalizedEstimateRepository,
  FinalizedTakeoffRepository,
  ProjectRepository,
  TakeoffDocument,
  TakeoffDocumentLine,
  TakeoffDocumentRepository,
  TakeoffDocumentSheet,
  TakeoffLineInput,
  RoundingRuleEntry,
} from '@costgenius/projects';
import type { PublishedDataset } from '@costgenius/pricebook';
import type { SessionRecord, SessionStore, User, UserStore } from '@costgenius/projects';
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
  };
  /**
   * Governance stores (P8-A S1, CG-GOV@0.1.0): authentication/session identity ONLY —
   * RBAC enforcement, audit events and reviewer sign-off are later stages and nothing
   * here authorizes by role yet.
   */
  readonly governance: {
    readonly users: UserStore;
    readonly sessions: SessionStore;
  };
  readonly dataset: PublishedDataset;
  /** Injected clock (ISO instant) — the server never reads the clock itself. */
  readonly clock: () => string;
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
    const result = await loginUser(authDeps, body.username, body.password);
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
    const user = await changePassword(authDeps, auth, body.currentPassword, body.newPassword);
    return { userId: user.userId, username: user.username, role: user.role };
  });

  // ---- User management (P8-A S2, CG-GOV §2.3 — org_admin only via the gate) --------------
  // The route gate has already established the caller is org_admin; these handlers
  // own the target-dependent guard rails (self-deactivation, last-active-admin).

  app.post('/users', async (request, reply) => {
    requireAuth(request);
    const body = createUserSchema.parse(request.body);
    const user = await createUser(authDeps, body);
    return await reply.code(201).send(user);
  });

  app.get('/users', async () => {
    return await listUsers(authDeps);
  });

  app.post('/users/:userId/role', async (request) => {
    requireAuth(request); // org_admin established by the gate; no actor guard on role change
    const userId = userIdParamSchema.parse((request.params as { userId: unknown }).userId);
    const body = roleChangeSchema.parse(request.body);
    return await changeUserRole(authDeps, userId, body.role);
  });

  app.post('/users/:userId/deactivate', async (request) => {
    const auth = requireAuth(request);
    const userId = userIdParamSchema.parse((request.params as { userId: unknown }).userId);
    return await deactivateUser(authDeps, auth.user.userId, userId);
  });

  app.get('/health', () => ({ status: 'ok' }));

  // ---- Project ---------------------------------------------------------------------------

  app.post('/projects', async (request, reply) => {
    const body = createProjectSchema.parse(request.body);
    const project = createProject({
      projectId: body.projectId,
      ...(body.organizationId !== undefined ? { organizationId: body.organizationId } : {}),
      title: body.title,
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      createdAt: body.createdAt ?? deps.clock(),
    });
    await deps.repositories.projects.save(project);
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

  // ---- Pricebook code lookup (Phase 18 UI autocomplete; presentation only) ---------------
  // A read-only filter over the ALREADY published dataset for the add-line dialog's
  // search box. It never resolves estimate lines: binding stays exact-code in
  // POST /estimate-versions/:id/lines. Deterministic: published order, capped results.

  app.get('/pricebook/rows', async (request, reply) => {
    const query = pricebookLookupQuerySchema.parse(request.query);
    const needle = query.search;
    const matches = deps.dataset.rows
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
    return await reply.code(200).send({ rows: matches, edition: deps.dataset.edition.id });
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
    await deps.repositories.estimates.save(estimate);
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
    await deps.repositories.estimates.save(updated);
    return await reply.code(201).send(currentVersionOf(updated));
  });

  app.get('/estimate-versions/:versionId', async (request, reply) => {
    const versionId = (request.params as { versionId: string }).versionId;
    const finalized = await deps.repositories.finalized.byVersionId(versionId);
    if (finalized !== undefined) return await reply.code(200).send(finalized);
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
    await deps.repositories.estimates.save(result.estimate);
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
    const versionId = (request.params as { versionId: string }).versionId;
    const body = finalizeSchema.parse(request.body);
    const estimate = await deps.repositories.estimates.findByVersionId(versionId);
    if (estimate === undefined)
      return await reply.code(404).send(notFound('version', versionId).body);
    const finalized = finalizeEstimate(estimate, versionId, coefficientsOf(body), {
      reportId: body.reportId ?? `report-${versionId}`,
      generatedAt: body.generatedAt ?? deps.clock(),
      finalizedAt: body.finalizedAt ?? deps.clock(),
    });
    // One transaction persists the finalization transition, the lines and the snapshot.
    await deps.repositories.finalized.save(finalized);
    return await reply.code(201).send(finalized);
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
    await deps.repositories.takeoffDocuments.create(document);
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
      return await reply.code(200).send(finalized);
    }
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    return await reply.code(200).send(document);
  });

  app.post('/projects/:projectId/takeoffs/:documentId/save', async (request, reply) => {
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
    await deps.repositories.takeoffDocuments.save(next, body.expectedRevision);
    return await reply.code(200).send(next);
  });

  app.post('/projects/:projectId/takeoffs/:documentId/archive', async (request, reply) => {
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const body = archiveTakeoffSchema.parse(request.body);
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    const archived = archiveTakeoffDocument(document, body.archivedAt ?? deps.clock());
    await deps.repositories.takeoffDocuments.save(archived, body.expectedRevision);
    return await reply.code(200).send(archived);
  });

  app.post('/projects/:projectId/takeoffs/:documentId/unarchive', async (request, reply) => {
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const body = unarchiveTakeoffSchema.parse(request.body);
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    const restored = unarchiveTakeoffDocument(document);
    await deps.repositories.takeoffDocuments.save(restored, body.expectedRevision);
    return await reply.code(200).send(restored);
  });

  // Finalization runs the domain path (which runs the engine): a non-calculating draft
  // is a 422 TAKEOFF_CALCULATION_FAILED with NOTHING persisted; the atomic transition +
  // immutable snapshot commit lives in the Phase 2 store's single transaction.
  app.post('/projects/:projectId/takeoffs/:documentId/finalize', async (request, reply) => {
    const params = takeoffDocumentParamsSchema.parse(request.params);
    const body = finalizeTakeoffSchema.parse(request.body);
    const document = await findProjectTakeoffDocument(deps, params.projectId, params.documentId);
    if (document === undefined) {
      return await reply.code(404).send(notFound('takeoff document', params.documentId).body);
    }
    const finalized = finalizeTakeoffDocument(document, {
      finalizedAt: body.finalizedAt ?? deps.clock(),
    });
    await deps.repositories.finalizedTakeoffs.save(finalized, body.expectedRevision);
    return await reply.code(201).send(finalized);
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
    await deps.repositories.takeoffDocuments.create(followUp);
    return await reply.code(201).send(followUp);
  });

  // ---- Takeoff → BOQ transfer (D-016 Phase 4, G2=B — CG-FT §8) ----------------------
  // Finalized takeoff → DRAFT estimate version of the SAME project. One BOQ line per
  // priced itemCode/itemTotal through the existing S2/S3 line-resolution path; uncoded
  // itemTotals are skipped and reported; all-or-nothing. The route only orchestrates —
  // aggregation, quantities, pricing and atomicity belong to the engine, the transfer
  // service and the store's single transaction.

  app.post('/projects/:projectId/takeoffs/:documentId/transfer-to-boq', async (request, reply) => {
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
    // One transaction commits the appended lines (the store's append-only writer);
    // a concurrent identical transfer commits as a no-op there, never a duplicate.
    await deps.repositories.estimates.save(transfer.estimate);
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
