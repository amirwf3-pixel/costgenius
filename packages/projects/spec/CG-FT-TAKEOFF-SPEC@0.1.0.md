# CG-FT-TAKEOFF-SPEC@0.1.0: Full Takeoff (متره) Product Specification

| Field           | Value                                                                                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec ID         | `CG-FT-TAKEOFF`                                                                                                                                                                                                                                                                                                         |
| Version         | `0.1.0`                                                                                                                                                                                                                                                                                                                 |
| Status          | Superseded by `CG-FT-TAKEOFF-SPEC@0.2.0` (D-017 contract closure, 2026-09-28) — history; normative content carries into 0.2.0 (changelog there). §12's `TAKEOFF_SOLUTION_REJECTED` rows described the intended solve surface, not the shipped finalization contract (`TAKEOFF_CALCULATION_FAILED`) — corrected in 0.2.0 |
| Scope           | The Full Takeoff product: document lifecycle and revisions, persistence, draft mutation and concurrency, calculation orchestration, rounding governance, BOQ transfer, reporting, provenance and the API error contract                                                                                                 |
| Engine contract | [`CG-IR-MEAS@0.2.0`](../../calc-engine/spec/CG-IR-MEASUREMENT-SPEC@0.2.0.md) — `calculateTakeoff`, implemented beside the FROZEN `calculateQuantities` (CG-RCS@0.1.0)                                                                                                                                                   |
| Decisions       | D-016 (DECISIONS.md): G1=A, G1b=C, G2=B, G4=B, G5=B, G6=A, R1=A, R2=C, R3=A                                                                                                                                                                                                                                             |
| Compatibility   | D-015 remains CLOSED; its quick-entry path is unchanged (§14)                                                                                                                                                                                                                                                           |

## 0. Source policy (normative)

1. This specification is a CostGenius design record formalizing the D-016 owner decisions.
   Where it is silent on S1 semantics, the engine contract (CG-IR-MEAS@0.2.0) governs;
   where both are silent, the existing estimate/BOQ contracts (ARCHITECTURE.md §4–§6) govern.
2. No Iranian measurement or rounding rule may be invented or assumed (CG-IR-MEAS §0 and
   §9 registry discipline; Q-1/Q-IR-5 remain unresolved without an authoritative source).
   `unverified`/`VERIFIED_SPEC_ONLY` rules never change a number.
3. Quantities are never produced or completed by AI (D-008). The line `origin` enum is
   carried as data; in V1 the product authors only `origin: "user"` (`import`/`ai-accepted`
   remain reserved for future, separately built pipelines).
4. This document specifies contracts, not implementation details. The D-016
   implementation (migration `0001_d016_takeoff`, the takeoff routes, the Takeoff
   workspace and `calculateTakeoff`) follows these contracts; behavior changes ship as
   spec version bumps with updated golden tests (§11).

## 1. Architecture and separation of concerns (normative)

```
UI (apps/web — Takeoff workspace)
  ↓ HTTP — strict Zod, exact decimal strings, no client-side calculation
API (apps/api — lifecycle + solve + transfer routes; stable public error codes)
  ↓
Takeoff application layer (packages/projects — workflow, lifecycle rules, transfer)
  ↓
calculateTakeoff (packages/calc-engine — PURE sibling of the frozen calculateQuantities)
  ↓ deterministic exact calculation → RoundingRuleSet application
Takeoff persistence (packages/db — repositories implementing the projects contracts)
  ↓
BOQ / Estimate (existing S2/S3/S4, estimate versions, snapshots — unchanged)
  ↓
Reporting (existing ReportModel → Excel/PDF renderers — extended, not replaced)
```

- `calculateQuantities` (CG-RCS@0.1.0) remains FROZEN and keeps serving the D-015
  quick-entry path unchanged: add-line dialog → lines-endpoint `takeoff` factors →
  `packages/projects/src/takeoff-quantities.ts` adapter.
- `calculateTakeoff` is a **sibling** engine contract (CG-IR-MEAS@0.2.0 §1): it never
  rewrites, wraps or supersedes `calculateQuantities`, and stamps its own
  `specVersion`/`engineVersion`.
- calc-engine purity rules apply to `calculateTakeoff` unchanged: no I/O, no clock, no
  randomness, no floats for business numbers, no `eval`.
- The API layer still never imports calc-engine directly (boundary as today); it goes
  through `@costgenius/projects`.
- The UI never computes quantities: it renders engine results and the canonical formula
  display (§6) only.

