/**
 * The pure ReportModel → PDF-document-model mapping (stage 2a), plus the renderer's
 * structural validation of a report.
 *
 * No business logic: no price lookup, no recalculation, no aggregation, no status
 * upgrading, no repair. Values are copied verbatim; `null`/absent values become `null`
 * model cells (rendered as pending placeholders — never 0).
 *
 * The validation mirrors the Excel renderer's contract (the reporting-excel package is
 * intentionally NOT imported — the renderers are siblings, not a stack): status⇔amount
 * coherence, identity mirrors, hierarchy, coverage, dependency attribution and the S4
 * result's internal shape, all WITHOUT source objects and without summing one amount.
 * Structural per-line checks reuse the BOQ layer's own validator.
 */
import { validateBoqLine } from '@costgenius/boq';
import type { ReportChapter, ReportGroup, ReportLine, ReportModel } from '@costgenius/reporting';
import { ReportingPdfError } from './errors.js';
import type { KeyValueRow, PdfDocumentModel, PdfSection, TableColumn } from './types.js';

/** Deterministic delimiter for multi-value cells (dependency ids, pending reasons). */
export const CELL_DELIMITER = '; ';

const CALCULATION_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETE',
  'INCOMPLETE',
  'EXTERNAL_DEPENDENCY',
  'NOT_SPECIFIED',
]);
const VERSION_STATUSES: ReadonlySet<string> = new Set(['draft', 'finalized']);
/** Exact decimal literal — the same contract shape as the pricebook's pattern. */
const EXACT_DECIMAL = /^-?\d+(\.\d+)?$/;

// ---- structural validation (fail loudly; never repair) ----------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function checkStatusAmount(
  errors: string[],
  field: string,
  status: unknown,
  amount: unknown,
): void {
  if (!isNonEmptyString(status) || !CALCULATION_STATUSES.has(status)) {
    errors.push(`${field}.status: "${String(status)}" is not a calculation status`);
    return;
  }
  if (status === 'COMPLETE') {
    if (!isNonEmptyString(amount)) {
      errors.push(`${field}.amount: a COMPLETE ${field} must carry an amount (never null → 0)`);
    } else if (!EXACT_DECIMAL.test(amount)) {
      errors.push(`${field}.amount: "${amount}" is not an exact decimal string`);
    }
  } else if (amount !== null) {
    errors.push(
      `${field}.amount: a pending (${status}) ${field} must keep amount null (never 0, never a total)`,
    );
  }
}

function checkCounts(
  errors: string[],
  field: string,
  record: { lineCount: unknown; pricedLineCount: unknown; pendingLineCount: unknown },
): void {
  for (const key of ['lineCount', 'pricedLineCount', 'pendingLineCount'] as const) {
    if (!isNonNegativeInteger(record[key])) {
      errors.push(`${field}.${key}: must be a non-negative integer`);
    }
  }
  if (
    isNonNegativeInteger(record.lineCount) &&
    isNonNegativeInteger(record.pricedLineCount) &&
    isNonNegativeInteger(record.pendingLineCount) &&
    record.pricedLineCount + record.pendingLineCount !== record.lineCount
  ) {
    errors.push(`${field}: priced + pending must equal lineCount`);
  }
}

/**
 * Validates the report's internal structure (no external sources are available to a
 * renderer). Returns every violation; empty array = renderable. Never mutates or repairs.
 */
