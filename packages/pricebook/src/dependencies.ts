/**
 * External-dependency model of the price-book data layer.
 *
 * A dependency is an external document the 1404 source explicitly names. Identities come
 * only from the verified specification (section 12.4 and the verification blocks); no
 * external document has been fetched, and none is claimed to be. `fetched` is a literal
 * `false` so a "verified external value" can never be asserted by accident.
 */
import type { SourceReference } from './provenance.js';

export interface ExternalDependency {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly sourceReference?: SourceReference;
  readonly status: 'EXTERNAL_DEPENDENCY';
  /** Always false: no external document has been fetched or imported. */
  readonly fetched: false;
}

function dep(
  id: string,
  name: string,
  description: string,
  sourceReference?: SourceReference,
): ExternalDependency {
  const record: ExternalDependency = {
    id,
    name,
    description,
    ...(sourceReference !== undefined ? { sourceReference } : {}),
    status: 'EXTERNAL_DEPENDENCY',
    fetched: false,
  };
  return Object.freeze(record);
}

const REFERENCED_AT = (section: string): SourceReference => ({
  sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
  edition: '1404',
  printedPage: section,
  section: 'referenced by the 1404 price book',
  sourceFileHash: null,
});

/**
 * The deduplicated registry of external dependencies established by the verified
 * specification (Phase 3.5-C final report, section D).
 */
export const VERIFIED_EXTERNAL_DEPENDENCIES: readonly ExternalDependency[] = Object.freeze([
  dep(
    'regional-coefficient-circular-94-69416',
    'ابلاغ ضریب‌های منطقه‌ای کارهای پیمانکاری — circular No. 94/69416 dated 1394/04/30, annex or later amendments',
    'Numerical regional coefficient values and region mappings. The 1404 book prints the formula only.',
    REFERENCED_AT('p243, Appendix 4'),
  ),
  dep(
    'general-conditions-article-29',
    'شرایط عمومی پیمان — Article 29, clauses الف and ج',
    'New-work pricing (clause ج) and quantity-increase rules (clause الف). No edition, number or date is printed.',
    REFERENCED_AT('p254, Appendix 6'),
  ),
  dep(
    'rule-773-appendix-5',
    'ضابطه شماره 773، پیوست 5 — دستورالعمل ارزیابی کیفیت و مشخصات فنی عملیات اجرا شده',
    'Five requirements governing payment of Appendix 5 rows 991401–991403.',
    REFERENCED_AT('p248, Appendix 5 clause 4-5'),
  ),
  dep(
    'supervision-circular',
    'بخشنامه نظارت',
    'Separate calculation of consultant costs when Appendix 5 rows 990301–990304 are omitted. No number or date printed.',
    REFERENCED_AT('p248, Appendix 5 clause 4-4'),
  ),
  dep(
    'hse-directives',
    'دستورالعمل‌های شورای عالی حفاظت فنی، وزارت کار و امور اجتماعی، وزارت بهداشت و سازمان محیط زیست',
    'Safety, occupational-disease prevention and hygiene directives for site setup.',
    REFERENCED_AT('p245, Appendix 5 clause 3-2'),
  ),
  dep(
    'road-rail-airport-pricebook',
    'فهرست بهای واحد پایه رشته راه، راه‌آهن و باند فرودگاه',
    'A separate price book (not this PDF) for access/service/communication and detour roads.',
    REFERENCED_AT('p245, Appendix 5 clauses 2-6 and 2-15'),
  ),
  dep(
    'moi-divisions-map',
    'نقشه تقسیمات کشوری — Ministry of Interior national divisions map',
    'Administrative boundaries for the regional coefficient; a dependency separate from the coefficient values.',
    REFERENCED_AT('p243, Appendix 4 clause 1-3'),
  ),
  dep(
    'star-item-instruction',
    'دستورالعمل تهیه و تأیید ردیف‌های ستاره‌دار',
    'Star-row pricing and approval detail; only the title is printed (p2 clause 2-6), no number/date/authority.',
    REFERENCED_AT('p2, clause 2-6'),
  ),
  dep(
    'rebar-tolerance-source',
    'Chapter 7 rebar tolerance "standard tables" (source standard not identified)',
    'The tolerance value for accepting weighed rebar weight; the source standard is not named by the 1404 book.',
    REFERENCED_AT('p56, Chapter 7 clause 2'),
  ),
  dep(
    'publication-714',
    'نشریه 714',
    'Referenced by Chapter 14 (thermal insulation and fire-resistant coatings).',
    REFERENCED_AT('Chapter 14 requirements'),
  ),
  dep(
    'publication-862',
    'نشریه 862 — آیین‌نامه طراحی و اجرای معابر درون روستایی',
    'Compaction provisions of the Chapter 26 group 6 deduction.',
    REFERENCED_AT('p221, Chapter 26'),
  ),
  dep(
    'publication-308',
    'نشریه 308',
    'Referenced by Chapter 8 (concrete).',
    REFERENCED_AT('Chapter 8 requirements'),
  ),
  dep(
    'publication-123',
    'نشریه 123',
    'Referenced by Chapter 16 (light steel works).',
    REFERENCED_AT('Chapter 16 requirements'),
  ),
  dep(
    'publication-385',
    'نشریه 385',
    'Referenced by Chapter 16 (light steel works).',
    REFERENCED_AT('Chapter 16 requirements'),
  ),
  dep(
    'publication-612',
    'نشریه 612',
    'Referenced by Chapter 16 (light steel works).',
    REFERENCED_AT('Chapter 16 requirements'),
  ),
  dep(
    'publication-613',
    'نشریه 613',
    'Referenced by Chapter 16 (light steel works).',
    REFERENCED_AT('Chapter 16 requirements'),
  ),
  dep(
    'insi-6594',
    'استاندارد ملی ایران 6594 — حفاظت سازه‌های فولادی در برابر خوردگی با استفاده از سیستم رنگ‌های محافظ',
    'Minimum standard for Chapter 25 rows 250320–250350.',
    REFERENCED_AT('p213, Chapter 25 clause 3-3'),
  ),
  dep(
    'en-12825',
    'EN 12825',
    'Referenced by Chapters 16/17 (raised floors).',
    REFERENCED_AT('Chapter 16/17 requirements'),
  ),
  dep(
    'standard-21083',
    'استاندارد 21083',
    'Referenced by Chapter 16 (light steel works).',
    REFERENCED_AT('Chapter 16 requirements'),
  ),
  dep(
    'standard-12172-1',
    'استاندارد 12172-1',
    'Referenced by Chapter 16 (light steel works).',
    REFERENCED_AT('Chapter 16 requirements'),
  ),
]);

const BY_ID: ReadonlyMap<string, ExternalDependency> = new Map(
  VERIFIED_EXTERNAL_DEPENDENCIES.map((d) => [d.id, d]),
);

export function getExternalDependency(id: string): ExternalDependency | undefined {
  return BY_ID.get(id);
}

/** Resolves only against the verified registry; unknown dependency ids are rejected. */
export function isVerifiedDependencyId(id: string): boolean {
  return BY_ID.has(id);
}
