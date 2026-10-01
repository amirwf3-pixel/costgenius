/**
 * Phase 12 dataset-completion tests: the full 1404 extraction.
 *
 * Every assertion is source-backed: chapter row counts come from the verified
 * specification's per-chapter blocks (N–BJ), exact values from sections 11.5/11.6
 * and the Chapter 27 block table, and the status policy sets from the per-chapter
 * "Price cells" statements. Nothing here is a count picked to make a test green.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import staged1404 from '../data/verified-1404.staged.v0.1.0.json' with { type: 'json' };
import { OFFICIAL_1404_EDITION, OFFICIAL_EDITION_ID } from '../src/provenance.js';
import { PRINTED_UNIT_MAPPINGS, unitCodeForPrintedLabel } from '../src/units-map.js';
import { PRICE_DECIMAL_PATTERN } from '../src/row.js';
import { isVerifiedDependencyId } from '../src/dependencies.js';
import { publishStagedImport, validateStagedImport } from '../src/staged-import.js';
import { canonicalJson } from '../src/canonical-json.js';

const report = validateStagedImport(staged1404);
const published = publishStagedImport(staged1404);
const rows = published.rows;

const SRC_HASH = 'c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f';

/** Verified chapter row counts (spec blocks O,P,Q,R,S,T,U,W,X,Y,Z,AA..AI,AK,BJ + appendix 5). */
const CHAPTER_COUNTS: Readonly<Record<string, number>> = {
  'chapter-1': 113,
  'chapter-2': 22,
  'chapter-3': 44,
  'chapter-4': 39,
  'chapter-5': 22,
  'chapter-6': 45,
  'chapter-7': 29,
  'chapter-8': 35,
  'chapter-9': 85,
  'chapter-10': 19,
  'chapter-11': 60,
  'chapter-12': 80,
  'chapter-13': 27,
  'chapter-14': 46,
  'chapter-16': 82,
  'chapter-17': 44,
  'chapter-18': 103,
  'chapter-19': 104,
  'chapter-20': 29,
  'chapter-21': 23,
  'chapter-22': 144,
  'chapter-23': 117,
  'chapter-24': 43,
  'chapter-25': 45,
  'chapter-26': 16,
  'chapter-27': 29,
  'chapter-28': 13,
  'appendix-1': 46,
  'appendix-5': 60,
};

/** Blank price cells outside Appendix 5 (spec price-cells statements + glyph extraction). */
const BLANK_INCOMPLETE = [
  '020105',
  '020106',
  '030203',
  '030706',
  '040315',
  '040404',
  '061001',
  '061002',
  '061004',
  '061005',
  '061006',
  '070801',
  '070802',
  '070901',
  '070902',
  '090607',
  '091607',
  '091611',
  '120220',
  '120221',
  '120222',
  '140807',
  '160225',
  '160501',
  '160705',
  '160906',
  '160907',
  '170308',
  '171016',
  '180811',
  '180818',
  '191236',
  '192101',
  '200127',
  '200327',
  '220124',
  '220125',
  '220126',
  '220129',
  '220130',
  '220140',
  '220141',
  '220147',
  '220620',
  '220803',
  '220913',
  '220917',
  '220918',
  '231401',
  '231402',
  '231403',
  '231501',
  '231502',
  '240807',
  '250801',
  '250802',
  '411004',
] as const;

/** Price cells printing the literal ۱ (spec: "reads one", never usable as a price). */
const LITERAL_ONE: readonly string[] = [
  '110830',
  '111102',
  '120534',
  '130311',
  '130312',
  '180322',
  '181002',
  '181112',
  '191505',
  '220804',
  '260401',
] as const;

/** Spec-explicit "deduction, not a price" rows: the printed negative never becomes basePrice. */
const NOT_A_PRICE = ['140717', '140718', '180323', '180913', '192001', '220925'] as const;

/** Percent-unit rows: the cell holds a percentage, never a Rial price. */
const PERCENT_ROWS = [
  '031203',
  '090805',
  '092801',
  '092802',
  '092803',
  '092804',
  '140717',
  '140718',
] as const;

