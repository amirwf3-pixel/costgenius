/**
 * View types of the Phase 17/18 API — mirroring the ACTUAL response shapes of
 * `apps/api` (Project, Estimate, EstimateVersion, BOQ lines, calculation bundles and
 * the finalized bundle). The web app is a pure HTTP consumer: it imports no workspace
 * package at runtime, and the integration test (`test/workflow.integration.test.ts`)
 * pins these shapes against the real API so they can never silently drift.
 */

export interface Project {
  readonly projectId: string;
  readonly organizationId?: string;
  readonly title: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export type VersionStatus = 'draft' | 'finalized';

export interface BoqLine {
  readonly lineId: string;
  readonly pricebookCode: string;
  readonly chapter: string;
  readonly group: string;
  readonly description: string;
  readonly unit: { readonly code: string; readonly label: string };
  readonly quantity: string;
  readonly basePrice: string | null;
  readonly lineAmount: string | null;
  readonly calculationStatus: string;
  readonly edition: string;
  readonly externalDependencies: readonly string[];
  readonly notes: readonly string[];
  readonly sourceRef: {
    readonly sourceDocument: string;
    readonly edition: string;
    readonly printedPage: string;
    readonly section: string;
  };
}

export interface EstimateVersion {
  readonly versionId: string;
  readonly estimateId: string;
  readonly versionNumber: number;
  readonly status: VersionStatus;
  readonly createdAt: string;
  readonly edition: string;
  readonly buildingId?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly lines: readonly BoqLine[];
}

export interface Estimate {
  readonly estimateId: string;
  readonly projectId: string;
  readonly title: string;
  readonly versions: readonly EstimateVersion[];
}

/** The S4 stage chain exactly as the engine returns it (names from the real payload). */
export interface CalculationStage {
  readonly stage: string;
  readonly coefficient: string | null;
  readonly input: string | null;
  readonly output: string | null;
  readonly status: string;
}

export interface CalculationResult {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly s4Result: {
    readonly calculationStatus: string;
    readonly finalEstimate: string | null;
    readonly stages: readonly CalculationStage[];
    readonly pending: {
      readonly incomplete: readonly string[];
      readonly externalDependencies: readonly string[];
      readonly notSpecified: readonly string[];
    };
  };
  readonly rollup: {
    readonly amount: string | null;
    readonly status: string;
    readonly lineCount: number;
    readonly pricedLineCount: number;
    readonly pendingLineCount: number;
  };
}

/** GET /estimate-versions/:id returns either a draft version or the finalized bundle. */
export interface FinalizedBundle {
  readonly estimate: Estimate;
  readonly versionId: string;
  readonly calculation: CalculationResult;
  readonly finalizedAt: string;
}

export type VersionOrBundle =
  | { readonly kind: 'draft'; readonly version: EstimateVersion }
  | { readonly kind: 'finalized'; readonly bundle: FinalizedBundle };

/** One pricebook row as returned by the lookup endpoint (UI autocomplete only). */
export interface PricebookRowRef {
  readonly code: string;
  readonly chapter: string;
  readonly group: string;
  readonly description: string;
  readonly unit: { readonly code: string; readonly label: string };
  readonly basePrice: string | null;
  readonly status: string;
}

/** The stable backend error body: {error: {code, message, details?}}. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export interface NewProjectInput {
  readonly title: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface NewEstimateInput {
  readonly title: string;
}

export interface NewVersionInput {
  readonly buildingId: string;
}

/**
 * D-015: dimensional factors of one line — the SERVER computes the quantity from these
 * (a client never submits a calculated quantity). Exactly one of `quantity` or `takeoff`
 * is sent per line.
 */
export interface TakeoffFactorsInput {
  readonly kind: 'addition' | 'deduction';
  readonly unit: string;
  /** Integer ≥ 0 as an exact string. */
  readonly count: string;
  readonly length?: string;
  readonly width?: string;
  readonly height?: string;
}

export interface NewLineInput {
  readonly pricebookCode: string;
  /** Manual entry only — omitted when `takeoff` carries the dimensional factors. */
  readonly quantity?: string;
  readonly unit: string;
  readonly buildingId?: string;
  readonly landscaping?: boolean;
  readonly takeoff?: TakeoffFactorsInput;
}

/** One item of the stateless dimensional preview request (D-015/D5-A). */
export interface TakeoffPreviewItemInput extends TakeoffFactorsInput {
  readonly itemKey: string;
}

/** The S1 provenance echoed by the preview: everything needed to replay the quantity. */
export interface TakeoffProvenanceView {
  /** The exact engine input item (echoed verbatim). */
  readonly input: unknown;
  /** The engine's own output; `qty` is the exact canonical decimal. */
  readonly output: { readonly qty: string };
  readonly specVersion: string;
  readonly engineVersion: string;
}

export interface TakeoffPreviewItemResult {
  readonly lineId: string;
  readonly quantity: string;
  readonly unit: string;
  readonly takeoff: TakeoffProvenanceView;
}

export interface TakeoffPreviewResult {
  readonly specVersion: string;
  readonly engineVersion: string;
  readonly items: readonly TakeoffPreviewItemResult[];
}

export interface CoefficientInputs {
  readonly floor: {
    readonly buildingId: string;
    readonly groundFloorArea: string;
    readonly firstBasementArea: string;
    readonly aboveGroundFloors: readonly { readonly area: string }[];
    readonly belowGroundFloors: readonly { readonly area: string }[];
    readonly totalBuildingFloorArea: string;
  };
  readonly overhead: {
    readonly planKind: 'capital' | 'non-capital';
    readonly tenderRoute: 'tender-or-monopoly' | 'waived-or-other';
  };
  readonly regional: {
    readonly parts: readonly {
      readonly regionId?: string;
      readonly coefficient: string | null;
      readonly executionCost: string;
    }[];
  };
  readonly siteSetup: { readonly lumpSumAmount: string | null };
}

/* ------------------------------------------------------------------------------------------------
 * D-016 Full Takeoff (Phases 3–4): the takeoff document family, mirrored from the ACTUAL
 * request/response schemas of `apps/api` (takeoff routes + transfer-to-boq). Same law as
 * above: pure HTTP consumer, exact decimal strings, no client-side computation — the
 * engine stays authoritative and every exact/rounded value rendered here was computed by
 * the backend (a draft carries no calculation result at all until it is finalized).
 * -----------------------------------------------------------------------------------------------*/

export type TakeoffDocumentStatus = 'draft' | 'archived' | 'finalized';

export type TakeoffLineKind = 'addition' | 'deduction';

export type TakeoffReferenceUse = 'signed' | 'magnitude';

/** §4.1 dimensional quantity: `value = floorCount × similarCount × Π(profile dimensions)`. */
export interface TakeoffDimensionalQuantity {
  readonly type: 'dimensional';
  readonly profile: 'L' | 'LW' | 'LWH' | 'count';
  readonly similarCount?: string;
  readonly floorCount?: string;
  readonly length?: string;
  readonly width?: string;
  readonly height?: string;
}

/** §4.2 reference quantity: `value = Σ factorᵢ × refᵢ` (a negative factor is allowed). */
export interface TakeoffReferenceTerm {
  readonly lineId: string;
  readonly factor: string;
  readonly use: TakeoffReferenceUse;
}

export interface TakeoffReferenceQuantity {
  readonly type: 'reference';
  readonly terms: readonly TakeoffReferenceTerm[];
}

/** §4.3 restricted expression tree — the closed node union (no parser exists anywhere). */
export type TakeoffExpressionNode =
  | { readonly op: 'const'; readonly value: string }
  | { readonly op: 'ref'; readonly lineId: string; readonly use: TakeoffReferenceUse }
  | {
      readonly op: 'add';
      readonly args: readonly [
        TakeoffExpressionNode,
        TakeoffExpressionNode,
        ...TakeoffExpressionNode[],
      ];
    }
  | {
      readonly op: 'mul';
      readonly args: readonly [
        TakeoffExpressionNode,
        TakeoffExpressionNode,
        ...TakeoffExpressionNode[],
      ];
    }
  | { readonly op: 'sub'; readonly args: readonly [TakeoffExpressionNode, TakeoffExpressionNode] }
  | {
      readonly op: 'round';
      readonly arg: TakeoffExpressionNode;
      readonly rule: { readonly scale: number; readonly mode: string };
    };

export interface TakeoffExpressionQuantity {
  readonly type: 'expression';
  readonly node: TakeoffExpressionNode;
}

/** §4.4 manual quantity: directly entered with a mandatory justification. */
export interface TakeoffManualQuantity {
  readonly type: 'manual';
  readonly value: string;
  readonly justification: string;
}

export type TakeoffQuantity =
  | TakeoffDimensionalQuantity
  | TakeoffReferenceQuantity
  | TakeoffExpressionQuantity
  | TakeoffManualQuantity;

export interface TakeoffLine {
  readonly lineId: string;
  readonly rowNo: number;
  readonly description: string;
  readonly location?: string;
  readonly itemCode?: string | null;
  readonly kind: TakeoffLineKind;
  readonly unit: string;
  readonly quantity: TakeoffQuantity;
  readonly notes?: string;
  readonly origin?: 'user';
  readonly ruleRefs?: readonly string[];
}

export interface TakeoffSheet {
  readonly sheetId: string;
  readonly name: string;
  readonly lines: readonly TakeoffLine[];
}

export type TakeoffRoundingTarget = 'line' | 'reference-term' | 'item-total' | 'sheet-total';

export type TakeoffRoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP' | 'FLOOR' | 'CEIL';

export interface TakeoffRoundingSelector {
  readonly itemCode?: string;
  readonly unit?: string;
  readonly lineIds?: readonly string[];
}

export interface TakeoffSourceRef {
  readonly sourceDocument: string | null;
  readonly edition: string | null;
  readonly page: string | null;
  readonly section: string | null;
  readonly sourceFileHash?: string;
}

export interface TakeoffRoundingRule {
  readonly target: TakeoffRoundingTarget;
  readonly selector?: TakeoffRoundingSelector;
  readonly scale: number;
  readonly mode: TakeoffRoundingMode;
  /** V1 authors `design` rules only (R3=A); the enum stays closed. */
  readonly sourceStatus: 'design' | 'organization-policy' | 'verified' | 'unverified';
  readonly source?: TakeoffSourceRef;
}

/** The persisted document (draft/archived) exactly as GET returns it. */
export interface TakeoffDocument {
  readonly documentId: string;
  readonly takeoffId: string;
  readonly projectId: string;
  readonly title: string;
  readonly documentNumber: number;
  readonly status: TakeoffDocumentStatus;
  readonly revision: number;
  readonly rounding: readonly TakeoffRoundingRule[];
  readonly sheets: readonly TakeoffSheet[];
  readonly createdAt: string;
  readonly archivedAt?: string;
  readonly finalizedAt?: string;
}

/** The engine result of a FINALIZED takeoff (verbatim; drafts carry no result). */
export interface TakeoffLineResult {
  readonly lineId: string;
  readonly sheetId: string;
  readonly rowNo: number;
  readonly itemCode: string | null;
  readonly unit: string;
  readonly kind: TakeoffLineKind;
  readonly exactMagnitude: string;
  readonly roundedMagnitude?: string;
  readonly signedValue: string;
}

export interface TakeoffItemTotal {
  readonly itemCode: string | null;
  readonly unit: string;
  readonly exactQty: string;
  readonly roundedQty?: string;
  /** Effective value: roundedQty when a rule produced one, otherwise exactQty (R2=C). */
  readonly qty: string;
  readonly lineIds: readonly string[];
}

export interface TakeoffSheetItemTotal {
  readonly itemCode: string | null;
  readonly unit: string;
  readonly exactQty: string;
  readonly roundedQty?: string;
  readonly qty: string;
  readonly lineIds: readonly string[];
}

export interface TakeoffSheetTotal {
  readonly sheetId: string;
  readonly byItem: readonly TakeoffSheetItemTotal[];
}

export interface TakeoffResult {
  readonly specId: 'CG-IR-MEAS';
  readonly specVersion: string;
  readonly engineVersion: string;
  readonly status: 'ok' | 'error';
  readonly errors: readonly {
    code: string;
    message: string;
    sheetId?: string;
    lineId?: string;
    field?: string;
  }[];
  readonly lines: readonly TakeoffLineResult[];
  readonly itemTotals: readonly TakeoffItemTotal[];
  readonly sheetTotals: readonly TakeoffSheetTotal[];
}

/** GET …/takeoffs/:documentId after finalization — the immutable snapshot bundle. */
export interface FinalizedTakeoffBundle {
  readonly document: TakeoffDocument;
  readonly documentId: string;
  readonly takeoffId: string;
  readonly documentNumber: number;
  readonly finalizedAt: string;
  readonly input: {
    readonly sheets: readonly TakeoffSheet[];
    readonly rounding: readonly TakeoffRoundingRule[];
  };
  readonly result: TakeoffResult;
}

export type TakeoffOrBundle =
  | { readonly kind: 'document'; readonly document: TakeoffDocument }
  | { readonly kind: 'finalized'; readonly bundle: FinalizedTakeoffBundle };

/**
 * P7-S1 (CG-FT@0.2.0 §15, D-LIST=B): one row of the project-scoped takeoff list —
 * a projection only (never full document content). `finalizedAt` is present only on
 * finalized documents; rows arrive in deterministic (takeoffId, documentNumber) order.
 */
export interface TakeoffListRow {
  readonly documentId: string;
  readonly takeoffId: string;
  readonly documentNumber: number;
  readonly title: string;
  readonly status: TakeoffDocumentStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly finalizedAt?: string;
}

/** The G2=B transfer outcome (Phase 4), exactly as the endpoint answers it. */
export interface TakeoffTransferResult {
  readonly transferred: readonly {
    readonly itemCode: string;
    readonly unit: string;
    readonly lineId: string;
    readonly quantity: string;
    readonly lineIds: readonly string[];
    readonly exactQty: string;
    readonly roundedQty?: string;
  }[];
  readonly skipped: readonly {
    readonly itemCode: null;
    readonly unit: string;
    readonly lineIds: readonly string[];
    readonly exactQty: string;
    readonly roundedQty?: string;
    readonly qty: string;
  }[];
  readonly lines: readonly {
    readonly lineId: string;
    readonly pricebookCode: string;
    readonly quantity: string;
    readonly unit: { readonly label: string; readonly code: string };
    readonly lineAmount: string | null;
    readonly calculationStatus: string;
  }[];
}

/** POST /projects/:projectId/takeoffs — the client-generated identity stays client-side. */
export interface NewTakeoffInput {
  readonly title: string;
}

/** The full-document replace content (G4=B) — sheets and rounding travel whole. */
export interface SaveTakeoffContent {
  readonly title: string;
  readonly sheets: readonly TakeoffSheet[];
  readonly rounding: readonly TakeoffRoundingRule[];
}

/* ------------------------------------------------------------------------------------------------
 * Authentication (P8-A S1, CG-GOV-SPEC@0.1.0 §1) — the session projection the API
 * returns; passwords and password hashes NEVER appear in any API payload.
 * -----------------------------------------------------------------------------------------------*/

export type UserRole = 'org_admin' | 'estimator' | 'reviewer' | 'viewer' | 'data_steward';

export interface AuthSession {
  readonly userId: string;
  readonly username: string;
  readonly role: UserRole;
  /** Absolute session expiration (UTC ISO string). */
  readonly expiresAt: string;
}

/** The password-change reply (no credential material, ever). */
export interface PasswordChanged {
  readonly userId: string;
  readonly username: string;
  readonly role: UserRole;
}
