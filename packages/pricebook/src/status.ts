/**
 * Canonical verification statuses of the CostGenius price-book data layer.
 *
 * Semantics (locked by the verified 1404 specification, sections 3, 10, 11 and 12):
 *
 * - `VERIFIED_SPEC_ONLY`: the 1404 source explicitly establishes the fact/value. It may
 *   participate in production workflows once all other required inputs exist.
 * - `EXTERNAL_DEPENDENCY`: the 1404 source explicitly points to an external source whose
 *   value is not available/verified. The value is never fabricated; a calculation depending
 *   on it stays incomplete.
 * - `NOT_SPECIFIED_IN_1404_PRICEBOOK`: the official 1404 price book does not establish the
 *   required rule/value. Nothing is inferred in its place.
 * - `INCOMPLETE`: the row exists (or is referenced) but the required source value is
 *   missing/blank/otherwise incomplete. Never replaced by zero.
 *
 * The legacy `UNRESOLVED` label of specification section 12.1 is NOT a production status.
 * It exists only for compatibility with the old specification material; this data layer
 * never generates it and rejects it on input.
 */
export const PRICEBOOK_STATUSES = [
  'VERIFIED_SPEC_ONLY',
  'EXTERNAL_DEPENDENCY',
  'NOT_SPECIFIED_IN_1404_PRICEBOOK',
  'INCOMPLETE',
] as const;

export type PricebookStatus = (typeof PRICEBOOK_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(PRICEBOOK_STATUSES);

export function isPricebookStatus(value: unknown): value is PricebookStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

/** Human-readable semantics, usable by UI/export layers without re-deriving them. */
export const STATUS_SEMANTICS: Readonly<Record<PricebookStatus, string>> = {
  VERIFIED_SPEC_ONLY:
    'established directly by the official 1404 source; usable once all other required inputs exist',
  EXTERNAL_DEPENDENCY:
    'the 1404 source names an external source; its value is not available and is never fabricated',
  NOT_SPECIFIED_IN_1404_PRICEBOOK:
    'the official 1404 price book does not specify the required rule or value; nothing is inferred',
  INCOMPLETE:
    'the required source value is missing, blank or otherwise incomplete; never treated as zero',
};
