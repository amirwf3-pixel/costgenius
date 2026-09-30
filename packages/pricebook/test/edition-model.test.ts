/**
 * P8-B S1 — the persistent edition domain model (CG-IR-PRICEBOOK-SPEC@0.2.0 §4/§5/§7).
 *
 * Pure-model verification of the vocabulary edition persistence is built on: the
 * three-state lifecycle, the canonical-content extraction (exactly what a consumer
 * can obtain from the stored `content` — `notice` and the envelope fields excluded),
 * and the content hash — PINNED to the in-repo verified staged dataset (§24 point 5:
 * the seed's `contentHash` must equal the canonical hash of the repository's file).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalContentOf,
  canonicalJson,
  contentHashOf,
  isEditionStatus,
  PRICEBOOK_EDITION_STATUSES,
  validateStagedImport,
  type CanonicalEditionContent,
  type StagedPricebookFile,
} from '../src/index.js';

const STAGED_1404_PATH = new URL('../data/verified-1404.staged.v0.1.0.json', import.meta.url)
  .pathname;

/** The pinned dataset identity of the in-repo verified staged 1404 file (§24). */
const PINNED_1404_CONTENT_HASH = 'a669ddd4c315ee26fda6e43cff56eeac05cc03178ed8a665a13f49ff814de786';

function readStaged1404(): StagedPricebookFile {
  return JSON.parse(readFileSync(STAGED_1404_PATH, 'utf8')) as StagedPricebookFile;
}

describe('EditionStatus (CG-IR-PB@0.2.0 §7, D-PB-2 = A)', () => {
  it('is exactly the three lifecycle states — no 0.1.0 pipeline status survives', () => {
    expect(PRICEBOOK_EDITION_STATUSES).toEqual(['DRAFT', 'ACTIVE', 'ARCHIVED']);
    for (const status of ['DRAFT', 'ACTIVE', 'ARCHIVED']) {
      expect(isEditionStatus(status)).toBe(true);
    }
    for (const superseded of ['staging', 'validated', 'approved', 'published', 'withdrawn', '']) {
      expect(isEditionStatus(superseded)).toBe(false);
    }
    expect(isEditionStatus(null)).toBe(false);
    expect(isEditionStatus(1404)).toBe(false);
  });
});

describe('canonicalContentOf (§18 content-storage semantics)', () => {
  it('carries exactly the edition block and the rows, in file order — nothing else', () => {
    const file = readStaged1404();
    const content = canonicalContentOf(file);
    expect(content.edition).toEqual(file.edition);
    expect(content.rows).toEqual(file.rows);
    expect(Object.keys(content)).toEqual(['edition', 'rows']);
    // the envelope fields and the notice annotation are NOT part of the content identity
    const canonicalKeys = JSON.parse(canonicalJson(content)) as Record<string, unknown>;
    expect('notice' in canonicalKeys).toBe(false);
    expect('formatVersion' in canonicalKeys).toBe(false);
    expect('kind' in canonicalKeys).toBe(false);
  });
});

describe('contentHashOf (§5 dataset identity)', () => {
  it('is the pinned SHA-256 of canonicalJson({edition, rows}) of the verified file', () => {
    const file = readStaged1404();
    expect(validateStagedImport(file).ok).toBe(true);
    expect(contentHashOf(canonicalContentOf(file))).toBe(PINNED_1404_CONTENT_HASH);
  });

  it('changes with ANY content difference — a change is a new edition, by definition', () => {
    const file = readStaged1404();
    const base = contentHashOf(canonicalContentOf(file));
    // a different price on one row
    const row = file.rows[0] as Record<string, unknown>;
    const repriced = {
      ...file,
      rows: [{ ...row, basePrice: '999999999' }, ...file.rows.slice(1)],
    } as StagedPricebookFile;
    expect(contentHashOf(canonicalContentOf(repriced))).not.toBe(base);
    // a different edition identity block
    const relabeled = {
      ...file,
      edition: { ...file.edition, id: 'ir-1404-abniye-err1' },
    } as StagedPricebookFile;
    expect(contentHashOf(canonicalContentOf(relabeled))).not.toBe(base);
    // row ORDER is significant (file order is the published order)
    const reordered = {
      ...file,
      rows: [...file.rows.slice(1), file.rows[0]],
    } as StagedPricebookFile;
    expect(contentHashOf(canonicalContentOf(reordered))).not.toBe(base);
  });

  it('is deterministic and key-order independent (canonical JSON, not raw bytes)', () => {
    const file = readStaged1404();
    const content = canonicalContentOf(file);
    expect(contentHashOf(content)).toBe(contentHashOf(content));
    // the same values with shuffled object keys hash identically — JSONB round-trip safety
    const shuffled: CanonicalEditionContent = {
      rows: content.rows,
      edition: Object.fromEntries(
        Object.entries({ ...content.edition }).reverse(),
      ) as unknown as typeof content.edition,
    };
    expect(contentHashOf(shuffled)).toBe(contentHashOf(content));
  });
});
