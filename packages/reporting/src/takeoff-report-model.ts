/**
 * The Takeoff ReportModel — stage 1 of the two-stage reporting design, takeoff branch
 * (D-016 Phase 6, G6=A).
 *
 * A takeoff report is an immutable, rendering-independent SNAPSHOT OF THE FINALIZED
 * TAKEOFF SNAPSHOT: every quantity, rounded value, effective value and total is copied
 * VERBATIM from the engine result that was persisted at finalization time. This layer
 * performs no calculation of its own — no quantity resolution, no aggregation, no
 * rounding, no recomputation of any kind (implementation-contract §22 and D-016 §3/§14).
 * A draft can never reach this layer: the source must be a finalized snapshot.
 *
 * The canonical formula column is the §6.3 display of CG-FT-TAKEOFF-SPEC@0.1.0 (the
 * normative, deterministic rendering shared by the UI and the report): a pure function
 * of the quantity tree, never parsed back, never evaluated.
 */
import type {
  ExpressionNode,
  RoundingRuleEntry,
  TakeoffCalculationInput,
  TakeoffQuantity,
  TakeoffResult,
} from '@costgenius/calc-engine';
import { ReportingError } from './errors.js';

// -------------------------------------------------------------------------------------------------
// §6.3 canonical display (normative, deterministic — the same grammar the UI renders)
// -------------------------------------------------------------------------------------------------

const present = (value: string | undefined): value is string => value !== undefined && value !== '';

function displayNode(node: ExpressionNode): string {
  switch (node.op) {
    case 'const':
      return node.value;
    case 'ref':
      return node.use === 'magnitude' ? `|#${node.lineId}|` : `#${node.lineId}`;
    case 'add':
      return `(${node.args.map(displayNode).join(' + ')})`;
    case 'mul':
      return `(${node.args.map(displayNode).join(' × ')})`;
    case 'sub':
      return `(${displayNode(node.args[0])} - ${displayNode(node.args[1])})`;
    case 'round':
      return `round(${displayNode(node.arg)}, ${String(node.rule.scale)}, ${node.rule.mode})`;
  }
}

/**
 * The §6.3 canonical display of one quantity — LTR text inside the RTL report. Only the
 * PRESENT factors appear (an absent `floorCount`/`similarCount` is never shown as 1);
 * manual values render as the literal with the justification shown separately.
 */
export function takeoffQuantityDisplay(quantity: TakeoffQuantity): string {
  switch (quantity.type) {
    case 'dimensional': {
      const parts: string[] = [];
      if (present(quantity.floorCount)) parts.push(quantity.floorCount);
      if (present(quantity.similarCount)) parts.push(quantity.similarCount);
      for (const dim of ['length', 'width', 'height'] as const) {
        if (present(quantity[dim])) parts.push(quantity[dim]);
      }
      return `(${parts.join(' × ')})`;
    }
    case 'reference':
      return `(${quantity.terms
        .map(
          (term) =>
            `${term.factor} × ${term.use === 'magnitude' ? `|#${term.lineId}|` : `#${term.lineId}`}`,
        )
        .join(' + ')})`;
    case 'expression':
      return displayNode(quantity.node);
    case 'manual':
      return quantity.value;
  }
}

// -------------------------------------------------------------------------------------------------
// The source: the finalized snapshot (structurally the domain's FinalizedTakeoff)
// -------------------------------------------------------------------------------------------------

/** The finalized snapshot's document metadata, exactly as persisted (verbatim copy). */
export interface TakeoffReportDocument {
  readonly documentId: string;
  readonly takeoffId: string;
  readonly projectId: string;
  readonly title: string;
  readonly documentNumber: number;
  /** Reports are finalized-only; a draft/archived source is rejected by the builder. */
  readonly status: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly finalizedAt?: string;
}

/**
 * What the builder consumes: the immutable finalized snapshot. This is deliberately a
 * structural mirror of the projects layer's `FinalizedTakeoff` (the reporting package
 * cannot import its consumer); TypeScript's structural typing accepts the real snapshot.
 */
export interface TakeoffReportSource {
  readonly document: TakeoffReportDocument;
  readonly documentId: string;
  readonly takeoffId: string;
  readonly documentNumber: number;
  /** Domain Instant of finalization — part of the snapshot, never a render-time clock. */
  readonly finalizedAt: string;
  /** The exact engine input that produced the result (deterministic replay record). */
  readonly input: TakeoffCalculationInput;
  /** The engine result, verbatim. */
  readonly result: TakeoffResult;
}

