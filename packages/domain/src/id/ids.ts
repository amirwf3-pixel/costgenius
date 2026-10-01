import { DomainError } from '../errors.js';

declare const brand: unique symbol;
/** Nominal typing helper: prevents mixing e.g. ProjectId and UserId. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrganizationId = Brand<string, 'OrganizationId'>;
export type UserId = Brand<string, 'UserId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type EstimateId = Brand<string, 'EstimateId'>;
export type EstimateVersionId = Brand<string, 'EstimateVersionId'>;
export type SourceDocumentId = Brand<string, 'SourceDocumentId'>;
export type PriceBookEditionId = Brand<string, 'PriceBookEditionId'>;
export type PriceBookItemId = Brand<string, 'PriceBookItemId'>;
export type MarketPriceObservationId = Brand<string, 'MarketPriceObservationId'>;
export type MarketPriceSnapshotId = Brand<string, 'MarketPriceSnapshotId'>;
export type PriceOverrideId = Brand<string, 'PriceOverrideId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;

/** RFC 9562 UUID (any version 1–8, RFC variant), lowercase canonical form. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Validate and brand an identifier. Generation (UUIDv7) happens at the edges
 * (db/api), never in the pure domain, to keep it free of clock/randomness.
 */
export function parseId<B extends string>(value: string, kind: B): Brand<string, B> {
  if (!UUID.test(value)) throw new DomainError('INVALID_ID', `invalid ${kind}: "${value}"`);
  return value as Brand<string, B>;
}
