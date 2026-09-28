/**
 * The pure ReportModel → workbook-model mapping (stage 2a of the reporting design).
 *
 * This module contains NO business logic: no price lookup, no recalculation, no
 * aggregation of amounts, no status upgrading, no repair. It copies the report's own
 * values into rendering-library-independent sheet descriptions:
 *
 * - business decimal strings (codes with leading zeros, quantities, prices, amounts,
 *   coefficients) become `text` cells — never numbers;
 * - integers that are already numbers in the contract (counts, version number) become
 *   `integer` cells;
 * - `null`/absent values become `empty` cells — never 0, never ''.
 *
 * Before mapping, the report is structurally validated (fail loudly). The validation
 * reuses the BOQ layer's own per-line validator and checks internal coherence (identity
 * mirrors, hierarchy, coverage, status⇔amount rules, dependency attribution) WITHOUT any
 * source objects and WITHOUT summing a single amount.
 */
import { validateBoqLine } from '@costgenius/boq';
import type { ReportChapter, ReportGroup, ReportLine, ReportModel } from '@costgenius/reporting';
import { ReportingExcelError } from './errors.js';
import type {
  WorkbookCell,
  WorkbookColumn,
  WorkbookEntry,
  WorkbookModel,
  WorkbookSheetModel,
  WorkbookTableModel,
} from './types.js';

/** Deterministic delimiter for multi-value cells (dependency ids, pending reasons). */
export const CELL_DELIMITER = '; ';

const CALCULATION_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETE',
  'INCOMPLETE',
  'EXTERNAL_DEPENDENCY',
  'NOT_SPECIFIED',
]);

const VERSION_STATUSES: ReadonlySet<string> = new Set(['draft', 'finalized']);

/**
 * Exact decimal literal — the same contract shape as the pricebook's pattern (local copy:
 * this package deliberately does not depend on the pricebook layer).
 */
const EXACT_DECIMAL = /^-?\d+(\.\d+)?$/;

const text = (value: string): WorkbookCell => ({ kind: 'text', value });
const int = (value: number): WorkbookCell => ({ kind: 'integer', value });
const EMPTY: WorkbookCell = { kind: 'empty' };

const textOrNull = (value: string | null): WorkbookCell => (value === null ? EMPTY : text(value));

const optionalText = (value: string | undefined): WorkbookCell =>
  value === undefined ? EMPTY : text(value);

/** Joins ids with the deterministic delimiter; no ids → an empty cell (not ''). */
const joined = (ids: readonly string[]): WorkbookCell =>
  ids.length === 0 ? EMPTY : text(ids.join(CELL_DELIMITER));

// ---- structural validation (fail loudly; never repair) ------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Status⇔amount coherence at every level: COMPLETE ⇔ a non-null exact-decimal amount;
 * pending ⇔ null. (Mirrors the BOQ contract; the renderer never repairs a violation.)
 */
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
    isNonNegativeInteger(record['lineCount']) &&
    isNonNegativeInteger(record['pricedLineCount']) &&
    isNonNegativeInteger(record['pendingLineCount']) &&
    record['pricedLineCount'] + record['pendingLineCount'] !== record['lineCount']
  ) {
    errors.push(`${field}: priced + pending must equal lineCount`);
  }
}

/**
 * Validates the report's internal structure (no external sources available to a renderer).
 * Returns every violation; empty array = renderable. Never mutates, never repairs.
 */
