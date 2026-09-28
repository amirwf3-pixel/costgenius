/**
 * The estimate workflow — thin orchestration of the BOQ lifecycle (Phase 13).
 *
 * Project → Estimate → EstimateVersion → BOQ lines, each step delegating to the layer
 * that owns the rule and adding no rule of its own. The version's edition is derived from
 * the dataset the caller resolves lines against (editions are never mixed — the BOQ layer
 * enforces it line by line). Line inputs resolve all-or-nothing: any S2 failure (unknown
 * code, unit mismatch, invalid decimal) leaves the estimate untouched and reports every
 * failure deterministically.
 */
import {
  addBoqLine as boqAddBoqLine,
  createEstimate as boqCreateEstimate,
  createEstimateVersion as boqCreateEstimateVersion,
  getCurrentVersion,
  type BoqLine,
  type Estimate,
  type EstimateVersion,
} from '@costgenius/boq';
import { parseInstant } from '@costgenius/domain';
import type { PublishedDataset } from '@costgenius/pricebook';
import { ProjectsError } from './errors.js';
import {
  resolveEstimateLines,
  type EstimateLineInput,
  type LineResolutionFailure,
} from './estimate-lines.js';
import type { Project } from './project.js';

export interface CreateEstimateForProjectInput {
  readonly estimateId: string;
  readonly title: string;
}

/** Creates an empty estimate under a project (identity + ordered versions; no content). */
export function createEstimateForProject(
  project: Project,
  input: CreateEstimateForProjectInput,
): Estimate {
  if (typeof input.estimateId !== 'string' || input.estimateId.length === 0) {
    throw new ProjectsError('INVALID_PROJECT_INPUT', 'estimateId must be a non-empty string');
  }
  if (typeof input.title !== 'string' || input.title.length === 0) {
    throw new ProjectsError('INVALID_PROJECT_INPUT', 'title must be a non-empty string');
  }
  return boqCreateEstimate({
    estimateId: input.estimateId,
    projectId: project.projectId,
    title: input.title,
  });
}

export interface StartVersionInput {
  /** Caller-supplied creation instant (ISO string; validated; this layer reads no clock). */
  readonly createdAt: string;
  /** The single-building scope of the version; required for S4 calculability. */
  readonly buildingId: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly versionId?: string;
}

/**
 * The edition identity every row of this dataset carries (e.g. "1404"). All rows of a
 * published dataset share one edition — verified once here, so a version created against
 * the dataset can never mix editions.
 */
export function datasetEditionOf(dataset: PublishedDataset): string {
  const first = dataset.rows[0];
  if (first === undefined) {
    throw new ProjectsError('EMPTY_DATASET', 'the dataset publishes no rows');
  }
  const edition = first.sourceRef.edition;
  if (edition.length === 0) {
    throw new ProjectsError('INCONSISTENT_DATASET_EDITION', 'the dataset rows carry no edition');
  }
  for (const row of dataset.rows) {
    if (row.sourceRef.edition !== edition) {
      throw new ProjectsError(
        'INCONSISTENT_DATASET_EDITION',
        `the dataset mixes editions "${edition}" and "${row.sourceRef.edition}" (rows ${first.code} and ${row.code}); editions are never mixed`,
      );
    }
  }
  return edition;
}

/** Appends the next DRAFT version, edition-bound to the dataset the lines will resolve against. */
export function startEstimateVersion(
  dataset: PublishedDataset,
  estimate: Estimate,
  input: StartVersionInput,
): Estimate {
  parseInstant(input.createdAt);
  if (typeof input.buildingId !== 'string' || input.buildingId.length === 0) {
    throw new ProjectsError(
      'INVALID_PROJECT_INPUT',
      'buildingId must be a non-empty string (the verified S4 chain is single-building)',
    );
  }
  return boqCreateEstimateVersion(estimate, {
    createdAt: input.createdAt,
    edition: datasetEditionOf(dataset),
    buildingId: input.buildingId,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.versionId !== undefined ? { versionId: input.versionId } : {}),
  });
}

export type AddLinesResult =
  | { readonly ok: true; readonly estimate: Estimate; readonly lines: readonly BoqLine[] }
  | { readonly ok: false; readonly failures: readonly LineResolutionFailure[] };

/**
 * Resolves line inputs against the dataset and adds them to a DRAFT version.
 * All-or-nothing: when any line fails to bind, the estimate is NOT modified and every
 * failure is reported; on success every resolved line is appended in input order and the
 * updated estimate is returned (the input estimate is never mutated).
 */
export function addEstimateLines(
  dataset: PublishedDataset,
  estimate: Estimate,
  versionId: string,
  inputs: readonly EstimateLineInput[],
): AddLinesResult {
  const resolution = resolveEstimateLines(dataset, inputs);
  if (!resolution.ok) return { ok: false, failures: resolution.failures };
  let updated = estimate;
  for (const line of resolution.lines) {
    updated = boqAddBoqLine(updated, versionId, line);
  }
  return { ok: true, estimate: updated, lines: resolution.lines };
}

/** The most recently created version of the estimate, or undefined when there is none. */
export function currentVersionOf(estimate: Estimate): EstimateVersion | undefined {
  return getCurrentVersion(estimate);
}
