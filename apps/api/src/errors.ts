/**
 * Error mapping: domain/application errors → HTTP status → stable JSON error body.
 *
 * The mapping is deterministic and total. Domain error CODES are surfaced verbatim —
 * never renamed, never swallowed. Errors are discriminated by their stable `name`
 * ('DomainError', 'BoqError', 'ProjectsError', 'DbError', 'EstimateInputError',
 * 'ZodError') so this layer stays decoupled from the inner packages' modules; an unknown
 * error becomes a generic 500 with no stack trace and no internal detail leaked.
 *
 * Status choices (stable contract):
 * - 400 INVALID_REQUEST       — malformed JSON / schema violation (Zod details included)
 * - 400 DomainError codes     — invalid ids, instants, decimals, units at the boundary
 * - 404 NOT_FOUND             — unknown project/estimate/version identity
 * - 409 BoqError/DbError      — VERSION_FINALIZED, duplicates, edition mismatch,
 *                               FINALIZED_ESTIMATE_IMMUTABLE, PERSISTENCE_CONFLICT,
 *                               TAKEOFF_DOCUMENT_IMMUTABLE, TAKEOFF_INVALID_TRANSITION
 * - 409 render-of-draft       — VERSION_NOT_FINALIZED (sent inline by the Excel/PDF
 *                               render routes when the version is still a draft)
 * - 409/422 takeoff (D-016)   — TAKEOFF_INVALID_TRANSITION (invalid lifecycle move or
 *                               mutation of a finalized document — the domain guard
 *                               fires first and its code surfaces verbatim),
 *                               INVALID_TAKEOFF_INPUT (400), TAKEOFF_CALCULATION_FAILED
 *                               (422; engine codes ride in the message). The authoring
 *                               policy 422 TAKEOFF_DOCUMENT_REJECTED (R3=A: non-`design`
 *                               rounding sourceStatus) is sent inline by the save route.
 * - 422 takeoff preview (P7-S2) — the stateless draft calculation preview sends 422
 *                               TAKEOFF_SOLUTION_REJECTED inline with the engine's
 *                               structured failures under details.failures (CG-FT@0.2.0
 *                               §12.2, D-ERROR=C) — DISTINCT from finalization's
 *                               TAKEOFF_CALCULATION_FAILED above; the two never alias.
 * - 401 AuthError (P8-A S1)   — UNAUTHENTICATED (missing/expired/invalid session) and
 *                               AUTH_INVALID_CREDENTIALS (uniform login failure, no
 *                               user enumeration; CG-GOV@0.1.0 §1.6/§8).
 * - 422 binding/S4 failures   — BOQ_LINES_REJECTED (S2 codes in details),
 *                               ESTIMATE_INPUT_ERROR, VERSION_WITHOUT_BUILDING,
 *                               TAKEOFF_QUANTITIES_REJECTED (D-015: calc-engine S1
 *                               errors in details; engine codes are never public)
 * - 500                       — structural/configuration failures, unknown errors
 */
import { ZodError } from 'zod';

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export interface ApiErrorMapping {
  readonly status: number;
  readonly body: ApiErrorBody;
}

const BOQ_STATUS: Readonly<Record<string, number>> = {
  VERSION_NOT_FOUND: 404,
  VERSION_FINALIZED: 409,
  DUPLICATE_LINE_ID: 409,
  DUPLICATE_VERSION_ID: 409,
  EDITION_MISMATCH: 409,
  INVALID_ESTIMATE: 400,
  INVALID_LINE: 400,
  LINE_MISMATCH: 400,
};

const PROJECTS_STATUS: Readonly<Record<string, number>> = {
  INVALID_PROJECT_INPUT: 400,
  INVALID_LINE_UNIT: 400,
  INVALID_TAKEOFF_INPUT: 400,
  VERSION_WITHOUT_BUILDING: 422,
  TAKEOFF_CALCULATION_FAILED: 422,
  TAKEOFF_INVALID_TRANSITION: 409,
  EMPTY_DATASET: 500,
  INCONSISTENT_DATASET_EDITION: 500,
};

const DB_STATUS: Readonly<Record<string, number>> = {
  FINALIZED_ESTIMATE_IMMUTABLE: 409,
  PERSISTENCE_CONFLICT: 409,
  TAKEOFF_DOCUMENT_IMMUTABLE: 409,
  TAKEOFF_INVALID_TRANSITION: 409,
};

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : 'no message';
}

/** Maps any thrown error to its stable HTTP status and JSON error body. */
export function mapError(error: unknown): ApiErrorMapping {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'INVALID_REQUEST',
          message: 'the request body or parameters do not match the API contract',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
    };
  }

  const name = (error as { name?: unknown }).name;
  const code = errorCode(error);

  if (name === 'BoqError' && code !== undefined) {
    const status = BOQ_STATUS[code] ?? 400;
    return { status, body: { error: { code, message: errorMessage(error) } } };
  }
  if (name === 'AuthError' && (code === 'UNAUTHENTICATED' || code === 'AUTH_INVALID_CREDENTIALS')) {
    // The P8-A S1 authentication error contract (CG-GOV §1.6/§8) — new codes only;
    // every existing code above and below is preserved verbatim.
    return { status: 401, body: { error: { code, message: errorMessage(error) } } };
  }
  if (name === 'ProjectsError' && code !== undefined) {
    const status = PROJECTS_STATUS[code] ?? 400;
    return { status, body: { error: { code, message: errorMessage(error) } } };
  }
  if (name === 'DbError' && code !== undefined) {
    const status = DB_STATUS[code] ?? 500;
    return { status, body: { error: { code, message: errorMessage(error) } } };
  }
  if (name === 'EstimateInputError') {
    return {
      status: 422,
      body: { error: { code: 'ESTIMATE_INPUT_ERROR', message: errorMessage(error) } },
    };
  }
  if (name === 'DomainError' && code !== undefined) {
    return { status: 400, body: { error: { code, message: errorMessage(error) } } };
  }

  // Framework-level transport errors (Fastify FST_ERR_*): malformed JSON (400),
  // oversized bodies (413), unsupported media types (415), … They carry a statusCode
  // but no domain `code`; without this branch they would fall through as 500s and
  // mislead clients into treating their own bad request as a server outage.
  const transportStatus = (error as { statusCode?: unknown }).statusCode;
  if (typeof transportStatus === 'number' && transportStatus >= 400 && transportStatus < 500) {
    return {
      status: transportStatus,
      body: {
        error: {
          code: transportStatus === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
          message:
            transportStatus === 413
              ? 'the request body exceeds the accepted size limit'
              : 'the request could not be parsed (malformed JSON or unsupported content type)',
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'an unexpected error occurred; no internal detail is exposed',
      },
    },
  };
}

/** A stable not-found reply for unknown identities. */
export function notFound(entity: string, id: string): ApiErrorMapping {
  return {
    status: 404,
    body: { error: { code: 'NOT_FOUND', message: `no ${entity} with id "${id}" exists` } },
  };
}
