/**
 * The ONE HTTP client of the web app (§6): typed, central JSON parsing, network errors
 * and HTTP errors mapped to a single application error type. No component ever calls
 * fetch itself — everything goes through this module.
 *
 * Business rules stay on the backend: this client sends decimals as exact strings and
 * never computes, converts or repairs any value.
 */
import type {
  ApiErrorBody,
  AuthSession,
  CalculationResult,
  CoefficientInputs,
  Estimate,
  EstimateVersion,
  FinalizedBundle,
  FinalizedTakeoffBundle,
  NewEstimateInput,
  NewLineInput,
  NewProjectInput,
  NewTakeoffInput,
  PasswordChanged,
  NewVersionInput,
  PricebookEditionSummary,
  PricebookRowRef,
  Project,
  SaveTakeoffContent,
  TakeoffDocument,
  TakeoffListRow,
  TakeoffResult,
  TakeoffOrBundle,
  TakeoffPreviewItemInput,
  TakeoffPreviewResult,
  TakeoffTransferResult,
  VersionOrBundle,
} from './types.js';

/** Persian, actionable messages for the workflow's known error codes (§35). */
function mapUserMessage(code: string, status: number, serverMessage: string): string {
  switch (code) {
    case 'VERSION_FINALIZED':
    case 'FINALIZED_ESTIMATE_IMMUTABLE':
      return 'این نسخه نهایی شده و قابل تغییر نیست. برای تغییرات، نسخه جدید ایجاد کنید.';
    case 'VERSION_NOT_FINALIZED':
      return 'این نسخه هنوز نهایی نشده است؛ ابتدا نسخه را نهایی کنید.';
    case 'NOT_FOUND':
      return 'موردی که درخواست کرده‌اید پیدا نشد. ممکن است حذف شده یا نشانی نادرست باشد.';
    case 'INVALID_REQUEST':
      return 'درخواست معتبر نیست؛ مقادیر ورودی را بررسی کنید.';
    case 'AUTH_INVALID_CREDENTIALS':
      return 'نام کاربری یا گذرواژه نادرست است.';
    case 'UNAUTHENTICATED':
      return 'نشست شما معتبر نیست یا پایان یافته است؛ دوباره وارد شوید.';
    case 'FORBIDDEN':
      // P8-A S2 (CG-GOV §2.2): the server is authoritative — the UI never predicts
      // roles; it only renders the denial. No role information is echoed.
      return 'شما مجوز انجام این عمل را ندارید.';
    case 'BOQ_LINES_REJECTED':
      return 'یک یا چند ردیف به فهرست‌بها متصل نشد؛ جزئیات را در فهرست خطاها ببینید.';
    case 'TAKEOFF_QUANTITIES_REJECTED':
      return 'یک یا چند قلم متره‌ای پذیرفته نشد؛ اندازه‌ها را بررسی کنید (تعداد صحیح، اعداد نامنفی، ابعاد الزامی بر حسب واحد).';
    case 'PERSISTENCE_CONFLICT':
      return 'این تغییر با داده‌های ذخیره‌شده در تضاد است؛ صفحه را نوسازی کنید.';
    case 'TAKEOFF_INVALID_TRANSITION':
      return 'این عملیات با وضعیت فعلی صورت‌برداشت سازگار نیست (سند نهایی‌شده تغییرناپذیر است و پیش‌نویس بایگانی‌شده ابتدا باید بازگردانی شود).';
    case 'TAKEOFF_DOCUMENT_IMMUTABLE':
      return 'سند صورت‌برداشت نهایی‌شده و تغییرناپذیر است.';
    case 'TAKEOFF_CALCULATION_FAILED':
      return 'محاسبهٔ صورت‌برداشت با خطا رد شد؛ هیچ چیزی نهایی نشد. خطاهای موتور محاسبه را ببینید.';
    case 'TAKEOFF_SOLUTION_REJECTED':
      return 'پیش‌نمایش محاسبهٔ صورت‌برداشت رد شد؛ هیچ چیزی ذخیره یا نهایی نشد. خطاهای هر ردیف را ببینید.';
    case 'TAKEOFF_DOCUMENT_REJECTED':
      return 'محتوای صورت‌برداشت پذیرفته نشد؛ در نسخهٔ فعلی فقط قواعد گرد کردن با منشأ «طراحی» مجازند.';
    case 'TAKEOFF_TRANSFER_REJECTED':
      return 'انتقال صورت‌برداشت به برآورد انجام نشد؛ جزئیات هر قلم را ببینید.';
    case 'INVALID_TAKEOFF_INPUT':
      return 'ورودی صورت‌برداشت معتبر نیست؛ مقادیر را بررسی کنید.';
    default:
      return status >= 500 ? 'خطای سرور؛ لطفاً دوباره تلاش کنید.' : serverMessage;
  }
}