export function reportStructureErrors(report: ReportModel): string[] {
  const errors: string[] = [];
  const add = (message: string): void => {
    errors.push(message);
  };

  if (!isObject(report)) return ['report: must be an object'];
  if (!isNonEmptyString(report['reportId'])) {
    errors.push('reportId: must be a non-empty string');
  }
  const metadata = report['metadata'];
  const summary = report['summary'];
  const chapters = report['chapters'];
  const scope = report['scopeBoundaries'];
  const provenance = report['generatedFrom'];
  if (
    !isObject(metadata) ||
    !isObject(summary) ||
    !Array.isArray(chapters) ||
    !isObject(scope) ||
    !isObject(provenance)
  ) {
    if (!isObject(metadata)) add('metadata: must be an object');
    if (!isObject(summary)) add('summary: must be an object');
    if (!Array.isArray(chapters)) add('chapters: must be an array');
    if (!isObject(scope)) add('scopeBoundaries: must be an object');
    if (!isObject(provenance)) add('generatedFrom: must be an object');
    return errors;
  }

  // ---- identity mirrors -------------------------------------------------------------------
  for (const field of [
    'reportId',
    'estimateId',
    'versionId',
    'projectId',
    'title',
    'edition',
    'createdAt',
  ] as const) {
    if (!isNonEmptyString(metadata[field])) add(`metadata.${field}: must be a non-empty string`);
  }
  if (
    !isNonEmptyString(metadata['versionStatus']) ||
    !VERSION_STATUSES.has(metadata['versionStatus'])
  ) {
    add('metadata.versionStatus: must be "draft" or "finalized"');
  }
  if (metadata['generatedAt'] !== null && !isNonEmptyString(metadata['generatedAt'])) {
    add('metadata.generatedAt: must be a non-empty string or null');
  }
  if (metadata['buildingId'] !== null && !isNonEmptyString(metadata['buildingId'])) {
    add('metadata.buildingId: must be a non-empty string or null');
  }
  if (!isNonNegativeInteger(metadata['versionNumber']) || metadata['versionNumber'] < 1) {
    add('metadata.versionNumber: must be a positive integer');
  }
  if (isNonEmptyString(report['reportId']) && metadata['reportId'] !== report['reportId']) {
    add('metadata.reportId: must equal the report reportId');
  }
  if (summary['estimateId'] !== metadata['estimateId']) {
    add('summary.estimateId: must mirror metadata.estimateId');
  }
  if (summary['versionId'] !== metadata['versionId']) {
    add('summary.versionId: must mirror metadata.versionId');
  }
  if (summary['versionNumber'] !== metadata['versionNumber']) {
    add('summary.versionNumber: must mirror metadata.versionNumber');
  }
  if (summary['edition'] !== metadata['edition']) {
    add('summary.edition: must mirror metadata.edition');
  }

  // ---- summary -----------------------------------------------------------------------------
  checkStatusAmount(errors, 'summary', summary['status'], summary['amount']);
  checkCounts(errors, 'summary', summary);
  if (!Array.isArray(summary['dependencies'])) add('summary.dependencies: must be an array');

  // ---- chapters / groups / lines -------------------------------------------------------------
  const seenLineIds = new Set<string>();
  const lineDependencies = new Map<string, Set<string>>();
  const allLineDependencyIds = new Set<string>();
  let totalLines = 0;
  for (const [c, chapterUnknown] of chapters.entries()) {
    if (!isObject(chapterUnknown)) {
      add(`chapters[${String(c)}]: must be an object`);
      continue;
    }
    const chapter = chapterUnknown as unknown as ReportChapter;
    const cField = `chapters[${String(c)}]`;
    if (!isNonEmptyString(chapter.chapter)) add(`${cField}.chapter: must be a non-empty string`);
    checkStatusAmount(errors, cField, chapter.status, chapter.amount);
    checkCounts(errors, cField, chapter);
    if (!Array.isArray(chapter.groups)) {
      add(`${cField}.groups: must be an array`);
      continue;
    }
    let chapterLines = 0;
    for (const [g, groupUnknown] of chapter.groups.entries()) {
      if (!isObject(groupUnknown)) {
        add(`${cField}.groups[${String(g)}]: must be an object`);
        continue;
      }
      const group = groupUnknown as unknown as ReportGroup;
      const gField = `${cField}.groups[${String(g)}]`;
      if (!isNonEmptyString(group.group)) add(`${gField}.group: must be a non-empty string`);
      if (group.chapter !== chapter.chapter) {
        add(`${gField}.chapter: must equal the parent chapter "${chapter.chapter}"`);
      }
      checkStatusAmount(errors, gField, group.status, group.amount);
      checkCounts(errors, gField, group);
      const groupLines: readonly unknown[] = group.lines;
      if (!Array.isArray(groupLines)) {
        add(`${gField}.lines: must be an array`);
        continue;
      }
      if (groupLines.length !== group.lineCount) {
        add(
          `${gField}.lines: carries ${String(groupLines.length)} lines but lineCount says ${String(group.lineCount)}`,
        );
      }
      chapterLines += groupLines.length;
      for (const lineUnknown of groupLines) {
        if (!isObject(lineUnknown)) {
          add(`${gField}.lines: every line must be an object`);
          continue;
        }
        const line = lineUnknown as unknown as ReportLine;
        const lField = `line ${line.lineId}`;
        if (isNonEmptyString(line['lineId'])) {
          if (seenLineIds.has(line['lineId'])) {
            add(`${lField}: appears more than once in the report`);
          }
          seenLineIds.add(line['lineId']);
        }
        for (const error of validateBoqLine(line)) {
          add(`${lField} ${error.field}: ${error.message}`);
        }
        if (line['chapter'] !== group.chapter || line['group'] !== group.group) {
          add(
            `${lField}: belongs to "${line['chapter']}"|"${line['group']}" but sits in "${group.chapter}"|"${group.group}" (lines are never moved)`,
          );
        }
        if (line['edition'] !== metadata['edition']) {
          add(`${lField}.edition: must be "${metadata['edition']}" (editions never mix)`);
        }
        if (isNonEmptyString(line['lineId']) && Array.isArray(line['externalDependencies'])) {
          const ids = new Set<string>();
          for (const dep of line['externalDependencies']) {
            if (isNonEmptyString(dep)) {
              ids.add(dep);
              allLineDependencyIds.add(dep);
            }
          }
          lineDependencies.set(line['lineId'], ids);
        }
      }
    }
    if (isNonNegativeInteger(chapter.lineCount) && chapterLines !== chapter.lineCount) {
      add(
        `${cField}: the group lines sum to ${String(chapterLines)} but lineCount says ${String(chapter.lineCount)}`,
      );
    }
    totalLines += chapterLines;
  }
  if (isNonNegativeInteger(summary['lineCount']) && totalLines !== summary['lineCount']) {
    add(
      `summary.lineCount: the chapters carry ${String(totalLines)} lines but summary.lineCount says ${String(summary['lineCount'])}`,
    );
  }

  // ---- dependency attribution ------------------------------------------------------------------
  const summaryDependencyIds = new Set<string>();
  if (Array.isArray(summary['dependencies'])) {
    for (const [d, dependencyUnknown] of summary['dependencies'].entries()) {
      if (!isObject(dependencyUnknown)) {
        add(`summary.dependencies[${String(d)}]: must be an object`);
        continue;
      }
      const dependency = dependencyUnknown;
      if (!isNonEmptyString(dependency['id'])) {
        add(`summary.dependencies[${String(d)}].id: must be a non-empty string`);
      } else if (summaryDependencyIds.has(dependency['id'])) {
        add(`summary.dependencies[${String(d)}].id: "${dependency['id']}" listed more than once`);
      } else {
        summaryDependencyIds.add(dependency['id']);
      }
      if (!Array.isArray(dependency['lineIds']) || dependency['lineIds'].length === 0) {
        add(
          `summary.dependencies[${String(d)}].lineIds: must be a non-empty array (per-line attribution preserved)`,
        );
        continue;
      }
      if (isNonEmptyString(dependency['id'])) {
        for (const lineIdUnknown of dependency['lineIds']) {
          if (!isNonEmptyString(lineIdUnknown) || !seenLineIds.has(lineIdUnknown)) {
            add(
              `summary.dependencies[${String(d)}].lineIds: "${String(lineIdUnknown)}" is not a line of this report`,
            );
            break;
          }
          const carried = lineDependencies.get(lineIdUnknown);
          if (carried === undefined || !carried.has(dependency['id'])) {
            add(
              `summary.dependencies[${String(d)}]: line "${lineIdUnknown}" does not carry dependency "${dependency['id']}"`,
            );
            break;
          }
        }
      }
    }
  }
  for (const id of allLineDependencyIds) {
    if (!summaryDependencyIds.has(id)) {
      add(`summary.dependencies: the lines carry dependency "${id}" but the summary omits it`);
    }
  }

  // ---- scope boundaries (verbatim NOT_SPECIFIED statements) --------------------------------------
  for (const key of ['multiBuildingCombination', 'multiDisciplineCombination'] as const) {
    const boundary: unknown = scope[key];
    if (!isObject(boundary) || boundary['status'] !== 'NOT_SPECIFIED') {
      add(`scopeBoundaries.${key}.status: must be "NOT_SPECIFIED" (never combined or estimated)`);
    }
    if (!isObject(boundary) || !isNonEmptyString(boundary['message'])) {
      add(`scopeBoundaries.${key}.message: must carry the BOQ layer statement verbatim`);
    }
  }

  // ---- provenance mirrors + S4 shape ---------------------------------------------------------------
  const estimate = provenance['estimate'];
  const version = provenance['version'];
  if (!isObject(estimate) || estimate['estimateId'] !== metadata['estimateId']) {
    add('generatedFrom.estimate.estimateId: must mirror metadata.estimateId');
  }
  if (!isObject(version) || version['versionId'] !== metadata['versionId']) {
    add('generatedFrom.version.versionId: must mirror metadata.versionId');
  }
  const s4 = provenance['s4Estimate'];
  if (s4 !== null) {
    if (!isObject(s4)) {
      add('generatedFrom.s4Estimate: must be an object or null');
    } else {
      if (s4['estimateId'] !== metadata['estimateId']) {
        add(
          `generatedFrom.s4Estimate.estimateId: "${s4['estimateId']}" does not match metadata.estimateId "${metadata['estimateId']}"`,
        );
      }
      if (isNonEmptyString(metadata['buildingId']) && s4['buildingId'] !== metadata['buildingId']) {
        add(
          `generatedFrom.s4Estimate.buildingId: "${s4['buildingId']}" does not match metadata.buildingId "${metadata['buildingId'] ?? 'null'}"`,
        );
      }
      if (!Array.isArray(s4['stages'])) {
        add(
          'generatedFrom.s4Estimate.stages: must be an array (preserved verbatim, never recomputed)',
        );
      } else {
        for (const [s, stageUnknown] of s4['stages'].entries()) {
          if (!isObject(stageUnknown)) {
            add(`generatedFrom.s4Estimate.stages[${String(s)}]: must be an object`);
            continue;
          }
          const stage = stageUnknown;
          const sField = `generatedFrom.s4Estimate.stages[${String(s)}]`;
          if (!isNonEmptyString(stage['stage'])) add(`${sField}.stage: must be a non-empty string`);
          const rule = stage['rule'];
          if (!isObject(rule) || !isNonEmptyString(rule['id'])) {
            add(`${sField}.rule.id: must be a non-empty string`);
          }
          if (!isObject(rule) || !isNonEmptyString(rule['sourceReference'])) {
            add(`${sField}.rule.sourceReference: must be a non-empty string`);
          }
          for (const key of ['input', 'coefficient', 'output'] as const) {
            const value = stage[key];
            if (value !== null && !isNonEmptyString(value)) {
              add(`${sField}.${key}: must be a non-empty string or null`);
            }
          }
          if (!isNonEmptyString(stage['status']) || !CALCULATION_STATUSES.has(stage['status'])) {
            add(`${sField}.status: must be a calculation status`);
          }
        }
      }
      if (
        !isNonEmptyString(s4['calculationStatus']) ||
        !CALCULATION_STATUSES.has(s4['calculationStatus'])
      ) {
        add('generatedFrom.s4Estimate.calculationStatus: must be a calculation status');
      }
      if (s4['finalEstimate'] !== null && !isNonEmptyString(s4['finalEstimate'])) {
        add('generatedFrom.s4Estimate.finalEstimate: must be a non-empty string or null');
      }
    }
  }

  return errors;
}