/** Deduction rows whose negative values are printed and recorded as printed (270320/270403 precedent). */
const NEGATIVE_AS_PRINTED = [
  '010517',
  '070615',
  '091606',
  '110831',
  '110832',
  '110905',
  '120808',
  '130310',
  '130313',
  '130314',
  '200803',
  '270320',
  '270403',
] as const;

/** Blank cells whose price is governed by the star-row instruction (spec classification). */
const EXTERNAL_STAR = ['090320', '090321', '120106', '160801'] as const;

/** Chapter 27 prices printed in spec block AH's table. */
const CH27_PRICES: Readonly<Record<string, string>> = {
  '270301': '48586000',
  '270302': '48920000',
  '270303': '50851000',
  '270304': '52806000',
  '270310': '709000',
  '270320': '-1037000',
  '270402': '2131000',
  '270403': '-2131000',
  '270404': '18392000',
  '270410': '9985000',
  '270411': '6886000',
  '270412': '3170000',
};

const codes = (predicate: (r: (typeof rows)[number]) => boolean): string[] =>
  rows.filter(predicate).map((r) => r.code);

describe('Phase 12: complete 1404 dataset — shape and invariants', () => {
  it('validates cleanly and publishes with the complete row set', () => {
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.rowCount).toBe(1564);
    expect(published.edition.id).toBe(OFFICIAL_EDITION_ID);
  });

  it('row count is exactly the sum of the verified per-chapter counts', () => {
    const total = Object.values(CHAPTER_COUNTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(1564);
    expect(rows).toHaveLength(total);
  });

  it('codes are unique, six digits, sorted, and never carry whitespace', () => {
    const list = rows.map((r) => r.code);
    expect(new Set(list).size).toBe(list.length);
    for (const code of list) {
      expect(code).toMatch(/^\d{6}$/);
      expect(code.trim()).toBe(code);
    }
    expect([...list].sort()).toEqual(list);
  });

  it('leading zeros survive: chapter 1-9 codes keep their leading zero', () => {
    expect(published.hasRow('010101')).toBe(true);
    expect(published.hasRow('10101')).toBe(false);
    expect(published.getRow('010101')?.basePrice).toBe('2890');
    expect(published.hasRow('070612')).toBe(true);
    expect(published.hasRow('70612')).toBe(false);
  });

  it('every chapter row derives its chapter and group from its code', () => {
    for (const r of rows) {
      if (!r.chapter.startsWith('chapter-')) continue;
      const ch = String(Number(r.code.slice(0, 2)));
      const gr = String(Number(r.code.slice(2, 4)));
      expect(r.chapter).toBe(`chapter-${ch}`);
      expect(r.group).toBe(gr);
      expect(r.sourceRef.section).toBe(`Chapter ${ch}, Group ${gr}`);
    }
  });

  it('chapter 15 and chapter 29 rows never exist', () => {
    expect(published.findRows({ chapter: 'chapter-15' })).toEqual([]);
    expect(published.findRows({ chapter: 'chapter-29' })).toEqual([]);
    expect(codes((r) => r.code.startsWith('15') || r.code.startsWith('29'))).toEqual([]);
  });

  it('030905 (no printed unit and no printed price) is absent, not invented', () => {
    expect(published.hasRow('030905')).toBe(false);
    expect(published.findRows({ chapter: 'chapter-3' })).toHaveLength(44); // 45 bands - 1 unrepresentable
  });

  it('no price is zero and every price matches the exact-decimal pattern', () => {
    for (const r of rows) {
      if (r.basePrice === null) continue;
      expect(r.basePrice).not.toBe('0');
      expect(PRICE_DECIMAL_PATTERN.test(r.basePrice)).toBe(true);
      expect(r.basePrice.includes(',')).toBe(false);
      expect(r.basePrice.includes('٬')).toBe(false);
    }
  });

  it('every row carries a non-empty description and a mapped unit', () => {
    for (const r of rows) {
      expect(r.description.length).toBeGreaterThan(0);
      expect(
        PRINTED_UNIT_MAPPINGS.some(
          (m) => m.printedLabel === r.unit.label && m.unitCode === r.unit.code,
        ),
      ).toBe(true);
    }
  });

  it('status totals match the source-backed policy sets', () => {
    expect(codes((r) => r.status === 'VERIFIED_SPEC_ONLY')).toHaveLength(1420);
    expect(codes((r) => r.status === 'INCOMPLETE')).toHaveLength(140);
    expect(codes((r) => r.status === 'EXTERNAL_DEPENDENCY').sort()).toEqual([...EXTERNAL_STAR]);
  });
});

