/**
 * Report validation — complete, strict, never repairing.
 *
 * A report is checked against its AUTHORITATIVE sources: the BOQ estimate version (for
 * identity, hierarchy and line coverage) and the BOQ rollup (for every amount, status and
 * count). Nothing is recalculated here and nothing is fixed: a mismatch is reported as an
 * error for the caller to reject (implementation-contract §§28–31).
 */
import {
  combinedMultiBuildingRollup,
  combinedMultiDisciplineRollup,
  validateBoqLine,
  type BoqRollup,
  type Estimate,
  type EstimateVersion,
} from '@costgenius/boq';
import type { ReportChapter, ReportModel } from './report-model.js';

export interface ReportValidationError {
  readonly field: string;
  readonly message: string;
}

/** The authoritative sources a report is validated against. */
export interface ReportValidationSource {
  readonly estimate: Estimate;
  readonly version: EstimateVersion;
  readonly rollup: BoqRollup;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const value of b) {
    if (!set.has(value)) return false;
  }
  return true;
}

function sameRecord(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function equalOrNull(a: string | null, b: string | null): boolean {
  return a === b;
}

interface SectionCounts {
  readonly lineCount: number;
  readonly pricedLineCount: number;
  readonly pendingLineCount: number;
}

function checkCounts(
  errors: ReportValidationError[],
  field: string,
  section: SectionCounts,
  expected: SectionCounts,
): void {
  for (const key of ['lineCount', 'pricedLineCount', 'pendingLineCount'] as const) {
    if (section[key] !== expected[key]) {
      errors.push({
        field: `${field}.${key}`,
        message: `${key} is ${String(section[key])} but the authoritative rollup says ${String(expected[key])}`,
      });
    }
  }
}

/**
 * Validates a report against its sources. Returns every violation (empty array = valid);
 * never throws for inconsistent data and never repairs anything.
 */
export function validateReportModel(
  report: ReportModel,
  source: ReportValidationSource,
): ReportValidationError[] {
  const errors: ReportValidationError[] = [];
  const { estimate, version, rollup } = source;
  const add = (field: string, message: string): void => {
    errors.push({ field, message });
  };

  // ---- identity (§28) -------------------------------------------------------------------
  if (report.reportId.length === 0) add('reportId', 'reportId must be a non-empty string');
  if (report.metadata.reportId !== report.reportId) {
    add('metadata.reportId', 'metadata.reportId must equal the report reportId');
  }
  if (estimate.estimateId !== version.estimateId) {
    add('estimate', 'the estimate does not contain this version');
  }

  const m = report.metadata;
  if (m.estimateId !== version.estimateId) {
    add('metadata.estimateId', `must be "${version.estimateId}"`);
  }
  if (m.versionId !== version.versionId) {
    add('metadata.versionId', `must be "${version.versionId}"`);
  }
  if (!Number.isInteger(m.versionNumber) || m.versionNumber < 1) {
    add('metadata.versionNumber', 'versionNumber must be a positive integer');
  } else if (m.versionNumber !== version.versionNumber) {
    add('metadata.versionNumber', `must be ${String(version.versionNumber)}`);
  }
  if (m.projectId !== estimate.projectId) {
    add('metadata.projectId', `must be "${estimate.projectId}"`);
  }
  if (m.title !== estimate.title) {
    add('metadata.title', `must be "${estimate.title}"`);
  }
  if (m.edition !== version.edition) {
    add('metadata.edition', `must be "${version.edition}" (editions are never mixed)`);
  }
  if (m.versionStatus !== version.status) {
    add('metadata.versionStatus', `must be "${version.status}"`);
  }
  if (m.createdAt !== version.createdAt) {
    add('metadata.createdAt', 'must equal the version createdAt');
  }
  if (m.buildingId !== (version.buildingId ?? null)) {
    add('metadata.buildingId', 'must equal the version buildingId (null when absent)');
  }
  if (!sameRecord(m.versionMetadata, version.metadata)) {
    add('metadata.versionMetadata', 'must equal the version metadata');
  }

  // ---- provenance (generatedFrom) --------------------------------------------------------
  const p = report.generatedFrom;
  if (p.estimate.estimateId !== version.estimateId) {
    add('generatedFrom.estimate.estimateId', `must be "${version.estimateId}"`);
  }
  if (p.estimate.projectId !== estimate.projectId) {
    add('generatedFrom.estimate.projectId', `must be "${estimate.projectId}"`);
  }
  if (p.estimate.title !== estimate.title) {
    add('generatedFrom.estimate.title', `must be "${estimate.title}"`);
  }
  if (
    p.version.versionId !== version.versionId ||
    p.version.versionNumber !== version.versionNumber ||
    p.version.status !== version.status ||
    p.version.createdAt !== version.createdAt ||
    p.version.buildingId !== (version.buildingId ?? null) ||
    !sameRecord(p.version.metadata, version.metadata)
  ) {
    add('generatedFrom.version', 'must mirror the source version identity and metadata');
  }
  if (p.s4Estimate !== null) {
    if (p.s4Estimate.estimateId !== version.estimateId) {
      add(
        'generatedFrom.s4Estimate',
        `the S4 result belongs to estimate "${p.s4Estimate.estimateId}", not "${version.estimateId}"`,
      );
    }
    if (version.buildingId !== undefined && p.s4Estimate.buildingId !== version.buildingId) {
      add(
        'generatedFrom.s4Estimate',
        `the S4 result is for building "${p.s4Estimate.buildingId}", not "${version.buildingId}"`,
      );
    }
  }

  // ---- summary vs the authoritative rollup (§29) ------------------------------------------
  const s = report.summary;
  if (s.estimateId !== version.estimateId || s.versionId !== version.versionId) {
    add('summary', 'summary identity must match the version');
  }
  if (s.versionNumber !== version.versionNumber) {
    add('summary.versionNumber', `must be ${String(version.versionNumber)}`);
  }
  if (s.edition !== version.edition) {
    add('summary.edition', `must be "${version.edition}"`);
  }
  if (s.status !== rollup.status) {
    add('summary.status', `must be "${rollup.status}" (the authoritative rollup status)`);
  }
  if (!equalOrNull(s.amount, rollup.amount)) {
    add(
      'summary.amount',
      `must be ${rollup.amount === null ? 'null (the rollup is pending; pending is never zero)' : `"${rollup.amount}"`} (the authoritative rollup total)`,
    );
  }
  checkCounts(errors, 'summary', s, rollup);
  const summaryDependencyIds = s.dependencies.map((d) => d.id);
  if (!sameStringSet(summaryDependencyIds, rollup.dependencies)) {
    add('summary.dependencies', 'must list exactly the rollup dependencies');
  }
  for (const dependency of s.dependencies) {
    if (dependency.id.length === 0 || dependency.lineIds.length === 0) {
      add(
        `summary.dependencies.${dependency.id}`,
        'a dependency summary entry needs an id and at least one attributing lineId',
      );
    }
  }

  // ---- chapters and groups vs the rollup (§§10, 11, 30) -----------------------------------
  if (report.chapters.length !== rollup.chapterSubtotals.length) {
    add(
      'chapters',
      `there are ${String(report.chapters.length)} chapter sections but the rollup has ${String(rollup.chapterSubtotals.length)}`,
    );
  }
  const versionLineIds = new Set(version.lines.map((line) => line.lineId));
  const seenReportLineIds = new Set<string>();
  const reportLinesInOrder: string[] = [];

  for (let c = 0; c < report.chapters.length; c += 1) {
    const chapter: ReportChapter | undefined = report.chapters[c];
    if (chapter === undefined) continue;
    const expected =
      rollup.chapterSubtotals[c] ??
      rollup.chapterSubtotals.find((cs) => cs.chapter === chapter.chapter);
    if (expected === undefined) {
      add(`chapters[${String(c)}]`, `chapter "${chapter.chapter}" does not exist in the rollup`);
      continue;
    }
    if (chapter.chapter !== expected.chapter) {
      add(
        `chapters[${String(c)}].chapter`,
        `must be "${expected.chapter}" (BOQ first-appearance order; never re-sorted)`,
      );
    }
    if (chapter.status !== expected.status) {
      add(`chapters[${String(c)}].status`, `must be "${expected.status}"`);
    }
    if (!equalOrNull(chapter.amount, expected.amount)) {
      add(
        `chapters[${String(c)}].amount`,
        `must be ${expected.amount === null ? 'null' : `"${expected.amount}"`} (the authoritative chapter subtotal)`,
      );
    }
    checkCounts(errors, `chapters[${String(c)}]`, chapter, expected);
    if (!sameStringSet(chapter.dependencies, expected.dependencies)) {
      add(`chapters[${String(c)}].dependencies`, 'must list exactly the rollup dependencies');
    }
    if (chapter.groups.length !== expected.groupSubtotals.length) {
      add(
        `chapters[${String(c)}].groups`,
        `there are ${String(chapter.groups.length)} group sections but the rollup has ${String(expected.groupSubtotals.length)}`,
      );
    }

    for (let g = 0; g < chapter.groups.length; g += 1) {
      const group = chapter.groups[g];
      if (group === undefined) continue;
      const expectedGroup =
        expected.groupSubtotals[g] ??
        expected.groupSubtotals.find((gs) => gs.group === group.group);
      if (expectedGroup === undefined) {
        add(
          `chapters[${String(c)}].groups[${String(g)}]`,
          `group "${group.group}" does not exist in the rollup`,
        );
        continue;
      }
      const field = `chapters[${String(c)}].groups[${String(g)}]`;
      if (group.chapter !== chapter.chapter) {
        add(`${field}.chapter`, `must equal the parent chapter "${chapter.chapter}"`);
      }
      if (group.group !== expectedGroup.group) {
        add(`${field}.group`, `must be "${expectedGroup.group}"`);
      }
      if (group.status !== expectedGroup.status) {
        add(`${field}.status`, `must be "${expectedGroup.status}"`);
      }
      if (!equalOrNull(group.amount, expectedGroup.amount)) {
        add(
          `${field}.amount`,
          `must be ${expectedGroup.amount === null ? 'null' : `"${expectedGroup.amount}"`} (the authoritative group subtotal)`,
        );
      }
      checkCounts(errors, field, group, expectedGroup);
      if (!sameStringSet(group.dependencies, expectedGroup.dependencies)) {
        add(`${field}.dependencies`, 'must list exactly the rollup dependencies');
      }
      if (group.lines.length !== group.lineCount) {
        add(
          `${field}.lines`,
          `carries ${String(group.lines.length)} lines but lineCount says ${String(group.lineCount)}`,
        );
      }

      for (const line of group.lines) {
        // hierarchy (§30): the line belongs to exactly this chapter+group section
        if (line.chapter !== group.chapter || line.group !== group.group) {
          add(
            `line ${line.lineId}`,
            `belongs to chapter "${line.chapter}" group "${line.group}" but sits in section "${group.chapter}"|"${group.group}"; lines are never moved to fix data`,
          );
        }
        if (line.edition !== version.edition) {
          add(
            `line ${line.lineId}.edition`,
            `must be "${version.edition}" (editions are never mixed)`,
          );
        }
        if (!versionLineIds.has(line.lineId)) {
          add(`line ${line.lineId}`, 'does not exist in the source version');
        }
        if (seenReportLineIds.has(line.lineId)) {
          add(`line ${line.lineId}`, 'appears more than once in the report');
        }
        seenReportLineIds.add(line.lineId);
        reportLinesInOrder.push(line.lineId);

        // per-line structural validation reused from the BOQ layer (§28):
        // COMPLETE⇔amount, pending⇔null, unit, exact decimals, trace, sourceRef.
        for (const error of validateBoqLine(line)) {
          add(`line ${error.lineId} ${error.field}`, error.message);
        }
      }
    }
  }

  // ---- line coverage (§31): the full report represents every version line ------------------
  if (reportLinesInOrder.length !== version.lines.length) {
    add(
      'chapters.lines',
      `the report carries ${String(reportLinesInOrder.length)} lines but the version has ${String(version.lines.length)} (no filtering in the full report)`,
    );
  }
  for (const line of version.lines) {
    if (!seenReportLineIds.has(line.lineId)) {
      add(`line ${line.lineId}`, 'is missing from the report');
    }
  }

  // ---- scope boundaries preserved verbatim (§§33, 34) ---------------------------------------
  // (the BlockedRollup type itself pins status to NOT_SPECIFIED; the message is the
  // substantive check — the BOQ layer's boundary statement must survive verbatim)
  const multiBuilding = combinedMultiBuildingRollup();
  if (report.scopeBoundaries.multiBuildingCombination.message !== multiBuilding.message) {
    add(
      'scopeBoundaries.multiBuildingCombination',
      'must carry the BOQ layer NOT_SPECIFIED statement verbatim',
    );
  }
  const multiDiscipline = combinedMultiDisciplineRollup();
  if (report.scopeBoundaries.multiDisciplineCombination.message !== multiDiscipline.message) {
    add(
      'scopeBoundaries.multiDisciplineCombination',
      'must carry the BOQ layer NOT_SPECIFIED statement verbatim',
    );
  }

  return errors;
}