/**
 * Persian hints for the S1 engine's factor errors. The engine's codes are deliberately
 * NOT public (D-015/D5-A) — they appear only inside `details.failures` of a
 * TAKEOFF_QUANTITIES_REJECTED error, and this map turns them into actionable text.
 */
export function takeoffFactorHint(code: string): string {
  switch (code) {
    case 'INVALID_DECIMAL':
      return 'یکی از اعداد قالب اعشاری دقیق ندارد (مثلاً 12.5 یا 3).';
    case 'NEGATIVE_INPUT':
      return 'اندازه‌ها باید نامنفی باشند؛ کسر با ردیف «کسر بها» انجام می‌شود، نه با عدد منفی.';
    case 'NON_INTEGER_COUNT':
      return 'تعداد باید عددی صحیح و نامنفی باشد (مثلاً 4 نه 4.5).';
    case 'DIMENSION_UNIT_MISMATCH':
      return 'برای این واحد همهٔ ابعاد الزامی است (مثلاً متر مربع به طول و عرض نیاز دارد).';
    case 'UNIT_MISMATCH':
      return 'واحد این ردیف در محاسبهٔ متره‌ای پشتیبانی نمی‌شود؛ مقدار را دستی وارد کنید.';
    case 'NEGATIVE_NET_QUANTITY':
      return 'حاصل خالص قلم متره‌ای باید نامنفی باشد؛ اندازه‌ها را بررسی کنید.';
    case 'DUPLICATE_KEY':
      return 'قلم تکراری در محاسبه وجود دارد.';
    default:
      return 'قلم متره‌ای پذیرفته نشد؛ اندازه‌ها را بررسی کنید.';
  }
}

/**
 * D-016: Persian hints for the CG-IR-MEAS engine error codes. Engine codes are never
 * public API codes — they ride inside the message of a 422 TAKEOFF_CALCULATION_FAILED
 * (finalize) as `CODE(lineId)` tokens. This map turns them into concise Persian text.
 */
const TAKEOFF_ENGINE_HINTS: Readonly<Record<string, string>> = {
  INVALID_DECIMAL: 'مقدار اعشاری نامعتبر است.',
  NON_INTEGER_COUNT: 'تعداد باید عدد صحیح باشد.',
  NEGATIVE_INPUT: 'مقادیر ورودی نمی‌توانند منفی باشند.',
  UNKNOWN_REFERENCE: 'مرجع انتخاب‌شده وجود ندارد.',
  CIRCULAR_REFERENCE: 'بین ردیف‌ها وابستگی حلقوی ایجاد شده است.',
  UNIT_MISMATCH: 'واحد این مقدار با مرجع سازگار نیست.',
  NEGATIVE_LINE_MAGNITUDE: 'مقدار خالص ردیف نمی‌تواند منفی باشد.',
  INVALID_ROUNDING_POLICY: 'قانون گرد کردن معتبر نیست.',
  NEGATIVE_NET_QUANTITY: 'مقدار خالص نمی‌تواند منفی باشد.',
  AGGREGATION_UNIT_MISMATCH: 'واحد آیتم در تجمیع یکسان نیست.',
  DUPLICATE_KEY: 'شناسهٔ تکراری (ردیف یا برگه) در سند وجود دارد.',
  DIMENSION_PROFILE_MISMATCH: 'ابعاد واردشده با الگوی اندازه‌گیری سازگار نیست.',
  MISSING_JUSTIFICATION: 'برای مقدار دستی، ثبت دلیل الزامی است.',
};