## 2. Lifecycle and revisions (G1=A, G1b=C, G4=B) — resolves N1

### 2.1 States

Exactly three statuses exist on a takeoff document: `draft` (active), `archived`,
`finalized`. No other lifecycle state is introduced.

Supersession is **positional, not a status**: when a follow-up revision exists in a chain,
earlier revisions keep their own status (a finalized revision stays `finalized`, exactly
like estimate v1 stays finalized when v2 exists). The chain's current revision is the
highest `documentNumber`.

### 2.2 Chain model

A takeoff **chain** is identified by `takeoffId`; each chain member is a document revision
with a sequential `documentNumber` (unique per chain) — mirroring `estimateId` +
`versionNumber` in the existing estimate versioning. The document identity used by the API
and provenance is `documentId` (one per revision row).

### 2.3 Transitions (all deterministic; anything not listed is invalid)

| Operation        | Precondition                             | Effect                                                                                                                 |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| create           | project exists                           | new chain: `documentNumber = 1`, status `draft`, `revision = 1`                                                        |
| save             | status `draft`, `expectedRevision` ok    | full-document replace (title, sheets, lines, roundingRuleSet); `revision += 1`                                         |
| archive          | status `draft`, `expectedRevision` ok    | status → `archived` (soft; auditable, recoverable)                                                                     |
| unarchive        | status `archived`, `expectedRevision` ok | status → `draft` (content and `revision` unchanged)                                                                    |
| finalize         | status `draft`, `expectedRevision` ok    | solve → canonical snapshot stored; status → `finalized`; immutable (byte-compare on re-save)                           |
| create-follow-up | source status `finalized`                | new draft `documentNumber + 1` in the same chain: a full copy of the source's sheets, lines and roundingRuleSet (§2.4) |

- Editing, archiving or finalizing an `archived` or `finalized` document, unarchiving a
  `draft`/`finalized` document, or creating a follow-up from a draft are invalid
  transitions (§12).
- Finalization is atomic with its snapshot (single transaction, serialized on the document
  row — the existing `SELECT … FOR UPDATE` pattern).

### 2.4 Follow-up revision copy semantics

The follow-up draft starts as a verbatim copy of the finalized source: same `sheetId`s,
same `lineId`s, same `rowNo`s, same expressions, same roundingRuleSet; its own `revision`
counter starts at 1. `lineId` stability across revisions gives cross-revision
traceability (the same `lineId` in revision N and N+1 denotes the same logical line). A
new line added in the follow-up must use a `lineId` unused within that document.

### 2.5 Archive semantics (G1b=C)

Archive is soft and reversible; nothing in the Takeoff family is ever hard-deleted.
Archived drafts remain readable and auditable, and can be unarchived. Finalized documents
are never archived — they are history by construction.

## 3. Persistence conceptual model (G1=A)

Conceptual only — **no DDL, no migration, no ORM detail here**. Conventions follow the
existing persistence layer exactly: business numbers are exact decimal strings, embedded
structures are JSONB snapshots copied verbatim, timestamps are domain Instant strings
(never database-generated), finalization is snapshot-based and byte-compared on re-save.

| Resource             | Identity                  | Key fields and constraints                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `takeoff_documents`  | `documentId`              | `takeoffId` + `documentNumber` (unique per chain), `projectId` → projects, `title`, `status` (`draft`\|`archived`\|`finalized`), `revision` (optimistic-concurrency counter, starts at 1), `roundingRuleSet` JSONB, `specVersion`, `createdAt`, `archivedAt?`, `finalizedAt?` |
| `takeoff_sheets`     | (`documentId`, `sheetId`) | `name`, `sheetOrder` (presentation order within the document). `sheetId` unique per document (engine V1)                                                                                                                                                                      |
| `takeoff_lines`      | (`documentId`, `lineId`)  | `sheetId` (within the document), `rowNo` (unique per sheet — engine V1), `description`, `location?`, `itemCode?`, `kind`, `unit`, `quantity` JSONB (the typed expression tree), `notes?`, `origin`, `ruleRefs?` JSONB                                                         |
| `finalized_takeoffs` | `documentId`              | canonical bundle JSONB: the complete document input + `TakeoffResult` + traces + the applied roundingRuleSet; `finalizedAt`. Immutable; byte-compared on re-save (the `finalized_estimates` pattern)                                                                          |

- Rows of `takeoff_sheets`/`takeoff_lines` belong to one document revision (the chain
  member), exactly like `boq_lines` belong to one estimate version.
