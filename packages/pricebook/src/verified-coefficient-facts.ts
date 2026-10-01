/**
 * Verified coefficient facts, recorded as printed. These are data-layer representations of
 * specification constants — they are NOT applied by any calculation stage in this phase.
 *
 * The 1404 source prints the Appendix 6 equipment-only coefficient as «1/14», the Persian
 * slash being the printed decimal separator, and the application-instructions
 * purchases/fittings overhead as «1.14». The two constants are different rules (NEW-03 vs
 * OVERHEAD-02/GENERAL-10-01). The printed forms are preserved verbatim and are never
 * rewritten into one another: a representation that turns «1/14» into «1.14» (or vice
 * versa) destroys the printed-form provenance even though both denote the same number.
 */

/** OVERHEAD-02: overhead coefficient for purchases and fittings (application instructions clause 2-7-2), printed 1.14. */
export const OVERHEAD_02_PURCHASE_AND_FITTINGS_COEFFICIENT = '1.14';

/** NEW-03: Appendix 6 Note 1, equipment-only new work — printed 1/14 (Persian slash decimal separator). */
export const NEW_03_EQUIPMENT_ONLY_COEFFICIENT_PRINTED = '1/14';