/**
 * P7-S2 (CG-FT@0.2.0 §12.2): Persian hints for the STRUCTURED preview failures — the
 * engine codes ride in `details.failures` of a 422 TAKEOFF_SOLUTION_REJECTED (never in
 * the message). Reuses the same hint map as finalization; same dedup discipline.
 */
export function takeoffFailureHints(details: unknown): readonly string[] {
  const failures = (details as { failures?: unknown } | undefined)?.failures;
  if (!Array.isArray(failures)) return [];
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const failure of failures) {
    const code = (failure as { code?: unknown }).code;
    if (typeof code !== 'string' || seen.has(code)) continue;
    const hint = TAKEOFF_ENGINE_HINTS[code];
    if (hint !== undefined) {
      seen.add(code);
      hints.push(hint);
    }
  }
  return hints;
}

/**
 * Extracts the known engine codes embedded in a TAKEOFF_CALCULATION_FAILED message and
 * returns their Persian hints (deduplicated, in first-seen order). Unknown codes are
 * kept as raw identifiers so debugging stays possible without leaking internals.
 */
export function takeoffEngineHints(serverMessage: string): readonly string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const match of serverMessage.matchAll(/\b([A-Z][A-Z_]+)\b/g)) {
    const code = match[1];
    if (code === undefined || seen.has(code)) continue;
    const hint = TAKEOFF_ENGINE_HINTS[code];
    if (hint !== undefined) {
      seen.add(code);
      hints.push(hint);
    }
  }
  return hints;
}

/** The single application error: an HTTP error with the backend's stable contract. */
export class ApiError extends Error {
  /**
   * The backend's raw (English) message. The user-visible text is `message` (Persian);
   * this is kept only so callers can surface embedded engine codes (D-016: the
   * finalize 422 carries `CODE(lineId)` tokens) without leaking them to users.
   */
  readonly serverMessage: string;

  constructor(
    readonly status: number,
    readonly code: string,
    serverMessage: string,
    readonly details?: unknown,
  ) {
    super(mapUserMessage(code, status, serverMessage));
    this.name = 'ApiError';
    this.serverMessage = serverMessage;
  }

  /** Alias kept for readability at call sites; the rendered text is `message`. */
  get userMessage(): string {
    return this.message;
  }
}

/** Network-level failure (server unreachable, DNS, aborted). */
export class NetworkError extends Error {
  constructor(override readonly cause: unknown) {
    super('ارتباط با سرور برقرار نشد');
    this.name = 'NetworkError';
  }
}

