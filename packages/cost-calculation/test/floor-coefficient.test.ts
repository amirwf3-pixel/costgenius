import { describe, expect, it } from 'vitest';
import { computeFloorCoefficient, type FloorCoefficientInput } from '../src/index.js';

const floors = (n: number, area: string): { area: string }[] =>
  Array.from({ length: n }, () => ({ area }));

/** The verified reference case of Appendix 2 (printed p240): S = 7600, weighted sum 34300, P = 1.0451. */
const goldenInput: FloorCoefficientInput = {
  buildingId: 'b-golden',
  groundFloorArea: '600',
  firstBasementArea: '400',
  aboveGroundFloors: [...floors(10, '500'), { area: '400' }],
  belowGroundFloors: floors(3, '400'),
  totalBuildingFloorArea: '7600',
};

describe('S4 floor coefficient P (Appendix 2, FLOOR-01..03)', () => {
  it('GOLDEN reference case: exact quotient 1.0451315…, rounded P = 1.0451 (4 decimals, HALF_UP)', () => {
    const outcome = computeFloorCoefficient(goldenInput);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.weightedSum).toBe('34300');
    expect(outcome.result.s).toBe('7600');
    expect(outcome.result.rawValue.startsWith('1.0451315')).toBe(true);
    expect(outcome.result.roundedValue).toBe('1.0451');
    expect(outcome.result.roundingRule).toEqual({ scale: 4, mode: 'HALF_UP' });
  });

  it('HALF_UP rounds the exact 5th-decimal .00005 up to 1.0001', () => {
    const outcome = computeFloorCoefficient({
      buildingId: 'b-up',
      groundFloorArea: '995',
      firstBasementArea: '0',
      aboveGroundFloors: [{ area: '5' }],
      belowGroundFloors: [],
      totalBuildingFloorArea: '1000',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.rawValue).toBe('1.00005');
    expect(outcome.result.roundedValue).toBe('1.0001');
  });

  it('HALF_UP drops the exact 5th-decimal .00004 down to 1.0000', () => {
    const outcome = computeFloorCoefficient({
      buildingId: 'b-down',
      groundFloorArea: '996',
      firstBasementArea: '0',
      aboveGroundFloors: [{ area: '4' }],
      belowGroundFloors: [],
      totalBuildingFloorArea: '1000',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.roundedValue).toBe('1.0000');
  });

  it('F0 and B0 carry no numerator weight but are included in S (P = 1 arises from the formula, never as a default)', () => {
    const outcome = computeFloorCoefficient({
      buildingId: 'b-flat',
      groundFloorArea: '600',
      firstBasementArea: '400',
      aboveGroundFloors: [],
      belowGroundFloors: [],
      totalBuildingFloorArea: '1000',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.weightedSum).toBe('0');
    expect(outcome.result.rawValue).toBe('1');
    expect(outcome.result.roundedValue).toBe('1.0000');
  });

  it('P is calculated per building: two buildings with different areas yield different P', () => {
    const a = computeFloorCoefficient({ ...goldenInput, buildingId: 'b-a' });
    const b = computeFloorCoefficient({
      buildingId: 'b-b',
      groundFloorArea: '1000',
      firstBasementArea: '0',
      aboveGroundFloors: [{ area: '1000' }],
      belowGroundFloors: [],
      totalBuildingFloorArea: '2000',
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.result.roundedValue).toBe('1.0451');
    expect(b.result.roundedValue).toBe('1.0050'); // 1 + (1×1000)/(100×2000) = 1.005
    expect(a.result.buildingId).toBe('b-a');
    expect(b.result.buildingId).toBe('b-b');
  });

  it('S must equal the sum of all level areas exactly', () => {
    const outcome = computeFloorCoefficient({
      ...goldenInput,
      totalBuildingFloorArea: '7500',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]?.field).toBe('totalBuildingFloorArea');
    expect(outcome.errors[0]?.message).toContain('does not equal the sum of the level areas');
  });

  it('negative areas are refused (the source specifies no negative-area rule)', () => {
    const outcome = computeFloorCoefficient({
      ...goldenInput,
      groundFloorArea: '-600',
    });
    expect(outcome.ok).toBe(false);
  });

  it('S = 0 and malformed decimals are errors', () => {
    const zero = computeFloorCoefficient({
      buildingId: 'b-zero',
      groundFloorArea: '0',
      firstBasementArea: '0',
      aboveGroundFloors: [],
      belowGroundFloors: [],
      totalBuildingFloorArea: '0',
    });
    expect(zero.ok).toBe(false);

    const malformed = computeFloorCoefficient({
      ...goldenInput,
      firstBasementArea: 'four hundred',
    });
    expect(malformed.ok).toBe(false);
  });
});
