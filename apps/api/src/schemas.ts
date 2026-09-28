/**
 * HTTP request contracts (Zod) — the only place raw JSON is accepted.
 *
 * Boundary rules enforced here:
 * - **Decimals are strings**: `quantity` is a Zod string — a JSON number is rejected with
 *   400 before any business layer sees it (no precision can ever be lost at the edge).
 * - **No prices from clients**: the line schema is `.strict()`, so a payload carrying
 *   `basePrice`, `unitPrice` or `lineAmount` is rejected — prices come only from the
 *   verified pricebook via S2/S3.
 * - The schemas check SHAPE only (required, string, enum); precise domain rules (UUID
 *   format, ISO instants, decimal syntax, unit codes) stay in the domain/engine layers,
 *   which reject invalid values with their own stable error codes. The one exception is
 *   the `:projectId` path parameter, whose UUID shape is checked here so a malformed id
 *   is a clean 400 instead of a database type error.
 */
import { USER_ROLES, type ExpressionNode } from '@costgenius/projects';
import { z } from 'zod';
import { USERNAME_PATTERN } from './auth.js';

export const createProjectSchema = z
  .object({
    projectId: z.string().min(1),
    organizationId: z.string().min(1).optional(),
    title: z.string().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
    createdAt: z.string().min(1).optional(),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof createProjectSchema>;

export const createEstimateSchema = z
  .object({
    estimateId: z.string().min(1),
    title: z.string().min(1),
  })
  .strict();
export type CreateEstimateRequest = z.infer<typeof createEstimateSchema>;

export const createVersionSchema = z
  .object({
    buildingId: z.string().min(1),
    createdAt: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    versionId: z.string().min(1).optional(),
  })
  .strict();
export type CreateVersionRequest = z.infer<typeof createVersionSchema>;

/**
 * D-015: the dimensional factors of one line — the SERVER computes the quantity from
 * these via calc-engine (a client never submits a calculated quantity). Shape only:
 * factor semantics (integer count, required dimensions per unit) stay in the engine.
 * There is deliberately NO rounding field (D-015/D3-A: exact-only) — `.strict()` rejects
 * any attempt to send one.
 */
const takeoffFactorsSchema = z
  .object({
    kind: z.enum(['addition', 'deduction']),
    unit: z.string().min(1),
    /** Exact decimal STRING (never a JSON number — floats lose precision). */
    count: z.string().min(1),
    length: z.string().min(1).optional(),
    width: z.string().min(1).optional(),
    height: z.string().min(1).optional(),
  })
  .strict();

export const estimateLineSchema = z
  .object({
    lineId: z.string().min(1),
    /** Exact printed pricebook code — string identity, leading zeros preserved. */
    pricebookCode: z.string().min(1),
    /** Exact decimal STRING (never a JSON number — floats lose precision). */
    quantity: z.string().min(1).optional(),
    unit: z.string().min(1),
    buildingId: z.string().min(1).optional(),
    landscaping: z.boolean().optional(),
    /** D-015: dimensional factors — exactly one of `quantity` or `takeoff` per line. */
    takeoff: takeoffFactorsSchema.optional(),
  })
  .strict()
  .refine((line) => (line.quantity === undefined) !== (line.takeoff === undefined), {
    message: 'exactly one of quantity (manual entry) or takeoff (dimensional factors) is required',
  })
  .refine((line) => line.takeoff === undefined || line.takeoff.unit === line.unit, {
    message: 'takeoff.unit must equal the line unit (the pricebook row unit); no conversion exists',
  });
export type AddEstimateLineRequest = z.infer<typeof estimateLineSchema>;

/** One item of the stateless dimensional preview (D-015/D5-A). */
export const takeoffPreviewItemSchema = takeoffFactorsSchema.extend({
  itemKey: z.string().min(1),
});
export type TakeoffPreviewItemRequest = z.infer<typeof takeoffPreviewItemSchema>;

/** POST /takeoff/quantities/preview — stateless, exact-only, no rounding accepted. */
export const takeoffPreviewSchema = z
  .object({
    items: z.array(takeoffPreviewItemSchema).min(1),
  })
  .strict();
export type TakeoffPreviewRequest = z.infer<typeof takeoffPreviewSchema>;

export const addLinesSchema = z
  .object({
    lines: z.array(estimateLineSchema).min(1),
  })
  .strict();
export type AddLinesRequest = z.infer<typeof addLinesSchema>;

const floorInputSchema = z
  .object({
    buildingId: z.string().min(1),
    groundFloorArea: z.string().min(1),
    firstBasementArea: z.string().min(1),
    aboveGroundFloors: z.array(z.object({ area: z.string().min(1) }).strict()),
    belowGroundFloors: z.array(z.object({ area: z.string().min(1) }).strict()),
    totalBuildingFloorArea: z.string().min(1),
  })
  .strict();

const overheadSelectionSchema = z.union([
  z
    .object({
      planKind: z.enum(['capital', 'non-capital']),
      tenderRoute: z.enum(['tender-or-monopoly', 'waived-or-other']),
    })
    .strict(),
  z.object({ value: z.string().min(1) }).strict(),
]);

const regionalSchema = z
  .object({
    parts: z.array(
      z
        .object({
          regionId: z.string().min(1).optional(),
          /** The regional coefficient Ri — external data supplied by the caller, or null. */
          coefficient: z.string().min(1).nullable(),
          executionCost: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

const siteSetupSchema = z
  .object({
    /** Project-local lump sum; null keeps the estimate INCOMPLETE (never invented). */
    lumpSumAmount: z.string().min(1).nullable(),
  })
  .strict();

export const coefficientInputsSchema = z
  .object({
    floor: floorInputSchema,
    overhead: overheadSelectionSchema,
    regional: regionalSchema,
    siteSetup: siteSetupSchema,
  })
  .strict();
export type CoefficientInputsRequest = z.infer<typeof coefficientInputsSchema>;

export const calculateSchema = coefficientInputsSchema.extend({
  reportId: z.string().min(1).optional(),
  generatedAt: z.string().min(1).optional(),
});
export type CalculateRequest = z.infer<typeof calculateSchema>;

export const finalizeSchema = coefficientInputsSchema.extend({
  reportId: z.string().min(1).optional(),
  generatedAt: z.string().min(1).optional(),
  finalizedAt: z.string().min(1).optional(),
});
export type FinalizeRequest = z.infer<typeof finalizeSchema>;

/** UUID shape for the `:projectId` path parameter (boundary hygiene → clean 400). */
export const projectIdParamSchema = z.string().uuid();

/**
 * Pricebook code-lookup query (Phase 18 UI autocomplete). `search` matches rows whose
 * printed code STARTS WITH the text or whose description CONTAINS it, in published
 * order, capped by `limit` — a presentation-level lookup only: the binding of an
 * estimate line to a pricebook row always goes through the exact-code add-lines
 * contract (no fuzzy resolution is ever performed).
 */
export const pricebookLookupQuerySchema = z
  .object({
    search: z.string().min(1).max(64),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type PricebookLookupQuery = z.infer<typeof pricebookLookupQuerySchema>;

/* ------------------------------------------------------------------------------------------------
 * Full Takeoff documents (D-016, CG-FT-TAKEOFF-SPEC@0.1.0 §4) — the stateful takeoff
 * resource family beside the unchanged D-015 stateless preview. Mutations are POST-only
 * (spec §4) and every mutation body carries `expectedRevision` (G4=B).
 *
 * Boundary rules (spec §6.2 — a malformed expression is unrepresentable at the edge):
 * - `quantity` is a CLOSED discriminated union and the expression tree a closed recursive
 *   union over exactly `const`/`ref`/`add`/`mul`/`sub`/`round` — division, powers, π and
 *   arbitrary functions do not exist on the wire (a `div` node is a 400 INVALID_REQUEST,
 *   never an engine error). The engine only ever receives well-formed trees.
 * - Shape only, exactly like the D-015 schemas: decimals are non-empty STRINGS (a JSON
 *   number is a 400 before any layer sees it), while decimal SYNTAX, profile/dimension
 *   fit, reference resolution, duplicate identities and rounding-rule validity stay in
 *   the engine/store and surface at save/finalization with their own stable codes.
 * - V1 authoring vocabularies are closed here: `origin` is `user` only (spec §13). The
 *   rounding `sourceStatus` enum is the full engine set STRUCTURALLY — the non-`design`
 *   values are an authoring-policy rejection (422 TAKEOFF_DOCUMENT_REJECTED, R3=A / spec
 *   §12) made by the save route, not a schema error.
 * -----------------------------------------------------------------------------------------------*/

const decimalStringSchema = z.string().min(1);

const roundingModeSchema = z.enum(['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP', 'FLOOR', 'CEIL']);

/** §4.3 restricted expression tree — closed recursive union, no parser exists anywhere. */
const takeoffExpressionNodeSchema: z.ZodType<ExpressionNode> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('const'), value: decimalStringSchema }).strict(),
    z
      .object({
        op: z.literal('ref'),
        lineId: z.string().min(1),
        use: z.enum(['signed', 'magnitude']),
      })
      .strict(),
    z
      .object({
        op: z.literal('add'),
        args: z
          .tuple([takeoffExpressionNodeSchema, takeoffExpressionNodeSchema])
          .rest(takeoffExpressionNodeSchema),
      })
      .strict(),
    z
      .object({
        op: z.literal('mul'),
        args: z
          .tuple([takeoffExpressionNodeSchema, takeoffExpressionNodeSchema])
          .rest(takeoffExpressionNodeSchema),
      })
      .strict(),
    z
      .object({
        op: z.literal('sub'),
        args: z.tuple([takeoffExpressionNodeSchema, takeoffExpressionNodeSchema]),
      })
      .strict(),
    z
      .object({
        op: z.literal('round'),
        arg: takeoffExpressionNodeSchema,
        rule: z.object({ scale: z.number().int(), mode: roundingModeSchema }).strict(),
      })
      .strict(),
  ]),
);

const takeoffQuantitySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('dimensional'),
      profile: z.enum(['L', 'LW', 'LWH', 'count']),
      similarCount: decimalStringSchema.optional(),
      floorCount: decimalStringSchema.optional(),
      length: decimalStringSchema.optional(),
      width: decimalStringSchema.optional(),
      height: decimalStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('reference'),
      terms: z.array(
        z
          .object({
            lineId: z.string().min(1),
            factor: decimalStringSchema,
            use: z.enum(['signed', 'magnitude']),
          })
          .strict(),
      ),
    })
    .strict(),
  z.object({ type: z.literal('expression'), node: takeoffExpressionNodeSchema }).strict(),
  z
    .object({
      type: z.literal('manual'),
      value: decimalStringSchema,
      justification: z.string().min(1),
    })
    .strict(),
]);
export type TakeoffQuantityRequest = z.infer<typeof takeoffQuantitySchema>;