- Loading a finalized document always returns the snapshot; rendering never recalculates
  (D-005 doctrine).
- Ordering (`documentNumber`, `sheetOrder`, `rowNo`) is presentation-only: canonical
  calculation and hashing ignore it (engine §7.5).

## 4. Draft mutation and concurrency (G4=B) — resolves N4

- Drafts are editable; `archived` and `finalized` documents are not.
- Every mutation carries `expectedRevision` in the request body. The server applies the
  mutation only if the stored `revision` matches; otherwise it answers `409
PERSISTENCE_CONFLICT` (the existing public code, existing Persian UX). No
  last-write-wins exists anywhere.
- **POST-only mutation** (consistent with the current GET/POST API doctrine; no
  PATCH/PUT/DELETE is introduced): `save`, `archive`, `unarchive`, `finalize`,
  `create-follow-up` are POST operations with `expectedRevision` in the body.
- Mutation granularity in V1 is the **full-document replace**: `save` submits the complete
  document content (title, sheets, lines, roundingRuleSet) and the server validates and
  stores it atomically (`revision += 1`). This is the simplest deterministic conflict
  surface; granular per-line operations are a future extension, not part of 0.1.0.
- `solve` (§5) never mutates: it computes from submitted or stored content and persists
  nothing.

## 5. Calculation contract

Solve = engine `calculateTakeoff` (CG-IR-MEAS@0.2.0): validate (V1–V13, all errors
collected in input order, atomic) → topological order by reference (ties broken by
`(sheet order, rowNo, lineId)`) → exact evaluation per line → apply a matching `line`
rounding rule → apply the `kind` sign → aggregate per `itemCode` and per sheet **from
exact values** → apply matching `item-total`/`sheet-total` rules.

Result levels (exact always authoritative; rounded always derived):

| Level      | Exact                                                                                        | Rounded                                                             |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| line       | `exactMagnitude` / `exactQty`                                                                | `roundedMagnitude?` / `roundedQty?` (only if a `line` rule matched) |
| itemTotal  | `exactQty`                                                                                   | `roundedQty?` (only if an `item-total` rule matched)                |
| sheetTotal | exact sum of its lines' exact values                                                         | rounded once if a `sheet-total` rule matched                        |
| document   | **not supported** — the engine contract defines no document total and D-016 does not add one | —                                                                   |

Determinism: identical canonical input produces a byte-identical canonical result;
renumbering `rowNo` or reordering sheets changes no value (engine §7.5).

### 5.1 floorCount / similarCount (explicit)

- Domain: integers ≥ 1 when present (engine §2.1/V2). Zero and negative values are invalid
  (`NON_INTEGER_COUNT`); fractional values are invalid.
- No default is invented: an absent factor means 1 and is **recorded as absent in the
  trace**, never written as `1`.
- Semantics: they multiply the dimensional profile product
  (`value = floorCount × similarCount × Π(profile dimensions)`; `profile: "count"` →
  `value = floorCount × similarCount`). They are exact factors inside the exact
  evaluation — they never interact with rounding (a `line` rule rounds the line's exact
  result, after all factors).
- They are never merged into one `count` field (reports show them in separate columns).

### 5.2 References

- Identity: the referenced line's `lineId` (document-unique; never `rowNo`).
- Target: the referenced line's **resolved** value — `use: "signed"` or `use: "magnitude"`.
- Ordering: topological; declaration order and sheet membership are irrelevant, so forward
  and cross-sheet references are allowed.
- Cycles: deterministic rejection (`CIRCULAR_REFERENCE`, the cycle listed, lexicographically
  rotated — engine V6).
- Unresolved targets: deterministic rejection (`UNKNOWN_REFERENCE` — engine V5).
- Exact-value propagation: references consume the referenced line's **exact** value unless
  an explicit `reference-term` rule rounds that term (engine §6 — an existing 0.1.0 rule,
  carried into 0.2.0; nothing new is invented for V1).
- Unit rule: a reference's target must share the referencing line's unit (engine V7).

## 6. Expression model and canonical display (G5=B) — resolves N5

### 6.1 Representation (authoritative)

The structured expression tree of CG-IR-MEAS@0.2.0 §4 is the only representation:
`dimensional` (profile L/LW/LWH/count + factors), `reference` (terms), `expression`
(nodes `const`/`ref`/`add`/`mul`/`sub`/`round`), `manual` (value + mandatory
justification). Division, powers, π and arbitrary functions do not exist in V1 (Q-IR-4);
adding them requires an engine-spec version bump under a separate decision.

