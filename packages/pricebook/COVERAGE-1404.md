# COVERAGE-1404 — coverage and documented absences

Companion record to [`data/verified-1404.staged.v0.1.0.json`](data/verified-1404.staged.v0.1.0.json)
(edition `ir-1404-abniye`, «فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴», circular 1403/742948,
source file `فهرست‌بهای واحد پایه رشته ابنیه ۱۴۰۴ — PDF رسمی.pdf`,
sha256 `c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f`).

The dataset carries **1564 rows**: every printed price row of chapters 1–14 and 16–28,
Appendix 1 Table 2 and Appendix 5 — 59 previously verified rows preserved unchanged
(apart from the now-verified `sourceFileHash`) and 1505 rows decoded at glyph level from
the official PDF. This file records every hole in the printed source that a dataset row
might otherwise be invented to fill. A recorded absence never becomes a placeholder row,
group or chapter; the machine-readable counterparts of these findings live in
`src/verified-findings.ts` (`VERIFIED_COVERAGE_FINDINGS`).

## Row-shaped absences (excluded, never fabricated)

- **Chapter 15** — absent from the source: Chapter 14 ends on p117 and Chapter 16 opens
  on p118. No `chapter-15` rows exist and none may be created, inferred or imported.
- **Chapter 29 rows** — the chapter (labour works, pp233–234) prints one clause and an
  empty row table; zero rows exist and none are invented.
- **Row 030905** — a chapter-3 band (code prefix 03, group 09; 45 bands print in the
  chapter) that prints **neither a unit nor a price**. It is not representable as a
  pricebook row and is excluded from the dataset (chapter 3 ships 44 rows) rather than
  being given an invented unit or price. This is the only audited-chapter row excluded
  from the dataset.

## Group-shaped absences (never fabricated)

- Chapter 25 prints groups 01 and 03–08 with no group 02.
- Chapter 26 prints no group 02 and no group 05.
- Chapter 28 prints no group 02 and no group 04.

## Printed-code numbering gaps (source typography, not missing data)

- Chapter 17's numbering jumps from 170206 to 170209: codes 170207 and 170208 print
  nowhere in the source; row 170209 cites rows 170204 and 170206.
- Chapter 19's clause text references row 191010 (substructure of 191006 to 191010,
  as printed) while no row 191010 exists in the chapter table; whether rows 191011 and
  191012 are covered is `NOT_SPECIFIED_IN_1404_PRICEBOOK`.

## Null-price rows by policy (blank ≠ zero — data recorded as printed, never coerced)

These rows are **present** in the dataset with `basePrice: null` and a note carrying the
printed evidence; they are policy, not data loss. Exact frozen memberships are asserted
in `test/pricebook-data-v2.test.ts`:

- **Blank price cells** (printed blank; status `INCOMPLETE`, warning `NO_PRINTED_PRICE`) —
  58 chapter rows plus Appendix 1 row 411004.
- **Appendix 5** — all 60 rows print no price **by design** (clause 2-1: the estimator
  enters the prices of the place of execution); every row is `INCOMPLETE`/null and its
  printed type is recorded in its note.
- **Percentage cells** (8 rows, unit درصد) — the cell prints a percentage, not a Rial
  price; the percentage is preserved in the note.
- **Deduction cells (کسر بها)** — 220925, 180323, 180913 and 192001 print negative
  amounts as deductions, not prices; the printed amount is preserved in the note
  (220925 is additionally guarded by the `mustNotBeNegative` anchor).
- **Star items (＊)** — 090320, 090321, 120106 and 160801 print the star-item
  instruction (status `EXTERNAL_DEPENDENCY`); 180811, 180818, 250801 and 250802 are
  tied to it (`INCOMPLETE` with the same declared dependency).
- **Literal `۱`** — 11 rows print the literal one as their price; kept as printed
  (`'1'`, `INCOMPLETE`) with warning `SUSPICIOUS_LITERAL_ONE`.

## Coverage limits

- **Chapters 1–7** (353 rows) are extracted at glyph level with the same decoder that
  reproduced every audited chapter block with zero discrepancies, but no Phase 3.5
  per-row unit audit exists for them; only specific clauses and payment references are
  spec-verified there (`kind: 'not-audited'` in `VERIFIED_COVERAGE_FINDINGS`).
- Printed page numbers are recorded per row as extracted; none are invented.