// ---- document model construction ---------------------------------------------------------------

const col = (header: string, width: number): TableColumn => ({ header, width });

const CHAPTER_COLUMNS: readonly TableColumn[] = [
  col('Chapter', 120),
  col('Status', 100),
  col('Line Count', 55),
  col('Priced Line Count', 62),
  col('Pending Line Count', 65),
  col('Amount', 70),
];

const GROUP_COLUMNS: readonly TableColumn[] = [
  col('Chapter', 105),
  col('Group', 60),
  col('Status', 90),
  col('Line Count', 45),
  col('Priced Line Count', 55),
  col('Pending Line Count', 58),
  col('Amount', 70),
];

/** Landscape Lines table: primary estimate columns (portrait width is not enough). */
const LINES_COLUMNS: readonly TableColumn[] = [
  col('Line ID', 55),
  col('Code', 55),
  col('Description', 225),
  col('Unit', 55),
  col('Quantity', 50),
  col('Base Price', 60),
  col('Line Amount', 65),
  col('Pricebook Status', 90),
  col('Calculation Status', 66),
];

/** Landscape provenance/trace table for the same lines, keyed by Line ID. */
const PROVENANCE_COLUMNS: readonly TableColumn[] = [
  col('Line ID', 50),
  col('Chapter', 55),
  col('Group', 35),
  col('Unit Code', 35),
  col('Source Document', 120),
  col('Source Edition', 35),
  col('Printed Page', 40),
  col('Source Section', 65),
  col('Source Hash', 50),
  col('Dependency IDs', 95),
  col('Trace Quantity', 40),
  col('Trace Unit Price', 45),
  col('Trace Operation', 45),
  col('Trace Line Amount', 50),
  col('Building ID', 40),
  col('Landscaping', 35),
];

