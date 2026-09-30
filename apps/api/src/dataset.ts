/**
 * Dataset loading — publishes the official staged 1404 pricebook (1564 rows, sha256-verified
 * provenance on every row) through the import gate. The dataset is read-only reference
 * data: the API resolves lines against it and never mutates it, and it is never a source
 * of persisted prices (prices live only inside BOQ-line snapshots).
 */
import { readFileSync } from 'node:fs';
import { publishStagedImport, type PublishedDataset } from '@costgenius/pricebook';

/**
 * The in-repo verified staged 1404 dataset — the runtime default of `DATASET_PATH` and,
 * since P8-B S1 (D-PB-1 = B), the FIRST-BOOT SEED ARTIFACT: the file the pricebook seed
 * imports into `pricebook_editions` when the edition is not yet persisted. Once seeded,
 * the database is the source of truth for editions (CG-IR-PRICEBOOK-SPEC@0.2.0 §24).
 */
export const DEFAULT_DATASET_PATH = new URL(
  '../../../packages/pricebook/data/verified-1404.staged.v0.1.0.json',
  import.meta.url,
).pathname;

/** Loads and publishes the staged 1404 dataset from `path` (defaults to the in-repo file). */
export function loadPublishedDataset(path?: string): PublishedDataset {
  const file: unknown = JSON.parse(readFileSync(path ?? DEFAULT_DATASET_PATH, 'utf8'));
  return publishStagedImport(file);
}
