# @costgenius/projects

Application/orchestration layer of the estimate workflow (Phase 13): Project → Estimate →
EstimateVersion → BOQ lines (exact 1404 pricebook binding) → S4 → rollup → ReportModel →
Excel/PDF rendering. Owns no formula and no formatting — every number comes from the
engine layers, every layout from the renderers. Pure: no I/O, no clock, no randomness
(identities and instants are injected).

Also defines the persistence contracts (`src/persistence.ts`, async since Phase 14)
implemented by `@costgenius/db` (PostgreSQL/Drizzle) and by the deterministic in-memory
reference adapters.

## Production workflow (Phase 17)

- **Project lifecycle** — created once (`createProject`), immutable afterwards: identity
  and content never change (the persistence layer byte-compares re-saves; a different
  content under the same id is `PERSISTENCE_CONFLICT`). Listing a project's estimates is
  the repository's `findByProjectId` (full aggregates, deterministic order).
- **Estimate lifecycle** — `createEstimateForProject` (after its project exists) → zero
  or more versions, append-only; the current version is the highest `versionNumber`
  (`currentVersionOf`). Estimate identity (project, title) is immutable.
- **Version lifecycle** — `startEstimateVersion` opens a draft bound to the dataset's
  edition (1404). A draft may gain lines (`addEstimateLines`) and be recalculated any
  number of times (`calculateEstimateVersion` — a pure preview, nothing persisted).
  `finalizeEstimate` closes it: the one-way draft → finalized transition, persisted with
  its immutable snapshot. The only way forward after a finalized version is a NEW
  version (v1 stays byte-stable). There is deliberately no `CALCULATED` state: a
  calculation is a pure function of the draft, not a persisted lifecycle stage.
- **BOQ lifecycle** — lines are APPEND-ONLY by design: `addEstimateLines` binds
  exact-code rows from the published dataset (S2), prices them (S3) and appends. There
  is no edit-line or remove-line operation in the domain, and the persistence layer
  enforces the same (a draft's stored lines must be a prefix of the presented ones).
  Removing or editing a line = create the next version with the desired line set.
- **Finalization / rendering** — `finalizeEstimate` returns the complete immutable bundle
  (estimate + calculation + finalizedAt); renderers (`renderEstimateExcel`/
  `renderEstimatePdf`) work only from such a persisted snapshot — they never recalculate,
  look up prices or repair data. XLSX and PDF renders are byte-deterministic.
