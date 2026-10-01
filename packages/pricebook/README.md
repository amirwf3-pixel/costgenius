# @costgenius/pricebook

Official building-works (ابنیه) price-book editions and the Item Master. Data enters through source → staging →
validation → human approval → immutable published edition.

**Status:** the official 1404 ابنیه edition ships as a **verified staged dataset**
(`data/verified-1404.staged.v0.1.0.json`, 1564 rows, hash-bound to the official source
PDF by `sourceFileHash`) — since P8-B S3 a **seed artifact and provenance reference
only**: the API loads no dataset at boot, and every runtime dataset is re-published
from the persisted `pricebook_editions` rows through this same `publishStagedImport`
gate (hash-verified). The package's 193-test suite pins the row count, the source hash
and the row invariants. Since P8-B S1 the edition is ALSO **persisted**: the first-boot
seed imports this file through the same validation gate into the `pricebook_editions`
registry (directly ACTIVE; `contentHash`
`a669ddd4c315ee26fda6e43cff56eeac05cc03178ed8a665a13f49ff814de786`), and the pure
edition domain model (`edition.ts`: statuses, canonical content, content hash) lives
here, and since P8-B S2 the pure lifecycle decision layer (`edition-lifecycle.ts`:
the §8 transition guards and the §20 error codes of the activate/archive commands)
lives here too. Current scope is the single official 1404 edition;
regional-coefficient VALUES remain an external dependency (circular 94/69416 annex)
and are never substituted. The edition lifecycle contract is
[`spec/CG-IR-PRICEBOOK-SPEC@0.2.0.md`](spec/CG-IR-PRICEBOOK-SPEC@0.2.0.md) — contract
closed 2026-09-29 (D-PB-1..D-PB-5 final); **S1 (persistence + seed), S2 (the
lifecycle API: routes #39–#43, the ACTIVE-resolving default edition search) and S3
(edition binding: the optional `editionId` on version creation, per-version
line/transfer resolution, the rows `editionId` parameter, the selector UI) implemented
2026-09-30/2026-10-01; further P8-B stages (S4) not started**;
[`spec/CG-IR-PRICEBOOK-SPEC@0.1.0.md`](spec/CG-IR-PRICEBOOK-SPEC@0.1.0.md) is the
superseded historical verification record of the official 1404 source (its lifecycle
model is superseded by 0.2.0). `spec/fixtures/` holds a **synthetic** fixture used
by the spec tests; it contains no real price-book data.
