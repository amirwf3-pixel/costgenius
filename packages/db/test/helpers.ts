import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { publishStagedImport, type PublishedDataset } from '@costgenius/pricebook';
import {
  addEstimateLines,
  createEstimateForProject,
  createProject,
  finalizeEstimate,
  resolveEstimateLines,
  startEstimateVersion,
  type EstimateLineInput,
  type FinalizedEstimate,
} from '@costgenius/projects';
import type { Project } from '@costgenius/projects';
import {
  DrizzleEstimateRepository,
  DrizzleFinalizedEstimateRepository,
  DrizzleProjectRepository,
  type DbClient,
} from '../src/index.js';
import type { EstimateCoefficientInputs } from '@costgenius/projects';

/**
 * Creates a REAL PostgreSQL database in-process (PGlite — PostgreSQL compiled to WASM;
 * real numeric/jsonb/FK/transaction semantics, no server, no Docker) and applies the
 * actual versioned migrations from ../migrations through Drizzle's journal migrator.
 *
 * The `as unknown as DbClient` cast selects the static type only: the pglite driver
 * implements the same PgDatabase protocol as the production node-postgres driver, so the
 * repository code under test is exactly the production code path. Server-based
 * deployment (node-postgres against a PostgreSQL server) is exercised by
 * `createDbPool`/`createDb` in production wiring and is NOT covered by these tests.
 */
export async function createTestDb(): Promise<TestDatabase> {
  const pg = new PGlite();
  const raw = drizzle(pg);
  await migrate(raw, {
    migrationsFolder: new URL('../migrations', import.meta.url).pathname,
  });
  const db = raw as unknown as DbClient;
  return {
    pg,
    db,
    projects: new DrizzleProjectRepository(db),
    estimates: new DrizzleEstimateRepository(db),
    finalized: new DrizzleFinalizedEstimateRepository(db),
  };
}

export interface TestDatabase {
  readonly pg: PGlite;
  readonly db: DbClient;
  readonly projects: DrizzleProjectRepository;
  readonly estimates: DrizzleEstimateRepository;
  readonly finalized: DrizzleFinalizedEstimateRepository;
}

/** Loads and publishes the OFFICIAL staged 1404 dataset (1564 rows, sha256-verified). */
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
 * The COMPLETE vertical-slice lines (all real 1404 rows, exact units) — the same fixture
 * as the Phase 13 integration suite: leading zero (010101), negative prices (010517,
 * 270320, 270403), zero quantity (240102), compound units (280101 ton_km, 280501
 * ton_nautical_mile). Total 38,147,600 Rial.
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

/**
 * The BLOCKED lines (all real 1404 rows): the deduction-classified 220925, the blank
 * 020105, the star-item external 090320, and the Appendix-5 row 991001 (m2_month, no
 * printed price by design) — every null stays null through persistence.
 */
export const BLOCKED_LINE_INPUTS: readonly EstimateLineInput[] = [
  { lineId: 'b1', pricebookCode: '220925', quantity: '40', unit: 'm2' },
  { lineId: 'b2', pricebookCode: '020105', quantity: '25', unit: 'm3' },
  { lineId: 'b3', pricebookCode: '090320', quantity: '80', unit: 'kg' },
  { lineId: 'b4', pricebookCode: '991001', quantity: '600', unit: 'm2_month' },
];

/** Golden coefficient inputs (attested by the S4 layer's own tests). */
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

/** The exact S4 chain of the COMPLETE fixture (P=1.0451, overhead 1.30, regional 1.1, site 12,000,000). */
export const COMPLETE_S4_EXPECTED = {
  base: '38147600',
  afterFloor: '39868056.76',
  afterOverhead: '51828473.788',
  afterRegional: '57011321.1668',
  finalEstimate: '69011321.1668',
} as const;

export const COMPLETE_EXPECTED_TOTAL = '38147600';

/** Builds the full Phase 13 workflow result for the given lines (real dataset rows). */
export function buildFinalized(
  dataset: PublishedDataset,
  lines: readonly EstimateLineInput[],
  reportId = 'rep-db',
): { project: Project; finalized: FinalizedEstimate } {
  const project = createProject({
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    title: 'برآورد اجرایی ساختمان اداری',
    metadata: { location: 'Tehran', discipline: 'abniye' },
    createdAt: FIXED_INSTANT,
  });
  let estimate = createEstimateForProject(project, {
    estimateId: ESTIMATE_ID,
    title: 'برآورد اولیه',
  });
  estimate = startEstimateVersion(dataset, estimate, {
    createdAt: FIXED_INSTANT,
    buildingId: BUILDING_ID,
    metadata: { source: 'vertical-slice' },
  });
  const added = addEstimateLines(dataset, estimate, `${ESTIMATE_ID}-v1`, lines);
  if (!added.ok) throw new Error(`fixture lines must resolve: ${JSON.stringify(added.failures)}`);
  const finalized = finalizeEstimate(
    added.estimate,
    `${ESTIMATE_ID}-v1`,
    goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
    {
      reportId,
      generatedAt: FIXED_INSTANT,
      finalizedAt: FIXED_INSTANT,
    },
  );
  return { project, finalized };
}

/** Resolves line inputs to BOQ lines without an estimate (for direct line fixtures). */
export function resolveLines(dataset: PublishedDataset, inputs: readonly EstimateLineInput[]) {
  const result = resolveEstimateLines(dataset, inputs);
  if (!result.ok) throw new Error(`lines must resolve: ${JSON.stringify(result.failures)}`);
  return result.lines;
}

/** The official 1404 source-file hash carried on every row. */
export const OFFICIAL_SOURCE_HASH =
  'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f';
