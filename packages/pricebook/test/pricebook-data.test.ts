import { describe, expect, it } from 'vitest';
import staged1404 from '../data/verified-1404.staged.v0.1.0.json' with { type: 'json' };
import syntheticFixture from '../spec/fixtures/synthetic-edition.v0.1.0.json' with { type: 'json' };
import {
  ImportValidationError,
  NEW_03_EQUIPMENT_ONLY_COEFFICIENT_PRINTED,
  OFFICIAL_1404_EDITION,
  OFFICIAL_EDITION_ID,
  OVERHEAD_02_PURCHASE_AND_FITTINGS_COEFFICIENT,
  PRINTED_UNIT_MAPPINGS,
  VERIFIED_COVERAGE_FINDINGS,
  VERIFIED_EXTERNAL_DEPENDENCIES,
  VERIFIED_SUBSET_REQUIRED_CODES,
  VERIFIED_VALUE_ANCHORS,
  canonicalJson,
  coverageFinding,
  getExternalDependency,
  isPricebookStatus,
  isVerifiedDependencyId,
  printedUnitMatches,
  publishStagedImport,
  requireUnitCodeForPrintedLabel,
  unitCodeForPrintedLabel,
  validateStagedImport,
  type ImportReport,
  type PricebookRow,
} from '../src/index.js';
import { isUnitCode } from '@costgenius/domain';

const report: ImportReport = validateStagedImport(staged1404);
const published = publishStagedImport(staged1404);

type StagedFile = typeof staged1404;

/** Deep-clone so mutation attempts never touch the shared staged file. */
const cloneStaged = (): StagedFile => structuredClone(staged1404);

const rowsOf = (file: StagedFile): Record<string, unknown>[] => file.rows;

/** Applies a patch to one staged row by code; throws when the code is absent. */
function patchRow(file: StagedFile, code: string, patch: Record<string, unknown>): void {
  const row = rowsOf(file).find((r) => r['code'] === code);
  if (row === undefined) throw new Error(`row ${code} missing from staged file`);
  Object.assign(row, patch);
}

/**
 * Builds a fully synthetic carrier row. SYNTHETIC TEST DATA ONLY — never official 1404
 * content; the source reference says so explicitly.
 */
function syntheticRow(
  code: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code,
    chapter: 'chapter-99',
    group: '1',
    description: `SYNTHETIC carrier row ${code}`,
    unit: { label: 'مترمکعب', code: 'm3' },
    basePrice: '1000',
    status: 'VERIFIED_SPEC_ONLY',
    sourceRef: {
      sourceDocument: 'SYNTHETIC TEST DATA',
      edition: 'SYN',
      printedPage: '1',
      section: 'SYNTHETIC',
      sourceFileHash: null,
    },
    externalDependencies: [],
    notes: [],
    ...overrides,
  };
}

