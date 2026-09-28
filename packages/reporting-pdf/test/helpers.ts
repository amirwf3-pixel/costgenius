import { readFileSync } from 'node:fs';
import {
  bindBoqLine,
  calculateEstimate,
  priceBoqLine,
  type EstimateInput,
  type EstimateResult,
  type PricedBoqLine,
} from '@costgenius/cost-calculation';
import { publishStagedImport, type PublishedDataset } from '@costgenius/pricebook';
import {
  addBoqLine,
  createBoqLine,
  createEstimate,
  createEstimateVersion,
  finalizeEstimateVersion,
  type BoqLine,
  type BoqLineExtras,
} from '@costgenius/boq';
import { buildReportModel, type ReportModel } from '@costgenius/reporting';

/**
 * Fully SYNTHETIC published dataset for renderer tests. All codes, prices, chapters and
 * statuses are fictitious test data — never official 1404 content. Edition "SYN" is
 * deliberately not the official edition.
 *
 * Coverage rows: leading-zero code (0990007), a two-dependency row (990006), all four
 * pricebook statuses, and a chapter id that sorts AFTER "chapter-99" but appears FIRST,
 * to prove ordering is first-appearance, never alphabetical.
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
      row('990006', { label: 'مترمکعب', code: 'm3' }, null, 'EXTERNAL_DEPENDENCY', {
        externalDependencies: ['regional-coefficient-circular-94-69416', 'supervision-circular'],
      }),
      // leading-zero code: '0990007' must never become 997 or 990007
      row('0990007', { label: 'مترمکعب', code: 'm3' }, '2500', 'VERIFIED_SPEC_ONLY', {
        group: '3',
      }),
      // a chapter id that sorts after "chapter-99" but is used first (anti-sort proof)
      row('990008', { label: 'متر مربع', code: 'm2' }, '100', 'VERIFIED_SPEC_ONLY', {
        chapter: 'zz-syn-chapter',
        group: '10',
      }),
      // long Persian description: exercises cell wrapping in the Lines table
      row('990009', { label: 'مترمکعب', code: 'm3' }, '10', 'VERIFIED_SPEC_ONLY', {
        chapter: 'zz-syn-chapter',
        group: '10',
        description:
          'ردیف آزمایشی با شرح فارسی بسیار طولانی برای آزمون شکستن متن در ستون شرح فهرست بها هنگام تهیه گزارش',
      }),
    ],
  };
  return publishStagedImport(file);
}

const dataset = syntheticDataset();

export function makeLineOn(
  source: PublishedDataset,
): (
  lineId: string,
  code: string,
  quantity: string,
  unit: string,
  extras?: BoqLineExtras,
) => BoqLine {
  return (lineId, code, quantity, unit, extras) => {
    const bound = bindBoqLine(source, { lineId, code, quantity, unit });
    if (!bound.ok) throw new Error(`bind failed for ${code}: ${JSON.stringify(bound.errors)}`);
    return createBoqLine(bound.line, priceBoqLine(bound.line), extras);
  };
}

export const makeLine = makeLineOn(dataset);

export interface MakeReportOptions {
  readonly estimateId?: string;
  readonly finalize?: boolean;
  readonly buildingId?: string;
  readonly generatedAt?: string;
  readonly reportId?: string;
  readonly s4Estimate?: EstimateResult;
}

/** Builds a ReportModel whose version 1 carries the given lines (draft by default). */
export function makeReport(
  lines: readonly BoqLine[],
  options: MakeReportOptions = {},
): ReportModel {
  const estimateId = options.estimateId ?? 'est-1';
  let estimate = createEstimate({
    estimateId,
    projectId: 'proj-1',
    title: 'SYNTHETIC estimate',
  });
  estimate = createEstimateVersion(estimate, {
    createdAt: '2026-01-01T00:00:00Z',
    edition: lines[0]?.edition ?? 'SYN',
    ...(options.buildingId !== undefined ? { buildingId: options.buildingId } : {}),
  });
  const versionId = `${estimateId}-v1`;
  for (const line of lines) {
    estimate = addBoqLine(estimate, versionId, line);
  }
  if (options.finalize === true) {
    estimate = finalizeEstimateVersion(estimate, versionId);
  }
  return buildReportModel({
    reportId: options.reportId ?? 'rep-1',
    estimate,
    versionId,
    ...(options.generatedAt !== undefined ? { generatedAt: options.generatedAt } : {}),
    ...(options.s4Estimate !== undefined ? { s4Estimate: options.s4Estimate } : {}),
  });
}

/**
 * The verified golden S4 case on the synthetic base (500×1000 + 1000×500 = 1,000,000):
 * golden floors S=7600 → P = 1.0451; capital/tender overhead 1.30; R = 1.1;
 * + site setup 50,000 → final estimate 1,544,493. Values attested by the S4 layer's own
 * tests — the renderer only carries them through.
 */
export function goldenS4Result(estimateId = 'est-1', buildingId = 'b-golden'): EstimateResult {
  const floors = (n: number, area: string): { area: string }[] =>
    Array.from({ length: n }, () => ({ area }));
  const input: EstimateInput = {
    estimateId,
    buildingId,
    floor: {
      buildingId,
      groundFloorArea: '600',
      firstBasementArea: '400',
      aboveGroundFloors: [...floors(10, '500'), { area: '400' }],
      belowGroundFloors: floors(3, '400'),
      totalBuildingFloorArea: '7600',
    },
    overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
    regional: { parts: [{ regionId: 'r1', coefficient: '1.1', executionCost: '1358630' }] },
    siteSetup: { lumpSumAmount: '50000' },
    lines: [
      { line: makePriced('line-990001', '990001', '500', 'm3') },
      { line: makePriced('line-990002', '990002', '1000', 'each') },
    ],
  };
  return calculateEstimate(input);
}

function makePriced(lineId: string, code: string, quantity: string, unit: string): PricedBoqLine {
  const bound = bindBoqLine(dataset, { lineId, code, quantity, unit });
  if (!bound.ok) throw new Error(`bind failed for ${code}: ${JSON.stringify(bound.errors)}`);
  return priceBoqLine(bound.line);
}

/** Loads the staged 1404 verified subset (59 real verified rows) for real-data tests. */
export function loadPublished1404(): PublishedDataset {
  const file: unknown = JSON.parse(
    readFileSync(
      new URL('../../pricebook/data/verified-1404.staged.v0.1.0.json', import.meta.url),
      'utf8',
    ),
  );
  return publishStagedImport(file);
}
