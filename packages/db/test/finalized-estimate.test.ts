import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEstimateVersion, finalizeEstimateVersion, type Estimate } from '@costgenius/boq';
import {
  addEstimateLines,
  createEstimateForProject,
  createProject,
  finalizeEstimate,
  startEstimateVersion,
} from '@costgenius/projects';
import { publishStagedImport, type PublishedDataset } from '@costgenius/pricebook';
import { canonicalJson, DbError } from '../src/index.js';
import {
  BLOCKED_LINE_INPUTS,
  BUILDING_ID,
  COMPLETE_EXPECTED_TOTAL,
  COMPLETE_LINE_INPUTS,
  COMPLETE_S4_EXPECTED,
  ESTIMATE_ID,
  FIXED_INSTANT,
  PROJECT_ID,
  buildFinalized,
  createTestDb,
  loadPublished1404,
  resolveLines,
} from './helpers.js';

const dataset = loadPublished1404();

/** TEST-ONLY mutated dataset: the official staged file with 010101's price changed in memory. */
function mutatedDataset(): PublishedDataset {
  const file = JSON.parse(
    readFileSync(
      new URL('../../pricebook/data/verified-1404.staged.v0.1.0.json', import.meta.url),
      'utf8',
    ),
  ) as { rows: Array<{ code: string; basePrice: string | null }> };
  const row = file.rows.find((r) => r.code === '010101');
  if (row === undefined) throw new Error('fixture row missing');
  row.basePrice = '999999';
  return publishStagedImport(file);
}

