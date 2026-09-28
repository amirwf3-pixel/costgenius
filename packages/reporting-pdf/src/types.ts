/**
 * The PDF document model — a rendering-library-independent description of the report
 * document, built purely from a ReportModel (stage 2a, mirroring the Excel renderer's
 * workbook model). Every value is copied verbatim; `null`/absent values become `empty`
 * cells — never 0, never ''.
 */

/** One key–value row of a metadata block (the whole row for Summary/S4 identity). */
export interface KeyValueRow {
  readonly field: string;
  /** The value as an exact string, or null when the contract value is null/absent. */
  readonly value: string | null;
}

/** A table column: header text and fixed width in points. */
export interface TableColumn {
  readonly header: string;
  readonly width: number;
}

/** A data table: columns in LOGICAL (first column = leftmost in the model) order. */
export interface TableModel {
  readonly columns: readonly TableColumn[];
  /** Cell values as exact strings, or null when the contract value is null/absent. */
  readonly rows: readonly (readonly (string | null)[])[];
}

/** Document block kinds. */
export type PdfBlock =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: 'key-value'; readonly rows: readonly KeyValueRow[] }
  | { readonly kind: 'table'; readonly title: string; readonly table: TableModel }
  | { readonly kind: 'paragraph'; readonly text: string };

/** A document section; orientation is fixed per section (deterministic layout). */
export interface PdfSection {
  readonly orientation: 'portrait' | 'landscape';
  readonly blocks: readonly PdfBlock[];
}

/** The complete document: sections in fixed order. */
export interface PdfDocumentModel {
  readonly title: string;
  readonly sections: readonly PdfSection[];
}
