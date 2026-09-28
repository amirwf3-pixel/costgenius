import { describe, expect, it } from 'vitest';
import { createEstimateVersion, finalizeEstimateVersion, type Estimate } from '@costgenius/boq';
import {
  addEstimateLines,
  createEstimateForProject,
  createProject,
  startEstimateVersion,
} from '@costgenius/projects';
import { canonicalJson, DbError } from '../src/index.js';
import {
  BUILDING_ID,
  COMPLETE_LINE_INPUTS,
  ESTIMATE_ID,
  FIXED_INSTANT,
  PROJECT_ID,
  createTestDb,
  loadPublished1404,
  resolveLines,
} from './helpers.js';

const dataset = loadPublished1404();

function newEstimate(): Estimate {
  return newEstimateWithId(ESTIMATE_ID);
}

function newEstimateWithId(estimateId: string): Estimate {
  const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
  return createEstimateForProject(project, { estimateId, title: 'برآورد اولیه' });
}

describe('B/C. Estimate and version persistence', () => {
  it('an estimate cannot be persisted before its project (clear PERSISTENCE_CONFLICT)', async () => {
    const { estimates } = await createTestDb();
    const estimate = startEstimateVersion(dataset, newEstimate(), {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const error = await estimates.save(estimate).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('PERSISTENCE_CONFLICT');
    expect((error as DbError).message).toContain('persist the project first');
  });

  it('persists and reloads a draft version with its lines (canonical equality)', async () => {
    const { projects, estimates } = await createTestDb();
    let estimate = startEstimateVersion(dataset, newEstimate(), {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const added = addEstimateLines(dataset, estimate, `${ESTIMATE_ID}-v1`, COMPLETE_LINE_INPUTS);
    if (!added.ok) throw new Error('fixture must resolve');
    estimate = added.estimate;
    await projects.save(
      createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT }),
    );
    await estimates.save(estimate);

    const loaded = await estimates.findById(ESTIMATE_ID);
    expect(loaded).toBeDefined();
    expect(canonicalJson(loaded)).toBe(canonicalJson(estimate));
    expect(loaded?.versions[0]?.status).toBe('draft');
    expect(loaded?.versions[0]?.edition).toBe('1404');
    expect(loaded?.versions[0]?.buildingId).toBe(BUILDING_ID);
    expect(loaded?.projectId).toBe(PROJECT_ID);
    expect(loaded?.versions[0]?.lines).toHaveLength(8);
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it('draft lifecycle: appending lines and re-saving evolves the persisted draft (append-only)', async () => {
    const { projects, estimates } = await createTestDb();
    const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    await projects.save(project);
    let estimate = startEstimateVersion(dataset, newEstimate(), {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const first = addEstimateLines(
      dataset,
      estimate,
      `${ESTIMATE_ID}-v1`,
      COMPLETE_LINE_INPUTS.slice(0, 3),
    );
    if (!first.ok) throw new Error('must resolve');
    estimate = first.estimate;
    await estimates.save(estimate);

    const second = addEstimateLines(
      dataset,
      estimate,
      `${ESTIMATE_ID}-v1`,
      COMPLETE_LINE_INPUTS.slice(3),
    );
    if (!second.ok) throw new Error('must resolve');
    estimate = second.estimate;
    await estimates.save(estimate);

    const loaded = await estimates.findById(ESTIMATE_ID);
    expect(loaded?.versions[0]?.lines).toHaveLength(8);
    expect(canonicalJson(loaded?.versions[0]?.lines)).toBe(
      canonicalJson(estimate.versions[0]?.lines ?? []),
    );
  });

  it('presenting fewer lines than stored is a rewrite conflict (history is append-only)', async () => {
    const { projects, estimates } = await createTestDb();
    const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    await projects.save(project);
    const full = startEstimateVersion(dataset, newEstimate(), {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const added = addEstimateLines(dataset, full, `${ESTIMATE_ID}-v1`, COMPLETE_LINE_INPUTS);
    if (!added.ok) throw new Error('must resolve');
    await estimates.save(added.estimate);

    // a same-id estimate whose v1 carries only the first two lines (impossible via the domain)
    const truncated = createEstimateVersion(newEstimate(), {
      createdAt: FIXED_INSTANT,
      edition: '1404',
      buildingId: BUILDING_ID,
      versionId: `${ESTIMATE_ID}-v1`,
      lines: resolveLines(dataset, COMPLETE_LINE_INPUTS.slice(0, 2)),
    });
    const error = await estimates.save(truncated).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('PERSISTENCE_CONFLICT');
    expect((error as DbError).message).toContain('append-only');
  });

  it('version numbers stay sequential; adding v2 leaves v1 untouched', async () => {
    const { projects, estimates } = await createTestDb();
    const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    await projects.save(project);
    let estimate = startEstimateVersion(dataset, newEstimate(), {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const added = addEstimateLines(dataset, estimate, `${ESTIMATE_ID}-v1`, COMPLETE_LINE_INPUTS);
    if (!added.ok) throw new Error('must resolve');
    estimate = added.estimate;
    await estimates.save(estimate);

    estimate = startEstimateVersion(dataset, estimate, {
      createdAt: '2026-02-01T00:00:00Z',
      buildingId: BUILDING_ID,
    });
    await estimates.save(estimate);

    const loaded = await estimates.findById(ESTIMATE_ID);
    expect(loaded?.versions).toHaveLength(2);
    expect(loaded?.versions[0]?.versionNumber).toBe(1);
    expect(loaded?.versions[1]?.versionNumber).toBe(2);
    expect(loaded?.versions[0]?.versionId).toBe(`${ESTIMATE_ID}-v1`);
    expect(loaded?.versions[0]?.lines).toHaveLength(8);
    expect(loaded?.versions[1]?.lines).toHaveLength(0);
  });

  it('a finalized version reloads with status finalized (one-way transition persisted)', async () => {
    const { projects, estimates } = await createTestDb();
    const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    await projects.save(project);
    let estimate = startEstimateVersion(dataset, newEstimate(), {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const added = addEstimateLines(dataset, estimate, `${ESTIMATE_ID}-v1`, COMPLETE_LINE_INPUTS);
    if (!added.ok) throw new Error('must resolve');
    estimate = finalizeEstimateVersion(added.estimate, `${ESTIMATE_ID}-v1`);
    await estimates.save(estimate);

    const loaded = await estimates.findById(ESTIMATE_ID);
    expect(loaded?.versions[0]?.status).toBe('finalized');
    expect(canonicalJson(loaded)).toBe(canonicalJson(estimate));
  });

  it('estimate identity is immutable: a different title under the same id conflicts', async () => {
    const { projects, estimates } = await createTestDb();
    const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    await projects.save(project);
    const a = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 'اول' });
    const b = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 'دوم' });
    await estimates.save(a);
    const error = await estimates.save(b).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('PERSISTENCE_CONFLICT');
    expect((error as DbError).message).toContain('identity');
  });

  it('findById of an unknown estimate returns undefined', async () => {
    const { estimates } = await createTestDb();
    expect(await estimates.findById('no-such-estimate')).toBeUndefined();
  });

  it("findByProjectId lists a project's estimates as full aggregates in a stable order", async () => {
    const { projects, estimates } = await createTestDb();
    await projects.save(
      createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT }),
    );
    // two estimates under the same project (plus one under another project)
    const otherProjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-cccccccccccc';
    await projects.save(
      createProject({ projectId: otherProjectId, title: 'other', createdAt: FIXED_INSTANT }),
    );
    const ids = ['11111111-1111-4111-8111-111111111111', ESTIMATE_ID];
    for (const estimateId of ids) {
      const estimate = startEstimateVersion(dataset, newEstimateWithId(estimateId), {
        createdAt: FIXED_INSTANT,
        buildingId: BUILDING_ID,
      });
      await estimates.save(estimate);
    }
    const other = createEstimateForProject(
      createProject({ projectId: otherProjectId, title: 'other', createdAt: FIXED_INSTANT }),
      { estimateId: '22222222-2222-4222-8222-222222222222', title: 'elsewhere' },
    );
    await estimates.save(
      startEstimateVersion(dataset, other, {
        createdAt: FIXED_INSTANT,
        buildingId: BUILDING_ID,
      }),
    );

    const listed = await estimates.findByProjectId(PROJECT_ID);
    expect(listed.map((estimate) => estimate.estimateId)).toEqual(ids);
    expect(listed.every((estimate) => estimate.projectId === PROJECT_ID)).toBe(true);
    const reloaded = await estimates.findById(ESTIMATE_ID);
    expect(canonicalJson(listed[1])).toBe(canonicalJson(reloaded));

    expect(await estimates.findByProjectId('00000000-0000-4000-8000-000000000000')).toEqual([]);
  });

  it('findByVersionId loads the owning aggregate (draft and unknown cases)', async () => {
    const { projects, estimates } = await createTestDb();
    const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    await projects.save(project);
    const estimate = startEstimateVersion(dataset, newEstimate(), {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    await estimates.save(estimate);

    const byVersion = await estimates.findByVersionId(`${ESTIMATE_ID}-v1`);
    expect(canonicalJson(byVersion)).toBe(canonicalJson(estimate));
    expect(byVersion?.versions[0]?.versionId).toBe(`${ESTIMATE_ID}-v1`);
    expect(await estimates.findByVersionId('no-such-version')).toBeUndefined();
  });
});
