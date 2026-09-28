/**
 * Validation boundaries of the verified 1404 contract — flags only, never charges.
 *
 * Every function here computes a ratio and reports whether a verified cap is exceeded. A
 * cap is never turned into an automatic cost, an automatic reduction or an automatic
 * adjustment; the caller decides what to do, and the pricebook itself names the approval
 * path (e.g. the High Technical Council for the site-setup cap in exceptional cases).
 */
import { type Decimal, canonical, toDecimal } from '@costgenius/domain';
import type { CalculationStatus } from './types.js';

function parse(value: string, field: string): Decimal {
  try {
    return toDecimal(value);
  } catch {
    throw new Error(`${field} "${value}" is not an exact decimal string`);
  }
}

/** SITE-01: the ابنیه site setup/removal maximum is 4 percent of the estimated execution cost excluding site setup (Table A / clause 2-7-1 basis). */
export const VERIFIED_SITE_SETUP_CAP_RATIO = '0.04';

/** NEW-02: new-work rows together with Article 29(a) quantity increases may not exceed 25 percent of the initial contract amount. */
export const VERIFIED_NEW_WORK_CAP_RATIO = '0.25';

/** NEW-04: additional site setup may be agreed up to 25 percent of the contract's lump-sum site setup/removal amount. */
export const VERIFIED_ADDITIONAL_SITE_SETUP_CAP_RATIO = '0.25';

export interface CapValidation {
  /** ratio = amount / base, exact, or null when it could not be computed. */
  readonly ratio: string | null;
  readonly capExceeded: boolean | null;
  readonly calculationStatus: CalculationStatus;
}

/** SITE-01 cap check. The lump sum is taken as supplied (its excluded-row composition is the caller's responsibility). */
export function validateSiteSetupCap(input: {
  readonly lumpSumAmount: string | null;
  readonly estimatedExecutionCostExcludingSiteSetup: string | null;
}): CapValidation {
  if (input.lumpSumAmount === null || input.estimatedExecutionCostExcludingSiteSetup === null) {
    return { ratio: null, capExceeded: null, calculationStatus: 'INCOMPLETE' };
  }
  const lumpSum = parse(input.lumpSumAmount, 'lumpSumAmount');
  const base = parse(
    input.estimatedExecutionCostExcludingSiteSetup,
    'estimatedExecutionCostExcludingSiteSetup',
  );
  if (base.isZero())
    throw new Error(
      'estimatedExecutionCostExcludingSiteSetup is zero; the 4 percent ratio is undefined',
    );
  const ratio = lumpSum.div(base);
  return {
    ratio: canonical(ratio),
    capExceeded: ratio.greaterThan(parse(VERIFIED_SITE_SETUP_CAP_RATIO, 'cap')),
    calculationStatus: 'COMPLETE',
  };
}

/** NEW-02 cap check. Article 29(a) increases are an external input; without them the check stays INCOMPLETE. */
export function validateNewWorkCap(input: {
  readonly newWorkRowsTotal: string | null;
  readonly article29aIncreasesTotal: string | null;
  readonly initialContractAmount: string | null;
}): CapValidation {
  if (
    input.newWorkRowsTotal === null ||
    input.article29aIncreasesTotal === null ||
    input.initialContractAmount === null
  ) {
    return { ratio: null, capExceeded: null, calculationStatus: 'INCOMPLETE' };
  }
  const rows = parse(input.newWorkRowsTotal, 'newWorkRowsTotal');
  const increases = parse(input.article29aIncreasesTotal, 'article29aIncreasesTotal');
  const contract = parse(input.initialContractAmount, 'initialContractAmount');
  if (contract.isZero())
    throw new Error('initialContractAmount is zero; the 25 percent ratio is undefined');
  const ratio = rows.plus(increases).div(contract);
  return {
    ratio: canonical(ratio),
    capExceeded: ratio.greaterThan(parse(VERIFIED_NEW_WORK_CAP_RATIO, 'cap')),
    calculationStatus: 'COMPLETE',
  };
}

/** NEW-04 cap check for additional site setup agreed for new works. */
export function validateAdditionalSiteSetupCap(input: {
  readonly agreedAdditionalAmount: string | null;
  readonly siteSetupLumpSumAmount: string | null;
}): CapValidation {
  if (input.agreedAdditionalAmount === null || input.siteSetupLumpSumAmount === null) {
    return { ratio: null, capExceeded: null, calculationStatus: 'INCOMPLETE' };
  }
  const additional = parse(input.agreedAdditionalAmount, 'agreedAdditionalAmount');
  const lumpSum = parse(input.siteSetupLumpSumAmount, 'siteSetupLumpSumAmount');
  if (lumpSum.isZero())
    throw new Error('siteSetupLumpSumAmount is zero; the 25 percent ratio is undefined');
  const ratio = additional.div(lumpSum);
  return {
    ratio: canonical(ratio),
    capExceeded: ratio.greaterThan(parse(VERIFIED_ADDITIONAL_SITE_SETUP_CAP_RATIO, 'cap')),
    calculationStatus: 'COMPLETE',
  };
}