const S4_STAGE_COLUMNS: readonly TableColumn[] = [
  col('Stage', 65),
  col('Rule ID', 90),
  col('Rule Source Reference', 88),
  col('Input', 50),
  col('Coefficient', 40),
  col('Output', 50),
  col('Status', 55),
  col('Note', 77),
];

/** Joined ids, or null when there are none (an empty cell, never ''). */
function joinedOr(ids: readonly string[]): string | null {
  return ids.length === 0 ? null : ids.join(CELL_DELIMITER);
}

function summaryRows(report: ReportModel): KeyValueRow[] {
  const m = report.metadata;
  const s = report.summary;
  return [
    { field: 'Report ID', value: m.reportId },
    { field: 'Estimate ID', value: m.estimateId },
    { field: 'Version ID', value: m.versionId },
    { field: 'Version Number', value: String(m.versionNumber) },
    { field: 'Project ID', value: m.projectId },
    { field: 'Title', value: m.title },
    { field: 'Edition', value: m.edition },
    { field: 'Version Status', value: m.versionStatus },
    { field: 'Report Status', value: s.status },
    { field: 'Line Count', value: String(s.lineCount) },
    { field: 'Priced Line Count', value: String(s.pricedLineCount) },
    { field: 'Pending Line Count', value: String(s.pendingLineCount) },
    { field: 'Total Amount', value: s.amount },
    { field: 'Dependency Count', value: String(s.dependencies.length) },
    { field: 'Dependency IDs', value: joinedOr(s.dependencies.map((d) => d.id)) },
    { field: 'Created At', value: m.createdAt },
    { field: 'Generated At', value: m.generatedAt },
    { field: 'Building ID', value: m.buildingId },
  ];
}

