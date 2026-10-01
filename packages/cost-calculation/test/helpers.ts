import { readFileSync } from 'node:fs';
import { publishStagedImport, type PublishedDataset } from '@costgenius/pricebook';

/**
 * Loads the staged 1404 verified-subset file and publishes it through the import gate.
 * Real verified data (59 rows).
 */
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
 * Builds a fully SYNTHETIC published dataset for business-layer tests. All codes, prices
 * and statuses are fictitious test data — never official 1404 content. The edition id is
 * deliberately not the official edition, so the verified-subset completeness floor does
 * not apply.
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
      row('990002', { label: 'قالب', code: 'each' }, '500', 'VERIFIED_SPEC_ONLY'),
      row('990003', { label: 'مترمکعب', code: 'm3' }, null, 'INCOMPLETE', {
        notes: ['SYNTHETIC: blank price cell'],
      }),
      row('990004', { label: 'مترمکعب', code: 'm3' }, null, 'EXTERNAL_DEPENDENCY', {
        externalDependencies: ['regional-coefficient-circular-94-69416'],
        notes: ['SYNTHETIC: value lives in an external source'],
      }),
      row('990005', { label: 'مترمکعب', code: 'm3' }, null, 'NOT_SPECIFIED_IN_1404_PRICEBOOK', {
        notes: ['SYNTHETIC: no rule in the 1404 price book'],
      }),
      row('070612', { label: 'مترمکعب', code: 'm3' }, '2000', 'VERIFIED_SPEC_ONLY', {
        chapter: 'chapter-7',
        group: '6',
      }),
      row('990101', { label: 'تن - کیلومتر', code: 'ton_km' }, '300', 'VERIFIED_SPEC_ONLY', {
        group: '2',
      }),
    ],
  };
  return publishStagedImport(file);
}
