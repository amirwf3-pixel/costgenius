/**
 * The ReportModel — stage 1 of the two-stage reporting design.
 *
 * A report is an immutable, rendering-independent SNAPSHOT of one BOQ estimate version:
 * it copies (never references) the lines, and every number in it comes from the upstream
 * BOQ rollup — the one authoritative aggregation path. This layer performs no calculation
 * of its own: no quantity × price, no subtotal, no total (implementation-contract §22).
 * Excel/PDF/UI renderers consume this model later and get the same numbers, statuses,
 * dependencies and traces for free.
 *
 * Provenance is preserved end-to-end: each line keeps its exact pricebook identity
 * (code, chapter, group, description, unit, sourceRef, edition), its calculation trace and
 * its external dependency ids; the summary keeps the deduplicated dependency summary with
 * per-line attribution; an optional S4 estimate result is carried verbatim in
 * `generatedFrom` so the coefficient chain (floor → overhead → regional → + site setup)
 * stays inspectable without being recomputed.
 */
import type { EstimateResult } from '@costgenius/cost-calculation';
import {
  combinedMultiBuildingRollup,
  combinedMultiDisciplineRollup,
  getVersion,
  groupLinesByChapterGroup,
  rollupBoqLines,
  type BlockedRollup,
  type BoqLine,
  type BoqRollup,
  type Estimate,
  type EstimateVersionStatus,
} from '@costgenius/boq';
import { ReportingError } from './errors.js';
import { validateReportModel } from './validation.js';

/**
 * A report line IS a BOQ line (contract reused, never duplicated): every field needed to
 * explain the number — identity, pricebook row data, unit, quantity, base price, amount,
 * both statuses, sourceRef, edition, external dependencies and the structured trace.
 */
export type ReportLine = BoqLine;

/** A deduplicated external-dependency summary; per-line provenance stays on each line. */
export interface ReportDependency {
  readonly id: string;
  /** Lines carrying this dependency, in report line order. */
  readonly lineIds: readonly string[];
}

/** Stable report identity and provenance metadata (all caller- or source-supplied). */
export interface ReportMetadata {
  readonly reportId: string;
  readonly estimateId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly projectId: string;
  readonly title: string;
  /** Pricebook edition of the version (e.g. "1404"); editions are never mixed. */
  readonly edition: string;
  /** The source version's own status (draft | finalized), preserved as-is. */
  readonly versionStatus: EstimateVersionStatus;
  /** The version's caller-supplied creation instant. */
  readonly createdAt: string;
  /** Caller-supplied generation instant; null when not supplied (pure layer: no clock). */
  readonly generatedAt: string | null;
  /** Building attribution when the version carries one (metadata only; no combined rule). */
  readonly buildingId: string | null;
  readonly versionMetadata: Readonly<Record<string, string>>;
}

/** The estimate-level summary — every figure copied from the authoritative BOQ rollup. */
export interface ReportSummary {
  readonly estimateId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly edition: string;
  /** Aggregated calculation status of the whole version (never upgraded here). */
  readonly status: BoqRollup['status'];
  /** Authoritative total, or null unless the whole version is COMPLETE (never 0 for pending). */
  readonly amount: string | null;
  readonly lineCount: number;
  readonly pricedLineCount: number;
  readonly pendingLineCount: number;
  readonly dependencies: readonly ReportDependency[];
}

/** One chapter+group section: status-honest subtotal plus the section's lines. */
export interface ReportGroup {
  readonly chapter: string;
  readonly group: string;
  readonly status: BoqRollup['status'];
  /** Exact group subtotal from the rollup, or null unless the group is COMPLETE. */
  readonly amount: string | null;
  readonly lineCount: number;
  readonly pricedLineCount: number;
  readonly pendingLineCount: number;
  readonly dependencies: readonly string[];
  readonly lines: readonly ReportLine[];
}

/** One chapter section: status-honest subtotal plus its group sections. */
export interface ReportChapter {
  readonly chapter: string;
  readonly status: BoqRollup['status'];
  /** Exact chapter subtotal from the rollup, or null unless the chapter is COMPLETE. */
  readonly amount: string | null;
  readonly lineCount: number;
  readonly pricedLineCount: number;
  readonly pendingLineCount: number;
  readonly dependencies: readonly string[];
  readonly groups: readonly ReportGroup[];
}

