# @costgenius/pricebook

Official building-works (ابنیه) price-book editions and the Item Master. Data enters through source → staging →
validation → human approval → immutable published edition.

**Status:** the official 1404 ابنیه edition ships as a **verified staged dataset**
(`data/verified-1404.staged.v0.1.0.json`, 1564 rows, hash-bound to the official source
PDF by `sourceFileHash`), loaded in-memory and published through `publishStagedImport`
for S2/S3; the package's 193-test suite pins the row count, the source hash and the row
invariants. Since P8-B S1 the edition is ALSO **persisted**: the first-boot seed
imports this file through the same validation gate into the `pricebook_editions`
registry (directly ACTIVE; `contentHash`
`a669ddd4c315ee26fda6e43cff56eeac05cc03178ed8a665a13f49ff814de786`), and the pure
edition domain model (`edition.ts`: statuses, canonical content, content hash) lives
here. Current scope is the single official 1404 edition; regional-coefficient VALUES
remain an external dependency (circular 94/69416 annex) and are never substituted. The
edition lifecycle contract is
[`spec/CG-IR-PRICEBOOK-SPEC@0.2.0.md`](spec/CG-IR-PRICEBOOK-SPEC@0.2.0.md) — contract
closed 2026-09-29 (D-PB-1..D-PB-5 final); **S1 (persistence + seed) implemented
2026-09-30; the lifecycle routes and UI (S2/S3) not implemented**;
[`spec/CG-IR-PRICEBOOK-SPEC@0.1.0.md`](spec/CG-IR-PRICEBOOK-SPEC@0.1.0.md) is the
superseded historical verification record of the official 1404 source (its lifecycle
model is superseded by 0.2.0). `spec/fixtures/` holds a **synthetic** fixture used
by the spec tests; it contains no real price-book data.
