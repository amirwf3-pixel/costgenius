# @costgenius/reporting-pdf

Stage 2 (PDF branch) of the reporting design: a read-only, RTL Persian PDF renderer for
the Phase-9 `ReportModel`.

`renderReportToPdf(report)` → `Promise<Uint8Array>` — real PDF bytes, produced entirely in
memory. Presentation only: no business logic, no pricebook lookup, no recalculation, no
repair; a structurally invalid report fails loudly (`INVALID_REPORT_MODEL`).

## PDF library

**pdfkit** (+ `bidi-js`): a real PDF engine with TTF embedding, subsetting, in-memory
generation, TypeScript types (`@types/pdfkit`) and deterministic metadata (Creator,
Producer and creation/modification dates are pinned to a fixed epoch — rendering the same
report twice yields byte-identical output). Chosen over browser/HTML pipelines
(Playwright/Chromium in ARCHITECTURE.md's original sketch) because it is a single small
dependency, fully in-memory, and deterministic.

## RTL / shaping strategy

PDFKit draws glyphs left-to-right and performs **no Arabic shaping and no bidi**. This
package therefore has a small, clearly-scoped RTL presentation engine (`src/rtl.ts`):

1. **Shaping** — the Unicode Arabic joining algorithm maps every Persian/Arabic letter to
   its contextual **Arabic Presentation Form** (isolated/final/initial/medial, plus the
   mandatory Lam-Alef ligatures). Real glyph shaping — no string reversal, no
   transliteration.
2. **Bidi** — `bidi-js` (a full UAX #9 implementation) reorders the _shaped_ string into
   visual order. The base direction follows the **first strong character**: Persian text
   renders RTL, while pure-Latin tokens (`0990007`, `EXTERNAL_DEPENDENCY`,
   `IR-1404-E-OVERHEAD-01`, dependency ids) render LTR so trailing separators (`_`, `-`)
   stay on the correct end of the run. Signed decimals (`-15000`) are isolated with
   explicit LTR embeddings so the minus stays left of the digits.
3. **Wrapping** — logical text is wrapped by measuring each candidate line's shaped visual
   form; over-long unbreakable tokens are chunked by measured width, preferring
   separator boundaries (`-`, `_`, `/`, `.`) so ids and statuses break readably
   (`NOT_SPECIFIED_IN_1404_` / `PRICEBOOK`) instead of mid-word.

Because the pipeline renders presentation forms, text _extraction_ of Persian returns the
shaped visual codepoint sequence (not the logical string) — a documented property of this
strategy; Latin/decimal values extract exactly. Practical extraction notes (verified
against pdfjs-dist):

- extractors may report a glyph's **base letter** instead of its presentation form
  (ToUnicode variance); `normalizePresentationForms()` (exported for consumers) maps
  presentation forms back to base letters for stable comparisons, on either side;
- an extractor may report Persian digits (U+06Fx) as Arabic-Indic digits (U+066x);
- some extractors reverse whole RTL lines when reconstructing reading order (the digits
  `۱۴۰۴` may extract as `۴۰۴۱`). The renderer always draws the correct visual order —
  the pdf-model suite pins it at the engine level, independent of any extractor.

## Font + embedding

**Vazirmatn** Regular + Bold (SIL OFL 1.1, license in `assets/fonts/OFL.txt`), obtained
from the npm `vazirmatn` package and bundled in `assets/fonts/`. Vazirmatn covers Persian,
Arabic, Latin, Persian/Latin digits and punctuation — including the Arabic Presentation
Forms codepoints the shaper emits (verified by glyph-id coverage). Both faces are embedded
in every PDF (`/FontFile2`, subset), so documents render identically on any system.
`loadBundledFonts()` is the only filesystem access in this package (presentation asset
loading, no business data); callers can pass in-memory fonts via
`renderReportToPdf(report, { fonts })`.

## Document structure

A4. Portrait: Summary (key–value), Scope Boundaries, Chapters, Groups, S4 Calculation
Trace (when present). Landscape (deterministic, readability only): the Lines table and the
Line Provenance & Trace table (16 columns). Fixed running header (title, edition,
versionId) and Persian page footer («صفحه i از n»); table header rows repeat on every
page; rows are never split across pages; columns are laid out right-to-left.

## Exact values and statuses

Business decimal strings render as exact text: leading zeros (`0990007`), negatives
(`-15000`), zero (`0`), decimals (`1.0451`, `1.30` — never `1.3`). `null`/absent values
render as the typographic placeholder `—` — never `0`. All statuses appear verbatim
(`VERIFIED_SPEC_ONLY`, `EXTERNAL_DEPENDENCY`, `NOT_SPECIFIED_IN_1404_PRICEBOOK`,
`INCOMPLETE` + the four calculation statuses); a pending report shows no total, and the
scope-boundary NOT_SPECIFIED statements are printed verbatim. Dependency ids are printed
verbatim, joined with `'; '`.

## Takeoff branch (D-016 Phase 6, G6=A)

`renderTakeoffReportToPdf(report)` renders a validated `TakeoffReportModel` through the
SAME encoder: A4 portrait خلاصه (document metadata + rounding rules + the
exact/rounded/effective explanation) → landscape متره تفصیلی (one 17-column table per
sheet) → portrait جمع‌ها (item totals + per-sheet totals, exact/rounded/effective with
contributing lineIds). Uncoded items print «بدون کد»; `null` prints `—`; the formula
column is the §6.3 canonical display. Byte-deterministic, pinned metadata dates,
structurally invalid input fails loudly.

## Limitations

- Source data remains the 59 verified 1404 rows; nothing here extends it.
- Regional numerical values remain EXTERNAL_DEPENDENCY; multi-building/multi-discipline
  combinations remain NOT_SPECIFIED (displayed, never combined).
- The renderer does not visually render bracket mirroring (UAX #9 L4); the verified
  business values contain no mirrored brackets.
- No visual (PDF→image) validation ran in this environment (no pdftoppm/gs/mutool);
  validation is programmatic (pdfjs-dist parse + text extraction + byte determinism).