/**
 * Scope boundaries carried verbatim from the BOQ layer: the 1404 source specifies no
 * combined multi-building or multi-discipline coefficient chain, and the report says so
 * instead of inventing a combination (NOT_SPECIFIED is preserved, never repaired).
 */
export interface ReportScopeBoundaries {
  readonly multiBuildingCombination: BlockedRollup;
  readonly multiDisciplineCombination: BlockedRollup;
}

/** Where the report came from — estimate/version identity and the optional S4 result. */
export interface ReportProvenance {
  readonly estimate: {
    readonly estimateId: string;
    readonly projectId: string;
    readonly title: string;
  };
  readonly version: {
    readonly versionId: string;
    readonly versionNumber: number;
    readonly status: EstimateVersionStatus;
    readonly createdAt: string;
    readonly buildingId: string | null;
    readonly metadata: Readonly<Record<string, string>>;
  };
  readonly generatedAt: string | null;
  /**
   * The S4 execution-cost result, preserved verbatim (structured clone) when the caller
   * supplies one. Reporting never recomputes, reorders or re-rounds its stages.
   */
  readonly s4Estimate: EstimateResult | null;
}

/** The immutable report snapshot handed to future renderers (Excel/PDF/UI). */
export interface ReportModel {
  readonly reportId: string;
  readonly metadata: ReportMetadata;
  readonly summary: ReportSummary;
  /** Chapter sections in BOQ first-appearance order (never sorted for presentation). */
  readonly chapters: readonly ReportChapter[];
  readonly scopeBoundaries: ReportScopeBoundaries;
  readonly generatedFrom: ReportProvenance;
}

export interface BuildReportInput {
  /** Caller-supplied report identity; no randomness inside the pure layer. */
  readonly reportId: string;
  readonly estimate: Estimate;
  readonly versionId: string;
  /** Caller-supplied generation instant (ISO string); omitted → null. */
  readonly generatedAt?: string;
  /**
   * Optional S4 estimate result for this estimate; preserved verbatim in the provenance.
   * Its estimateId (and buildingId, when the version carries one) must match the version.
   */
  readonly s4Estimate?: EstimateResult;
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
    throw new ReportingError('INVALID_REPORT_INPUT', `${field} must be a non-empty string`);
  }
}

/** Deduplicated dependency summary in first-appearance order, with per-line attribution. */
function dependencySummary(lines: readonly BoqLine[]): ReportDependency[] {
  const order: string[] = [];
  const lineIds = new Map<string, string[]>();
  for (const line of lines) {
    for (const id of line.externalDependencies) {
      const existing = lineIds.get(id);
      if (existing === undefined) {
        order.push(id);
        lineIds.set(id, [line.lineId]);
      } else {
        existing.push(line.lineId);
      }
    }
  }
  return order.map((id) => {
    const ids = lineIds.get(id);
    return { id, lineIds: [...(ids ?? [])] };
  });
}

/** Maps (chapter → group → lines) once, in the BOQ layer's first-appearance order. */
function linesByChapterGroup(
  lines: readonly BoqLine[],
): Map<string, Map<string, readonly BoqLine[]>> {
  const byGroup = new Map<string, Map<string, readonly BoqLine[]>>();
  for (const group of groupLinesByChapterGroup(lines)) {
    let chapters = byGroup.get(group.chapter);
    if (chapters === undefined) {
      chapters = new Map<string, readonly BoqLine[]>();
      byGroup.set(group.chapter, chapters);
    }
    chapters.set(group.group, group.lines);
  }
  return byGroup;
}

function groupLinesOf(
  byGroup: Map<string, Map<string, readonly BoqLine[]>>,
  chapter: string,
  group: string,
): readonly BoqLine[] {
  return byGroup.get(chapter)?.get(group) ?? [];
}

/**
 * Builds the ReportModel: a deep-cloned, frozen snapshot of one BOQ estimate version.
 *
 * Section structure and ordering come from the BOQ grouping (first appearance); every
 * amount, status and count comes from the BOQ rollup — this function adds no arithmetic.
 * An unknown versionId propagates the BOQ layer's `VERSION_NOT_FOUND` BoqError.
 */