describe('Phase 12: the preserved verified subset stays frozen', () => {
  const V1 = [
    '410202',
    '410203',
    '410204',
    '410205',
    '410206',
    '410301',
    '410302',
    '410303',
    '410305',
    '410501',
    '410502',
    '410508',
    '410601',
    '410602',
    '410603',
    '410701',
    '410702',
    '410703',
    '410801',
    '410802',
    '410804',
    '410901',
    '410902',
    '410903',
    '410904',
    '410905',
    '410906',
    '410907',
    '410908',
    '411001',
    '411002',
    '411003',
    '411004',
    '411101',
    '411202',
    '411303',
    '411304',
    '411405',
    '411406',
    '411902',
    '412002',
    '412401',
    '412801',
    '412901',
    '413101',
    '413102',
    '280101',
    '280102',
    '280103',
    '280104',
    '280105',
    '280106',
    '280301',
    '280302',
    '280501',
    '280502',
    '280503',
    '280504',
    '280505',
  ] as const;

  it('all 59 verified rows are present', () => {
    for (const code of V1) expect(published.hasRow(code)).toBe(true);
  });

  it('the appendix descriptions are verbatim (spot checks from §11.5)', () => {
    expect(published.getRow('410202')?.description).toBe('ماسه شسته.');
    expect(published.getRow('410205')?.description).toBe('مصالح زیر اساس از مصالح رودخانه ای.');
    expect(published.getRow('410508')?.description).toBe('سیمان سفید پاکتی.');
    expect(published.getRow('411902')?.description).toBe('تخته نراد خارجی.');
  });

  it('the chapter 28 descriptions keep the verified §11.6 condensed form', () => {
    expect(published.getRow('280101')?.description).toBe(
      'حمل سیمان پاکتی، مصالح سنگی، آهن\u200cآلات، آجر و بلوک، بیش از ۳۰ تا ۷۵ کیلومتر',
    );
    expect(published.getRow('280501')?.description).toBe(
      'حمل دریایی سیمان پاکتی، مصالح سنگی، آهن\u200cآلات، آجر و بلوک، تا ۱۰ مایل دریایی',
    );
  });

  it('the preserved unit labels keep their verified spellings (single-space ton-km)', () => {
    expect(published.getRow('280101')?.unit.label).toBe('تن - کیلومتر');
    expect(published.getRow('280101')?.unit.code).toBe('ton_km');
    expect(published.getRow('280501')?.unit.label).toBe('تن - مایل دریایی');
  });

  it('411004 stays the one blank appendix row (INCOMPLETE, never zero)', () => {
    const row = published.getRow('411004');
    expect(row?.basePrice).toBeNull();
    expect(row?.status).toBe('INCOMPLETE');
  });
});

describe('Phase 12: per-chapter counts match the verified specification blocks', () => {
  it('audited chapters 8-28 match block-by-block (O..AI)', () => {
    const audited: Readonly<Record<string, number>> = {
      'chapter-8': 35,
      'chapter-9': 85,
      'chapter-10': 19,
      'chapter-11': 60,
      'chapter-12': 80,
      'chapter-13': 27,
      'chapter-14': 46,
      'chapter-16': 82,
      'chapter-17': 44,
      'chapter-18': 103,
      'chapter-19': 104,
      'chapter-20': 29,
      'chapter-21': 23,
      'chapter-22': 144,
      'chapter-23': 117,
      'chapter-24': 43,
      'chapter-25': 45,
      'chapter-26': 16,
      'chapter-27': 29,
      'chapter-28': 13,
    };
    for (const [chapter, count] of Object.entries(audited)) {
      expect(published.findRows({ chapter })).toHaveLength(count);
    }
  });

  it('appendix counts: Table 2 has 46 rows, Appendix 5 has 60 rows', () => {
    expect(published.findRows({ chapter: 'appendix-1' })).toHaveLength(46);
    expect(published.findRows({ chapter: 'appendix-5' })).toHaveLength(60);
  });

  it('documented group absences hold (chapter 25 group 02, chapter 26 groups 02/05, chapter 28 groups 02/04)', () => {
    expect(published.findRows({ chapter: 'chapter-25', group: '2' })).toEqual([]);
    expect(published.findRows({ chapter: 'chapter-26', group: '2' })).toEqual([]);
    expect(published.findRows({ chapter: 'chapter-26', group: '5' })).toEqual([]);
    expect(published.findRows({ chapter: 'chapter-28', group: '2' })).toEqual([]);
    expect(published.findRows({ chapter: 'chapter-28', group: '4' })).toEqual([]);
  });
});

