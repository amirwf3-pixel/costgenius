/**
 * Drizzle/PostgreSQL implementation of `FinalizedEstimateRepository`.
 *
 * `save` persists the ENTIRE finalized bundle in one transaction: the estimate aggregate
 * (through the shared history-preserving sync, which performs the draft → finalized
 * transition and enforces line immutability) followed by the finalization record (exact
 * S4 input/result, rollup, ReportModel, finalization instant). The record is written
 * once: re-saving the identical bundle is a no-op; presenting different content for the
 * same version — a different total, a different report, a different instant — is
 * FINALIZED_ESTIMATE_IMMUTABLE. No incomplete intermediate state is ever visible: the
 * transaction commits the version status, the lines and the calculation snapshot
 * atomically.
 *
 * `byVersionId` reloads the bundle and reassembles the exact `FinalizedEstimate`
 * (estimate + calculation + finalizedAt), deep-frozen.
 */
import { eq } from 'drizzle-orm';
import type { FinalizedEstimate, FinalizedEstimateRepository } from '@costgenius/projects';
import { canonicalJson } from '../canonical-json.js';
import type { DbClient } from '../client.js';
import { DbError } from '../errors.js';
import { finalizedEstimates } from '../schema/index.js';
import { deepFreeze } from './serialization.js';
import { loadEstimate, syncEstimate } from './estimate-store.js';

export class DrizzleFinalizedEstimateRepository implements FinalizedEstimateRepository {
  readonly #db: DbClient;

  constructor(db: DbClient) {
    this.#db = db;
  }

  async save(finalized: FinalizedEstimate): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await syncEstimate(tx, finalized.estimate);

      const row = (
        await tx
          .select()
          .from(finalizedEstimates)
          .where(eq(finalizedEstimates.versionId, finalized.versionId))
      )[0];

      if (row === undefined) {
        await tx.insert(finalizedEstimates).values({
          versionId: finalized.versionId,
          estimateId: finalized.estimate.estimateId,
          finalizedAt: finalized.finalizedAt,
          s4Input: structuredClone(finalized.calculation.s4Input),
          s4Result: structuredClone(finalized.calculation.s4Result),
          rollup: structuredClone(finalized.calculation.rollup),
          reportModel: structuredClone(finalized.calculation.reportModel),
        });
        return;
      }

      const persisted = {
        finalizedAt: row.finalizedAt,
        s4Input: row.s4Input,
        s4Result: row.s4Result,
        rollup: row.rollup,
        reportModel: row.reportModel,
      };
      const incoming = {
        finalizedAt: finalized.finalizedAt,
        s4Input: finalized.calculation.s4Input,
        s4Result: finalized.calculation.s4Result,
        rollup: finalized.calculation.rollup,
        reportModel: finalized.calculation.reportModel,
      };
      if (canonicalJson(persisted) !== canonicalJson(incoming)) {
        throw new DbError(
          'FINALIZED_ESTIMATE_IMMUTABLE',
          `a finalized estimate for version "${finalized.versionId}" is already persisted with different content; finalized bundles are never rewritten`,
        );
      }
    });
  }

  async byVersionId(versionId: string): Promise<FinalizedEstimate | undefined> {
    const row = (
      await this.#db
        .select()
        .from(finalizedEstimates)
        .where(eq(finalizedEstimates.versionId, versionId))
    )[0];
    if (row === undefined) return undefined;

    const estimate = await loadEstimate(this.#db, row.estimateId);
    if (estimate === undefined) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `finalized record for version "${versionId}" references estimate "${row.estimateId}", which is not persisted; the store is inconsistent`,
      );
    }
    const version = estimate.versions.find((v) => v.versionId === versionId);
    if (version === undefined) {
      throw new DbError(
        'PERSISTENCE_CONFLICT',
        `finalized record for version "${versionId}" references a version missing from estimate "${row.estimateId}"; the store is inconsistent`,
      );
    }

    const finalized: FinalizedEstimate = {
      estimate,
      versionId,
      calculation: {
        versionId,
        versionNumber: version.versionNumber,
        s4Input: structuredClone(row.s4Input),
        s4Result: structuredClone(row.s4Result),
        rollup: structuredClone(row.rollup),
        reportModel: structuredClone(row.reportModel),
      },
      finalizedAt: row.finalizedAt,
    };
    return deepFreeze(finalized);
  }
}
