import { describe, expect, it } from 'vitest';
import { Money, canonical } from '@costgenius/domain';
import { bindBoqLine, priceBoqLine } from '@costgenius/cost-calculation';
import {
  combinedMultiBuildingRollup,
  combinedMultiDisciplineRollup,
  createBoqLine,
  groupLinesByBuilding,
  groupLinesByChapter,
  groupLinesByChapterGroup,
  rollupBoqLines,
  type BoqLine,
} from '../src/index.js';
import { loadPublished1404, syntheticDataset } from './helpers.js';

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

describe('grouping', () => {
  const lines = [
    makeLine(published, 'l1', '280101', '1', 'ton_km'), // chapter-28, group 1
    makeLine(published, 'l2', '410202', '2', 'm3'), // appendix-1, table-2
    makeLine(published, 'l3', '280501', '3', 'ton_nautical_mile'), // chapter-28, group 5
    makeLine(published, 'l4', '410701', '4', 'each'), // appendix-1, table-2
  ];

  it('groups by chapter in first-appearance order, lines in source order', () => {
    const chapters = groupLinesByChapter(lines);
    expect(chapters.map((c) => c.chapter)).toEqual(['chapter-28', 'appendix-1']);
    expect(chapters[0]?.lines.map((l) => l.lineId)).toEqual(['l1', 'l3']);
    expect(chapters[1]?.lines.map((l) => l.lineId)).toEqual(['l2', 'l4']);
  });

  it('groups by chapter+group in first-appearance order', () => {
    const groups = groupLinesByChapterGroup(lines);
    expect(groups.map((g) => [g.chapter, g.group])).toEqual([
      ['chapter-28', '1'],
      ['appendix-1', 'table-2'],
      ['chapter-28', '5'],
    ]);
  });

  it('duplicate pricebook codes remain separate lines (identity is lineId)', () => {
    const dupes = [
      makeLine(synthetic, 'a', '990001', '1', 'm3'),
      makeLine(synthetic, 'b', '990001', '2', 'm3'),
      makeLine(synthetic, 'c', '990001', '3', 'm3'),
    ];
    const groups = groupLinesByChapterGroup(dupes);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.lines).toHaveLength(3);
    expect(groups[0]?.lines.map((l) => l.lineId)).toEqual(['a', 'b', 'c']);
  });

  it('groups by building attribution (metadata only)', () => {
    const byBuilding = groupLinesByBuilding([
      makeLine(synthetic, 'a', '990001', '1', 'm3', { buildingId: 'b-2' }),
      makeLine(synthetic, 'b', '990002', '1', 'each'),
      makeLine(synthetic, 'c', '990001', '1', 'm3', { buildingId: 'b-1' }),
      makeLine(synthetic, 'd', '990006', '1', 'm3', { buildingId: 'b-2' }),
    ]);
    expect(byBuilding.map((g) => g.buildingId)).toEqual(['b-2', null, 'b-1']);
    expect(byBuilding[0]?.lines.map((l) => l.lineId)).toEqual(['a', 'd']);
  });
});