### 6.2 Evaluation

Only the engine evaluates, exactly and deterministically. There is **no free-form parser
and no text evaluation in V1**; `eval` remains forbidden. Structurally invalid trees are
unrepresentable at the API edge: the request schema is a closed discriminated union, so a
malformed expression is a `400 INVALID_REQUEST` before any engine call. The engine only
ever receives well-formed trees.

### 6.3 Canonical display (normative, deterministic)

A single canonical rendering is shared by the UI and the report; it is a pure function of
the tree (same tree → same string, always), rendered LTR inside the RTL Persian layout.
It is **never parsed back** — display is not an execution language.

Tokens: `×` multiplication, `+` addition, `-` subtraction (ASCII), `#<lineId>` a signed
reference, `|#<lineId>|` a magnitude reference; decimal factors appear as their exact
literal string.

```
display(dimensional line) = "(" [floorCount " × "] [similarCount " × "] dim₁ [" × " dim₂ [" × " dim₃]] ")"
                               — only present factors, in this order
display(reference line)   = "(" term (" + " term)* ")"  with term = factor " × " ("#" lineId | "|#" lineId "|")
display(expression node)  = const → the literal string
                            ref   → "#" lineId | "|#" lineId "|"
                            add   → "(" a " + " b [" + " c …] ")"
                            mul   → "(" a " × " b [" × " c …] ")"
                            sub   → "(" a " - " b ")"
                            round → "round(" arg ", " scale ", " mode ")"
display(manual line)      = the value literal, with the justification shown separately
```

## 7. Rounding governance (R1=A, R2=C, R3=A) — resolves N6, N7

- The document-level `RoundingRuleSet` (engine §6) is the only rounding authority:
  entries `{target, selector?, scale 0..20, mode, sourceStatus, source?}`; narrowest
  selector match wins; ties are errors (`INVALID_ROUNDING_POLICY`). No rule ⇒ no rounding.
- **Targets are limited to** `line`, `reference-term`, `item-total`, `sheet-total`
  (exactly the engine 0.1.0/0.2.0 set). No document-level target, no organization policy,
  no market-specific policy, no undocumented Iranian standard rules.
- **R1 (normative for V1):** exact values are always computed and retained; aggregation is
  from exact values; the applicable total rule rounds once at its target. Rounded values
  are derived and never feed another rounding. There is **no accumulate-rounded mode in
  V1** — the phrase "unless the explicit rounding rule says otherwise" introduces no
  behavior (engine 0.2.0 §7.4 states this normatively).
- **R2:** the BOQ transfer consumes `itemTotal.qty` — the rounded itemTotal when an
  `item-total` rule matched, otherwise the exact itemTotal. S2/S3/S4 never re-round
  (§8).
- **R3:** in V1 the product authors only `sourceStatus: "design"` rules; the authoring API
  rejects the other enum values. No organization-policy infrastructure exists or is
  implied. Iranian rounding practice remains an open question (Q-1/Q-IR-5).
- Exact and rounded values are both recorded in the result and the trace, together with
  the identity of the applied rule (target/scale/mode/selector).

## 8. BOQ transfer (G2=B, R2=C) — resolves N2, N3

A deterministic, atomic operation: **finalized Takeoff document → draft estimate version**.

1. The source must be `finalized` (snapshot-backed, deterministic). The target must be a
   `draft` estimate version.
2. Aggregation: per `itemCode` itemTotal (engine V13 guarantees unit homogeneity upstream;
   incompatible units never reach transfer). **Uncoded lines are never transferred** —
   they remain in the Takeoff and are reported there only.
3. One BOQ line is created per **priced** itemCode/itemTotal, through the existing
   line-resolution path (S2 exact-code binding + unit equality, S3 exact pricing —
   arithmetic unchanged). The BOQ line quantity is `itemTotal.qty` (R2): rounded iff an
   `item-total` rule matched, otherwise exact. No second rounding anywhere downstream.
4. Repeat protection: the transfer is rejected if the target version already contains any
   line whose provenance references the same source `documentId`
   (`TAKEOFF_TRANSFER_REJECTED`, failure `ALREADY_TRANSFERRED` in details). No duplicate
   BOQ line is ever created for the same transfer operation.
5. The batch is all-or-nothing, exactly like the existing lines endpoint: any rejected
   itemCode rejects the whole transfer with per-item failures.

Behavior matrix (deterministic; nothing silent):