const takeoffLineSchema = z
  .object({
    lineId: z.string().min(1),
    rowNo: z.number().int(),
    description: z.string().min(1),
    location: z.string().min(1).optional(),
    /** Opaque Item-Master/pricebook code; `null` is an explicitly uncoded line. */
    itemCode: z.string().min(1).nullable().optional(),
    kind: z.enum(['addition', 'deduction']),
    unit: z.string().min(1),
    quantity: takeoffQuantitySchema,
    notes: z.string().min(1).optional(),
    /** V1 authors `user` lines only (spec §13: import/ai-accepted are reserved). */
    origin: z.literal('user').optional(),
    ruleRefs: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type TakeoffLineRequest = z.infer<typeof takeoffLineSchema>;

const takeoffSheetSchema = z
  .object({
    sheetId: z.string().min(1),
    name: z.string().min(1),
    lines: z.array(takeoffLineSchema),
  })
  .strict();
export type TakeoffSheetRequest = z.infer<typeof takeoffSheetSchema>;

const roundingSelectorSchema = z
  .object({
    itemCode: z.string().min(1).optional(),
    unit: z.string().min(1).optional(),
    lineIds: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type RoundingSelectorRequest = z.infer<typeof roundingSelectorSchema>;

const sourceRefSchema = z
  .object({
    sourceDocument: z.string().min(1).nullable(),
    edition: z.string().min(1).nullable(),
    page: z.string().min(1).nullable(),
    section: z.string().min(1).nullable(),
    sourceFileHash: z.string().min(1).optional(),
  })
  .strict();
export type SourceRefRequest = z.infer<typeof sourceRefSchema>;

const roundingRuleEntrySchema = z
  .object({
    target: z.enum(['line', 'reference-term', 'item-total', 'sheet-total']),
    selector: roundingSelectorSchema.optional(),
    scale: z.number().int(),
    mode: roundingModeSchema,
    sourceStatus: z.enum(['design', 'organization-policy', 'verified', 'unverified']),
    source: sourceRefSchema.optional(),
  })
  .strict();
export type RoundingRuleEntryRequest = z.infer<typeof roundingRuleEntrySchema>;

/** POST /projects/:projectId/takeoffs — start a new takeoff chain (documentNumber 1). */
export const createTakeoffSchema = z
  .object({
    takeoffId: z.string().min(1),
    documentId: z.string().min(1),
    title: z.string().min(1),
    createdAt: z.string().min(1).optional(),
  })
  .strict();
export type CreateTakeoffRequest = z.infer<typeof createTakeoffSchema>;

/**
 * POST /projects/:projectId/takeoffs/:documentId/save — the G4=B full-document replace:
 * the COMPLETE content (title, sheets, lines, rounding rule set) plus the
 * `expectedRevision` the caller loaded.
 */
export const saveTakeoffDraftSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    title: z.string().min(1),
    sheets: z.array(takeoffSheetSchema),
    rounding: z.array(roundingRuleEntrySchema),
  })
  .strict();
export type SaveTakeoffDraftRequest = z.infer<typeof saveTakeoffDraftSchema>;

export const archiveTakeoffSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    archivedAt: z.string().min(1).optional(),
  })
  .strict();
