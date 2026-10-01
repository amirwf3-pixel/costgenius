import { describe, expect, it } from 'vitest';
import { createProject } from '@costgenius/projects';
import { DbError } from '../src/index.js';
import { FIXED_INSTANT, ORGANIZATION_ID, PROJECT_ID, createTestDb } from './helpers.js';

describe('A. Project persistence', () => {
  it('persists and reloads a project with exact identity, metadata and createdAt', async () => {
    const { projects } = await createTestDb();
    const project = createProject({
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      title: 'برآورد اجرایی ساختمان اداری',
      metadata: { location: 'Tehran', phase: '14' },
      createdAt: FIXED_INSTANT,
    });
    await projects.save(project);

    const loaded = await projects.findById(PROJECT_ID);
    expect(loaded).toBeDefined();
    expect(loaded?.projectId).toBe(PROJECT_ID);
    expect(loaded?.organizationId).toBe(ORGANIZATION_ID);
    expect(loaded?.title).toBe('برآورد اجرایی ساختمان اداری');
    expect(loaded?.metadata).toEqual({ location: 'Tehran', phase: '14' });
    expect(loaded?.createdAt).toBe(FIXED_INSTANT); // exact domain instant, no DB reformatting
    expect(loaded).toEqual(project);
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it('a project without organizationId round-trips with the field absent', async () => {
    const { projects } = await createTestDb();
    const project = createProject({
      projectId: PROJECT_ID,
      title: 'solo',
      createdAt: FIXED_INSTANT,
    });
    await projects.save(project);
    const loaded = await projects.findById(PROJECT_ID);
    expect(loaded?.organizationId).toBeUndefined();
    expect(loaded).toEqual(project);
  });

  it('re-saving the identical project is idempotent (no error, no change)', async () => {
    const { projects } = await createTestDb();
    const project = createProject({
      projectId: PROJECT_ID,
      title: 'stable',
      createdAt: FIXED_INSTANT,
    });
    await projects.save(project);
    await expect(projects.save(project)).resolves.toBeUndefined();
    expect(await projects.findById(PROJECT_ID)).toEqual(project);
  });

  it('saving different content under the same id is a stable PERSISTENCE_CONFLICT', async () => {
    const { projects } = await createTestDb();
    const project = createProject({
      projectId: PROJECT_ID,
      title: 'original',
      createdAt: FIXED_INSTANT,
    });
    await projects.save(project);
    const mutated = createProject({
      projectId: PROJECT_ID,
      title: 'rewritten',
      createdAt: FIXED_INSTANT,
    });
    const error = await projects.save(mutated).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('PERSISTENCE_CONFLICT');
    // the stored project is untouched
    expect((await projects.findById(PROJECT_ID))?.title).toBe('original');
  });

  it('list() returns every project in ascending id order; empty when none exist', async () => {
    const { projects } = await createTestDb();
    expect(await projects.list()).toEqual([]);
    await projects.save(
      createProject({
        projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        title: 'ب',
        createdAt: FIXED_INSTANT,
      }),
    );
    await projects.save(
      createProject({ projectId: PROJECT_ID, title: 'ا', createdAt: FIXED_INSTANT }),
    );
    const listed = await projects.list();
    expect(listed.map((project) => project.projectId)).toEqual([
      PROJECT_ID,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
    expect(listed.every((project) => Object.isFrozen(project))).toBe(true);
  });

  it('findById of an unknown id returns undefined', async () => {
    const { projects } = await createTestDb();
    expect(await projects.findById('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });
});
