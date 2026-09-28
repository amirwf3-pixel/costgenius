import { readFileSync } from 'node:fs';
import { publishStagedImport, type PublishedDataset } from '@costgenius/pricebook';

/** Loads and publishes the staged 1404 verified subset (59 real verified rows). */
export function loadPublished1404(): PublishedDataset {
  const file: unknown = JSON.parse(
    readFileSync(
      new URL('../../pricebook/data/verified-1404.staged.v0.1.0.json', import.meta.url),
      'utf8',
    ),
  );
  return publishStagedImport(file);
}

/**
 * Fully SYNTHETIC published dataset for BOQ tests. All codes, prices and statuses are
 * fictitious test data — never official 1404 content. Edition "SYN" is deliberately not
 * the official edition.
 */
export function syntheticDataset(): PublishedDataset {
  const sourceRef = {
    sourceDocument: 'SYNTHETIC TEST DATA',
    edition: 'SYN',
    printedPage: '1',
    section: 'SYN-1',
    sourceFileHash: null,
  };
  const row = (
    code: string,
    unit: { label: string; code: string },
    basePrice: string | null,
    status: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    code,
    chapter: 'chapter-99',
    group: '1',
    description: `SYNTHETIC test row ${code}`,
    unit,
    basePrice,
    status,
    sourceRef,
    externalDependencies: [],
    notes: [],
    ...extra,
  });
  const file: unknown = {
    formatVersion: '1',
    kind: 'staged-import',
    edition: {
      id: 'syn-test-edition',
      title: 'SYNTHETIC TEST DATA',
      organization: 'SYNTHETIC',
      year: 'SYN',
      notificationNumber: null,
      notificationDate: null,
      sourceFileHash: null,
    },
    rows: [
      row('990001', { label: 'مترمکعب', code: 'm3' }, '1000', 'VERIFIED_SPEC_ONLY'),
      row('990002', { label: 'قالب', code: 'each' }, '500', 'VERIFIED_SPEC_ONLY', { group: '2' }),
      row('990003', { label: 'مترمکعب', code: 'm3' }, null, 'INCOMPLETE', {
        notes: ['SYNTHETIC: blank price cell'],
      }),
      row('990004', { label: 'مترمکعب', code: 'm3' }, null, 'EXTERNAL_DEPENDENCY', {
        externalDependencies: ['regional-coefficient-circular-94-69416'],
      }),
      row('990005', { label: 'مترمکعب', code: 'm3' }, null, 'NOT_SPECIFIED_IN_1404_PRICEBOOK'),
      // tiny decimal prices for the exact-arithmetic test (synthetic, not Rial-realistic)
      row('990006', { label: 'مترمکعب', code: 'm3' }, '0.1', 'VERIFIED_SPEC_ONLY', { group: '3' }),
      row('990007', { label: 'مترمکعب', code: 'm3' }, '0.2', 'VERIFIED_SPEC_ONLY', { group: '3' }),
    ],
  };
  return publishStagedImport(file);
}

/** A second synthetic dataset with a DIFFERENT price for 990001, for the snapshot test. */
export function syntheticDatasetAltPrice(): PublishedDataset {
  const sourceRef = {
    sourceDocument: 'SYNTHETIC TEST DATA',
    edition: 'SYN',
    printedPage: '2',
    section: 'SYN-2',
    sourceFileHash: null,
  };
  const file: unknown = {
    formatVersion: '1',
    kind: 'staged-import',
    edition: {
      id: 'syn-test-edition',
      title: 'SYNTHETIC TEST DATA',
      organization: 'SYNTHETIC',
      year: 'SYN',
      notificationNumber: null,
      notificationDate: null,
      sourceFileHash: null,
    },
    rows: [
      {
        code: '990001',
        chapter: 'chapter-99',
        group: '1',
        description: 'SYNTHETIC test row 990001 (alternative price)',
        unit: { label: 'مترمکعب', code: 'm3' },
        basePrice: '999999',
        status: 'VERIFIED_SPEC_ONLY',
        sourceRef,
        externalDependencies: [],
        notes: [],
      },
    ],
  };
  return publishStagedImport(file);
}
