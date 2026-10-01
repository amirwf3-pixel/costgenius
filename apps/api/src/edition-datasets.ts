/**
 * The runtime ACTIVE-edition dataset resolver (P8-B S2, CG-IR-PRICEBOOK-SPEC@0.2.0
 * §9/§17/§18-runtime) — the DB-backed default of `GET /pricebook/rows`.
 *
 * The persisted ACTIVE edition is authoritative: the resolver reads it fresh on every
 * call (lifecycle commands change it at runtime — a boot-time registry would serve a
 * stale default), while the PUBLISHED DATASET of an edition is cached forever keyed by
 * `editionId` — edition content is immutable (§11), so a cache entry can never go
 * stale, and publishing (a deep freeze of 1564+ rows) happens once per edition per
 * process. On first sight of an edition the stored `contentHash` is RECOMPUTED from
 * the stored content (§5): a mismatch is a fatal deployment-integrity error — the
 * process must not serve data whose storage diverges from its identity
 * (`EDITION_CONTENT_HASH_MISMATCH`, §20: internal, never an API response).
 *
 * The 0-active state (D-PB-4 = A) resolves to `null` — the caller fails closed with
 * 409 `EDITION_NOT_ACTIVE`; there is no fallback to a latest/DRAFT/ARCHIVED edition
 * and none to the boot-time in-memory dataset.
 */
import {
  contentHashOf,
  createPublishedDataset,
  V1_DISCIPLINE,
  type PublishedDataset,
} from '@costgenius/pricebook';
import type { PricebookEditionRepository } from '@costgenius/projects';

export class ActiveEditionDatasets {
  readonly #editions: PricebookEditionRepository;
  readonly #published = new Map<string, PublishedDataset>();

  constructor(editions: PricebookEditionRepository) {
    this.#editions = editions;
  }

  /**
   * The published dataset of the discipline's current ACTIVE edition, or null in the
   * 0-active state (§9) — deterministic, fail-closed, never a guess.
   */
  async activeDataset(): Promise<PublishedDataset | null> {
    const active = await this.#editions.findActiveByDiscipline(V1_DISCIPLINE);
    if (active === undefined) return null;
    const cached = this.#published.get(active.editionId);
    if (cached !== undefined) return cached;
    if (contentHashOf(active.content) !== active.contentHash) {
      // §5/§20: internal fatal integrity error — never served, never an API code.
      throw new Error(
        `edition "${active.editionId}" failed its content-hash integrity check: the stored content does not match its stored contentHash (EDITION_CONTENT_HASH_MISMATCH); refusing to serve diverged data`,
      );
    }
    const dataset = createPublishedDataset(active.content.edition, active.content.rows);
    this.#published.set(active.editionId, dataset);
    return dataset;
  }
}
