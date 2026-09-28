import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BoqError } from '@costgenius/boq';
import { publishStagedImport, type PublishedDataset } from '@costgenius/pricebook';
import {
  InMemoryEstimateRepository,
  InMemoryFinalizedEstimateRepository,
  InMemoryProjectRepository,
  addEstimateLines,
  calculateEstimateVersion,
  createEstimateForProject,
  createProject,
  finalizeEstimate,
  startEstimateVersion,
} from '../src/index.js';
import {
  BUILDING_ID,
  COMPLETE_EXPECTED_AMOUNTS,
  COMPLETE_EXPECTED_TOTAL,
  COMPLETE_LINE_INPUTS,
  COMPLETE_S4_EXPECTED,
  ESTIMATE_ID,
  FIXED_INSTANT,
  PROJECT_ID,
  goldenCoefficients,
  loadPublished1404,
} from './helpers.js';

const dataset = loadPublished1404();

/**
 * A TEST-ONLY alternative dataset: the official staged file with ONE row's price changed
 * in memory (010101: 2890 → 999999). It exists purely to prove that an already-finalized
 * version never references the live dataset — it is never written anywhere.
 */
function mutatedDataset(): PublishedDataset {
  const file = JSON.parse(
    readFileSync(
      new URL('../../pricebook/data/verified-1404.staged.v0.1.0.json', import.meta.url),
      'utf8',
    ),
  ) as { rows: Array<{ code: string; basePrice: string | null }> };
  const row = file.rows.find((r) => r.code === '010101');
  if (row === undefined) throw new Error('fixture row 010101 missing');
  row.basePrice = '999999';
  return publishStagedImport(file);
}

function builtEstimate() {
  const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
  const estimate = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 't' });
  const started = startEstimateVersion(dataset, estimate, {
    createdAt: FIXED_INSTANT,
    buildingId: BUILDING_ID,
  });
  const added = addEstimateLines(dataset, started, `${ESTIMATE_ID}-v1`, COMPLETE_LINE_INPUTS);
  if (!added.ok) throw new Error('fixture lines must resolve');
  return { project, estimate: added.estimate };
}

