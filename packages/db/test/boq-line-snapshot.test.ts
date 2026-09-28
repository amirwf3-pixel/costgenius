import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { BoqLine } from '@costgenius/boq';
import {
  addEstimateLines,
  createEstimateForProject,
  createProject,
  startEstimateVersion,
  type EstimateLineInput,
} from '@costgenius/projects';
import { canonicalJson } from '../src/index.js';
import {
  BLOCKED_LINE_INPUTS,
  BUILDING_ID,
  COMPLETE_LINE_INPUTS,
  ESTIMATE_ID,
  FIXED_INSTANT,
  OFFICIAL_SOURCE_HASH,
  PROJECT_ID,
  createTestDb,
  loadPublished1404,
  resolveLines,
} from './helpers.js';

const dataset = loadPublished1404();

/**
 * Persists a draft version carrying the given lines and returns the RELOADED lines plus
 * the raw PGlite handle (for direct SQL column checks).
 */
async function persistedLines(
  inputs: readonly EstimateLineInput[],
): Promise<{ lines: readonly BoqLine[]; pg: PGlite }> {
  const { pg, projects, estimates } = await createTestDb();
  const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
  await projects.save(project);
  let estimate = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 't' });
  estimate = startEstimateVersion(dataset, estimate, {
    createdAt: FIXED_INSTANT,
    buildingId: BUILDING_ID,
  });
  const added = addEstimateLines(dataset, estimate, `${ESTIMATE_ID}-v1`, inputs);
  if (!added.ok) throw new Error('fixture must resolve');
  await estimates.save(added.estimate);
  const loaded = await estimates.findById(ESTIMATE_ID);
  return { lines: loaded?.versions[0]?.lines ?? [], pg };
}

describe('D. BoqLine snapshots persist field-for-field', () => {
  it('every line field round-trips exactly (canonical equality of the whole version)', async () => {
    const { lines } = await persistedLines([...COMPLETE_LINE_INPUTS, ...BLOCKED_LINE_INPUTS]);
    expect(lines).toHaveLength(12);
    const original = resolveLines(dataset, [...COMPLETE_LINE_INPUTS, ...BLOCKED_LINE_INPUTS]);
    expect(canonicalJson(lines)).toBe(canonicalJson(original));

    // explicit field-by-field spot check of the identity/provenance contract
    const l1 = lines.find((l) => l.lineId === 'l1');
    expect(l1?.pricebookCode).toBe('010101');
    expect(l1?.chapter).toBe('chapter-1');
    expect(l1?.group).toBe('1');
    expect(l1?.unit).toEqual({ label: 'مترمربع', code: 'm2' });
    expect(l1?.basePrice).toBe('2890');
    expect(l1?.lineAmount).toBe('2890000');
    expect(l1?.sourceRef).toEqual({
      sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
      edition: '1404',
      printedPage: '11',
      section: 'Chapter 1, Group 1',
      sourceFileHash: OFFICIAL_SOURCE_HASH,
    });
    expect(l1?.edition).toBe('1404');
    expect(l1?.externalDependencies).toEqual([]);
    expect(l1?.notes).toEqual([]);
    expect(l1?.trace).toEqual({
      quantity: '1000',
      unitPrice: '2890',
      operation: 'multiply',
      lineAmount: '2890000',
    });
    expect(Object.isFrozen(l1)).toBe(true);
  });
});

