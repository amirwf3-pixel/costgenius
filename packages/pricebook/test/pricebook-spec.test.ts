/**
 * Validates CG-IR-PB@0.1.0 specification artefacts: the SYNTHETIC fixture and the spec document.
 * The checks below are test-only expressions of spec §7 rules; no production importer exists yet.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fixture from '../spec/fixtures/synthetic-edition.v0.1.0.json' with { type: 'json' };

const spec = readFileSync(
  new URL('../spec/CG-IR-PRICEBOOK-SPEC@0.1.0.md', import.meta.url),
  'utf8',
).replace(/[ \t]+/g, ' ');
const UNIT_CODES = ['m', 'm2', 'm3', 'kg', 't', 'l', 'each', 'lump_sum'];
const f = fixture as unknown as {
  notice: string;
  edition: { year: string; status: string; sourceFiles: { sha256: string }[] };
  chapters: { chapterNo: string; source: Record<string, unknown>; status: string }[];
  unitMappings: { printedLabel: string; unitCode: string; status: string }[];
  items: {
    itemCode: string;
    chapterNo: string;
    description: string;
    unitLabel: string;
    basePrice: string;
    source: Record<string, unknown>;
    status: string;
  }[];
  coefficientDefinitions: {
    kind: string;
    structure: string;
    status: string;
    source: Record<string, unknown>;
  }[];
};

describe('synthetic fixture is clearly fictitious', () => {
  it('is labelled synthetic and uses SYN identifiers', () => {
    expect(f.notice).toMatch(/SYNTHETIC/);
    expect(f.edition.year).toBe('SYN');
    f.items.forEach((i) => {
      expect(i.itemCode).toMatch(/^SYN-\d{4}$/);
    });
  });
  it('is in staging and nothing is verified', () => {
    expect(f.edition.status).toBe('staging');
    [...f.chapters, ...f.items, ...f.unitMappings, ...f.coefficientDefinitions].forEach((r) => {
      expect(r.status).toBe('unverified');
    });
  });
});

describe('fixture satisfies spec §7 validation rules', () => {
  it('PB-V1 unique item codes', () => {
    const codes = f.items.map((i) => i.itemCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it('PB-V2 items belong to existing chapters', () => {
    const ch = new Set(f.chapters.map((c) => c.chapterNo));
    f.items.forEach((i) => {
      expect(ch).toContain(i.chapterNo);
    });
  });
  it('PB-V3 base prices are non-negative integer Rial strings', () => {
    f.items.forEach((i) => {
      expect(i.basePrice).toMatch(/^(0|[1-9]\d*)$/);
    });
  });
  it('PB-V4 every unit label is mapped to a domain UnitCode', () => {
    const map = new Map(f.unitMappings.map((m) => [m.printedLabel, m.unitCode]));
    f.items.forEach((i) => {
      expect(UNIT_CODES).toContain(map.get(i.unitLabel));
    });
  });
  it('PB-V5 every item and chapter has a complete SourceRef bound to a source file hash', () => {
    const hashes = new Set(f.edition.sourceFiles.map((s) => s.sha256));
    [...f.items, ...f.chapters].forEach((r) => {
      for (const k of [
        'sourceDocument',
        'edition',
        'page',
        'section',
        'sourceFileId',
        'sourceFileHash',
      ])
        expect(r.source).toHaveProperty(k);
      expect(hashes).toContain(r.source['sourceFileHash']);
    });
  });
  it('PB-V7 descriptions are non-empty', () => {
    f.items.forEach((i) => {
      expect(i.description.trim()).not.toBe('');
    });
  });
  it('coefficients are definition-only, unstructured and not machine-applicable in 0.1.0', () => {
    f.coefficientDefinitions.forEach((c) => {
      expect(c.structure).toBe('unstructured');
      expect(Object.keys(c.source).sort()).toEqual([
        'edition',
        'page',
        'section',
        'sourceDocument',
      ]);
    });
  });
});

describe('spec document', () => {
  it('records the verified 1404 edition identity and facts F1–F9 with source fields', () => {
    for (const v of ['1403/742948', '1403/12/29']) expect(spec).toContain(v);
    for (let i = 1; i <= 9; i++) {
      const row = spec.split('\n').find((r) => r.startsWith(`| F${String(i)} |`));
      expect(row, `F${String(i)}`).toBeDefined();
      expect(row).toMatch(/\| 1404 \| [125] \| (clause|clauses|General Requirements, clause) /);
    }
  });

  it('forbids fabricated data and defines the approval pipeline', () => {
    expect(spec).toContain(
      'No price, item code, description, coefficient or rule may be typed in, generated or inferred',
    );
    for (const step of [
      'INGEST',
      'EXTRACT',
      'NORMALISE',
      'VALIDATE',
      'REVIEW',
      'APPROVE',
      'PUBLISH',
    ])
      expect(spec).toContain(step);
  });
  it('separates Item Master from Price Book', () => {
    expect(spec).toMatch(/\*\*Item Master\*\*.*\| \*\*No\*\* \|/);
  });
  it('represents every required 1404 concept separately (C1–C9)', () => {
    for (const c of ['C1a', 'C1b', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'])
      expect(spec).toContain(`| ${c} |`);
  });
  it('verification table carries source fields for every row', () => {
    const table = spec.slice(spec.indexOf('| Topic | sourceDocument'), spec.indexOf('## 11.'));
    const rows = table
      .split('\n')
      .filter((r) => r.startsWith('|') && !/^\| ?-/.test(r) && !r.startsWith('| Topic'));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    rows.forEach((r) => {
      expect(r.split('|').length - 2).toBe(5);
    });
  });
});

describe('verified Iranian rules — 1404 (estimation components)', () => {
  const section = spec.slice(
    spec.indexOf('## 11. Verified Iranian Rules'),
    spec.indexOf('## 12. Calculation Engine Implementation Contract'),
  );
  const rows = section
    .split('\n')
    .filter((r) => r.startsWith('| IR-1404-E-'))
    .map((r) =>
      r
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  const byId = (id: string): string[] => {
    const r = rows.find((x) => x[0] === id);
    if (!r) throw new Error(`missing ${id}`);
    return r;
  };
  const stmt = (id: string): string => byId(id)[5] ?? '';

  it('has the expected rules with full source metadata', () => {
    expect(rows.map((r) => r[0])).toEqual([
      'IR-1404-E-FLOW-01',
      'IR-1404-E-APPLY-01',
      'IR-1404-E-FLOOR-01',
      'IR-1404-E-FLOOR-02',
      'IR-1404-E-FLOOR-03',
      'IR-1404-E-OVERHEAD-01',
      'IR-1404-E-OVERHEAD-02',
      'IR-1404-E-GENERAL-10-01',
      'IR-1404-E-STAR-01',
      'IR-1404-E-STAR-02',
      'IR-1404-E-STAR-03',
      'IR-1404-E-OVERHEAD-COST-01',
      'IR-1404-E-OVERHEAD-COST-02',
      'IR-1404-E-OVERHEAD-COST-03',
      'IR-1404-E-OVERHEAD-COST-04',
      'IR-1404-E-OVERHEAD-COST-05',
      'IR-1404-E-REGION-01',
      'IR-1404-E-SITE-01',
      'IR-1404-E-SITE-02',
      'IR-1404-E-NEW-01',
      'IR-1404-E-NEW-02',
      'IR-1404-E-NEW-03',
      'IR-1404-E-NEW-04',
      'IR-1404-E-ONSITE-01',
      'IR-1404-E-ONSITE-02',
      'IR-1404-E-ONSITE-03',
      'IR-1404-E-ONSITE-04',
      'IR-1404-E-ONSITE-05',
      'IR-1404-E-ONSITE-06',
      'IR-1404-E-ONSITE-07',
      'IR-1404-E-ONSITE-T2-01',
      'IR-1404-E-ONSITE-T2-02',
      'IR-1404-E-TRANSPORT-01',
      'IR-1404-E-TRANSPORT-02',
      'IR-1404-E-TRANSPORT-03',
      'IR-1404-E-TRANSPORT-04',
      'IR-1404-E-TRANSPORT-QTY-01',
    ]);
    for (const r of rows) {
      expect(r).toHaveLength(9);
      expect(r[1]).toBe('فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴');
      expect(r[2]).toBe('1404');
      expect(r[3]).toMatch(/^(\d+(–\d+)?)(; \d+(–\d+)?)*$/);
      expect(r[4]).toMatch(
        /^(Appendix [1-6] — |Application Instructions|General Rules \(کلیات\)|Chapter 28 — )/,
      );
      expect(r[8]).toBe('VERIFIED_SPEC_ONLY');
    }
    expect(section).toContain('c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f');
  });

  it('cites the verified printed pages and clauses', () => {
    const cite = (id: string) => byId(id).slice(3, 5);
    expect(cite('IR-1404-E-FLOW-01')).toEqual(['2–3', 'Application Instructions, clause 2-8']);
    expect(cite('IR-1404-E-FLOOR-01')[0]).toBe('239–240');
    expect(cite('IR-1404-E-FLOOR-02')).toEqual([
      '240',
      'Appendix 2 — Floor Coefficient (ضریب طبقات), Note 4',
    ]);
    expect(cite('IR-1404-E-FLOOR-03')).toEqual([
      '239',
      'Appendix 2 — Floor Coefficient (ضریب طبقات), clause 1-4',
    ]);
    expect(cite('IR-1404-E-OVERHEAD-01')).toEqual([
      '2',
      'Application Instructions, clauses 2-7-2 and 2-7-5 (Table A)',
    ]);
    expect(cite('IR-1404-E-SITE-01')[0]).toBe('2; 246–247');
    expect(cite('IR-1404-E-SITE-02')).toEqual([
      '248',
      'Appendix 5 — Site setup/removal, clauses 4-1, 4-2, 4-3',
    ]);
    for (const id of [
      'IR-1404-E-NEW-01',
      'IR-1404-E-NEW-02',
      'IR-1404-E-NEW-03',
      'IR-1404-E-NEW-04',
    ]) {
      expect(cite(id)[0]).toBe('254');
    }
  });

  // 1. formula structure
  it('P formula matches the verified source structure', () => {
    expect(section).toContain(
      'P = 1 + [(1×F1 + 2×F2 + … + n×Fn) + (1×B1 + 2×B2 + … + m×Bm)] / (100 × S)',
    );
    expect(section).not.toContain('UNVERIFIED_IMAGE_REQUIRED');
  });

  // 2. worked example, recomputed exactly from the spec's own JSON
  it('P worked example gives 1.0451', () => {
    const start = section.indexOf('```json', section.indexOf('Worked example')) + '```json'.length;
    const ex = JSON.parse(section.slice(start, section.indexOf('```', start))) as {
      belowB0: { level: string; area: string }[];
      aboveF0: { level: string; area: string }[];
      B0: string;
      F0: string;
      S: string;
      weightedSum: string;
      unrounded: string;
      P: string;
    };
    const weight = (l: string): bigint => BigInt(l.slice(1));
    const weighted = [...ex.aboveF0, ...ex.belowB0].reduce(
      (a, f) => a + weight(f.level) * BigInt(f.area),
      0n,
    );
    const S = [...ex.aboveF0, ...ex.belowB0].reduce(
      (a, f) => a + BigInt(f.area),
      BigInt(ex.B0) + BigInt(ex.F0),
    );
    expect(weighted.toString()).toBe(ex.weightedSum);
    expect(S.toString()).toBe(ex.S);
    // P scaled by 10^6 exactly (truncated), then the source rule at 4 decimals
    const scaled6 = 1_000_000n + (weighted * 1_000_000n) / (100n * S); // 1045131
    const fifthRounded = (scaled6 + 50n) / 100n; // 4 decimals, +1 if 5th decimal ≥ 5
    expect(
      `${String(fifthRounded / 10000n)}.${String(fifthRounded % 10000n).padStart(4, '0')}`,
    ).toBe(ex.P);
    expect(ex.P).toBe('1.0451');
    expect(ex.unrounded).toBe('1.045132');
  });

  // 3–5
  it('landscaping and on-site materials are excluded from P', () => {
    expect(byId('IR-1404-E-FLOOR-01')[6]).toBe(
      "Per building; the building's work items; NOT landscaping; NOT on-site materials",
    );
    expect(stmt('IR-1404-E-FLOOR-01')).toContain('excluding landscaping items');
    expect(stmt('IR-1404-E-FLOOR-01')).toContain(
      'except on-site materials, from the first progress statement (Note 3)',
    );
    expect(stmt('IR-1404-E-FLOOR-01')).toContain(
      'Landscaping = all building work or mechanical/electrical installations performed outside the building (Note 2)',
    );
    expect(stmt('IR-1404-E-FLOOR-01')).toContain(
      'main ground floor in the initial drawings is used (Note 1)',
    );
  });

  it('above-ground and below-ground floors are distinct', () => {
    expect(stmt('IR-1404-E-FLOOR-01')).toContain(
      'Each above-ground floor area Fi is multiplied by i (1, 2, 3 … n) (1-1)',
    );
    expect(stmt('IR-1404-E-FLOOR-01')).toContain(
      'each floor area Bj below the floor under the ground floor is multiplied by j (1, 2, 3 … m) (1-2)',
    );
    expect(section).toContain('F0 = ground floor area');
    expect(section).toContain('B0 = area of the floor below the ground floor');
  });

  // 6
  it('P uses S as defined by the source', () => {
    expect(section).toContain(
      'S = total floor area of the building, including ground floor, B0, all floors above the ground floor and all floors below B0',
    );
    expect(section).toContain('F0 and B0 carry no weight in the numerator but are included in S.');
  });

  // 7
  it('P rounds according to the source rule', () => {
    expect(stmt('IR-1404-E-FLOOR-02')).toBe(
      'P is taken with four decimal places: if the fifth decimal is less than 5 it is dropped; if it is 5 or more, one unit is added to the fourth decimal.',
    );
    expect(byId('IR-1404-E-FLOOR-02')[6]).toContain('The floor coefficient P only');
  });

  // 8
  it('P recalculation follows the verified execution-change conditions', () => {
    const t = stmt('IR-1404-E-FLOOR-03');
    expect(t).toContain(
      'P is recalculated once and applied in the final progress statement, provided P was included in the estimate',
    );
    expect(t).toContain('creates entitlement to P, it is calculated and applied');
  });

  // 9
  it('coefficients are applied sequentially, then site setup is added', () => {
    const t = stmt('IR-1404-E-FLOW-01');
    expect(t).toContain(
      'Row amount = quantity × unit price; chapter amount = sum of its row amounts',
    );
    expect(t).toContain('multiplied successively (به صورت پی در پی)');
    expect(t.indexOf('multiplied successively')).toBeLessThan(
      t.indexOf('site setup/removal cost is then added'),
    );
  });

  // 10
  it('overhead values map only to their verified classifications', () => {
    const t = stmt('IR-1404-E-OVERHEAD-01');
    expect(t).toContain(
      'Capital plans (طرح‌های عمرانی): tender, or no tender due to monopoly → 1.30; tender formalities waived, or no tender for reasons other than monopoly → 1.20',
    );
    expect(t).toContain(
      'Non-capital plans (طرح‌های غیرعمرانی): tender, or no tender due to monopoly → 1.41; tender formalities waived, or no tender for reasons other than monopoly → 1.30',
    );
    expect(t.match(/→ \d\.\d+/g)).toEqual(['→ 1.30', '→ 1.20', '→ 1.41', '→ 1.30']);
    expect(t).toContain('Appendix 3 gives the breakdown of overhead items as guidance');
  });

  // 11
  it('construction overhead is not confused with purchase-chapter 1.14', () => {
    expect(stmt('IR-1404-E-OVERHEAD-01')).not.toContain('1.14');
    expect(byId('IR-1404-E-OVERHEAD-02')[6]).toBe(
      'Purchase chapters only; NOT ordinary construction overhead',
    );
    expect(section).toContain('must not be used as ordinary construction overhead');
  });

  // 12–13
  it('site setup/removal maximum for ابنیه is 4% of cost excluding setup', () => {
    const t = stmt('IR-1404-E-SITE-01');
    expect(t).toContain('Maximum for ابنیه = 4% (Table A)');
    expect(t).toContain('excluding site setup/removal costs (2-17-1)');
    expect(t).toContain('rows 990104, 990301–990303 and 991001–991104');
    expect(t).toContain(
      'approval of the High Technical Council (شورای عالی فنی) before award (2-17)',
    );
    expect(byId('IR-1404-E-SITE-01')[6]).toContain(
      'separate from ordinary work quantities and takeoff',
    );
  });

  it('multiple-price-list site setup follows the verified rule', () => {
    expect(stmt('IR-1404-E-SITE-01')).toContain(
      'maximum = Σ (percentage for each price list × estimated execution cost under that price list, excluding site setup/removal) (2-17-2)',
    );
  });

  it('site setup payment splits are recorded as verified', () => {
    const t = stmt('IR-1404-E-SITE-02');
    expect(t).toContain('70% with construction progress, 30% for upkeep/operation');
    expect(t).toContain('30% with foundation/installation, 70% for upkeep/operation');
    expect(t).toContain(
      'rows 990101, 990102, 990103, 990301, 990302: 15% with progress of the related operations, 85% for upkeep/operation',
    );
    expect(t).toContain('Removal cost is paid after removal is completed (4-3)');
  });

  // 14–15
  it('equipment-only new work uses 1.14 only, and 1.14 is not generalised', () => {
    expect(stmt('IR-1404-E-NEW-03')).toContain('only overhead coefficient 1.14 is applied');
    expect(byId('IR-1404-E-NEW-03')[6]).toMatch(
      /^ONLY officially approved new work consisting solely of equipment purchase; 1\.14 is not applicable to ordinary new works$/,
    );
    const with114 = rows.filter((r) => (r[5] ?? '').includes('1.14')).map((r) => r[0]);
    expect(with114).toEqual(['IR-1404-E-OVERHEAD-02', 'IR-1404-E-NEW-03']);
    expect(stmt('IR-1404-E-NEW-02')).not.toContain('1.14');
  });

  // 16–17
  it('new-work 25% cap and extra site-setup cap are specification rules', () => {
    expect(stmt('IR-1404-E-NEW-02')).toContain(
      'together with quantity increases under Article 29(a) may not exceed 25% of the initial contract amount',
    );
    expect(stmt('IR-1404-E-NEW-04')).toContain(
      "up to 25% of the contract's lump-sum site setup/removal amount",
    );
    expect(byId('IR-1404-E-NEW-01')[7]).toBe('Contents of Article 29(c)');
    expect(byId('IR-1404-E-NEW-02')[7]).toBe('Contents of Article 29(a)');
  });

  it('regional coefficient cites Appendix 4 printed page 243', () => {
    expect(byId('IR-1404-E-REGION-01').slice(3, 5)).toEqual([
      '243',
      'Appendix 4 — Regional Coefficient (ضریب منطقه‌ای), clauses 1, 1-1, 1-2, 1-3, 1-4',
    ]);
  });

  it('regional values come from the external circular and are not recorded', () => {
    const t = stmt('IR-1404-E-REGION-01');
    expect(t).toContain('circular No. 94/69416 dated 1394/04/30 or its later amendments (1-1)');
    expect(t).not.toMatch(/\d\.\d/);
    expect(byId('IR-1404-E-REGION-01')[7]).toMatch(
      /^All coefficient values and the region\/location mapping/,
    );
  });

  it('regional fallback uses the county or district coefficient', () => {
    expect(stmt('IR-1404-E-REGION-01')).toContain(
      'the regional coefficient of the county or district (شهرستان یا بخش) in which the project is located is used (1-2)',
    );
    expect(stmt('IR-1404-E-REGION-01')).toContain(
      'latest national divisions map published by the Ministry of Interior (1-3)',
    );
  });

  it('multi-region projects use the cost-weighted regional formula', () => {
    expect(stmt('IR-1404-E-REGION-01')).toContain('R = [(R1×C1) + (R2×C2) + … + (Rn×Cn)] / C');
    expect(byId('IR-1404-E-REGION-01')[6]).toContain('per discipline (رشته)');
  });

  it('on-site material rules cite Appendix 1 printed pages 235–236', () => {
    for (let i = 1; i <= 7; i++) {
      const r = byId(`IR-1404-E-ONSITE-0${String(i)}`);
      expect(r[3]).toMatch(/^235(–236)?$/);
      expect(r[4]).toMatch(/^Appendix 1 — On-site materials \(مصالح پای‌کار\), /);
      expect(r[6]).toMatch(
        /^Interim payment statements \(صورت وضعیت موقت\) only; separate from takeoff/,
      );
    }
  });

  it('defines on-site materials and their eligibility conditions', () => {
    const t = stmt('IR-1404-E-ONSITE-02');
    expect(t).toContain(
      'needed for executing the subject of the contract and are to be installed in the work',
    );
    expect(t).toContain('in a form that can be inspected, measured or counted');
    expect(t).toContain('entry minute stating type, quantity and entry date');
  });

  it('on-site rates are only for interim payment statements', () => {
    expect(stmt('IR-1404-E-ONSITE-01')).toContain(
      'only for calculating on-site-material amounts in interim payment statements',
    );
  });

  it('Table 2 rates include transport up to 30 km only', () => {
    expect(stmt('IR-1404-E-ONSITE-03')).toContain('transport up to 30 km');
    expect(stmt('IR-1404-E-ONSITE-03')).toContain(
      'no additional cost for transport beyond 30 km is paid',
    );
  });

  it('interim payment includes 70% of on-site material value with the stated coefficients', () => {
    const t = stmt('IR-1404-E-ONSITE-05');
    expect(t).toContain(
      '70% of the price of the on-site materials and of the transport cost, without applying coefficient 0.7',
    );
    expect(t).toContain(
      "with the regional coefficient, the overhead coefficient and the contractor's proposed coefficient applied",
    );
    expect(t).not.toContain('floor coefficient');
  });

  it('Table 1 records the verified average coefficients', () => {
    const start = section.indexOf('### 11.3');
    const sub = section.slice(start, section.indexOf('### 11.2', start));
    const vals = sub
      .split('\n')
      .filter((l) => /^\| .+ \(\d+\) \|/.test(l))
      .map((l) => [l.match(/\((\d+)\)/)?.[1], l.match(/(\d+)% \|$/)?.[1]]);
    expect(vals).toEqual([
      ['5', '90'],
      ['12', '50'],
      ['13', '65'],
      ['14', '50'],
      ['16', '70'],
      ['17', '90'],
      ['18', '70'],
      ['19', '70'],
      ['20', '70'],
      ['21', '70'],
      ['22', '70'],
      ['23', '75'],
      ['24', '80'],
    ]);
    expect(stmt('IR-1404-E-ONSITE-04')).toContain(
      'the row with the lowest unit price is the basis',
    );
  });

  it('custody, end-of-contract exclusion and surplus removal', () => {
    expect(stmt('IR-1404-E-ONSITE-06')).toContain('lies with the contractor');
    expect(stmt('IR-1404-E-ONSITE-07')).toContain(
      'after provisional acceptance, and in the final statement, no on-site materials',
    );
    expect(stmt('IR-1404-E-ONSITE-07')).toContain(
      'must be removed from the site by the contractor',
    );
  });

  it('Table 2 rates are not transcribed and P exclusion is unchanged', () => {
    expect(section).toContain('Table 2 is recorded in §11.5 (IR-1404-E-ONSITE-T2-01/02).');
    expect(section).toContain('Appendix 1 does not mention the floor coefficient P.');
    expect(stmt('IR-1404-E-FLOOR-01')).toContain(
      'except on-site materials, from the first progress statement (Note 3)',
    );
  });

  const a3 = (): string => {
    const start = section.indexOf('### 11.4');
    return section.slice(start, section.indexOf('\n### ', start + 1));
  };
  const a3Items = (): string[][] =>
    a3()
      .split('\n')
      .filter((l) => /^\| \d/.test(l))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );

  it('Appendix 3 rules cite printed pages 241–242 and are VERIFIED_SPEC_ONLY', () => {
    const ids = [1, 2, 3, 4, 5].map((i) => `IR-1404-E-OVERHEAD-COST-0${String(i)}`);
    expect(ids.map((id) => byId(id)[3])).toEqual(['241', '241', '241–242', '242', '242']);
    for (const id of ids) {
      expect(byId(id)[4]).toMatch(
        /^Appendix 3 — Overhead cost items \(شرح اقلام هزینه‌های بالاسری\), /,
      );
      expect(byId(id)[8]).toBe('VERIFIED_SPEC_ONLY');
    }
    expect(a3()).toContain('Printed pages 241–242, «پیوست ۳. شرح اقلام هزینه‌های بالاسری»');
  });

  it('Appendix 3 separates general and work overhead', () => {
    expect(stmt('IR-1404-E-OVERHEAD-COST-01')).toContain(
      'general overhead cost (هزینه بالاسری عمومی) and work overhead cost (هزینه بالاسری کار)',
    );
    expect(stmt('IR-1404-E-OVERHEAD-COST-02')).toContain('cannot be attributed to a specific work');
    expect(stmt('IR-1404-E-OVERHEAD-COST-03')).toContain('can be attributed to a specific work');
  });

  it('Appendix 3 item list is complete', () => {
    const items = a3Items();
    const general = items.filter((r) => r[2]?.startsWith('general')).map((r) => r[0]);
    const work = items.filter((r) => r[2]?.startsWith('work')).map((r) => r[0]);
    expect(general).toEqual(['1', ...Array.from({ length: 17 }, (_, i) => `1-${String(i + 1)}`)]);
    expect(work).toEqual([
      '2',
      '2-1',
      '2-1-1',
      '2-1-2',
      '2-2',
      '2-2-1',
      '2-2-2',
      '2-2-3',
      '2-3',
      '2-4',
      '2-5',
      ...Array.from({ length: 10 }, (_, i) => `2-5-${String(i + 1)}`),
      '2-6',
      ...Array.from({ length: 6 }, (_, i) => `2-6-${String(i + 1)}`),
      '2-7',
    ]);
    const page = (n: string) => items.find((r) => r[0] === n)?.[3];
    expect([page('1-17'), page('2-5'), page('2-5-1'), page('2-7')]).toEqual([
      '241',
      '241',
      '242',
      '242',
    ]);
  });

  it('Appendix 3 exclusions from overhead', () => {
    expect(stmt('IR-1404-E-OVERHEAD-COST-04')).toContain('site setup/removal cost (2-5-1)');
    expect(stmt('IR-1404-E-OVERHEAD-COST-04')).toContain(
      'included in the machinery hourly cost (Note 1)',
    );
    expect(stmt('IR-1404-E-OVERHEAD-COST-05')).toContain('are not included in overhead (Note 2)');
    expect(stmt('IR-1404-E-OVERHEAD-COST-05')).toContain(
      'value-added tax and, for applicable contracts, municipal charges are not included in overhead (Note 3)',
    );
  });

  it('Appendix 3 provides no coefficient values', () => {
    for (let i = 1; i <= 5; i++) {
      const id = `IR-1404-E-OVERHEAD-COST-0${String(i)}`;
      expect(stmt(id).replace(/§\d+\.\d+/g, '')).not.toMatch(/\d\.\d|%/);
      expect(byId(id)[6]).toContain('NOT a source of overhead coefficient values');
    }
    expect(a3().replace(/§?\d+\.\d+ Appendix 3|### 11\.4/g, '')).not.toMatch(/\d\.\d{2}|%/);
    expect(stmt('IR-1404-E-OVERHEAD-01')).toContain('→ 1.30');
  });

  it('General Rules clause 10 is cited on printed page 4', () => {
    const r = byId('IR-1404-E-GENERAL-10-01');
    expect(r.slice(1, 5)).toEqual([
      'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
      '1404',
      '4',
      'General Rules (کلیات), clause 10 (بند ۱۰ کلیات)',
    ]);
    expect(r[8]).toBe('VERIFIED_SPEC_ONLY');
  });

  it('clause 10 covers only fittings in the five named chapters', () => {
    const t = stmt('IR-1404-E-GENERAL-10-01');
    for (const c of [
      'کارهای فولادی سبک',
      'کارهای آلومینیومی',
      'کارهای چوبی',
      'کارهای پلاستیکی و پلیمری',
      'فصل شیشه و نصب آن',
    ]) {
      expect(t).toContain(c);
    }
    expect(t).toContain("supply of fittings (تهیه یراق‌آلات) is the contractor's responsibility");
    expect(byId('IR-1404-E-GENERAL-10-01')[6]).toContain('NOT ordinary work items');
  });

  it('clause 10 prices fittings by approved invoice with overhead only, no adjustment', () => {
    const t = stmt('IR-1404-E-GENERAL-10-01');
    expect(t).toContain(
      'sales invoice approved by the employer, with the overhead coefficient (ضریب بالاسری) applied',
    );
    expect(t).toContain(
      'not subject to unit-price adjustment (تعدیل آحادبها), and the other contract coefficients do not apply to it',
    );
  });

  it('1.14 for ابنیه purchase items comes from Table A, linked to clause 10', () => {
    expect(stmt('IR-1404-E-OVERHEAD-02')).toContain(
      'The purchase-chapter overhead column is headed 1.14.',
    );
    expect(stmt('IR-1404-E-OVERHEAD-02')).toContain('«بند ۱۰ کلیات»');
    expect(stmt('IR-1404-E-GENERAL-10-01')).not.toMatch(/\d\.\d/);
    expect(byId('IR-1404-E-GENERAL-10-01')[7]).toMatch(/^Clause 10 prints no numeric value/);
    expect(stmt('IR-1404-E-OVERHEAD-01')).not.toContain('1.14');
    for (let i = 1; i <= 5; i++) {
      expect(stmt(`IR-1404-E-OVERHEAD-COST-0${String(i)}`)).not.toContain('1.14');
    }
  });

  it('star-item rules cite Application Instructions clause 2-6 on printed pages 1–2', () => {
    expect(byId('IR-1404-E-STAR-01').slice(3, 5)).toEqual([
      '1',
      'Application Instructions, clauses 2-1, 2-4 and 2-5 (definition referenced by clause 2-6)',
    ]);
    for (const id of ['IR-1404-E-STAR-02', 'IR-1404-E-STAR-03']) {
      expect(byId(id).slice(3, 5)).toEqual(['1–2', 'Application Instructions, clause 2-6']);
      expect(byId(id)[8]).toBe('VERIFIED_SPEC_ONLY');
    }
  });

  it('defines star rows', () => {
    const t = stmt('IR-1404-E-STAR-01');
    expect(t).toContain('marked with a star, and are called star rows (ردیف‌های ستاره‌دار)');
    expect(t).toContain('have no unit price are priced the same way and are also star rows (2-4)');
    expect(t).toContain('approved by the executive body (دستگاه اجرایی)');
  });

  it('star-item caps are exactly 30 / 15 / 10 percent by tender type', () => {
    const t = stmt('IR-1404-E-STAR-02');
    expect(t).toContain('public tender (مناقصه عمومی)');
    expect(t).toContain('exceeds 30%');
    expect(t).toContain(
      'limited tender (مناقصه محدود) or waiver of tender formalities (ترک تشریفات مناقصه), the cap is 15% and 10% respectively',
    );
    expect(t.match(/\d+%/g)).toEqual(['30%', '15%', '10%']);
  });

  it('star-item denominator is all rows (base and non-base) excluding site setup, per discipline', () => {
    const t = stmt('IR-1404-E-STAR-02');
    expect(t).toContain(
      'Ratio = Σ star-row estimate ÷ Σ (base + non-base) row estimate, site setup/removal excluded, per discipline.',
    );
    expect(t).toContain(
      'without applying site setup/removal cost (بدون اعمال هزینه تجهیز و برچیدن کارگاه)',
    );
    expect(byId('IR-1404-E-STAR-02')[6]).toContain('not the Appendix 6 new-work 25% cap');
  });

  it('exceeding the cap requires High Technical Council approval before tender', () => {
    const t = stmt('IR-1404-E-STAR-03');
    expect(t).toContain('before the tender (قبل از انجام مناقصه)');
    expect(t).toContain('secretariat of the High Technical Council (دبیرخانه شورای عالی فنی)');
    expect(t).toContain('approval by the High Technical Council (شورای عالی فنی)');
    expect(t).toContain('covers all star rows of the discipline, not only the excess');
    expect(t).not.toMatch(/\d+%/);
  });

  const t2Rows = (): string[][] => {
    const start = section.indexOf('### 11.5');
    return section
      .slice(start, section.indexOf('### 11.2', start))
      .split('\n')
      .filter((l) => /^\| 41\d{4} /.test(l))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
  };

  it('Table 2 is cited on printed pages 237–238 with its verified structure', () => {
    expect(byId('IR-1404-E-ONSITE-T2-01').slice(3, 5)).toEqual([
      '237–238',
      'Appendix 1 — On-site materials (مصالح پای‌کار), Table 2 (جدول شماره دو), rows 410202–413102',
    ]);
    expect(stmt('IR-1404-E-ONSITE-T2-01')).toContain(
      'It has 46 rows (29 on page 237, 17 on page 238)',
    );
    expect(byId('IR-1404-E-ONSITE-T2-01')[8]).toBe('VERIFIED_SPEC_ONLY');
    expect(byId('IR-1404-E-ONSITE-T2-01')[6]).toMatch(/^Interim payment statements/);
  });

  it('Table 2 rows, units, printed rates and pages are exactly as verified', () => {
    expect(t2Rows().map((r) => [r[0], r[2], r[3], r[4]])).toEqual([
      ['410202', 'مترمکعب', '5,591,000', '237'],
      ['410203', 'مترمکعب', '5,719,000', '237'],
      ['410204', 'مترمکعب', '4,899,000', '237'],
      ['410205', 'مترمکعب', '4,159,000', '237'],
      ['410206', 'مترمکعب', '4,726,000', '237'],
      ['410301', 'مترمکعب', '4,820,000', '237'],
      ['410302', 'مترمکعب', '5,945,000', '237'],
      ['410303', 'مترمکعب', '6,034,000', '237'],
      ['410305', 'مترمربع', '4,214,000', '237'],
      ['410501', 'تن', '17,908,000', '237'],
      ['410502', 'تن', '15,864,000', '237'],
      ['410508', 'تن', '33,390,000', '237'],
      ['410601', 'تن', '9,457,000', '237'],
      ['410602', 'تن', '7,660,000', '237'],
      ['410603', 'تن', '10,707,000', '237'],
      ['410701', 'قالب', '21,400', '237'],
      ['410702', 'قالب', '16,800', '237'],
      ['410703', 'قالب', '37,000', '237'],
      ['410801', 'قالب', '40,600', '237'],
      ['410802', 'قالب', '155,000', '237'],
      ['410804', 'قالب', '117,500', '237'],
      ['410901', 'کیلوگرم', '346,000', '237'],
      ['410902', 'کیلوگرم', '584,500', '237'],
      ['410903', 'کیلوگرم', '342,500', '237'],
      ['410904', 'کیلوگرم', '326,500', '237'],
      ['410905', 'کیلوگرم', '338,000', '237'],
      ['410906', 'کیلوگرم', '421,000', '237'],
      ['410907', 'کیلوگرم', '457,000', '237'],
      ['410908', 'کیلوگرم', '400,000', '237'],
      ['411001', 'کیلوگرم', '344,500', '238'],
      ['411002', 'کیلوگرم', '310,000', '238'],
      ['411003', 'کیلوگرم', '349,000', '238'],
      ['411004', 'کیلوگرم', '—', '238'],
      ['411101', 'کیلوگرم', '428,500', '238'],
      ['411202', 'کیلوگرم', '593,500', '238'],
      ['411303', 'متر مربع', '314,000', '238'],
      ['411304', 'کیلو گرم', '485,500', '238'],
      ['411405', 'کیلوگرم', '1,698,000', '238'],
      ['411406', 'کیلوگرم', '2,438,000', '238'],
      ['411902', 'مترمکعب', '222,924,000', '238'],
      ['412002', 'مترمکعب', '138,590,000', '238'],
      ['412401', 'کیلوگرم', '216,000', '238'],
      ['412801', 'مترمکعب', '4,547,000', '238'],
      ['412901', 'مترمربع', '365,500', '238'],
      ['413101', 'کیلوگرم', '1,576,000', '238'],
      ['413102', 'کیلوگرم', '982,500', '238'],
    ]);
  });

  it('Table 2 rates are positive integer Rial except the blank 411004', () => {
    for (const r of t2Rows()) {
      if (r[0] === '411004') expect(r[3]).toBe('—');
      else expect(r[3]).toMatch(/^[1-9]\d{0,2}(,\d{3})*$/);
    }
    expect(stmt('IR-1404-E-ONSITE-T2-02')).toContain(
      'has no printed unit price. No price is recorded or inferred.',
    );
  });

  it('Table 2 transport and use restrictions follow clauses 2 and 7', () => {
    expect(stmt('IR-1404-E-ONSITE-03')).toContain('transport up to 30 km');
    expect(stmt('IR-1404-E-ONSITE-03')).toContain(
      'no additional cost for transport beyond 30 km is paid, except where provided in the transport chapter',
    );
    expect(stmt('IR-1404-E-ONSITE-01')).toContain(
      'may not be relied on or used for any other purpose',
    );
  });

  it('Transport rules cite Chapter 28 printed pages 228–232', () => {
    expect([1, 2, 3, 4].map((i) => byId(`IR-1404-E-TRANSPORT-0${String(i)}`)[3])).toEqual([
      '228',
      '228',
      '228–230',
      '230–232',
    ]);
    for (let i = 1; i <= 4; i++) {
      const r = byId(`IR-1404-E-TRANSPORT-0${String(i)}`);
      expect(r[4]).toMatch(/^Chapter 28 — Transport \(فصل بیست و هشتم\. حمل و نقل\), /);
      expect(r[8]).toBe('VERIFIED_SPEC_ONLY');
    }
  });

  it('beyond-30-km transport is paid only for materials covered by Chapter 28', () => {
    const t = stmt('IR-1404-E-TRANSPORT-01');
    expect(t).toContain('up to a distance of 30 km');
    expect(t).toContain('is paid, as applicable, from the rows of this chapter');
    expect(t).toContain(
      'this chapter provides no beyond-30-km transport cost, no separate transport cost is paid',
    );
    expect(byId('IR-1404-E-TRANSPORT-03')[6]).toBe(
      'Cement, stone materials, steel, brick and block only',
    );
    expect(section).not.toMatch(/all transport beyond 30 km is (automatically )?paid/i);
    expect(section).toContain('is not stated by the source and is not mapped here');
  });

  it('transport distance basis, dirt-road coefficient and quantity restriction', () => {
    const t = stmt('IR-1404-E-TRANSPORT-02');
    expect(t).toContain('shortest route passable by the load-carrying vehicles');
    expect(t).toContain(
      'dirt or gravel roads, the rows of this chapter are paid with coefficient 1.30 (4)',
    );
    expect(t).toContain(
      'may not be used for calculating material quantities or other purposes (5)',
    );
  });

  it('road transport is tonne-kilometre after deducting 30 km; special coefficients', () => {
    expect(stmt('IR-1404-E-TRANSPORT-04')).toContain(
      'تن - کیلومتر (tonne-kilometre) for the whole route length after deducting 30 km',
    );
    const t = stmt('IR-1404-E-TRANSPORT-03');
    expect(t).toContain('coefficient 1.15 for the whole route after deducting 30 km (1-2-2)');
    expect(t).toContain('coefficient 1.20');
    expect(t).toContain('without deducting the first 30 km, with coefficient 2 (1-4-5)');
  });

  it('Chapter 28 row units and rates are exactly as verified', () => {
    const start = section.indexOf('### 11.6');
    const got = section
      .slice(start, section.indexOf('### 11.2', start))
      .split('\n')
      .filter((l) => /^\| 280\d{3} /.test(l))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      )
      .map((r) => [r[0], r[2], r[3]]);
    expect(got).toEqual([
      ['280101', 'تن - کیلومتر', '28,400'],
      ['280102', 'تن - کیلومتر', '19,600'],
      ['280103', 'تن - کیلومتر', '13,500'],
      ['280104', 'تن - کیلومتر', '12,200'],
      ['280105', 'تن - کیلومتر', '10,200'],
      ['280106', 'تن - کیلومتر', '8,130'],
      ['280301', 'تن - کیلومتر', '37,300'],
      ['280302', 'تن - کیلومتر', '22,800'],
      ['280501', 'تن - مایل دریایی', '110,700'],
      ['280502', 'تن - مایل دریایی', '26,700'],
      ['280503', 'تن - مایل دریایی', '20,300'],
      ['280504', 'تن - مایل دریایی', '18,200'],
      ['280505', 'تن - مایل دریایی', '18,200'],
    ]);
  });

  const qtyRows = (): string[][] => {
    const start = section.indexOf('### 11.7');
    return section
      .slice(start, section.indexOf('### 11.2', start))
      .split('\n')
      .filter((l) => /^\| 1-\d/.test(l))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
  };

  it('Group 1 transport quantities cite Chapter 28 pages 228–230 and clause 5', () => {
    const r = byId('IR-1404-E-TRANSPORT-QTY-01');
    expect(r[3]).toBe('228–230');
    expect(r[4]).toContain(
      'Group 1 requirements, clauses 1-2-3 to 1-2-10, 1-3-2 to 1-3-13, 1-4-4, 1-5-2 to 1-5-5',
    );
    expect(r[8]).toBe('VERIFIED_SPEC_ONLY');
    expect(stmt('IR-1404-E-TRANSPORT-QTY-01')).toContain(
      'only for calculating transport costs and may not be relied on for calculating material quantities or other purposes',
    );
    expect(r[6]).toContain(
      'NOT material-consumption norms, BOQ coefficients, wastage factors or takeoff coefficients',
    );
  });

  it('Group 1 quantities, units and pages are exactly as verified', () => {
    expect(qtyRows().map((q) => [q[0], q[3], q[4], q[5]])).toEqual([
      [
        '1-2-3',
        'cement content (عیار سیمان) of the concrete + 6% cement loss (اتلاف سیمان); content per Chapter 8 Group 1 clause 1-1 formula',
        '—',
        '228',
      ],
      ['1-2-3', '0.50 m³ concrete', 'per m³ slab', '228'],
      ['1-2-3', '0.77 m³ concrete', 'per m³ slab', '228'],
      ['1-2-4', 'cement content + 6% loss, by shotcrete thickness', '—', '228'],
      ['1-2-5', 'cement content + 6% loss', '—', '229'],
      ['1-2-6', 'cement content of mortar + 6% loss, by plaster thickness', '—', '229'],
      ['1-2-7', 'cement content of mortar + 6% loss; mortar thickness average 3 cm', '—', '229'],
      ['1-2-8', 'cement content of mortar + 6% loss', '—', '229'],
      ['1-2-8', '30% of masonry volume', '—', '229'],
      ['1-2-8', '10% of masonry volume', '—', '229'],
      ['1-2-8', '10% of masonry volume', '—', '229'],
      ['1-2-8', '30% of masonry volume', '—', '229'],
      ['1-2-8', '10% of operation volume', '—', '229'],
      ['1-2-8', '+40% added to blockwork mortar volume', '—', '229'],
      ['1-2-9', '135 kg cement + 6% loss', 'per m³ cement-block masonry', '229'],
      ['1-2-10', '0.45 kg cement + 6% loss', 'per litre', '229'],
      ['1-3-2', '2.2 t', 'per m³', '229'],
      ['1-3-3', '0.65 t sand and 0.70 t pumice', 'per m³', '229'],
      ['1-3-4', '2 t', 'per m³', '229'],
      ['1-3-5', '2.2 t', 'per m³', '229'],
      ['1-3-6', '1.85 t', 'per m³ mortar', '229'],
      ['1-3-7', '0.05 t', 'per m²', '229'],
      ['1-3-8', '1.85 t', 'per m³ mortar', '229'],
      ['1-3-9', '0.75 t', 'per m³ cement-block masonry', '229'],
      ['1-3-10', '2 t', 'per m³', '229'],
      ['1-3-11', '1.70 t', 'per m³', '229'],
      ['1-3-12', '2 t', 'per m³', '229'],
      ['1-3-13', '2.2 t', 'per m³', '229'],
      ['1-4-4', '1.05 kg', 'per kg steel', '230'],
      ['1-5-2', '1.25 t', 'per m³', '230'],
      ['1-5-3', '0.04 t', 'per m²', '230'],
      ['1-5-4', '0.70 t', 'per m³', '230'],
      ['1-5-5', '0.40 t', 'per m³ slab', '230'],
    ]);
  });

  it('Group 1 quantity table excludes Group 3 and keeps steel 1.05 scoped to chapters 7, 9 and 16', () => {
    const rows = qtyRows();
    expect(rows.every((q) => q[0]?.startsWith('1-'))).toBe(true);
    const steel = rows.filter((q) => q[1] === 'steel');
    expect(steel).toHaveLength(1);
    expect(steel[0]?.[2]).toBe('steel consumed in chapters 7, 9 and 16');
    expect(steel[0]?.[3]).toBe('1.05 kg');
  });

  it('Group 1 quantities have no Appendix 1 mapping', () => {
    expect(section).toContain('NO_EXPLICIT_APPENDIX_1_MAPPING');
    for (const q of qtyRows()) expect(q.join(' ')).not.toMatch(/\b41\d{4}\b/);
  });

  it('overview sections carry no stale unverified claims about verified rules', () => {
    const conceptRow = (id: string): string =>
      spec.split('\n').find((l) => l.startsWith(`| ${id} `)) ?? '';
    expect(conceptRow('C6')).toContain('not Appendix 3');
    expect(conceptRow('C6')).not.toContain('Applied in S4');
    expect(conceptRow('C4')).not.toContain('Content unverified');
    expect(spec).not.toContain('does not verify an order');
    expect(spec).not.toContain('rules themselves unverified');
    expect(spec).toContain('The coefficient order is verified by IR-1404-E-FLOW-01');
  });

  it('unresolved items stay listed as UNVERIFIED', () => {
    expect(section).toContain('Still UNVERIFIED');
    for (const k of [
      'Article 29(a)/(c)',
      'regional coefficient values',
      'Appendix 1 Table 2 row 411004',
      'NO_EXPLICIT_APPENDIX_1_MAPPING',
      'NOT_FOUND_IN_PROJECT_SOURCES',
    ]) {
      expect(section).toContain(k);
    }
  });
});

describe('calculation engine implementation contract (§12)', () => {
  const c12 = spec.slice(spec.indexOf('## 12. Calculation Engine Implementation Contract'));
  const s11 = spec.slice(spec.indexOf('## 11. Verified Iranian Rules'), spec.indexOf('## 12.'));
  const decision = c12
    .split('\n')
    .filter((l) => /^\| IR-1404-[EM]-/.test(l))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((x) => x.trim()),
    );
  const d = (id: string): string[] => {
    const r = decision.find((x) => x[0] === id);
    if (!r) throw new Error(`missing ${id}`);
    return r;
  };

  it('classifies every §11 rule exactly once with a valid type and status', () => {
    const ids11 = [...s11.matchAll(/^\| (IR-1404-E-[A-Z0-9-]+) /gm)].map((m) => m[1]);
    const idsE = decision.map((r) => r[0]).filter((id) => id?.startsWith('IR-1404-E-'));
    expect(idsE).toEqual(ids11);
    for (const r of decision) {
      expect(r).toHaveLength(7);
      expect(['A', 'B', 'C', 'D', 'E', 'F', 'G']).toContain(r[1]);
      expect([
        'IMPLEMENTABLE_FROM_CURRENT_SOURCE',
        'EXTERNAL_DEPENDENCY',
        'NOT_IMPLEMENTABLE_FROM_CURRENT_SOURCE',
        'UNRESOLVED',
      ]).toContain(r[5]);
    }
  });

  it('descriptive rules stay non-computational', () => {
    for (const id of [1, 2, 3, 4, 5].map((i) => `IR-1404-E-OVERHEAD-COST-0${String(i)}`)) {
      expect(d(id).slice(1, 3)).toEqual(['E', 'no']);
      expect(d(id)[5]).toBe('NOT_IMPLEMENTABLE_FROM_CURRENT_SOURCE');
    }
    expect(c12).toContain(
      'Appendix 3 (OVERHEAD-COST-01..05) is descriptive and never a coefficient source.',
    );
  });

  it('open items keep external/unresolved status', () => {
    expect(d('IR-1404-E-REGION-01')[5]).toBe('EXTERNAL_DEPENDENCY');
    expect(d('IR-1404-E-NEW-01')[5]).toBe('EXTERNAL_DEPENDENCY');
    expect(d('IR-1404-E-NEW-02')[5]).toBe('EXTERNAL_DEPENDENCY');
    expect(d('IR-1404-E-ONSITE-T2-02').slice(1, 6)).toEqual(['G', 'no', '—', '—', 'UNRESOLVED']);
    expect(d('IR-1404-M-REBAR-01')[5]).toBe('UNRESOLVED');
    expect(d('IR-1404-M-CONC-02')[6]).toContain('>0.05 m³: NOT_IMPLEMENTABLE_FROM_CURRENT_SOURCE');
    for (const k of [
      'Appendix 1 row 411004 price',
      'Appendix 1 Table 2 → Chapter 28 category mapping',
      'Star-row preparation/approval instruction',
      'Regional values (circular 94/69416 and amendments)',
      'Article 29(a)/(c) of the General Conditions',
      'Chapter 7 rebar tolerance value',
      'Chapter 8 voids > 0.05 m³',
    ]) {
      expect(c12).toContain(`| ${k}`);
    }
  });

  it('safety contract forbids generalisation and fabrication', () => {
    for (const k of [
      'Never generalise 1.14 beyond OVERHEAD-02, GENERAL-10-01 and NEW-03.',
      'Never generalise the 6% cement addition beyond Chapter 28 transport tonnage.',
      'Never generalise the 1.05 steel factor beyond Chapter 28 transport of steel in chapters 7, 9 and 16.',
      'Never use transport quantities as takeoff or consumption quantities.',
      'Never infer the Appendix 1 ↔ Chapter 28 mapping.',
      'Never fabricate regional coefficients.',
      'Never turn a cap (4%, 25%, 30/15/10%) into an automatic charge.',
    ]) {
      expect(c12).toContain(k);
    }
  });

  it('§12 introduces no numeric values absent from §11', () => {
    const nums = (t: string) => new Set(t.match(/\d+\.\d+/g) ?? []);
    const in11 = nums(s11);
    const extra = [...nums(c12)].filter(
      (n) => !in11.has(n) && !/^1[12]\.\d$/.test(n) && n !== '9.3',
    );
    expect(extra).toEqual([]);
    expect(c12).not.toMatch(/411004[^\n]*\d{2,},\d{3}/);
  });

  it('adversarial: outcomes are distinct and no global coefficient product is allowed', () => {
    for (const k of ['`ERROR`', '`INCOMPLETE`', '`NOT_SPECIFIED_IN_1404_PRICEBOOK`']) {
      expect(c12).toContain(`| ${k}`);
    }
    expect(c12.replace(/\s+/g, ' ')).toContain('never writes `Σ rows × P × overhead × R`');
    expect(c12).toContain('R is per discipline only; it is never a project-global coefficient');
    expect(c12).not.toMatch(/Otherwise reject|incomplete \(error\)/);
  });

  it('adversarial: per-void threshold stays per void', () => {
    expect(c12).toContain('The threshold applies per individual void, never to the total');
    expect(c12).toContain('Negative areas: NOT_SPECIFIED_IN_1404_PRICEBOOK');
  });

  it('ONSITE-05: 70% of material price; extra transport cost not reduced by 0.7; interim only', () => {
    const f = c12.slice(c12.indexOf('**F. On-site materials'), c12.indexOf('**G. Site setup'));
    const p = f
      .slice(f.indexOf('- Interim payment (ONSITE-05):'), f.indexOf('- Eligibility'))
      .replace(/\s+/g, ' ');
    expect(p).toContain('`material_payment = 70% × applicable on-site-material price`');
    expect(p).toContain(
      '`extra_transport_payment = applicable extra transport cost`, not multiplied by 0.7',
    );
    expect(p).not.toMatch(/NOT_SPECIFIED|UNRESOLVED|NOT_IMPLEMENTABLE|not computed/);
    expect(p).not.toMatch(/material_payment = (100%|1(\.0)?) ×/);
    expect(f).toContain('Used only in interim statements (ONSITE-01).');
    expect(c12).not.toContain('Meaning of "without coefficient 0.7"');
  });

  it('Table 2 → Chapter 28 mapping stays unresolved with no row mapping (§11.8)', () => {
    const m = spec.slice(spec.indexOf('### 11.8'), spec.indexOf('## 12.'));
    expect(m).toContain('0 explicit row mappings');
    expect(m).toContain('PARTIALLY_SPECIFIED');
    expect(m).not.toMatch(/41[0-3]\d{3}[^\n|]*→/);
    expect(c12).toContain(
      'beyond-30-km transport for Table 2 rows not computed (UNRESOLVED, §11.8)',
    );
    expect(c12).toContain('NO_EXPLICIT_APPENDIX_1_MAPPING');
  });

  it('star-row instruction stays an external dependency identified by title only', () => {
    const flat = spec.replace(/\s+/g, ' ');
    expect(flat).toContain(
      'prints only the title «دستورالعمل نحوه تهیه و تصویب ردیف‌های ستاره‌دار»',
    );
    expect(flat).toContain('no document number, date or issuing authority is printed');
    expect(flat).toContain('no procedural detail is taken from it');
    expect(c12.replace(/\s+/g, ' ')).toContain(
      'EXTERNAL_DEPENDENCY (title only, p2 clause 2-6; no number/date/authority printed; not in project)',
    );
  });

  it('411004 stays present, per kilogram, blank-priced and UNRESOLVED', () => {
    const row = spec.split('\n').find((l) => l.startsWith('| 411004 '));
    expect(
      row
        ?.split('|')
        .map((c) => c.trim())
        .slice(1, 6),
    ).toEqual(['411004', 'انواع کابل فولادی (برای پیش تنیدگی).', 'کیلوگرم', '—', '238']);
    const flat = spec.replace(/\s+/g, ' ');
    expect(flat).toContain('row 411004 (not printed); UNRESOLVED. Phase 3.5-U');
    expect(flat).toContain('so it is not a fallback for 411004');
    expect(flat).toContain('must not invent, estimate, zero or N/A-price it');
    expect(d('IR-1404-E-ONSITE-T2-02')[5]).toBe('UNRESOLVED');
  });

  it('regional: rule verified, values external, latest source by estimate date (§11.9)', () => {
    const r = spec.slice(spec.indexOf('### 11.9'), spec.indexOf('## 12.'));
    const flat = r.replace(/\s+/g, ' ');
    expect(flat).toMatch(/rule \(IR-1404-E-REGION-01\) \| VERIFIED_SPEC_ONLY/);
    expect(flat).toContain('`R = Σ(Ri × Ci) / C` per discipline');
    expect(flat).toContain('county/district (شهرستان یا بخش) fallback');
    expect(flat).toMatch(/regional coefficient values \| EXTERNAL_DEPENDENCY \/ UNRESOLVED/);
    expect(flat).toContain('circular No. 94/69416 dated 1394/04/30 or its later amendments');
    expect(flat).toContain('The 1394 circular is not automatically the applicable source');
    expect(flat).toContain('estimate preparation date');
    expect(
      r.replace(/94\/69416|1394\/04\/30|1-[1-4]|11\.9|3\.5-[A-Z]+|p243|pp\. 1–2, 235|1404/g, ''),
    ).not.toMatch(/\d\.\d/);
  });

  it('Chapter 7 rebar tolerance stays UNRESOLVED; 3132 not linked (Phase 3.5-W)', () => {
    const k = c12
      .slice(c12.indexOf('**K. Chapter 7 rebar'), c12.indexOf('**L. Chapter 8'))
      .replace(/\s+/g, ' ');
    expect(k).toContain('`weighed ≤ theoretical + max standard-table tolerance`');
    expect(k).toContain(
      'The tolerance value → UNRESOLVED (Phase 3.5-W). p56 clause 2 prints no number',
    );
    expect(k).toContain('the source does not link 3132 to this tolerance');
    expect(k.replace(/3132|3\.5-[A-Z]+|p56/g, '')).not.toMatch(/\d+(\.\d+)?\s*%|±/);
    expect(d('IR-1404-M-REBAR-01')[6]).toContain('source not identified');
  });

  it('Chapter 8 voids: per void, exactly 0.05 not deducted, >0.05 unresolved (Phase 3.5-X)', () => {
    const l = c12
      .slice(c12.indexOf('**L. Chapter 8 voids'), c12.indexOf('**M. Clause 10'))
      .replace(/\s+/g, ' ');
    expect(l).toContain('Each void ≤ 0.05 m³ is not deducted from concrete volume.');
    expect(l).toContain('The threshold applies per individual void, never to the total');
    expect(l).toContain('A void of exactly 0.05 m³ is not deducted');
    expect(l).toContain('Voids > 0.05 m³ → UNRESOLVED');
    expect(l).toContain(
      'No full, partial, proportional or excess-only deduction, and no non-deduction, is assumed',
    );
    expect(l).not.toMatch(/[-−]\s*0\.05|× \(?V|V\s*[-−]/);
    expect(d('IR-1404-M-CONC-02')[6]).toContain('>0.05 m³: NOT_IMPLEMENTABLE_FROM_CURRENT_SOURCE');
  });

  it('sea transport: printed nm bands verified, application method unresolved (Phase 3.5-Y)', () => {
    const rates = Object.fromEntries(
      spec
        .split('\n')
        .filter((l) => /^\| 28050[1-5] /.test(l))
        .map((l) => l.split('|').map((c) => c.trim()))
        .map((c): [string, string[]] => [c[1] ?? '', [c[3] ?? '', c[4] ?? '']]),
    );
    expect(rates).toEqual({
      '280501': ['تن - مایل دریایی', '110,700'],
      '280502': ['تن - مایل دریایی', '26,700'],
      '280503': ['تن - مایل دریایی', '20,300'],
      '280504': ['تن - مایل دریایی', '18,200'],
      '280505': ['تن - مایل دریایی', '18,200'],
    });
    const j = c12
      .slice(c12.indexOf('- Sea transport:'), c12.indexOf('- Tonnage ='))
      .replace(/\s+/g, ' ');
    expect(j).toContain('280505 مازاد بر ۹۰ تا ۱۵۰ مایل دریایی');
    expect(j).toContain('the road km bands are never applied to sea transport');
    expect(j).toContain(
      'how a distance is priced against these bands is NOT_SPECIFIED_IN_1404_PRICEBOOK → UNRESOLVED',
    );
    expect(j).toContain('distances over 150 nautical miles have no row');
    expect(j.replace('after deducting 30 km', '')).not.toMatch(/amount\s*=|rate\(|\d\s*km/);
  });

  it('transport coefficient combination stays UNRESOLVED (Phase 3.5-Z)', () => {
    const j = c12
      .slice(c12.indexOf('**J. Chapter 28'), c12.indexOf('- Sea transport:'))
      .replace(/\s+/g, ' ');
    for (const k of [
      '1.30: General Requirements clause 4 (p228), transport on dirt or gravel roads',
      '1.15: Group 1 clause 1-2-2 (p228), bulk cement',
      '1.20: clause 1-4-3 (p230), cold-rolled galvanised steel',
      '2: clause 1-4-5 (p230), loading/transport/unloading of factory-fabricated steel parts',
      'combine on the same haul is NOT_SPECIFIED_IN_1404_PRICEBOOK → UNRESOLVED',
      'Individual verification does not establish a combination rule.',
    ]) {
      expect(j).toContain(k);
    }
    expect(j).not.toMatch(/1\.30 × 1\.|× 1\.15|× 1\.20|highest|max\(|first applies|last applies/);
    expect(c12).toContain('when more than one transport coefficient applies to the same haul');
  });

  it('row-subset scope: P per building, R per discipline, mixed scope unresolved (Phase 3.5-AA)', () => {
    const e = c12
      .slice(c12.indexOf('**E. Application order'), c12.indexOf('**F. On-site'))
      .replace(/\s+/g, ' ');
    expect(e).toContain('calculated separately for each building (excluding landscaping items)');
    expect(e).toContain('one R per discipline');
    expect(e).toMatch(/several buildings with different P in one discipline \| [^|]+\| UNRESOLVED/);
    expect(e).toMatch(
      /R basis for C and Ci \(before or after P \/ overhead\) \| not stated \| UNRESOLVED/,
    );
    expect(e).toContain(
      'never uses one P for several buildings, never uses one R across disciplines',
    );
    expect(e).not.toContain('multiply the applicable rows');
    expect(e).not.toMatch(/project-wide R|global P/);
  });

  it('new works: Appendix 6 intact, Article 29 external and version unidentified (Phase 3.5-AB)', () => {
    const i = c12
      .slice(c12.indexOf('**I. New works'), c12.indexOf('**J. Chapter 28'))
      .replace(/\s+/g, ' ');
    expect(i).toContain('No existing price: Article 29(c) → EXTERNAL_DEPENDENCY.');
    expect(i).toContain(
      '`new-work rows + Art. 29(a) increases ≤ 25% × initial contract amount` → validation only.',
    );
    expect(i).toContain('Equipment-only approved new work: overhead 1.14 only (NEW-03).');
    expect(i).toContain('Extra site setup ≤ 25% × lump-sum site setup (NEW-04).');
    expect(i).toContain('clause 1 → «بند ج ماده ۲۹ شرایط عمومی پیمان»');
    expect(i).toContain(
      'Article 29(a) and 29(c): EXTERNAL_DEPENDENCY / UNRESOLVED (document version not identified)',
    );
    expect(i).toContain('Their content is not recorded and never becomes a 1404 rule');
    expect(d('IR-1404-E-NEW-01')[5]).toBe('EXTERNAL_DEPENDENCY');
    expect(d('IR-1404-E-NEW-02')[5]).toBe('EXTERNAL_DEPENDENCY');
  });

  it('regional external dependencies are classified separately (Phase 3.5-AC)', () => {
    const r = spec.slice(spec.indexOf('### 11.9'), spec.indexOf('## 12.')).replace(/\s+/g, ' ');
    expect(r).toContain('circular No. 94/69416 dated 1394/04/30 or its later amendments');
    expect(r).toContain('latest coefficients issued up to the time the estimate is prepared');
    expect(r).toContain('county/district (شهرستان یا بخش) fallback');
    expect(r).toContain('`R = Σ(Ri × Ci) / C` per discipline');
    expect(r).toMatch(/methodology \(Appendix 4 rules\) \| VERIFIED_SPEC_ONLY/);
    expect(r).toMatch(/numerical coefficient table \| EXTERNAL_DEPENDENCY/);
    expect(r).toMatch(/later amendments \/ version current for 1404 \| UNRESOLVED/);
    expect(r).toMatch(/administrative boundaries \(clause 1-3\) \| EXTERNAL_DEPENDENCY/);
    expect(r).toContain('No regional lookup is implemented or claimed as verified.');
    expect(
      r.replace(/94\/69416|1394\/04\/30|1-[1-4]|11\.9|3\.5-[A-Z]+|p243|pp\. 1–2, 235|1404/g, ''),
    ).not.toMatch(/\d\.\d/);
  });

  it('Table 2 → Chapter 28 recheck keeps all 46 rows unmapped (Phase 3.5-AD)', () => {
    const m = spec.slice(spec.indexOf('### 11.8'), spec.indexOf('### 11.9')).replace(/\s+/g, ' ');
    expect(m).toContain(
      'Verified row mappings: 0. Unresolved: all 46. Classification: UNRESOLVED.',
    );
    expect(m).toContain(
      'Name similarity (for example sand → stone, cement → cement, rebar → steel) is not evidence',
    );
    expect(m).toContain('an unmapped row gets no Chapter 28 amount');
    expect(m).toContain('wire/Rabitz mesh, 411004) has an explicit link');
    expect(m).not.toMatch(/41[0-3]\d{3} → 28\d{4}/);
    expect(c12).toContain('Never use transport quantities as takeoff or consumption quantities.');
    expect(c12).toContain('Never infer the Appendix 1 ↔ Chapter 28 mapping.');
  });

  it('rebar tolerance: no authorised number, manufacturer tables no tolerance source (Phase 3.5-AE)', () => {
    const k = c12
      .slice(c12.indexOf('**K. Chapter 7 rebar'), c12.indexOf('**L. Chapter 8'))
      .replace(/\s+/g, ' ');
    expect(k).toContain('با لحاظ نمودن حداکثر رواداری جدول‌های استاندارد');
    expect(k).toContain(
      'manufacturer tables are a weight basis, not a tolerance source, and create no universal tolerance',
    );
    expect(k).toContain('3132 is neither established nor excluded as the source');
    expect(k).toContain(
      'symmetric (plus-or-minus) value from any source is never turned into a + allowance',
    );
    expect(k).toContain('No numerical tolerance is authorised by the current verified source set');
    expect(k.replace(/3132|3\.5-[A-Z]+|p56/g, '')).not.toMatch(/\d+(\.\d+)?\s*%|±\s*\d/);
    expect(d('IR-1404-M-REBAR-01')[5]).toBe('UNRESOLVED');
  });

  it('Chapter 8 voids above 0.05 stay unresolved, no deduction method (Phase 3.5-AF)', () => {
    const l = c12
      .slice(c12.indexOf('**L. Chapter 8 voids'), c12.indexOf('**M. Clause 10'))
      .replace(/\s+/g, ' ');
    expect(l).toContain('"۰/۰۵ مترمکعب یا کمتر"');
    expect(l).toContain('never to the total of several voids');
    expect(l).toContain(
      'establishes non-deduction for individual voids at or below 0.05 m³ but does not establish the treatment of individual voids greater than 0.05 m³',
    );
    expect(l).toContain('No production deduction rule may be created from inference');
    expect(l).toContain('must not combine several voids into one threshold test');
    expect(l).toContain('must not silently ignore larger voids');
    expect(l).toContain('do not apply to Chapter 8 concrete volume');
    expect(d('IR-1404-M-CONC-02')[6]).toContain('>0.05 m³: NOT_IMPLEMENTABLE_FROM_CURRENT_SOURCE');
  });

  it('Chapter 8 measurement basis: clause 14 verified, excess and tolerance not specified (Phase 3.5-AG)', () => {
    const n = c12
      .slice(c12.indexOf('**N. Chapter 8 concrete measurement'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    expect(n).toContain(
      'بر اساس ابعاد کارهای انجام شده، که طبق ابعاد درج شده در نقشه‌های اجرایی و دستور کارها است',
    );
    expect(n).toContain('VERIFIED_SPEC_ONLY');
    expect(n).toContain('neither drawing dimensions alone nor executed dimensions alone');
    expect(n).toContain('NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(n).toContain('does not pay or reject such excess, applies no tolerance');
    expect(n).toContain('No rule from other chapters');
    expect(n).toContain('not a general concrete-volume rule');
    expect(
      n.replace(/3\.5-[A-Z]+|15 cm|pp?\. [\d–]+|clause 1[45]|page [45]|Group 7|F[1-9]/g, ''),
    ).not.toMatch(/\d+(\.\d+)?\s*%|±/);
  });

  it('Chapter 8 item inventory and special measurement rules (Phase 3.5-AH)', () => {
    const o = c12
      .slice(c12.indexOf('**O. Chapter 8 item-specific'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...['080101', '080102', '080103', '080104', '080105', '080106', '080107', '080108', '080109'],
      ...['080111', '080201', '080202', '080204', '080301', '080302', '080304', '080305', '080307'],
      ...['080308', '080309', '080310', '080311', '080312', '080313', '080314', '080315', '080316'],
      ...['080401', '080501', '080502', '080601', '080602', '080701', '080702', '080801'],
    ];
    expect(codes).toHaveLength(35);
    const listed = o.replace(/080101–080109/, codes.slice(0, 9).join(' '));
    for (const c of codes) expect(listed).toContain(c);
    expect(o.match(/CHAPTER_8_SPECIAL_RULE/g)?.length).toBe(7);
    expect(o).toContain('area measured from the drawings along the executable line');
    expect(o).toContain('the thickness means the minimum sprayed thickness');
    expect(o).toContain('Chapter 8 has no concrete flooring item');
    expect(o).toContain('none is transferred to structural concrete');
    expect(o).toContain('Voids: block L is unchanged');
    expect(o).toContain('Nothing is imported from other chapters');
    expect(o).toContain('A unit such as m³ or m² is not itself a special rule');
    expect(o).toContain('stay `INCOMPLETE`');
    expect(c12).toContain('A void of exactly 0.05 m³ is not deducted');
  });

  it('Chapter 8 special rules stay in their own rows (Phase 3.5-AI)', () => {
    const o1 = c12.slice(c12.indexOf('**O.1 Scope'), c12.indexOf('### 12.4')).replace(/\s+/g, ' ');
    const rows = o1
      .split('\n')
      .join(' ')
      .split('| 080')
      .slice(1)
      .map((r) => '080' + r);
    const special = [
      '080305',
      '080311',
      '080315',
      '080401',
      '080601',
      '080602',
      '080701',
      '080702',
    ];
    expect(rows.map((r) => r.slice(0, 6))).toEqual(special);
    for (const r of rows)
      expect(r).toMatch(/REPLACES_CLAUSE_14_FOR_THIS_QUANTITY|SUPPLEMENTS_CLAUSE_14/);
    expect(o1).toContain('exactly 180 kg per m³ is not granted');
    expect(o1).toContain('up to includes exactly 30 litres');
    expect(o1).toContain('per anchor or in aggregate is not specified');
    expect(o1).toContain('keying is not defined in the 1404 source');
    expect(o1).toContain('minimum thickness is not stated to be the paid thickness');
    expect(o1).toContain('NOT_SUPPORTED_OUTSIDE_EXPLICIT_SCOPE');
    for (const k of [
      'structural concrete',
      'all concrete',
      'other grout work',
      'other concrete rows',
    ])
      expect(o1).toContain(k);
    expect(o1).toContain('GROUP_5_MEASUREMENT_RULE = NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(o1).toContain('standards 18417 and 2930 are not measurement sources');
    expect(o1).toContain('Open boundary cases stay `INCOMPLETE`');
    expect(o1.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+/g) ?? []).toEqual([]);
  });

  it('Chapter 8 boundary cases stay unresolved with no silent default (Phase 3.5-AJ)', () => {
    const o2 = c12
      .slice(c12.indexOf('**O.2 Boundary-case'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    expect(o2).toContain('all six stay UNRESOLVED');
    expect(o2).toContain('«کرم‌بندی» is not defined anywhere');
    expect(o2).toContain('never defines keying from outside knowledge');
    expect(o2).toContain('does not pick an equality rule');
    expect(o2).toContain('chooses no rounding');
    expect(o2).toContain('creates no cement-difference formula');
    expect(o2).toContain('never aggregates grout allowances across anchors');
    expect(o2).toContain('never treats the minimum as automatically payable');
    expect(o2).toContain('no web search was made');
    expect(o2.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+/g) ?? []).toEqual([]);
  });

  it('Chapter 9 inventory, rules and unresolved boundaries (Phase 3.5-AK)', () => {
    const pb = c12
      .slice(c12.indexOf('**P. Chapter 9'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes =
      '090101 090102 090103 090104 090106 090220 090221 090222 090223 090224 090225 090226 090227 090228 090229 090230 090231 090232 090233 090234 090235 090236 090237 090238 090305 090306 090307 090308 090309 090310 090320 090321 090401 090402 090404 090501 090601 090602 090603 090604 090605 090606 090607 090608 090609 090701 090702 090704 090705 090706 090801 090802 090803 090804 090805 091001 091002 091003 091004 091010 091011 091012 091101 091104 091105 091110 091111 091112 091113 091114 091115 091601 091605 091606 091607 091608 091609 091610 091611 091612 091613 092801 092802 092803 092804'.split(
        ' ',
      );
    expect(codes).toHaveLength(85);
    const expand = (t: string): string =>
      t.replace(/(\d{6})–(\d{6})/g, (_m, a: string, b: string) =>
        codes.filter((c) => c >= a && c <= b).join(' '),
      );
    const listed = expand(pb);
    for (const c of codes) expect(listed).toContain(c);
    expect(pb).toContain('85 price rows');
    expect(pb).toContain(
      '«با لحاظ نمودن حداکثر رواداری». No tolerance value is printed: UNRESOLVED',
    );
    expect(pb).toContain('neither clause is used to read the other');
    expect(pb).toContain('without deducting the cut or hole');
    expect(pb).toContain('deducts 3 percent');
    expect(pb).toContain('Throats above 15 mm: NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(pb).toContain('exactly 2 kg is not covered (UNRESOLVED)');
    expect(pb).toContain('exactly 7 mm is not covered (UNRESOLVED)');
    expect(pb).toContain('No add-on applies outside the rows it names');
    expect(pb).toContain('gives definitions only');
    expect(pb).toContain('never priced');
    expect(pb).toContain(
      'no default tolerance, rounding, equality rule, aggregation or coefficient',
    );
    expect(pb.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+/g) ?? []).toEqual([]);
  });

  it('Chapter 10 inventory, slab-area rules and unresolved boundaries (Phase 3.5-AL)', () => {
    const q = c12
      .slice(c12.indexOf('**Q. Chapter 10'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes =
      '100101 100102 100103 100104 100202 100203 100305 100306 100401 100402 100403 100405 100501 100502 100601 100602 100701 100702 100703'.split(
        ' ',
      );
    expect(codes).toHaveLength(19);
    const listed = q.replace('100101–100104', '100101 100102 100103 100104');
    for (const c of codes) expect(listed).toContain(c);
    expect(q).toContain('19 price rows');
    expect(q).toContain('all in m² (مترمربع)');
    expect(q).toContain('outer face of the slab edge concrete');
    expect(q).toContain(
      'no extra for middle tying members («کلاف‌های دوزنده میانی»); both exclusions are limited to Chapter 10 clause 5',
    );
    expect(q).toContain('the boundary is the inner face of the beam or wall');
    expect(q).toContain('holes smaller than one square metre are not deducted');
    expect(q).toContain('Holes of one square metre or more: NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(q).toContain('paid from rows 080105 to 080107');
    expect(q).toContain('Part-kilograms: NOT_SPECIFIED');
    expect(q).toContain(
      'combine by addition or multiplication: NOT_SPECIFIED; the engine chooses none',
    );
    expect(q).toContain('exactly 20 MPa takes no add-on; above 30 MPa: NOT_SPECIFIED');
    expect(q).toContain('does not apply to Chapter 8 concrete volume');
    expect(q).toContain('a requirements document, not a measurement source');
    expect(q.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+/g) ?? []).toEqual([]);
  });

  it('Chapter 11 inventory, brickwork rules and unresolved boundaries (Phase 3.5-AM)', () => {
    const r = c12
      .slice(c12.indexOf('**R. Chapter 11'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes =
      '110101 110104 110107 110110 110201 110205 110208 110212 110213 110401 110402 110403 110501 110502 110503 110504 110601 110602 110603 110610 110611 110612 110615 110616 110617 110701 110702 110703 110801 110802 110803 110804 110805 110815 110816 110817 110820 110821 110822 110823 110824 110825 110826 110827 110830 110831 110832 110901 110902 110903 110904 110905 111001 111002 111005 111101 111102 111201 111202 111203'.split(
        ' ',
      );
    expect(codes).toHaveLength(60);
    const all = r.replace(/(\d{6})–(\d{6})/g, (_m, a: string, b: string) =>
      codes.filter((c) => c >= a && c <= b).join(' '),
    );
    for (const c of codes) expect(all).toContain(c);
    expect(r).toContain('not insulation');
    expect(r).toContain('60 price rows');
    expect(r).toContain('Exactly that area and larger openings: NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(r).toContain('facing is measured on the executed surface; joint area is not deducted');
    expect(r).toContain(
      'the whole brickwork volume is measured from the relevant rows, then the add-on is added',
    );
    expect(r).toContain('clause 16 coefficients apply only to 110830–110832');
    expect(r).toContain(
      'is not the Chapter 8 void rule (block L) or the Chapter 10 slab-hole rule (block Q)',
    );
    expect(r).toContain('material only, not measurement sources');
    expect(r).toContain('price cells of 110830 and 111102 read one (not used as prices)');
    expect(r).toContain('no default rounding, combination, deduction or price');
    expect(r.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+/g) ?? []).toEqual([]);
  });

  it('Chapter 12 inventory, precast and block rules, unresolved boundaries (Phase 3.5-AN)', () => {
    const sb = c12
      .slice(c12.indexOf('**S. Chapter 12'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'120101 120102 120103 120104 120105 120106 120201 120202 120203 120204 120205 120220 120221 120222'.split(
        ' ',
      ),
      ...'120301 120302 120303 120304 120305 120306 120307 120308 120309 120310 120311 120401 120402 120403'.split(
        ' ',
      ),
      ...'120501 120502 120503 120504 120505 120506 120508 120509 120520 120521 120522 120523 120524'.split(
        ' ',
      ),
      ...'120530 120531 120532 120533 120534 120540 120541 120542 120543 120601 120602 120603'.split(
        ' ',
      ),
      ...'120701 120702 120703 120704 120801 120802 120803 120804 120805 120806 120807 120808'.split(
        ' ',
      ),
      ...'120820 120821 120822 120823 120824 121001 121002 121003 121004 121005 121101 121102 121103 121104 121201'.split(
        ' ',
      ),
    ];
    expect(new Set(codes).size).toBe(80);
    const all = sb.replace(/(\d{6})–(\d{6})/g, (_m, a: string, b: string) =>
      codes.filter((c) => c >= a && c <= b).join(' '),
    );
    for (const c of codes) expect(all).toContain(c);
    expect(sb).toContain('«فصل دوازدهم. بتن پیش‌ساخته و بلوک‌چینی»');
    expect(sb).toContain('80 price rows');
    expect(sb).toMatch(
      /\| 120220–120222 [^\n]*\| INCOMPLETE \(no printed price; never priced\)\s*\|/,
    );
    expect(sb).toContain('kerbs measured by their own volume without setting mortar');
    expect(sb).toContain('the concrete volume of the pieces; no add-on for any shape');
    expect(sb).toContain('121101 does not apply to AAC block walls');
    expect(sb).toContain('density exactly 1000 kg per m³ is not covered');
    expect(sb).toContain('not measurement sources');
    expect(sb).toContain('nothing is taken from Chapter 11 brickwork');
    expect(sb).toContain('120534 price cell reads one (not used as a price)');
    expect(sb).toContain('no default rounding, combination, deduction or price');
    expect(sb.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+/g) ?? []).toEqual([]);
  });

  it('Chapter 13 inventory, damp-proofing rules and incomplete boundaries (Phase 3.5-AO)', () => {
    const tb = c12
      .slice(c12.indexOf('**T. Chapter 13'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'130101 130102 130108 130109 130201 130202 130203 130204 130205 130206'.split(' '),
      ...'130303 130304 130305 130306 130307 130308 130309 130310 130311 130312 130313 130314'.split(
        ' ',
      ),
      ...'130403 130404 130405 130406 130501'.split(' '),
    ];
    expect(new Set(codes).size).toBe(27);
    const all = tb.replace(/(\d{6})–(\d{6})/g, (_m, a: string, b: string) =>
      codes.filter((c) => c >= a && c <= b).join(' '),
    );
    for (const c of codes) expect(all).toContain(c);
    expect(tb).toContain('«فصل سیزدهم. عایق‌کاری رطوبتی»');
    expect(tb).toContain('27 price rows');
    expect(tb).toContain('the measurement basis is the visible surface of damp-proofed work');
    expect(tb).toContain('no separate cost for overlap');
    expect(tb).toContain('is included in their price');
    expect(tb).toContain('beyond them NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(tb).toContain(
      'How the printed tolerance band enters the pro-rata calculation is NOT_SPECIFIED',
    );
    expect(tb).toContain('not measurement sources');
    expect(tb).toContain('nothing from Chapters 8–12 is imported');
    expect(tb).toContain('price cells of 130311 and 130312 read one (not used as prices)');
    expect(tb).toContain('no default rounding, combination, extrapolation or price');
    expect(tb).not.toContain('UNRESOLVED');
    expect(tb.replace(/3\.5-[A-Z]+|1504-2/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
  });

  it('Chapter 14 inventory, insulation and fire-coating rules, incomplete cases (Phase 3.5-AP)', () => {
    const u = c12
      .slice(c12.indexOf('**U. Chapter 14'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'140111 140112 140113 140114 140115 140116 140117 140118 140119 140120 140121 140122 140123 140124'.split(
        ' ',
      ),
      ...'140125 140126 140127 140128 140211 140212 140213 140214 140215 140216 140217 140218'.split(
        ' ',
      ),
      ...'140311 140312 140313 140314 140315 140316 140411 140412 140511 140611 140612'.split(' '),
      ...'140711 140712 140713 140714 140715 140716 140717 140718 140807'.split(' '),
    ];
    expect(new Set(codes).size).toBe(46);
    const all = u.replace(/(\d{6})–(\d{6})/g, (_m, a: string, b: string) =>
      codes.filter((c) => c >= a && c <= b).join(' '),
    );
    for (const c of codes) expect(all).toContain(c);
    expect(u).toContain('«فصل چهاردهم. عایق‌کاری حرارتی و پوشش‌های مقاوم در برابر آتش»');
    expect(u).toContain('46 price rows');
    expect(u).toContain(
      'except fire-resistant coatings, the measurement basis is the visible insulated surface',
    );
    expect(u).toContain('the hole area is counted on one side and deducted on the other');
    expect(u).toContain('This formula is VERIFIED_SPEC_ONLY for the group 1 add-ons');
    expect(u).toContain('is NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(u).toContain('Exactly 90 falls under up to 90');
    expect(u).toContain('140807 has no price (never priced)');
    expect(u).toContain('deductions, not prices');
    expect(u).toContain('the Chapter 13 overlap rule (block T) is not imported');
    expect(u).toContain('material and technical only');
    expect(u).toContain('no default rounding, combination, extrapolation or price');
    expect(u).not.toContain('UNRESOLVED');
    expect(u.replace(/3\.5-[A-Z]+|8299-1|17197-1/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
  });

  it('Chapter 15 is absent from the 1404 Pricebook (Phase 3.5-AQ)', () => {
    const v = c12
      .slice(c12.indexOf('**V. Chapter 15'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    expect(v).toContain('No «فصل پانزدهم» is listed');
    expect(v).toContain(
      'printed p118 (rendered and viewed) opens «فصل شانزدهم. کارهای فولادی سبک»',
    );
    expect(v).toContain('so there are 0 items');
    expect(v).toContain('NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(v).toContain('must not create, infer or import a Chapter 15');
    expect(v).toContain('Chapter 16 is not audited in this phase');
    expect(v).not.toContain('UNRESOLVED');
    expect(v.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    expect(c12.match(/\*\*V\. Chapter 15/g)).toHaveLength(1);
  });

  it('Chapter 16 light steel inventory, rules and incomplete cases (Phase 3.5-AR)', () => {
    const w = c12
      .slice(c12.indexOf('**W. Chapter 16'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'160101 160102 160103 160104 160105 160106 160107'.split(' '),
      ...'160201 160202 160203 160204 160205 160206 160207 160208 160210 160211 160213 160215'.split(
        ' ',
      ),
      ...'160221 160222 160223 160224 160225 160230 160231'.split(' '),
      ...'160301 160302 160303 160305 160306 160307 160309 160311 160315'.split(' '),
      ...'160401 160402 160403 160404 160405 160406 160408 160409 160410 160417 160418'.split(' '),
      ...'160419 160420 160421 160422 160501'.split(' '),
      ...'160601 160602 160603 160604 160605 160606 160607 160608 160609 160610 160611'.split(' '),
      ...'160612 160613 160614 160615 160616 160617 160618'.split(' '),
      ...'160701 160702 160703 160704 160705 160706 160707 160801'.split(' '),
      ...'160901 160902 160905 160906 160907'.split(' '),
    ];
    expect(new Set(codes).size).toBe(82);
    for (const c of codes) expect(w).toContain(c);
    expect(w).toContain('«فصل شانزدهم. کارهای فولادی سبک»');
    expect(w).toContain('printed pp. 118–131');
    expect(w).toContain('82 price rows');
    expect(w).toContain('door and window rows are weighed without hardware');
    expect(w).toContain('no add-on for extra weight or dimensions beyond the drawings');
    expect(w).toContain('exactly one m² in 160601 and 160602 is NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(w).toContain('adds one and a half percent per kg per m³');
    expect(w).toContain('adds two and a half percent per kg per m³');
    expect(w).toContain(
      'Combination order of the density, slope, thickness, height and external-wall add-ons is not stated',
    );
    expect(w).toContain(
      '160225, 160501, 160705, 160801, 160906, 160907 have no printed price; each is INCOMPLETE',
    );
    expect(w).toContain('The star-item instruction for 160801 is EXTERNAL_DEPENDENCY');
    expect(w).toContain('they do not leak to Chapter 14, Chapter 17 or other chapters');
    expect(w).toContain('Chapter 15 stays absent (block V)');
    expect(w).not.toContain('UNRESOLVED');
    expect(w.replace(/3\.5-[A-Z]+|12172-1/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(c12.match(/\*\*W\. Chapter 16/g)).toHaveLength(1);
    expect(
      c12
        .slice(c12.indexOf('**V. Chapter 15'), c12.indexOf('**W. Chapter 16'))
        .match(/\b15\d{4}\b/g) ?? [],
    ).toEqual([]);
  });

  it('Chapter 17 aluminium inventory, rules and incomplete cases (Phase 3.5-AS)', () => {
    const x = c12
      .slice(c12.indexOf('**X. Chapter 17'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'170102 170110 170111 170113 170115 170117 170204 170205 170206 170209 170211'.split(' '),
      ...'170213 170214 170216 170301 170303 170305 170308 170401 170402 170403 170404'.split(' '),
      ...'170501 170502 170503 170603 170604 170605 170606 170705 171001 171002 171004'.split(' '),
      ...'171005 171007 171008 171010 171012 171013 171015 171016 171201 171202 171203'.split(' '),
    ];
    expect(new Set(codes).size).toBe(44);
    for (const c of codes) expect(x).toContain(c);
    expect(x).toContain('«فصل هفدهم. کارهای آلومینیومی»');
    expect(x).toContain('printed pp. 132–138');
    expect(x).toContain('44 price rows');
    expect(x).toContain('kg rows are paid by the aluminium weight used, without hardware');
    expect(x).toContain(
      'the weighed weight governs, but not more than the theoretical weight plus the maximum tolerance',
    );
    expect(x).toContain('measured by the installed, visible sheet surface');
    expect(x).toContain('Exactly a quarter of a square metre is NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(x).toContain('fall in no row: NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(x).toContain('Combination order of add-ons is not stated');
    expect(x).toContain('170308 and 171016 have no printed price; each is INCOMPLETE');
    expect(x).toContain('Star-item instruction (EXTERNAL_DEPENDENCY)');
    expect(x).toContain('they do not leak to Chapter 14, Chapter 16, Chapter 18 or other chapters');
    expect(x).toContain('Chapter 15 stays absent (block V)');
    expect(x).not.toContain('UNRESOLVED');
    expect(x.replace(/3\.5-[A-Z]+|8299-1/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(x.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    expect(c12.match(/\*\*X\. Chapter 17/g)).toHaveLength(1);
    expect(c12.match(/\*\*W\. Chapter 16/g)).toHaveLength(1);
  });

  it('Chapter 18 plastering inventory, rules and incomplete cases (Phase 3.5-AT)', () => {
    const y = c12
      .slice(c12.indexOf('**Y. Chapter 18'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'180201 180202 180203 180210 180211 180212 180215 180216 180217 180218 180220 180221 180225 180226'.split(
        ' ',
      ),
      ...'180301 180302 180304 180305 180306 180308 180309 180310 180312 180313 180314 180321 180322 180323'.split(
        ' ',
      ),
      ...'180325 180330 180331 180335 180401 180402 180403 180404 180501 180502 180503'.split(' '),
      ...'180601 180602 180603 180604 180605 180606 180608 180609 180701 180704'.split(' '),
      ...'180801 180802 180803 180804 180805 180808 180809 180810 180811 180815 180817 180818'.split(
        ' ',
      ),
      ...'180901 180902 180911 180912 180913 180914 180915 180916 180917 180918 180925 180926 180927'.split(
        ' ',
      ),
      ...'180930 180931 180932 180935 180936 180937 180940 180941 180942 180943 181001 181002 181003'.split(
        ' ',
      ),
      ...'181103 181104 181105 181106 181107 181108 181109 181112 181113 181115 181116 181117'.split(
        ' ',
      ),
      ...'181201 181202 181203 181204'.split(' '),
    ];
    expect(new Set(codes).size).toBe(103);
    for (const c of codes) expect(y).toContain(c);
    expect(y).toContain('«فصل هجدهم. اندودکاری و بندکشی»');
    expect(y).toContain('printed pp. 139–149');
    expect(y).toContain('103 price rows');
    expect(y).toContain('the measurement basis of plastering is the plastered surface');
    expect(y).toContain('exactly 30 degrees is vertical');
    expect(y).toContain('takes an add-on of 20 percent');
    expect(y).toContain('width exactly 50 cm qualifies');
    expect(y).toContain('exactly a quarter of a square metre is NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(y).toContain('paid once from 180925 to 180927');
    expect(y).toContain('Combination of the 20 and 30 percent add-ons');
    expect(y).toContain('180811 and 180818 have no printed price');
    expect(y).toContain('180322, 181002 and 181112 read one');
    expect(y).toContain('negative deductions, not prices');
    expect(y).toContain('Star-item instruction (EXTERNAL_DEPENDENCY)');
    expect(y).toContain('they do not leak to Chapter 16, Chapter 17, Chapter 19 or other chapters');
    expect(y).toContain('Chapter 15 stays absent (block V)');
    expect(y).not.toContain('UNRESOLVED');
    expect(y.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(y.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of ['W. Chapter 16', 'X. Chapter 17', 'Y. Chapter 18'])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 19 wood works inventory, rules and incomplete cases (Phase 3.5-AU)', () => {
    const z = c12
      .slice(c12.indexOf('**Z. Chapter 19'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'190110 190111 190112 190113 190210 190211 190212 190213 190214 190301 190302 190303'.split(
        ' ',
      ),
      ...'190304 190305 190405 190406 190407 190408 190409 190410 190411 190412 190413 190414'.split(
        ' ',
      ),
      ...'190501 190502 190603 190604 190605 190610 190611 190612 190613 190614 190702 190706'.split(
        ' ',
      ),
      ...'190801 190802 191006 191007 191008 191009 191011 191012 191019 191101 191102 191103'.split(
        ' ',
      ),
      ...'191104 191106 191108 191109 191204 191205 191206 191210 191211 191212 191213 191216'.split(
        ' ',
      ),
      ...'191217 191218 191219 191220 191223 191224 191225 191228 191229 191230 191231 191235'.split(
        ' ',
      ),
      ...'191236 191240 191241 191242 191502 191505 191506 191602 191603 191604 191605 191606'.split(
        ' ',
      ),
      ...'191607 191610 191611 191612 191613 191614 191617 191618 191620 191622 191801 191802'.split(
        ' ',
      ),
      ...'191803 191901 191902 191903 191907 191908 192001 192101'.split(' '),
    ];
    expect(new Set(codes).size).toBe(104);
    for (const c of codes) expect(z).toContain(c);
    expect(z).toContain('«فصل نوزدهم. کارهای چوبی»');
    expect(z).toContain('printed pp. 150–161');
    expect(z).toContain('104 price rows');
    expect(z).toContain('190501 leaf (لنگه)');
    expect(z).toContain('clause 7 REPLACES clause 14 for this chapter');
    expect(z).toContain('measured by the visible installed surface; thickness is not counted');
    expect(z).toContain('the inner grid rows are deducted, but framing, facing and veneer are not');
    expect(z).toContain('exactly a quarter of a square metre is NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(z).toContain('OSB2 is paid at 80 percent of the related rows');
    expect(z).toContain('no row 191010 exists');
    expect(z).toContain('sections between 40 and 50 or 75 and 100 square cm');
    expect(z).toContain(
      'conversion from the m² base rows 191901 to 191903 to the m³ add-on 191907',
    );
    expect(z).toContain('191236 and 192101 have no printed price; 191505 reads one');
    expect(z).toContain('negative deduction per m³, not a price');
    expect(z).toContain('Star-item instruction (EXTERNAL_DEPENDENCY)');
    expect(z).toContain(
      'they do not leak to Chapter 16, Chapter 17, Chapter 18, Chapter 20 or other chapters',
    );
    expect(z).toContain('Chapter 15 stays absent (block V)');
    expect(z).not.toContain('UNRESOLVED');
    expect(z.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(z.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of ['W. Chapter 16', 'X. Chapter 17', 'Y. Chapter 18', 'Z. Chapter 19'])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 20 ceramic tiling inventory, rules and incomplete cases (Phase 3.5-AV)', () => {
    const aa = c12
      .slice(c12.indexOf('**AA. Chapter 20'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'200121 200122 200123 200124 200125 200126 200127 200201 200202 200321'.split(' '),
      ...'200322 200323 200324 200325 200326 200327 200411 200511 200611 200612'.split(' '),
      ...'200613 200614 200615 200616 200711 200712 200801 200802 200803'.split(' '),
    ];
    expect(new Set(codes).size).toBe(29);
    for (const c of codes) expect(aa).toContain(c);
    expect(aa).toContain('«فصل بیستم. کاشی‌کاری با کاشی‌های سرامیکی»');
    expect(aa).toContain('printed pp. 162–167');
    expect(aa).toContain('29 price rows');
    expect(aa).toContain('m², except 200802 m');
    expect(aa).toContain('measured on the visible finished tiled surface');
    expect(aa).toContain('exactly 30 degrees is vertical');
    expect(aa).toContain('any thickness, no add-on or deduction');
    expect(aa).toContain('pointing from 180809 where the joint is 3 mm or more');
    expect(aa).toContain('group Ia (below half a percent) adds 29 percent');
    expect(aa).toContain('clause 9-1 states no exclusion');
    expect(aa).toContain('pool tile pieces above 1 dm²');
    expect(aa).toContain('absorption between 3 and 10 percent');
    expect(aa).toContain('200127 and 200327 have no printed price; each is INCOMPLETE');
    expect(aa).toContain('200803 is a negative deduction, not a price');
    expect(aa).toContain('Source inconsistencies: none confirmed');
    expect(aa).toContain('Star-item instruction (EXTERNAL_DEPENDENCY)');
    expect(aa).toContain(
      'they do not leak to Chapter 16, Chapter 17, Chapter 18, Chapter 19, Chapter 21 or other chapters',
    );
    expect(aa).toContain('Chapter 15 stays absent (block V)');
    expect(aa).not.toContain('UNRESOLVED');
    expect(aa.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(aa.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 21 mosaic and concrete paving inventory, rules and incomplete cases (Phase 3.5-AW)', () => {
    const ab = c12
      .slice(c12.indexOf('**AB. Chapter 21'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'210105 210106 210107 210108 210205 210206 210305 210306 210307 210308 210403 210404'.split(
        ' ',
      ),
      ...'210511 210512 210513 210514 210601 210602 210701 210702 210703 210801 210802'.split(' '),
    ];
    expect(new Set(codes).size).toBe(23);
    for (const c of codes) expect(ab).toContain(c);
    expect(ab).toContain('«فصل بیست و یکم. فرش موزاییک و کفپوش بتنی»');
    expect(ab).toContain('printed pp. 168–172');
    expect(ab).toContain('23 price rows');
    expect(ab).toContain('every row is m²');
    expect(ab).toContain('measurement is on the executed work surface');
    expect(ab).toContain('joint area is not deducted');
    expect(ab).toContain('paid at 50 percent of 180308 to 180310');
    expect(ab).toContain('coefficient one and six hundredths (multiplier)');
    expect(ab).toContain('Exactly 20 percent takes no coefficient');
    expect(ab).toContain('paver thickness above 8 cm and partial centimetres');
    expect(ab).toContain('all 23 rows carry a printed price');
    expect(ab).toContain('the engine must not extend 210702 to groups 5 and 6');
    expect(ab).toContain('No star-item instruction is cited in this chapter');
    expect(ab).toContain(
      'they do not leak to Chapter 18, Chapter 19, Chapter 20, Chapter 22 or other chapters',
    );
    expect(ab).toContain('Chapter 15 stays absent (block V)');
    expect(ab).not.toContain('UNRESOLVED');
    expect(ab.replace(/3\.5-[A-Z]+|755-[12]/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(ab.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 22 slab-stone works inventory, rules and incomplete cases (Phase 3.5-AX)', () => {
    const ac = c12
      .slice(c12.indexOf('**AC. Chapter 22'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'220110 220113 220114 220115 220116 220117 220118 220121 220124 220125 220126 220127'.split(
        ' ',
      ),
      ...'220128 220129 220130 220131 220134 220136 220139 220140 220141 220142 220143 220144'.split(
        ' ',
      ),
      ...'220145 220146 220147 220148 220151 220154 220155 220156 220157 220160 220205 220208'.split(
        ' ',
      ),
      ...'220211 220212 220215 220320 220321 220322 220325 220328 220329 220330 220331 220332'.split(
        ' ',
      ),
      ...'220333 220334 220335 220336 220338 220339 220340 220341 220344 220345 220346 220347'.split(
        ' ',
      ),
      ...'220348 220349 220350 220351 220352 220353 220354 220355 220360 220410 220413 220416'.split(
        ' ',
      ),
      ...'220417 220420 220423 220424 220430 220510 220511 220514 220515 220516 220517 220520'.split(
        ' ',
      ),
      ...'220521 220522 220525 220526 220529 220530 220533 220536 220539 220542 220543 220546'.split(
        ' ',
      ),
      ...'220550 220601 220602 220603 220604 220605 220607 220610 220611 220612 220613 220614'.split(
        ' ',
      ),
      ...'220615 220616 220617 220620 220710 220711 220712 220713 220801 220802 220803 220804'.split(
        ' ',
      ),
      ...'220805 220806 220807 220808 220809 220910 220911 220912 220913 220914 220915 220916'.split(
        ' ',
      ),
      ...'220917 220918 220925 221001 221002 221003 221004 221101 221102 221201 221202 221203'.split(
        ' ',
      ),
    ];
    expect(new Set(codes).size).toBe(144);
    for (const c of codes) expect(ac).toContain(c);
    expect(ac).toContain('«فصل بیست و دوم. کارهای سنگی با سنگ پلاک»');
    expect(ac).toContain('printed pp. 173–187');
    expect(ac).toContain('Printed p188 opens «فصل بیست و سوم. کارهای پلاستیکی و پلیمری»');
    expect(ac).toContain('144 price rows');
    expect(ac).toContain('134 rows are m² and 10 rows are metres');
    expect(ac).toContain('measurement is on the finished exposed work surface');
    expect(ac).toContain('up to 30 degrees from vertical are vertical');
    expect(ac).toContain('joint area is not deducted');
    expect(ac).toContain('width more than 40 up to a maximum of 60 cm adds 35 percent');
    expect(ac).toContain('each half cm added brings 25 percent');
    expect(ac).toContain('one and three tenths by one and five tenths of the two-cm price');
    expect(ac).toContain('15 percent of the base price of the two-cm stone is deducted');
    expect(ac).toContain('the joint filling is paid separately from 180808');
    expect(ac).toContain('paid at 50 percent of 180308 to 180310');
    expect(ac).toContain('paid at 50 percent of 180304 to 180306');
    expect(ac).toContain('cubes of 10 by 10 by 10 cm add 50 percent');
    expect(ac).toContain('counts 75 percent of the related rows');
    expect(ac).toContain('coefficient one and five hundredths');
    expect(ac).toContain('comes from 050102 or 060102');
    expect(ac).toContain('comes from 160223 and 160224, aluminium profiles from 170117');
    expect(ac).toContain('cross-section of 30 cm² or less');
    expect(ac).toContain('each is INCOMPLETE, never priced from neighbouring rows');
    expect(ac).toContain(
      '220124, 220125, 220126, 220129, 220130, 220140, 220141, 220147, 220620, 220803, 220913, 220917, 220918',
    );
    expect(ac).toContain('The cell of 220804 reads one and is INCOMPLETE as a price');
    expect(ac).toContain('220925 is a negative deduction (کسر بها), not a price');
    expect(ac).toContain('cites standard 5696 with the marble title');
    expect(ac).toContain('the engine must not convert units or assume a per-metre basis');
    expect(ac).toContain('publication 714 for 221101 and 221102 (EXTERNAL_DEPENDENCY');
    expect(ac).toContain(
      'the star-item instruction for slab width above 60 cm, slab thickness above 4 cm and 220620 (EXTERNAL_DEPENDENCY',
    );
    expect(ac).toContain('partial half-cm thickness steps inside a band');
    expect(ac).toContain('not the Chapter 21 slope coefficient one and six hundredths');
    expect(ac).toContain(
      'they do not leak to Chapter 16, Chapter 17, Chapter 18, Chapter 19, Chapter 20, Chapter 21, Chapter 23 or other chapters',
    );
    expect(ac).toContain('Chapter 15 stays absent (block V)');
    expect(ac).not.toContain('UNRESOLVED');
    expect(ac.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(ac.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 23 plastic and polymer works inventory, rules and incomplete cases (Phase 3.5-AY)', () => {
    const ad = c12
      .slice(c12.indexOf('**AD. Chapter 23'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'230110 230111 230112 230113 230114 230115 230116 230117 230118 230119 230120 230121'.split(
        ' ',
      ),
      ...'230122 230123 230130 230131 230132 230230 230231 230232 230233 230240 230241 230242'.split(
        ' ',
      ),
      ...'230243 230250 230251 230330 230331 230340 230341 230350 230351 230352 230353 230354'.split(
        ' ',
      ),
      ...'230355 230360 230361 230362 230402 230403 230410 230420 230421 230430 230501 230502'.split(
        ' ',
      ),
      ...'230503 230504 230505 230506 230510 230511 230520 230521 230530 230531 230540 230541'.split(
        ' ',
      ),
      ...'230542 230543 230544 230610 230615 230620 230625 230630 230701 230702 230703 230801'.split(
        ' ',
      ),
      ...'230810 230910 230911 230912 230913 230914 230920 230925 230930 230931 231001 231002'.split(
        ' ',
      ),
      ...'231003 231004 231005 231006 231007 231010 231110 231310 231311 231315 231316 231401'.split(
        ' ',
      ),
      ...'231402 231403 231501 231502 231610 231611 231701 231702 231703 231704 231706 231707'.split(
        ' ',
      ),
      ...'231708 231720 231810 231820 231901 231902 232001 232002 232003'.split(' '),
    ];
    expect(new Set(codes).size).toBe(117);
    for (const c of codes) expect(ad).toContain(c);
    expect(ad).toContain('«فصل بیست و سوم کارهای پلاستیکی و پلیمری»');
    expect(ad).toContain('printed pp. 188–204');
    expect(ad).toContain('Printed p205 opens «فصل بیست وچهارم. شیشه و نصب آن»');
    expect(ad).toContain('117 price rows');
    expect(ad).toContain('nineteen groups with no group 12');
    expect(ad).toContain('group requirements for seventeen of the nineteen groups');
    expect(ad).toContain('1-5 to 12-5');
    expect(ad).toContain(
      '71 rows are m², 20 are metres, 12 are kilograms, 12 are count and 2 are cubic decimetres',
    );
    expect(ad).toContain('executed work surface without counting the corrugation or the overlap');
    expect(ad).toContain('per the perimeter of the intersection of the base with the substrate');
    expect(ad).toContain('per the horizontal projection of the useful dimensions of the bubble');
    expect(ad).toContain('the lower weight is the basis');
    expect(ad).toContain('up to one tenth of a millimetre');
    expect(ad).toContain('no deduction or add-on is considered on this account');
    expect(ad).toContain('coefficient one and one tenth');
    expect(ad).toContain('coefficient eighty-five hundredths');
    expect(ad).toContain('with coefficient one and two tenths');
    expect(ad).toContain(
      'adds 40 percent for 231701 and 231702, 60 percent for 231706 and 10 percent for 231707 and 231708',
    );
    expect(ad).toContain('one facade side adds 15 percent and on two facade sides 25 percent');
    expect(ad).toContain('pro rata to the increase or decrease of thickness');
    expect(ad).toContain('each is INCOMPLETE, never priced from neighbouring rows');
    expect(ad).toContain('231401, 231402, 231403, 231501 and 231502');
    expect(ad).toContain('No cell reads one, and no negative price is printed');
    expect(ad).toContain('prints 62,100 rials');
    expect(ad).toContain('group twelve of this chapter');
    expect(ad).toContain('no 2312xx row is printed');
    expect(ad).toContain('the engine must not invent a group 12');
    expect(ad).toContain('Chapter 13 prints 130403, 130404 and 130405 in that group and no 130406');
    expect(ad).toContain('the engine must not substitute 130405');
    expect(ad).toContain(
      'Groups 7 and 15 carry priced rows without a written requirements section',
    );
    expect(ad).toContain('star-item instruction (EXTERNAL_DEPENDENCY)');
    expect(ad).toContain('every other cited code is a printed row');
    expect(ad).toContain('they do not leak to Chapter 22 or any other chapter');
    expect(ad).toContain('Chapter 15 stays absent (block V)');
    expect(ad).not.toContain('UNRESOLVED');
    expect(ad.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(ad.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 24 glass and its installation inventory, rules and incomplete case (Phase 3.5-AZ)', () => {
    const ae = c12
      .slice(c12.indexOf('**AE. Chapter 24'), c12.indexOf('**AF. Chapter 25'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'240102 240103 240104 240105 240106 240108 240201 240202 240204 240205 240211 240301'.split(
        ' ',
      ),
      ...'240302 240303 240304 240305 240307 240308 240315 240401 240402 240410 240501 240502'.split(
        ' ',
      ),
      ...'240505 240506 240507 240510 240601 240602 240605 240709 240710 240711 240715 240716'.split(
        ' ',
      ),
      ...'240720 240725 240726 240804 240805 240806 240807'.split(' '),
    ];
    expect(new Set(codes).size).toBe(43);
    for (const c of codes) expect(ae).toContain(c);
    const six = (ae.match(/\b\d{6}\b/g) ?? []).filter((c) => c !== '536342');
    expect(six.every((c) => c.startsWith('24'))).toBe(true);
    const tableCodes = (
      ae.slice(ae.indexOf('| group'), ae.indexOf('Row descriptions:')).match(/\b\d{6}\b/g) ?? []
    ).filter((c) => c !== '536342');
    expect([...new Set(tableCodes)].sort()).toEqual([...new Set(codes)].sort());
    expect(ae).toContain('«فصل بیست وچهارم. شیشه و نصب آن»');
    expect(ae).toContain('printed pp. 205–210');
    expect(ae).toContain('Printed p211 opens «فصل بیست و پنجم. رنگ آمیزی»');
    expect(ae).toContain('43 price rows');
    expect(ae).toContain('40 rows are m² and 3 rows are metres (240605, 240725 and 240726)');
    expect(ae).toContain('Every group has both written requirements and priced rows');
    expect(ae).toContain('no group number is missing or duplicated');
    expect(ae).toContain('the group table, groups 01 to 08');
    expect(ae).toContain(
      'Rows 240102 to 240402 are printed on p208, rows 240410 to 240716 on p209 and rows 240720 to 240807 on p210',
    );
    expect(ae).toContain('240102: 3,069,000');
    expect(ae).toContain('240211: 17,460,000');
    expect(ae).toContain('240507: 56,000,000');
    expect(ae).toContain('240605: 568,500');
    expect(ae).toContain('240711: 120,000');
    expect(ae).toContain('240725: 1,117,000');
    expect(ae).toContain('240806: 8,113,000');
    expect(ae).toContain('240807: no printed price');
    expect(ae).toContain('Add-on rows (اضافه‌بها): 240315');
    expect(ae).toContain(
      'No deduction (کسر بها) row and no negative price is printed in this chapter',
    );
    expect(ae).toContain(
      'the measurement basis of the rows of this chapter is the glass surface that is installed',
    );
    expect(ae).toContain('the surface of the glass tile or hollow glass block itself');
    expect(ae).toContain('the entire glass surface of which all or a part is frosted');
    expect(ae).toContain(
      'counted for one glass surface and only once for double- or triple-glazed glass',
    );
    expect(ae).toContain('counted per lamination when there is more than one');
    expect(ae).toContain('per metre of the perimeter of the glazed unit');
    expect(ae).toContain('cutting to size (قواره‌کردن)');
    expect(ae).toContain('opening and re-closing the beads (زهوارها)');
    expect(ae).toContain('from rows 240709 to 240711');
    expect(ae).toContain('do not include bent glass or curved cutting');
    expect(ae).toContain(
      'an area of five hundredths of a square metre or more and a smallest surface dimension of at least 100 millimetres',
    );
    expect(ae).toContain('50 percent');
    expect(ae).toContain('30 percent');
    expect(ae).toContain('star-item instruction (EXTERNAL_DEPENDENCY)');
    expect(ae).toContain('the extra price of row 240716 is applied');
    expect(ae).toContain('the steel mesh (شبکه فولادی) is paid separately from the related rows');
    expect(ae).toContain(
      'two and a half to 3 centimetres and of row 240505 is 1 to one and a half centimetres',
    );
    expect(ae).toContain('the cost of the air or the other gases between the panes is included');
    expect(ae).toContain(
      'one square metre from 240303, two square metres from 240104, 4 metres from 240725, one square metre from 240806 and one square metre from 240715',
    );
    expect(ae).toContain('the treatment of glass pieces below the clause 5 limits');
    expect(ae).toContain(
      'the combination order of the clause 6 percentages with the flat add-on rows',
    );
    expect(ae).toContain('the engine must not extend clause 6 to any other glass type');
    expect(ae).toContain('INCOMPLETE — NO PRINTED PRICE, never priced from neighbouring rows');
    expect(ae).toContain('No cell reads one, and no negative price is printed');
    expect(ae).toContain('below the 6,688,000 rials of the 5 millimetre row 240302');
    expect(ae).toContain('both values are recorded as printed and neither is corrected');
    expect(ae).toContain('no footnote text printed anywhere in the chapter');
    expect(ae).toContain('no missing code is inferred from the numerical sequences');
    expect(ae).toContain('Chapter 24 cites no row of any other chapter');
    expect(ae).toContain('10673-2, 10673-5, 10673-6, 2385, 14496, 3241, 16372, 8521-1 and 16373');
    expect(ae).toContain('shows 536342 there where the glyph-validated code is 240605');
    expect(ae).toContain('they do not leak to Chapter 23 or any other chapter');
    expect(ae).toContain('no rule of Chapters 16 to 23 is imported');
    expect(ae).toContain('Chapter 15 stays absent (block V)');
    expect(ae).not.toContain('UNRESOLVED');
    expect(ae.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(ae.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 25 painting inventory, rules and incomplete cases (Phase 3.5-BA)', () => {
    const af = c12
      .slice(c12.indexOf('**AF. Chapter 25'), c12.indexOf('**AG. Chapter 26'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'250101 250103 250104 250304 250305 250320 250321 250322 250323 250324 250325 250326'.split(
        ' ',
      ),
      ...'250330 250331 250332 250333 250334 250335 250336 250340 250345 250350 250401 250403'.split(
        ' ',
      ),
      ...'250404 250405 250406 250501 250502 250503 250506 250507 250508 250601 250602 250603'.split(
        ' ',
      ),
      ...'250604 250701 250703 250705 250706 250707 250708 250801 250802'.split(' '),
    ];
    expect(new Set(codes).size).toBe(45);
    for (const c of codes) expect(af).toContain(c);
    const six = af.match(/\b\d{6}\b/g) ?? [];
    expect(six.every((c) => c.startsWith('25'))).toBe(true);
    const tableCodes =
      af.slice(af.indexOf('| group'), af.indexOf('Row descriptions:')).match(/\b\d{6}\b/g) ?? [];
    expect([...new Set(tableCodes)].sort()).toEqual([...new Set(codes)].sort());
    expect(af).toContain('«فصل بیست و پنجم. رنگ آمیزی»');
    expect(af).toContain('printed pp. 211–218');
    expect(af).toContain(
      'Printed p219 opens «فصل بیست وششم. زیراساس و اساس» (the opening page prints «زیراساس» as one word while the running headers print «زیر اساس و اساس»)',
    );
    expect(af).toContain('45 price rows');
    expect(af).toContain('42 rows are m² and 3 rows are metres (250601, 250602 and 250604)');
    expect(af).toContain('seven groups with no group 02');
    expect(af).toContain('group requirements for all seven groups');
    expect(af).toContain(
      'Rows 250101 to 250330 are printed on p215, rows 250331 to 250405 on p216, rows 250406 to 250706 on p217 and rows 250707 to 250802 on p218',
    );
    expect(af).toContain('250101: 265,500');
    expect(af).toContain('250320: 1,216,000');
    expect(af).toContain('250405: 9,848,000');
    expect(af).toContain('250503: 420,500');
    expect(af).toContain('250603: 6,319,000');
    expect(af).toContain('250604: 14,800');
    expect(af).toContain('250707: 1,130,000');
    expect(af).toContain('250801: no printed price; 250802: no printed price');
    expect(af).toContain('Add-on rows (اضافه‌بها): 250604');
    expect(af).toContain(
      'No deduction (کسر بها) row and no negative price is printed in this chapter',
    );
    expect(af).toContain('supplements Clause 14; no rule replaces it');
    expect(af).toContain(
      'counted one side, unless the developed painted surface of the members exceeds',
    );
    expect(af).toContain('the developed painted surface is the basis');
    expect(af).toContain('the glazed area of doors is deducted from both sides');
    expect(af).toContain('counted one side like a window');
    expect(af).toContain('apparent surface on the basis of the nominal diameter');
    expect(af).toContain('measured on the painted length');
    expect(af).toContain('50 percent is added to the price of the related rows');
    expect(af).toContain('the engine must not extend it beyond those members');
    expect(af).toContain('نشریه 306 «آمادهسازی و تمیزکاری سطوح فلزی جهت اجرای پوشش»');
    expect(af).toContain('row 250101 is set at cleaning grade St 2');
    expect(af).toContain('Sa two and a half');
    expect(af).toContain('with coefficient nine tenths');
    expect(af).toContain('with coefficient one and eight tenths');
    expect(af).toContain('with coefficient one and three tenths');
    expect(af).toContain('with coefficient sixty-five hundredths');
    expect(af).toContain('at most 60 micron, then for every 10 micron, 20 percent');
    expect(af).toContain('a deduction of 10 micron is computed pro rata');
    expect(af).toContain('so 40 percent is added to row 250332');
    expect(af).toContain('so 80 percent of the price of row 250340 is considered');
    expect(af).toContain('240 percent of the price of row 250324 is considered');
    expect(af).toContain(
      'Iranian National Standard 6594 «حفاظت سازههای فولادی در برابر خوردگی با استفاده از سیستم رنگهای محافظ»',
    );
    expect(af).toContain('the cost of post-erection painting touch-up is included');
    expect(af).toContain(
      'row 250321, the iron-oxide alkyd, is the ordinary anti-rust paint in the ochre colour',
    );
    expect(af).toContain('must be executed with vehicle machinery');
    expect(af).toContain('the add-on 250604 applies');
    expect(af).toContain('60 to 70 percent oil and 20 to 30 percent phthalic anhydride');
    expect(af).toContain('determined per the star-item instruction (EXTERNAL_DEPENDENCY)');
    expect(af).toContain('the lower bound of the 5-3 adjustment below 40 micron');
    expect(af).toContain(
      'the combination order of the coefficients of 3-1, 4-1, 5-1, 6-3, 7-3 and 9-3',
    );
    expect(af).toContain('INCOMPLETE — NO PRINTED PRICE, never priced from neighbouring rows');
    expect(af).toContain('No cell reads one, and no negative price is printed');
    expect(af).toContain('the engine must not invent group 2 or any 2502xx row');
    expect(af).toContain('but 250102 is not printed as a row');
    expect(af).toContain(
      'the engine must not invent 250102 or redirect the citation to another row',
    );
    expect(af).toContain('no missing code or price is inferred');
    expect(af).toContain('no footnote text is printed anywhere in the chapter');
    expect(af).toContain('Row 250345 prints «اجرایرنگ» without the intervening space');
    expect(af).toContain('Rows 250325 and 250326 both print 1,152,000 rials');
    expect(af).toContain('No duplicate code was found');
    expect(af).toContain('Chapters 7, 9 and 16 are cited as subject references only');
    expect(af).toContain(
      'no row of another chapter is cited and no rule of those chapters is imported',
    );
    expect(af).toContain(
      'shows codes 253131, 253133 and 253134 there where the glyph-validated codes are 250101, 250103 and 250104',
    );
    expect(af).toContain('they do not leak to Chapter 24 or any other chapter');
    expect(af).toContain('no rule of Chapters 16 to 24 is imported');
    expect(af).toContain('Chapter 15 stays absent (block V)');
    expect(af).not.toContain('UNRESOLVED');
    expect(af.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(af.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 26 sub-base and base inventory, rules and suspicious price cell (Phase 3.5-BB)', () => {
    const ag = c12
      .slice(c12.indexOf('**AG. Chapter 26'), c12.indexOf('**AH. Chapter 27'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'260101 260102 260103 260301 260302 260303 260401 260601 260603 260604 260605 260701 260702 260801 260802 260803'.split(
        ' ',
      ),
    ];
    expect(new Set(codes).size).toBe(16);
    for (const c of codes) expect(ag).toContain(c);
    const six = (ag.match(/\b\d{6}\b/g) ?? []).filter((c) => c !== '110904');
    expect(six.every((c) => c.startsWith('26'))).toBe(true);
    const tableCodes =
      ag.slice(ag.indexOf('| group'), ag.indexOf('Row descriptions:')).match(/\b\d{6}\b/g) ?? [];
    expect([...new Set(tableCodes)].sort()).toEqual([...new Set(codes)].sort());
    expect(ag).toContain('«فصل بیست وششم. زیراساس و اساس»');
    expect(ag).toContain('printed pp. 219–222');
    expect(ag).toContain('Printed p223 opens «فصل بیست وهفتم. آسفالت»');
    expect(ag).toContain('six groups with no group 02 and no group 05');
    expect(ag).toContain('group requirements for groups 6, 7 and 8 only');
    expect(ag).toContain('the group 6 requirements are a single unnumbered paragraph');
    expect(ag).toContain('16 price rows');
    expect(ag).toContain('all 16 rows are cubic metres (مترمکعب)');
    expect(ag).toContain(
      'Rows 260101 to 260604 are printed on p221 and rows 260605 to 260803 on p222',
    );
    expect(ag).toContain('260101: 4,864,000');
    expect(ag).toContain('260303: 5,674,000');
    expect(ag).toContain('260605: 713,000');
    expect(ag).toContain('260701: 4,855,000');
    expect(ag).toContain('260801: 1,543,000');
    expect(ag).toContain('260803: 1,699,000');
    expect(ag).toContain('260401: price cell reads one');
    expect(ag).toContain('Add-on rows (اضافه‌بها): 260401');
    expect(ag).toContain(
      'No deduction (کسر بها) row and no negative price is printed in this chapter',
    );
    expect(ag).toContain(
      'the volume of the layers after compaction is the operative basis for computing the quantities',
    );
    expect(ag).toContain(
      'no separate payment arises on account of volume change from settlement or compaction',
    );
    expect(ag).toContain('up to 30 kilometres from the production place');
    expect(ag).toContain(
      'haulage beyond 30 kilometres is considered per the related rows of the transport chapter (Chapter 28 — payment reference only)',
    );
    expect(ag).toContain(
      'no separate payment is made for the extra loading, haulage and unloading',
    );
    expect(ag).toContain('river material (رودخانهای)');
    expect(ag).toContain('mountain material (کوهی)');
    expect(ag).toContain('artificial crushing; natural crushing is not meant');
    expect(ag).toContain('cost of procuring and hauling the consumed water is included');
    expect(ag).toContain('نشریه شماره 862');
    expect(ag).toContain(
      '1 percent per each percent of reduction applies to rows 260601, 260603, 260604 and 260605',
    );
    expect(ag).toContain('related rows of Chapter 3 (payment reference only)');
    expect(ag).toContain('Footnote 83, printed with its text on p219, defines توونان');
    expect(ag).toContain('passing sieve No. 200');
    expect(ag).toContain('Unified (یونیفاید) classification it classifies with the G suffix');
    expect(ag).toContain('computed and considered per row 110904');
    expect(ag).toContain(
      'verified as a printed row of Chapter 11, block R — payment reference only',
    );
    expect(ag).toContain('0 to 50 (260301), 0 to 38 (260302) and 0 to 25 (260303)');
    expect(ag).toContain(
      'at least 50 percent of the material retained on sieve No. 4 is crushed on one face',
    );
    expect(ag).toContain('per each 5 percent of extra crush, one time');
    expect(ag).toContain('more than 15 up to 20 centimetres (260603)');
    expect(ag).toContain('more than 10 up to 15 centimetres (260605)');
    expect(ag).toContain('100 percent compaction by the modified AASHTO method (آشتو اصلاحی)');
    expect(ag).toContain('50 kilograms of slaked lime per cubic metre');
    expect(ag).toContain(
      '90 percent compaction (260801), 95 percent (260802) and 100 percent (260803)',
    );
    expect(ag).toContain(
      'تا includes the named upper value and بیش از excludes the named lower value',
    );
    expect(ag).toContain('the treatment of a fractional part of the 5-percent step of 260401');
    expect(ag).toContain('the combination order of the 260401 add-on with the group 6 deduction');
    expect(ag).toContain(
      'the test procedure or acceptance method behind the compaction percentages',
    );
    expect(ag).toContain('EXTERNAL_DEPENDENCY');
    expect(ag).toContain('no specific row is named');
    expect(ag).toContain('INCOMPLETE — SUSPICIOUS PRICE CELL, never priced from neighbouring rows');
    expect(ag).toContain(
      'Rows 260801 and 260802 print the identical price 1,543,000 rials although their compaction percentages differ',
    );
    expect(ag).toContain('the engine must not invent them');
    expect(ag).toContain('no missing code or price is inferred from the sequences');
    expect(ag).toContain('stray conjunction «یا و»');
    expect(ag).toContain('the price of 260401 is a single digit one, HM FLotoos gid 464');
    expect(ag).toContain(
      'The only Latin letter in the chapter is the G of the Unified classification inside footnote 83',
    );
    expect(ag).toContain('they do not leak to Chapter 25 or any other chapter');
    expect(ag).toContain('no rule of Chapters 16 to 25 is imported');
    expect(ag).toContain('Chapter 15 stays absent (block V)');
    expect(ag).not.toContain('UNRESOLVED');
    expect(ag.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(ag.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
      'AG. Chapter 26',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 27 asphalt inventory, rules and negative deduction rows (Phase 3.5-BC)', () => {
    const ah = c12
      .slice(c12.indexOf('**AH. Chapter 27'), c12.indexOf('**AI. Chapter 28'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'270101 270102 270103 270104 270105 270106 270107 270202 270210 270301 270302 270303'.split(
        ' ',
      ),
      ...'270304 270310 270320 270402 270403 270404 270410 270411 270412 270501 270502 270503'.split(
        ' ',
      ),
      ...'270510 270601 270602 270603 270604'.split(' '),
    ];
    expect(new Set(codes).size).toBe(29);
    for (const c of codes) expect(ah).toContain(c);
    const six = (ah.match(/\b\d{6}\b/g) ?? []).filter((c) => c !== '280301' && c !== '280302');
    expect(six.every((c) => c.startsWith('27'))).toBe(true);
    const tableCodes =
      ah.slice(ah.indexOf('| group'), ah.indexOf('Row descriptions:')).match(/\b\d{6}\b/g) ?? [];
    expect([...new Set(tableCodes)].sort()).toEqual([...new Set(codes)].sort());
    expect(ah).toContain('«فصل بیست وهفتم. آسفالت»');
    expect(ah).toContain('printed pp. 223–227');
    expect(ah).toContain('Printed p228 opens «فصل بیست و هشتم. حمل و نقل»');
    expect(ah).toContain('groups 01 to 06 contiguously');
    expect(ah).toContain('group requirements for groups 1, 2, 4, 5 and 6 only');
    expect(ah).toContain('29 price rows');
    expect(ah).toContain(
      '8 rows are kilograms, 3 are square metres (270210, 270501 and 270502), 16 are cubic metres and 2 are cubic decimetres (270503 and 270510)',
    );
    expect(ah).toContain(
      'Rows 270101 to 270320 are printed on p225, rows 270402 to 270602 on p226 and rows 270603 and 270604 on p227',
    );
    expect(ah).toContain('270101: 299,000');
    expect(ah).toContain('270304: 52,806,000');
    expect(ah).toContain('270404: 18,392,000');
    expect(ah).toContain('270510: 1,037,000');
    expect(ah).toContain('270601: 33,486,000');
    expect(ah).toContain('270320: -1,037,000');
    expect(ah).toContain('270403: -2,131,000');
    expect(ah).toContain(
      'Add-on rows (اضافه‌بها): 270202, 270310, 270402, 270404, 270410, 270411, 270412, 270502 and 270604',
    );
    expect(ah).toContain('Deduction rows (کسر بها): 270320 and 270403');
    expect(ah).toContain(
      'classified per their printed wording as deductions from the rows they name, never as costs, and never inputs to a price',
    );
    expect(ah).toContain('cationic CSS of at least 57 percent residual bitumen');
    expect(ah).toContain('cationic CMS of at least 65 percent (270103)');
    expect(ah).toContain('cationic CRS of at least 60 percent (270104)');
    expect(ah).toContain('anionic SS of at least 57 percent (270105)');
    expect(ah).toContain('anionic MS of at least 55 percent (270106)');
    expect(ah).toContain('anionic RS of at least 55 percent (270107)');
    expect(ah).toContain('0 to thirty-seven and a half (270301)');
    expect(ah).toContain('0 to twelve and a half (270304) millimetres');
    expect(ah).toContain('wearing course (قشر رویه)');
    expect(ah).toContain('bituminous base course (قشر اساس قیر)');
    expect(ah).toContain(
      'the volume of the layers after compaction is the operative basis for computing the quantities',
    );
    expect(ah).toContain('added to or deducted from the work price in the same proportion');
    expect(ah).toContain('the source prints only «در حد مجاز» and no limit');
    expect(ah).toContain('the engine must not invent a tolerance or a limit');
    expect(ah).toContain('river material');
    expect(ah).toContain('star-item instruction (EXTERNAL_DEPENDENCY)');
    expect(ah).toContain("must reach the consultant engineer's approval");
    expect(ah).toContain(
      '90 kilograms for 270301, 110 kilograms for 270302 and 270303, 120 kilograms for 270304',
    );
    expect(ah).toContain('90 kilograms for cold in-place mixed asphalt');
    expect(ah).toContain('computed, respectively, from rows 270402 and 270403');
    expect(ah).toContain('up to 30 kilometres from the production place');
    expect(ah).toContain('considered from row 280301 (Chapter 28 — payment reference only)');
    expect(ah).toContain('mechanical broom, compressor');
    expect(ah).toContain('conditional on the execution of row 270210');
    expect(ah).toContain('the add-on rows 270404 to 270412 do not apply to roof asphalt');
    expect(ah).toContain('the price of row 270404 is not considered');
    expect(ah).toContain('execution on all surfaces and by any method');
    expect(ah).toContain('from rows 280301 and 280302 (Chapter 28 — payment reference only)');
    expect(ah).toContain('a fractional 10 kilograms is computed pro rata');
    expect(ah).toContain('a fractional centimetre is computed pro rata');
    expect(ah).toContain('20 square metres and less (270410), more than 20 up to 50 (270411)');
    expect(ah).toContain('width of up to 2 metres');
    expect(ah).toContain('one and a half to 2 centimetres');
    expect(ah).toContain('the permitted range of the clause 4 thickness excess or deficit');
    expect(ah).toContain('the combination order of the add-ons and deductions with one another');
    expect(ah).toContain('the treatment of patch areas above 100 square metres');
    expect(ah).toContain('the application rate of the prime and surface coats');
    expect(ah).toContain('Chapter 28 is not yet audited and no rule of it is imported');
    expect(ah).toContain('no footnote text printed anywhere in the chapter');
    expect(ah).toContain('Rows 270106 and 270107 print the identical price 174,500 rials');
    expect(ah).toContain('no missing code or price is inferred from the sequences');
    expect(ah).toContain(
      'the text layer reads USS, UFS, USS, SS, FS and SS there, while the glyph-validated readings',
    );
    expect(ah).toContain(
      '(gids 38 54 54, 38 48 54, 38 53 54, 54 54, 48 54 and 53 54, with gids 36 to 61 being A to Z) are CSS, CMS, CRS, SS, MS and RS',
    );
    expect(ah).toContain('the cationic rows carry the C prefix and the anionic rows do not');
    expect(ah).toContain('the minus glyph (HM FLotoos gid 16)');
    expect(ah).toContain('they do not leak to Chapter 26 or any other chapter');
    expect(ah).toContain('no rule of Chapters 16 to 26 is imported');
    expect(ah).toContain('Chapter 15 stays absent (block V)');
    expect(ah).not.toContain('UNRESOLVED');
    expect(ah.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(ah.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
      'AG. Chapter 26',
      'AH. Chapter 27',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 28 transport chapter audit, groups, rows and boundaries (Phase 3.5-BD)', () => {
    const ai = c12
      .slice(c12.indexOf('**AI. Chapter 28'), c12.indexOf('**AJ. Chapter 29'))
      .replace(/\s+/g, ' ');
    const codes = [
      ...'280101 280102 280103 280104 280105 280106 280301 280302 280501 280502 280503 280504 280505'.split(
        ' ',
      ),
    ];
    expect(new Set(codes).size).toBe(13);
    for (const c of codes) expect(ai).toContain(c);
    const six = ai.match(/\b\d{6}\b/g) ?? [];
    expect(six.every((c) => c.startsWith('28'))).toBe(true);
    const tableCodes =
      ai
        .slice(ai.indexOf('| group'), ai.indexOf('All 13 rows print positive prices'))
        .match(/\b\d{6}\b/g) ?? [];
    expect([...new Set(tableCodes)].sort()).toEqual([...new Set(codes)].sort());
    expect(ai).toContain('«فصل بیست و هشتم. حمل و نقل»');
    expect(ai).toContain('printed pp. 228–232');
    expect(ai).toContain('Printed p233 opens «فصل بیست و نهم. کارهای دستمزدی»');
    expect(ai).toContain('three groups with no group 02 and no group 04');
    expect(ai).toContain('group requirements for all three printed groups');
    expect(ai).toContain('13 price rows');
    expect(ai).toContain('8 rows are ton-kilometres (تن - کیلومتر)');
    expect(ai).toContain('5 rows are ton-nautical-miles (تن - مایل دریایی)');
    expect(ai).toContain(
      'Rows 280101 to 280503 are printed on p231 and rows 280504 and 280505 on p232',
    );
    expect(ai).toContain('280101: 28,400');
    expect(ai).toContain('280106: 8,130');
    expect(ai).toContain('280301: 37,300');
    expect(ai).toContain('280302: 22,800');
    expect(ai).toContain('280501: 110,700');
    expect(ai).toContain('280505: 18,200');
    expect(ai).toContain('more than 750 kilometres with no printed upper bound (280106)');
    expect(ai).toContain(
      'asphaltic concrete and factory cold asphalt, more than 30 up to 75 kilometres',
    );
    expect(ai).toContain('factory cold asphalt, more than 30 up to 150 kilometres');
    expect(ai).toContain(
      'the sea rows carry no first-30-kilometre deduction and no whole-route wording',
    );
    expect(ai).toContain('All 13 rows print positive prices');
    expect(ai).toContain('no blank cell, no cell reading one and no negative price');
    expect(ai).toContain('block J remains authoritative for the calculation behaviour');
    expect(ai).toContain(
      'included in the prices of the rows of the other chapters of this pricebook',
    );
    expect(ai).toContain('no separate haulage payment is considered');
    expect(ai).toContain('the shortest route on which the cargo vehicles can travel');
    expect(ai).toContain('the coefficient one and three tenths');
    expect(ai).toContain(
      'solely for computing the haulage costs and are not citable for computing material quantities',
    );
    expect(ai).toContain(
      'the coefficient one and fifteen hundredths applied to the prices of the related rows, for the whole route, after deducting 30 kilometres',
    );
    expect(ai).toContain(
      'recorded in the transport-quantity section of §11 and are not restated here',
    );
    expect(ai).toContain('the coefficient one and two tenths from the producing factory (1-4-3)');
    expect(ai).toContain(
      'one and five hundredths kilograms per kilogram of steel consumed in Chapters 7, 9 and 16 (1-4-4)',
    );
    expect(ai).toContain('without deducting the first 30 kilometres with the coefficient 2');
    expect(ai).toContain('two and two tenths tonnes of asphalt is considered for haulage');
    expect(ai).toContain(
      'all costs of loading, transport, unloading and the related dues are included',
    );
    expect(ai).toContain(
      'the rows BC cited are verified as printed — 280301 is the transport of asphaltic concrete and factory cold asphalt',
    );
    expect(ai).toContain('Block AH needs no correction');
    expect(ai).toContain('the treatment of a fractional kilometre or nautical mile');
    expect(ai).toContain('Beyond 150 nautical miles there is no row, per block J');
    expect(ai).toContain(
      'Chapter 8 Group 1 clause 1-1 is cited by 1-2-3 as the source of the cement-content formula',
    );
    expect(ai).toContain('no Latin text and no footnote markers');
    expect(ai).toContain('the engine must not invent them');
    expect(ai).toContain(
      'haulage of asphaltic concrete beyond 75 kilometres therefore has no printed row',
    );
    expect(ai).toContain('the engine must not redirect it to 280302 or any other row');
    expect(ai).toContain('Rows 280504 and 280505 print the identical price 18,200 rials');
    expect(ai).toContain('no missing code or price is inferred from the sequences');
    expect(ai).toContain('The chapter contains no Latin letter, so no Latin decoding was needed');
    expect(ai).toContain('they do not leak to Chapter 27 or any other chapter');
    expect(ai).toContain('no rule of Chapters 16 to 27 is imported');
    expect(ai).toContain('Chapter 15 stays absent (block V)');
    expect(ai).not.toContain('UNRESOLVED');
    expect(ai.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(ai.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
      'AG. Chapter 26',
      'AH. Chapter 27',
      'AI. Chapter 28',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Chapter 29 labour works: one clause, empty table, star-item dependency (Phase 3.5-BE)', () => {
    const aj = c12
      .slice(c12.indexOf('**AJ. Chapter 29'), c12.indexOf('**AK. Appendix 1'))
      .replace(/\s+/g, ' ');
    expect(aj).toContain('«فصل بیست و نهم. کارهای دستمزدی»');
    expect(aj).toContain('printed pp. 233–234');
    expect(aj).toContain(
      'Printed p235 opens «پیوسـت 1. مصالح پای کار» (Appendix 1, materials at the work site, printed with the kashida form «پیوسـت»)',
    );
    expect(aj).toContain('Chapter 29 is the last chapter of the pricebook: no Chapter 30');
    expect(aj).toContain('General Requirements (الزامات عمومی) clause 1 only (p233)');
    expect(aj).toContain(
      'a price table whose header row alone is printed, with no data row (p234)',
    );
    expect(aj).toContain(
      'no group table is printed and no group number, group title or group requirements section exists',
    );
    expect(aj).toContain('the engine must not invent any group');
    expect(aj).toContain('with zero data rows');
    expect(aj).toContain(
      'No code, no description, no unit and no price is printed anywhere in this chapter',
    );
    expect(aj).toContain(
      'there is no blank cell, no suspicious placeholder cell and no negative price',
    );
    expect(aj).toContain(
      'The engine must not invent any row, code, unit or price for this chapter',
    );
    expect(aj).toContain('must not import a row from another chapter or edition');
    expect(aj).toContain(
      "the measurement basis of any future inserted row is that row's own description per the star-item instruction",
    );
    expect(aj).toContain(
      'NOT_SPECIFIED_IN_1404_PRICEBOOK: every measurement and payment aspect of the chapter beyond clause 1',
    );
    expect(aj).toContain('procured by and at the cost of the employer (کارفرما)');
    expect(aj).toContain('including loading, transport and unloading at the site');
    expect(aj).toContain(
      'the necessary handling (جابجاییهای لازم), installation and commissioning (نصب و راهاندازی)',
    );
    expect(aj).toContain('prepared per the star-item instruction and inserted in this chapter');
    expect(aj).toContain('This is the only labour classification the source establishes');
    expect(aj).toContain(
      'no skill category, team composition, productivity, working-hours, overtime, night-work',
    );
    expect(aj).toContain('none is imported; each such aspect is NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(aj).toContain('no overhead or other coefficient of any kind is printed in this chapter');
    expect(aj).toContain(
      'the star-item instruction (دستورالعمل اقلام ستارهدار) of clause 1 is an EXTERNAL_DEPENDENCY',
    );
    expect(aj).toContain('no row, description or price can be formed for this chapter without it');
    expect(aj).toContain('It is already recorded in §11 as title-only');
    expect(aj).toContain('no document number, date or issuing authority is printed');
    expect(aj).toContain('this block adds no procedural detail from it');
    expect(aj).toContain('No row of Chapters 1 to 28 is cited');
    expect(aj).toContain(
      'no standard, no نشریه, no General Conditions clause and no external table is referenced',
    );
    expect(aj).toContain('a price table consisting of a header row with no data rows');
    expect(aj).toContain(
      'No footnote or superscript marker and no Latin text appear anywhere in the chapter',
    );
    expect(aj).toContain('the p234 table carries no numeric glyph at all below its header');
    expect(aj).toContain('confirming at glyph level that no row is printed');
    expect(aj).toContain('The chapter contains no Latin letter, so no Latin decoding was needed');
    expect(aj).toContain('they do not leak to Chapter 28 or any other chapter');
    expect(aj).toContain('no rule of Chapters 16 to 28 is imported');
    expect(aj).toContain('Chapter 15 stays absent (block V)');
    expect(aj).not.toContain('UNRESOLVED');
    expect(aj).not.toMatch(/\b\d{6}\b/);
    expect(aj.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(aj.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
      'AG. Chapter 26',
      'AH. Chapter 27',
      'AI. Chapter 28',
      'AJ. Chapter 29',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Appendix 1 on-site materials: boundary, completeness and consistency audit (Phase 3.5-BF)', () => {
    const ak = c12
      .slice(c12.indexOf('**AK. Appendix 1'), c12.indexOf('**AL. Appendix 2 floor coefficient'))
      .replace(/\s+/g, ' ');
    expect(ak).toContain('«پیوسـت 1. مصالح پای کار»');
    expect(ak).toContain('printed pp. 235–238');
    expect(ak).toContain(
      'The next printed unit opens on printed p239: «پیوست 4. ضریب طبقات» (Appendix 4, floor coefficient, printed without the kashida)',
    );
    expect(ak).toContain(
      'the appendix numbering is not sequential — Appendix 4 follows Appendix 1 directly',
    );
    expect(ak).toContain('no Appendix 2 or Appendix 3 page intervenes');
    expect(ak).toContain('an introduction heading (مقدمه) and clauses 1 to 8 (p235)');
    expect(ak).toContain('Table 1 with its title and its explanatory note (توضیح) (p236)');
    expect(ak).toContain('Table 2 (pp. 237–238)');
    expect(ak).toContain('the rules numbered ONSITE-01 to ONSITE-07');
    expect(ak).toContain('the implementation contract is block F');
    expect(ak).toContain('the Table 1 section of §11');
    expect(ak).toContain('Table 2 in the Table 2 section of §11');
    expect(ak).toContain('the mapping-verification section of §11');
    expect(ak).toContain(
      'This block is the Phase 3.5-BF source-completeness, boundary and consistency audit of that coverage',
    );
    expect(ak).toContain(
      'the printed clause inventory is exactly the introduction and clauses 1 to 8 — no ninth clause and no sub-clause is printed',
    );
    expect(ak).toContain('70 percent of the on-site-material price and of the transport cost');
    expect(ak).toContain('the extra transport cost not being subject to the seven-tenths factor');
    expect(ak).toContain(
      'the regional, overhead and contractor-proposed coefficients applied as applicable',
    );
    expect(ak).toContain('the clause 2 thirty-kilometre inclusion');
    expect(ak).toContain('the clause 8 final-statement exclusion');
    expect(ak).toContain(
      '«جدول شماره یک. ضرایب متوسط جهت اعمال به بهای واحد ردیفها برای تعیین قیمت مصالح پایکار»',
    );
    expect(ak).toContain(
      'chapter five ninety percent, twelve fifty percent, thirteen sixty-five percent, fourteen fifty percent, sixteen seventy percent, seventeen ninety percent, eighteen seventy percent, nineteen seventy percent, twenty seventy percent, twenty-one seventy percent, twenty-two seventy percent, twenty-three seventy-five percent and twenty-four eighty percent',
    );
    expect(ak).toContain('each glyph-verified and agreeing with the Table 1 section of §11');
    expect(ak).toContain('which earlier phases had read from the rendered page images');
    expect(ak).toContain('the chapter numbers print in Persian words');
    expect(ak).toContain(
      'for every chapter not listed the coefficient is NOT_SPECIFIED_IN_1404_PRICEBOOK and must not be taken as zero',
    );
    expect(ak).toContain('exactly forty-six rows (twenty-nine on p237 and seventeen on p238)');
    expect(ak).toContain('all forty-six codes, units and prices were glyph-verified');
    expect(ak).toContain('agree with the Table 2 section of §11 row for row');
    expect(ak).toContain('the units printed with their irregular spellings');
    expect(ak).toContain('the blank price cell of row 411004');
    expect(ak).toContain('no price recorded or inferred; the engine never assigns a price to it');
    expect(ak).toContain('INCOMPLETE — NO PRINTED PRICE');
    expect(ak).toContain('the lowest-priced row governs when a material appears in several rows');
    expect(ak).toContain('that order remains NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(ak).toContain('The appendix does not mention the floor coefficient P');
    expect(ak).toContain('no interaction with them is inferred');
    expect(ak).toContain('the star-item instruction for materials outside both tables (clause 3)');
    expect(ak).toContain('The transport chapter is cited generically in clause 2');
    expect(ak).toContain('block AI is the chapter audit');
    expect(ak).toContain('no cross-appendix reference exists in it');
    expect(ak).toContain(
      'the opening title prints «پیوسـت» with a kashida while the Appendix 4 opening prints «پیوست» without one',
    );
    expect(ak).toContain('with no row for chapters one to four, six to eleven and fifteen');
    expect(ak).toContain('or for chapters twenty-five to twenty-nine');
    expect(ak).toContain(
      'no missing row is inferred and no coefficient is assigned to an unlisted chapter',
    );
    expect(ak).toContain(
      'No duplicate code, no negative price and no suspicious placeholder cell is printed',
    );
    expect(ak).toContain(
      'no footnote or superscript marker and no bottom-of-page glossary entry appears anywhere in the four pages',
    );
    expect(ak).toContain('the U.P.V.C of the Table 1 chapter-twenty-three row, set in Times Bold');
    expect(ak).toContain('the profile Z of Table 2 row 411101, set in Times New Roman');
    expect(ak).toContain(
      'independently confirming the rendered-image readings of the earlier phases',
    );
    expect(ak).toContain(
      'the ONSITE rules, block F, the Table 1 and Table 2 sections of §11 and the mapping-verification section of §11 remain authoritative',
    );
    expect(ak).toContain('Nothing here leaks to Chapter 28 or any chapter block');
    expect(ak).toContain('Chapter 15 stays absent (block V)');
    expect(ak).not.toContain('UNRESOLVED');
    expect(ak.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(ak.match(/%/g) ?? []).toEqual([]);
    expect(ak.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    const six = ak.match(/\b\d{6}\b/g) ?? [];
    expect(six.every((c) => c.startsWith('41'))).toBe(true);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
      'AG. Chapter 26',
      'AH. Chapter 27',
      'AI. Chapter 28',
      'AJ. Chapter 29',
      'AK. Appendix 1',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Appendix 2 floor coefficient: printed title, boundaries, formula audit and example (Phase 3.5-BG)', () => {
    const al = c12
      .slice(
        c12.indexOf('**AL. Appendix 2 floor coefficient'),
        c12.indexOf('**AM. Appendix 3 overhead-cost items'),
      )
      .replace(/\s+/g, ' ');
    expect(al).toContain('«پیوست 2. ضریب طبقات»');
    expect(al).toContain(
      'identical wording on the opening title (p239) and both running headers (pp. 239–240)',
    );
    expect(al).toContain('the printed numeral is two');
    expect(al).toContain(
      'the same mapping that decodes the edition line on these very pages as the year 1404',
    );
    expect(al).toContain('that note reproduced the corrupted text layer, not the printed page');
    expect(al).toContain('the appendix sequence is sequential');
    expect(al).toContain('no non-sequential numbering exists on these pages');
    expect(al).toContain('Block AK is locked and is left exactly as written');
    expect(al).toContain('must be glyph-read in their own phases');
    expect(al).toContain('printed pp. 239–240');
    expect(al).toContain('its running header glyph-reads «پیوسـت1. مصالح پای کار»');
    expect(al).toContain("The p240 footer's text layer prints 241, but its glyphs read 240");
    expect(al).toContain(
      'the next printed unit opens on p241 with «پیوست 3. شرح اقلام هزینه‌های بالاسری»',
    );
    expect(al).toContain('the text layer says five; the glyphs say three');
    expect(al).toContain('the overhead-cost-items appendix already recorded at pp. 241–242');
    expect(al).toContain('FLOOR-01 to FLOOR-03');
    expect(al).toContain('the implementation contract block B of §12');
    expect(al).toContain(
      'This block is the Phase 3.5-BG source-completeness, boundary and glyph-verification audit',
    );
    expect(al).toContain('exactly clause 1, sub-clauses 1-1, 1-2 and 1-3, clause 1-4');
    expect(al).toContain('Notes 1 to 4 and one worked example');
    expect(al).toContain('no footnote, no superscript marker and no bottom-of-page glossary entry');
    expect(al).toContain('print their connector as a tatweel while 1-4 prints a hyphen');
    expect(al).toContain('the capital P set in Times New Roman Bold inside parentheses');
    expect(al).toContain('printed as an embedded raster image');
    expect(al).toContain('no text layer of it exists');
    expect(al).toContain('no new transcription is made here');
    expect(al).toContain('a fraction bar spanning about three hundred and forty points');
    expect(al).toContain('F and B are thus areas, not counts or coefficients');
    expect(al).toContain('F0 and B0 carry no weight but are included in S');
    expect(al).toContain('while the text layer renders it as three');
    expect(al).toContain('NOT_SPECIFIED_IN_1404_PRICEBOOK for each');
    expect(al).toContain('mezzanine, roof, attic, parking, service or partial floors');
    expect(al).toContain('mathematical round-half-up at the fifth decimal');
    expect(al).toContain('matching FLOOR-02');
    expect(al).toContain(
      'on-site materials (مصالح پایکار) excluded and application from the first progress statement',
    );
    expect(al).toContain(
      'no shared-area, attached-building, identical-building or repeated-block rule is printed',
    );
    expect(al).toContain('S = 1200 + 400 + 600 + 5000 + 400 = 7600');
    expect(al).toContain('5000 = 10 × F10 and 4400 = 11 × F11');
    expect(al).toContain('no product line exists for F0 or B0');
    expect(al).toContain('p = 1 + 34300/(100 × 7600)');
    expect(al).toContain('zero slash zero four five one two');
    expect(al).toContain('one slash zero four five one');
    expect(al).toContain('Source inconsistency, recorded and not reconciled');
    expect(al).toContain(
      'also differs from the six-decimal intermediate zero point zero four five one three two',
    );
    expect(al).toContain('does agree with the Note 4 rounding of the exact quotient');
    expect(al).toContain('NO_NUMERICAL_TABLE_IN_1404_PRICEBOOK');
    expect(al).toContain("the lowercase p of clause 1-4 and of the example's final line");
    expect(al).toContain(
      'the unit cites no circular, standard, other appendix or external document',
    );
    expect(al).toContain('belongs to the regional-coefficient appendix recorded at p243');
    expect(al).toContain('circular 94/69416 dated 1394/04/30');
    expect(al).toContain('no regional or overhead value is printed or needed here');
    expect(al).toContain('block B of §12 and C5 remain authoritative');
    expect(al).toContain('block AK is left exactly as locked with its correction recorded here');
    expect(al).not.toContain('UNRESOLVED');
    expect(al).not.toMatch(/\b\d{6}\b/);
    expect(al.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(al.match(/%/g) ?? []).toEqual([]);
    expect(al.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
      'AG. Chapter 26',
      'AH. Chapter 27',
      'AI. Chapter 28',
      'AJ. Chapter 29',
      'AK. Appendix 1',
      'AL. Appendix 2 floor coefficient',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Appendix 3 overhead-cost items: boundary, completeness and glyph audit (Phase 3.5-BH)', () => {
    const am = c12
      .slice(
        c12.indexOf('**AM. Appendix 3 overhead-cost items'),
        c12.indexOf('**AN. Appendix 4 regional coefficient'),
      )
      .replace(/\s+/g, ' ');
    expect(am).toContain('«پیوست 3. شرح اقلام هزینه‌های بالاسری»');
    expect(am).toContain(
      'identical wording on the opening title (p241) and the running headers of both pages',
    );
    expect(am).toContain('the validated map of the header font reads as three');
    expect(am).toContain('maps the glyph to five on both pages');
    expect(am).toContain('already recorded for p241 in the previous block');
    expect(am).toContain(
      'The appendix sequence remains sequential as corrected in the previous block',
    );
    expect(am).toContain(
      'Appendix 1 (pp. 235–238), Appendix 2 (pp. 239–240), this unit and, next, Appendix 4',
    );
    expect(am).toContain(
      'the unit is exactly two pages, pp. 241–242, both footers glyph-verified (241 and 242)',
    );
    expect(am).toContain(
      'The previous page p240 belongs to Appendix 2 (previous block; not re-audited)',
    );
    expect(am).toContain(
      'The p242 content ends with the third توضیح and the remainder of the page is blank',
    );
    expect(am).toContain(
      'no glossary entry, no footnote and no superscript marker appears anywhere in the unit',
    );
    expect(am).toContain('opens on p243 with «پیوست 4. ضریب منطقه‌ای»');
    expect(am).toContain(
      'its numeral glyph-verified as four on both its running header and its opening title',
    );
    expect(am).toContain('the regional-coefficient appendix already recorded at printed p243');
    expect(am).toContain('Appendix 3 therefore ends on p242');
    expect(am).toContain('the item table of the overhead-cost-items section of §11');
    expect(am).toContain('the register rows OVERHEAD-COST-01 to OVERHEAD-COST-05');
    expect(am).toContain('the coefficient contract C6');
    expect(am).toContain('descriptive and never a coefficient source');
    expect(am).toContain('That section recorded the list from the rendered page images');
    expect(am).toContain(
      'this block is the Phase 3.5-BH source-completeness, boundary and glyph-verification audit of that coverage',
    );
    expect(am).toContain('items 1-1 to 1-17');
    expect(am).toContain('items 2-1 to 2-7');
    expect(am).toContain('2-1-1 and 2-1-2; 2-2-1 to 2-2-3; 2-5-1 to 2-5-10; 2-6-1 to 2-6-6');
    expect(am).toContain(
      'three closing notes printed with the word توضیح and the numbers one, two and three',
    );
    expect(am).toContain(
      'forty-seven numbered entries — two clause headings, twenty-four items and twenty-one sub-items — plus the three notes',
    );
    expect(am).toContain(
      'no clause 3, no eighteenth general item, no eighth work item, no skipped or duplicated number',
    );
    expect(am).toContain('no content image beyond the page background seal');
    expect(am).toContain(
      'the label connectors print as tatweels except item 2-7, which prints a hyphen',
    );
    expect(am).toContain('«مانند» (such as)');
    expect(am).toContain('the numerical-value count beyond identifiers is zero');
    expect(am).toContain('NO_NUMERICAL_TABLE_IN_1404_PRICEBOOK');
    expect(am).toContain('set in the application instructions (OVERHEAD-01), not here');
    expect(am).toContain(
      'توضیح 1 — the wages of the personnel working in the machinery repair workshop are provided for in the machinery hourly cost',
    );
    expect(am).toContain("funded by the executive bodies from the plan's credit");
    expect(am).toContain(
      'the value-added tax and the municipal charges (for the contracts that are subject to them) are not included in the overhead costs',
    );
    expect(am).toContain(
      'The printed note word here is توضیح, where the floor-coefficient appendix prints تبصره for its notes',
    );
    expect(am).toContain(
      'the employer-share insurance of توضیح 2 and the contractor-share insurance of item 2-7 address different shares',
    );
    expect(am).toContain('a second sentence introduced by «همچنین»');
    expect(am).toContain(
      'renders this second sentence as a parenthetical without the word «همچنین»',
    );
    expect(am).toContain('summarizes it in exclusion form');
    expect(am).toContain(
      'wages already provided for in the row prices or in the site setup/removal cost are not counted again in overhead',
    );
    expect(am).toContain(
      'cites no chapter, appendix, clause, table, row, standard, circular or نشریه by number',
    );
    expect(am).toContain('the word نشریات in item 1-14 is itself a listed cost category');
    expect(am).toContain(
      'does not mention the floor coefficient, the floor areas, Appendix 2, the on-site materials, Appendix 1, the regional coefficient or any circular',
    );
    expect(am).toContain(
      'No external document is named, so nothing here is an external dependency',
    );
    expect(am).toContain('Shop Drawings and As Built Drawings');
    expect(am).toContain(
      'set in Times New Roman Bold, whose ToUnicode table is itself corrupted on these pages',
    );
    expect(am).toContain(
      'agrees with the rendered-image reading already recorded in the item table of §11',
    );
    expect(am).toContain(
      "The appendix numeral's text-layer value (five) is corrupted on both pages",
    );
    expect(am).toContain(
      'the item table of §11, the register rows OVERHEAD-COST-01 to OVERHEAD-COST-05, C6, the implementation contract and the previous blocks remain authoritative',
    );
    expect(am).toContain(
      'No coefficient, percentage, price, exclusion beyond the printed notes or payment mechanism is introduced',
    );
    expect(am).not.toContain('UNRESOLVED');
    expect(am).not.toMatch(/\b\d{6}\b/);
    expect(am.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(am.match(/%/g) ?? []).toEqual([]);
    expect(am.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
      'AG. Chapter 26',
      'AH. Chapter 27',
      'AI. Chapter 28',
      'AJ. Chapter 29',
      'AK. Appendix 1',
      'AL. Appendix 2 floor coefficient',
      'AM. Appendix 3 overhead-cost items',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Appendix 4 regional coefficient: boundary, formula and external-source audit (Phase 3.5-BI)', () => {
    const an = c12
      .slice(
        c12.indexOf('**AN. Appendix 4 regional coefficient'),
        c12.indexOf('**BJ. Appendix 5 site setup and removal'),
      )
      .replace(/\s+/g, ' ');
    expect(an).toContain('«پیوست 4. ضریب منطقه»');
    expect(an).toContain('the last word printed as «منطقه», without the «ای» suffix');
    expect(an).toContain('on both the running header and the opening title');
    expect(an).toContain('the validated map of the header font reads as four');
    expect(an).toContain(
      'here the ToUnicode table happens to agree, printing four in the text layer as well',
    );
    expect(an).toContain(
      'the per-glyph corruption is erratic and text-layer digits remain non-evidence throughout',
    );
    expect(an).toContain('The body clauses print the coefficient name with the suffix');
    expect(an).toContain('recorded as printed and not reconciled');
    expect(an).toContain(
      'The previous two blocks cite the p243 title with the suffix, following the register wording',
    );
    expect(an).toContain('that citation is corrected here');
    expect(an).toContain('both blocks are locked and left exactly as written');
    expect(an).toContain(
      'the same protocol the floor-coefficient block applied to the appendix-numbering correction before it',
    );
    expect(an).toContain('the unit is exactly one page, p243, its footer glyph-verified (243)');
    expect(an).toContain(
      'The previous page p242 belongs to Appendix 3 (previous block; not re-audited)',
    );
    expect(an).toContain("The page's content ends with the last variable definition (the Cn line)");
    expect(an).toContain(
      'no note, no footnote, no superscript marker, no glossary entry, no table and no continuation',
    );
    expect(an).toContain('opens on p244 with «پیوست 5. دستورالعمل تجهیز و برچیدن کارگاه»');
    expect(an).toContain(
      'its numeral glyph-verified as five on both its running header and its opening title',
    );
    expect(an).toContain('the text layer prints three — corrupted');
    expect(an).toContain('the site-setup/removal appendix already recorded at pp. 244–253');
    expect(an).toContain('the coverage table and the site-setup register rows');
    expect(an).toContain('Appendix 4 therefore ends on p243');
    expect(an).toContain('one, two, three, four, five');
    expect(an).toContain('the rule-versus-values section of §11');
    expect(an).toContain('the register row REGION-01');
    expect(an).toContain('the coefficient contract C7');
    expect(an).toContain('the open-dependencies table row for the regional values');
    expect(an).toContain(
      'This block is the Phase 3.5-BI source-boundary, completeness and glyph-verification audit',
    );
    expect(an).toContain('exactly clause 1, sub-clauses 1-1, 1-2, 1-3 and 1-4');
    expect(an).toContain('five variable-definition lines (R, C, C1, C2 and Cn)');
    expect(an).toContain('No clause 2, no fifth sub-clause, no note and no example is printed');
    expect(an).toContain('their connectors print as hyphens');
    expect(an).toContain('where the floor-coefficient and overhead appendices print tatweels');
    expect(an).toContain('with easy access to materials and services');
    expect(an).toContain(
      'the latest issued up to the time the estimate of the execution cost is prepared',
    );
    expect(an).toContain(
      'in the annex to circular No. 94/69416 dated 1394/04/30 or its later amendments',
    );
    expect(an).toContain('the county (شهرستان) or district (بخش)');
    expect(an).toContain('the latest national divisions map published by the Ministry of Interior');
    expect(an).toContain('such as linear projects');
    expect(an).toContain(
      'the relation is printed as real text — set in Cambria Math, not an image',
    );
    expect(an).toContain('unlike the floor-coefficient formula');
    expect(an).toContain(
      'R equals the fraction whose numerator is the sum of three parenthesised products',
    );
    expect(an).toContain(
      'R one times C one, plus R two times C two, plus a midline ellipsis, plus R n times C n',
    );
    expect(an).toContain('The fraction bar is a drawn rule spanning the numerator');
    expect(an).toContain('the multiplication operator is the asterisk operator');
    expect(an).toContain('the R glyph appears four times, the C glyph four times');
    expect(an).toContain('maps its glyphs to the correct mathematical characters');
    expect(an).toContain(
      'R equals the sum of each regional coefficient times the estimated execution cost of the part of the work to which it applies',
    );
    expect(an).toContain('the per-discipline scope printed in the definitions themselves');
    expect(an).toContain('every digit glyph on p243 (thirty-seven in total)');
    expect(an).toContain(
      'a digit of the circular number or of the date, a formula subscript or the footer',
    );
    expect(an).toContain('NO_NUMERICAL_REGIONAL_COEFFICIENT_TABLE_IN_1404_PRICEBOOK');
    expect(an).toContain(
      'the circular as the number ninety-four over sixty-nine thousand four hundred and sixteen (94/69416)',
    );
    expect(an).toContain('the date as 1394/04/30, with the Persian slash as the separator in both');
    expect(an).toContain(
      'an EXTERNAL_DEPENDENCY, since the annex is not reproduced in the 1404 PDF',
    );
    expect(an).toContain('recorded as a separate EXTERNAL_DEPENDENCY');
    expect(an).toContain(
      'The amendment-currency question and the value-set provenance remain exactly as the existing section records them',
    );
    expect(an).toContain(
      'no external table was accessed, no value is recorded here or in the engine',
    );
    expect(an).toContain('that order is NOT_SPECIFIED_IN_1404_PRICEBOOK');
    expect(an).toContain(
      'the successive-multiplication wording of the application instructions is not imported here',
    );
    expect(an).toContain('The appendix does not mention Appendix 1, Appendix 2 or Appendix 3');
    expect(an).toContain(
      'the title prints «ضریب منطقه» without the «ای» suffix while the body clauses print «ضریب منطقه‌ای» with it',
    );
    expect(an).toContain(
      "The next unit's numeral (p244, Appendix 5) prints five in glyphs and three in the text layer",
    );
    expect(an).toContain(
      'The clause-label connectors here are hyphens, where the previous appendices print tatweels',
    );
    expect(an).toContain('No clause label is missing or duplicated');
    expect(an).toContain(
      'the regional-coefficient section of §11, REGION-01, C7, the implementation-contract statements, the open-dependencies row and the previous blocks remain authoritative',
    );
    expect(an).toContain(
      'No coefficient value, region mapping, boundary, rounding or combination order is introduced',
    );
    expect(an).not.toContain('UNRESOLVED');
    expect(an).not.toMatch(/\b\d{6}\b/);
    expect(an.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(an.match(/%/g) ?? []).toEqual([]);
    expect(an.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
      'AG. Chapter 26',
      'AH. Chapter 27',
      'AI. Chapter 28',
      'AJ. Chapter 29',
      'AK. Appendix 1',
      'AL. Appendix 2 floor coefficient',
      'AM. Appendix 3 overhead-cost items',
      'AN. Appendix 4 regional coefficient',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Appendix 5 site setup and removal: source, table and glyph-verification audit (Phase 3.5-BJ)', () => {
    const bj = c12
      .slice(
        c12.indexOf('**BJ. Appendix 5 site setup and removal'),
        c12.indexOf('**BK. Appendix 6 new works'),
      )
      .replace(/\s+/g, ' ');
    expect(bj).toContain('«پیوست 5. دستورالعمل تجهیز و برچیدن کارگاه»');
    expect(bj).toContain(
      'identical wording on the opening title (p244) and the running headers of all ten pages',
    );
    expect(bj).toContain('the validated map of the header font reads as five');
    expect(bj).toContain('while the ToUnicode table of that font prints three on these pages');
    expect(bj).toContain(
      'the unit is exactly ten pages, pp. 244–253, every footer glyph-verified (244 through 253)',
    );
    expect(bj).toContain(
      'The previous page p243 belongs to Appendix 4 (previous block; not re-audited)',
    );
    expect(bj).toContain('The next printed unit opens on p254 with «پیوست 6. کارهای جدید»');
    expect(bj).toContain(
      'its numeral glyph-verified as six on both its running header and its opening title',
    );
    expect(bj).toContain('(the text layer prints four — corrupted)');
    expect(bj).toContain('the new-works appendix already recorded at p254 (NEW-01 to NEW-04)');
    expect(bj).toContain('Appendix 5 therefore ends on p253');
    expect(bj).toContain('the appendix sequence remains sequential from one to six');
    expect(bj).toContain(
      'the instruction is prepared generically for use in the various disciplines',
    );
    expect(bj).toContain('the register rows SITE-01');
    expect(bj).toContain('the payment rules of clause 4-1 with its note, and clauses 4-2 and 4-3');
    expect(bj).toContain(
      'the coverage-table row for this appendix (pp. 244–253, verbatim transcription pending)',
    );
    expect(bj).toContain(
      'site setup/removal is not a row of the estimate sums and is added after the successive coefficients',
    );
    expect(bj).toContain(
      'The clause texts cited by SITE-01 and SITE-02 were re-read glyph by glyph and agree',
    );
    expect(bj).toContain(
      'This block is the Phase 3.5-BJ source-completeness, boundary, table and glyph-verification audit',
    );
    expect(bj).toContain('clause 1 «تعاریف» with items 1-1 to 1-13');
    expect(bj).toContain(
      'clause 2 «روش تهیه برآورد» with items 2-1 to 2-18 including the sub-items 2-17-1 and 2-17-2',
    );
    expect(bj).toContain('clause 3 «شرایط کلی» with items 3-1 to 3-9');
    expect(bj).toContain('clause 4 «نحوه محاسبه هزینه» with items 4-1 to 4-5');
    expect(bj).toContain(
      'four clauses, forty-seven numbered items (thirteen, eighteen, nine and five, the two 2-17 sub-items included), two tabdare and the introduction',
    );
    expect(bj).toContain(
      'no footnote, no superscript marker and no bottom-of-page glossary entry appears anywhere in the ten pages',
    );
    expect(bj).toContain(
      "site setup is estimated exclusively from the rows of this appendix's table",
    );
    expect(bj).toContain('adding rows under any title, including star rows, is not allowed');
    expect(bj).toContain(
      'for buildings to be constructed, the salvage value of materials is deducted',
    );
    expect(bj).toContain(
      'the transport, installation, depreciation and investment costs over the execution period are calculated and included',
    );
    expect(bj).toContain('only one setup-and-removal list is prepared for the whole work');
    expect(bj).toContain(
      'only their upkeep and operation during execution enters the setup estimate as a lump sum',
    );
    expect(bj).toContain(
      'calculated using the price list of the road, railway and airport-runway discipline',
    );
    expect(bj).toContain("per the General Conditions the land for site setup is the employer's");
    expect(bj).toContain(
      'providing the vehicle needed by the employer, consultant and laboratory is not allowed in the estimate',
    );
    expect(bj).toContain('detour roads are not setup rows');
    expect(bj).toContain(
      "the contractor prepares the setup layout plan and, after the consultant's approval, it becomes the basis of the setup",
    );
    expect(bj).toContain(
      "a documented hygiene, safety and environment programme for the consultant's approval",
    );
    expect(bj).toContain('its cost applies up to the total price foreseen in the related rows');
    expect(bj).toContain(
      'the salvage price is set at the ordinary current rate by agreement and credited to the contractor',
    );
    expect(bj).toContain('rows 990301 to 990304 are not inserted');
    expect(bj).toContain(
      "calculated separately for the consultant under the supervision circular's provisions",
    );
    expect(bj).toContain(
      'rows 991401 to 991403 are paid in proportion to the physical progress of the related operations',
    );
    expect(bj).toContain('the five requirements of appendix five of Rule (ضابطه) number 773');
    expect(bj).toContain('«دستورالعمل ارزیابی کیفیت و مشخصات فنی عملیات اجرا شده»');
    expect(bj).toContain(
      'the list is titled «فهرست ردیف‌های تجهیز و برچیدن کارگاه» (p249) and has seven printed columns',
    );
    expect(bj).toContain('شماره، نوع، شرح، واحد، بهای واحد (ریال)، مقدار، بهای کل (ریال)');
    expect(bj).toContain(
      'exactly sixty numbered rows in fifteen contiguous groups, every code glyph-verified',
    );
    expect(bj).toContain('and مترمربع-ماه for row 991001 alone, the only row with that unit');
    expect(bj).toContain(
      'when the cladding height exceeds 3/5 metre — the decimal separator printed as the Persian slash',
    );
    expect(bj).toContain('the digit inventory of the five table pages closes exactly');
    expect(bj).toContain('the بهای واحد, مقدار and بهای کل columns print no numeric glyph at all');
    expect(bj).toContain(
      'clause 2-1 has the estimator enter the prices of the place of execution against the rows',
    );
    expect(bj).toContain('no price or quantity is recorded or inferred here for any row');
    expect(bj).toContain(
      'one unnumbered total row, «جمع هزینه تجهیز و برچیدن کارگاه», unit مقطوع, likewise without values',
    );
    expect(bj).toContain(
      'seventy and thirty for constructed type-one buildings, thirty and seventy for prefabricated type-one, and fifteen and eighty-five for the rental and purchased-service rows',
    );
    expect(bj).toContain('are glyph-verified on p248 and agree with SITE-02');
    expect(bj).toContain('the cap percentage itself is not printed in this appendix');
    expect(bj).toContain('rows 990104, 990301 تا 990303 and 991001 تا 991104');
    expect(bj).toContain(
      'the text layer prints three for the glyph five on all ten pages of this unit and four for the glyph six on the p254 opening of the next unit',
    );
    expect(bj).toContain(
      'items 1-7, 1-13, 2-17-2, 2-18 and 3-9 print hyphens while every other sub-clause label prints a tatweel',
    );
    expect(bj).toContain('Rows 991401 to 991403 print the type «پیشرفت کار» in their type cells');
    expect(bj).toContain('with clause 4-5\u2019s progress-and-quality payment condition');
    expect(bj).toContain(
      'the earlier reading of those cells as empty is corrected by the glyph evidence',
    );
    expect(bj).toContain('row 990304 lies in the latter only; both are recorded as printed');
    expect(bj).toContain('The total row carries no code');
    expect(bj).toContain('its pixel shape a short horizontal stroke');
    expect(bj).toContain('its meaning is NOT_SPECIFIED_IN_1404_PRICEBOOK, recorded as printed');
    expect(bj).toContain(
      'the General Conditions of Contract (شرایط عمومی پیمان, named in clauses 2-7, 2-8 and 3-5; edition not printed — the already-recorded open question)',
    );
    expect(bj).toContain(
      'the price list of the رشته راه، راه‌آهن و باند فرودگاه discipline (clauses 2-6 and 2-15; a separate price book, not this PDF)',
    );
    expect(bj).toContain(
      'the supervision circular (بخشنامه نظارت, clause 4-4; no number or date printed)',
    );
    expect(bj).toContain('ضابطه number 773, appendix five');
    expect(bj).toContain('the rule number is printed, the document itself is not in the project');
    expect(bj).toContain(
      'the new-works appendix note two (cited by clause 3-5 — the appendix at p254, NEW-04)',
    );
    expect(bj).toContain(
      'the application-instructions table (cited by clause 2-17-1 — the p2 table)',
    );
    expect(bj).toContain(
      'The appendix does not mention the floor, regional or overhead coefficients, Appendix 1 to 4, or on-site materials',
    );
    expect(bj).toContain(
      'SITE-01, SITE-02, C8, the implementation-contract statements, the coverage-table row and the previous blocks remain authoritative',
    );
    expect(bj).toContain(
      'no cap value is imported, and nothing here leaks to the new-works appendix or any other unit',
    );
    const six = bj.match(/\b\d{6}\b/g) ?? [];
    expect(six.length).toBeGreaterThan(30);
    expect(six.every((c) => c.startsWith('99'))).toBe(true);
    for (const code of [
      '990101',
      '990104',
      '990301',
      '990306',
      '990405',
      '990501',
      '990704',
      '990906',
      '991010',
      '991107',
      '991501',
    ])
      expect(bj).toContain(code);
    expect(bj).not.toContain('UNRESOLVED');
    expect(bj.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(bj.match(/%/g) ?? []).toEqual([]);
    expect(bj.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
      'AG. Chapter 26',
      'AH. Chapter 27',
      'AI. Chapter 28',
      'AJ. Chapter 29',
      'AK. Appendix 1',
      'AL. Appendix 2 floor coefficient',
      'AM. Appendix 3 overhead-cost items',
      'AN. Appendix 4 regional coefficient',
      'BJ. Appendix 5 site setup and removal',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('Appendix 6 new works: one-page source, caps and glyph-verification audit (Phase 3.5-BK)', () => {
    const bk = c12
      .slice(c12.indexOf('**BK. Appendix 6 new works'), c12.indexOf('### 12.4'))
      .replace(/\s+/g, ' ');
    expect(bk).toContain('«پیوست 6. کارهای جدید»');
    expect(bk).toContain('identical wording on the running header and the opening title');
    expect(bk).toContain('the validated map of the header font reads as six');
    expect(bk).toContain('while the ToUnicode table of that font prints four on both occurrences');
    expect(bk).toContain('the unit is exactly one page, p254, its footer glyph-verified (254');
    expect(bk).toContain('with the text layer printing four for every one of the three digits');
    expect(bk).toContain(
      'The previous page p253 belongs to Appendix 5 (previous block; not re-audited)',
    );
    expect(bk).toContain(
      "The next printed page, p255, is the document's last page (the PDF ends there): it is the closing acknowledgment «تشکر و قدردانی»",
    );
    expect(bk).toContain(
      'set in different fonts (B Nazanin, Calibri and Cambria, none of the price-book fonts)',
    );
    expect(bk).toContain('back matter that names the working group and carries no rule');
    expect(bk).toContain(
      'No Appendix 7 and no further unit exists; the appendix sequence ends at six',
    );
    expect(bk).toContain("the price book's normative content ends with this appendix");
    expect(bk).toContain(
      'the text itself ends with the second tabdare mid-page; the remainder of the page is blank',
    );
    expect(bk).toContain('the register rows NEW-01');
    expect(bk).toContain('which relied on a visual recheck of p254');
    expect(bk).toContain(
      'All four register statements were re-read glyph by glyph and agree with the printed page',
    );
    expect(bk).toContain(
      'This block is the Phase 3.5-BK source-completeness, boundary, numerical and glyph-verification audit',
    );
    expect(bk).toContain(
      'the printed inventory is exactly an introduction, two numbered clauses and two tabdare',
    );
    expect(bk).toContain(
      'within the framework of the subject of the contract (در چارچوب موضوع پیمان)',
    );
    expect(bk).toContain('new works are instructed (ابلاغ) to the contractor');
    expect(bk).toContain(
      'the framing «within the framework of the contract subject» is printed and was not previously recorded',
    );
    expect(bk).toContain(
      'no unit price or quantity is foreseen for the instructed new work, the new price is determined in accordance with clause ج of Article 29',
    );
    expect(bk).toContain('the clause letter ج is glyph-verified');
    expect(bk).toContain(
      'or the method of determining its unit price is explicitly stated in the chapter requirements (الزامات فصلها)',
    );
    expect(bk).toContain('exactly (عیناً) that price is used');
    expect(bk).toContain(
      "such as the related overhead costs, the contractor's proposed coefficient and, as the case may be, the other related coefficients",
    );
    expect(bk).toContain(
      'taking into account the increases of the work quantities in accordance with clause الف of Article 29',
    );
    expect(bk).toContain('up to twenty-five percent of the initial contract amount');
    expect(bk).toContain('the clause letter الف is glyph-verified');
    expect(bk).toContain('if the instructed new work is solely the purchase of equipment');
    expect(bk).toContain('only the overhead coefficient 1/14 is applied to it');
    expect(bk).toContain(
      'the three digits one, one and four with the Persian slash as the printed decimal separator',
    );
    expect(bk).toContain('additional site setup beyond the site setup foreseen in the contract');
    expect(bk).toContain(
      'the additional setup items and their cost are agreed with the contractor',
    );
    expect(bk).toContain(
      "up to a maximum of twenty-five percent of the contract's lump-sum site-setup-and-removal amount",
    );
    expect(bk).toContain('No clause 3, no definitions section, no table, no formula, no example');
    expect(bk).toContain('the only image on the page is the standard masked logo');
    expect(bk).toContain('Every Latin-font glyph on the page is a space');
    expect(bk).toContain('the unit contains no Latin term');
    expect(bk).toContain(
      'the digit inventory of the page closes exactly — twenty-four digit glyphs in total',
    );
    expect(bk).toContain(
      'the two clause labels (one and two), the Article number in each clause (29 and 29)',
    );
    expect(bk).toContain('the two cap values (25 and 25)');
    expect(bk).toContain(
      'the three coefficient digits of 1/14, the two tabdare labels (one and two), and the footer (254)',
    );
    expect(bk).toContain(
      'No price, monetary value, quantity, row code, year other than the edition line, or coefficient other than 1/14 is printed',
    );
    expect(bk).toContain('no percentage other than the two twenty-five-percent caps');
    expect(bk).toContain('The two caps share one numeral but not one base');
    expect(bk).toContain('already recorded as distinct rules (NEW-02 and NEW-04)');
    expect(bk).toContain(
      'the star-row caps of the application instructions are a separate concept',
    );
    expect(bk).toContain(
      'Formula audit: none is printed — the unit carries no mathematical notation at all',
    );
    expect(bk).toContain(
      'Table audit: none is printed — the appendix has no row list, no prices and no units to extract',
    );
    expect(bk).toContain('clause ج of Article 29 of the شرایط عمومی پیمان (clause 1)');
    expect(bk).toContain('clause الف of Article 29 of the شرایط عمومی پیمان (clause 2)');
    expect(bk).toContain('no edition, document number, date or issuer is printed, the article');
    expect(bk).toContain('both remain EXTERNAL_DEPENDENCY with their contents unrecorded');
    expect(bk).toContain(
      'the new-price determination under clause ج is not computed by the engine',
    );
    expect(bk).toContain('an internal reference to no chapter in particular');
    expect(bk).toContain('Appendix 5 clause 3-5 cites «تبصره دو پیوست کارهای جدید»');
    expect(bk).toContain('that target is verified to exist with matching content');
    expect(bk).toContain('The appendix does not cite Appendix 1 to 5, any chapter by number');
    expect(bk).toContain(
      'the pricing of new works instructed within the framework of the contract subject',
    );
    expect(bk).toContain('NOT_SPECIFIED_IN_1404_PRICEBOOK: a definition of «کار جدید»');
    expect(bk).toContain(
      'the distinction between a new item, a new unit price, a quantity increase, extra work, omitted work, revised work or supplemental work',
    );
    expect(bk).toContain('how the quantities of a new work are determined');
    expect(bk).toContain(
      'whether the twenty-five-percent cap is checked per instruction or cumulatively',
    );
    expect(bk).toContain('any approval workflow other than the Article 29 reference');
    expect(bk).toContain('clause 1 conditions on no unit price یا (or) quantity being foreseen');
    expect(bk).toContain(
      'clause 2 on a unit price و (and) quantity being foreseen یا (or) the unit-price method being stated in the chapter requirements',
    );
    expect(bk).toContain('its edge scope is not resolved by inference');
    expect(bk).toContain('the most completely corrupted digit layer of any unit audited so far');
    expect(bk).toContain(
      'The first word pair of tabdare 1 prints run together, «چنانچهکار», with no space glyph between the two words (glyph-verified)',
    );
    expect(bk).toContain(
      'Tabdare 2 prints a double space between «به» and «تجهیز» (two consecutive space glyphs — glyph-verified)',
    );
    expect(bk).toContain(
      'The tabdare labels print only a closing parenthesis — «تبصره 1)» and «تبصره 2)» — with no opening parenthesis',
    );
    expect(bk).toContain('The page prints no zero-width non-joiner anywhere');
    expect(bk).toContain('the two caps as validation-only, the equipment-only coefficient gate');
    expect(bk).toContain(
      'the verbatim transcription of the unit remains pending in the coverage table',
    );
    expect(bk).toContain(
      'the contents of Article 29 clauses الف and ج remain external and unrecorded; no discrepancy with the prior coverage was found',
    );
    expect(bk).toContain(
      'NEW-01 to NEW-04, C9, the implementation rows and contracts, the open-dependencies row, the coverage-table row and the previous blocks remain authoritative',
    );
    expect(bk).toContain(
      'No price, rate, quantity, cap value, workflow state or Article 29 content is introduced',
    );
    expect(bk).toContain(
      "The document's remaining page is acknowledgment back matter and is not audited beyond its identity",
    );
    expect(bk.match(/\b\d{6}\b/g) ?? []).toEqual([]);
    expect(bk).not.toContain('UNRESOLVED');
    expect(bk.replace(/3\.5-[A-Z]+/g, '').match(/\d+\.\d+|±/g) ?? []).toEqual([]);
    expect(bk.match(/%/g) ?? []).toEqual([]);
    expect(bk.match(/\b15\d{4}\b/g) ?? []).toEqual([]);
    for (const b of [
      'W. Chapter 16',
      'X. Chapter 17',
      'Y. Chapter 18',
      'Z. Chapter 19',
      'AA. Chapter 20',
      'AB. Chapter 21',
      'AC. Chapter 22',
      'AD. Chapter 23',
      'AE. Chapter 24',
      'AF. Chapter 25',
      'AG. Chapter 26',
      'AH. Chapter 27',
      'AI. Chapter 28',
      'AJ. Chapter 29',
      'AK. Appendix 1',
      'AL. Appendix 2 floor coefficient',
      'AM. Appendix 3 overhead-cost items',
      'AN. Appendix 4 regional coefficient',
      'BJ. Appendix 5 site setup and removal',
      'BK. Appendix 6 new works',
    ])
      expect(c12.split(`**${b}`)).toHaveLength(2);
  });

  it('1.14 appears only for purchase/fittings and equipment-only new work', () => {
    const rows114 = decision.filter((r) => r.join(' ').includes('1.14')).map((r) => r[0]);
    expect(rows114).toEqual(['IR-1404-E-NEW-03']);
    expect(c12).toContain('Not applicable to ordinary work items.');
  });
});
