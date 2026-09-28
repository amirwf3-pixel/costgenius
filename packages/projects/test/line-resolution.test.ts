import { describe, expect, it } from 'vitest';
import { BoqError } from '@costgenius/boq';
import { publishStagedImport, type PublishedDataset } from '@costgenius/pricebook';
import {
  addEstimateLines,
  computeTakeoffQuantities,
  createEstimateForProject,
  createProject,
  resolveEstimateLines,
  startEstimateVersion,
  takeoffInputOf,
  type EstimateLineInput,
  type TakeoffQuantity,
} from '../src/index.js';
import {
  BUILDING_ID,
  ESTIMATE_ID,
  FIXED_INSTANT,
  PROJECT_ID,
  loadPublished1404,
} from './helpers.js';

const dataset = loadPublished1404();

const line = (over: Partial<EstimateLineInput>): EstimateLineInput => ({
  lineId: 't1',
  pricebookCode: '010101',
  quantity: '1',
  unit: 'm2',
  ...over,
});

describe('B/C/D/E/F/S. exact pricebook resolution', () => {
  it('resolves a real row with exact identity (code, chapter, group, description, unit, edition)', () => {
    const result = resolveEstimateLines(dataset, [
      line({ lineId: 'a', pricebookCode: '280101', quantity: '12', unit: 'ton_km' }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const l = result.lines[0];
    expect(l?.pricebookCode).toBe('280101');
    expect(l?.chapter).toBe('chapter-28');
    expect(l?.group).toBe('1');
    expect(l?.description).toContain('حمل سیمان پاکتی');
    expect(l?.unit.label).toBe('تن - کیلومتر');
    expect(l?.unit.code).toBe('ton_km');
    expect(l?.edition).toBe('1404');
    expect(l?.basePrice).toBe('28400');
    expect(l?.lineAmount).toBe('340800');
  });

  it('a missing code is a deterministic failure — no substitution of any kind', () => {
    const result = resolveEstimateLines(dataset, [line({ pricebookCode: '999999' })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.errors.map((e) => e.code)).toEqual(['PRICEBOOK_ROW_NOT_FOUND']);
    expect(result.failures[0]?.errors[0]?.message).toContain('no substitution is made');
  });

  it('leading zeros are string identity: 010101 binds, the zero-stripped 70612 does not', () => {
    const ok = resolveEstimateLines(dataset, [line({ pricebookCode: '010101' })]);
    expect(ok.ok).toBe(true);
    const stripped = resolveEstimateLines(dataset, [line({ pricebookCode: '70612', unit: 'm2' })]);
    expect(stripped.ok).toBe(false);
    if (stripped.ok) return;
    expect(stripped.failures[0]?.errors[0]?.code).toBe('PRICEBOOK_ROW_NOT_FOUND');
  });

  it('unit mismatch is explicit: ton_km never collapses to ton', () => {
    const result = resolveEstimateLines(dataset, [line({ pricebookCode: '280101', unit: 't' })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = result.failures[0]?.errors[0];
    expect(error?.code).toBe('UNIT_MISMATCH');
    expect(error?.message).toContain('ton_km');
    expect(error?.message).toContain('no conversion is applied');
  });

  it('unit mismatch: m3 against an m2 row', () => {
    const result = resolveEstimateLines(dataset, [line({ pricebookCode: '010101', unit: 'm3' })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.errors[0]?.code).toBe('UNIT_MISMATCH');
  });

  it('compound units stay exact (ton_nautical_mile, m2_month paths)', () => {
    const ok = resolveEstimateLines(dataset, [
      line({ pricebookCode: '280501', quantity: '7', unit: 'ton_nautical_mile' }),
    ]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.lines[0]?.unit.code).toBe('ton_nautical_mile');
    expect(ok.lines[0]?.lineAmount).toBe('774900'); // 7 × 110700
  });

  it('an invalid decimal quantity and an unknown unit are deterministic failures', () => {
    const badDecimal = resolveEstimateLines(dataset, [line({ quantity: '12.5.1' })]);
    expect(badDecimal.ok).toBe(false);
    if (!badDecimal.ok) {
      expect(badDecimal.failures[0]?.errors.map((e) => e.code)).toContain('INVALID_DECIMAL');
    }
    const badUnit = resolveEstimateLines(dataset, [line({ unit: 'parsec' })]);
    expect(badUnit.ok).toBe(false);
    if (!badUnit.ok) {
      expect(badUnit.failures[0]?.errors.map((e) => e.code)).toContain('UNKNOWN_UNIT');
    }
  });

  it('INCOMPLETE rows resolve but are not priceable (blank stays null, never zero)', () => {
    const result = resolveEstimateLines(dataset, [
      line({ pricebookCode: '020105', quantity: '25', unit: 'm3' }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const l = result.lines[0];
    expect(l?.pricebookStatus).toBe('INCOMPLETE');
    expect(l?.calculationStatus).toBe('INCOMPLETE');
    expect(l?.basePrice).toBeNull();
    expect(l?.lineAmount).toBeNull();
    expect(l?.trace.lineAmount).toBeNull();
  });

  it('EXTERNAL_DEPENDENCY rows resolve with their dependency and null amount', () => {
    const result = resolveEstimateLines(dataset, [
      line({ pricebookCode: '090320', quantity: '80', unit: 'kg' }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const l = result.lines[0];
    expect(l?.pricebookStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(l?.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(l?.lineAmount).toBeNull();
    expect(l?.externalDependencies).toEqual(['star-item-instruction']);
  });

  it('NOT_SPECIFIED rows stay NOT_SPECIFIED (synthetic dataset — no such row exists in 1404)', () => {
    const synthetic = syntheticNotSpecifiedDataset();
    const result = resolveEstimateLines(synthetic, [line({ pricebookCode: '990005', unit: 'm3' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0]?.calculationStatus).toBe('NOT_SPECIFIED');
    expect(result.lines[0]?.lineAmount).toBeNull();
  });

  it('addEstimateLines is all-or-nothing: one bad line blocks the batch, estimate untouched', () => {
    const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    const estimate = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 't' });
    const started = startEstimateVersion(dataset, estimate, {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const result = addEstimateLines(dataset, started, `${ESTIMATE_ID}-v1`, [
      line({ lineId: 'good', pricebookCode: '010101', quantity: '10', unit: 'm2' }),
      line({ lineId: 'bad', pricebookCode: '999999', unit: 'm2' }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.lineId).toBe('bad');
    // the estimate is unchanged: no lines were added
    const version = started.versions[0];
    expect(version?.lines).toHaveLength(0);
  });

  it('duplicate lineIds are rejected by the BOQ layer (identity is lineId, not code)', () => {
    const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
    const estimate = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 't' });
    const started = startEstimateVersion(dataset, estimate, {
      createdAt: FIXED_INSTANT,
      buildingId: BUILDING_ID,
    });
    const first = addEstimateLines(dataset, started, `${ESTIMATE_ID}-v1`, [
      line({ lineId: 'dup', quantity: '1' }),
    ]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(() =>
      addEstimateLines(dataset, first.estimate, `${ESTIMATE_ID}-v1`, [
        line({ lineId: 'dup', quantity: '2' }),
      ]),
    ).toThrowError(BoqError);
  });

  it('the same code twice is legitimate (two measurement entries, never merged)', () => {
    const result = resolveEstimateLines(dataset, [
      line({ lineId: 'm1', pricebookCode: '010101', quantity: '10' }),
      line({ lineId: 'm2', pricebookCode: '010101', quantity: '15' }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]?.lineAmount).toBe('28900');
    expect(result.lines[1]?.lineAmount).toBe('43350');
  });

  it('zero quantity is legitimate and prices to exactly 0 (blank ≠ zero preserved)', () => {
    const result = resolveEstimateLines(dataset, [
      line({ pricebookCode: '240102', quantity: '0', unit: 'm2' }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0]?.lineAmount).toBe('0');
    expect(result.lines[0]?.calculationStatus).toBe('COMPLETE');
  });

  // D-015/D2-A re-baseline (owner-approved, 2026-09): this test previously asserted that
  // a negative quantity keeps its sign through the exact product (`-10 × -1037000 =
  // 10370000`, a POSITIVE amount from two negatives). That behavior is rejected by
  // decision D2-A: a deduction is a priced کسر بها row (e.g. 010517) or the dimensional
  // engine's `kind: "deduction"` semantics — never a signed quantity. No conversion from
  // a signed quantity to a deduction was invented; the old assertion was replaced, not
  // silently deleted, and this comment records the change.
  it('rejects a negative quantity (D-015/D2-A): -10 × -1037000 is no longer reachable', () => {
    const result = resolveEstimateLines(dataset, [
      line({ pricebookCode: '270320', quantity: '-10', unit: 'm3' }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures[0]?.lineId).toBe('t1');
    expect(result.failures[0]?.errors[0]?.code).toBe('NEGATIVE_QUANTITY');
  });

  it('a deduction stays a priced کسر بها row: positive quantity × negative price (010517)', () => {
    const result = resolveEstimateLines(dataset, [
      line({ pricebookCode: '010517', quantity: '10', unit: 'm2' }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0]?.lineAmount).toBe('-1045000'); // 10 × -104500 (کسر بها)
  });
});

describe('D-015: dimensional (takeoff) lines', () => {
  /** Computes one m2 provenance: count 4 × length 2.5 × width 2 = 20 m2 exactly. */
  function provenance20(): TakeoffQuantity {
    const computed = computeTakeoffQuantities(
      takeoffInputOf([
        { itemKey: 't1', kind: 'addition', unit: 'm2', count: '4', length: '2.5', width: '2' },
      ]),
    );
    if (!computed.ok) throw new Error('the fixture must compute');
    const item = computed.items[0];
    if (item === undefined) throw new Error('the fixture item is missing');
    return item;
  }

  it('carries the S1 provenance into the line trace with the computed quantity', () => {
    const computed = provenance20();
    const result = resolveEstimateLines(dataset, [
      line({ quantity: computed.quantity, takeoff: computed.takeoff }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resolved = result.lines[0];
    expect(resolved?.quantity).toBe('20');
    expect(resolved?.trace.takeoff).toEqual(computed.takeoff); // verbatim, deep-copied
  });

  it('rejects a line whose quantity disagrees with its own provenance (LINE_MISMATCH)', () => {
    const computed = provenance20();
    expect(() =>
      resolveEstimateLines(dataset, [line({ quantity: '999', takeoff: computed.takeoff })]),
    ).toThrow(BoqError);
    try {
      resolveEstimateLines(dataset, [line({ quantity: '999', takeoff: computed.takeoff })]);
    } catch (error) {
      expect((error as BoqError).code).toBe('LINE_MISMATCH');
    }
  });

  it('manual lines stay byte-compatible: no takeoff key appears on their trace', () => {
    const result = resolveEstimateLines(dataset, [line({ quantity: '25' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('takeoff' in (result.lines[0]?.trace ?? {})).toBe(false);
  });
});

/** Synthetic dataset with one NOT_SPECIFIED row (such a row does not exist in the 1404 source). */
function syntheticNotSpecifiedDataset(): PublishedDataset {
  const file: unknown = {
    formatVersion: '1',
    kind: 'staged-import',
    edition: {
      id: 'syn-ns',
      title: 'SYNTHETIC',
      organization: 'SYNTHETIC',
      year: 'SYN',
      notificationNumber: null,
      notificationDate: null,
      sourceFileHash: null,
    },
    rows: [
      {
        code: '990005',
        chapter: 'chapter-99',
        group: '1',
        description: 'SYNTHETIC not-specified row',
        unit: { label: 'مترمکعب', code: 'm3' },
        basePrice: null,
        status: 'NOT_SPECIFIED_IN_1404_PRICEBOOK',
        sourceRef: {
          sourceDocument: 'SYNTHETIC',
          edition: 'SYN',
          printedPage: '1',
          section: 'SYN-1',
          sourceFileHash: null,
        },
        externalDependencies: [],
        notes: [],
      },
    ],
  };
  return publishStagedImport(file);
}