describe('M/N. BOQ snapshot and finalized immutability', () => {
  it('a later dataset change cannot mutate an already-finalized version or its calculation', () => {
    const { estimate } = builtEstimate();
    const finalized = finalizeEstimate(
      estimate,
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-snap', generatedAt: FIXED_INSTANT, finalizedAt: FIXED_INSTANT },
    );

    // the dataset mutates afterwards (new edition of the world)
    const mutated = mutatedDataset();
    expect(mutated.getRow('010101')?.basePrice).toBe('999999');

    // the finalized bundle is untouched: lines, rollup, S4 result, report
    const frozenLines = finalized.estimate.versions[0]?.lines ?? [];
    expect(frozenLines.find((l) => l.lineId === 'l1')?.basePrice).toBe('2890');
    expect(frozenLines.find((l) => l.lineId === 'l1')?.lineAmount).toBe(
      COMPLETE_EXPECTED_AMOUNTS['l1'],
    );
    expect(finalized.calculation.rollup.amount).toBe(COMPLETE_EXPECTED_TOTAL);
    expect(finalized.calculation.s4Result.finalEstimate).toBe(COMPLETE_S4_EXPECTED.finalEstimate);
    expect(finalized.calculation.reportModel.summary.amount).toBe(COMPLETE_EXPECTED_TOTAL);

    // recalculating the finalized version against the NEW dataset changes nothing:
    // the version's lines are the snapshot, the live dataset is never consulted again
    const recalculated = calculateEstimateVersion(
      finalized.estimate,
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-snap-2' },
    );
    expect(recalculated.rollup.amount).toBe(COMPLETE_EXPECTED_TOTAL);

    // but a NEW version resolved against the mutated dataset sees the new price
    const v2 = startEstimateVersion(mutated, finalized.estimate, {
      createdAt: '2026-03-01T00:00:00Z',
      buildingId: BUILDING_ID,
    });
    const added = addEstimateLines(
      mutated,
      v2,
      `${ESTIMATE_ID}-v2`,
      COMPLETE_LINE_INPUTS.map((l) =>
        l.lineId === 'l1' ? { ...l, lineId: 'l1v2' } : { ...l, lineId: `${l.lineId}v2` },
      ),
    );
    expect(added.ok).toBe(true);
    if (added.ok) {
      expect(added.estimate.versions[1]?.lines.find((l) => l.lineId === 'l1v2')?.basePrice).toBe(
        '999999',
      );
      // v1 remains exactly as it was
      expect(added.estimate.versions[0]?.lines.find((l) => l.lineId === 'l1')?.basePrice).toBe(
        '2890',
      );
    }
  });

  it('a finalized version rejects new lines (VERSION_FINALIZED) and re-finalization', () => {
    const { estimate } = builtEstimate();
    const finalized = finalizeEstimate(
      estimate,
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-fin', generatedAt: FIXED_INSTANT, finalizedAt: FIXED_INSTANT },
    );
    expect(() =>
      addEstimateLines(dataset, finalized.estimate, `${ESTIMATE_ID}-v1`, [
        { lineId: 'late', pricebookCode: '010101', quantity: '1', unit: 'm2' },
      ]),
    ).toThrowError(BoqError);
    expect(() =>
      finalizeEstimate(
        finalized.estimate,
        `${ESTIMATE_ID}-v1`,
        goldenCoefficients('1.1', '1', '1'),
        {
          reportId: 'rep-fin2',
          finalizedAt: FIXED_INSTANT,
        },
      ),
    ).toThrowError(/already finalized/);
  });

  it('the calculation bundle and finalized estimate are deep-frozen', () => {
    const { estimate } = builtEstimate();
    const finalized = finalizeEstimate(
      estimate,
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-frozen', generatedAt: FIXED_INSTANT, finalizedAt: FIXED_INSTANT },
    );
    expect(Object.isFrozen(finalized)).toBe(true);
    expect(Object.isFrozen(finalized.calculation)).toBe(true);
    expect(Object.isFrozen(finalized.calculation.s4Result)).toBe(true);
    expect(Object.isFrozen(finalized.calculation.rollup)).toBe(true);
    expect(Object.isFrozen(finalized.calculation.reportModel)).toBe(true);
    expect(() => {
      (finalized.calculation as unknown as { rollup: { amount: string } }).rollup.amount = '0';
    }).toThrow();
  });

  it('in-memory repositories round-trip the frozen aggregates (persistence-ready contracts)', async () => {
    const { project, estimate } = builtEstimate();
    const finalized = finalizeEstimate(
      estimate,
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
      { reportId: 'rep-repo', generatedAt: FIXED_INSTANT, finalizedAt: FIXED_INSTANT },
    );
    const projects = new InMemoryProjectRepository();
    const estimates = new InMemoryEstimateRepository();
    const finalizedStore = new InMemoryFinalizedEstimateRepository();
    await projects.save(project);
    await estimates.save(finalized.estimate);
    await finalizedStore.save(finalized);

    expect(await projects.findById(PROJECT_ID)).toBe(project);
    expect((await estimates.findById(ESTIMATE_ID))?.versions[0]?.status).toBe('finalized');
    expect(await finalizedStore.byVersionId(`${ESTIMATE_ID}-v1`)).toBe(finalized);

    // a finalized version is history: a different bundle for the same versionId is refused
    const other = finalizeEstimate(
      builtEstimate().estimate,
      `${ESTIMATE_ID}-v1`,
      goldenCoefficients('1.1', '1', '1'),
      {
        reportId: 'rep-other',
        finalizedAt: FIXED_INSTANT,
      },
    );
    await expect(finalizedStore.save(other)).rejects.toThrowError(/cannot be replaced/);
  });
});
