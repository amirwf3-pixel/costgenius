/**
 * Overhead coefficient — Application Instructions clause 2-7-2 of the 1404 price book
 * (OVERHEAD-01). The values below are the only verified construction overhead coefficients;
 * Appendix 3 is descriptive only and establishes no value. The purchases/fittings column
 * value 1.14 (OVERHEAD-02) applies to purchase chapters only — it is NOT a construction
 * overhead and is rejected for the estimate chain. The Appendix 6 equipment-only new-work
 * coefficient is printed «1/14» (NEW-03) and is re-exported verbatim; it must never be
 * normalised to 1.14.
 */
import {
  NEW_03_EQUIPMENT_ONLY_COEFFICIENT_PRINTED,
  OVERHEAD_02_PURCHASE_AND_FITTINGS_COEFFICIENT,
} from '@costgenius/pricebook';

export type PlanKind = 'capital' | 'non-capital';
export type TenderRoute = 'tender-or-monopoly' | 'waived-or-other';

/** Verified OVERHEAD-01 values (clause 2-7-2), exact as printed. */
export const VERIFIED_OVERHEAD_01_COEFFICIENTS: Readonly<
  Record<PlanKind, Readonly<Record<TenderRoute, string>>>
> = Object.freeze({
  capital: Object.freeze({
    'tender-or-monopoly': '1.30',
    'waived-or-other': '1.20',
  }),
  'non-capital': Object.freeze({
    'tender-or-monopoly': '1.41',
    'waived-or-other': '1.30',
  }),
});

/** The set of values accepted for the construction estimate chain. */
export const CONSTRUCTION_OVERHEAD_VALUES: readonly string[] = Object.freeze([
  '1.20',
  '1.30',
  '1.41',
]);

/** Re-exported single source of truth for the printed-form constants. */
export const PURCHASE_AND_FITTINGS_OVERHEAD_02 = OVERHEAD_02_PURCHASE_AND_FITTINGS_COEFFICIENT;
export const EQUIPMENT_ONLY_NEW_WORK_COEFFICIENT_PRINTED =
  NEW_03_EQUIPMENT_ONLY_COEFFICIENT_PRINTED;

/** Selects the verified overhead coefficient by plan kind and tender route (OVERHEAD-01). */
export function selectOverheadCoefficient(planKind: PlanKind, tenderRoute: TenderRoute): string {
  return VERIFIED_OVERHEAD_01_COEFFICIENTS[planKind][tenderRoute];
}

export class InvalidOverheadValueError extends Error {
  constructor(readonly value: string) {
    super(
      `"${value}" is not a verified construction overhead coefficient (clause 2-7-2: 1.20, 1.30 or 1.41); 1.14 is the purchases/fittings column only and 1/14 is the Appendix 6 equipment-only coefficient — neither is construction overhead`,
    );
    this.name = 'InvalidOverheadValueError';
  }
}

/** Guards the estimate chain against unverified overhead values. */
export function assertConstructionOverheadValue(value: string): void {
  if (!CONSTRUCTION_OVERHEAD_VALUES.includes(value)) {
    throw new InvalidOverheadValueError(value);
  }
}
