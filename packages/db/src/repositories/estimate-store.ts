/**
 * Shared persistence internals for the Estimate aggregate (used by both the estimate
 * repository and the finalized-estimate repository so the two can never disagree).
 *
 * `syncEstimate` is the transactional writer. It is strictly history-preserving:
 * - the referenced project must already be persisted (clear PERSISTENCE_CONFLICT if not);
 * - estimate identity (project, title) is immutable — a mismatch is a conflict;
 * - a version row is inserted once; its creation fields are immutable afterwards
 *   (P8-B S3: the `edition_id` binding among them — immutable once set, with the
 *   insert-time trigger-stamp asymmetry tolerated; see `editionBindingConflicts`);
 * - DRAFT versions only ever GAIN lines: the stored lines must be an exact prefix of the
 *   incoming ones (the domain only appends); anything else is a rewrite conflict;
 * - a FINALIZED version is compared byte-for-byte (canonical JSON): different content —
 *   or a downgrade back to draft — is FINALIZED_ESTIMATE_IMMUTABLE, never an update;
 * - the draft → finalized one-way transition is the only update ever issued;
 * - nothing is ever deleted.
 *
 * `loadEstimate` reassembles the aggregate (versions in number order, lines in insertion
 * order) with re-validated IDs and deep-frozen results.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import type { BoqLine, Estimate } from '@costgenius/boq';
import { canonicalJson } from '../canonical-json.js';
import type { DbExecutor } from '../db-executor.js';
import { boqLines, estimateVersions, estimates, projects } from '../schema/index.js';
import { DbError } from '../errors.js';
import {
  estimateFromRows,
  lineFromRow,
  lineToRow,
  versionFromRows,
  versionToRow,
} from './serialization.js';

/**
 * P8-B S3: does an incoming version's edition binding conflict with the stored row's?
 * The stored `edition_id` is authoritative and immutable (the migration trigger);
 * the comparison tolerates exactly one asymmetry — the incoming aggregate may predate
 * its own persistence and carry NO `editionId` while the stored row was stamped by
 * the insert-time trigger (an insert that arrived NULL). In that direction the stored
 * binding wins silently. But a version that PRESENTS an `editionId` must present
 * exactly the stored one: a different binding (or one the stored row never had) is a
 * creation-data conflict, never an update.
 */
function editionBindingConflicts(
  storedEditionId: string | null,
  incoming: string | undefined,
): boolean {
  if (incoming === undefined) return false;
  return storedEditionId !== incoming;
}

