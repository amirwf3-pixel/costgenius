/**
 * The runtime edition-dataset resolver (P8-B S2/S3, CG-IR-PRICEBOOK-SPEC@0.2.0
 * §9/§12/§17/§18-runtime) — the DB-backed edition source of EVERY runtime dataset
 * resolution: the default search of `GET /pricebook/rows`, the edition selection of
 * version creation, and the per-version resolution of line-add and takeoff transfer.
 *
 * The persisted edition registry is authoritative: every resolution reads it fresh
 * (lifecycle commands change it at runtime — a boot-time registry would serve a stale
 * default), while the PUBLISHED DATASET of an edition is cached forever keyed by
 * `editionId` — edition content is immutable (§11), so a cache entry can never go
 * stale, and publishing (a deep freeze of 1564+ rows) happens once per edition per
 * process. On first sight of an edition the stored `contentHash` is RECOMPUTED from
 * the stored content (§5): a mismatch is a fatal deployment-integrity error — the
 * process must not serve data whose storage diverges from its identity
 * (`EDITION_CONTENT_HASH_MISMATCH`, §20: internal, never an API response).
 *
 * The 0-active state (D-PB-4 = A) resolves to `null` — the caller fails closed with
 * 409 `EDITION_NOT_ACTIVE`; there is no fallback to a latest/DRAFT/ARCHIVED edition
 * and none to the boot-time in-memory dataset (which remains the SEED artifact only).
 */
import {
  contentHashOf,
  createPublishedDataset,
  ensureSelectable,
  PricebookEditionError,
  V1_DISCIPLINE,
  type PricebookEdition,
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
    return this.#datasetOf(active);
  }

  /**
   * The published dataset of the edition with this exact id, or undefined when no such
   * edition exists — status-agnostic by design (P8-B S3): line-add and takeoff
   * transfer resolve against a version's IMMUTABLE binding whatever the edition's
   * current lifecycle state, and the binding is only ever ACTIVE or ARCHIVED because
   * `forNewVersion` (below) refuses DRAFT at creation. No substitution ever happens:
   * an unknown id is undefined, never "the active one instead".
   */
  async datasetFor(editionId: string): Promise<PublishedDataset | undefined> {
    const edition = await this.#editions.findByEditionId(editionId);
    if (edition === undefined) return undefined;
    return this.#datasetOf(edition);
  }

  /**
   * The edition binding of a NEW estimate version (P8-B S3, D-PB-3 = B, §12):
   *
   * - `editionId` omitted → the discipline's unique ACTIVE edition, resolved and read
   *   BEFORE any version mutation; the 0-active state is the deterministic
   *   `EDITION_NOT_ACTIVE` (§9 — the API owns this failure; the insert-time DB stamp
   *   is only ever a safety net, never the API's default path).
   * - `editionId` supplied → the edition must exist (`EDITION_NOT_FOUND`) and be
   *   selectable (`ensureSelectable`: ACTIVE or ARCHIVED; a DRAFT is never selectable
   *   for new work — `EDITION_NOT_SELECTABLE`). An explicit ARCHIVED selection is
   *   legal even in the 0-active state (an estimate under an existing contract prices
   *   against the contract's edition).
   *
   * Returns the resolved edition (its `editionId` is the version's immutable binding
   * and its audit record) together with ITS published dataset — `startEstimateVersion`
   * derives the version's year label from that dataset's rows, so the label can never
   * diverge from the rows the version's lines will resolve against.
   */
  async forNewVersion(editionId?: string): Promise<{
    readonly edition: PricebookEdition;
    readonly dataset: PublishedDataset;
  }> {
    const edition =
      editionId === undefined
        ? await this.#editions.findActiveByDiscipline(V1_DISCIPLINE)
        : await this.#editions.findByEditionId(editionId);
    if (edition === undefined) {
      throw editionId === undefined
        ? new PricebookEditionError(
            'EDITION_NOT_ACTIVE',
            'no ACTIVE pricebook edition exists for the discipline (the 0-active state is legal); activate an edition or select one explicitly',
          )
        : new PricebookEditionError(
            'EDITION_NOT_FOUND',
            `no pricebook edition "${editionId}" exists`,
          );
    }
    if (editionId !== undefined) {
      // Only an explicit selection is validated: the omitted path resolved the ACTIVE
      // edition by construction. DRAFT is never selectable for new work (D-PB-3 = B).
      ensureSelectable(edition);
    }
    return { edition, dataset: this.#datasetOf(edition) };
  }

  /**
   * The published dataset an EXPLICIT `GET /pricebook/rows?editionId=…` search runs
   * over (P8-B S3, §12/§17): the add-line dialog searches the workspace version's
   * edition, so suggestions must match what binding accepts — an ACTIVE or ARCHIVED
   * edition is searchable, a DRAFT never is (`EDITION_NOT_SELECTABLE`), an unknown id
   * is `EDITION_NOT_FOUND`. No substitution: the searched edition is exactly the one
   * named, and the response's `edition` field identifies it.
   */
  async searchableDataset(editionId: string): Promise<PublishedDataset> {
    const edition = await this.#editions.findByEditionId(editionId);
    if (edition === undefined) {
      throw new PricebookEditionError(
        'EDITION_NOT_FOUND',
        `no pricebook edition "${editionId}" exists`,
      );
    }
    ensureSelectable(edition);
    return this.#datasetOf(edition);
  }

  /** Publishes (once per edition per process, cached) and integrity-checks the edition. */
  #datasetOf(edition: PricebookEdition): PublishedDataset {
    const cached = this.#published.get(edition.editionId);
    if (cached !== undefined) return cached;
    if (contentHashOf(edition.content) !== edition.contentHash) {
      // §5/§20: internal fatal integrity error — never served, never an API code.
      throw new Error(
        `edition "${edition.editionId}" failed its content-hash integrity check: the stored content does not match its stored contentHash (EDITION_CONTENT_HASH_MISMATCH); refusing to serve diverged data`,
      );
    }
    const dataset = createPublishedDataset(edition.content.edition, edition.content.rows);
    this.#published.set(edition.editionId, dataset);
    return dataset;
  }
}
