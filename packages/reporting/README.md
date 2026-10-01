# @costgenius/reporting

Stage 1 of the two-stage reporting design: the ReportModel builder.

`buildReportModel` turns one BOQ estimate version (plus its authoritative rollup) into an
immutable, rendering-independent snapshot — sections, summary, per-line provenance
(sourceRef, edition, trace, external dependencies) and the optional S4 estimate result,
preserved verbatim. `validateReportModel` re-checks any report against its sources.

Excel/PDF/UI renderers (stage 2) consume this model later; none exist yet. No I/O, no
clock, no randomness: `reportId` and `generatedAt` are caller-supplied.

## Takeoff branch (D-016 Phase 6, G6=A)

`buildTakeoffReportModel` builds the same kind of snapshot for a **finalized takeoff**:
every quantity, rounded value, effective value and total is copied **verbatim** from the
persisted engine result (the `FinalizedTakeoff` snapshot, consumed structurally). The
builder performs no calculation of its own and rejects drafts, non-ok results, identity
mismatches and orphan lines. The `formula` column is the §6.3 canonical display of
CG-FT-TAKEOFF-SPEC@0.2.0 (`takeoffQuantityDisplay`) — the one deterministic formula
representation, never parsed back. Uncoded items keep `itemCode: null` («بدون کد» at
render time); no document total is ever invented.
