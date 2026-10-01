import { describe, expect, it } from 'vitest';
import {
  EstimateInputError,
  VERIFIED_OVERHEAD_01_COEFFICIENTS,
  calculateEstimate,
  selectOverheadCoefficient,
  validateAdditionalSiteSetupCap,
  validateNewWorkCap,
  validateSiteSetupCap,
  type EstimateInput,
  type EstimateLine,
  type PricedBoqLine,
} from '../src/index.js';
import { bindBoqLine, priceBoqLine } from '../src/index.js';
import {
  EQUIPMENT_ONLY_NEW_WORK_COEFFICIENT_PRINTED,
  PURCHASE_AND_FITTINGS_OVERHEAD_02,
} from '../src/index.js';
import { loadPublished1404, syntheticDataset } from './helpers.js';

const synthetic = syntheticDataset();
const published = loadPublished1404();

function priced(code: string, quantity: string, unit: string): PricedBoqLine {
  const bound = bindBoqLine(synthetic, { lineId: `line-${code}`, code, quantity, unit });
  if (!bound.ok) throw new Error(`bind failed for ${code}: ${JSON.stringify(bound.errors)}`);
  return priceBoqLine(bound.line);
}

/** Base estimate: P = 1.0009 (F0 900, B0 100, one floor of 100, S 1100), overhead 1.30, regional 1.1 (synthetic), site setup 50000. */
function baseEstimate(overrides: Partial<EstimateInput> = {}): EstimateInput {
  return {
    estimateId: 'est-1',
    buildingId: 'b-1',
    floor: {
      buildingId: 'b-1',
      groundFloorArea: '900',
      firstBasementArea: '100',
      aboveGroundFloors: [{ area: '100' }],
      belowGroundFloors: [],
      totalBuildingFloorArea: '1100',
    },
    overhead: { planKind: 'capital', tenderRoute: 'tender-or-monopoly' },
    regional: { parts: [{ regionId: 'r1', coefficient: '1.1', executionCost: '1301170' }] },
    siteSetup: { lumpSumAmount: '50000' },
    lines: [{ line: priced('990001', '500', 'm3') }, { line: priced('990002', '1000', 'each') }],
    ...overrides,
  };
}

