import { describe, expect, it } from 'vitest';
import { combinedMultiBuildingRollup, combinedMultiDisciplineRollup } from '@costgenius/boq';
import type { ReportModel } from '@costgenius/reporting';
import {
  CELL_DELIMITER,
  ReportingPdfError,
  buildPdfDocumentModel,
  reportStructureErrors,
  shapeArabicPersian,
  toVisualString,
  wrapLogicalText,
  type PdfDocumentModel,
} from '../src/index.js';
import { goldenS4Result, makeLine, makeReport } from './helpers.js';

/** Recursively-writable view, for corrupting an unfrozen clone in tests. */
type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };
const corrupt = <T>(value: T): Writable<T> => structuredClone(value);

function expectInvalid(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportingPdfError);
  expect((caught as ReportingPdfError).code).toBe('INVALID_REPORT_MODEL');
  expect((caught as ReportingPdfError).details?.length ?? 0).toBeGreaterThan(0);
}

/** COMPLETE report: 990001 ×10 m3 = 10,000 + 990002 ×2 each = 1,000 → total 11,000. */
function completeReport(): ReportModel {
  return makeReport([makeLine('l1', '990001', '10', 'm3'), makeLine('l2', '990002', '2', 'each')]);
}

function section(model: PdfDocumentModel, index: number) {
  const found = model.sections[index];
  if (found === undefined) throw new Error(`section ${String(index)} missing`);
  return found;
}