// -------------------------------------------------------------------------------------------------
// The model
// -------------------------------------------------------------------------------------------------

/** Stable report identity and provenance metadata (all snapshot- or caller-supplied). */
export interface TakeoffReportMetadata {
  readonly reportId: string;
  readonly documentId: string;
  readonly takeoffId: string;
  readonly projectId: string;
  /** Project title when the caller supplied it; null when unknown (never invented). */
  readonly projectTitle: string | null;
  readonly title: string;
  readonly documentNumber: number;
  readonly status: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly finalizedAt: string;
  readonly specId: string;
  readonly specVersion: string;
  readonly engineVersion: string;
  readonly sheetCount: number;
  readonly lineCount: number;
  readonly codedItemCount: number;
  readonly uncodedItemCount: number;
}

/** One detailed line: the authored input joined with the engine's own per-line result. */
export interface TakeoffReportLine {
  readonly sheetOrder: number;
  readonly sheetId: string;
  readonly sheetName: string;
  readonly rowNo: number;
  readonly lineId: string;
  readonly description: string;
  readonly location: string | null;
  /** Opaque pricebook code; null for uncoded lines (never an invented code). */
  readonly itemCode: string | null;
  readonly kind: string;
  /** ابعادی / ارجاع / عبارت / دستی — the quantity form label. */
  readonly quantityType: string;
  readonly unit: string;
  /** The §6.3 canonical display — the one deterministic formula representation. */
  readonly formula: string;
  /** Present factors only; absent → null (an absent factor is never shown as 1). */
  readonly floorCount: string | null;
  readonly similarCount: string | null;
  /** Manual justification, shown separately (§6.3); null for non-manual quantities. */
  readonly manualJustification: string | null;
  readonly notes: string | null;
  /** The engine's exact magnitude — verbatim, authoritative. */
  readonly exactMagnitude: string;
  /** The engine's rounded magnitude; null when no rule produced one (never fabricated). */
  readonly roundedMagnitude: string | null;
  /** The engine's signed value (kind applied after any line rounding) — verbatim. */
  readonly signedValue: string;
  /** The root trace node's spec anchor (the trace reference); null when absent. */
  readonly traceRuleId: string | null;
}

export interface TakeoffReportSheet {
  readonly sheetOrder: number;
  readonly sheetId: string;
  readonly sheetName: string;
  readonly lines: readonly TakeoffReportLine[];
}

/** One aggregation row (itemTotals and per-sheet byItem share this shape) — verbatim. */
export interface TakeoffReportTotalRow {
  readonly itemCode: string | null;
  readonly unit: string;
  readonly exactQty: string;
  readonly roundedQty: string | null;
  /** Effective value: roundedQty when a rule produced one, otherwise exactQty (R2=C). */
  readonly qty: string;
  readonly lineIds: readonly string[];
}

export interface TakeoffReportSheetTotal {
  readonly sheetOrder: number;
  readonly sheetId: string;
  readonly sheetName: string;
  readonly byItem: readonly TakeoffReportTotalRow[];
}

/** A rounding rule of the snapshot's rule set, copied verbatim (design-authored in V1). */
export interface TakeoffReportRoundingRule {
  readonly target: string;
  readonly selector: string | null;
  readonly scale: number;
  readonly mode: string;
  readonly sourceStatus: string;
  readonly source: string | null;
}

/** Where the report came from — the full snapshot, preserved verbatim for inspection. */
export interface TakeoffReportProvenance {
  readonly document: TakeoffReportDocument;
  readonly projectTitle: string | null;
  readonly input: TakeoffCalculationInput;
  readonly result: TakeoffResult;
}

/** The immutable takeoff report snapshot handed to the renderers. */
export interface TakeoffReportModel {
  readonly reportId: string;
  readonly metadata: TakeoffReportMetadata;
  /** Sheets in document order; lines ordered by sheet order then row number (§13). */
  readonly sheets: readonly TakeoffReportSheet[];
  /** Item totals in the engine's own deterministic order (§13). */
  readonly itemTotals: readonly TakeoffReportTotalRow[];
  readonly sheetTotals: readonly TakeoffReportSheetTotal[];
  readonly rounding: readonly TakeoffReportRoundingRule[];
  readonly generatedFrom: TakeoffReportProvenance;
}