describe('subtotals and rollup', () => {
  it('group, chapter and estimate totals aggregate exactly, with no double-counting', () => {
    const lines = [
      makeLine(published, 'l1', '280101', '10', 'ton_km'), // 284,000
      makeLine(published, 'l2', '280501', '2', 'ton_nautical_mile'), // 221,400 (chapter-28, group 5)
      makeLine(published, 'l3', '410202', '3', 'm3'), // 16,773,000
      makeLine(published, 'l4', '410701', '100', 'each'), // 2,140,000
    ];
    const rollup = rollupBoqLines(lines);
    expect(rollup.status).toBe('COMPLETE');
    expect(rollup.amount).toBe('19418400');

    // one authoritative path: total = Σ chapter amounts = Σ group amounts = Σ line amounts (exact)
    const sumExact = (values: readonly (string | null)[]): string => {
      let sum = Money.zero();
      for (const value of values) {
        if (value !== null) sum = sum.add(Money.of(value));
      }
      return canonical(sum.toDecimal());
    };
    const chapterSum = sumExact(rollup.chapterSubtotals.map((c) => c.amount));
    const groupSum = sumExact(
      rollup.chapterSubtotals.flatMap((c) => c.groupSubtotals).map((g) => g.amount),
    );
    const lineSum = sumExact(lines.map((l) => l.lineAmount));
    expect(chapterSum).toBe(rollup.amount);
    expect(groupSum).toBe(rollup.amount);
    expect(lineSum).toBe(rollup.amount);
    expect(rollup.chapterSubtotals.map((c) => c.chapter)).toEqual(['chapter-28', 'appendix-1']);
    expect(rollup.chapterSubtotals[0]?.groupSubtotals.map((g) => g.group)).toEqual(['1', '5']);
  });

  it('aggregation is exact decimal arithmetic, not floating point (0.1 + 0.2 = 0.3)', () => {
    const lines = [
      makeLine(synthetic, 'a', '990006', '1', 'm3'), // 0.1
      makeLine(synthetic, 'b', '990007', '1', 'm3'), // 0.2
    ];
    const rollup = rollupBoqLines(lines);
    expect(rollup.amount).toBe('0.3');
    expect(rollup.amount).not.toContain('00000004');
  });

  it('negative lines and negative subtotals keep their sign', () => {
    const lines = [
      makeLine(synthetic, 'a', '990001', '10', 'm3'), // +10,000
      makeLine(synthetic, 'b', '990001', '-15', 'm3'), // -15,000
    ];
    const rollup = rollupBoqLines(lines);
    expect(rollup.amount).toBe('-5000');
    expect(rollup.status).toBe('COMPLETE');
  });

  it('zero-quantity lines stay traceable with a zero amount', () => {
    const lines = [makeLine(synthetic, 'a', '990001', '0', 'm3')];
    const rollup = rollupBoqLines(lines);
    expect(rollup.amount).toBe('0');
    expect(rollup.lineCount).toBe(1);
    // the zero-quantity line stays traceable in the aggregation: counted, amount 0 (not null)
    expect(rollup.chapterSubtotals[0]?.groupSubtotals[0]?.lineCount).toBe(1);
    expect(rollup.chapterSubtotals[0]?.groupSubtotals[0]?.amount).toBe('0');
  });

  it('pending lines make the subtotal null, never zero (INCOMPLETE / EXTERNAL / NOT_SPECIFIED)', () => {
    for (const [code, unit, expectedStatus] of [
      ['990003', 'm3', 'INCOMPLETE'],
      ['990004', 'm3', 'EXTERNAL_DEPENDENCY'],
      ['990005', 'm3', 'NOT_SPECIFIED'],
    ] as const) {
      const lines = [
        makeLine(synthetic, 'ok', '990001', '10', 'm3'),
        makeLine(synthetic, 'pending', code, '5', unit),
      ];
      const rollup = rollupBoqLines(lines);
      expect(rollup.amount, code).toBeNull();
      expect(rollup.status, code).toBe(expectedStatus);
      expect(rollup.pendingLineCount, code).toBe(1);
      expect(rollup.pricedLineCount, code).toBe(1);
    }
  });

  it('external dependencies propagate into the rollup', () => {
    const lines = [
      makeLine(synthetic, 'a', '990001', '1', 'm3'),
      makeLine(synthetic, 'b', '990004', '1', 'm3'),
    ];
    const rollup = rollupBoqLines(lines);
    expect(rollup.status).toBe('EXTERNAL_DEPENDENCY');
    expect(rollup.dependencies).toContain('regional-coefficient-circular-94-69416');
  });

  it('a fully complete version aggregates COMPLETE; an empty version totals 0', () => {
    expect(rollupBoqLines([makeLine(synthetic, 'a', '990001', '2', 'm3')]).amount).toBe('2000');
    const empty = rollupBoqLines([]);
    expect(empty.amount).toBe('0');
    expect(empty.status).toBe('COMPLETE');
    expect(empty.lineCount).toBe(0);
  });
});

describe('scope boundaries (no invented combination rules)', () => {
  it('combined multi-building rollup is NOT_SPECIFIED', () => {
    const blocked = combinedMultiBuildingRollup();
    expect(blocked.status).toBe('NOT_SPECIFIED');
    expect(blocked.message).toContain('per building');
  });

  it('combined multi-discipline rollup is NOT_SPECIFIED', () => {
    const blocked = combinedMultiDisciplineRollup();
    expect(blocked.status).toBe('NOT_SPECIFIED');
    expect(blocked.message).toContain('each discipline separately');
  });
});