describe('document model structure', () => {
  it('has fixed sections: Summary, Chapters, Groups (portrait), Lines (landscape)', () => {
    const model = buildPdfDocumentModel(completeReport());
    expect(model.sections.map((s) => s.orientation)).toEqual([
      'portrait',
      'portrait',
      'portrait',
      'landscape',
    ]);
    expect(section(model, 0).blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(section(model, 0).blocks[1]).toMatchObject({ kind: 'heading', text: 'Summary' });
    expect(section(model, 1).blocks[0]).toMatchObject({ kind: 'heading', text: 'Chapters' });
    expect(section(model, 2).blocks[0]).toMatchObject({ kind: 'heading', text: 'Groups' });
    expect(section(model, 3).blocks[0]).toMatchObject({ kind: 'heading', text: 'Lines' });
  });

  it('adds the S4 Calculation Trace section (portrait) only when an S4 result exists', () => {
    const plain = buildPdfDocumentModel(completeReport());
    expect(plain.sections).toHaveLength(4);
    expect(JSON.stringify(plain)).not.toContain('S4 Calculation Trace');

    const withS4 = buildPdfDocumentModel(
      makeReport(
        [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
        {
          buildingId: 'b-golden',
          s4Estimate: goldenS4Result(),
        },
      ),
    );
    expect(withS4.sections).toHaveLength(5);
    expect(withS4.sections[4]?.orientation).toBe('portrait');
    expect(JSON.stringify(withS4.sections[4])).toContain('S4 Calculation Trace');
  });

  it('is deterministic: the same report builds the same model twice', () => {
    const report = completeReport();
    expect(buildPdfDocumentModel(report)).toEqual(buildPdfDocumentModel(report));
  });

  it('carries every summary field as an exact string (null stays null, counts as text)', () => {
    const model = buildPdfDocumentModel(
      makeReport([makeLine('l1', '990001', '10', 'm3')], {
        generatedAt: '2026-03-04T00:00:00Z',
        buildingId: 'b-7',
      }),
    );
    const rows = (
      section(model, 0).blocks[2] as unknown as { rows: { field: string; value: string | null }[] }
    ).rows;
    const byField = new Map(rows.map((r) => [r.field, r.value]));
    expect(byField.get('Report ID')).toBe('rep-1');
    expect(byField.get('Version Number')).toBe('1');
    expect(byField.get('Line Count')).toBe('1');
    expect(byField.get('Total Amount')).toBe('10000');
    expect(byField.get('Generated At')).toBe('2026-03-04T00:00:00Z');
    expect(byField.get('Building ID')).toBe('b-7');
  });

  it('keeps a pending total null in the model (never 0)', () => {
    const model = buildPdfDocumentModel(
      makeReport([makeLine('ok', '990001', '10', 'm3'), makeLine('p', '990004', '5', 'm3')]),
    );
    const rows = (
      section(model, 0).blocks[2] as unknown as { rows: { field: string; value: string | null }[] }
    ).rows;
    expect(rows.find((r) => r.field === 'Total Amount')?.value).toBe(null);
    expect(rows.find((r) => r.field === 'Report Status')?.value).toBe('EXTERNAL_DEPENDENCY');
  });

  it('carries the scope boundaries verbatim (NOT_SPECIFIED + BOQ statements)', () => {
    const model = buildPdfDocumentModel(completeReport());
    const json = JSON.stringify(model);
    expect(json).toContain('"Multi-Building Combination"');
    expect(json).toContain(combinedMultiBuildingRollup().message);
    expect(json).toContain(combinedMultiDisciplineRollup().message);
    expect(json).toContain('NOT_SPECIFIED');
  });

  it('line rows preserve every exact value and provenance field', () => {
    const report = makeReport([
      makeLine('a', '0990007', '-15', 'm3', { buildingId: 'b-2', landscaping: true }),
      makeLine('b', '990006', '2', 'm3'),
    ]);
    const model = buildPdfDocumentModel(report);
    const linesTable = section(model, 3).blocks.find(
      (b) => b.kind === 'table' && b.title === 'Lines',
    ) as unknown as { table: { rows: string[][] } };
    const rowA = linesTable.table.rows[0];
    expect(rowA).toEqual([
      'a',
      '0990007',
      'SYNTHETIC test row 0990007',
      'مترمکعب',
      '-15',
      '2500',
      '-37500',
      'VERIFIED_SPEC_ONLY',
      'COMPLETE',
    ]);
    const provTable = section(model, 3).blocks.find(
      (b) => b.kind === 'table' && b.title === 'Line Provenance and Trace',
    ) as unknown as { table: { rows: (string | null)[][] } };
    const provA = provTable.table.rows[0];
    expect(provA).toEqual([
      'a',
      'chapter-99',
      '3',
      'm3',
      'SYNTHETIC TEST DATA',
      'SYN',
      '1',
      'SYN-1',
      null,
      null,
      '-15',
      '2500',
      'multiply',
      '-37500',
      'b-2',
      'true',
    ]);
    const provB = provTable.table.rows[1];
    expect(provB?.[9]).toBe(
      `regional-coefficient-circular-94-69416${CELL_DELIMITER}supervision-circular`,
    );
    expect(provB?.[6]).toBe('1'); // printed page still exact
  });

  it('S4 stage rows carry the golden values verbatim (no recomputation)', () => {
    const model = buildPdfDocumentModel(
      makeReport(
        [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
        {
          buildingId: 'b-golden',
          s4Estimate: goldenS4Result(),
        },
      ),
    );
    const tableBlock = section(model, 4).blocks.find((b) => b.kind === 'table') as unknown as {
      table: { rows: (string | null)[][] };
    };
    const rows = tableBlock.table.rows;
    expect(rows.map((r) => r[0])).toEqual([
      'base-subtotal',
      'floor',
      'overhead',
      'regional',
      'site-setup',
    ]);
    expect(rows[1]?.[4]).toBe('1.0451'); // golden P, exact string
    expect(rows[1]?.[1]).toBe('IR-1404-E-FLOOR-01..03');
    expect(rows[2]?.[4]).toBe('1.30'); // verified overhead, never '1.3'
    expect(rows[2]?.[1]).toBe('IR-1404-E-OVERHEAD-01');
    expect(rows[4]?.[1]).toBe('IR-1404-E-SITE-01'); // site setup stays a separate stage
  });
});

describe('structural validation (fail loudly, never repair)', () => {
  it('accepts a correct report with zero errors', () => {
    expect(reportStructureErrors(completeReport())).toEqual([]);
  });

  it('rejects a pending summary that carries an amount', () => {
    const report = corrupt(makeReport([makeLine('a', '990003', '5', 'm3')]));
    report.summary = { ...report.summary, amount: '999' };
    expectInvalid(() => buildPdfDocumentModel(report));
    expect(reportStructureErrors(report).some((e) => e.includes('summary.amount'))).toBe(true);
  });

  it('rejects a COMPLETE line whose amount was nulled', () => {
    const report = corrupt(completeReport());
    const group = report.chapters[0]?.groups[0];
    if (group === undefined) throw new Error('missing group');
    group.lines = group.lines.map((line) => ({ ...line, lineAmount: null }));
    expectInvalid(() => buildPdfDocumentModel(report));
  });

  it('rejects a line moved into the wrong group section', () => {
    const report = corrupt(
      makeReport([makeLine('a', '990001', '1', 'm3'), makeLine('b', '990002', '1', 'each')]),
    );
    const group2 = report.chapters[0]?.groups[1];
    if (group2 === undefined) throw new Error('missing group 2');
    group2.lines = group2.lines.map((line) =>
      line.lineId === 'b' ? { ...line, group: 'wrong-group' } : line,
    );
    expectInvalid(() => buildPdfDocumentModel(report));
  });

  it('rejects a dropped line (coverage mismatch)', () => {
    const report = corrupt(
      makeReport([makeLine('a', '990001', '10', 'm3'), makeLine('b', '990001', '2', 'm3')]),
    );
    const group = report.chapters[0]?.groups[0];
    if (group === undefined) throw new Error('missing group');
    group.lines = group.lines.slice(0, 1);
    expectInvalid(() => buildPdfDocumentModel(report));
    expect(reportStructureErrors(report).some((e) => e.includes('summary.lineCount'))).toBe(true);
  });

  it('rejects broken dependency attribution and omitted dependencies', () => {
    const ghost = corrupt(makeReport([makeLine('a', '990004', '5', 'm3')]));
    ghost.summary = {
      ...ghost.summary,
      dependencies: [{ id: 'regional-coefficient-circular-94-69416', lineIds: ['ghost-line'] }],
    };
    expectInvalid(() => buildPdfDocumentModel(ghost));

    const omitted = corrupt(makeReport([makeLine('a', '990004', '5', 'm3')]));
    omitted.summary = { ...omitted.summary, dependencies: [] };
    expectInvalid(() => buildPdfDocumentModel(omitted));
  });

  it('rejects an S4 result from a different estimate', () => {
    const report = corrupt(
      makeReport(
        [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
        { buildingId: 'b-golden', s4Estimate: goldenS4Result() },
      ),
    );
    const s4 = report.generatedFrom.s4Estimate;
    if (s4 === null) throw new Error('expected s4');
    report.generatedFrom = { ...report.generatedFrom, s4Estimate: { ...s4, estimateId: 'other' } };
    expectInvalid(() => buildPdfDocumentModel(report));
  });

  it('rejects identity garbage (empty reportId, missing chapters)', () => {
    const report = corrupt(completeReport());
    report.reportId = '';
    expect(reportStructureErrors(report).some((e) => e.includes('reportId'))).toBe(true);

    const noChapters = corrupt(completeReport());
    (noChapters as { chapters: unknown }).chapters = undefined;
    expectInvalid(() => buildPdfDocumentModel(noChapters));
  });
});

describe('RTL engine (shaping, bidi, wrapping)', () => {
  it('shapes Persian words into correct contextual presentation forms', () => {
    // سلام: SEEN initial + LAM-ALEF ligature (final) + MEEM isolated (the alef breaks joining)
    expect(shapeArabicPersian('سلام')).toBe(String.fromCodePoint(0xfeb3, 0xfefc, 0xfee1));
    // فهرست: FEH initial + HEH medial + REH final + SEEN initial (joins ت) + TEH final
    expect(shapeArabicPersian('فهرست')).toBe(
      String.fromCodePoint(0xfed3, 0xfeec, 0xfeae, 0xfeb3, 0xfe96),
    );
    // پایه: PEH initial + ALEF final + FARSI YEH initial (joins ه) + HEH final
    expect(shapeArabicPersian('پایه')).toBe(String.fromCodePoint(0xfb58, 0xfe8e, 0xfbfe, 0xfeea));
    // منطقه: MEEM initial + NOON medial + TAH medial + QAF medial + HEH final
    expect(shapeArabicPersian('منطقه')).toBe(
      String.fromCodePoint(0xfee3, 0xfee8, 0xfec4, 0xfed8, 0xfeea),
    );
  });

  it('leaves Latin, digits and punctuation untouched by shaping', () => {
    expect(shapeArabicPersian('0990007')).toBe('0990007');
    expect(shapeArabicPersian('IR-1404-E-OVERHEAD-01')).toBe('IR-1404-E-OVERHEAD-01');
    expect(shapeArabicPersian('1.0451')).toBe('1.0451');
  });

  it('bidi: Persian title becomes visual order with digits intact', () => {
    const visual = toVisualString('فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴');
    // the year stays ۱۴۰۴ in visual order (not reversed)
    expect(visual).toContain('۱۴۰۴');
    // the first logical word فهرست is drawn LAST (leftmost): the visual string ends with
    // its shaped glyphs in REVERSED order (RTL run reordering, not reversal-as-shaping)
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- verify reversed shaped code points
    const shapedFehrest = [...shapeArabicPersian('فهرست')].reverse().join('');
    expect(visual.endsWith(shapedFehrest)).toBe(true);
  });

  it('bidi: Latin tokens and signed decimals stay exact', () => {
    expect(toVisualString('0990007')).toBe('0990007');
    expect(toVisualString('-15000')).toBe('-15000');
    expect(toVisualString('1.0451')).toBe('1.0451');
    expect(toVisualString('1.30')).toBe('1.30');
    expect(toVisualString('regional-coefficient-circular-94-69416')).toBe(
      'regional-coefficient-circular-94-69416',
    );
    expect(toVisualString('IR-1404-E-OVERHEAD-01')).toBe('IR-1404-E-OVERHEAD-01');
  });

  it('bidi: a signed decimal inside Persian text keeps its minus on the left', () => {
    const visual = toVisualString('مبلغ: -15000 ریال');
    expect(visual).toContain('-15000');
    expect(visual).not.toContain('15000-');
  });

  it('wraps logical text by measured width and chunks over-long tokens', () => {
    const widthOf = (text: string): number => text.length * 10; // deterministic fake measure
    const lines = wrapLogicalText('کد 0990007 با شرح', 50, widthOf);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toContain('0990007');

    const chunks = wrapLogicalText(
      'regional-coefficient-circular-94-69416',
      50,
      (t) => t.length * 10,
    );
    expect(chunks.length).toBeGreaterThan(1); // chunked, never overflowing
    expect(chunks.join('')).toBe('regional-coefficient-circular-94-69416');
  });
});