export function reportStructureErrors(report: ReportModel): string[] {
  const errors: string[] = [];
  const add = (message: string): void => {
    errors.push(message);
  };

  if (!isObject(report)) {
    return ['report: must be an object'];
  }
  if (!isNonEmptyString(report['reportId'])) {
    add('reportId: must be a non-empty string');
  }
  const metadata = report['metadata'];
  const summary = report['summary'];
  const chapters = report['chapters'];
  const scope = report['scopeBoundaries'];
  const provenance = report['generatedFrom'];
  if (!isObject(metadata)) add('metadata: must be an object');
  if (!isObject(summary)) add('summary: must be an object');
  if (!Array.isArray(chapters)) add('chapters: must be an array');
  if (!isObject(scope)) add('scopeBoundaries: must be an object');
  if (!isObject(provenance)) add('generatedFrom: must be an object');
  if (
    !isObject(metadata) ||
    !isObject(summary) ||
    !Array.isArray(chapters) ||
    !isObject(scope) ||
    !isObject(provenance)
  ) {
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
    if (!isNonEmptyString(metadata[field])) {
      add(`metadata.${field}: must be a non-empty string`);
    }
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
  if (!Array.isArray(summary['dependencies'])) {
    add('summary.dependencies: must be an array');
  }

  // ---- chapters and groups ------------------------------------------------------------------
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
        // per-line structural validation reused from the BOQ layer (its own contract)
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

  // ---- coverage: the full report represents every line exactly once -------------------------
  if (isNonNegativeInteger(summary['lineCount']) && totalLines !== summary['lineCount']) {
    add(
      `summary.lineCount: the chapters carry ${String(totalLines)} lines but summary.lineCount says ${String(summary['lineCount'])}`,
    );
  }

  // ---- dependency attribution -----------------------------------------------------------------
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
  // every dependency a line actually carries must be summarized (no silent loss)
  for (const id of allLineDependencyIds) {
    if (!summaryDependencyIds.has(id)) {
      add(`summary.dependencies: the lines carry dependency "${id}" but the summary omits it`);
    }
  }

  // ---- scope boundaries (verbatim NOT_SPECIFIED statements) -----------------------------------
  for (const [key, label] of [
    ['multiBuildingCombination', 'multiBuildingCombination'],
    ['multiDisciplineCombination', 'multiDisciplineCombination'],
  ] as const) {
    const boundary: unknown = scope[key]; // runtime check of possibly-transported data
    if (!isObject(boundary) || boundary['status'] !== 'NOT_SPECIFIED') {
      add(`scopeBoundaries.${label}.status: must be "NOT_SPECIFIED" (never combined or estimated)`);
    }
    if (!isObject(boundary) || !isNonEmptyString(boundary['message'])) {
      add(`scopeBoundaries.${label}.message: must carry the BOQ layer statement verbatim`);
    }
  }

  // ---- provenance mirrors -----------------------------------------------------------------------
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
      if (
        metadata['buildingId'] !== null &&
        isNonEmptyString(metadata['buildingId']) &&
        s4['buildingId'] !== metadata['buildingId']
      ) {
        add(
          `generatedFrom.s4Estimate.buildingId: "${s4['buildingId']}" does not match metadata.buildingId "${metadata['buildingId']}"`,
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
            if (!isStringOrNull(stage[key])) {
              add(`${sField}.${key}: must be a string or null`);
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

// ---- sheet builders ---------------------------------------------------------------------------

const CHAPTER_COLUMNS: readonly WorkbookColumn[] = [
  { header: 'Chapter', width: 24, wrap: false },
  { header: 'Status', width: 22, wrap: false },
  { header: 'Line Count', width: 12, wrap: false },
  { header: 'Priced Line Count', width: 16, wrap: false },
  { header: 'Pending Line Count', width: 17, wrap: false },
  { header: 'Amount', width: 18, wrap: false },
  { header: 'Dependency IDs', width: 42, wrap: true },
];

const GROUP_COLUMNS: readonly WorkbookColumn[] = [
  { header: 'Chapter', width: 24, wrap: false },
  { header: 'Group', width: 18, wrap: false },
  { header: 'Status', width: 22, wrap: false },
  { header: 'Line Count', width: 12, wrap: false },
  { header: 'Priced Line Count', width: 16, wrap: false },
  { header: 'Pending Line Count', width: 17, wrap: false },
  { header: 'Amount', width: 18, wrap: false },
  { header: 'Dependency IDs', width: 42, wrap: true },
];

const LINE_COLUMNS: readonly WorkbookColumn[] = [
  { header: 'Chapter', width: 22, wrap: false },
  { header: 'Group', width: 16, wrap: false },
  { header: 'Line ID', width: 16, wrap: false },
  { header: 'Code', width: 14, wrap: false },
  { header: 'Description', width: 48, wrap: true },
  { header: 'Unit Label', width: 16, wrap: false },
  { header: 'Unit Code', width: 12, wrap: false },
  { header: 'Quantity', width: 12, wrap: false },
  { header: 'Base Price', width: 14, wrap: false },
  { header: 'Line Amount', width: 16, wrap: false },
  { header: 'Pricebook Status', width: 30, wrap: false },
  { header: 'Calculation Status', width: 22, wrap: false },
  { header: 'Source Document', width: 44, wrap: true },
  { header: 'Source Edition', width: 15, wrap: false },
  { header: 'Printed Page', width: 13, wrap: false },
  { header: 'Source Section', width: 26, wrap: false },
  { header: 'Source Hash', width: 16, wrap: false },
  { header: 'Dependency IDs', width: 42, wrap: true },
  { header: 'Trace Quantity', width: 14, wrap: false },
  { header: 'Trace Unit Price', width: 16, wrap: false },
  { header: 'Trace Operation', width: 16, wrap: false },
  { header: 'Trace Line Amount', width: 17, wrap: false },
  { header: 'Building ID', width: 14, wrap: false },
  { header: 'Landscaping', width: 13, wrap: false },
];

const S4_STAGE_COLUMNS: readonly WorkbookColumn[] = [
  { header: 'Stage', width: 26, wrap: false },
  { header: 'Rule ID', width: 26, wrap: false },
  { header: 'Rule Source Reference', width: 44, wrap: true },
  { header: 'Input', width: 18, wrap: false },
  { header: 'Coefficient', width: 14, wrap: false },
  { header: 'Output', width: 18, wrap: false },
  { header: 'Status', width: 22, wrap: false },
  { header: 'Note', width: 44, wrap: true },
];

function summarySheet(report: ReportModel): WorkbookSheetModel {
  const m = report.metadata;
  const s = report.summary;
  const entries: WorkbookEntry[] = [
    { field: 'Report ID', cell: text(m.reportId) },
    { field: 'Estimate ID', cell: text(m.estimateId) },
    { field: 'Version ID', cell: text(m.versionId) },
    { field: 'Version Number', cell: int(m.versionNumber) },
    { field: 'Project ID', cell: text(m.projectId) },
    { field: 'Title', cell: text(m.title) },
    { field: 'Edition', cell: text(m.edition) },
    { field: 'Version Status', cell: text(m.versionStatus) },
    { field: 'Report Status', cell: text(s.status) },
    { field: 'Line Count', cell: int(s.lineCount) },
    { field: 'Priced Line Count', cell: int(s.pricedLineCount) },
    { field: 'Pending Line Count', cell: int(s.pendingLineCount) },
    { field: 'Total Amount', cell: textOrNull(s.amount) },
    { field: 'Dependency Count', cell: int(s.dependencies.length) },
    { field: 'Dependency IDs', cell: joined(s.dependencies.map((d) => d.id)) },
    { field: 'Created At', cell: text(m.createdAt) },
    { field: 'Generated At', cell: textOrNull(m.generatedAt) },
    { field: 'Building ID', cell: textOrNull(m.buildingId) },
    {
      field: 'Multi-Building Combination',
      cell: text(report.scopeBoundaries.multiBuildingCombination.status),
    },
    {
      field: 'Multi-Building Combination — Note',
      cell: text(report.scopeBoundaries.multiBuildingCombination.message),
    },
    {
      field: 'Multi-Discipline Combination',
      cell: text(report.scopeBoundaries.multiDisciplineCombination.status),
    },
    {
      field: 'Multi-Discipline Combination — Note',
      cell: text(report.scopeBoundaries.multiDisciplineCombination.message),
    },
  ];
  return { name: 'Summary', entries };
}

function chaptersSheet(report: ReportModel): WorkbookSheetModel {
  const table: WorkbookTableModel = {
    columns: CHAPTER_COLUMNS,
    rows: report.chapters.map((chapter) => [
      text(chapter.chapter),
      text(chapter.status),
      int(chapter.lineCount),
      int(chapter.pricedLineCount),
      int(chapter.pendingLineCount),
      textOrNull(chapter.amount),
      joined(chapter.dependencies),
    ]),
  };
  return { name: 'Chapters', entries: [], table };
}

function groupsSheet(report: ReportModel): WorkbookSheetModel {
  const table: WorkbookTableModel = {
    columns: GROUP_COLUMNS,
    rows: report.chapters.flatMap((chapter) =>
      chapter.groups.map((group) => [
        text(group.chapter),
        text(group.group),
        text(group.status),
        int(group.lineCount),
        int(group.pricedLineCount),
        int(group.pendingLineCount),
        textOrNull(group.amount),
        joined(group.dependencies),
      ]),
    ),
  };
  return { name: 'Groups', entries: [], table };
}

/** One row per ReportLine, in report order — every provenance field preserved. */
function lineRow(line: ReportLine): WorkbookCell[] {
  return [
    text(line.chapter),
    text(line.group),
    text(line.lineId),
    text(line.pricebookCode),
    text(line.description),
    text(line.unit.label),
    text(line.unit.code),
    text(line.quantity),
    textOrNull(line.basePrice),
    textOrNull(line.lineAmount),
    text(line.pricebookStatus),
    text(line.calculationStatus),
    text(line.sourceRef.sourceDocument),
    text(line.sourceRef.edition),
    text(line.sourceRef.printedPage),
    text(line.sourceRef.section),
    textOrNull(line.sourceRef.sourceFileHash),
    joined(line.externalDependencies),
    text(line.trace.quantity),
    textOrNull(line.trace.unitPrice),
    text(line.trace.operation),
    textOrNull(line.trace.lineAmount),
    optionalText(line.buildingId),
    line.landscaping === undefined ? EMPTY : text(line.landscaping ? 'true' : 'false'),
  ];
}

function linesSheet(report: ReportModel): WorkbookSheetModel {
  const table: WorkbookTableModel = {
    columns: LINE_COLUMNS,
    rows: report.chapters.flatMap((chapter) =>
      chapter.groups.flatMap((group) => group.lines.map(lineRow)),
    ),
  };
  return { name: 'Lines', entries: [], table };
}

/**
 * The S4 Trace sheet — the estimate result preserved verbatim: its identity/status block
 * as key–value entries, then one row per stage (rule, input, coefficient, output, status).
 * Nothing is recomputed; the golden P = 1.0451 stays exactly the string the S4 result carries.
 */
function s4TraceSheet(report: ReportModel): WorkbookSheetModel {
  const s4 = report.generatedFrom.s4Estimate;
  if (s4 === null)
    throw new ReportingExcelError('INVALID_REPORT_MODEL', 's4 sheet built without an S4 result');
  const entries: WorkbookEntry[] = [
    { field: 'S4 Estimate ID', cell: text(s4.estimateId) },
    { field: 'Building ID', cell: text(s4.buildingId) },
    { field: 'Calculation Status', cell: text(s4.calculationStatus) },
    { field: 'Final Estimate', cell: textOrNull(s4.finalEstimate) },
    { field: 'External Dependencies', cell: joined(s4.pending.externalDependencies) },
    { field: 'Incomplete', cell: joined(s4.pending.incomplete) },
    { field: 'Not Specified', cell: joined(s4.pending.notSpecified) },
  ];
  const table: WorkbookTableModel = {
    columns: S4_STAGE_COLUMNS,
    rows: s4.stages.map((stage) => [
      text(stage.stage),
      text(stage.rule.id),
      text(stage.rule.sourceReference),
      textOrNull(stage.input),
      textOrNull(stage.coefficient),
      textOrNull(stage.output),
      text(stage.status),
      optionalText(stage.note),
    ]),
  };
  return { name: 'S4 Trace', entries, table };
}

/**
 * Builds the workbook model from a report: validates the report's structure first and
 * fails loudly (INVALID_REPORT_MODEL) on any violation. Sheet order is fixed:
 * Summary, Chapters, Groups, Lines, then S4 Trace when the report carries an S4 result.
 */
export function buildWorkbookModel(report: ReportModel): WorkbookModel {
  const errors = reportStructureErrors(report);
  if (errors.length > 0) {
    throw new ReportingExcelError(
      'INVALID_REPORT_MODEL',
      'the ReportModel failed the renderer structural validation; nothing is repaired',
      errors,
    );
  }
  return {
    sheets: [
      summarySheet(report),
      chaptersSheet(report),
      groupsSheet(report),
      linesSheet(report),
      ...(report.generatedFrom.s4Estimate !== null ? [s4TraceSheet(report)] : []),
    ],
  };
}
