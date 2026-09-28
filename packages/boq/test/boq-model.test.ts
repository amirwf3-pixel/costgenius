import { describe, expect, it } from 'vitest';
import { calculateQuantities } from '@costgenius/calc-engine';
import { bindBoqLine, priceBoqLine } from '@costgenius/cost-calculation';
import {
  BoqError,
  addBoqLine,
  createBoqLine,
  createEstimate,
  createEstimateVersion,
  finalizeEstimateVersion,
  getCurrentVersion,
  getVersion,
  type BoqLine,
} from '../src/index.js';
import { loadPublished1404, syntheticDataset, syntheticDatasetAltPrice } from './helpers.js';

const published = loadPublished1404();
const synthetic = syntheticDataset();

function makeLine(
  dataset: ReturnType<typeof syntheticDataset>,
  lineId: string,
  code: string,
  quantity: string,
  unit: string,
  extras?: Parameters<typeof createBoqLine>[2],
): BoqLine {
  const bound = bindBoqLine(dataset, { lineId, code, quantity, unit });
  if (!bound.ok) throw new Error(`bind failed for ${code}: ${JSON.stringify(bound.errors)}`);
  return createBoqLine(bound.line, priceBoqLine(bound.line), extras);
}

describe('estimate and versioning', () => {
  it('creates an estimate with identity and no versions', () => {
    const estimate = createEstimate({
      estimateId: 'est-1',
      projectId: 'proj-1',
      title: 'SYNTHETIC estimate',
    });
    expect(estimate.estimateId).toBe('est-1');
    expect(estimate.versions).toEqual([]);
    expect(getCurrentVersion(estimate)).toBeUndefined();
  });

  it('creates version 1 as draft, then version 2; numbers are sequential integers', () => {
    const estimate = createEstimate({ estimateId: 'est-1', projectId: 'proj-1', title: 't' });
    const v1 = createEstimateVersion(estimate, {
      createdAt: '2026-01-01T00:00:00Z',
      edition: 'SYN',
    });
    expect(getVersion(v1, 'est-1-v1').versionNumber).toBe(1);
    expect(getVersion(v1, 'est-1-v1').status).toBe('draft');
    const v2 = createEstimateVersion(v1, { createdAt: '2026-01-02T00:00:00Z', edition: 'SYN' });
    expect(getVersion(v2, 'est-1-v2').versionNumber).toBe(2);
    expect(getCurrentVersion(v2)?.versionId).toBe('est-1-v2');
    expect(Number.isInteger(getVersion(v2, 'est-1-v2').versionNumber)).toBe(true);
  });

  it('finalized versions are immutable: addBoqLine and finalize again throw; object mutation throws', () => {
    let estimate = createEstimate({ estimateId: 'est-1', projectId: 'p', title: 't' });
    estimate = createEstimateVersion(estimate, {
      createdAt: '2026-01-01T00:00:00Z',
      edition: 'SYN',
    });
    estimate = addBoqLine(estimate, 'est-1-v1', makeLine(synthetic, 'l1', '990001', '10', 'm3'));
    estimate = finalizeEstimateVersion(estimate, 'est-1-v1');
    expect(getVersion(estimate, 'est-1-v1').status).toBe('finalized');

    expect(() =>
      addBoqLine(estimate, 'est-1-v1', makeLine(synthetic, 'l2', '990002', '1', 'each')),
    ).toThrow(BoqError);
    expect(() => finalizeEstimateVersion(estimate, 'est-1-v1')).toThrow(BoqError);
    expect(() => {
      (getVersion(estimate, 'est-1-v1') as unknown as { lines: unknown[] }).lines.push({});
    }).toThrow();
  });

  it('old versions remain unchanged when a new version is edited', () => {
    let estimate = createEstimate({ estimateId: 'est-1', projectId: 'p', title: 't' });
    estimate = createEstimateVersion(estimate, {
      createdAt: '2026-01-01T00:00:00Z',
      edition: 'SYN',
    });
    estimate = addBoqLine(estimate, 'est-1-v1', makeLine(synthetic, 'l1', '990001', '10', 'm3'));
    estimate = finalizeEstimateVersion(estimate, 'est-1-v1');
    const v1Snapshot = getVersion(estimate, 'est-1-v1');

    estimate = createEstimateVersion(estimate, {
      createdAt: '2026-01-02T00:00:00Z',
      edition: 'SYN',
    });
    estimate = addBoqLine(estimate, 'est-1-v2', makeLine(synthetic, 'l2', '990002', '5', 'each'));
    estimate = addBoqLine(estimate, 'est-1-v2', makeLine(synthetic, 'l3', '990001', '7', 'm3'));

    const v1After = getVersion(estimate, 'est-1-v1');
    expect(v1After).toBe(v1Snapshot); // same frozen object, untouched
    expect(v1After.lines).toHaveLength(1);
    expect(getVersion(estimate, 'est-1-v2').lines).toHaveLength(2);
  });

  it('duplicate lineIds inside one version are rejected; unknown versions are rejected', () => {
    let estimate = createEstimate({ estimateId: 'est-1', projectId: 'p', title: 't' });
    estimate = createEstimateVersion(estimate, {
      createdAt: '2026-01-01T00:00:00Z',
      edition: 'SYN',
    });
    estimate = addBoqLine(estimate, 'est-1-v1', makeLine(synthetic, 'l1', '990001', '10', 'm3'));
    expect(() =>
      addBoqLine(estimate, 'est-1-v1', makeLine(synthetic, 'l1', '990002', '1', 'each')),
    ).toThrow(BoqError);
    expect(() =>
      addBoqLine(estimate, 'nope', makeLine(synthetic, 'l9', '990001', '1', 'm3')),
    ).toThrow(BoqError);
  });

  it('edition mixing is rejected (EDITION_MISMATCH)', () => {
    let estimate = createEstimate({ estimateId: 'est-1', projectId: 'p', title: 't' });
    estimate = createEstimateVersion(estimate, {
      createdAt: '2026-01-01T00:00:00Z',
      edition: '1404',
    });
    expect(() =>
      addBoqLine(estimate, 'est-1-v1', makeLine(synthetic, 'l1', '990001', '10', 'm3')),
    ).toThrow(BoqError);
  });
});

