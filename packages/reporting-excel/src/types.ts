/**
 * The renderer-local workbook model — a rendering-library-independent description of the
 * workbook, built purely from a ReportModel.
 *
 * Cell values keep the ReportModel's exact contract: business decimal strings (codes with
 * leading zeros, quantities, prices, amounts, coefficients) are `text` cells and are NEVER
 * converted to numbers; integers that are already numbers in the contract (counts, version
 * number) are `integer` cells; `null`/absent values are `empty` cells — never 0, never ''.
 */

/** A single cell value in the workbook model. */
export type WorkbookCell =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'empty' };

/** One key–value entry of a sheet's leading block (e.g. the Summary sheet). */
export interface WorkbookEntry {
  readonly field: string;
  readonly cell: WorkbookCell;
}

/** A table column: header text, fixed width, and whether long text wraps. */
export interface WorkbookColumn {
  readonly header: string;
  readonly width: number;
  readonly wrap: boolean;
}

/** A table block (header + data rows) rendered below a sheet's key–value block. */
export interface WorkbookTableModel {
  readonly columns: readonly WorkbookColumn[];
  readonly rows: readonly WorkbookCell[][];
}

/**
 * One sheet. `entries` is the leading key–value block (the whole sheet for Summary);
 * `table` is the optional tabular block below it (Chapters/Groups/Lines/S4 stages).
 */
export interface WorkbookSheetModel {
  readonly name: string;
  readonly entries: readonly WorkbookEntry[];
  readonly table?: WorkbookTableModel;
}

/** The complete workbook: sheets in fixed, deterministic order. */
export interface WorkbookModel {
  readonly sheets: readonly WorkbookSheetModel[];
}