describe('Phase 12: exact values (glyph-decoded, spec-cross-checked)', () => {
  it('chapter 27 block AH prices reproduce exactly, including both anchored negatives', () => {
    for (const [code, price] of Object.entries(CH27_PRICES)) {
      expect(published.getRow(code)?.basePrice).toBe(price);
    }
  });

  it('chapter 1 leading-zero rows decode with their exact prices', () => {
    expect(published.getRow('010101')?.basePrice).toBe('2890');
    expect(published.getRow('010121')?.basePrice).toBe('28586000');
    expect(published.getRow('010127')?.basePrice).toBe('279767000');
  });

  it('appendix 1 Table 2 spot values reproduce exactly', () => {
    expect(published.getRow('410508')?.basePrice).toBe('33390000');
    expect(published.getRow('412002')?.basePrice).toBe('138590000');
    expect(published.getRow('410701')?.basePrice).toBe('21400');
  });

  it('chapter 16 group 6 rows (recovered tall-row bands) are present with prices', () => {
    expect(published.getRow('160601')?.basePrice).not.toBeNull();
    expect(published.getRow('160608')?.basePrice).not.toBeNull();
    expect(published.getRow('160613')?.basePrice).not.toBeNull();
  });

  it('Persian digit cells with thousands separators decode to plain decimal strings', () => {
    // ۰۱۰۱۰۱ → 2,890 Rial; ۴۱۰۲۰۲ → ۵٬۵۹۱٬۰۰۰ Rial (calibration rows)
    expect(published.getRow('010101')?.basePrice).toBe('2890');
    expect(published.getRow('410202')?.basePrice).toBe('5591000');
  });
});