describe('BOQ line creation and identity', () => {
  it('creates a BOQ line from S2/S3 results and preserves exact pricebook identity', () => {
    const line = makeLine(published, 'l-280101', '280101', '12', 'ton_km');
    expect(line.pricebookCode).toBe('280101');
    expect(line.chapter).toBe('chapter-28');
    expect(line.group).toBe('1');
    expect(line.description).toContain('حمل سیمان پاکتی');
    expect(line.unit.label).toBe('تن - کیلومتر');
    expect(line.unit.code).toBe('ton_km');
    expect(line.basePrice).toBe('28400');
    expect(line.quantity).toBe('12');
    expect(line.lineAmount).toBe('340800');
    expect(line.calculationStatus).toBe('COMPLETE');
  });

  it('sourceRef, statuses and external dependencies are preserved', () => {
    const complete = makeLine(published, 'l-410202', '410202', '1', 'm3');
    expect(complete.sourceRef.printedPage).toBe('237');
    expect(complete.sourceRef.section).toBe('Appendix 1, Table 2');
    expect(complete.pricebookStatus).toBe('VERIFIED_SPEC_ONLY');
    expect(complete.edition).toBe('1404');

    const incomplete = makeLine(published, 'l-411004', '411004', '1', 'kg');
    expect(incomplete.pricebookStatus).toBe('INCOMPLETE');
    expect(incomplete.calculationStatus).toBe('INCOMPLETE');
    expect(incomplete.lineAmount).toBeNull();

    const external = makeLine(synthetic, 'l-990004', '990004', '1', 'm3');
    expect(external.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(external.lineAmount).toBeNull();
    expect(external.externalDependencies).toEqual(['regional-coefficient-circular-94-69416']);
  });

  it('pricebook-row notes are copied verbatim (the deduction classification travels with the line)', () => {
    const deduction = makeLine(published, 'l-220925', '220925', '1', 'm2');
    expect(deduction.pricebookStatus).toBe('INCOMPLETE');
    expect(deduction.lineAmount).toBeNull();
    expect(deduction.notes).toEqual([
      'The cell prints -\u06f3\u06f7\u06f7\u066c\u06f5\u06f0\u06f0 as a deduction (\u06a9\u0633\u0631 \u0628\u0647\u0627), not a price; no base price is recorded (verified specification).',
    ]);

    const plain = makeLine(published, 'l-280101', '280101', '12', 'ton_km');
    expect(plain.notes).toEqual([]);
  });

  it('mismatched S2/S3 pairs are rejected (LINE_MISMATCH)', () => {
    const boundA = bindBoqLine(synthetic, {
      lineId: 'a',
      code: '990001',
      quantity: '1',
      unit: 'm3',
    });
    const boundB = bindBoqLine(synthetic, {
      lineId: 'b',
      code: '990002',
      quantity: '1',
      unit: 'each',
    });
    if (!boundA.ok || !boundB.ok) throw new Error('bind failed');
    expect(() => createBoqLine(boundA.line, priceBoqLine(boundB.line))).toThrow(BoqError);
  });

  it('unknown pricebook codes are rejected upstream in S2 (PRICEBOOK_ROW_NOT_FOUND)', () => {
    const result = bindBoqLine(published, {
      lineId: 'l-x',
      code: '150101',
      quantity: '1',
      unit: 'm3',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe('PRICEBOOK_ROW_NOT_FOUND');
  });

  it('invalid lines cannot enter a version (INVALID_LINE with details)', () => {
    const estimate = createEstimate({ estimateId: 'e', projectId: 'p', title: 't' });
    const withLines = createEstimateVersion(estimate, {
      createdAt: '2026-01-01T00:00:00Z',
      edition: 'SYN',
      lines: [makeLine(synthetic, 'l1', '990001', '1', 'm3')],
    });
    expect(withLines.versions[0]?.lines).toHaveLength(1);

    const bad = makeLine(synthetic, 'l2', '990002', '1', 'each');
    const tampered = { ...bad, quantity: '1.2.3' } as BoqLine;
    expect(() => addBoqLine(withLines, 'e-v1', tampered)).toThrow(BoqError);
  });
});

describe('snapshot behaviour', () => {
  it('a finalized version keeps its captured base price and result when the dataset later changes', () => {
    const lineV1 = makeLine(synthetic, 'l1', '990001', '10', 'm3');
    expect(lineV1.basePrice).toBe('1000');
    expect(lineV1.lineAmount).toBe('10000');

    let estimate = createEstimate({ estimateId: 'e', projectId: 'p', title: 't' });
    estimate = createEstimateVersion(estimate, {
      createdAt: '2026-01-01T00:00:00Z',
      edition: 'SYN',
      lines: [lineV1],
    });
    estimate = finalizeEstimateVersion(estimate, 'e-v1');

    // the dataset changes (same code, different price)…
    const changed = makeLine(syntheticDatasetAltPrice(), 'l1-new', '990001', '10', 'm3');
    expect(changed.basePrice).toBe('999999');
    expect(changed.lineAmount).toBe('9999990');

    // …but the finalized version is untouched (frozen snapshot, no live lookup)
    const finalizedLine = getVersion(estimate, 'e-v1').lines[0];
    expect(finalizedLine?.basePrice).toBe('1000');
    expect(finalizedLine?.lineAmount).toBe('10000');
  });
});

describe('D-015: takeoff provenance on the line trace', () => {
  /** Real engine output for one m3 item: 2 × (3 × 2 × 0.5) = 6 m3 exactly. */
  function provenance() {
    const input = {
      items: [
        {
          itemKey: 'l-270320',
          unit: 'm3',
          lines: [
            {
              lineKey: 'l-270320',
              kind: 'addition',
              unit: 'm3',
              count: '2',
              length: '3',
              width: '2',
              height: '0.5',
            },
          ],
        },
      ],
    } as const;
    const inputItem = input.items[0];
    const result = calculateQuantities(input);
    if (result.status !== 'ok') throw new Error('the fixture must compute');
    const outputItem = result.items[0];
    if (outputItem === undefined) throw new Error('the fixture output is missing');
    return {
      input: inputItem,
      output: outputItem,
      specVersion: result.specVersion,
      engineVersion: result.engineVersion,
    };
  }

  it('persists the provenance into trace.takeoff (input, output, both versions)', () => {
    const takeoff = provenance();
    const line = makeLine(published, 'l-270320', '270320', '6', 'm3', { takeoff });
    expect(line.trace.takeoff).toEqual(takeoff); // deep copy, verbatim
    expect(line.trace.takeoff?.output.qty).toBe('6');
    expect(line.trace.takeoff?.specVersion).toBe(takeoff.specVersion);
    expect(line.trace.takeoff?.engineVersion).toBe(takeoff.engineVersion);
  });

  it('round-trips through addBoqLine into a version and back (persistence shape)', () => {
    const takeoff = provenance();
    const line = makeLine(published, 'l-270320', '270320', '6', 'm3', { takeoff });
    const estimate = createEstimate({
      estimateId: 'e-takeoff',
      projectId: 'proj-1',
      title: 'takeoff estimate',
    });
    const version = getVersion(
      finalizeEstimateVersion(
        addBoqLine(
          createEstimateVersion(estimate, { createdAt: '2026-01-01T00:00:00Z', edition: '1404' }),
          'e-takeoff-v1',
          line,
        ),
        'e-takeoff-v1',
      ),
      'e-takeoff-v1',
    );
    const stored = version.lines[0];
    expect(stored?.trace.takeoff).toEqual(takeoff);
  });

  it('guards quantity/provenance consistency with LINE_MISMATCH', () => {
    const takeoff = provenance();
    expect(() => makeLine(published, 'l-270320', '270320', '7', 'm3', { takeoff })).toThrow(
      BoqError,
    );
    try {
      makeLine(published, 'l-270320', '270320', '7', 'm3', { takeoff });
    } catch (error) {
      expect((error as BoqError).code).toBe('LINE_MISMATCH');
    }
  });

  it('lines without provenance keep the exact pre-D-015 trace shape (byte-compatibility)', () => {
    const line = makeLine(published, 'l-280101', '280101', '12', 'ton_km');
    expect('takeoff' in line.trace).toBe(false);
    expect(Object.keys(line.trace).sort()).toEqual([
      'lineAmount',
      'operation',
      'quantity',
      'unitPrice',
    ]);
  });
});
