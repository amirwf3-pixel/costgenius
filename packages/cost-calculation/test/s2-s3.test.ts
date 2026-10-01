import { describe, expect, it } from 'vitest';
import {
  bindBoqLine,
  bindBoqLines,
  priceBoqLine,
  sumPricedLines,
  type BoundBoqLine,
} from '../src/index.js';
import { loadPublished1404, syntheticDataset } from './helpers.js';

const published = loadPublished1404();
const synthetic = syntheticDataset();

function bindOrThrow(
  dataset: ReturnType<typeof loadPublished1404>,
  code: string,
  quantity: string,
  unit: string,
  lineId = `line-${code}`,
): BoundBoqLine {
  const result = bindBoqLine(dataset, { lineId, code, quantity, unit });
  if (!result.ok) throw new Error(`binding failed: ${JSON.stringify(result.errors)}`);
  return result.line;
}

describe('S2 — BOQ / pricebook row binding', () => {
  it('binds by exact code and preserves the complete row identity', () => {
    const line = bindOrThrow(published, '410202', '10', 'm3');
    expect(line.pricebookRow.code).toBe('410202');
    expect(line.pricebookRow.chapter).toBe('appendix-1');
    expect(line.pricebookRow.group).toBe('table-2');
    expect(line.pricebookRow.description).toBe('ماسه شسته.');
    expect(line.pricebookRow.unit.label).toBe('مترمکعب');
    expect(line.pricebookRow.unit.code).toBe('m3');
    expect(line.pricebookRow.basePrice).toBe('5591000');
    expect(line.status).toBe('VERIFIED_SPEC_ONLY');
    expect(line.sourceRef.section).toBe('Appendix 1, Table 2');
    expect(line.sourceRef.printedPage).toBe('237');
  });

  it('unknown codes are a controlled PRICEBOOK_ROW_NOT_FOUND; nothing is substituted', () => {
    for (const code of ['999999', '41070', ' 410701', '410701 ', '4102020']) {
      const result = bindBoqLine(published, { lineId: 'l1', code, quantity: '1', unit: 'm3' });
      expect(result.ok, code).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.code).toBe('PRICEBOOK_ROW_NOT_FOUND');
        expect(result.errors[0]?.message).toContain(code.trim());
      }
    }
  });

  it('leading zeros are preserved: "070612" binds, "70612" does not', () => {
    expect(
      bindBoqLine(synthetic, { lineId: 'l1', code: '070612', quantity: '1', unit: 'm3' }).ok,
    ).toBe(true);
    const notFound = bindBoqLine(synthetic, {
      lineId: 'l2',
      code: '70612',
      quantity: '1',
      unit: 'm3',
    });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.errors[0]?.code).toBe('PRICEBOOK_ROW_NOT_FOUND');
  });

  it('unit match succeeds for compound units (ton-km, ton-nautical-mile, m2-month codes)', () => {
    expect(
      bindBoqLine(published, { lineId: 'l1', code: '280101', quantity: '10', unit: 'ton_km' }).ok,
    ).toBe(true);
    expect(
      bindBoqLine(published, {
        lineId: 'l2',
        code: '280501',
        quantity: '10',
        unit: 'ton_nautical_mile',
      }).ok,
    ).toBe(true);
  });

  it('unit mismatch is rejected with both units named; no conversion is applied', () => {
    const result = bindBoqLine(published, {
      lineId: 'l1',
      code: '280101',
      quantity: '10',
      unit: 't',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('UNIT_MISMATCH');
      expect(result.errors[0]?.message).toContain('t');
      expect(result.errors[0]?.message).toContain('ton_km');
    }
  });

  it('ton-km and ton-nautical-mile are distinct: mixing them is a mismatch, not a conversion', () => {
    const result = bindBoqLine(published, {
      lineId: 'l1',
      code: '280501',
      quantity: '10',
      unit: 'ton_km',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe('UNIT_MISMATCH');
  });

  it('INCOMPLETE rows bind for traceability (411004) and never become priced', () => {
    const line = bindOrThrow(published, '411004', '10', 'kg');
    expect(line.status).toBe('INCOMPLETE');
    expect(line.pricebookRow.basePrice).toBeNull();
  });

  it('EXTERNAL_DEPENDENCY rows bind and carry their registry dependencies', () => {
    const line = bindOrThrow(synthetic, '990004', '10', 'm3');
    expect(line.status).toBe('EXTERNAL_DEPENDENCY');
    expect(line.externalDependencies).toEqual(['regional-coefficient-circular-94-69416']);
  });

  it('invalid quantities and unknown units are rejected', () => {
    const badDecimal = bindBoqLine(published, {
      lineId: 'l1',
      code: '410202',
      quantity: '1.5.3',
      unit: 'm3',
    });
    expect(badDecimal.ok).toBe(false);
    if (!badDecimal.ok) expect(badDecimal.errors[0]?.code).toBe('INVALID_DECIMAL');

    const badUnit = bindBoqLine(published, {
      lineId: 'l2',
      code: '410202',
      quantity: '1',
      unit: 'foot',
    });
    expect(badUnit.ok).toBe(false);
    if (!badUnit.ok) expect(badUnit.errors[0]?.code).toBe('UNKNOWN_UNIT');
  });

  it('batch binding preserves input order and independence', () => {
    const results = bindBoqLines(published, [
      { lineId: 'a', code: '410202', quantity: '1', unit: 'm3' },
      { lineId: 'b', code: 'nope', quantity: '1', unit: 'm3' },
      { lineId: 'c', code: '280101', quantity: '1', unit: 'ton_km' },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[2]?.ok).toBe(true);
  });
});

describe('S3 — line pricing', () => {
  it('prices exactly: 10 m3 × 5,591,000 = 55,910,000', () => {
    const priced = priceBoqLine(bindOrThrow(published, '410202', '10', 'm3'));
    expect(priced.lineAmount).toBe('55910000');
    expect(priced.calculationStatus).toBe('COMPLETE');
  });

  it('prices exact decimals without floating point: 0.125 × 28,400 = 3,550', () => {
    const priced = priceBoqLine(bindOrThrow(published, '280101', '0.125', 'ton_km'));
    expect(priced.lineAmount).toBe('3550');
  });

  it('negative quantities stay negative (deduction lines): -3 × 28,400 = -85,200', () => {
    const priced = priceBoqLine(bindOrThrow(published, '280101', '-3', 'ton_km'));
    expect(priced.lineAmount).toBe('-85200');
    expect(priced.calculationStatus).toBe('COMPLETE');
  });

  it('INCOMPLETE rows are never priced (411004: null, never zero)', () => {
    const priced = priceBoqLine(bindOrThrow(published, '411004', '10', 'kg'));
    expect(priced.lineAmount).toBeNull();
    expect(priced.basePrice).toBeNull();
    expect(priced.calculationStatus).toBe('INCOMPLETE');
  });

  it('EXTERNAL_DEPENDENCY rows stay unpriced with their dependencies listed', () => {
    const priced = priceBoqLine(bindOrThrow(synthetic, '990004', '10', 'm3'));
    expect(priced.lineAmount).toBeNull();
    expect(priced.calculationStatus).toBe('EXTERNAL_DEPENDENCY');
    expect(priced.dependencies).toEqual(['regional-coefficient-circular-94-69416']);
  });

  it('NOT_SPECIFIED rows stay unpriced as NOT_SPECIFIED', () => {
    const priced = priceBoqLine(bindOrThrow(synthetic, '990005', '10', 'm3'));
    expect(priced.lineAmount).toBeNull();
    expect(priced.calculationStatus).toBe('NOT_SPECIFIED');
  });

  it('the trace records quantity × unit price = line amount', () => {
    const priced = priceBoqLine(bindOrThrow(published, '410202', '10', 'm3'));
    expect(priced.trace.quantity).toBe('10');
    expect(priced.trace.unitPrice).toBe('5591000');
    expect(priced.trace.operation).toBe('multiply');
    expect(priced.trace.lineAmount).toBe('55910000');
  });

  it('sumPricedLines totals only when every line is COMPLETE', () => {
    const complete = sumPricedLines([
      priceBoqLine(bindOrThrow(published, '410202', '10', 'm3')),
      priceBoqLine(bindOrThrow(published, '280101', '10', 'ton_km')),
    ]);
    expect(complete.total).toBe('56194000');
    expect(complete.calculationStatus).toBe('COMPLETE');

    const withIncomplete = sumPricedLines([
      priceBoqLine(bindOrThrow(published, '410202', '10', 'm3')),
      priceBoqLine(bindOrThrow(published, '411004', '10', 'kg')),
    ]);
    expect(withIncomplete.total).toBeNull();
    expect(withIncomplete.calculationStatus).toBe('INCOMPLETE');
  });
});
