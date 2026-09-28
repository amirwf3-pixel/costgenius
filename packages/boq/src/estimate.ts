/**
 * Estimate identity and versioning — immutable transitions only.
 *
 * An `Estimate` is a thin aggregate (identity + ordered versions). All calculation content
 * lives in `EstimateVersion`s, which are appended, never edited: `addBoqLine` and
 * `finalizeEstimateVersion` return a NEW estimate that shares the previous frozen version
 * objects unchanged, so history is stable by construction. A finalized version rejects
 * further lines (VERSION_FINALIZED); changes require a new version number. Version numbers
 * are sequential integers starting at 1 and are generated, never floating. `createdAt` is a
 * caller-supplied instant — this layer is pure and reads no clock.
 */
import type { BoqLine } from './boq-line.js';
import { BoqError } from './errors.js';
import { validateBoqLines } from './validation.js';

export type EstimateVersionStatus = 'draft' | 'finalized';

export interface Estimate {
  readonly estimateId: string;
  readonly projectId: string;
  readonly title: string;
  readonly versions: readonly EstimateVersion[];
}

export interface EstimateVersion {
  readonly versionId: string;
  readonly estimateId: string;
  readonly versionNumber: number;
  readonly status: EstimateVersionStatus;
  /** Caller-supplied instant (pure layer: no clock). */
  readonly createdAt: string;
  /** Edition identity every line of this version must share (e.g. "1404"); editions are never mixed. */
  readonly edition: string;
  readonly buildingId?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly lines: readonly BoqLine[];
}

export interface CreateEstimateInput {
  readonly estimateId: string;
  readonly projectId: string;
  readonly title: string;
}

export interface CreateVersionInput {
  readonly createdAt: string;
  readonly edition: string;
  readonly buildingId?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly lines?: readonly BoqLine[];
  /** Defaults to `${estimateId}-v${versionNumber}`. */
  readonly versionId?: string;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new BoqError('INVALID_ESTIMATE', `${field} must be a non-empty string`);
  }
}

/** Creates an empty estimate (no versions). */
export function createEstimate(input: CreateEstimateInput): Estimate {
  requireNonEmpty(input.estimateId, 'estimateId');
  requireNonEmpty(input.projectId, 'projectId');
  requireNonEmpty(input.title, 'title');
  return deepFreeze({
    estimateId: input.estimateId,
    projectId: input.projectId,
    title: input.title,
    versions: [] as readonly EstimateVersion[],
  });
}

function checkLines(version: Omit<EstimateVersion, 'status'>, edition: string): void {
  const errors = validateBoqLines(version.lines);
  if (errors.length > 0) {
    throw new BoqError(
      'INVALID_LINE',
      'invalid BOQ line(s)',
      errors.map((e) => e.message),
    );
  }
  for (const line of version.lines) {
    if (line.lineId.length === 0) throw new BoqError('INVALID_LINE', 'lineId must be non-empty');
    if (line.edition !== edition) {
      throw new BoqError(
        'EDITION_MISMATCH',
        `line ${line.lineId} belongs to edition "${line.edition}" but the version is edition "${edition}"; editions are never mixed`,
      );
    }
  }
}

/** Appends the next draft version (number = previous + 1, sequential by construction). */
export function createEstimateVersion(estimate: Estimate, input: CreateVersionInput): Estimate {
  requireNonEmpty(input.createdAt, 'createdAt');
  requireNonEmpty(input.edition, 'edition');
  const versionNumber = estimate.versions.length + 1;
  const versionId = input.versionId ?? `${estimate.estimateId}-v${String(versionNumber)}`;
  if (estimate.versions.some((v) => v.versionId === versionId)) {
    throw new BoqError('DUPLICATE_VERSION_ID', `versionId "${versionId}" already exists`);
  }
  const draft: EstimateVersion = deepFreeze({
    versionId,
    estimateId: estimate.estimateId,
    versionNumber,
    status: 'draft',
    createdAt: input.createdAt,
    edition: input.edition,
    metadata: { ...input.metadata },
    lines: [...(input.lines ?? [])],
    ...(input.buildingId !== undefined ? { buildingId: input.buildingId } : {}),
  });
  checkLines(draft, input.edition);
  return deepFreeze({ ...estimate, versions: [...estimate.versions, draft] });
}

function findVersion(estimate: Estimate, versionId: string): EstimateVersion {
  const version = estimate.versions.find((v) => v.versionId === versionId);
  if (version === undefined) {
    throw new BoqError(
      'VERSION_NOT_FOUND',
      `no version "${versionId}" in estimate ${estimate.estimateId}`,
    );
  }
  return version;
}

/**
 * Adds one BOQ line to a DRAFT version. Returns a new estimate; the input estimate and all
 * other versions (including any finalized one) are unchanged. Finalized versions reject
 * lines; duplicate lineIds and edition mixing are rejected.
 */
export function addBoqLine(estimate: Estimate, versionId: string, line: BoqLine): Estimate {
  const version = findVersion(estimate, versionId);
  if (version.status === 'finalized') {
    throw new BoqError(
      'VERSION_FINALIZED',
      `version ${versionId} is finalized and cannot be modified; create a new version instead`,
    );
  }
  if (version.lines.some((existing) => existing.lineId === line.lineId)) {
    throw new BoqError(
      'DUPLICATE_LINE_ID',
      `lineId "${line.lineId}" already exists in version ${versionId}`,
    );
  }
  checkLines({ ...version, lines: [...version.lines, line] }, version.edition);
  const updated: EstimateVersion = deepFreeze({ ...version, lines: [...version.lines, line] });
  const versions = estimate.versions.map((v) => (v.versionId === versionId ? updated : v));
  return deepFreeze({ ...estimate, versions });
}

/** Finalizes a DRAFT version (one-way; a finalized version is immutable). */
export function finalizeEstimateVersion(estimate: Estimate, versionId: string): Estimate {
  const version = findVersion(estimate, versionId);
  if (version.status === 'finalized') {
    throw new BoqError('VERSION_FINALIZED', `version ${versionId} is already finalized`);
  }
  const finalized: EstimateVersion = deepFreeze({ ...version, status: 'finalized' });
  const versions = estimate.versions.map((v) => (v.versionId === versionId ? finalized : v));
  return deepFreeze({ ...estimate, versions });
}

export function getVersion(estimate: Estimate, versionId: string): EstimateVersion {
  return findVersion(estimate, versionId);
}

/** The most recently created version, or undefined for an estimate without versions. */
export function getCurrentVersion(estimate: Estimate): EstimateVersion | undefined {
  return estimate.versions[estimate.versions.length - 1];
}
