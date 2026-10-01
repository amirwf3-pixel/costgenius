# @costgenius/db

PostgreSQL/Drizzle persistence adapter (Phase 14) — implements the repository contracts of
`@costgenius/projects` (`ProjectRepository`, `EstimateRepository`,
`FinalizedEstimateRepository`, and the D-016 `TakeoffDocumentRepository` /
`FinalizedTakeoffRepository`) over the schema in `src/schema` (projects → estimates →
estimate_versions → boq_lines, plus the immutable finalized_estimates record; and the
D-016 Full Takeoff family takeoff_documents → takeoff_sheets → takeoff_lines, plus the
immutable finalized_takeoffs snapshot).

- **Not a price master**: the verified 1404 pricebook dataset stays the source of truth;
  only application data and snapshots created from it are persisted.
- **Exactness**: business decimals are `numeric` columns read/written as exact strings;
  blank prices stay NULL (never 0); leading-zero codes stay text; domain instants are
  stored verbatim (the database never generates or reformats time).
- **Immutable history**: finalized versions/bundles are byte-compared (canonical JSON) —
  different content is `FINALIZED_ESTIMATE_IMMUTABLE`, never an update; drafts only ever
  append lines; nothing is ever deleted.
- **Concurrency (Phase 16)**: `syncEstimate` takes the version-row lock
  (`SELECT … FOR UPDATE`) before reading a version's lines, so finalization and
  line-appends on the same version serialize; the transaction that arrives second
  re-reads the committed state under the lock and fails with its deterministic contract
  error (verified against a real PostgreSQL server, including the corrupted-snapshot
  race that motivated the lock).
- **Client**: injectable (`createDbPool`/`createDb`, node-postgres); migrations are
  versioned SQL in `migrations/` applied by `migrateDatabase` (journal-based, seed-free);
  regenerate with `pnpm db:generate`.
- **Full Takeoff (D-016)**: drafts are fully editable with optimistic concurrency
  (`save(document, expectedRevision)`, `revision` +1 per save, stale →
  `PERSISTENCE_CONFLICT`); archive is soft and reversible (`G1b=C`); finalization is the
  atomic draft→finalized transition plus the write-once `finalized_takeoffs` snapshot
  (byte-compared, `TAKEOFF_DOCUMENT_IMMUTABLE` on difference); follow-up revisions copy a
  finalized document as the next chain member (`takeoffId` + `documentNumber`). The
  persisted sheets/lines ARE the engine input, so documents round-trip into
  `calculateTakeoff` without semantic loss.
- **Tests** run against real PostgreSQL in-process (PGlite — PostgreSQL compiled to WASM)
  with the actual migrations; server-based deployment via node-postgres is the production
  path (exercised by the same repository code, plus the env-gated
  `takeoff-concurrency.server.test.ts` real-server suite).