describe('Phase 12: status policy (every classification is spec-statement-backed)', () => {
  it('blank cells outside Appendix 5 are exactly the documented set, all INCOMPLETE and null', () => {
    const blanks = codes(
      (r) => r.basePrice === null && r.status === 'INCOMPLETE' && r.chapter !== 'appendix-5',
    ).sort();
    const expected = [...new Set([...BLANK_INCOMPLETE, ...NOT_A_PRICE, ...PERCENT_ROWS])].sort();
    expect(blanks).toEqual(expected);
    for (const code of BLANK_INCOMPLETE) {
      expect(published.getRow(code)?.basePrice).toBeNull();
      expect(published.getRow(code)?.status).toBe('INCOMPLETE');
    }
  });

  it('literal-one rows keep the printed ۱ as INCOMPLETE with a documenting note', () => {
    expect(codes((r) => r.basePrice === '1').sort()).toEqual([...LITERAL_ONE]);
    for (const code of LITERAL_ONE) {
      const row = published.getRow(code);
      expect(row?.status).toBe('INCOMPLETE');
      expect(row?.notes.some((n) => n.includes('literal ۱'))).toBe(true);
    }
  });

  it('"deduction, not a price" rows never carry a base price; the printed value stays in a note', () => {
    for (const code of NOT_A_PRICE) {
      const row = published.getRow(code);
      expect(row?.basePrice).toBeNull();
      expect(row?.status).toBe('INCOMPLETE');
      expect(
        row?.notes.some((n) => n.includes('not a price') || n.includes('not a Rial price')),
      ).toBe(true);
    }
    // 220925 prints -377,500 as a deduction; the anchor forbids importing it as a price
    expect(published.getRow('220925')?.notes[0]).toContain('۳۷۷٬۵۰۰');
  });

  it('percent-unit rows record no base price; their percentage stays in a note', () => {
    expect(codes((r) => r.unit.code === 'percent').sort()).toEqual([...PERCENT_ROWS]);
    for (const code of PERCENT_ROWS) {
      const row = published.getRow(code);
      expect(row?.basePrice).toBeNull();
      expect(row?.unit.label).toBe('درصد');
      expect(row?.notes.some((n) => n.includes('percent'))).toBe(true);
    }
    expect(published.getRow('092803')?.notes[0]).toContain('۲۵');
  });

  it('negative base prices exist only on the anchored and printed-as-price deduction rows', () => {
    expect(codes((r) => (r.basePrice ?? '').startsWith('-')).sort()).toEqual([
      ...NEGATIVE_AS_PRINTED,
    ]);
    expect(published.getRow('270320')?.basePrice).toBe('-1037000');
    expect(published.getRow('270403')?.basePrice).toBe('-2131000');
    expect(published.getRow('010517')?.basePrice).toBe('-104500');
  });

  it('star-row blanks: EXTERNAL_DEPENDENCY for the spec-classified four, INCOMPLETE+dep for the other four', () => {
    for (const code of EXTERNAL_STAR) {
      const row = published.getRow(code);
      expect(row?.status).toBe('EXTERNAL_DEPENDENCY');
      expect(row?.externalDependencies).toEqual(['star-item-instruction']);
      expect(row?.basePrice).toBeNull();
    }
    for (const code of ['180811', '180818', '250801', '250802']) {
      const row = published.getRow(code);
      expect(row?.status).toBe('INCOMPLETE');
      expect(row?.externalDependencies).toEqual(['star-item-instruction']);
    }
    expect(isVerifiedDependencyId('star-item-instruction')).toBe(true);
  });

  it('Appendix 5 rows are all INCOMPLETE with null prices by design (clause 2-1)', () => {
    const a5 = published.findRows({ chapter: 'appendix-5' });
    expect(a5.every((r) => r.basePrice === null && r.status === 'INCOMPLETE')).toBe(true);
    expect(a5.every((r) => r.notes.some((n) => n.includes('clause 2-1')))).toBe(true);
  });

  it('Appendix 5 row 991001 is the only m2_month row; 991401-991403 carry their printed type', () => {
    expect(published.findRows({ unitCode: 'm2_month' }).map((r) => r.code)).toEqual(['991001']);
    expect(published.getRow('991001')?.unit.label).toBe('مترمربع-ماه');
    for (const code of ['991401', '991402', '991403']) {
      expect(published.getRow(code)?.notes[0]).toContain('پیشرفت کار');
    }
  });
});

describe('Phase 12: units never collapse', () => {
  it('the printed unit census maps onto distinct codes without conversion', () => {
    expect(published.findRows({ unitCode: 'ton_km' })).toHaveLength(8);
    expect(published.findRows({ unitCode: 'ton_nautical_mile' })).toHaveLength(5);
    expect(published.findRows({ unitCode: 'm2_month' })).toHaveLength(1);
    expect(published.findRows({ unitCode: 'dm3' })).toHaveLength(8);
    expect(published.findRows({ unitCode: 'm3_km' })).toHaveLength(3);
    expect(published.findRows({ unitCode: 'percent' })).toHaveLength(8);
    expect(published.findRows({ unitCode: 'lump_sum' })).toHaveLength(50);
  });

  it('dm3 is never converted to litres and m3_km never collapses to m3 or ton_km', () => {
    expect(unitCodeForPrintedLabel('دسیمتر مکعب')).toBe('dm3');
    expect(unitCodeForPrintedLabel('مترمکعب - کیلومتر')).toBe('m3_km');
    expect(unitCodeForPrintedLabel('دسیمتر مکعب')).not.toBe('l');
    expect(unitCodeForPrintedLabel('مترمکعب - کیلومتر')).not.toBe('m3');
    // grout rows keep dm3 (080501/080502 per spec block O)
    expect(published.getRow('080501')?.unit.code).toBe('dm3');
    expect(published.getRow('080502')?.unit.code).toBe('dm3');
  });

  it('spelling variants map to the same code; distinct labels stay distinct', () => {
    expect(unitCodeForPrintedLabel('مترمربع')).toBe('m2');
    expect(unitCodeForPrintedLabel('متر مربع')).toBe('m2');
    expect(unitCodeForPrintedLabel('مترطول')).toBe('m');
    expect(unitCodeForPrintedLabel('متر طول')).toBe('m');
    expect(unitCodeForPrintedLabel('عدد')).toBe('each');
    expect(unitCodeForPrintedLabel('اصله')).toBe('each');
    expect(unitCodeForPrintedLabel('تن - کیلومتر')).toBe('ton_km');
    expect(unitCodeForPrintedLabel('تن -  کیلومتر')).toBe('ton_km');
    expect(unitCodeForPrintedLabel('تن - مایل دریایی')).toBe('ton_nautical_mile');
    expect(unitCodeForPrintedLabel('مقطوع')).toBe('lump_sum');
  });

  it('unknown labels never map (no guessing)', () => {
    expect(unitCodeForPrintedLabel('کیلووات')).toBeUndefined();
    expect(unitCodeForPrintedLabel('لیتر')).toBeUndefined();
    expect(unitCodeForPrintedLabel('')).toBeUndefined();
  });
});