describe('S4 — estimate pipeline (FLOW-01 order)', () => {
  it('applies floor → overhead → regional successively and adds site setup, each stage traced separately', () => {
    const result = calculateEstimate(baseEstimate());
    expect(result.stages.map((s) => s.stage)).toEqual([
      'base-subtotal',
      'floor',
      'overhead',
      'regional',
      'site-setup',
    ]);
    // base 1,000,000 → ×P 1.0009 → ×overhead 1.30 → ×R 1.1 → +site setup 50,000
    const base = result.stages[0];
    const floor = result.stages[1];
    const overhead = result.stages[2];
    const regional = result.stages[3];
    const siteSetup = result.stages[4];
    expect(base?.output).toBe('1000000');
    expect(floor?.coefficient).toBe('1.0009');
    expect(floor?.input).toBe('1000000');
    expect(floor?.output).toBe('1000900');
    expect(overhead?.coefficient).toBe('1.30');
    expect(overhead?.input).toBe('1000900');
    expect(overhead?.output).toBe('1301170');
    expect(regional?.coefficient).toBe('1.1');
    expect(regional?.input).toBe('1301170');
    expect(regional?.output).toBe('1431287');
    expect(siteSetup?.input).toBe('1431287');
    expect(siteSetup?.output).toBe('1481287');
    expect(result.calculationStatus).toBe('COMPLETE');
    expect(result.finalEstimate).toBe('1481287');
    expect(result.pending).toEqual({ externalDependencies: [], incomplete: [], notSpecified: [] });
    // each stage names its verified rule and source
    expect(floor?.rule.id).toBe('IR-1404-E-FLOOR-01..03');
    expect(overhead?.rule.id).toBe('IR-1404-E-OVERHEAD-01');
    expect(regional?.rule.id).toBe('IR-1404-E-REGION-01');
    expect(siteSetup?.rule.id).toBe('IR-1404-E-SITE-01');
  });

  it('the golden floor coefficient drives the floor stage (P = 1.0451 from the verified reference case)', () => {
    const result = calculateEstimate(
      baseEstimate({
        floor: {
          buildingId: 'b-1',
          groundFloorArea: '600',
          firstBasementArea: '400',
          aboveGroundFloors: [
            { area: '500' },
            { area: '500' },
            { area: '500' },
            { area: '500' },
            { area: '500' },
            { area: '500' },
            { area: '500' },
            { area: '500' },
            { area: '500' },
            { area: '500' },
            { area: '400' },
          ],
          belowGroundFloors: [{ area: '400' }, { area: '400' }, { area: '400' }],
          totalBuildingFloorArea: '7600',
        },
      }),
    );
    expect(result.stages[1]?.coefficient).toBe('1.0451');
  });

  it('overhead: the four verified OVERHEAD-01 values select correctly', () => {
    expect(selectOverheadCoefficient('capital', 'tender-or-monopoly')).toBe('1.30');
    expect(selectOverheadCoefficient('capital', 'waived-or-other')).toBe('1.20');
    expect(selectOverheadCoefficient('non-capital', 'tender-or-monopoly')).toBe('1.41');
    expect(selectOverheadCoefficient('non-capital', 'waived-or-other')).toBe('1.30');
    expect(VERIFIED_OVERHEAD_01_COEFFICIENTS['non-capital']['waived-or-other']).toBe('1.30');
  });

  it('overhead 1.14 and 1/14 are rejected for the construction chain (they are not construction overhead)', () => {
    expect(() => calculateEstimate(baseEstimate({ overhead: { value: '1.14' } }))).toThrow(
      EstimateInputError,
    );
    expect(() => calculateEstimate(baseEstimate({ overhead: { value: '1/14' } }))).toThrow(
      EstimateInputError,
    );
    expect(() => calculateEstimate(baseEstimate({ overhead: { value: '1.35' } }))).toThrow(
      EstimateInputError,
    );
    // …while the printed-form constants remain distinct
    expect(PURCHASE_AND_FITTINGS_OVERHEAD_02).toBe('1.14');
    expect(EQUIPMENT_ONLY_NEW_WORK_COEFFICIENT_PRINTED).toBe('1/14');
    expect(PURCHASE_AND_FITTINGS_OVERHEAD_02).not.toBe(EQUIPMENT_ONLY_NEW_WORK_COEFFICIENT_PRINTED);
  });

  it('regional: multi-region R is the verified weighted formula, exactly', () => {
    const result = calculateEstimate(
      baseEstimate({
        regional: {
          parts: [
            { regionId: 'r1', coefficient: '1.2', executionCost: '100' },
            { regionId: 'r2', coefficient: '1.5', executionCost: '300' },
          ],
        },
      }),
    );
    // R = (1.2×100 + 1.5×300)/400 = 1.425
    expect(result.stages[3]?.coefficient).toBe('1.425');
    expect(result.finalEstimate).toBe('1904167.25'); // 1301170 × 1.425 = 1854167.25, plus 50000
  });

  it('regional: a missing Ri keeps the estimate EXTERNAL_DEPENDENCY; nothing is substituted', () => {
    const result = calculateEstimate(
      baseEstimate({
        regional: { parts: [{ regionId: 'r1', coefficient: null, executionCost: '1301170' }] },
      }),
    );
    expect(result.stages[3]?.status).toBe('EXTERNAL_DEPENDENCY');
    expect(result.stages[3]?.output).toBeNull();
    expect(result.stages[4]?.output).toBeNull();
    expect(result.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(result.finalEstimate).toBeNull();
    expect(result.pending.externalDependencies).toContain('regional-coefficient-circular-94-69416');
    expect(result.pending.externalDependencies.some((d) => d.includes('r1'))).toBe(true);
  });

  it('site setup: an absent lump sum keeps the estimate INCOMPLETE; zero is never substituted', () => {
    const result = calculateEstimate(baseEstimate({ siteSetup: { lumpSumAmount: null } }));
    expect(result.stages[4]?.status).toBe('INCOMPLETE');
    expect(result.stages[4]?.output).toBeNull();
    expect(result.stages[4]?.note).toContain('never defaulted to zero');
    expect(result.calculationStatus).toBe('INCOMPLETE');
    expect(result.finalEstimate).toBeNull();
    expect(result.pending.incomplete.some((i) => i.includes('site setup'))).toBe(true);
  });

  it('an INCOMPLETE line blocks the total (the estimate never looks complete)', () => {
    const lines: EstimateLine[] = [
      { line: priced('990001', '500', 'm3') },
      { line: priced('990003', '10', 'm3') },
    ];
    const result = calculateEstimate(baseEstimate({ lines }));
    expect(result.stages[0]?.status).toBe('INCOMPLETE');
    expect(result.calculationStatus).toBe('INCOMPLETE');
    expect(result.finalEstimate).toBeNull();
    expect(result.pending.incomplete.some((i) => i.includes('990003'))).toBe(true);
  });

  it('an EXTERNAL_DEPENDENCY line propagates its dependencies into the estimate pending list', () => {
    const lines: EstimateLine[] = [
      { line: priced('990001', '500', 'm3') },
      { line: priced('990004', '10', 'm3') },
    ];
    const result = calculateEstimate(baseEstimate({ lines }));
    expect(result.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(result.finalEstimate).toBeNull();
    expect(result.pending.externalDependencies).toContain('regional-coefficient-circular-94-69416');
  });

  it('landscaping lines make the estimate mixed-scope: chain halts, combined amount NOT_SPECIFIED', () => {
    const lines: EstimateLine[] = [
      { line: priced('990001', '500', 'm3') },
      { line: priced('990002', '1000', 'each'), landscaping: true },
    ];
    const result = calculateEstimate(baseEstimate({ lines }));
    // the floor stage still computes the in-scope subtotal…
    expect(result.stages[0]?.output).toBe('500000');
    expect(result.stages[0]?.note).toContain('in-scope rows only');
    expect(result.stages[1]?.coefficient).toBe('1.0009');
    expect(result.stages[1]?.output).toBe('500450');
    // …but the chain never combines out-of-scope rows
    expect(result.stages[2]?.status).toBe('NOT_SPECIFIED');
    expect(result.stages[2]?.output).toBeNull();
    expect(result.stages[3]?.status).toBe('NOT_SPECIFIED');
    expect(result.stages[4]?.status).toBe('NOT_SPECIFIED');
    expect(result.calculationStatus).toBe('NOT_SPECIFIED');
    expect(result.finalEstimate).toBeNull();
    expect(result.pending.notSpecified.some((n) => n.includes('mixed-scope'))).toBe(true);
  });

  it('Appendix 1 on-site-material rows are refused as estimate lines (ONSITE-01: interim payment only)', () => {
    const bound = bindBoqLine(published, {
      lineId: 'l-onsite',
      code: '410202',
      quantity: '10',
      unit: 'm3',
    });
    if (!bound.ok) throw new Error('bind failed');
    const line = priceBoqLine(bound.line);
    expect(() => calculateEstimate(baseEstimate({ lines: [{ line }] }))).toThrow(
      EstimateInputError,
    );
  });

  it('structural input violations throw EstimateInputError (buildingId mismatch, bad floor input)', () => {
    expect(() =>
      calculateEstimate(baseEstimate({ floor: { ...baseEstimate().floor, buildingId: 'other' } })),
    ).toThrow(EstimateInputError);
    expect(() =>
      calculateEstimate(
        baseEstimate({ floor: { ...baseEstimate().floor, totalBuildingFloorArea: '999' } }),
      ),
    ).toThrow(EstimateInputError);
  });

  it('status aggregation precedence: external > unspecified > incomplete', () => {
    const result = calculateEstimate(
      baseEstimate({
        regional: { parts: [{ regionId: 'r1', coefficient: null, executionCost: '1' }] },
        lines: [{ line: priced('990005', '10', 'm3') }],
      }),
    );
    expect(result.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(result.pending.notSpecified.length).toBeGreaterThan(0);
    expect(result.pending.externalDependencies.length).toBeGreaterThan(0);
  });
});

describe('S4 — verified cap validators (flags only, never charges)', () => {
  it('SITE-01: site setup cap of 4 percent flags without altering anything', () => {
    const atCap = validateSiteSetupCap({
      lumpSumAmount: '40000',
      estimatedExecutionCostExcludingSiteSetup: '1000000',
    });
    expect(atCap.ratio).toBe('0.04');
    expect(atCap.capExceeded).toBe(false);
    const over = validateSiteSetupCap({
      lumpSumAmount: '40001',
      estimatedExecutionCostExcludingSiteSetup: '1000000',
    });
    expect(over.capExceeded).toBe(true);
    const missing = validateSiteSetupCap({
      lumpSumAmount: null,
      estimatedExecutionCostExcludingSiteSetup: null,
    });
    expect(missing.capExceeded).toBeNull();
    expect(missing.calculationStatus).toBe('INCOMPLETE');
  });

  it('NEW-02: new-work 25 percent cap; Article 29(a) increases are a required external input', () => {
    const ok = validateNewWorkCap({
      newWorkRowsTotal: '200000',
      article29aIncreasesTotal: '50000',
      initialContractAmount: '1000000',
    });
    expect(ok.ratio).toBe('0.25');
    expect(ok.capExceeded).toBe(false);
    const over = validateNewWorkCap({
      newWorkRowsTotal: '200000',
      article29aIncreasesTotal: '50001',
      initialContractAmount: '1000000',
    });
    expect(over.ratio).toBe('0.250001');
    expect(over.capExceeded).toBe(true);
    const blocked = validateNewWorkCap({
      newWorkRowsTotal: '200000',
      article29aIncreasesTotal: null,
      initialContractAmount: '1000000',
    });
    expect(blocked.calculationStatus).toBe('INCOMPLETE');
    expect(blocked.capExceeded).toBeNull();
  });

  it('NEW-04: additional site setup cap of 25 percent of the lump sum', () => {
    const ok = validateAdditionalSiteSetupCap({
      agreedAdditionalAmount: '25000',
      siteSetupLumpSumAmount: '100000',
    });
    expect(ok.ratio).toBe('0.25');
    expect(ok.capExceeded).toBe(false);
    const over = validateAdditionalSiteSetupCap({
      agreedAdditionalAmount: '25001',
      siteSetupLumpSumAmount: '100000',
    });
    expect(over.capExceeded).toBe(true);
  });
});