export type ArchiveTakeoffRequest = z.infer<typeof archiveTakeoffSchema>;

export const unarchiveTakeoffSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
  })
  .strict();
export type UnarchiveTakeoffRequest = z.infer<typeof unarchiveTakeoffSchema>;

export const finalizeTakeoffSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    finalizedAt: z.string().min(1).optional(),
  })
  .strict();
export type FinalizeTakeoffRequest = z.infer<typeof finalizeTakeoffSchema>;

/** POST /projects/:projectId/takeoffs/:documentId/follow-up — continue a finalized chain. */
export const followUpTakeoffSchema = z
  .object({
    documentId: z.string().min(1),
    createdAt: z.string().min(1).optional(),
  })
  .strict();
export type FollowUpTakeoffRequest = z.infer<typeof followUpTakeoffSchema>;

/**
 * POST /projects/:projectId/takeoffs/:documentId/transfer-to-boq (D-016 G2=B) — transfer
 * the finalized takeoff into a DRAFT estimate version of the same project. The target is
 * the existing estimate-version identity; nothing else is client-supplied (the source is
 * the immutable finalized snapshot, the quantities are the engine's own itemTotals).
 */
export const takeoffTransferSchema = z
  .object({
    versionId: z.string().min(1),
  })
  .strict();
export type TakeoffTransferRequest = z.infer<typeof takeoffTransferSchema>;

