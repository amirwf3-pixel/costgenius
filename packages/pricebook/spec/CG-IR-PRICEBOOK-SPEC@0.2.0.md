# CG-IR-PRICEBOOK-SPEC@0.2.0: Pricebook Edition Lifecycle Specification

| Field      | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec ID    | `CG-IR-PB`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Version    | `0.2.0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Status     | **CONTRACT CLOSED — S1 IMPLEMENTED (2026-09-30), S2/S3 NOT STARTED.** P8-B decision gate 2026-09-29; D-PB-3 = B confirmed by the owner's finalization order. All five decisions are FINAL (§23): D-PB-1 = B, D-PB-2 = A, D-PB-3 = B, D-PB-4 = A, D-PB-5 = A. S1 (edition persistence + 1404 seed) is implemented: migration `0004_p8b_pricebook_editions`, the `pricebook_editions` registry (§18), the first-boot seed (§24), the `estimate_versions.edition_id` binding with backfill and insert-time stamping, the database-level immutability guards (§11) and their tests. NOT implemented: the lifecycle API routes #39–43 (§17, S2), edition-aware lookup/selection and the UI (§19, S3) — each requires its own owner execution order (the D-018/D-017 convention). |
| Supersedes | [`CG-IR-PRICEBOOK-SPEC@0.1.0`](CG-IR-PRICEBOOK-SPEC@0.1.0.md) — **lifecycle sections only**: the §3 edition model, the §5 pipeline, the §8 Item-Master lineage and the §9 consumption contract. 0.1.0 is preserved unchanged and remains the authoritative verified factual/source record of the official 1404 edition (its §0–§2, §3.1–§3.2, §4, §6, §7, §10–§12).                                                                                                                                                                                                                                                                                                                                                                                                         |
| Scope      | Official base-price pricebook editions (فهرست بهای واحد پایه), discipline ابنیه, proposed **V1.1** — the annually published unit-price lists. NOT market pricing (that is the separate `market-prices` concern, still deferred).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Related    | [`apps/api/spec/CG-GOV-SPEC@0.1.0.md`](../../../apps/api/spec/CG-GOV-SPEC@0.1.0.md) — P8-B reuses its S1–S4 foundations (authentication, the five-role lattice, the append-only audit writer, reviewer sign-off) and changes none of them; `DECISIONS.md` D-019.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 1. Status

This document is the contract closure of the P8-B decision gate (2026-09-29).
**S1 (edition persistence + 1404 seed) is implemented** — migration
`0004_p8b_pricebook_editions`, the edition registry, the seed, the version bindings and
the immutability guards (see the Status row). Everything else remains specification
only: each further stage (the lifecycle routes, the edition-aware selection, the UI)
requires its own owner execution order (the D-018/D-017 convention). The stage
statuses of the governance layer it builds on are S0..S4 COMPLETE.

All five decisions are final (owner orders, 2026-09-29 — see §23): D-PB-1 = B, D-PB-2 = A, **D-PB-3 = B** (confirmed by the owner's finalization order: version creation accepts an optional `editionId` — omitted means the current ACTIVE edition; supplied means ACTIVE or ARCHIVED; DRAFT is never selectable), D-PB-4 = A and D-PB-5 = A. The specification is **implementation-ready**; S1 is implemented (see the Status row), and every further stage requires a separate owner execution order.

## 2. Supersedes

This specification supersedes `CG-IR-PRICEBOOK-SPEC@0.1.0` **for the edition lifecycle
only**:

| 0.1.0 section                                                                                                                                                                                                               | Disposition under 0.2.0                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3 Edition (the `PriceBookEdition` model with statuses staging/validated/approved/published/withdrawn)                                                                                                                      | **Superseded** by §4–§9 (D-PB-2 = A: the three-state DRAFT/ACTIVE/ARCHIVED lifecycle). The 0.1.0 model was conceptual only — nothing implemented it.                                                                                                                                         |
| §5 Pipeline (source → staging → validation → approval → publish, per-step audit events)                                                                                                                                     | **Superseded** by §10: validation is atomic inside import; there is no separate approval workflow in P8-B (four-eyes survives as the activation guard, §16). The full extraction pipeline (INGEST/EXTRACT steps, AI-assisted staging) stays deferred.                                        |
| §8 Item-Master lineage                                                                                                                                                                                                      | **Deferred** (unchanged deferral, restated in §22). Cross-edition lineage and the PB-V9 diff remain warning-level import-report material at most.                                                                                                                                            |
| §9 Consumption contract                                                                                                                                                                                                     | **Refined** by §12–§13 (edition selection and takeoff-transfer semantics). The 0.1.0 error names `UNKNOWN_ITEM_CODE`, `ITEM_UNIT_MISMATCH` and `EDITION_NOT_PUBLISHED` keep their S2/S3 meaning; `EDITION_NOT_PUBLISHED` is realised as the 0-active-state error `EDITION_NOT_ACTIVE` (§20). |
| §0 source policy, §1 concept chain, §2 common types, §3.1–§3.2 verified identity/facts, §4 content concepts, §6 unit mapping, §7 validation rules, §10 open verifications, §11 verified rules register, §12 safety contract | **Remain authoritative, unchanged.** They are the verification record of the official 1404 source, not lifecycle machinery. The validation rules PB-V1..PB-V10 of 0.1.0 §7 are incorporated by reference as the import gate of §10.                                                          |

The synthetic fixture (`spec/fixtures/synthetic-edition.v0.1.0.json`) remains the test
fixture for pipeline/validation behaviour; it contains no real price-book data.

## 3. Purpose

CostGenius prices estimates against the official annually published base-price lists
(فهرست بهای واحد پایه رشته ابنیه). Today exactly one edition exists — 1404 — shipped as a
verified, hash-bound staged dataset loaded in memory by the API. P8-B establishes how the
system handles **multiple official editions over time**:

- import a new edition through a validated, audited, immutable pipeline;
- activate at most one edition per discipline as the default for new work;
- archive superseded editions without ever deleting them; and
- guarantee that finalized/approved estimates and takeoffs remain byte-identically
  reproducible no matter what later happens to the edition lifecycle (§14).

Everything else about the pricebook data layer is unchanged: the four data statuses, the
exact-code binding discipline, the unit-label mapping, the verified anchors and the
never-fabricate safety contract of 0.1.0 §12.

## 4. Edition identity

Five concepts, never conflated:

| Concept                    | Fields                                                                                                                                                                                            | Mutability                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Edition identity           | `editionId` (stable handle, e.g. `ir-1404-abniye`) and `contentHash` (§5)                                                                                                                         | assigned at import; immutable; never reused |
| Dataset content            | the validated staged-import payload (`edition` metadata + `rows`), stored as canonical `content` (§18 content-storage semantics)                                                                  | immutable from import onward                |
| Source/provenance          | `sourceFileHash` (sha256 of the official source file), source title/organization, notification number/date, per-row `sourceRef`, importer (`importedBy`/`importedAt`), the stored `import_report` | immutable                                   |
| Publication/effective date | `notificationNumber`/`notificationDate`/`effectiveFrom` as **printed metadata only** — recorded from the source, never an automation trigger (there is no scheduled activation in P8-B)           | immutable                                   |
| Status                     | `status` ∈ {DRAFT, ACTIVE, ARCHIVED} plus the lifecycle actor/timestamp columns (`activated_by`/`activated_at`, `archived_by`/`archived_at`)                                                      | the ONLY mutable fields (§11)               |

`editionId` is the stable handle and follows the existing convention of the shipped
edition (`ir-1404-abniye` = `ir-<year>-abniye`). A corrected reprint of the same year is a
**new edition** — `ir-<year>-abniye-err<N>` — linked to the one it supersedes via
`supersedes_edition_id` (0.1.0 §3: "a correction is a new edition"). The **year string**
(e.g. `1404`) is publication metadata and the human-facing label — it is NOT identity: two
editions of the same year must never be conflated, which is precisely why the existing
`estimate_versions.edition` (year label) is kept for display/bytes and a new additive
`edition_id` (§12) carries exact identity.

`sourceFileHash` is provenance, not edition identity: two editions may legitimately share
a source file, and one source file may be re-imported with corrected staging. Dataset
identity is the `contentHash` alone.

## 5. Content hash

- **Definition**: `contentHash` = SHA-256 over `canonicalJson({ edition, rows })` of the
  staged-import payload — the typed `StagedPricebookFile` content that
  `createPublishedDataset` consumes, in file order. Top-level annotations the typed shape
  does not carry (e.g. `notice`) are excluded: the hash covers exactly what a consumer can
  obtain from the stored `content`.
- **Computed once at import**, stored, and **recomputed at every load** from the stored
  `content`; a mismatch is a fatal deployment integrity error (`EDITION_CONTENT_HASH_MISMATCH`,
  §20) — the process must not serve data whose storage diverges from its identity.
- **Duplicate detection**: `contentHash` is UNIQUE across all editions and all statuses.
  Re-importing identical content is refused with `EDITION_ALREADY_EXISTS` (the correct
  action is to activate the existing edition — content-addressable semantics).
- An edition's content NEVER changes (§11); therefore its `contentHash` is stable for life
  and any content difference, however small, is by definition a new edition.

## 6. Provenance

- Per-row provenance is unchanged: every row carries its full `sourceRef`
  (sourceDocument, edition, printedPage, section, sourceFileHash) — the existing verified
  1404 discipline (0.1.0 §2/§3.1).
- Edition-level provenance: `sourceFileHash`, printed title/organization,
  `notificationNumber`/`notificationDate` (as printed, null when the source prints none),
  `importedBy`/`importedAt` (the authenticated importing user and the domain Instant),
  and the complete `import_report` produced by the import gate — all stored on the edition
  row, all immutable.
- **Custody of official source files stays outside the edition record** (D-PB-5 = A): no
  database blob column, no filesystem storage subsystem. The repository's `sources/`
  convention (and the root PDF for 1404) remains the operational reference; the edition
  row records the hash and printed metadata only. Licensing/redistribution questions
  (0.1.0 §10) are unaffected.
- The actor of every lifecycle audit event is the session-resolved user (the S3 rule);
  provenance fields are never client-narrated — they come from the staged file and the
  authenticated session only.

## 7. Lifecycle

Exactly three states (D-PB-2 = A). The 0.1.0 five-status pipeline (staging/validated/
approved/published/withdrawn) is superseded: validation is atomic inside import (the gate
refuses errors, so **every stored edition is valid by construction** — there is no
"validated" state to represent), approval is the activation guard (four-eyes, §16), and
"withdrawn" is ARCHIVED.

| State    | Who can create it                            | Who can transition it                        | Allowed operations                                                                                                                                                                                                                                 | Forbidden operations                                                                                                                                | Reversible?                                          |
| -------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| DRAFT    | data_steward/org_admin (import, §10)         | data_steward/org_admin (activate or archive) | be listed/read (viewer+); be activated; be archived (discard); its rows may be searched via `GET /pricebook/rows?editionId=` (presentation only)                                                                                                   | bind new estimate versions (not selectable for new work); be edited (content or metadata); be deleted; be the default for anything                  | yes — via DRAFT→ACTIVE or DRAFT→ARCHIVED             |
| ACTIVE   | — (only via DRAFT→ACTIVE or ARCHIVED→ACTIVE) | data_steward/org_admin (archive)             | everything DRAFT allows, plus: be the default edition for new estimate versions (when the request supplies no `editionId`), be the default search edition of `GET /pricebook/rows`, and be explicitly selected for a new version (§12, D-PB-3 = B) | be edited; be deleted; coexist with another ACTIVE edition of the same discipline (§9)                                                              | yes — ACTIVE→ARCHIVED (and back via ARCHIVED→ACTIVE) |
| ARCHIVED | — (via DRAFT→ARCHIVED or ACTIVE→ARCHIVED)    | data_steward/org_admin (re-activate)         | be listed/read; keep serving every existing version bound to it (line-add, finalize, render — §12/§14); be explicitly selected for a NEW estimate version (§12, D-PB-3 = B)                                                                        | be edited; be deleted; be the default for new work; receive takeoff transfers into versions bound to other editions (`EDITION_MISMATCH`, unchanged) | yes — ARCHIVED→ACTIVE (same immutable content)       |

No other states exist and no lifecycle operation is available to estimator/reviewer/viewer
(§15).

## 8. State transitions

| Transition                  | Legal? | Performed by             | Semantics and guards                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (import) → DRAFT            | yes    | data_steward / org_admin | the only entry point into the system; validation atomic inside it (§10); emits `pricebook_edition.imported` in the same transaction                                                                                                                                                                                                                                                                                                              |
| DRAFT → ACTIVE              | yes    | data_steward / org_admin | `POST …/:editionId/activate`; four-eyes: the activator must differ from the importer, else `403 EDITION_SELF_ACTIVATION_FORBIDDEN` (zero mutation, zero events); archives the currently ACTIVE edition of the discipline in the SAME transaction; emits `pricebook_edition.activated` (for the new one) and `pricebook_edition.archived` (for the superseded one) together; a race between two different activations has exactly one winner (§9) |
| ACTIVE → ARCHIVED           | yes    | data_steward / org_admin | `POST …/:editionId/archive`; permitted even when it is the ONLY active edition (D-PB-4 = A → the 0-active state, §9); emits `pricebook_edition.archived` in the same transaction                                                                                                                                                                                                                                                                 |
| DRAFT → ARCHIVED            | yes    | data_steward / org_admin | the discard path: retire a bad import without ever activating it. Soft (append-only posture — mirroring user deactivation and 0.1.0 §3 "withdrawing never deletes"); emits `pricebook_edition.archived` (`details.previousStatus: "DRAFT"`)                                                                                                                                                                                                      |
| ARCHIVED → ACTIVE           | yes    | data_steward / org_admin | re-activation of the same immutable content; four-eyes does NOT apply (the activator is not re-importing anything — the content was already imported and audited); same auto-archive and event semantics as DRAFT→ACTIVE                                                                                                                                                                                                                         |
| ACTIVE → DRAFT              | **NO** | —                        | content and metadata are immutable (§11); there is no edit path to "un-publish" into a draft — no route and no grant exist (the operation is unrepresentable, not merely forbidden)                                                                                                                                                                                                                                                              |
| any content/metadata change | **NO** | —                        | a change is a NEW edition (new `contentHash` → new row, `supersedes_edition_id` set); "edit draft metadata" is deliberately granted to NOBODY (§15) — wrong metadata means discard + re-import                                                                                                                                                                                                                                                   |
| delete any edition          | **NO** | —                        | no delete route, no database DELETE grant; editions are never removed because estimates referencing them must stay reproducible (0.1.0 §3, D-005)                                                                                                                                                                                                                                                                                                |

## 9. Active-edition invariant

- **Exactly 0 or 1 ACTIVE edition per discipline** (V1 discipline: ابنیه only). Multiple
  simultaneously active editions are forbidden — two actives would make "the default
  edition" ambiguous and are exactly what the smallest deterministic model excludes.
- **Database-enforced**: a partial unique index
  `ON pricebook_editions (discipline) WHERE status = 'ACTIVE'` (§18). Application code
  never relies on itself alone for the invariant; a race between two activations produces
  exactly one winner (200) and one loser (409, unique-violation mapped to
  `EDITION_ALREADY_ACTIVE`) with zero partial state — the same single-winner shape as the
  S4 `approved_by IS NULL` guard.
- **What ACTIVE means**: the edition used by DEFAULT when no explicit edition is selected
  — the default for a new estimate version's binding (§12), and the default edition
  searched by `GET /pricebook/rows` (§17). It does NOT mean "the edition used by existing
  work": every existing version keeps its own bound edition regardless of status (§12).
- **Activating a new edition automatically archives the previous ACTIVE edition of the
  discipline** in the same transaction (the transition table of §8). There is no
  "two actives during a handover window" state.
- **The 0-active state is legal and reachable** (D-PB-4 = A): archiving the only active
  edition is permitted; no artificial guard prevents it. In that state:
  - **no edition is automatically selected** — there is no fallback and no implicit choice; creating a new estimate version **without** `editionId` fails deterministically with `409 EDITION_NOT_ACTIVE` (zero mutation, zero events); `GET /pricebook/rows` without an explicit `editionId` fails with `409 EDITION_NOT_ACTIVE` (fail-closed — never a silently empty result); any other operation explicitly defined as "use the current ACTIVE edition" fails with `409 EDITION_NOT_ACTIVE` — the same deterministic failure, never invented behaviour; **explicitly selecting an ARCHIVED edition for a new version remains permitted** (D-PB-3 = B — the 0-active state only affects the default selection); existing drafts, finalized and approved work remain fully usable according to their existing contracts (their editions are bound per version, not per deployment state); the next activation restores normal operation. No additional behaviour is invented for this state.

## 10. Import/validation

- **Input artifact**: the staged-import JSON document — `formatVersion "1"`,
  `kind "staged-import"`, the edition metadata block and the rows array (the typed
  `StagedPricebookFile` shape). The extraction of rows from an official source file
  (0.1.0 §5 INGEST/EXTRACT, AI-assisted staging, D-008) stays **deferred**: P8-B imports
  already-extracted, already-human-verified staged content only.
- **Parser/validation boundary**: the existing `validateStagedImport` gate, unchanged —
  format/kind checks, edition-metadata structure, per-row schema (exact codes preserving
  leading zeros, canonical decimal prices, mapped unit labels, complete `sourceRef`), the
  PB-V1..PB-V10 rules of 0.1.0 §7, duplicate-code detection, verified-anchor pins, and the
  verified-subset completeness floor for `ir-1404-abniye` (which continues to apply ONLY
  to that edition id).
- **Deterministic normalization**: unchanged and already inside the gate (exact printed
  codes, `PRICE_DECIMAL_PATTERN`, printed-label→UnitCode mapping with its approval-gated
  discipline — unmapped labels block, they are never guessed).
- **Content hash**: computed at import per §5 and stored with the row.
- **Duplicate detection**: identical `contentHash` (any status) → `409 EDITION_ALREADY_EXISTS`,
  nothing stored, zero events.
- **Validation failure behaviour**: `422 PRICEBOOK_IMPORT_REJECTED` with the complete
  report in `details` (`failures`); **nothing is stored and zero audit events are written**
  (the house rule: a rejected/forbidden operation writes no events).
- **Atomicity**: the edition INSERT, its `contentHash`, and the `pricebook_edition.imported`
  event commit in ONE transaction (the S3 `deps.transact` + `appendAuditEvent`
  infrastructure); a failure leaves no edition row and no event.
- **Authorization**: data_steward (org_admin via the lattice) — §15. Anonymous → 401;
  every other role → 403 `FORBIDDEN` with `requiredRole: 'data_steward'`; both write zero
  events.
- **No external market pricing** enters through this gate — official base-price editions
  only (the `market-prices` scaffold stays untouched and deferred).

## 11. Immutability

- An edition is immutable **from the moment of import** — there is no mutable window, not
  even for DRAFT. Import is the single write of content and metadata; the lifecycle
  columns (`status`, `activated_by/at`, `archived_by/at`) are the only fields that ever
  change, and only through the two lifecycle commands (§8).
- **DRAFT is not mutable.** "Edit draft metadata" is granted to nobody (§15): the staged
  file is validated as a whole, and wrong metadata means discarding the draft
  (DRAFT→ARCHIVED) and re-importing a corrected file. This keeps one code path (import),
  one audit story, and content-addressable identity (§5).
- **Any content change is a new edition** (new `contentHash`, new row,
  `supersedes_edition_id` → the replaced one). There is no in-place correction, ever.
- **Database-level enforcement requirement**: the application role must not be able to update content/metadata/provenance columns or delete edition rows. The intended mechanism is column-limited grants — `SELECT` + `INSERT` + `UPDATE` of the lifecycle columns only, mirroring the `audit_events` REVOKE posture of S1 — so that immutability does not depend on application discipline alone. **Implementation gate**: the implementation MUST verify effective privileges using the actual application DB role. If table ownership bypasses the intended column-level restrictions, the implementation MUST use an equivalent enforceable mechanism (for example ownership separation or an equivalent database constraint/trigger strategy) before declaring the immutability requirement satisfied.

## 12. Estimate-version binding

The binding point is the **estimate version** — the existing architecture, unchanged in
kind: a version's edition is fixed at creation, every line of the version must carry the
same edition (`EDITION_MISMATCH` otherwise — "editions are never mixed"), and the binding
is irrevocable for the version's life. This is the narrowest correct point: not the
project (a project may legitimately span editions over time), not the estimate (a new
version is a new pricing decision), not the calculation run (prices freeze at line-add,
before any calculation).

Concretely, P8-B adds **one additive column**: `estimate_versions.edition_id` (nullable
text FK → `pricebook_editions.edition_id`). The existing `edition` text column keeps its
year-label semantics and bytes exactly as they are (ReportModel, UI and goldens untouched);
`edition_id` carries exact identity so a same-year erratum can never be conflated with the
original. The per-line `BoqLine.edition`/`sourceRef.edition` fields are likewise unchanged
(year-level); exact edition identity is version-level, and every line of a version
resolves against that version's edition dataset by construction (below), so the boq-layer
year check remains a sound second line of defence.

**How a version's edition is chosen at creation — D-PB-3 = B (final, owner order)**: `POST /estimates/:estimateId/versions` accepts an **optional `editionId`**. Resolution: - **A) `editionId` omitted** → bind the new version to the **unique ACTIVE edition** of the discipline (§9). - **B) `editionId` supplied** → the edition MUST exist (`404 EDITION_NOT_FOUND` otherwise) and have status **ACTIVE or ARCHIVED**. - **C) `DRAFT`** → reject with `409 EDITION_NOT_SELECTABLE` — DRAFT editions are never selectable for new work. - **D) zero ACTIVE editions with `editionId` omitted** → reject with `409 EDITION_NOT_ACTIVE` (§9; zero mutation, zero events). - **E) the selected edition is persisted on the estimate version (`edition_id`) and is immutable for the version's life** — the binding never changes afterwards. - **F) activating or archiving editions later does NOT mutate any version's bound edition** — every existing version keeps its `edition_id` and its dataset regardless of later lifecycle changes (§14). The chosen `editionId` is audited in `estimate_version.created` details (additive whitelisted field, §16). The professional driver is Iranian contract practice: an estimate or its revision prepared under an existing contract prices against the contract's edition even after a newer annual edition is active organization-wide. This is **V1.1** behavior: there is **no per-line edition selection** (a line's edition is its version's edition — `EDITION_MISMATCH` otherwise) and no project-level edition setting. **Binding and resolution rules (architecture-forced, unchanged):**

- Line-add (`POST /estimate-versions/:versionId/lines`) resolves against **the version's
  bound edition** (`edition_id`), never against "whatever is active now". A draft created
  under E1404 keeps accepting E1404 lines after E1405 becomes active — this is the
  draft-binding invariant; resolving against the active edition would make every added
  line fail `EDITION_MISMATCH` and freeze the draft mid-work.
- The add-line dialog's search (`GET /pricebook/rows`) takes an optional `editionId`
  parameter (default = ACTIVE) so the dialog searches the version's edition — suggested
  codes and prices must match what binding will accept (§17).
- Draft → finalized → approved behaviour is unchanged and edition-independent: finalize and approval never consult any dataset (the S4 snapshot discipline), so activation or archiving of any edition cannot change a finalized/approved version (§14).

**Tooling**: the existing pricebook/estimate tooling (import tooling, dataset loading, test harnesses — anything that resolves lines against a dataset) must preserve the same version-level binding: **no tool may silently substitute the currently ACTIVE edition for a version that is already bound to another edition.** Tooling that resolves prices for an existing version resolves against that version's `edition_id` dataset, exactly like the API.

## 13. Takeoff transfer semantics

- **A takeoff has no pricebook edition binding.** Takeoffs are quantity-only (quantities,
  measurement traces, engine stamps); their schema, calculation and finalized snapshot are
  **unchanged** by P8-B. Takeoff quantities are independent
  of the pricebook lifecycle.
- **Transfer prices against the TARGET VERSION's bound edition.** The transfer request
  stays `{versionId}` (strict, unchanged): the target is an existing DRAFT estimate
  version, and the edition used to resolve itemTotals into BOQ lines is **that version's immutable `edition_id` binding** — the edition persisted at version creation (D-PB-3 = B: either the explicitly selected edition or the then-ACTIVE default). Transfer therefore needs no edition parameter of its own, and **MUST NOT resolve against the currently ACTIVE edition**: doing so would price lines of an E1404-bound draft with E1405 and
  deterministically fail `EDITION_MISMATCH` — breaking the draft-binding invariant of §12.
- **No silent historical inference**: the edition used is always the target version's explicit, persisted, audited binding — never a guess from dates, project attributes or the deployment's active state. If a transferred item's pricing and the target version's bound edition differ, the existing `EDITION_MISMATCH` ("editions are never mixed") contract semantics apply unchanged.
- Rejection semantics are unchanged: any itemTotal that fails to bind (unknown code, unit
  mismatch, edition mismatch) rejects the whole transfer all-or-nothing
  (`TAKEOFF_TRANSFER_REJECTED` / `BOQ_LINES_REJECTED` failure families), zero mutation,
  one `takeoff_document.transferred_to_boq` event only on success (existing catalog
  behaviour).

## 14. Historical reproducibility (HARD invariant)

Activating, archiving or re-activating any edition **MUST NOT** alter:

- any finalized estimate snapshot (`s4_input`, `s4_result`, `rollup`, `report_model`);
- any approved estimate (the S4 sign-off columns and their semantics);
- any BOQ price (`boq_lines.base_price`/`line_amount` — frozen at line-add);
- any calculation result, rollup or ReportModel;
- any rendered PDF or Excel bytes (rendering reads the frozen ReportModel; it never
  recalculates and never consults an edition);
- any audit history.

Why this holds structurally (and must keep holding): prices freeze into `BoqLine`s at
line-add time (`basePrice`, `lineAmount`, `sourceRef`, `edition`); finalized estimates are
self-contained replay records; rendering is snapshot-driven; editions are never deleted
(§8), so an old version's edition remains loadable and identifiable forever via its
immutable row and the additive `edition_id`. P8-B adds no re-resolution path anywhere. In particular — and as an **explicit contract requirement of this specification, not merely an implementation detail** — a newer ACTIVE edition must not change the pricing basis of any existing draft or version that is already bound to an older edition.

The existing golden total **`69011321.1668`** is unchanged by P8-B and its implementation
must prove it (§21). Implementation must also prove byte-identity across an activation:
finalize (and approve) under E1404, import+activate a second (synthetic) edition, then
re-render and byte-compare everything listed above.

## 15. RBAC

The existing five roles and the CG-GOV §2 lattice, unchanged; no sixth role. P8-B grants
`data_steward` its first capabilities — the role CG-GOV §2.1 reserved for exactly this
pipeline — via `requiredRole: 'data_steward'` (yielding precisely {data_steward, org_admin},
the same mechanism S2 used for the reviewer approve routes).

| Operation                       |                                          org_admin                                           | estimator | reviewer | viewer |        data_steward         |
| ------------------------------- | :------------------------------------------------------------------------------------------: | :-------: | :------: | :----: | :-------------------------: |
| View editions (list/get/report) |                                              ✅                                              |    ✅     |    ✅    |   ✅   |             ✅              |
| Create/import draft             |                                              ✅                                              |    ❌     |    ❌    |   ❌   |             ✅              |
| Edit draft metadata             |                                              ❌                                              |    ❌     |    ❌    |   ❌   | ❌ (no route exists — §11)  |
| Validate draft                  |  n/a — validation is atomic inside import (§10); the stored report is a viewer-readable GET  |           |          |        |                             |
| Activate edition                |                                              ✅                                              |    ❌     |    ❌    |   ❌   | ✅ (≠ importer — four-eyes) |
| Archive edition                 |                                              ✅                                              |    ❌     |    ❌    |   ❌   |             ✅              |
| Delete draft                    | ❌ — no delete operation exists; the discard path is DRAFT→ARCHIVED (data_steward/org_admin) |           |          |        |                             |

Justification from existing role semantics: PROJECT_SCOPE §4 assigns "price-book imports"
to Org Admin and "manage market-price sources and price-book editions" to Data Steward;
CG-GOV §2.1 reserves data_steward for the pricebook/market-price pipeline; viewer keeps
"all GET routes". Four-eyes on activation mirrors 0.1.0 §5 step 6 ("≥ 1 approver with
role Data Steward, distinct from the importer") and the S4
`SIGNOFF_SELF_APPROVAL_FORBIDDEN` pattern; it applies to DRAFT→ACTIVE only (re-activation
of audited content imports nothing — §8). Estimate/review workflows are untouched:
estimators and reviewers never see an edition-mutation surface.

## 16. Audit

Three new events join the catalog (20 → 23 at implementation); new resource type
`pricebook_edition`; `projectId` is **null** on all three (editions are not project-scoped);
each event commits in the SAME transaction as its mutation (the S3 infrastructure); denied
and failed operations write zero events. The catalog stays otherwise exactly as frozen in
S3 — no other event changes shape or payload.

| Event                         | Actor                         | Resource type / ID                | `details` (whitelisted, exact)                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pricebook_edition.imported`  | the importing user (session)  | `pricebook_edition` / `editionId` | `{contentHash, rowCount, warningCount}` (the seed of §24 adds `seeded: true`)                                                                                                                                                                                       |
| `pricebook_edition.activated` | the activating user (session) | `pricebook_edition` / `editionId` | `{contentHash, supersededEditionId}` — `supersededEditionId` is null when there was no previous active edition; the auto-archive of the superseded edition emits its own `pricebook_edition.archived` in the same transaction (the seed of §24 adds `seeded: true`) |
| `pricebook_edition.archived`  | the archiving user (session)  | `pricebook_edition` / `editionId` | `{contentHash, previousStatus}` — `previousStatus` ∈ {`DRAFT`, `ACTIVE`}                                                                                                                                                                                            |