describe('I. finalized-estimate persistence', () => {
  it('persist → reload → exact snapshot equality of the ENTIRE bundle', async () => {
    const { projects, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(dataset, COMPLETE_LINE_INPUTS, 'rep-final');
    await projects.save(project);
    await finalizedRepo.save(finalized);

    const loaded = await finalizedRepo.byVersionId(`${ESTIMATE_ID}-v1`);
    expect(loaded).toBeDefined();
    expect(canonicalJson(loaded)).toBe(canonicalJson(finalized));
    expect(loaded?.estimate.versions[0]?.status).toBe('finalized');
    expect(loaded?.finalizedAt).toBe(FIXED_INSTANT);
    expect(loaded?.calculation.versionNumber).toBe(1);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.calculation.reportModel)).toBe(true);
  });

  it('the exact coefficient chain and totals survive the round-trip as exact strings', async () => {
    const { projects, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(dataset, COMPLETE_LINE_INPUTS);
    await projects.save(project);
    await finalizedRepo.save(finalized);
    const loaded = await finalizedRepo.byVersionId(`${ESTIMATE_ID}-v1`);

    const stages = loaded?.calculation.s4Result.stages ?? [];
    expect(stages.find((s) => s.stage === 'base-subtotal')?.output).toBe(COMPLETE_S4_EXPECTED.base);
    expect(stages.find((s) => s.stage === 'floor')?.coefficient).toBe('1.0451');
    expect(stages.find((s) => s.stage === 'floor')?.output).toBe(COMPLETE_S4_EXPECTED.afterFloor);
    expect(stages.find((s) => s.stage === 'overhead')?.coefficient).toBe('1.30');
    expect(stages.find((s) => s.stage === 'overhead')?.output).toBe(
      COMPLETE_S4_EXPECTED.afterOverhead,
    );
    expect(stages.find((s) => s.stage === 'regional')?.coefficient).toBe('1.1');
    expect(stages.find((s) => s.stage === 'regional')?.output).toBe(
      COMPLETE_S4_EXPECTED.afterRegional,
    );
    expect(stages.find((s) => s.stage === 'site-setup')?.output).toBe(
      COMPLETE_S4_EXPECTED.finalEstimate,
    );
    expect(loaded?.calculation.s4Result.finalEstimate).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
    expect(loaded?.calculation.rollup.amount).toBe(COMPLETE_EXPECTED_TOTAL);
    expect(loaded?.calculation.reportModel.summary.amount).toBe(COMPLETE_EXPECTED_TOTAL);
  });

  it('a blocked finalized bundle persists with null totals and honest statuses', async () => {
    const { projects, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(
      dataset,
      [...COMPLETE_LINE_INPUTS, ...BLOCKED_LINE_INPUTS],
      'rep-blocked-final',
    );
    await projects.save(project);
    await finalizedRepo.save(finalized);
    const loaded = await finalizedRepo.byVersionId(`${ESTIMATE_ID}-v1`);
    expect(loaded?.calculation.s4Result.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(loaded?.calculation.s4Result.finalEstimate).toBeNull();
    expect(loaded?.calculation.rollup.amount).toBeNull();
    expect(loaded?.calculation.reportModel.summary.amount).toBeNull();
  });

  it('re-saving the identical bundle is idempotent', async () => {
    const { projects, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(dataset, COMPLETE_LINE_INPUTS);
    await projects.save(project);
    await finalizedRepo.save(finalized);
    await expect(finalizedRepo.save(finalized)).resolves.toBeUndefined();
  });

  it('saving DIFFERENT content for the same version is FINALIZED_ESTIMATE_IMMUTABLE', async () => {
    const { projects, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(dataset, COMPLETE_LINE_INPUTS);
    await projects.save(project);
    await finalizedRepo.save(finalized);

    // a DIFFERENT finalization of the same version: fresh draft, different site setup
    const project2 = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    let draft = createEstimateForProject(project2, {
      estimateId: ESTIMATE_ID,
      title: 'برآورد اولیه',
    });
    draft = startEstimateVersion(dataset, draft, {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const added = addEstimateLines(dataset, draft, `${ESTIMATE_ID}-v1`, COMPLETE_LINE_INPUTS);
    if (!added.ok) throw new Error('must resolve');
    const otherFinalized = finalizeEstimate(
      added.estimate,
      `${ESTIMATE_ID}-v1`,
      { ...finalized.calculation.s4Input, siteSetup: { lumpSumAmount: '999999999' } },
      { reportId: 'rep-other', finalizedAt: FIXED_INSTANT },
    );
    const error = await finalizedRepo.save(otherFinalized).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('FINALIZED_ESTIMATE_IMMUTABLE');
    // and the persisted bundle is untouched
    const reloaded = await finalizedRepo.byVersionId(`${ESTIMATE_ID}-v1`);
    expect(canonicalJson(reloaded)).toBe(canonicalJson(finalized));
  });

  it('rewriting a finalized version through the estimate repository is refused', async () => {
    const { projects, estimates, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(dataset, COMPLETE_LINE_INPUTS);
    await projects.save(project);
    await finalizedRepo.save(finalized);

    // same ids, same versionId, finalized, but different lines (impossible via the domain)
    const project2 = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    const estimate2 = createEstimateForProject(project2, {
      estimateId: ESTIMATE_ID,
      title: 'برآورد اولیه',
    });
    const withVersion = createEstimateVersion(estimate2, {
      createdAt: FIXED_INSTANT,
      edition: '1404',
      buildingId: BUILDING_ID,
      versionId: `${ESTIMATE_ID}-v1`,
      lines: resolveLines(dataset, COMPLETE_LINE_INPUTS.slice(0, 4)),
    });
    const tampered = finalizeEstimateVersion(withVersion, `${ESTIMATE_ID}-v1`);
    const error = await estimates.save(tampered).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('FINALIZED_ESTIMATE_IMMUTABLE');
  });

  it('downgrading a finalized version back to draft is refused', async () => {
    const { projects, estimates, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(dataset, COMPLETE_LINE_INPUTS);
    await projects.save(project);
    await finalizedRepo.save(finalized);

    const project2 = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    const estimate2 = createEstimateForProject(project2, {
      estimateId: ESTIMATE_ID,
      title: 'برآورد اولیه',
    });
    const asDraft = createEstimateVersion(estimate2, {
      createdAt: FIXED_INSTANT,
      edition: '1404',
      buildingId: BUILDING_ID,
      versionId: `${ESTIMATE_ID}-v1`,
      lines: resolveLines(dataset, COMPLETE_LINE_INPUTS),
    });
    const error = await estimates.save(asDraft).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('FINALIZED_ESTIMATE_IMMUTABLE');
    expect((error as DbError).message).toContain('never rewritten');
  });

  it('byVersionId of an unknown version returns undefined', async () => {
    const { finalized: finalizedRepo } = await createTestDb();
    expect(await finalizedRepo.byVersionId('never-finalized')).toBeUndefined();
  });
});

describe('J. dataset mutation after finalization cannot change history', () => {
  it('a later dataset edition leaves the persisted finalized snapshot byte-identical', async () => {
    const { projects, estimates, finalized: finalizedRepo } = await createTestDb();
    const { project, finalized } = buildFinalized(dataset, COMPLETE_LINE_INPUTS, 'rep-history');
    await projects.save(project);
    await finalizedRepo.save(finalized);

    // the dataset "changes" afterwards (v2 resolves 010101 at a different price)
    const mutated = mutatedDataset();
    expect(mutated.getRow('010101')?.basePrice).toBe('999999');

    let estimate: Estimate = finalized.estimate;
    estimate = startEstimateVersion(mutated, estimate, {
      createdAt: '2026-03-01T00:00:00Z',
      buildingId: BUILDING_ID,
    });
    const added = addEstimateLines(
      mutated,
      estimate,
      `${ESTIMATE_ID}-v2`,
      COMPLETE_LINE_INPUTS.map((l) => ({ ...l, lineId: `${l.lineId}-v2` })),
    );
    if (!added.ok) throw new Error('v2 must resolve');
    await estimates.save(added.estimate);

    // v2 sees the new price; v1's finalized snapshot is untouched
    const loadedEstimate = await estimates.findById(ESTIMATE_ID);
    expect(loadedEstimate?.versions[1]?.lines.find((l) => l.lineId === 'l1-v2')?.basePrice).toBe(
      '999999',
    );
    const v1Lines = loadedEstimate?.versions[0]?.lines ?? [];
    expect(v1Lines.find((l) => l.lineId === 'l1')?.basePrice).toBe('2890');
    expect(v1Lines.find((l) => l.lineId === 'l1')?.lineAmount).toBe('2890000');

    // the finalized HISTORY is byte-identical: the calculation snapshot, the finalization
    // instant, and the v1 version content (the reloaded aggregate also carries the later
    // append-only v2 — history is never rewritten, only extended)
    const reloaded = await finalizedRepo.byVersionId(`${ESTIMATE_ID}-v1`);
    expect(reloaded).toBeDefined();
    expect(canonicalJson(reloaded?.calculation)).toBe(canonicalJson(finalized.calculation));
    expect(reloaded?.finalizedAt).toBe(finalized.finalizedAt);
    const reloadedV1 = reloaded?.estimate.versions.find((v) => v.versionId === `${ESTIMATE_ID}-v1`);
    expect(canonicalJson(reloadedV1)).toBe(
      canonicalJson(finalized.estimate.versions.find((v) => v.versionId === `${ESTIMATE_ID}-v1`)),
    );
    expect(reloaded?.calculation.rollup.amount).toBe(COMPLETE_EXPECTED_TOTAL);
    expect(reloaded?.calculation.reportModel.summary.amount).toBe(COMPLETE_EXPECTED_TOTAL);
    expect(reloaded?.calculation.s4Result.finalEstimate).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
    expect(reloaded?.estimate.versions).toHaveLength(2); // v1 (finalized, untouched) + v2
  });
});
