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
  ensureActivatable,
  ensureArchivable,
  ensureSelectable,
  isEditionStatus,
  PRICEBOOK_EDITION_STATUSES,
  validateStagedImport,
  V1_DISCIPLINE,
  type CanonicalEditionContent,
  type EditionStatus,
  type PricebookEdition,
  type PricebookEditionError,
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

/* ------------------------------------------------------------------------------------------------
 * P8-B S2 — the lifecycle decision layer (§7/§8/§20): the pure guards
 * -----------------------------------------------------------------------------------------------*/

describe('the S2 lifecycle guards (ensureActivatable / ensureArchivable, CG-IR-PB@0.2.0 §8)', () => {
  /** An edition skeleton with ONLY the fields the guards decide on. */
  function editionOf(overrides: { status: EditionStatus; importedBy: string }): PricebookEdition {
    return {
      ...readStaged1404AsEdition(),
      status: overrides.status,
      importedBy: overrides.importedBy,
    };
  }

  function readStaged1404AsEdition(): PricebookEdition {
    const file = readStaged1404();
    const content = canonicalContentOf(file);
    return {
      editionId: file.edition.id,
      discipline: V1_DISCIPLINE,
      year: file.edition.year,
      title: file.edition.title,
      organization: file.edition.organization,
      notificationNumber: file.edition.notificationNumber,
      notificationDate: file.edition.notificationDate,
      sourceFileHash: file.edition.sourceFileHash ?? 'source-hash',
      contentHash: contentHashOf(content),
      content,
      importReport: validateStagedImport(file),
      status: 'DRAFT',
      supersedesEditionId: null,
      importedBy: 'importer-1',
      importedAt: '2026-01-01T00:00:00Z',
      activatedBy: null,
      activatedAt: null,
      archivedBy: null,
      archivedAt: null,
    };
  }

  /** Runs a guard, returning its error code — undefined when it passes. */
  function guardCode(work: () => void): string | undefined {
    try {
      work();
      return undefined;
    } catch (error) {
      const lifecycleError = error as PricebookEditionError;
      expect(lifecycleError.name).toBe('PricebookEditionError');
      return lifecycleError.code;
    }
  }

  it('DRAFT + a DIFFERENT activator is activatable (the normal four-eyes-clean handover)', () => {
    expect(
      guardCode(() => {
        ensureActivatable(editionOf({ status: 'DRAFT', importedBy: 'importer-1' }), 'steward-2');
      }),
    ).toBeUndefined();
  });

  it('DRAFT + the IMPORTER as activator → 403 EDITION_SELF_ACTIVATION_FORBIDDEN (four-eyes)', () => {
    expect(
      guardCode(() => {
        ensureActivatable(editionOf({ status: 'DRAFT', importedBy: 'importer-1' }), 'importer-1');
      }),
    ).toBe('EDITION_SELF_ACTIVATION_FORBIDDEN');
  });

  it('ARCHIVED + the IMPORTER as activator is ALLOWED — four-eyes does not apply to re-activation (§8)', () => {
    expect(
      guardCode(() => {
        ensureActivatable(
          editionOf({ status: 'ARCHIVED', importedBy: 'importer-1' }),
          'importer-1',
        );
      }),
    ).toBeUndefined();
  });

  it('ACTIVE (any activator) → 409 EDITION_ALREADY_ACTIVE — checked before four-eyes', () => {
    expect(
      guardCode(() => {
        ensureActivatable(editionOf({ status: 'ACTIVE', importedBy: 'importer-1' }), 'steward-2');
      }),
    ).toBe('EDITION_ALREADY_ACTIVE');
  });

  it('DRAFT and ACTIVE are archivable; ARCHIVED → 409 EDITION_ALREADY_ARCHIVED', () => {
    expect(
      guardCode(() => {
        ensureArchivable(editionOf({ status: 'DRAFT', importedBy: 'x' }));
      }),
    ).toBeUndefined();
    expect(
      guardCode(() => {
        ensureArchivable(editionOf({ status: 'ACTIVE', importedBy: 'x' }));
      }),
    ).toBeUndefined();
    expect(
      guardCode(() => {
        ensureArchivable(editionOf({ status: 'ARCHIVED', importedBy: 'x' }));
      }),
    ).toBe('EDITION_ALREADY_ARCHIVED');
  });

  it('every guard error carries the §20 code and the stable mapper discriminator', () => {
    expect(
      guardCode(() => {
        ensureActivatable(editionOf({ status: 'ACTIVE', importedBy: 'x' }), 'y');
      }),
    ).toBe('EDITION_ALREADY_ACTIVE');
  });
});

describe('the S3 selection guard (ensureSelectable, CG-IR-PB@0.2.0 §12, D-PB-3 = B)', () => {
  /** An edition skeleton with ONLY the fields the guard decides on. */
  function editionOf(status: EditionStatus): PricebookEdition {
    const file = readStaged1404();
    const content = canonicalContentOf(file);
    return {
      editionId: file.edition.id,
      discipline: V1_DISCIPLINE,
      year: file.edition.year,
      title: file.edition.title,
      organization: file.edition.organization,
      notificationNumber: file.edition.notificationNumber,
      notificationDate: file.edition.notificationDate,
      sourceFileHash: file.edition.sourceFileHash ?? 'source-hash',
      contentHash: contentHashOf(content),
      content,
      importReport: validateStagedImport(file),
      status,
      supersedesEditionId: null,
      importedBy: 'importer-1',
      importedAt: '2026-01-01T00:00:00Z',
      activatedBy: null,
      activatedAt: null,
      archivedBy: null,
      archivedAt: null,
    };
  }

  /** Runs the guard, returning its error code — undefined when it passes. */
  function guardCode(work: () => void): string | undefined {
    try {
      work();
      return undefined;
    } catch (error) {
      const lifecycleError = error as PricebookEditionError;
      expect(lifecycleError.name).toBe('PricebookEditionError');
      return lifecycleError.code;
    }
  }

  it('ACTIVE and ARCHIVED are selectable for new work (the explicit-ARCHIVED contract driver)', () => {
    expect(
      guardCode(() => {
        ensureSelectable(editionOf('ACTIVE'));
      }),
    ).toBeUndefined();
    expect(
      guardCode(() => {
        ensureSelectable(editionOf('ARCHIVED'));
      }),
    ).toBeUndefined();
  });

  it('DRAFT is NEVER selectable → 409 EDITION_NOT_SELECTABLE (§12/§20)', () => {
    expect(
      guardCode(() => {
        ensureSelectable(editionOf('DRAFT'));
      }),
    ).toBe('EDITION_NOT_SELECTABLE');
  });

  it('the DRAFT rejection names the edition and the rule (zero-guess diagnostics)', () => {
    let message = '';
    try {
      ensureSelectable(editionOf('DRAFT'));
    } catch (error) {
      message = (error as PricebookEditionError).message;
    }
    expect(message).toContain('ir-1404-abniye');
    expect(message).toContain('DRAFT');
  });
});