export function buildReportModel(input: BuildReportInput): ReportModel {
  requireNonEmpty(input.reportId, 'reportId');
  requireNonEmpty(input.versionId, 'versionId');
  const version = getVersion(input.estimate, input.versionId);
  if (input.generatedAt !== undefined) {
    requireNonEmpty(input.generatedAt, 'generatedAt');
  }
  if (input.s4Estimate !== undefined) {
    if (input.s4Estimate.estimateId !== version.estimateId) {
      throw new ReportingError(
        'S4_MISMATCH',
        `the S4 estimate result belongs to estimate "${input.s4Estimate.estimateId}" but version ${version.versionId} belongs to estimate "${version.estimateId}"`,
      );
    }
    if (version.buildingId !== undefined && input.s4Estimate.buildingId !== version.buildingId) {
      throw new ReportingError(
        'S4_MISMATCH',
        `the S4 estimate result is for building "${input.s4Estimate.buildingId}" but version ${version.versionId} is for building "${version.buildingId}"`,
      );
    }
  }

  // The one authoritative aggregation path — consumed, never reimplemented here.
  const rollup = rollupBoqLines(version.lines);
  const byGroup = linesByChapterGroup(version.lines);

  const chapters: ReportChapter[] = rollup.chapterSubtotals.map((chapter) => ({
    chapter: chapter.chapter,
    status: chapter.status,
    amount: chapter.amount,
    lineCount: chapter.lineCount,
    pricedLineCount: chapter.pricedLineCount,
    pendingLineCount: chapter.pendingLineCount,
    dependencies: [...chapter.dependencies],
    groups: chapter.groupSubtotals.map((group) => ({
      chapter: group.chapter,
      group: group.group,
      status: group.status,
      amount: group.amount,
      lineCount: group.lineCount,
      pricedLineCount: group.pricedLineCount,
      pendingLineCount: group.pendingLineCount,
      dependencies: [...group.dependencies],
      // Deep clone: the report owns its lines; later source objects cannot alter it.
      lines: groupLinesOf(byGroup, group.chapter, group.group).map((line) => structuredClone(line)),
    })),
  }));

  const report: ReportModel = {
    reportId: input.reportId,
    metadata: {
      reportId: input.reportId,
      estimateId: version.estimateId,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      projectId: input.estimate.projectId,
      title: input.estimate.title,
      edition: version.edition,
      versionStatus: version.status,
      createdAt: version.createdAt,
      generatedAt: input.generatedAt ?? null,
      buildingId: version.buildingId ?? null,
      versionMetadata: { ...version.metadata },
    },
    summary: {
      estimateId: version.estimateId,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      edition: version.edition,
      status: rollup.status,
      amount: rollup.amount,
      lineCount: rollup.lineCount,
      pricedLineCount: rollup.pricedLineCount,
      pendingLineCount: rollup.pendingLineCount,
      dependencies: dependencySummary(version.lines),
    },
    chapters,
    scopeBoundaries: {
      multiBuildingCombination: combinedMultiBuildingRollup(),
      multiDisciplineCombination: combinedMultiDisciplineRollup(),
    },
    generatedFrom: {
      estimate: {
        estimateId: input.estimate.estimateId,
        projectId: input.estimate.projectId,
        title: input.estimate.title,
      },
      version: {
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        status: version.status,
        createdAt: version.createdAt,
        buildingId: version.buildingId ?? null,
        metadata: { ...version.metadata },
      },
      generatedAt: input.generatedAt ?? null,
      s4Estimate: input.s4Estimate === undefined ? null : structuredClone(input.s4Estimate),
    },
  };

  // Defensive consistency pass: a correctly built report always passes; a regression in
  // this builder must fail loudly instead of emitting an inconsistent snapshot.
  const errors = validateReportModel(report, {
    estimate: input.estimate,
    version,
    rollup,
  });
  if (errors.length > 0) {
    throw new ReportingError(
      'INVALID_REPORT',
      'the built report failed its own consistency validation',
      errors.map((e) => `${e.field}: ${e.message}`),
    );
  }

  return deepFreeze(report);
}