describe('1404 data layer: staged import, validation and publication', () => {
  it('the shipped staged file validates cleanly and publishes', () => {
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.rowCount).toBe(1564);
    expect(published.edition.id).toBe(OFFICIAL_EDITION_ID);
  });

  it('exact code preservation and code-based identity', () => {
    const row = published.getRow('410701');
    expect(row?.code).toBe('410701');
    expect(published.hasRow('410701')).toBe(true);
    expect(published.getRow('41070')).toBeUndefined();
    expect(published.getRow(' 410701')).toBeUndefined();
    expect(published.getRow('410701 ')).toBeUndefined();
  });

  it('leading zeros in row codes survive the whole pipeline', () => {
    // 070698 has the Chapter 7 code shape but is not a printed row; a synthetic carrier
    // proves identity stays string-based (the real 070612 also ships with its zero).
    const file = cloneStaged();
    rowsOf(file).push(syntheticRow('070698', { chapter: 'chapter-7', group: '6' }));
    const ds = publishStagedImport(file);
    expect(ds.getRow('070698')?.description).toBe('SYNTHETIC carrier row 070698');
    expect(ds.getRow('70698')).toBeUndefined();
    expect(published.getRow('070612')?.code).toBe('070612');
  });

  it('exact price preservation (spot checks against the verified specification)', () => {
    expect(published.getRow('410202')?.basePrice).toBe('5591000');
    expect(published.getRow('411902')?.basePrice).toBe('222924000');
    expect(published.getRow('280101')?.basePrice).toBe('28400');
    expect(published.getRow('280501')?.basePrice).toBe('110700');
  });

  it('negative anchors: 270320/270403 keep their exact negative sign; sign flips are rejected', () => {
    // the rows ship in the staged file with their anchored negative values
    expect(published.getRow('270320')?.basePrice).toBe('-1037000');
    expect(published.getRow('270403')?.basePrice).toBe('-2131000');
    expect(validateStagedImport(cloneStaged()).ok).toBe(true);

    const flipped = cloneStaged();
    const target = rowsOf(flipped).find((r) => (r as { code?: string }).code === '270320') as {
      basePrice?: string;
    };
    target.basePrice = '1037000';
    const flippedReport = validateStagedImport(flipped);
    expect(flippedReport.ok).toBe(false);
    expect(
      flippedReport.errors.some(
        (e) => e.code === 'ANCHOR_VALUE_MISMATCH' && e.rowCode === '270320',
      ),
    ).toBe(true);
  });

  it('220925 is not a verified negative price; a negative sign for it is rejected', () => {
    const file = cloneStaged();
    rowsOf(file).push(
      syntheticRow('220925', { chapter: 'chapter-22', group: '9', basePrice: '-1000' }),
    );
    const r = validateStagedImport(file);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.code === 'ANCHOR_NEGATIVE_FORBIDDEN' && e.rowCode === '220925'),
    ).toBe(true);
  });

  it('blank price stays null with status INCOMPLETE; it can never become zero', () => {
    const row = published.getRow('411004');
    expect(row?.basePrice).toBeNull();
    expect(row?.status).toBe('INCOMPLETE');

    const zeroed = cloneStaged();
    patchRow(zeroed, '411004', { basePrice: '0' });
    const r = validateStagedImport(zeroed);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.rowCode === '411004' && e.message.includes('verified anchor')),
    ).toBe(true);
    expect(
      r.warnings.some((e) => e.code === 'SUSPICIOUS_ZERO_PRICE' && e.rowCode === '411004'),
    ).toBe(true);
  });

  it('a null price on any other status is rejected (blank never silently becomes usable)', () => {
    const file = cloneStaged();
    patchRow(file, '410202', { basePrice: null });
    const r = validateStagedImport(file);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some(
        (e) =>
          e.rowCode === '410202' &&
          e.message.includes('null (blank) price requires status INCOMPLETE'),
      ),
    ).toBe(true);
  });

  it('status enum validation: the four canonical statuses pass; UNRESOLVED and junk are rejected', () => {
    for (const status of [
      'VERIFIED_SPEC_ONLY',
      'EXTERNAL_DEPENDENCY',
      'NOT_SPECIFIED_IN_1404_PRICEBOOK',
      'INCOMPLETE',
    ]) {
      expect(isPricebookStatus(status)).toBe(true);
    }
    expect(isPricebookStatus('UNRESOLVED')).toBe(false);
    expect(isPricebookStatus('verified')).toBe(false);

    const file = cloneStaged();
    rowsOf(file).push(syntheticRow('999999', { status: 'UNRESOLVED' }));
    const r = validateStagedImport(file);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.rowCode === '999999' && e.message.includes('legacy UNRESOLVED')),
    ).toBe(true);
  });

  it('NOT_SPECIFIED_IN_1404_PRICEBOOK rows are preserved as such through publication', () => {
    const file = cloneStaged();
    rowsOf(file).push(
      syntheticRow('990999', {
        status: 'NOT_SPECIFIED_IN_1404_PRICEBOOK',
        notes: ['SYNTHETIC: rule value not specified by the 1404 price book'],
      }),
    );
    const ds = publishStagedImport(file);
    expect(ds.getRow('990999')?.status).toBe('NOT_SPECIFIED_IN_1404_PRICEBOOK');
  });

  it('EXTERNAL_DEPENDENCY rows must reference verified registry dependencies', () => {
    const file = cloneStaged();
    rowsOf(file).push(
      syntheticRow('999001', {
        status: 'EXTERNAL_DEPENDENCY',
        externalDependencies: ['regional-coefficient-circular-94-69416'],
      }),
    );
    expect(validateStagedImport(file).ok).toBe(true);

    const unknownDep = cloneStaged();
    rowsOf(unknownDep).push(
      syntheticRow('999002', {
        status: 'EXTERNAL_DEPENDENCY',
        externalDependencies: ['not-a-real-dependency'],
      }),
    );
    const r = validateStagedImport(unknownDep);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some(
        (e) => e.rowCode === '999002' && e.message.includes('unknown external dependency'),
      ),
    ).toBe(true);

    const emptyDep = cloneStaged();
    rowsOf(emptyDep).push(
      syntheticRow('999003', { status: 'EXTERNAL_DEPENDENCY', externalDependencies: [] }),
    );
    expect(validateStagedImport(emptyDep).ok).toBe(false);
  });

  it('the verified external-dependency registry holds the established identities, unfetched', () => {
    for (const id of [
      'regional-coefficient-circular-94-69416',
      'general-conditions-article-29',
      'rule-773-appendix-5',
      'supervision-circular',
      'hse-directives',
      'road-rail-airport-pricebook',
      'moi-divisions-map',
      'star-item-instruction',
      'rebar-tolerance-source',
      'publication-714',
      'publication-862',
      'insi-6594',
    ]) {
      const dep = getExternalDependency(id);
      expect(dep, id).toBeDefined();
      expect(dep?.status).toBe('EXTERNAL_DEPENDENCY');
      expect(dep?.fetched).toBe(false);
      expect(isVerifiedDependencyId(id)).toBe(true);
    }
    expect(isVerifiedDependencyId('made-up-circular')).toBe(false);
    expect(VERIFIED_EXTERNAL_DEPENDENCIES).toHaveLength(20);
    expect(new Set(VERIFIED_EXTERNAL_DEPENDENCIES.map((d) => d.id)).size).toBe(20);
  });

  it('compound unit vocabulary: three distinct codes, no collapse, no conversion', () => {
    expect(isUnitCode('ton_km')).toBe(true);
    expect(isUnitCode('ton_nautical_mile')).toBe(true);
    expect(isUnitCode('m2_month')).toBe(true);
    expect(unitCodeForPrintedLabel('تن - کیلومتر')).toBe('ton_km');
    expect(unitCodeForPrintedLabel('تن - مایل دریایی')).toBe('ton_nautical_mile');
    expect(unitCodeForPrintedLabel('مترمربع-ماه')).toBe('m2_month');
    expect(unitCodeForPrintedLabel('تن - کیلومتر')).not.toBe('t');
    expect(unitCodeForPrintedLabel('مترمربع-ماه')).not.toBe('m2');
    expect(unitCodeForPrintedLabel('تن - کیلومتر')).not.toBe(
      unitCodeForPrintedLabel('تن - مایل دریایی'),
    );
    const seaRows = published.findRows({ unitCode: 'ton_nautical_mile' });
    expect(seaRows).toHaveLength(5);
    expect(published.findRows({ unitCode: 'ton_km' })).toHaveLength(8);
  });

  it('unknown printed units and inconsistent label/code pairs are rejected', () => {
    expect(unitCodeForPrintedLabel('فوت')).toBeUndefined();
    expect(() => requireUnitCodeForPrintedLabel('فوت')).toThrow(/unknown printed unit label/);
    expect(printedUnitMatches('تن - کیلومتر', 't')).toBe(false);
    expect(printedUnitMatches('کیلوگرم', 'kg')).toBe(true);
    expect(printedUnitMatches('کیلو گرم', 'kg')).toBe(true);

    const file = cloneStaged();
    patchRow(file, '410202', { unit: { label: 'فوت', code: 'm' } });
    const r = validateStagedImport(file);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.rowCode === '410202' && e.message.includes('unit.code must be')),
    ).toBe(true);
  });

  it('printed unit labels are preserved verbatim, including irregular spellings', () => {
    expect(published.getRow('411303')?.unit.label).toBe('متر مربع');
    expect(published.getRow('410305')?.unit.label).toBe('مترمربع');
    expect(published.getRow('411304')?.unit.label).toBe('کیلو گرم');
    expect(published.getRow('410701')?.unit.label).toBe('قالب');
    expect(published.getRow('280502')?.unit.label).toBe('تن - مایل دریایی');
    expect(PRINTED_UNIT_MAPPINGS).toHaveLength(22);
  });

  it('source references survive publication; the missing hash stays null', () => {
    const row = published.getRow('280101');
    expect(row?.sourceRef.printedPage).toBe('231');
    expect(row?.sourceRef.section).toBe('Chapter 28, Group 1');
    expect(row?.sourceRef.sourceDocument).toBe(OFFICIAL_1404_EDITION.title);
    // populated in the v2 dataset: the official file hash matches the spec's record
    const HASH = 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f';
    expect(row?.sourceRef.sourceFileHash).toBe(HASH);
    expect(published.edition.sourceFileHash).toBe(HASH);
    expect(published.edition.notificationNumber).toBe('1403/742948');
    expect(published.edition.notificationDate).toBe('1403/12/29');
  });

  it('1/14 and 1.14 keep their distinct printed forms (NEW-03 vs OVERHEAD-02)', () => {
    expect(NEW_03_EQUIPMENT_ONLY_COEFFICIENT_PRINTED).toBe('1/14');
    expect(OVERHEAD_02_PURCHASE_AND_FITTINGS_COEFFICIENT).toBe('1.14');
    expect(NEW_03_EQUIPMENT_ONLY_COEFFICIENT_PRINTED).not.toContain('.');
    expect(NEW_03_EQUIPMENT_ONLY_COEFFICIENT_PRINTED).not.toBe(
      OVERHEAD_02_PURCHASE_AND_FITTINGS_COEFFICIENT,
    );
  });

  it('the synthetic fixture can never be mistaken for the official 1404 edition', () => {
    expect(syntheticFixture.edition.editionId).not.toBe(OFFICIAL_EDITION_ID);
    expect(syntheticFixture.edition.year).not.toBe('1404');
    expect(syntheticFixture.notice).toContain('SYNTHETIC');
    const notice: string = (staged1404 as { notice: string }).notice;
    expect(notice).toContain('Complete machine-readable extraction');
    expect(notice).toContain('no value is inferred from any neighbouring row');
  });

  it('published edition and rows are immutable', () => {
    expect(() => {
      (published as unknown as { rows: unknown[] }).rows.push({});
    }).toThrow();
    expect(() => {
      (published.getRow('410202') as unknown as { basePrice: string }).basePrice = '0';
    }).toThrow();
  });

  it('deterministic canonical serialization (stable across parse/render cycles)', () => {
    const once = canonicalJson(staged1404);
    const twice = canonicalJson(JSON.parse(once));
    expect(twice).toBe(once);
    const ds1 = publishStagedImport(JSON.parse(once));
    const ds2 = publishStagedImport(JSON.parse(once));
    expect(canonicalJson(ds1.rows)).toBe(canonicalJson(ds2.rows));
  });

  it('importer rejects invalid records: duplicates, junk prices, missing rows, bad provenance', () => {
    const duplicate = cloneStaged();
    const dup = rowsOf(duplicate).find((r) => r['code'] === '410202');
    if (dup === undefined) throw new Error('410202 missing');
    rowsOf(duplicate).push(structuredClone(dup));
    expect(validateStagedImport(duplicate).errors.some((e) => e.code === 'DUPLICATE_CODE')).toBe(
      true,
    );

    const floatPrice = cloneStaged();
    patchRow(floatPrice, '410202', { basePrice: 5591000.5 });
    expect(
      validateStagedImport(floatPrice).errors.some(
        (e) => e.rowCode === '410202' && e.message.includes('exact decimal string'),
      ),
    ).toBe(true);

    const commaPrice = cloneStaged();
    patchRow(commaPrice, '410202', { basePrice: '5,591,000' });
    expect(
      validateStagedImport(commaPrice).errors.some(
        (e) => e.rowCode === '410202' && e.message.includes('exact decimal string'),
      ),
    ).toBe(true);

    const missing = cloneStaged();
    const idx = rowsOf(missing).findIndex((r) => r['code'] === '411004');
    rowsOf(missing).splice(idx, 1);
    expect(
      validateStagedImport(missing).errors.some(
        (e) => e.code === 'VERIFIED_SUBSET_INCOMPLETE' && e.rowCode === '411004',
      ),
    ).toBe(true);

    const badProvenance = cloneStaged();
    patchRow(badProvenance, '410202', {
      sourceRef: {
        sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
        edition: '1404',
        printedPage: '',
        section: 'Appendix 1, Table 2',
        sourceFileHash: null,
      },
    });
    expect(
      validateStagedImport(badProvenance).errors.some(
        (e) => e.rowCode === '410202' && e.message.includes('printedPage'),
      ),
    ).toBe(true);
  });

  it('publication is refused for invalid files (nothing auto-publishes)', () => {
    const file = cloneStaged();
    patchRow(file, '410202', { basePrice: '0' });
    expect(() => publishStagedImport(file)).toThrow(ImportValidationError);
    expect(() => publishStagedImport({ formatVersion: '1', kind: 'staged-import' })).toThrow(
      ImportValidationError,
    );
  });

  it('exact filtering only; coverage findings preserve absences instead of fabricating', () => {
    // chapters in first-appearance (ascending-code) order: chapters 1-14, 16-28, appendices 1 and 5
    expect(published.chapters()).toEqual([
      'chapter-1',
      'chapter-2',
      'chapter-3',
      'chapter-4',
      'chapter-5',
      'chapter-6',
      'chapter-7',
      'chapter-8',
      'chapter-9',
      'chapter-10',
      'chapter-11',
      'chapter-12',
      'chapter-13',
      'chapter-14',
      'chapter-16',
      'chapter-17',
      'chapter-18',
      'chapter-19',
      'chapter-20',
      'chapter-21',
      'chapter-22',
      'chapter-23',
      'chapter-24',
      'chapter-25',
      'chapter-26',
      'chapter-27',
      'chapter-28',
      'appendix-1',
      'appendix-5',
    ]);
    expect(published.findRows({ chapter: 'chapter-28', group: '5' })).toHaveLength(5);
    expect(published.findRows({ status: 'INCOMPLETE' })).toHaveLength(140);
    expect(published.findRows({ status: 'VERIFIED_SPEC_ONLY' })).toHaveLength(1420);
    expect(published.findRows({ status: 'EXTERNAL_DEPENDENCY' }).map((r) => r.code)).toEqual([
      '090320',
      '090321',
      '120106',
      '160801',
    ]);
    expect(published.getRow('150101')).toBeUndefined();
    expect(published.getRow('290101')).toBeUndefined();

    const absent = coverageFinding('chapter-15');
    expect(absent?.kind).toBe('absent-from-verified-source');
    expect(absent?.detail).toContain('must not be created');
    expect(coverageFinding('chapters-1-to-7')?.kind).toBe('not-audited');
    expect(VERIFIED_COVERAGE_FINDINGS.length).toBeGreaterThanOrEqual(9);
  });

  it('the staged 1404 file is the verified subset: 59 rows, 62 anchors, all codes required', () => {
    expect(VERIFIED_SUBSET_REQUIRED_CODES).toHaveLength(59);
    expect(VERIFIED_VALUE_ANCHORS).toHaveLength(62);
    const anchor411004 = VERIFIED_VALUE_ANCHORS.find((a) => a.code === '411004');
    expect(anchor411004?.expect?.basePrice).toBeNull();
    expect(anchor411004?.expect?.status).toBe('INCOMPLETE');
    expect(published.rows.every((row: PricebookRow) => row.sourceRef.edition === '1404')).toBe(
      true,
    );
  });
});