export interface BuildTakeoffReportInput {
  readonly source: TakeoffReportSource;
  /** Deterministic default: `takeoff-report-<documentId>`; no randomness inside. */
  readonly reportId?: string;
  /** Project title when the caller knows it; omitted → null (never invented). */
  readonly projectTitle?: string | null;
}

// -------------------------------------------------------------------------------------------------
// Builder
// -------------------------------------------------------------------------------------------------

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

const QUANTITY_TYPE_LABELS: Readonly<Record<TakeoffQuantity['type'], string>> = {
  dimensional: 'ابعادی',
  reference: 'ارجاع',
  expression: 'عبارت',
  manual: 'دستی',
};

/** The §6.3 selector rendering: AND-combined fields, or «همه» when no selector exists. */
function selectorDisplay(rule: RoundingRuleEntry): string | null {
  if (rule.selector === undefined) return null;
  const parts: string[] = [];
  if (rule.selector.itemCode !== undefined) parts.push(`کد ${rule.selector.itemCode}`);
  if (rule.selector.unit !== undefined) parts.push(`واحد ${rule.selector.unit}`);
  if (rule.selector.lineIds !== undefined && rule.selector.lineIds.length > 0) {
    parts.push(`ردیف‌های ${rule.selector.lineIds.join('+')}`);
  }
  return parts.length > 0 ? parts.join(' و ') : 'همه';
}

function sourceDisplay(rule: RoundingRuleEntry): string | null {
  if (rule.source === undefined) return null;
  const parts: string[] = [];
  if (rule.source.sourceDocument !== null) parts.push(rule.source.sourceDocument);
  if (rule.source.edition !== null) parts.push(rule.source.edition);
  if (rule.source.page !== null) parts.push(`صفحه ${rule.source.page}`);
  if (rule.source.section !== null) parts.push(rule.source.section);
  return parts.length > 0 ? parts.join('، ') : null;
}

function totalRowOf(item: {
  readonly itemCode: string | null;
  readonly unit: string;
  readonly exactQty: string;
  readonly roundedQty?: string;
  readonly qty: string;
  readonly lineIds: readonly string[];
}): TakeoffReportTotalRow {
  return {
    itemCode: item.itemCode,
    unit: item.unit,
    exactQty: item.exactQty,
    roundedQty: item.roundedQty ?? null,
    qty: item.qty,
    lineIds: [...item.lineIds],
  };
}

/**
 * Builds the TakeoffReportModel from a FINALIZED takeoff snapshot: a deep-cloned, frozen
 * copy whose every quantity comes from the persisted engine result. Ordering is explicit
 * (document → sheet order → row number; item totals in engine order); nothing is
 * recalculated, re-rounded, aggregated or repaired here.
 */
