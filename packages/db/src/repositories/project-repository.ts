/**
 * Drizzle/PostgreSQL implementation of `ProjectRepository`.
 *
 * `save` is transactional and idempotent by value: an absent project is inserted; a
 * re-save of the identical project is a no-op; a project presented with different content
 * under the same id is a PERSISTENCE_CONFLICT (projects have no mutation path in the
 * domain — identity and content are immutable). `findById` re-validates and re-brands the
 * UUIDs and returns a deep-frozen Project, or undefined.
 */
import { asc, eq } from 'drizzle-orm';
import type { Project, ProjectRepository } from '@costgenius/projects';
import { canonicalJson } from '../canonical-json.js';
import type { DbExecutor } from '../db-executor.js';
import { DbError } from '../errors.js';
import { projects } from '../schema/index.js';
import { projectFromRow, projectToRow } from './serialization.js';

export class DrizzleProjectRepository implements ProjectRepository {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async save(project: Project): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const row = (
        await tx.select().from(projects).where(eq(projects.projectId, project.projectId))
      )[0];
      if (row === undefined) {
        await tx.insert(projects).values(projectToRow(project));
        return;
      }
      if (canonicalJson(projectFromRow(row)) !== canonicalJson(project)) {
        throw new DbError(
          'PERSISTENCE_CONFLICT',
          `project "${project.projectId}" is already persisted with different content; projects are immutable`,
        );
      }
    });
  }

  async findById(projectId: string): Promise<Project | undefined> {
    const row = (
      await this.#db.select().from(projects).where(eq(projects.projectId, projectId))
    )[0];
    return row === undefined ? undefined : projectFromRow(row);
  }

  async list(): Promise<readonly Project[]> {
    // Deterministic order (project_id ascending) — the Phase 18 workflow UI list.
    const rows = await this.#db.select().from(projects).orderBy(asc(projects.projectId));
    return rows.map((row) => projectFromRow(row));
  }
}
