/**
 * Drizzle/PostgreSQL implementation of `EstimateRepository`.
 *
 * `save` persists the whole aggregate (estimate row + every version + every line) in ONE
 * transaction through the shared history-preserving `syncEstimate` (append-only lines,
 * immutable finalized versions, draft → finalized as the only transition). `findById`
 * reassembles the aggregate exactly: versions in number order, lines in insertion order,
 * IDs re-validated, everything deep-frozen. `findByVersionId` resolves the owning
 * aggregate from the version identity (Phase 15 API addressing). `findByProjectId` lists
 * a project's estimates as full aggregates in a deterministic order (Phase 17 workflow).
 */
import { asc, eq } from 'drizzle-orm';
import type { Estimate } from '@costgenius/boq';
import type { EstimateRepository } from '@costgenius/projects';
import type { DbClient } from '../client.js';
import { estimates, estimateVersions } from '../schema/index.js';
import { loadEstimate, syncEstimate } from './estimate-store.js';

export class DrizzleEstimateRepository implements EstimateRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async save(estimate: Estimate): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await syncEstimate(tx, estimate);
    });
  }

  async findById(estimateId: string): Promise<Estimate | undefined> {
    return loadEstimate(this.#db, estimateId);
  }

  async findByVersionId(versionId: string): Promise<Estimate | undefined> {
    const row = (
      await this.#db
        .select({ estimateId: estimateVersions.estimateId })
        .from(estimateVersions)
        .where(eq(estimateVersions.versionId, versionId))
    )[0];
    return row === undefined ? undefined : loadEstimate(this.#db, row.estimateId);
  }

  async findByProjectId(projectId: string): Promise<readonly Estimate[]> {
    // Deterministic order (estimate_id ascending); full aggregates via the shared loader.
    const rows = await this.#db
      .select({ estimateId: estimates.estimateId })
      .from(estimates)
      .where(eq(estimates.projectId, projectId))
      .orderBy(asc(estimates.estimateId));
    const loaded: Estimate[] = [];
    for (const row of rows) {
      const estimate = await loadEstimate(this.#db, row.estimateId);
      if (estimate !== undefined) {
        loaded.push(estimate);
      }
    }
    return loaded;
  }
}