describe('E. NULL semantics survive persistence (blank ≠ zero)', () => {
  it('220925: basePrice and lineAmount are NULL in the database, never 0', async () => {
    const { lines, pg } = await persistedLines(BLOCKED_LINE_INPUTS);
    const b1 = lines.find((l) => l.lineId === 'b1');
    expect(b1?.pricebookCode).toBe('220925');
    expect(b1?.pricebookStatus).toBe('INCOMPLETE');
    expect(b1?.basePrice).toBeNull();
    expect(b1?.lineAmount).toBeNull();
    expect(b1?.notes[0]).toContain('کسر بها');

    // raw column check: the database itself stores NULL, not 0 and not ''
    const raw = await pg.query<{ base_price: string | null; line_amount: string | null }>(
      "select base_price, line_amount from boq_lines where line_id = 'b1'",
    );
    expect(raw.rows[0]?.base_price).toBeNull();
    expect(raw.rows[0]?.line_amount).toBeNull();
  });

  it('Appendix-5 row 991001: no printed price stays NULL through the database', async () => {
    const { lines, pg } = await persistedLines(BLOCKED_LINE_INPUTS);
    const b4 = lines.find((l) => l.lineId === 'b4');
    expect(b4?.pricebookCode).toBe('991001');
    expect(b4?.unit.code).toBe('m2_month'); // compound unit preserved exactly
    expect(b4?.basePrice).toBeNull();
    expect(b4?.lineAmount).toBeNull();
    const raw = await pg.query<{ base_price: string | null }>(
      "select base_price from boq_lines where line_id = 'b4'",
    );
    expect(raw.rows[0]?.base_price).toBeNull();
  });

  it('a zero-quantity line keeps its exact 0 amount (zero is a value, not a blank)', async () => {
    const { lines } = await persistedLines(COMPLETE_LINE_INPUTS);
    const l3 = lines.find((l) => l.lineId === 'l3');
    expect(l3?.quantity).toBe('0');
    expect(l3?.lineAmount).toBe('0');
  });
});

describe('F. negative prices survive persistence (no sign loss, no absolute value)', () => {
  it('270320 and 270403 keep their exact negative base prices and amounts', async () => {
    const { lines, pg } = await persistedLines(COMPLETE_LINE_INPUTS);
    const l5 = lines.find((l) => l.lineId === 'l5');
    const l6 = lines.find((l) => l.lineId === 'l6');
    expect(l5?.pricebookCode).toBe('270320');
    expect(l5?.basePrice).toBe('-1037000');
    expect(l5?.lineAmount).toBe('-10370000');
    expect(l6?.pricebookCode).toBe('270403');
    expect(l6?.basePrice).toBe('-2131000');
    expect(l6?.lineAmount).toBe('-4262000');

    const raw = await pg.query<{ base_price: string; line_amount: string }>(
      "select base_price, line_amount from boq_lines where line_id in ('l5','l6') order by line_id",
    );
    expect(raw.rows.map((r) => r.base_price)).toEqual(['-1037000', '-2131000']);
    expect(raw.rows.map((r) => r.line_amount)).toEqual(['-10370000', '-4262000']);
  });
});

describe('G/H. leading zeros and exact decimals survive persistence', () => {
  it('the leading-zero code 010101 is stored and reloaded as exact text', async () => {
    const { lines, pg } = await persistedLines(COMPLETE_LINE_INPUTS);
    expect(lines.find((l) => l.lineId === 'l1')?.pricebookCode).toBe('010101');
    const raw = await pg.query<{ pricebook_code: string }>(
      "select pricebook_code from boq_lines where line_id = 'l1'",
    );
    expect(raw.rows[0]?.pricebook_code).toBe('010101');
    const columnType = await pg.query<{ data_type: string }>(
      "select data_type from information_schema.columns where table_name = 'boq_lines' and column_name = 'pricebook_code'",
    );
    expect(columnType.rows[0]?.data_type).toBe('text'); // text column: leading zeros by construction
  });

  it('a 24-digit quantity and its exact product round-trip losslessly (numeric, string-typed)', async () => {
    const { lines } = await persistedLines([
      { lineId: 'big', pricebookCode: '010101', quantity: '123456789012345678000001', unit: 'm2' },
      { lineId: 'frac', pricebookCode: '010101', quantity: '12.5', unit: 'm2' },
    ]);
    const big = lines.find((l) => l.lineId === 'big');
    expect(big?.quantity).toBe('123456789012345678000001');
    expect(big?.basePrice).toBe('2890');
    expect(big?.lineAmount).toBe('356790120245679009420002890'); // exact product, no float
    const frac = lines.find((l) => l.lineId === 'frac');
    expect(frac?.quantity).toBe('12.5');
    expect(frac?.lineAmount).toBe('36125'); // 12.5 × 2890, exact
  });
});