/** Path parameters of the takeoff document routes (boundary hygiene → clean 400s). */
export const takeoffDocumentParamsSchema = z
  .object({
    projectId: z.string().uuid(),
    documentId: z.string().min(1),
  })
  .strict();
export type TakeoffDocumentParams = z.infer<typeof takeoffDocumentParamsSchema>;

/* ------------------------------------------------------------------------------------------------
 * Authentication routes (P8-A S1, CG-GOV-SPEC@0.1.0 §1) — shape-only validation.
 * Login is deliberately LOOSE (any non-empty strings): every credential failure —
 * malformed username, unknown user, wrong password, deactivated user — answers the
 * identical 401 AUTH_INVALID_CREDENTIALS after normalization, so the schema never
 * leaks which part failed. The password-change schema enforces the 8–128 rule of
 * §1.2 for the NEW password only (the current one is verified by scrypt, not shape).
 * -----------------------------------------------------------------------------------------------*/

export const loginSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(128),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginSchema>;

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(8).max(128),
  })
  .strict();
export type PasswordChangeRequest = z.infer<typeof passwordChangeSchema>;

/*
 * P8-A S2 user management (CG-GOV §2.3): the five-role enum, the §1.1 username rule
 * and the §1.2 password rule are enforced HERE so a malformed payload is a clean 400
 * INVALID_REQUEST (§8) — unlike login, this surface must validate its input.
 */
export const roleSchema = z.enum(USER_ROLES);
export type RoleValue = z.infer<typeof roleSchema>;

export const createUserSchema = z
  .object({
    username: z.string().regex(USERNAME_PATTERN, '3–64 chars of a-z 0-9 . _ -'),
    password: z.string().min(8).max(128),
    role: roleSchema,
  })
  .strict();
export type CreateUserRequest = z.infer<typeof createUserSchema>;

export const roleChangeSchema = z
  .object({
    role: roleSchema,
  })
  .strict();
export type RoleChangeRequest = z.infer<typeof roleChangeSchema>;

export const userIdParamSchema = z.string().uuid();