/**
 * Builds the PDF document model from a report: validates structure first and fails loudly
 * (INVALID_REPORT_MODEL). Section order is fixed: Summary (portrait) → Chapters (portrait)
 * → Groups (portrait) → Lines + provenance (landscape) → S4 Trace (portrait, only when the
 * report carries an S4 result).
 */
export function buildPdfDocumentModel(report: ReportModel): PdfDocumentModel {
  const errors = reportStructureErrors(report);
  if (errors.length > 0) {
    throw new ReportingPdfError(
      'INVALID_REPORT_MODEL',
      'the ReportModel failed the renderer structural validation; nothing is repaired',
      errors,
    );
  }

  const summarySection: PdfSection = {
    orientation: 'portrait',
    blocks: [
      { kind: 'heading', level: 1, text: `${report.metadata.title} — ${report.metadata.reportId}` },
      { kind: 'heading', level: 2, text: 'Summary' },
      { kind: 'key-value', rows: summaryRows(report) },
      { kind: 'heading', level: 2, text: 'Scope Boundaries' },
      {
        kind: 'key-value',
        rows: [
          {
            field: 'Multi-Building Combination',
            value: report.scopeBoundaries.multiBuildingCombination.status,
          },
          {
            field: 'Multi-Building Combination — Note',
            value: report.scopeBoundaries.multiBuildingCombination.message,
          },
          {
            field: 'Multi-Discipline Combination',
            value: report.scopeBoundaries.multiDisciplineCombination.status,
          },
          {
            field: 'Multi-Discipline Combination — Note',
            value: report.scopeBoundaries.multiDisciplineCombination.message,
          },
        ],
      },
    ],
  };

  const chaptersSection: PdfSection = {
    orientation: 'portrait',
    blocks: [
      { kind: 'heading', level: 2, text: 'Chapters' },
      {
        kind: 'table',
        title: 'Chapters',
        table: {
          columns: CHAPTER_COLUMNS,
          rows: report.chapters.map((chapter) => [
            chapter.chapter,
            chapter.status,
            String(chapter.lineCount),
            String(chapter.pricedLineCount),
            String(chapter.pendingLineCount),
            chapter.amount,
          ]),
        },
      },
    ],
  };

  const groupsSection: PdfSection = {
    orientation: 'portrait',
    blocks: [
      { kind: 'heading', level: 2, text: 'Groups' },
      {
        kind: 'table',
        title: 'Groups',
        table: {
          columns: GROUP_COLUMNS,
          rows: report.chapters.flatMap((chapter) =>
            chapter.groups.map((group) => [
              group.chapter,
              group.group,
              group.status,
              String(group.lineCount),
              String(group.pricedLineCount),
              String(group.pendingLineCount),
              group.amount,
            ]),
          ),
        },
      },
    ],
  };

  const linesSection: PdfSection = {
    orientation: 'landscape',
    blocks: [
      { kind: 'heading', level: 2, text: 'Lines' },
      {
        kind: 'table',
        title: 'Lines',
        table: {
          columns: LINES_COLUMNS,
          rows: report.chapters.flatMap((chapter) =>
            chapter.groups.flatMap((group) =>
              group.lines.map((line) => [
                line.lineId,
                line.pricebookCode,
                line.description,
                line.unit.label,
                line.quantity,
                line.basePrice,
                line.lineAmount,
                line.pricebookStatus,
                line.calculationStatus,
              ]),
            ),
          ),
        },
      },
      { kind: 'heading', level: 2, text: 'Line Provenance and Trace' },
      {
        kind: 'table',
        title: 'Line Provenance and Trace',
        table: {
          columns: PROVENANCE_COLUMNS,
          rows: report.chapters.flatMap((chapter) =>
            chapter.groups.flatMap((group) =>
              group.lines.map((line) => [
                line.lineId,
                line.chapter,
                line.group,
                line.unit.code,
                line.sourceRef.sourceDocument,
                line.sourceRef.edition,
                line.sourceRef.printedPage,
                line.sourceRef.section,
                line.sourceRef.sourceFileHash,
                joinedOr(line.externalDependencies),
                line.trace.quantity,
                line.trace.unitPrice,
                line.trace.operation,
                line.trace.lineAmount,
                line.buildingId ?? null,
                line.landscaping === undefined ? null : line.landscaping ? 'true' : 'false',
              ]),
            ),
          ),
        },
      },
    ],
  };

  const s4 = report.generatedFrom.s4Estimate;
  const sections: PdfSection[] = [summarySection, chaptersSection, groupsSection, linesSection];
  if (s4 !== null) {
    sections.push({
      orientation: 'portrait',
      blocks: [
        { kind: 'heading', level: 2, text: 'S4 Calculation Trace' },
        {
          kind: 'key-value',
          rows: [
            { field: 'S4 Estimate ID', value: s4.estimateId },
            { field: 'Building ID', value: s4.buildingId },
            { field: 'Calculation Status', value: s4.calculationStatus },
            { field: 'Final Estimate', value: s4.finalEstimate },
            { field: 'External Dependencies', value: joinedOr(s4.pending.externalDependencies) },
            { field: 'Incomplete', value: joinedOr(s4.pending.incomplete) },
            { field: 'Not Specified', value: joinedOr(s4.pending.notSpecified) },
          ],
        },
        {
          kind: 'table',
          title: 'S4 Stages',
          table: {
            columns: S4_STAGE_COLUMNS,
            rows: s4.stages.map((stage) => [
              stage.stage,
              stage.rule.id,
              stage.rule.sourceReference,
              stage.input,
              stage.coefficient,
              stage.output,
              stage.status,
              stage.note ?? null,
            ]),
          },
        },
      ],
    });
  }

  return { title: `${report.metadata.title} — ${report.metadata.reportId}`, sections };
}
