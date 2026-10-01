/**
 * Row ↔ domain serialization for the Phase 14 schema.
 *
 * Every mapping is field-for-field and lossless: decimal strings stay exact strings
 * (numeric columns, string-typed), NULL stays NULL (blank ≠ zero), text codes keep their
 * leading zeros, embedded snapshots (sourceRef, trace, notes, dependencies) are copied
 * verbatim, and domain Instants are stored/read as their exact strings. IDs are
 * re-validated and re-branded on load (parseId/parseInstant), so a corrupted row fails
 * loudly instead of silently producing a bad domain object.
 */
import { parseId } from '@costgenius/domain';
import type { BoqLine, Estimate, EstimateVersion } from '@costgenius/boq';
import type { Project } from '@costgenius/projects';
import type { boqLines, estimateVersions, estimates, projects } from '../schema/index.js';

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type EstimateRow = typeof estimates.$inferSelect;
export type EstimateInsert = typeof estimates.$inferInsert;
export type VersionRow = typeof estimateVersions.$inferSelect;
export type VersionInsert = typeof estimateVersions.$inferInsert;
export type LineRow = typeof boqLines.$inferSelect;
export type LineInsert = typeof boqLines.$inferInsert;

export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}

export function projectToRow(project: Project): ProjectInsert {
  return {
    projectId: project.projectId,
    ...(project.organizationId !== undefined ? { organizationId: project.organizationId } : {}),
    title: project.title,
    metadata: { ...project.metadata },
    createdAt: project.createdAt,
  };
}

/**
 * Validates an ISO-8601 UTC instant WITHOUT normalizing it: the domain accepts both
 * '...T00:00:00Z' and '...T00:00:00.000Z', and the persisted string must round-trip
 * byte-identically (the database never reformats — or generates — domain time).
 */
export function validateInstant(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) {
    throw new Error(`persisted ${field} "${value}" is not an ISO-8601 UTC timestamp`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error(`persisted ${field} "${value}" is not a valid calendar date`);
  }
  return value;
}

export function projectFromRow(row: ProjectRow): Project {
  const organizationId =
    row.organizationId !== null ? parseId(row.organizationId, 'OrganizationId') : undefined;
  const project: Project = {
    projectId: parseId(row.projectId, 'ProjectId'),
    ...(organizationId !== undefined ? { organizationId } : {}),
    title: row.title,
    metadata: { ...row.metadata },
    createdAt: validateInstant(row.createdAt, 'project.createdAt'),
  };
  return deepFreeze(project);
}

export function versionToRow(version: EstimateVersion): VersionInsert {
  return {
    versionId: version.versionId,
    estimateId: version.estimateId,
    versionNumber: version.versionNumber,
    status: version.status,
    createdAt: version.createdAt,
    edition: version.edition,
    // P8-B S3 (D-PB-3 = B): the explicit edition binding. Omitted when the version
    // carries none — the insert then arrives NULL and the migration's insert-time
    // trigger stamps the ACTIVE edition (the S1 net; the API always passes the
    // resolved/explicit editionId explicitly, never relying on the stamp).
    ...(version.editionId !== undefined ? { editionId: version.editionId } : {}),
    ...(version.buildingId !== undefined ? { buildingId: version.buildingId } : {}),
    metadata: { ...version.metadata },
  };
}

export function lineToRow(versionId: string, lineIndex: number, line: BoqLine): LineInsert {
  return {
    versionId,
    lineIndex,
    lineId: line.lineId,
    pricebookCode: line.pricebookCode,
    chapter: line.chapter,
    groupNumber: line.group,
    description: line.description,
    unitLabel: line.unit.label,
    unitCode: line.unit.code,
    quantity: line.quantity,
    basePrice: line.basePrice,
    lineAmount: line.lineAmount,
    pricebookStatus: line.pricebookStatus,
    calculationStatus: line.calculationStatus,
    sourceRef: structuredClone(line.sourceRef),
    edition: line.edition,
    externalDependencies: [...line.externalDependencies],
    notes: [...line.notes],
    trace: structuredClone(line.trace),
    ...(line.buildingId !== undefined ? { buildingId: line.buildingId } : {}),
    ...(line.landscaping !== undefined ? { landscaping: line.landscaping } : {}),
  };
}

export function lineFromRow(row: LineRow): BoqLine {
  const line: BoqLine = {
    lineId: row.lineId,
    pricebookCode: row.pricebookCode,
    chapter: row.chapter,
    group: row.groupNumber,
    description: row.description,
    unit: { label: row.unitLabel, code: row.unitCode },
    quantity: row.quantity,
    basePrice: row.basePrice,
    lineAmount: row.lineAmount,
    pricebookStatus: row.pricebookStatus as BoqLine['pricebookStatus'],
    calculationStatus: row.calculationStatus as BoqLine['calculationStatus'],
    sourceRef: structuredClone(row.sourceRef),
    edition: row.edition,
    externalDependencies: [...row.externalDependencies],
    notes: [...row.notes],
    trace: structuredClone(row.trace),
    ...(row.buildingId !== null ? { buildingId: row.buildingId } : {}),
    ...(row.landscaping !== null ? { landscaping: row.landscaping } : {}),
  };
  return deepFreeze(line);
}

export function estimateFromRows(row: EstimateRow, versions: readonly EstimateVersion[]): Estimate {
  const estimate: Estimate = {
    estimateId: row.estimateId,
    projectId: row.projectId,
    title: row.title,
    versions: [...versions],
  };
  return deepFreeze(estimate);
}

export function versionFromRows(row: VersionRow, lines: readonly BoqLine[]): EstimateVersion {
  const version: EstimateVersion = {
    versionId: row.versionId,
    estimateId: row.estimateId,
    versionNumber: row.versionNumber,
    status: row.status as EstimateVersion['status'],
    createdAt: validateInstant(row.createdAt, 'version.createdAt'),
    edition: row.edition,
    ...(row.editionId !== null ? { editionId: row.editionId } : {}),
    ...(row.buildingId !== null ? { buildingId: row.buildingId } : {}),
    metadata: { ...row.metadata },
    lines: [...lines],
  };
  return deepFreeze(version);
}
