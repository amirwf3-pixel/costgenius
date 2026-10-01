/**
 * The published, immutable dataset and its read-only access boundary.
 *
 * Identity is the exact printed code string; lookups are exact-match only. Filtering is by
 * exact field equality — there is deliberately no description search and no fuzzy
 * matching. This module is the only runtime consumers should use; nothing here converts a
 * status, a null price or a dependency into a usable value.
 */
import type { UnitCode } from '@costgenius/domain';
import type { EditionMetadata } from './provenance.js';
import type { PricebookRow } from './row.js';
import type { PricebookStatus } from './status.js';

export interface RowFilter {
  readonly chapter?: string;
  readonly group?: string;
  readonly unitCode?: UnitCode;
  readonly status?: PricebookStatus;
}

export interface PublishedDataset {
  readonly edition: EditionMetadata;
  readonly rows: readonly PricebookRow[];
  /** Exact printed-code identity lookup. No trimming, no normalisation, no fuzzy match. */
  getRow(code: string): PricebookRow | undefined;
  hasRow(code: string): boolean;
  /** Exact-equality filter over the published rows, in published order. Never selects by similarity. */
  findRows(filter: RowFilter): readonly PricebookRow[];
  /** Distinct chapter ids in first-appearance order. */
  chapters(): readonly string[];
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

/** Creates the immutable published dataset. Internal: only the import gate calls this. */
export function createPublishedDataset(
  edition: EditionMetadata,
  rows: readonly unknown[],
): PublishedDataset {
  // Deep-clone then freeze: the caller can never mutate a published dataset afterwards,
  // and no caller-owned array or object is shared with the dataset.
  const frozenRows = deepFreeze(structuredClone(rows)) as readonly PricebookRow[];
  const byCode: ReadonlyMap<string, PricebookRow> = new Map(frozenRows.map((r) => [r.code, r]));

  const dataset: PublishedDataset = {
    edition: deepFreeze(structuredClone(edition)),
    rows: frozenRows,
    getRow(code: string): PricebookRow | undefined {
      return byCode.get(code);
    },
    hasRow(code: string): boolean {
      return byCode.has(code);
    },
    findRows(filter: RowFilter): readonly PricebookRow[] {
      return frozenRows.filter(
        (row) =>
          (filter.chapter === undefined || row.chapter === filter.chapter) &&
          (filter.group === undefined || row.group === filter.group) &&
          (filter.unitCode === undefined || row.unit.code === filter.unitCode) &&
          (filter.status === undefined || row.status === filter.status),
      );
    },
    chapters(): readonly string[] {
      const seen: string[] = [];
      for (const row of frozenRows) {
        if (!seen.includes(row.chapter)) seen.push(row.chapter);
      }
      return seen;
    },
  };
  return deepFreeze(dataset);
}
