import { DomainError } from './errors.js';

/**
 * Generic SI / counting units used for building takeoff. This is a closed vocabulary of
 * measurement units only; it does not encode any price-book rule. Price-book editions map
 * their own unit labels onto these codes during import validation.
 *
 * There are deliberately no conversions: a unit mismatch is an error.
 */
export const UNIT_CODES = ['m', 'm2', 'm3', 'kg', 't', 'l', 'each', 'lump_sum'] as const;
export type UnitCode = (typeof UNIT_CODES)[number];

const UNIT_SET: ReadonlySet<string> = new Set(UNIT_CODES);

export function isUnitCode(value: string): value is UnitCode {
  return UNIT_SET.has(value);
}

export function parseUnitCode(value: string): UnitCode {
  if (!isUnitCode(value)) throw new DomainError('UNKNOWN_UNIT', `unknown unit "${value}"`);
  return value;
}
