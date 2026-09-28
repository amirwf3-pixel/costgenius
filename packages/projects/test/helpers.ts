import { readFileSync } from 'node:fs';
import { publishStagedImport, type PublishedDataset } from '@costgenius/pricebook';
import type { EstimateCoefficientInputs } from '../src/estimate-calculation.js';
import type { EstimateLineInput } from '../src/estimate-lines.js';

/**
 * Loads and publishes the OFFICIAL staged 1404 dataset (1564 rows, sha256-verified
 * provenance on every row). Every fixture row in this test suite is a real published
 * 1404 row — no fabricated prices, no invented codes.
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

/** Fixed, deterministic identities (UUID shape per the domain id module). */
export const ORGANIZATION_ID = '11111111-2222-4333-8444-555555555555';
export const PROJECT_ID = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
export const ESTIMATE_ID = '12345678-90ab-4cde-9f01-234567890abc';
export const BUILDING_ID = 'building-main';
export const FIXED_INSTANT = '2026-01-01T00:00:00Z';

/**
 * The COMPLETE vertical-slice lines (all real 1404 rows, exact units):
 *
 * | line | row    | unit              | qty  | base price  | amount       |
 * |------|--------|-------------------|------|-------------|--------------|
 * | l1   | 010101 | m2 (leading zero) | 1000 | 2890        | 2890000      |
 * | l2   | 010517 | m2 (negative)     | 5    | -104500     | -522500      |
 * | l3   | 240102 | m2 (zero qty)     | 0    | 3069000     | 0            |
 * | l4   | 270101 | kg                | 120  | 299000      | 35880000     |
 * | l5   | 270320 | m3 (anchored neg) | 10   | -1037000    | -10370000    |
 * | l6   | 270403 | m3 (anchored neg) | 2    | -2131000    | -4262000     |
 * | l7   | 280101 | ton_km (compound) | 500  | 28400       | 14200000     |
 * | l8   | 280501 | ton_nautical_mile | 3    | 110700      | 332100       |
 *
 * Chapter subtotals: ch1 2367500, ch24 0, ch27 21248000, ch28 14532100 → total 38147600.
 */
export const COMPLETE_LINE_INPUTS: readonly EstimateLineInput[] = [
  { lineId: 'l1', pricebookCode: '010101', quantity: '1000', unit: 'm2' },
  { lineId: 'l2', pricebookCode: '010517', quantity: '5', unit: 'm2' },
  { lineId: 'l3', pricebookCode: '240102', quantity: '0', unit: 'm2' },
  { lineId: 'l4', pricebookCode: '270101', quantity: '120', unit: 'kg' },
  { lineId: 'l5', pricebookCode: '270320', quantity: '10', unit: 'm3' },
  { lineId: 'l6', pricebookCode: '270403', quantity: '2', unit: 'm3' },
  { lineId: 'l7', pricebookCode: '280101', quantity: '500', unit: 'ton_km' },
  { lineId: 'l8', pricebookCode: '280501', quantity: '3', unit: 'ton_nautical_mile' },
];

/** Exact expected amounts per lineId (integer Rial; exact decimal arithmetic). */
export const COMPLETE_EXPECTED_AMOUNTS: Readonly<Record<string, string>> = {
  l1: '2890000',
  l2: '-522500',
  l3: '0',
  l4: '35880000',
  l5: '-10370000',
  l6: '-4262000',
  l7: '14200000',
  l8: '332100',
};

/** Exact expected chapter subtotals (chapter → amount). */
export const COMPLETE_EXPECTED_CHAPTERS: Readonly<Record<string, string>> = {
  'chapter-1': '2367500',
  'chapter-24': '0',
  'chapter-27': '21248000',
  'chapter-28': '14532100',
};

export const COMPLETE_EXPECTED_TOTAL = '38147600';

/**
 * The BLOCKED estimate lines (all real 1404 rows): one deduction-classified row with no
 * price (220925), one blank-price row (020105) and one star-item external row (090320).
 */
export const BLOCKED_LINE_INPUTS: readonly EstimateLineInput[] = [
  { lineId: 'b1', pricebookCode: '220925', quantity: '40', unit: 'm2' },
  { lineId: 'b2', pricebookCode: '020105', quantity: '25', unit: 'm3' },
  { lineId: 'b3', pricebookCode: '090320', quantity: '80', unit: 'kg' },
];

/**
 * Golden coefficient inputs (attested by the S4 layer's own tests): floors S=7600 →
 * P = 1.0451; capital/tender-or-monopoly overhead 1.30; a single regional part with the
 * test-supplied coefficient (regional values are EXTERNAL — the number here is a test
 * input, never an implemented circular value); a project-local site-setup lump sum.
 */
export function goldenCoefficients(
  regionalCoefficient: string | null,
  regionalExecutionCost: string,
  siteSetupLumpSum: string | null,
): EstimateCoefficientInputs {
  return {
    floor: {
      buildingId: BUILDING_ID,
      groundFloorArea: '600',
      firstBasementArea: '400',
      aboveGroundFloors: [...Array.from({ length: 10 }, () => ({ area: '500' })), { area: '400' }],
      belowGroundFloors: Array.from({ length: 3 }, () => ({ area: '400' })),
      totalBuildingFloorArea: '7600',
    },
    overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
    regional: {
      parts: [
        {
          regionId: 'r-test',
          coefficient: regionalCoefficient,
          executionCost: regionalExecutionCost,
        },
      ],
    },
    siteSetup: { lumpSumAmount: siteSetupLumpSum },
  };
}

/**
 * The exact S4 chain of the COMPLETE fixture (P = 1.0451, overhead 1.30, regional 1.1,
 * site setup 12,000,000 Rial). Every value is the exact decimal product — nothing rounds.
 */
export const COMPLETE_S4_EXPECTED = {
  base: '38147600',
  afterFloor: '39868056.76',
  afterOverhead: '51828473.788',
  afterRegional: '57011321.1668',
  finalEstimate: '69011321.1668',
} as const;

/** The official 1404 source-file hash carried on every row. */
export const OFFICIAL_SOURCE_HASH =
  'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f';
