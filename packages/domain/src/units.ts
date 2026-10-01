import { DomainError } from './errors.js';

/**
 * Generic SI / counting units used for building takeoff. This is a closed vocabulary of
 * measurement units only; it does not encode any price-book rule. Price-book editions map
 * their own unit labels onto these codes during import validation.
 *
 * The compound codes `ton_km`, `ton_nautical_mile`, `m3_km` and `m2_month` carry the printed
 * compound units of the 1404 price book (Chapter 28 transport; Chapter 3 soil haulage;
 * Appendix 5 row 991001). `dm3` carries the printed دسیمتر مکعب (cubic decimetre) of the
 * grout and mastic rows; it is deliberately NOT converted to litres. `percent` carries the
 * printed درصد rows, whose cells hold percentages, never Rial amounts. All are deliberately
 * distinct: there are no conversions, a unit mismatch is an error, and ton-kilometres are
 * never collapsed into tonnes, square-metre-months into square metres, cubic-decimetres
 * into litres, or nautical miles into kilometres.
 */
export const UNIT_CODES = [
  'm',
  'm2',
  'm3',
  'kg',
  't',
  'l',
  'each',
  'lump_sum',
  'ton_km',
  'ton_nautical_mile',
  'm2_month',
  'dm3',
  'm3_km',
  'percent',
] as const;
export type UnitCode = (typeof UNIT_CODES)[number];

const UNIT_SET: ReadonlySet<string> = new Set(UNIT_CODES);

export function isUnitCode(value: string): value is UnitCode {
  return UNIT_SET.has(value);
}

export function parseUnitCode(value: string): UnitCode {
  if (!isUnitCode(value)) throw new DomainError('UNKNOWN_UNIT', `unknown unit "${value}"`);
  return value;
}