export async function syncEstimate(db: DbExecutor, estimate: Estimate): Promise<void> {
  const projectRow = (
    await db.select().from(projects).where(eq(projects.projectId, estimate.projectId))
  )[0];
  if (projectRow === undefined) {
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `project "${estimate.projectId}" of estimate "${estimate.estimateId}" is not persisted; persist the project first (the workflow's first transaction)`,
    );
  }

  const existingEstimate = (
    await db.select().from(estimates).where(eq(estimates.estimateId, estimate.estimateId))
  )[0];
  if (existingEstimate === undefined) {
    await db.insert(estimates).values({
      estimateId: estimate.estimateId,
      projectId: estimate.projectId,
      title: estimate.title,
    });
  } else if (
    existingEstimate.projectId !== estimate.projectId ||
    existingEstimate.title !== estimate.title
  ) {
    throw new DbError(
      'PERSISTENCE_CONFLICT',
      `estimate "${estimate.estimateId}" is already persisted with a different identity (project/title); estimate identity is immutable`,
    );
  }

  for (const version of estimate.versions) {
    // Phase 16 concurrency fix: lock the version row for the rest of the transaction.
    // Both the draft→finalized transition and draft line-appends pass through here, and
    // without the lock two transactions can interleave on the same version (one finalizes
    // while the other appends a line), leaving a finalized snapshot that no longer matches
    // the stored boq_lines. SELECT … FOR UPDATE serializes them: the transaction that
    // arrives second re-reads the committed state under the lock and fails with its
    // deterministic contract error instead of silently diverging from history.
    const versionRow = (
      await db
        .select()
        .from(estimateVersions)
        .where(eq(estimateVersions.versionId, version.versionId))
        .for('update')
    )[0];

    if (versionRow === undefined) {
      await db.insert(estimateVersions).values(versionToRow(version));
      for (const [index, line] of version.lines.entries()) {
        await db.insert(boqLines).values(lineToRow(version.versionId, index, line));
      }
      continue;
    }

    const storedLineRows = await db
      .select()
      .from(boqLines)
      .where(eq(boqLines.versionId, version.versionId))
      .orderBy(asc(boqLines.lineIndex));
    const storedLines = storedLineRows.map((row) => lineFromRow(row));

    if (versionRow.status === 'finalized') {
      // A finalized version is history: ANY difference — a downgrade to draft, different
      // creation data, or different lines — is FINALIZED_ESTIMATE_IMMUTABLE, never an update.
      const identical =
        version.status === 'finalized' &&
        versionRow.estimateId === version.estimateId &&
        versionRow.versionNumber === version.versionNumber &&
        versionRow.createdAt === version.createdAt &&
        versionRow.edition === version.edition &&
        !editionBindingConflicts(versionRow.editionId, version.editionId) &&
        versionRow.buildingId === (version.buildingId ?? null) &&
        canonicalJson(versionRow.metadata) === canonicalJson(version.metadata) &&
        canonicalJson(storedLines) === canonicalJson(version.lines);
      if (!identical) {
        throw new DbError(
          'FINALIZED_ESTIMATE_IMMUTABLE',
          `version "${version.versionId}" is finalized in the database and the incoming version differs; finalized versions are never rewritten`,
        );
      }
      continue;
    }

    if (
      versionRow.estimateId !== version.estimateId ||
      versionRow.versionNumber !== version.versionNumber ||
      versionRow.createdAt !== version.createdAt ||
      versionRow.edition !== version.edition ||
      editionBindingConflicts(versionRow.editionId, version.editionId) ||
      versionRow.buildingId !== (version.buildingId ?? null) ||
      canonicalJson(versionRow.metadata) !== canonicalJson(version.metadata)
    ) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `version "${version.versionId}" is already persisted with different creation data; version creation fields are immutable`,
      );
    }

    // stored version is DRAFT: lines may only be appended (stored = exact prefix of incoming)
    if (storedLines.length > version.lines.length) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `draft version "${version.versionId}" has ${String(storedLines.length)} persisted lines but ${String(version.lines.length)} were presented; lines are append-only`,
      );
    }
    for (let i = 0; i < storedLines.length; i += 1) {
      if (canonicalJson(storedLines[i]) !== canonicalJson(version.lines[i])) {
        throw new DbError(
          'PERSISTENCE_CONFLICT',
          `line ${String(i)} of draft version "${version.versionId}" differs from its persisted content; lines are append-only`,
        );
      }
    }
    for (let i = storedLines.length; i < version.lines.length; i += 1) {
      const line = version.lines[i];
      if (line !== undefined) {
        await db.insert(boqLines).values(lineToRow(version.versionId, i, line));
      }
    }

    if (version.status === 'finalized') {
      await db
        .update(estimateVersions)
        .set({ status: 'finalized' })
        .where(eq(estimateVersions.versionId, version.versionId));
    }
  }
}

export async function loadEstimate(
  db: DbExecutor,
  estimateId: string,
): Promise<Estimate | undefined> {
  const estimateRow = (
    await db.select().from(estimates).where(eq(estimates.estimateId, estimateId))
  )[0];
  if (estimateRow === undefined) return undefined;

  const versionRows = await db
    .select()
    .from(estimateVersions)
    .where(eq(estimateVersions.estimateId, estimateId))
    .orderBy(asc(estimateVersions.versionNumber));

  const versionIds = versionRows.map((row) => row.versionId);
  const lineRows =
    versionIds.length === 0
      ? []
      : await db
          .select()
          .from(boqLines)
          .where(inArray(boqLines.versionId, versionIds))
          .orderBy(asc(boqLines.lineIndex));

  const linesByVersion = new Map<string, BoqLine[]>();
  for (const row of lineRows) {
    const bucket = linesByVersion.get(row.versionId);
    if (bucket === undefined) {
      linesByVersion.set(row.versionId, [lineFromRow(row)]);
    } else {
      bucket.push(lineFromRow(row));
    }
  }

  const versions = versionRows.map((row) =>
    versionFromRows(row, linesByVersion.get(row.versionId) ?? []),
  );
  return estimateFromRows(estimateRow, versions);
}