export interface ApiClient {
  // Property signatures on purpose: this is a stateless HTTP client with no `this`,
  // so method references are always safe to detach (expect(api.x), wrappers, ...).
  readonly listProjects: () => Promise<readonly Project[]>;
  readonly createProject: (input: NewProjectInput) => Promise<Project>;
  readonly getProject: (projectId: string) => Promise<Project>;
  readonly listEstimates: (projectId: string) => Promise<readonly Estimate[]>;
  readonly createEstimate: (projectId: string, input: NewEstimateInput) => Promise<Estimate>;
  readonly getEstimate: (estimateId: string) => Promise<Estimate>;
  readonly createVersion: (estimateId: string, input: NewVersionInput) => Promise<EstimateVersion>;
  readonly getVersion: (versionId: string) => Promise<VersionOrBundle>;
  readonly addLines: (
    versionId: string,
    lines: readonly NewLineInput[],
  ) => Promise<EstimateVersion>;
  readonly calculate: (
    versionId: string,
    coefficients: CoefficientInputs,
  ) => Promise<CalculationResult>;
  readonly finalize: (
    versionId: string,
    coefficients: CoefficientInputs,
  ) => Promise<FinalizedBundle>;
  readonly searchPricebook: (
    search: string,
    limit?: number,
    editionId?: string,
  ) => Promise<readonly PricebookRowRef[]>;
  /** P8-B S3: the #39 edition list (viewer-readable) — the version selector's data. */
  readonly listEditions: () => Promise<readonly PricebookEditionSummary[]>;
  /** D-015/D5-A: stateless dimensional quantity preview (calc-engine, exact-only). */
  readonly previewTakeoffQuantities: (
    items: readonly TakeoffPreviewItemInput[],
  ) => Promise<TakeoffPreviewResult>;
  /** P7-S1 (CG-FT@0.2.0 §15): project-scoped takeoff list projection rows. */
  readonly listTakeoffs: (projectId: string) => Promise<readonly TakeoffListRow[]>;
  // ---- D-016 Full Takeoff (Phases 3–4) — the existing routes, used as-is ----
  /** Creates a new takeoff chain's first document (client-generated UUID identity). */
  readonly createTakeoff: (projectId: string, input: NewTakeoffInput) => Promise<TakeoffDocument>;
  /** Loads a takeoff document; finalized documents answer the immutable snapshot bundle. */
  readonly getTakeoff: (projectId: string, documentId: string) => Promise<TakeoffOrBundle>;
  /** G4=B full-document replace under `expectedRevision`; the server owns the revision. */
  readonly saveTakeoffDraft: (
    projectId: string,
    documentId: string,
    expectedRevision: number,
    content: SaveTakeoffContent,
  ) => Promise<TakeoffDocument>;
  readonly archiveTakeoff: (
    projectId: string,
    documentId: string,
    expectedRevision: number,
  ) => Promise<TakeoffDocument>;
  readonly unarchiveTakeoff: (
    projectId: string,
    documentId: string,
    expectedRevision: number,
  ) => Promise<TakeoffDocument>;
  /** P7-S2 (CG-FT@0.2.0 §16): stateless draft calculation preview — the engine result
   *  verbatim; failures answer 422 TAKEOFF_SOLUTION_REJECTED with details.failures. */
  readonly previewTakeoffCalculation: (
    projectId: string,
    documentId: string,
  ) => Promise<TakeoffResult>;
  /** Finalizes through the domain (the engine runs server-side); 201 = the bundle. */
  readonly finalizeTakeoff: (
    projectId: string,
    documentId: string,
    expectedRevision: number,
  ) => Promise<FinalizedTakeoffBundle>;
  /** Follow-up: a verbatim copy of a finalized document as the chain's next draft. */
  readonly createTakeoffFollowUp: (
    projectId: string,
    documentId: string,
  ) => Promise<TakeoffDocument>;
  /** G2=B transfer into a draft estimate version of the same project (Phase 4). */
  readonly transferTakeoffToBoq: (
    projectId: string,
    documentId: string,
    versionId: string,
  ) => Promise<TakeoffTransferResult>;
  /** Downloads a rendered report as bytes (Excel/PDF) with a derived filename. */
  readonly downloadReport: (
    versionId: string,
    kind: 'excel' | 'pdf',
  ) => Promise<{ blob: Blob; filename: string }>;
  /** Downloads the finalized takeoff's report as bytes (Excel/PDF) — Phase 6. */
  readonly downloadTakeoffReport: (
    projectId: string,
    documentId: string,
    kind: 'excel' | 'pdf',
  ) => Promise<{ blob: Blob; filename: string }>;
  readonly health: () => Promise<boolean>;
  /* P8-A S1 (CG-GOV@0.1.0 §1) — the session rides the HttpOnly cg_session cookie. */
  /** Logs in; the server sets the session cookie (never returned in the body). */
  readonly login: (username: string, password: string) => Promise<AuthSession>;
  /** The current session projection; 401 UNAUTHENTICATED when absent/expired. */
  readonly getSession: () => Promise<AuthSession>;
  /** Deletes the server-side session and clears the cookie. */
  readonly logout: () => Promise<void>;
  /** Self-service password change; revokes every OTHER session of the user. */
  readonly changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<PasswordChanged>;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(header);
  return match?.[1]?.replaceAll('"', '') ?? undefined;
}

/** Optional seams of the concrete client (tests inject a cookie-attaching fetch). */
export interface ApiClientOptions {
  /**
   * The fetch implementation used for every request (defaults to the global fetch).
   * The browser relies on its cookie jar; the node integration test injects a
   * cookie-attaching wrapper because node fetch has no cookie jar.
   */
  readonly fetchImpl?: typeof fetch;
}

