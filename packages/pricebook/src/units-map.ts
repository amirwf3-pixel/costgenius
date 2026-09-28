/**
 * Explicit mapping from printed Persian unit labels to the domain `UnitCode` vocabulary.
 *
 * The printed label is stored verbatim on every row (including the irregular spellings the
 * source prints, e.g. «کیلو گرم» with a space next to «کیلوگرم» without one); this table is
 * the only place a label becomes a code. The mapping is exact-match only: an unknown label
 * is an error, never a guess, and there are no conversions between codes — ton-kilometres,
 * ton-nautical-miles and square-metre-months stay distinct units.
 */
import { type UnitCode, isUnitCode } from '@costgenius/domain';

export interface PrintedUnitMapping {
  readonly printedLabel: string;
  readonly unitCode: UnitCode;
}

/** Labels printed by the verified 1404 source (Appendix 1 Table 2, Chapter 28, Appendix 5,
 * and the full glyph-level extraction of chapters 1–14 and 16–28; see COVERAGE-1404.md).
 * Spelling variants the source prints (کیلوگرم / کیلو گرم, مترمربع / متر مربع,
 * تن - کیلومتر / تن -  کیلومتر with a double space) map to the same code as the printed
 * form of the same unit; distinct printed units keep distinct codes. */
export const PRINTED_UNIT_MAPPINGS: readonly PrintedUnitMapping[] = Object.freeze([
  { printedLabel: 'مترمکعب', unitCode: 'm3' },
  { printedLabel: 'متر مربع', unitCode: 'm2' },
  { printedLabel: 'مترمربع', unitCode: 'm2' },
  { printedLabel: 'کیلوگرم', unitCode: 'kg' },
  { printedLabel: 'کیلو گرم', unitCode: 'kg' },
  { printedLabel: 'تن', unitCode: 't' },
  { printedLabel: 'قالب', unitCode: 'each' },
  { printedLabel: 'تن - کیلومتر', unitCode: 'ton_km' },
  { printedLabel: 'تن -  کیلومتر', unitCode: 'ton_km' },
  { printedLabel: 'تن - مایل دریایی', unitCode: 'ton_nautical_mile' },
  { printedLabel: 'مترمربع-ماه', unitCode: 'm2_month' },
  { printedLabel: 'مترطول', unitCode: 'm' },
  { printedLabel: 'متر طول', unitCode: 'm' },
  { printedLabel: 'عدد', unitCode: 'each' },
  { printedLabel: 'اصله', unitCode: 'each' },
  { printedLabel: 'دستگاه', unitCode: 'each' },
  { printedLabel: 'لنگه', unitCode: 'each' },
  { printedLabel: 'رشته', unitCode: 'each' },
  { printedLabel: 'مقطوع', unitCode: 'lump_sum' },
  { printedLabel: 'دسیمتر مکعب', unitCode: 'dm3' },
  { printedLabel: 'مترمکعب - کیلومتر', unitCode: 'm3_km' },
  { printedLabel: 'درصد', unitCode: 'percent' },
]);

const LABEL_TO_CODE: ReadonlyMap<string, UnitCode> = new Map(
  PRINTED_UNIT_MAPPINGS.map((m) => [m.printedLabel, m.unitCode]),
);

/** Exact-match lookup; `undefined` when the label is not a verified printed unit. */
export function unitCodeForPrintedLabel(printedLabel: string): UnitCode | undefined {
  return LABEL_TO_CODE.get(printedLabel);
}

/**
 * True when `label` is a verified printed label that maps to `code` and `code` is a valid
 * domain unit code. This is the consistency gate every row must pass: a row may not carry a
 * code its printed label does not map to.
 */
export function printedUnitMatches(label: unknown, code: unknown): boolean {
  if (typeof label !== 'string' || typeof code !== 'string') return false;
  if (!isUnitCode(code)) return false;
  return LABEL_TO_CODE.get(label) === code;
}

export class UnknownPrintedUnitError extends Error {
  constructor(readonly printedLabel: string) {
    super(`unknown printed unit label "${printedLabel}"; no mapping is guessed`);
    this.name = 'UnknownPrintedUnitError';
  }
}

/** Requires a verified printed label; throws rather than guessing a mapping. */
export function requireUnitCodeForPrintedLabel(printedLabel: string): UnitCode {
  const code = LABEL_TO_CODE.get(printedLabel);
  if (code === undefined) throw new UnknownPrintedUnitError(printedLabel);
  return code;
}