| Situation                                                          | Behavior                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| itemCode exists in the published pricebook, unit matches           | one BOQ line; S2 binds, S3 prices (existing semantics)                                                     |
| itemCode missing from the pricebook                                | transfer rejected (atomic), failure `PRICEBOOK_ROW_NOT_FOUND` in details — the existing S2 code            |
| itemCode exists but its pricebook unit ≠ itemTotal unit            | transfer rejected (atomic), failure `UNIT_MISMATCH` in details — the existing S2 code                      |
| pricebook row blocked / incomplete (e.g. کسر بها rows, null price) | binds; produces an unpriced BOQ line with its source statuses — existing S2/S3 semantics (data, not error) |
| same itemCode with incompatible units among Takeoff lines          | impossible at transfer — rejected earlier at solve by engine V13 (`AGGREGATION_UNIT_MISMATCH`)             |
| target version already finalized                                   | existing `409` family (VERSION_FINALIZED / FINALIZED_ESTIMATE_IMMUTABLE)                                   |
| same source transferred again                                      | `422 TAKEOFF_TRANSFER_REJECTED` with `ALREADY_TRANSFERRED` in details                                      |

No pricing semantics beyond the existing S2/S3 are invented by this specification.

### 8.1 Transfer provenance

Each transferred BOQ line carries a **new** trace field, separate from D-015's
`trace.takeoff` (which stays reserved for quick-entry lines, byte-compatible):

```
trace.takeoffDocument = {
  takeoffDocumentId, takeoffId, documentNumber,      // revision identity
  itemCode, unit,
  lineIds,                                            // contributing Takeoff lines
  exactQty, roundedQty?, qty,                         // exact always; rounded only if a rule matched
  roundingRule?,                                      // the matched item-total rule entry, when one applied
  specVersion, engineVersion                          // of the calculateTakeoff result
}
```

The full calculation trace stays in the Takeoff snapshot; the BOQ line never duplicates
the whole document (§10).

## 9. Reporting (G6=A)

One **standard** detailed Takeoff report, rendered from the finalized snapshot only, in
both PDF and Excel, through the existing two-stage architecture (a takeoff report model →
the existing renderers, extended — not replaced). No organization-customizable template
system exists in V1. No live Excel formulas (the existing D-010 deferral stands). Reports
are byte-deterministic.

Content contract:

- **Detailed section** — document metadata (title, `takeoffId`, `documentNumber`, status,
  project, created/finalized instants, spec/engine versions), the roundingRuleSet summary;
  per sheet: name; per line: `rowNo`, `lineId`, description, location (where present),
  `itemCode` (where present), unit, kind, the canonical formula display (§6.3), the
  factors (`floorCount`/`similarCount` shown only where present — absent is shown as
  absent, never as 1), exact result, rounded result (where applicable), reference terms,
  and a trace reference.
- **Summary section** — per itemCode: `itemCode`, unit, exact itemTotal, rounded
  itemTotal (where applicable), the contributing `lineIds`. Line descriptions live in the
  detailed section; pricebook descriptions are not joined into takeoff reports (S1 keeps
  `itemCode` opaque — engine V12 — and reports render from snapshots only).

## 10. Provenance and traceability

The chain `TakeoffLine → calculation → itemTotal → BOQ line` is fully traceable:

- Each line's `TraceNode` (engine §8) lives in the finalized Takeoff snapshot.
- Each itemTotal carries `lineIds` (its contributing lines) and exact/rounded values with
  the applied rule.
- Each transferred BOQ line carries `trace.takeoffDocument` (§8.1).
- Revision identity (`takeoffId`, `documentNumber`, `documentId`) and the engine
  `specVersion`/`engineVersion` are retained at every hop.

Nothing duplicates the whole document: the BOQ line carries identity + itemTotal-level
values; the full trace remains in the Takeoff snapshot.

## 11. Versioning, canonicalization and determinism

- `specVersion` = the engine contract version implemented by `calculateTakeoff`
  (CG-IR-MEAS@0.2.0); `engineVersion` = the engine build version — both stamped on every
  result, exactly like CG-RCS.
- Canonical serialization uses the repository's existing `canonicalJson`; identical
  canonical input yields a byte-identical canonical result and snapshot.
- Finalized snapshots are immutable and byte-compared on re-save; rendering always
  reloads the snapshot.
- Backward compatibility: D-015 surfaces are untouched (§14). Behavior changes to this
  product spec ship as version bumps with updated golden tests (D-003 doctrine).
- `calculateQuantities` (CG-RCS@0.1.0) stays frozen; `calculateTakeoff` never mutates it.