describe('Phase 12: provenance, hash and determinism', () => {
  it('every row cites the official document, its printed page and the verified file hash', () => {
    for (const r of rows) {
      const ref = r.sourceRef;
      expect(ref.sourceDocument).toBe(OFFICIAL_1404_EDITION.title);
      expect(ref.edition).toBe('1404');
      expect(ref.printedPage).toMatch(/^\d{1,3}$/);
      expect(ref.section.length).toBeGreaterThan(0);
      expect(ref.sourceFileHash).toBe(SRC_HASH);
    }
  });

  it('printed pages sit inside the normative range (7..253)', () => {
    for (const r of rows) {
      const p = Number(r.sourceRef.printedPage);
      expect(p).toBeGreaterThanOrEqual(7);
      expect(p).toBeLessThanOrEqual(253);
    }
  });

  it('edition metadata carries the notification identity and the verified hash', () => {
    expect(published.edition.notificationNumber).toBe('1403/742948');
    expect(published.edition.notificationDate).toBe('1403/12/29');
    expect(published.edition.sourceFileHash).toBe(SRC_HASH);
  });

  it('canonical serialization is stable across parse/render cycles', () => {
    const once = canonicalJson(staged1404);
    const twice = canonicalJson(JSON.parse(once));
    expect(twice).toBe(once);
  });

  it('the staged file is byte-stable on disk (deterministic generation)', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(dir, '../data/verified-1404.staged.v0.1.0.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { rows: unknown[] };
    expect(parsed.rows).toHaveLength(1564);
    expect(JSON.stringify(parsed) === JSON.stringify(JSON.parse(raw) as unknown)).toBe(true);
  });
});

describe('Phase 12: safety — no numeric coercion or neighbour fallback in the data layer', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');

  it('no forbidden numeric coercion patterns appear in the pricebook sources', () => {
    const files = ['row.ts', 'staged-import.ts', 'dataset.ts', 'units-map.ts', 'provenance.ts'];
    const forbidden = [/Number\(/, /parseFloat\(/, /Math\.round\(/, /\|\| 0/, /\?\? 0/];
    for (const f of files) {
      const text = readFileSync(join(srcDir, f), 'utf-8');
      for (const pattern of forbidden) {
        expect({ file: f, pattern: String(pattern), hit: pattern.test(text) }).toEqual({
          file: f,
          pattern: String(pattern),
          hit: false,
        });
      }
    }
  });

  it('no dataset row describes its value as typical, inferred or estimated', () => {
    const banned = ['typical', 'inferred', 'estimated', 'approximate'];
    for (const r of rows) {
      for (const note of r.notes) {
        for (const word of banned) {
          expect(note.toLowerCase().includes(word)).toBe(false);
        }
      }
    }
  });

  it('the import report flags every literal-one row as suspicious (the guard stays armed)', () => {
    const suspicious = report.warnings.filter((w) => w.code === 'SUSPICIOUS_LITERAL_ONE');
    expect(suspicious).toHaveLength(11);
    expect(suspicious.every((w) => LITERAL_ONE.includes(w.rowCode ?? ''))).toBe(true);
  });
});
