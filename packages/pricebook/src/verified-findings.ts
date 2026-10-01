/**
 * Coverage findings of the verified 1404 specification.
 *
 * These keep the three coverage concepts distinct and prevent fabrication:
 * a chapter/group that is known, one that is absent from the verified source, and one that
 * was never unit-audited. A finding is a recorded fact about the source — it never becomes
 * a placeholder row, group or chapter.
 */
export type CoverageFindingKind = 'absent-from-verified-source' | 'not-audited';

export interface CoverageFinding {
  readonly kind: CoverageFindingKind;
  /** Subject identity, e.g. "chapter-15". */
  readonly subject: string;
  readonly detail: string;
}

export const VERIFIED_COVERAGE_FINDINGS: readonly CoverageFinding[] = Object.freeze([
  {
    kind: 'absent-from-verified-source',
    subject: 'chapter-15',
    detail:
      'Chapter 15 is not present in the 1404 price book (Chapter 14 ends on p117, Chapter 16 opens on p118); it must not be created, inferred or imported',
  },
  {
    kind: 'absent-from-verified-source',
    subject: 'chapter-25/group-02',
    detail: 'Chapter 25 prints groups 01 and 03–08 with no group 02; no group 02 is fabricated',
  },
  {
    kind: 'absent-from-verified-source',
    subject: 'chapter-26/group-02',
    detail: 'Chapter 26 prints no group 02; not fabricated',
  },
  {
    kind: 'absent-from-verified-source',
    subject: 'chapter-26/group-05',
    detail: 'Chapter 26 prints no group 05; not fabricated',
  },
  {
    kind: 'absent-from-verified-source',
    subject: 'chapter-28/group-02',
    detail: 'Chapter 28 prints no group 02; not fabricated',
  },
  {
    kind: 'absent-from-verified-source',
    subject: 'chapter-28/group-04',
    detail: 'Chapter 28 prints no group 04; not fabricated',
  },
  {
    kind: 'absent-from-verified-source',
    subject: 'chapter-29/rows',
    detail:
      'Chapter 29 (labour works, pp233–234) prints one clause and an empty row table; zero rows exist and none are invented',
  },
  {
    kind: 'not-audited',
    subject: 'chapters-1-to-7',
    detail:
      'Chapters 1–7 rows are extracted at glyph level in the v2 dataset (353 rows, decoder calibrated against every audited chapter block with zero discrepancies), but no Phase 3.5 per-row unit audit exists for them; only specific clauses (pp1–5 application/general requirements, Chapter 7 clause 2) and payment references are spec-verified',
  },
  {
    kind: 'not-audited',
    subject: 'full-price-coverage',
    detail:
      'The v2 dataset carries the complete printed row/price set: 1564 rows (chapters 1–14 and 16–28, Appendix 1 Table 2, Appendix 5) extracted glyph-level from the official PDF; Chapter 15 is absent from the source, Chapter 29 prints no rows, and 030905 prints neither unit nor price and is documented in COVERAGE-1404.md rather than given an invented unit',
  },
]);

export function coverageFinding(subject: string): CoverageFinding | undefined {
  return VERIFIED_COVERAGE_FINDINGS.find((f) => f.subject === subject);
}