## 12. Error contract

Engine error codes are never public API codes (the D-015/D5-A doctrine: engine codes such
as `UNIT_MISMATCH`/`INVALID_DECIMAL` collide with existing public codes). Public codes are
stable; engine detail appears only under `details.failures`, mirroring
`BOQ_LINES_REJECTED`/`TAKEOFF_QUANTITIES_REJECTED`.

| Category                              | Deterministic behavior                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| invalid input (decimals, counts)      | engine `INVALID_DECIMAL`/`NON_INTEGER_COUNT` → `422 TAKEOFF_SOLUTION_REJECTED` (details)                                                            |
| invalid dimensions / profile          | engine `DIMENSION_PROFILE_MISMATCH`/`NEGATIVE_INPUT` → `422 TAKEOFF_SOLUTION_REJECTED`                                                              |
| invalid floorCount / similarCount     | engine `NON_INTEGER_COUNT` (integers ≥ 1) → `422 TAKEOFF_SOLUTION_REJECTED`                                                                         |
| unresolved reference                  | engine `UNKNOWN_REFERENCE` → `422 TAKEOFF_SOLUTION_REJECTED`                                                                                        |
| circular reference                    | engine `CIRCULAR_REFERENCE` (cycle listed) → `422 TAKEOFF_SOLUTION_REJECTED`                                                                        |
| incompatible unit aggregation         | engine `AGGREGATION_UNIT_MISMATCH` (V13) → `422 TAKEOFF_SOLUTION_REJECTED`                                                                          |
| invalid expression (structural)       | unrepresentable at the API edge — closed Zod union → `400 INVALID_REQUEST`                                                                          |
| invalid rounding rule                 | engine `INVALID_ROUNDING_POLICY` → `422 TAKEOFF_SOLUTION_REJECTED`; authoring a non-`design` `sourceStatus` in V1 → `422 TAKEOFF_DOCUMENT_REJECTED` |
| negative result where forbidden       | engine `NEGATIVE_LINE_MAGNITUDE`/`NEGATIVE_NET_QUANTITY` → `422 TAKEOFF_SOLUTION_REJECTED`                                                          |
| persistence conflict (stale revision) | `409 PERSISTENCE_CONFLICT` (existing code and Persian UX)                                                                                           |
| mutation of a finalized document      | `409 TAKEOFF_DOCUMENT_IMMUTABLE`                                                                                                                    |
| invalid lifecycle transition          | `409 TAKEOFF_INVALID_TRANSITION`                                                                                                                    |
| BOQ transfer incompatibility          | `422 TAKEOFF_TRANSFER_REJECTED` (details: existing S2 codes or `ALREADY_TRANSFERRED`); finalized target → existing `409` family                     |
| missing resource                      | `404 NOT_FOUND`; malformed payload → `400 INVALID_REQUEST` (both existing)                                                                          |

## 13. Open items (explicitly NOT decided here)

- Iranian rounding practice (Q-1/Q-IR-5): no verified rule exists; none is assumed.
- Excel live formulas: pre-existing D-010 deferral, unchanged.
- Report visual layout: settled with the D-016 Phase 6 report (the standard V1
  template — no customization in V1); the content contract remains §9.
- `origin: "import"`/`"ai-accepted"` authoring pipelines: reserved; V1 authors `user` only.
- `drawingRef` / drawing management: outside D-016 (engine §9.1 mentions a future field;
  nothing is specified).
- Division/power/π in expressions: excluded (Q-IR-4); any addition is an engine-spec
  version bump under a separate decision.

## 14. D-015 compatibility (normative)

D-015 remains CLOSED. The following are unchanged by this specification and by any D-016
implementation:

- quantity-only BOQ line creation (payload shape, persisted line shape, byte-compatibility);
- the dimensional quick-entry path: stateless `POST /takeoff/quantities/preview`
  (still rejecting a `rounding` field) and the lines-endpoint `takeoff` factors with
  server-computed quantity;
- `trace.takeoff` provenance (D-015 shape) on quick-entry lines; manual lines' trace shape;
- S2/S3/S4 arithmetic, estimate versions, finalization and finalized snapshots;
- the frozen `calculateQuantities` (CG-RCS@0.1.0) and its 283-test contract;
- the D2-A deduction semantics (sign only from `kind`; never a signed quantity).

Full Takeoff is an additional workflow beside D-015, not a replacement: the quick-entry
dialog, its API behavior and its provenance remain exactly as shipped and audited.
