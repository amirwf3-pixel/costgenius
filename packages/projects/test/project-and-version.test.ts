import { describe, expect, it } from 'vitest';
import { createEstimateVersion, type Estimate } from '@costgenius/boq';
import { createPublishedDataset } from '@costgenius/pricebook';
import {
  addEstimateLines,
  calculateEstimateVersion,
  createEstimateForProject,
  createProject,
  currentVersionOf,
  datasetEditionOf,
  startEstimateVersion,
} from '../src/index.js';
import { InMemoryEstimateRepository } from '../src/persistence.js';
import {
  BUILDING_ID,
  COMPLETE_LINE_INPUTS,
  ESTIMATE_ID,
  FIXED_INSTANT,
  ORGANIZATION_ID,
  PROJECT_ID,
  goldenCoefficients,
  loadPublished1404,
} from './helpers.js';

const dataset = loadPublished1404();

function newEstimate(): Estimate {
  const project = createProject({
    projectId: PROJECT_ID,
    title: 'p',
    createdAt: FIXED_INSTANT,
  });
  return createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 'برآورد اولیه' });
}

describe('A. Project → Estimate → EstimateVersion', () => {
  it('creates an immutable project with validated branded identity', () => {
    const project = createProject({
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      title: 'برآورد اجرایی ساختمان اداری',
      metadata: { location: 'Tehran' },
      createdAt: FIXED_INSTANT,
    });
    expect(project.projectId).toBe(PROJECT_ID);
    expect(project.organizationId).toBe(ORGANIZATION_ID);
    expect(project.title).toBe('برآورد اجرایی ساختمان اداری');
    expect(project.metadata).toEqual({ location: 'Tehran' });
    expect(Object.isFrozen(project)).toBe(true);
    expect(Object.isFrozen(project.metadata)).toBe(true);
  });

  it('rejects an invalid projectId / organizationId (UUID-validated, injected identity)', () => {
    expect(() =>
      createProject({ projectId: 'not-a-uuid', title: 'x', createdAt: FIXED_INSTANT }),
    ).toThrowError(/invalid ProjectId/);
    expect(() =>
      createProject({
        projectId: PROJECT_ID,
        organizationId: 'also-not-a-uuid',
        title: 'x',
        createdAt: FIXED_INSTANT,
      }),
    ).toThrowError(/invalid OrganizationId/);
  });

  it('rejects an empty title and an invalid creation instant', () => {
    expect(() =>
      createProject({ projectId: PROJECT_ID, title: '', createdAt: FIXED_INSTANT }),
    ).toThrowError(/title/);
    expect(() =>
      createProject({ projectId: PROJECT_ID, title: 'x', createdAt: 'yesterday' }),
    ).toThrowError(/ISO-8601/);
  });

  it('creates an estimate under the project with no versions', () => {
    const estimate = newEstimate();
    expect(estimate.projectId).toBe(PROJECT_ID);
    expect(estimate.estimateId).toBe(ESTIMATE_ID);
    expect(estimate.versions).toHaveLength(0);
    expect(currentVersionOf(estimate)).toBeUndefined();
  });

  it('starts version 1 as a draft, edition-bound to the 1404 dataset', () => {
    const withVersion = startEstimateVersion(dataset, newEstimate(), {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const version = currentVersionOf(withVersion);
    expect(version).toBeDefined();
    expect(version?.versionNumber).toBe(1);
    expect(version?.versionId).toBe(`${ESTIMATE_ID}-v1`);
    expect(version?.status).toBe('draft');
    expect(version?.edition).toBe('1404');
    expect(version?.buildingId).toBe(BUILDING_ID);
    expect(version?.lines).toHaveLength(0);
  });

  it('adds resolved lines to a draft version; version numbers stay sequential', () => {
    let estimate = startEstimateVersion(dataset, newEstimate(), {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const added = addEstimateLines(dataset, estimate, `${ESTIMATE_ID}-v1`, COMPLETE_LINE_INPUTS);
    expect(added.ok).toBe(true);
    if (added.ok) estimate = added.estimate;
    expect(currentVersionOf(estimate)?.lines).toHaveLength(8);

    estimate = startEstimateVersion(dataset, estimate, {
      createdAt: '2026-02-01T00:00:00Z',
      buildingId: BUILDING_ID,
    });
    const v2 = currentVersionOf(estimate);
    expect(v2?.versionNumber).toBe(2);
    expect(estimate.versions).toHaveLength(2);
    expect(estimate.versions[0]?.lines).toHaveLength(8); // v1 untouched
  });

  it('datasetEditionOf derives the edition from the dataset and rejects inconsistency', () => {
    expect(datasetEditionOf(dataset)).toBe('1404');
    const sourceRef = (edition: string) => ({
      sourceDocument: 'TEST',
      edition,
      printedPage: '1',
      section: 'T',
      sourceFileHash: null,
    });
    const row = (code: string, edition: string) => ({
      code,
      chapter: 'chapter-90',
      group: '1',
      description: 'test',
      unit: { label: 'مترمکعب', code: 'm3' },
      basePrice: '1',
      status: 'VERIFIED_SPEC_ONLY',
      sourceRef: sourceRef(edition),
      externalDependencies: [],
      notes: [],
    });
    const mixed = createPublishedDataset(
      {
        id: 'mixed-test',
        title: 'MIXED TEST',
        organization: 'TEST',
        year: '1404',
        notificationNumber: null,
        notificationDate: null,
        sourceFileHash: null,
      },
      [row('900001', '1404'), row('900002', '1403')],
    );
    expect(() => datasetEditionOf(mixed)).toThrowError(/mixes editions/);
  });

  it('a version without buildingId cannot be S4-calculated (single-scope chain)', () => {
    const withoutBuilding = createEstimateVersion(newEstimate(), {
      createdAt: FIXED_INSTANT,
      edition: '1404',
    });
    expect(() =>
      calculateEstimateVersion(
        withoutBuilding,
        `${ESTIMATE_ID}-v1`,
        goldenCoefficients('1.1', '1', '1000'),
        {
          reportId: 'rep-1',
        },
      ),
    ).toThrowError(/no buildingId/);
  });
});

describe('EstimateRepository.findByProjectId (in-memory reference adapter)', () => {
  it("lists only the project's estimates; empty array for a project without any", async () => {
    const repo = new InMemoryEstimateRepository();
    const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    const other = createProject({
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-cccccccccccc',
      title: 'other',
      createdAt: FIXED_INSTANT,
    });
    const mine = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 'a' });
    const otherEstimate = createEstimateForProject(other, {
      estimateId: '22222222-2222-4222-8222-222222222222',
      title: 'b',
    });
    void repo.save(mine);
    void repo.save(otherEstimate);

    const listed = await repo.findByProjectId(PROJECT_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.estimateId).toBe(ESTIMATE_ID);
    expect(await repo.findByProjectId('00000000-0000-4000-8000-000000000000')).toEqual([]);
  });
});
