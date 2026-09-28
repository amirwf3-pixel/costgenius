# @costgenius/reporting-excel

Stage 2 (Excel branch) of the reporting design: a read-only XLSX renderer for the
Phase-9 `ReportModel`.

`renderReportToXlsx(report)` → `Promise<Uint8Array>` — real XLSX bytes, produced entirely
in memory (the caller decides where the bytes go; the renderer touches no filesystem,
clock or randomness, and never invents a filename).

## Presentation only

The renderer contains **no business logic**: no pricebook lookup, no S2/S3/S4
recalculation, no coefficient or rollup arithmetic, no status upgrading, no repair. Every
number, status and dependency id is copied from the ReportModel; a structurally invalid
report fails loudly (`INVALID_REPORT_MODEL`) instead of being fixed.

## Workbook

Fixed, deterministic sheet order: **Summary · Chapters · Groups · Lines** (+ **S4 Trace**
when the report carries an S4 estimate result — the coefficient chain preserved verbatim,
e.g. golden P `1.0451`, overhead `1.30`, site setup as a separate additive stage).

## Takeoff branch (D-016 Phase 6, G6=A)

`renderTakeoffReportToXlsx(report)` renders a validated `TakeoffReportModel` through the
SAME encoder. Fixed sheet order: **خلاصه · متره تفصیلی · جمع آیتم‌ها · جمع برگه‌ها**.
Exact/rounded/effective decimals are text cells (never numbers, never formulas — static
values only); uncoded items print «بدون کد»; contributing lineIds join with «، »;
`null` renders as an empty cell. Byte-deterministic (zip entries pinned to a fixed
epoch); structurally invalid input fails loudly.

## Exact-value contract

- Business decimal strings (codes, quantities, prices, amounts, coefficients) are **text
  cells**: leading zeros (`0990007`), negatives (`-15000`), zero (`'0'`) and decimals stay
  exact — never converted through numbers.
- Integers that are already numbers in the contract (counts, version number) are integer
  cells.
- `null`/absent values render as **empty cells** — never `0`. A pending report shows an
  empty total plus its status, never a normal-looking number.
- Multi-value cells (dependency ids) use the deterministic delimiter `'; '`
  (`CELL_DELIMITER`).
- The workbook's doc properties are pinned to a fixed epoch constant (not a clock read).

Excel may flag numbers-stored-as-text on business columns; that is the deliberate,
documented trade-off of the exact-decimal contract.
