/**
 * Floor coefficient P — Appendix 2 of the 1404 price book (FLOOR-01..03, printed pp. 239–240).
 *
 * Verified formula: P = 1 + [(1×F1 + … + n×Fn) + (1×B1 + … + m×Bm)] / (100 × S), where
 * F0/B0 carry no numerator weight but are included in S, and S is the total building floor
 * area (F0 + B0 + all Fi + all Bj). P is computed per building; the coefficient excludes
 * landscaping items and on-site materials (that exclusion is an application-scope rule and
 * is enforced by the S4 estimate stage, not by this function). Rounding is 4 decimals,
 * half-up on the fifth decimal (FLOOR-02), applied to the exact quotient. A building with
 * no floors above F0 or below B0 yields P = 1 from the formula — never as a default.
 *
 * Input validation refuses what the source does not establish: negative areas, a missing
 * or inconsistent S, and S = 0 are errors. More than one ground level: which level is F0
 * is an input (FLOOR-01 Note 1), never inferred. Mezzanine, roof, parking, service,
 * partial floors and gross/net area bases are NOT_SPECIFIED_IN_1404_PRICEBOOK and are not
 * interpreted here — the caller supplies the areas per the approved drawings.
 */
import { Decimal, RoundingMode, canonical, roundDecimal, toDecimal } from '@costgenius/domain';

export interface FloorLevelArea {
  /** Exact decimal area of one floor level. */
  readonly area: string;
}

export interface FloorCoefficientInput {
  readonly buildingId: string;
  /** F0 — ground floor area. */
  readonly groundFloorArea: string;
  /** B0 — first basement area. */
  readonly firstBasementArea: string;
  /** F1…Fn, ordered from the first floor above the ground floor upward; ordinal = position + 1. */
  readonly aboveGroundFloors: readonly FloorLevelArea[];
  /** B1…Bm, ordered from the first floor below B0 downward; ordinal = position + 1. */
  readonly belowGroundFloors: readonly FloorLevelArea[];
  /** S — total building floor area; must equal the sum of all level areas exactly. */
  readonly totalBuildingFloorArea: string;
}

export interface FloorCoefficientResult {
  readonly buildingId: string;
  /** The exact unrounded quotient, canonical decimal string. */
  readonly rawValue: string;
  /** P rounded to 4 decimals, half-up (FLOOR-02). */
  readonly roundedValue: string;
  readonly roundingRule: { readonly scale: 4; readonly mode: 'HALF_UP' };
  readonly weightedSum: string;
  readonly s: string;
}

export interface FloorInputError {
  readonly field: string;
  readonly message: string;
}

export type FloorCoefficientOutcome =
  | { readonly ok: true; readonly result: FloorCoefficientResult }
  | { readonly ok: false; readonly errors: readonly FloorInputError[] };

const ZERO = new Decimal(0);

function parseArea(value: string, field: string, errors: FloorInputError[]): Decimal | undefined {
  let parsed: Decimal;
  try {
    parsed = toDecimal(value);
  } catch {
    errors.push({ field, message: `${field} "${value}" is not an exact decimal string` });
    return undefined;
  }
  if (parsed.isNegative()) {
    errors.push({
      field,
      message: `${field} is negative; the source specifies no negative-area rule and the input is refused`,
    });
    return undefined;
  }
  return parsed;
}

/** Computes P for one building from the verified formula. Pure; never defaults anything. */
export function computeFloorCoefficient(input: FloorCoefficientInput): FloorCoefficientOutcome {
  const errors: FloorInputError[] = [];

  const f0 = parseArea(input.groundFloorArea, 'groundFloorArea', errors);
  const b0 = parseArea(input.firstBasementArea, 'firstBasementArea', errors);
  const sInput = parseArea(input.totalBuildingFloorArea, 'totalBuildingFloorArea', errors);

  const above: Decimal[] = [];
  for (const [index, floor] of input.aboveGroundFloors.entries()) {
    const area = parseArea(floor.area, `aboveGroundFloors[${String(index)}]`, errors);
    if (area !== undefined) above.push(area);
  }
  const below: Decimal[] = [];
  for (const [index, floor] of input.belowGroundFloors.entries()) {
    const area = parseArea(floor.area, `belowGroundFloors[${String(index)}]`, errors);
    if (area !== undefined) below.push(area);
  }
  if (errors.length > 0 || f0 === undefined || b0 === undefined || sInput === undefined) {
    return { ok: false, errors };
  }

  // S must equal the sum of all level areas — the printed definition of S.
  const sComputed = above.reduce(
    (acc, a) => acc.plus(a),
    below.reduce((acc, a) => acc.plus(a), f0.plus(b0)),
  );
  if (!sComputed.eq(sInput)) {
    return {
      ok: false,
      errors: [
        {
          field: 'totalBuildingFloorArea',
          message: `totalBuildingFloorArea ${canonical(sInput)} does not equal the sum of the level areas ${canonical(sComputed)} (S = F0 + B0 + all floors above and below, per the printed definition)`,
        },
      ],
    };
  }
  if (sInput.isZero()) {
    return {
      ok: false,
      errors: [{ field: 'totalBuildingFloorArea', message: 'S is zero; the formula is undefined' }],
    };
  }

  // Weighted sum: F0 and B0 carry no weight; Fi/Bj are weighted by their ordinal from 1.
  let weightedSum = ZERO;
  for (const [index, area] of above.entries()) {
    weightedSum = weightedSum.plus(area.times(index + 1));
  }
  for (const [index, area] of below.entries()) {
    weightedSum = weightedSum.plus(area.times(index + 1));
  }

  const raw = new Decimal(1).plus(weightedSum.div(sInput.times(100)));
  // toFixed(4) keeps the verified four-decimal scale (canonical would strip trailing zeros).
  const rounded = roundDecimal(raw, { scale: 4, mode: RoundingMode.HALF_UP }).toFixed(4);

  return {
    ok: true,
    result: {
      buildingId: input.buildingId,
      rawValue: canonical(raw),
      roundedValue: rounded,
      roundingRule: { scale: 4, mode: RoundingMode.HALF_UP } as const,
      weightedSum: canonical(weightedSum),
      s: canonical(sInput),
    },
  };
}
