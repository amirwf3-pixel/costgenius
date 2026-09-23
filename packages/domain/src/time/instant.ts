import { type Brand } from '../id/ids.js';
import { DomainError } from '../errors.js';

/**
 * A UTC instant as canonical ISO-8601 with millisecond precision: `YYYY-MM-DDTHH:mm:ss.sssZ`.
 * Stored and compared in UTC; Jalali/Asia-Tehran rendering belongs to @costgenius/i18n.
 */
export type Instant = Brand<string, 'Instant'>;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function parseInstant(value: string): Instant {
  if (!ISO_UTC.test(value)) {
    throw new DomainError('INVALID_INSTANT', `"${value}" is not an ISO-8601 UTC timestamp`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new DomainError('INVALID_INSTANT', `"${value}" is not a valid date`);
  const normalized = new Date(ms).toISOString();
  // Reject calendar overflow such as 2026-02-30 which Date would silently roll over.
  if (normalized.slice(0, 19) !== value.slice(0, 19)) {
    throw new DomainError('INVALID_INSTANT', `"${value}" is not a valid calendar date`);
  }
  return normalized as Instant;
}

export function compareInstants(a: Instant, b: Instant): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