/** Builds the concrete client bound to a base URL (same-origin '/api' by default). */
export function createApiClient(baseUrl: string, options: ApiClientOptions = {}): ApiClient {
  const url = (path: string): string => `${baseUrl}${path}`;
  // resolved at CALL time so tests that stub globalThis.fetch after client creation
  // keep working (and the injected seam wins whenever provided)
  const doFetch: typeof fetch = (input, init) => (options.fetchImpl ?? fetch)(input, init);

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    let response: Response;
    try {
      const init: RequestInit = { method: options.method ?? 'GET' };
      if (options.body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(options.body);
      }
      if (options.signal !== undefined) init.signal = options.signal;
      response = await doFetch(url(path), init);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw cause;
      throw new NetworkError(cause);
    }
    if (!response.ok) {
      let code = 'HTTP_ERROR';
      let message = `HTTP ${String(response.status)}`;
      let details: unknown;
      try {
        const body = (await response.json()) as ApiErrorBody;
        if (typeof body.error.code === 'string') code = body.error.code;
        if (typeof body.error.message === 'string') message = body.error.message;
        details = body.error.details;
      } catch {
        // non-JSON error body — keep the generic HTTP message
      }
      throw new ApiError(response.status, code, message, details);
    }
    // 204 (and any empty body) has nothing to parse — e.g. logout answers 204
    const text = await response.text();
    return (text.length === 0 ? undefined : (JSON.parse(text) as T)) as T;
  }

  return {
    async listProjects() {
      return await request<readonly Project[]>('/projects');
    },
    async createProject(input: NewProjectInput) {
      return await request<Project>('/projects', {
        method: 'POST',
        // identity is generated here (UUID v4); createdAt stays server-side (injected clock)
        body: { projectId: crypto.randomUUID(), title: input.title, metadata: input.metadata },
      });
    },
    async getProject(projectId) {
      return await request<Project>(`/projects/${projectId}`);
    },
    async listEstimates(projectId) {
      return await request<readonly Estimate[]>(`/projects/${projectId}/estimates`);
    },
    async createEstimate(projectId, input: NewEstimateInput) {
      return await request<Estimate>(`/projects/${projectId}/estimates`, {
        method: 'POST',
        body: { estimateId: crypto.randomUUID(), title: input.title },
      });
    },
    async getEstimate(estimateId) {
      return await request<Estimate>(`/estimates/${estimateId}`);
    },
    async createVersion(estimateId, input: NewVersionInput) {
      return await request<EstimateVersion>(`/estimates/${estimateId}/versions`, {
        method: 'POST',
        body: {
          buildingId: input.buildingId,
          // P8-B S3: the optional edition binding — undefined means the server's
          // ACTIVE-edition default (D-PB-3 = B).
          ...(input.editionId !== undefined ? { editionId: input.editionId } : {}),
        },
      });
    },
    async getVersion(versionId) {
      const body = await request<FinalizedBundle | EstimateVersion>(
        `/estimate-versions/${versionId}`,
      );
      if ('finalizedAt' in body && 'calculation' in body) {
        return { kind: 'finalized', bundle: body };
      }
      return { kind: 'draft', version: body };
    },
    async addLines(versionId, lines) {
      return await request<EstimateVersion>(`/estimate-versions/${versionId}/lines`, {
        method: 'POST',
        body: {
          lines: lines.map((line) => ({
            lineId: `l-${crypto.randomUUID().slice(0, 8)}`,
            pricebookCode: line.pricebookCode,
            unit: line.unit,
            // exactly one of quantity (manual) or takeoff (dimensional factors, D-015)
            ...(line.quantity !== undefined ? { quantity: line.quantity } : {}),
            ...(line.takeoff !== undefined ? { takeoff: line.takeoff } : {}),
            ...(line.buildingId !== undefined ? { buildingId: line.buildingId } : {}),
            ...(line.landscaping !== undefined ? { landscaping: line.landscaping } : {}),
          })),
        },
      });
    },
    async previewTakeoffQuantities(items) {
      return await request<TakeoffPreviewResult>('/takeoff/quantities/preview', {
        method: 'POST',
        body: {
          items: items.map((item) => ({
            itemKey: item.itemKey,
            kind: item.kind,
            unit: item.unit,
            count: item.count,
            ...(item.length !== undefined ? { length: item.length } : {}),
            ...(item.width !== undefined ? { width: item.width } : {}),
            ...(item.height !== undefined ? { height: item.height } : {}),
          })),
        },
      });
    },
    async calculate(versionId, coefficients) {
      return await request<CalculationResult>(`/estimate-versions/${versionId}/calculate`, {
        method: 'POST',
        body: coefficients,
      });
    },
    async finalize(versionId, coefficients) {
      return await request<FinalizedBundle>(`/estimate-versions/${versionId}/finalize`, {
        method: 'POST',
        body: coefficients,
      });
    },
    async searchPricebook(search, limit = 20, editionId) {
      // P8-B S3 (§12/§17): an explicit editionId searches the WORKSPACE VERSION's
      // edition (never a global search) so suggestions match what binding accepts;
      // omitted → the server's ACTIVE-edition default.
      const editionQuery =
        editionId === undefined ? '' : `&editionId=${encodeURIComponent(editionId)}`;
      const body = await request<{ rows: readonly PricebookRowRef[] }>(
        `/pricebook/rows?search=${encodeURIComponent(search)}&limit=${String(limit)}${editionQuery}`,
      );
      return body.rows;
    },
    async listEditions() {
      const body = await request<{ editions: readonly PricebookEditionSummary[] }>(
        '/pricebook/editions',
      );
      return body.editions;
    },
    async createTakeoff(projectId, input) {
      return await request<TakeoffDocument>(`/projects/${projectId}/takeoffs`, {
        method: 'POST',
        body: {
          takeoffId: crypto.randomUUID(),
          documentId: crypto.randomUUID(),
          title: input.title,
        },
      });
    },
    async listTakeoffs(projectId) {
      return await request<readonly TakeoffListRow[]>(`/projects/${projectId}/takeoffs`);
    },
    async getTakeoff(projectId, documentId) {
      const body = await request<FinalizedTakeoffBundle | TakeoffDocument>(
        `/projects/${projectId}/takeoffs/${documentId}`,
      );
      if ('result' in body && 'finalizedAt' in body) {
        return { kind: 'finalized', bundle: body };
      }
      return { kind: 'document', document: body };
    },
    async saveTakeoffDraft(projectId, documentId, expectedRevision, content) {
      return await request<TakeoffDocument>(`/projects/${projectId}/takeoffs/${documentId}/save`, {
        method: 'POST',
        body: {
          expectedRevision,
          title: content.title,
          sheets: content.sheets.map((sheet) => ({
            sheetId: sheet.sheetId,
            name: sheet.name,
            lines: sheet.lines.map((line) => ({
              lineId: line.lineId,
              rowNo: line.rowNo,
              description: line.description,
              ...(line.location !== undefined && line.location !== ''
                ? { location: line.location }
                : {}),
              ...(line.itemCode !== undefined && line.itemCode !== null && line.itemCode !== ''
                ? { itemCode: line.itemCode }
                : {}),
              kind: line.kind,
              unit: line.unit,
              quantity: line.quantity,
              ...(line.notes !== undefined && line.notes !== '' ? { notes: line.notes } : {}),
            })),
          })),
          rounding: content.rounding.map((rule) => ({
            target: rule.target,
            ...(rule.selector !== undefined
              ? {
                  selector: {
                    ...(rule.selector.itemCode !== '' ? { itemCode: rule.selector.itemCode } : {}),
                    ...(rule.selector.unit !== '' ? { unit: rule.selector.unit } : {}),
                    ...(rule.selector.lineIds !== undefined && rule.selector.lineIds.length > 0
                      ? { lineIds: rule.selector.lineIds }
                      : {}),
                  },
                }
              : {}),
            scale: rule.scale,
            mode: rule.mode,
            sourceStatus: rule.sourceStatus,
            ...(rule.source !== undefined ? { source: rule.source } : {}),
          })),
        },
      });
    },
    async archiveTakeoff(projectId, documentId, expectedRevision) {
      return await request<TakeoffDocument>(
        `/projects/${projectId}/takeoffs/${documentId}/archive`,
        { method: 'POST', body: { expectedRevision } },
      );
    },
    async unarchiveTakeoff(projectId, documentId, expectedRevision) {
      return await request<TakeoffDocument>(
        `/projects/${projectId}/takeoffs/${documentId}/unarchive`,
        { method: 'POST', body: { expectedRevision } },
      );
    },
    async previewTakeoffCalculation(projectId, documentId) {
      // No request body (CG-FT §16.1): the server calculates the PERSISTED draft.
      return await request<TakeoffResult>(
        `/projects/${projectId}/takeoffs/${documentId}/calculate`,
        { method: 'POST' },
      );
    },
    async finalizeTakeoff(projectId, documentId, expectedRevision) {
      return await request<FinalizedTakeoffBundle>(
        `/projects/${projectId}/takeoffs/${documentId}/finalize`,
        { method: 'POST', body: { expectedRevision } },
      );
    },
    async createTakeoffFollowUp(projectId, documentId) {
      return await request<TakeoffDocument>(
        `/projects/${projectId}/takeoffs/${documentId}/follow-up`,
        { method: 'POST', body: { documentId: crypto.randomUUID() } },
      );
    },
    async transferTakeoffToBoq(projectId, documentId, versionId) {
      return await request<TakeoffTransferResult>(
        `/projects/${projectId}/takeoffs/${documentId}/transfer-to-boq`,
        { method: 'POST', body: { versionId } },
      );
    },
    async downloadReport(versionId, kind) {
      let response: Response;
      try {
        response = await doFetch(url(`/estimate-versions/${versionId}/render/${kind}`));
      } catch (cause) {
        throw new NetworkError(cause);
      }
      if (!response.ok) {
        let code = 'HTTP_ERROR';
        let message = `HTTP ${String(response.status)}`;
        try {
          const body = (await response.json()) as ApiErrorBody;
          code = body.error.code;
          message = body.error.message;
        } catch {
          // binary endpoint error without a JSON body
        }
        throw new ApiError(response.status, code, message);
      }
      // The contract sets content-type but no content-disposition: the filename comes
      // from the header when present, otherwise a stable versionId-based fallback.
      const filename =
        filenameFromDisposition(response.headers.get('content-disposition')) ??
        `costgenius-${versionId}.${kind === 'excel' ? 'xlsx' : 'pdf'}`;
      return { blob: await response.blob(), filename };
    },
    async downloadTakeoffReport(projectId, documentId, kind) {
      let response: Response;
      try {
        response = await doFetch(
          url(`/projects/${projectId}/takeoffs/${documentId}/render/${kind}`),
        );
      } catch (cause) {
        throw new NetworkError(cause);
      }
      if (!response.ok) {
        let code = 'HTTP_ERROR';
        let message = `HTTP ${String(response.status)}`;
        try {
          const body = (await response.json()) as ApiErrorBody;
          code = body.error.code;
          message = body.error.message;
        } catch {
          // binary endpoint error without a JSON body
        }
        throw new ApiError(response.status, code, message);
      }
      // Same contract as the estimate reports: content-type but no content-disposition;
      // the filename comes from the header when present, otherwise a stable
      // documentId-based fallback (no timestamps, no random ids).
      const filename =
        filenameFromDisposition(response.headers.get('content-disposition')) ??
        `costgenius-takeoff-${documentId}.${kind === 'excel' ? 'xlsx' : 'pdf'}`;
      return { blob: await response.blob(), filename };
    },
    async login(username, password) {
      return await request<AuthSession>('/auth/login', {
        method: 'POST',
        body: { username, password },
      });
    },
    async getSession() {
      return await request<AuthSession>('/auth/session');
    },
    async logout() {
      await request<undefined>('/auth/logout', { method: 'POST' });
    },
    async changePassword(currentPassword, newPassword) {
      return await request<PasswordChanged>('/auth/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
    },
    async health() {
      try {
        const response = await doFetch(url('/health'));
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