export function buildTakeoffReportModel(input: BuildTakeoffReportInput): TakeoffReportModel {
  const source = input.source;
  requireNonEmpty(source.document.documentId, 'source.document.documentId');
  requireNonEmpty(source.document.takeoffId, 'source.document.takeoffId');
  requireNonEmpty(source.document.projectId, 'source.document.projectId');
  requireNonEmpty(source.document.title, 'source.document.title');
  requireNonEmpty(source.document.createdAt, 'source.document.createdAt');
  requireNonEmpty(source.finalizedAt, 'source.finalizedAt');
  // Finalized-only (D-016 §9): a draft or archived document has no report — reject it
  // here too, not just at the API edge, so the model can never render an unfinalized takeoff.
  if (source.document.status !== 'finalized') {
    throw new ReportingError(
      'INVALID_REPORT_INPUT',
      `only a finalized takeoff has a report (document "${source.document.documentId}" is ${source.document.status})`,
    );
  }
  if (source.result.status !== 'ok') {
    throw new ReportingError(
      'INVALID_REPORT_INPUT',
      `the finalized snapshot's engine result is not ok (document "${source.document.documentId}")`,
    );
  }
  // Identity mirrors: the bundle level and the document level must agree.
  if (
    source.documentId !== source.document.documentId ||
    source.takeoffId !== source.document.takeoffId ||
    source.documentNumber !== source.document.documentNumber
  ) {
    throw new ReportingError(
      'INVALID_REPORT',
      'the finalized snapshot identity does not mirror its document identity',
    );
  }
  const reportId = input.reportId ?? `takeoff-report-${source.document.documentId}`;
  requireNonEmpty(reportId, 'reportId');

  // Join the authored lines with the engine's per-line results (lineId is the key).
  const resultByLineId = new Map(source.result.lines.map((line) => [line.lineId, line]));
  const inputLineIds = new Set<string>();
  const sheets: TakeoffReportSheet[] = source.input.sheets.map((sheet, sheetIndex) => {
    const orderedLines = [...sheet.lines].sort((a, b) => a.rowNo - b.rowNo);
    return {
      sheetOrder: sheetIndex + 1,
      sheetId: sheet.sheetId,
      sheetName: sheet.name,
      lines: orderedLines.map((line) => {
        inputLineIds.add(line.lineId);
        const result = resultByLineId.get(line.lineId);
        if (result === undefined) {
          throw new ReportingError(
            'INVALID_REPORT',
            `line "${line.lineId}" of sheet "${sheet.sheetId}" has no result in the finalized snapshot`,
          );
        }
        const quantity = line.quantity;
        return {
          sheetOrder: sheetIndex + 1,
          sheetId: sheet.sheetId,
          sheetName: sheet.name,
          rowNo: line.rowNo,
          lineId: line.lineId,
          description: line.description,
          location: line.location ?? null,
          itemCode: line.itemCode ?? null,
          kind: line.kind,
          quantityType: QUANTITY_TYPE_LABELS[quantity.type],
          unit: line.unit,
          formula: takeoffQuantityDisplay(quantity),
          floorCount: quantity.type === 'dimensional' ? (quantity.floorCount ?? null) : null,
          similarCount: quantity.type === 'dimensional' ? (quantity.similarCount ?? null) : null,
          manualJustification: quantity.type === 'manual' ? quantity.justification : null,
          notes: line.notes ?? null,
          exactMagnitude: result.exactMagnitude,
          roundedMagnitude: result.roundedMagnitude ?? null,
          signedValue: result.signedValue,
          traceRuleId: result.trace.ruleId,
        };
      }),
    };
  });
  // Coverage: every engine result line must belong to the authored input (no orphans).
  for (const resultLine of source.result.lines) {
    if (!inputLineIds.has(resultLine.lineId)) {
      throw new ReportingError(
        'INVALID_REPORT',
        `the engine result carries line "${resultLine.lineId}" but the snapshot input does not`,
      );
    }
  }

  const sheetById = new Map(sheets.map((sheet) => [sheet.sheetId, sheet]));
  const sheetTotals: TakeoffReportSheetTotal[] = source.result.sheetTotals.map((total) => {
    const sheet = sheetById.get(total.sheetId);
    if (sheet === undefined) {
      throw new ReportingError(
        'INVALID_REPORT',
        `the engine result totals reference unknown sheet "${total.sheetId}"`,
      );
    }
    return {
      sheetOrder: sheet.sheetOrder,
      sheetId: total.sheetId,
      sheetName: sheet.sheetName,
      byItem: total.byItem.map(totalRowOf),
    };
  });

  const itemTotals = source.result.itemTotals.map(totalRowOf);
  const rounding: TakeoffReportRoundingRule[] = source.input.rounding.map((rule) => ({
    target: rule.target,
    selector: selectorDisplay(rule),
    scale: rule.scale,
    mode: rule.mode,
    sourceStatus: rule.sourceStatus,
    source: sourceDisplay(rule),
  }));

  const report: TakeoffReportModel = {
    reportId,
    metadata: {
      reportId,
      documentId: source.document.documentId,
      takeoffId: source.document.takeoffId,
      projectId: source.document.projectId,
      projectTitle: input.projectTitle ?? null,
      title: source.document.title,
      documentNumber: source.document.documentNumber,
      status: source.document.status,
      revision: source.document.revision,
      createdAt: source.document.createdAt,
      finalizedAt: source.finalizedAt,
      specId: source.result.specId,
      specVersion: source.result.specVersion,
      engineVersion: source.result.engineVersion,
      sheetCount: sheets.length,
      lineCount: sheets.reduce((sum, sheet) => sum + sheet.lines.length, 0),
      codedItemCount: itemTotals.filter((total) => total.itemCode !== null).length,
      uncodedItemCount: itemTotals.filter((total) => total.itemCode === null).length,
    },
    sheets,
    itemTotals,
    sheetTotals,
    rounding,
    generatedFrom: {
      document: { ...source.document },
      projectTitle: input.projectTitle ?? null,
      input: structuredClone(source.input),
      result: structuredClone(source.result),
    },
  };

  return deepFreeze(report);
}