Deliberately NOT in the catalog: `pricebook_edition.updated` (no update exists — §11),
`.validation_failed` (zero mutation ⇒ zero events), `.deleted` (no delete exists), and
0.1.0 §5's per-step staging events (they belong to the deferred extraction pipeline). No
`audit_events` table migration is needed for new actions (the catalog is type- and
test-enforced; the table has no action CHECK — verified against migration 0002).

Additionally (additive, not a new event): `estimate_version.created` details gain the
chosen `editionId` — the audited record of every version's edition binding (§12).

## 17. API contract

Command-oriented, POST-only mutations, no PATCH/PUT/DELETE — house style. Route numbers
continue the CG-GOV §3 matrix (#37/#38 were the S4 approve routes); the API surface grows
38 → 43. Every error keeps the stable `{error:{code, message, details?}}` shape.

| #   | Route                                          | Role         | Request → Response                                                                                                                                                                                                                                                                                                            | Errors / mutation semantics                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 39  | `GET /pricebook/editions`                      | viewer       | – → `{editions: […]}` — per edition: `editionId, discipline, year, title, organization, notificationNumber, notificationDate, sourceFileHash, contentHash, rowCount, status, supersedesEditionId, importedBy, importedAt, activatedAt?, archivedAt?`. Deterministic order: `(importedAt, editionId)`. Never returns row bulk. | –                                                                                                                                                                                                                                                                          |
| 40  | `GET /pricebook/editions/:editionId`           | viewer       | – → the edition detail **including the stored `importReport`** (the complete validation evidence). Rows stay searchable via #below.                                                                                                                                                                                           | `404 EDITION_NOT_FOUND`                                                                                                                                                                                                                                                    |
| 41  | `POST /pricebook/editions`                     | data_steward | body = the staged-import JSON document (formatVersion 1) → `201 {edition, importReport}`. Validates atomically, computes `contentHash`, inserts DRAFT, appends `pricebook_edition.imported` — one transaction.                                                                                                                | `422 PRICEBOOK_IMPORT_REJECTED` (`details.failures` — nothing stored, zero events); `409 EDITION_ALREADY_EXISTS` (identical `contentHash` — activate the existing edition instead). Idempotency: retrying the same body always yields the same 409 and never a second row. |
| 42  | `POST /pricebook/editions/:editionId/activate` | data_steward | empty body → `200` edition (now ACTIVE; the previous active edition of the discipline auto-archived in the same transaction; both events appended).                                                                                                                                                                           | `404 EDITION_NOT_FOUND`; `409 EDITION_ALREADY_ACTIVE` (also the unique-index race outcome — exactly one 200, zero partial state); `403 EDITION_SELF_ACTIVATION_FORBIDDEN` (activator = importer; zero mutation, zero events; does not apply to ARCHIVED→ACTIVE).           |
| 43  | `POST /pricebook/editions/:editionId/archive`  | data_steward | empty body → `200` edition (ARCHIVED).                                                                                                                                                                                                                                                                                        | `404 EDITION_NOT_FOUND`; `409 EDITION_ALREADY_ARCHIVED`. Archiving the only ACTIVE edition is legal (D-PB-4 = A → 0-active state, §9).                                                                                                                                     |

Existing routes, minimally extended (additive, backwards compatible):

- `GET /pricebook/rows` — optional `editionId` query parameter (default: the ACTIVE
  edition; `409 EDITION_NOT_ACTIVE` when none is active and no explicit edition is given —
  fail-closed, never an empty 200). The response's `edition` field continues to identify
  the searched edition. Rationale: the add-line dialog must search the version's edition
  (§12) so suggestions match what binding accepts.
- `POST /estimates/:estimateId/versions` — optional `editionId` field (D-PB-3 = B): omitted → the ACTIVE edition (`409 EDITION_NOT_ACTIVE` when there is none); supplied → ACTIVE or ARCHIVED (`409 EDITION_NOT_SELECTABLE` for DRAFT; `404 EDITION_NOT_FOUND` when unknown). The chosen edition is persisted as the version's immutable binding and audited (§12/§16).
- `POST /estimate-versions/:versionId/lines` and
  `POST /projects/:projectId/takeoffs/:documentId/transfer-to-boq` — request shapes
  unchanged; both resolve against the **target version's** edition dataset (§12/§13).

No other route changes. No delete route. No validate route (validation is the import gate;
its report is stored and readable via #40).

## 18. Database contract

**One new table** (12 → 13); migration `0004_p8b_pricebook_editions.sql` (migrations
0000–0003 byte-untouched, the standing rule):

```sql
CREATE TABLE pricebook_editions (
  edition_id            text PRIMARY KEY,              -- 'ir-1404-abniye', 'ir-1404-abniye-err1', …
  discipline            text NOT NULL,                 -- CHECK (discipline = 'abniye') in V1
  year                  text NOT NULL,                 -- Jalali year as published ('1404')
  title                 text NOT NULL,                 -- as printed
  organization          text NOT NULL,                 -- as printed
  notification_number   text,                          -- as printed; null when absent
  notification_date     text,                          -- Jalali, as printed; null when absent
  source_file_hash      text NOT NULL,                 -- provenance: sha256 of the official source file
  content_hash          text NOT NULL UNIQUE,          -- §5: immutable dataset identity
  content               jsonb NOT NULL,                -- canonical semantic content (see content-storage note)
  import_report         jsonb NOT NULL,                -- the ImportReport at import time
  status                text NOT NULL,                 -- CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED'))
  supersedes_edition_id text REFERENCES pricebook_editions(edition_id),
  imported_by           uuid NOT NULL REFERENCES users(user_id),
  imported_at           text NOT NULL,                 -- domain Instant, stored verbatim (house rule)
  activated_by          uuid REFERENCES users(user_id),
  activated_at          text,
  archived_by           uuid REFERENCES users(user_id),
  archived_at           text
);
-- the 0..1 invariant, enforced by PostgreSQL, not by application discipline:
CREATE UNIQUE INDEX pricebook_editions_one_active
  ON pricebook_editions (discipline) WHERE status = 'ACTIVE';
CREATE INDEX pricebook_editions_status_idx ON pricebook_editions (status);
```

- **Immutable fields**: everything except `status`, `activated_by`, `activated_at`, `archived_by`, `archived_at`. Intended enforcement for the application role: column-limited grants — `SELECT` + `INSERT` + `UPDATE (status, activated_by, activated_at, archived_by, archived_at)`; no `DELETE` (§11). The implementation MUST verify effective privileges with the actual application DB role and, if table ownership bypasses these column-level restrictions, MUST use an equivalent enforceable mechanism (ownership separation or an equivalent constraint/trigger strategy) before declaring the immutability requirement satisfied (§11).
- **Content-storage semantics**: the `content` JSONB column stores the **canonical semantic content** represented by the imported dataset (the validated staged-import payload), not the original raw bytes of any file. JSONB persistence preserves that canonical semantic content; byte-level fidelity of the original source artifact is represented by `sourceFileHash` (§6) and operational source custody (D-PB-5 = A). Dataset identity across time is `contentHash` (§5), recomputed from the stored canonical content at every load.
- **Existing tables**: exactly one additive change — `estimate_versions.edition_id`
  (nullable text FK → `pricebook_editions.edition_id`), backfilled for all existing rows to
  the seeded 1404 edition (§24). `estimate_versions.edition` (year label), `boq_lines`
  (including `edition`/`base_price`/`line_amount`/`source_ref`), and every finalized
  snapshot table are untouched — no byte of persisted application data changes.
- **Deletion restrictions**: none needed beyond the absent DELETE grant — there is no
  delete path, and historical references (`estimate_versions.edition_id`) stay valid
  forever because editions are never removed.
- **Runtime shape**: at boot the API loads every edition row, recomputes each
  `contentHash` from the stored content (fatal on mismatch, §5), publishes each through
  the existing `createPublishedDataset`, and keeps a registry keyed by `editionId`; the
  ACTIVE row is the default dataset. The database becomes the single source of truth for
  editions (D-PB-1 = B).

## 19. UI contract

Minimum V1.1 UI — one steward-facing surface, no admin console:

- **"Pricebook editions" page** (navigation visible to data_steward/org_admin): the edition
  list of route #39 — status badge, year/title, circular number/date, short `contentHash`,
  row count, imported/activated/archived by-at; an **import** action (file picker for the
  staged JSON; the import report renders inline — errors mean nothing was stored); and
  **activate** / **archive** actions with confirmation dialogs (activation states plainly
  that the previous active edition will be archived and that new versions will
  thereafter default to the new edition).
- **Add-line dialog**: searches the workspace version's edition (the `editionId` parameter
  of `GET /pricebook/rows`) — never a global search.
- **Version creation**: an optional edition selector — default: the ACTIVE edition; selectable: ACTIVE + ARCHIVED; not selectable: DRAFT (never offered). The bound edition is visible on the version workspace after creation (the edition label may render dynamically from the edition metadata — today's «فهرست‌بها ۱۴۰۴» label is hardcoded; cosmetic only).

No edition switcher on estimates, no draft editing UI, no row-level dataset browser, no
diff/lineage UI.

## 20. Error contract

Stable `{error:{code, message, details?}}` shape; existing status semantics (401
`UNAUTHENTICATED`, 403 `FORBIDDEN` + `details.requiredRole`, 404, 409 conflict, 422
domain rejection). New codes follow the existing SCREAMING_SNAKE naming:

| Code                                | HTTP | Meaning                                                                                                                                                                                                                                                   |
| ----------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRICEBOOK_IMPORT_REJECTED`         | 422  | the staged file failed the import gate; `details.failures` (the complete report); nothing stored, zero events                                                                                                                                             |
| `EDITION_ALREADY_EXISTS`            | 409  | an edition with the identical `contentHash` already exists (any status) — activate the existing edition instead                                                                                                                                           |
| `EDITION_NOT_FOUND`                 | 404  | unknown `editionId`                                                                                                                                                                                                                                       |
| `EDITION_ALREADY_ACTIVE`            | 409  | activate an already-ACTIVE edition (also the unique-index race outcome; exactly one winner)                                                                                                                                                               |
| `EDITION_ALREADY_ARCHIVED`          | 409  | archive an already-ARCHIVED edition                                                                                                                                                                                                                       |
| `EDITION_SELF_ACTIVATION_FORBIDDEN` | 403  | four-eyes: the importer cannot activate their own DRAFT import (mirrors `SIGNOFF_SELF_APPROVAL_FORBIDDEN`); zero mutation, zero events; not applicable to ARCHIVED→ACTIVE                                                                                 |
| `EDITION_NOT_ACTIVE`                | 409  | an operation that defaults to the active edition found **zero** active editions (new version with default selection; `GET /pricebook/rows` without explicit `editionId`) — the 0-active state of §9; realises 0.1.0's `EDITION_NOT_PUBLISHED` reservation |
| `EDITION_NOT_SELECTABLE`            | 409  | an explicit `editionId` names a DRAFT edition, which is never selectable for new work (D-PB-3 = B)                                                                                                                                                        |
| `EDITION_CONTENT_HASH_MISMATCH`     | –    | internal: recomputed hash of stored content ≠ stored `contentHash` at load; fatal startup integrity error, never an API response                                                                                                                          |
| `EDITION_MISMATCH`                  | 409  | existing boq-layer code, unchanged: a line belongs to a different edition than the version ("editions are never mixed")                                                                                                                                   |

Operations that do NOT get an error code because they are unrepresentable: editing edition
content/metadata (no route, no grant, no DB grant), ACTIVE→DRAFT, deleting an edition
(no route, no DB grant).

## 21. Test contract

The implementation must satisfy (names indicative; the established verification gate
applies — `pnpm check`, `pnpm -r build`, all package suites, E2E, production smoke,
real-PostgreSQL fresh + reused, golden regression):

- **Lifecycle**: import → DRAFT; activate → ACTIVE with previous active auto-archived
  (both events, one transaction); archive ACTIVE; archive DRAFT (discard); re-activate
  ARCHIVED; every illegal transition (activate ACTIVE, archive ARCHIVED, self-activation)
  → the exact code, zero mutation, zero events.
- **Uniqueness**: duplicate `contentHash` import → `EDITION_ALREADY_EXISTS`, single row;
  two simultaneous activations of different editions → exactly one 200 + one 409, one
  ACTIVE row, exactly one `activated` event (real-PostgreSQL race suite, fresh and reused
  databases) — the partial-unique-index proof.
- **Immutability**: no API path mutates content/metadata; DB-level probes (restricted
  role) fail on content-column UPDATE and on DELETE; ACTIVE/ARCHIVED edition rows
  byte-identical across every lifecycle operation.
- **Historical reproducibility (the core invariant)**: seed/activate E1404 → build the
  golden estimate → finalize (+ approve) → import + activate a synthetic second edition →
  the finalized bundle, `s4_result`, rollup, ReportModel, Excel and PDF bytes are
  **byte-identical**; approved state untouched; re-render identical; the old draft still
  accepts its own edition's lines; a new version binds the new edition.
- **Binding and transfer**: the version-creation selection matrix (omitted → the ACTIVE edition; explicit ACTIVE/ARCHIVED → bound; DRAFT → `EDITION_NOT_SELECTABLE`; unknown → 404; omitted with 0 active → `EDITION_NOT_ACTIVE`); line-add resolves against the version's edition (not the active one) — proven by adding a line to an E1404-bound draft while E1405 is active; takeoff transfer into that draft succeeds with E1404 prices; transfer request shape unchanged; `EDITION_MISMATCH` unchanged.
- **Security**: all five roles × each new route (matrix, incl. anonymous 401 and
  estimator/reviewer/viewer 403 with `requiredRole: 'data_steward'`); four-eyes actor
  correctness; audit actor session-derived; no credential material in events.
- **Regression**: golden total `69011321.1668` unchanged; every S1–S4 suite stays green
  (counts may grow only additively); the 193 pricebook package tests unchanged; the seed
  `contentHash` equals the canonical hash of the in-repo 1404 staged file; 12 → 13 tables
  exactly; migrations 0000–0003 byte-untouched.
- **PostgreSQL**: fresh disposable DB (migrations from zero incl. 0004 + idempotent seed)
  and reused disposable DB (no 42P07, no order dependency, seed and setup idempotent).

## 22. Deferred scope

Explicitly outside P8-B (not silently absorbed): market pricing, live supplier prices and
automated market-price ingestion (`market-prices` stays a boundary-only scaffold); the
source-file extraction pipeline (0.1.0 §5 INGEST/EXTRACT — PDF parsing, OCR, drawing/CAD,
AI-assisted staging per D-008); the machine Item-Master lineage and cross-edition diff of
0.1.0 §8 (PB-V9 stays at most a warning in the import report); machine-applicable
coefficient definitions (0.1.0 §4 — the S4 coefficient inputs remain the verified
hardwired mechanics of D-004); D-006 manual overrides (a future layer OVER editions,
never an edition mutation); contract-specific negotiated rates; live Excel formulas;
customizable report templates; `effectiveFrom` scheduled activation; additional
disciplines; organizations/multitenancy, RLS, OAuth/MFA (unchanged deferrals); an audit
read API/UI (unchanged posture); a delete/purge path for editions (never — append-only).

## 23. Decision register

| Decision | Resolution                                                                                                                                                                                                                                                                                                                                                                               | Rationale (repository-grounded)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Consequence                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-PB-1   | **= B** (owner order 2026-09-29): the shipped 1404 edition enters through the SAME edition pipeline — a first-boot idempotent seed imports the verified staged file into `pricebook_editions` and establishes it ACTIVE (§24).                                                                                                                                                           | One source of truth, one lifecycle model, one invariant, one provenance and audit model; no permanent special case for 1404. No concrete blocker found — the file already passes the gate unchanged and its content is frozen.                                                                                                                                                                                                                                                                                                                                   | Boot order gains a seed step; `DATASET_PATH` becomes the seed artifact path; the golden must remain exactly `69011321.1668` (test-pinned); the DB becomes the runtime source of editions.                       |
| D-PB-2   | **= A** (owner order 2026-09-29): three states — DRAFT / ACTIVE / ARCHIVED; validation atomic in import; no separate approval workflow; the 0.1.0 five-status pipeline is superseded for lifecycle purposes (0.1.0 preserved, marked superseded).                                                                                                                                        | The smallest model that preserves determinism: the import gate already refuses errors (so "validated" is implicit in existence), four-eyes survives as the activation guard, and "withdrawn" is ARCHIVED.                                                                                                                                                                                                                                                                                                                                                        | Simpler states/routes/events/UI; the extraction-era per-step pipeline remains deferred with the extraction pipeline itself.                                                                                     |
| D-PB-3   | **= B (final — owner order 2026-09-29)**: version creation accepts an optional `editionId`; omitted → the current ACTIVE edition; supplied → ACTIVE or ARCHIVED; DRAFT rejected (`EDITION_NOT_SELECTABLE`); the version binding is immutable; line-add and takeoff transfer use the target version's bound edition; no silent edition switching; no per-line selection (V1.1) (§12/§13). | Repository facts: binding is version-level and irrevocable (`EDITION_MISMATCH`); transfer targets an existing `versionId` (no edition dimension of its own); editions are immutable and always loadable — so B is architecturally native. Professional driver: Iranian contract estimates and their revisions must price under the contract's edition after newer editions activate; under A a revision silently switches basis and an org must keep an old edition ACTIVE to continue contract work. Recommendation B was confirmed by the owner on 2026-09-29. | Additive API field + UI selector + one new error case (`EDITION_NOT_SELECTABLE`); pricing-basis consistency is explicit; the 0-active state affects only the default (explicit ARCHIVED selection still works). |
| D-PB-4   | **= A** (owner order 2026-09-29): archiving the only ACTIVE edition is permitted; the system may temporarily have 0 ACTIVE editions; new-version default and default edition search then fail deterministically (`EDITION_NOT_ACTIVE`); historical/frozen work stays intact; the next activation restores normal operation.                                                              | No artificial guard: the 0-active state is reachable anyway (activate-new-then-archive-old), deterministic failure is the house style, and a guard would protect nothing.                                                                                                                                                                                                                                                                                                                                                                                        | One fewer special case; `EDITION_NOT_ACTIVE` and its fail-closed behaviours (§9) become part of the contract.                                                                                                   |
| D-PB-5   | **= A** (owner order 2026-09-29): store hash + metadata + provenance only; NO blob column, NO filesystem storage subsystem; official source artifacts stay operationally managed outside the edition record (the repo `sources/` convention remains the reference).                                                                                                                      | Provenance needs the hash and printed metadata, not the bytes; a blob/filesystem subsystem is new stateful surface with licensing implications (0.1.0 §10) and no consumer inside CostGenius.                                                                                                                                                                                                                                                                                                                                                                    | The edition row stays small and self-verifying (§5); custody/licensing stays an operational concern outside the schema.                                                                                         |

## 24. Compatibility and migration notes for the existing 1404 edition

- **Seed (D-PB-1 = B)**: on first boot after migration 0004, if no row with
  `edition_id = 'ir-1404-abniye'` exists, the API imports the in-repo verified staged file
  (`packages/pricebook/data/verified-1404.staged.v0.1.0.json`, via `DATASET_PATH`) through
  the normal import gate, computes its `contentHash`, inserts it **directly as ACTIVE**
  (it is the edition in production use; the DRAFT step is not performed for the seed), and
  appends `pricebook_edition.imported` and `pricebook_edition.activated` — both with actor
  = the bootstrap admin and `details.seeded = true` — after `ensureBootstrapAdmin`. The
  seed is idempotent: subsequent boots are no-ops and never re-activate an edition the
  operator archived. A staged file that fails the gate at seed time is a boot-fatal error
  (a corrupted verified dataset must never be served).
- **Seed ordering (binding at implementation)**: (1) the verified 1404 staged dataset is the seed input; (2) the seed MUST pass through the same validation/import gate as any future edition; (3) the seed MUST be idempotent; (4) it MUST establish exactly ONE ACTIVE 1404 edition; (5) its `contentHash` MUST be test-pinned to the repository's verified staged dataset; (6) repeated startup/deployment MUST NOT create duplicate editions; (7) the backfill of historical `estimate_versions.edition_id` runs only AFTER the corresponding seeded 1404 edition exists; (8) the `edition_id` FK therefore never temporarily references a non-existent edition; (9) seed behaviour MUST be deterministic and transactional.
- **Hash pinning**: the seed's `contentHash` must equal the canonical hash of the in-repo
  file — pinned by test (§21). The 1404 values, the 1564-row count, the
  `sourceFileHash` `c49e315548152da03d54394ca46b558592817de1ad24b29392d84311216fae0f` and
  the 193-test integrity suite are untouched.
- **Backfill**: existing `estimate_versions` rows gain `edition_id` =
  `ir-1404-abniye` (all existing work is 1404 by construction). The `edition` year-label
  column, `boq_lines`, all finalized snapshot tables and every rendered byte are unchanged
  — the golden total `69011321.1668` and every S1–S4 suite must stay green.
- **Schema accounting**: 12 → 13 tables; migration `0004_p8b_pricebook_editions`;
  migrations 0000–0003 byte-untouched (the standing rule); the applications role's grants
  follow §18.
- **Configuration**: `DATASET_PATH` changes meaning from "the runtime dataset" to "the
  first-boot seed artifact"; once seeded, the database is the source of truth and changing
  `DATASET_PATH` has no effect (documented in DEPLOYMENT at implementation).
- **Sources convention**: the official PDF (repository root; the owner's `sources/`
  upload on `main` carries the identical bytes) remains the provenance reference; the
  edition row records its hash (D-PB-5 = A).
