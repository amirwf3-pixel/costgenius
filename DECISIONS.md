# Architecture Decision Log

Format: ID · Decision · Rationale · Consequences. Status is "Accepted" unless noted.

Entries whose shipped state differs from or completes the original decision carry a
**Current status** annotation (added 2026-09, after the production release audit).
The original text is preserved unchanged as history — annotations only make the
present state explicit. Repository truth (ARCHITECTURE.md) is the authority.

## D-001 · TypeScript end-to-end monorepo (pnpm + Turborepo)

- **Why**: shared types/validation between engine, API, UI and exports; one toolchain; strong hiring pool.
- **Consequences**: numeric correctness must be enforced by a decimal library (D-002), since JS numbers are floats. Python rejected mainly for split-language type sharing with the UI.

## D-002 · Decimal arithmetic everywhere; no floats for money or quantities

- **Why**: auditability and exact reproduction of manual/Excel calculations.
- **How**: `decimal.js` wrapped in `Money`/`Qty` value types; Postgres `numeric`; lint rule forbidding raw arithmetic on these types; explicit rounding policy per estimate.

## D-003 · Calculation engine is a pure, versioned library

- **Why**: determinism, testability, reproducibility of locked versions.
- **Consequences**: all data resolved before calling the engine; `engineVersion` persisted; behavior changes ship as new versions with golden-test updates.

> **Current status — implemented (engines); versions persisted on the takeoff branch.**
> The pure engines exist: `calc-engine` (the frozen `calculateQuantities`, CG-RCS@0.1.0
> rules R1–R9, wired into the estimate lines endpoint by D-015; and `calculateTakeoff`,
> CG-IR-MEAS@0.2.0, implemented by D-016 Phase 1) and `cost-calculation` (S2 binding,
> S3 pricing, S4 estimate). The two S1 engines stamp `specVersion`/`engineVersion` on
> every result. The D-016 takeoff branch persists these versions with the finalized
> snapshot (`finalized_takeoffs.spec_version`/`engine_version`, mirrored inside the
> result and in the BOQ transfer provenance `trace.takeoffDocument`). The estimate
> branch keeps snapshot-based reproducibility (D-005): finalized estimate versions
> store the full canonical input/result JSONB and re-render from it; the estimate
> tables carry no separate engineVersion column of their own.

## D-004 · Coefficients and price-book rules are data, not code

- **Why**: rules change per edition/year; hard-coding risks silently wrong or fabricated regulations.
- **Consequences**: each edition's coefficient definitions are transcribed from official documents, expert-verified, and stored with source references. The engine implements only generic rule mechanics.

> **Current status — partially implemented.** The shipped 1404 rules exist as verified
> mechanics in `cost-calculation` (floor, overhead, site-setup), each citing its
> printed source; regional-coefficient VALUES remain external data (circular 94/69416
> annex) and are never substituted. A per-edition coefficient-definition data store
> does not exist yet — the current system serves a single hardwired edition.

## D-005 · Immutable, versioned reference data; locked estimate snapshots

- **Why**: an estimate submitted in one year must re-render identically later.
- **How**: editions and market snapshots immutable after publish; locked version stores canonical input/result JSON + SHA-256.

> **Current status — implemented for the shipped scope.** Finalized estimate versions
> store canonical JSONB snapshots (`s4_input`, `s4_result`, `rollup`, `report_model`)
> that are immutable and byte-compared on re-save, and rendering always reloads the
> snapshot (never recalculates). The pricebook edition is an immutable, hash-bound
> dataset file (D-013). Market-price snapshots do not exist (`market-prices` is a
> scaffold).

## D-006 · Manual overrides are layers, never edits

- **Why**: original source values must remain visible for review.
- **How**: `PriceOverride` records with mandatory reason; reports include an overrides appendix.

> **Current status — not implemented.** The shipped system has no override mechanism
> at all: line payloads are strict-schema and reject client prices outright — prices
> come only from the verified pricebook. Remains future direction.

## D-007 · Append-only audit log in the same transaction

- **Why**: full auditability; no audit gaps from async failures.
- **Consequences**: write amplification acceptable; DB privileges prevent UPDATE/DELETE on audit tables.

> **Current status — not implemented.** `audit` is a scaffold package; no audit-event
> writer or DB privilege scheme exists.

## D-008 · AI is advisory and sandboxed

- **Why**: AI must never invent quantities, prices, regulations or BOQ items.
- **How**: AI output → `Proposal` staging; item references validated against existing editions; human acceptance required; provenance recorded; no AI write path to prices/editions; provider-agnostic with self-hosted option; app fully functional with AI disabled.

> **Current status — not implemented.** `ai-assist` is a scaffold package; no AI path
> exists anywhere in the product (the "fully functional without it" property holds
> trivially).

## D-009 · PostgreSQL as the single stateful store (+ S3-compatible storage)

- **Why**: relational integrity, `numeric`, RLS, JSONB for traces, pg-boss queue — minimal infrastructure for on-prem Iranian deployments.
- **Rejected**: separate queue/broker, NoSQL primary store.

> **Current status — partially implemented.** PostgreSQL is the single stateful store
> (exact `numeric` columns, JSONB snapshots, one versioned migration). RLS, the
> pg-boss queue and S3-compatible object storage are **not** implemented (no
> multi-tenancy, no worker, no object storage).

## D-010 · Two-stage reporting: ReportModel → renderers

- **Why**: Excel and PDF must show identical numbers from one source.
- **How**: ExcelJS with real formulas and verification tests that recompute formulas vs engine totals; PDF via HTML + headless Chromium for reliable Persian RTL shaping and font embedding.
- **Rejected**: low-level PDF libraries (weak Arabic-script shaping), value-only Excel exports (not editable).

> **Current status — implemented; the rendering mechanisms evolved from this sketch.**
> One immutable `ReportModel` (built by `reporting`) feeds both renderers, and both
> are byte-deterministic. The shipped mechanisms differ from the original "How":
> Excel renders exact static text values (no live formulas yet — deferred), and the
> PDF is rendered by pdfkit + bidi-js with embedded Vazirmatn — the Arabic-shaping
> concern was solved without headless Chromium. The original text is kept as the
> historical rationale.

## D-011 · Deployable without foreign SaaS dependencies

- **Why**: sanctions, connectivity, and data-residency realities for Iranian companies.
- **Consequences**: Docker Compose deployment; self-hosted fonts, auth, storage; npm mirror/offline build considered in CI.

> **Current status — partially implemented.** All dependencies resolve from the npm
> registry only — even the E2E browser (Chromium via `@sparticuz/chromium`) and the
> smoke-test PostgreSQL binaries come from npm packages, proven in a
> network-restricted environment. Fonts are self-hosted (bundled Vazirmatn). Docker
> Compose is **not** provided (no daemon in the build environment; documented as a
> limitation in DEPLOYMENT.md); there is no auth or object storage to self-host yet.

## D-012 · Fa-IR/RTL-first, UTC storage, Jalali display

- **Why**: correct time math and audit ordering; native user experience.
- **Consequences**: dedicated `i18n` package for Jalali dates, Persian digits, Rial/Toman formatting (Toman display only).

> **Current status — partially implemented.** The UI and PDF are RTL-first Persian;
> instants are stored and transported as UTC ISO strings and render via
> `Intl.DateTimeFormat('fa-IR')`. Jalali calendar conversion, Persian-digit report
> formatting and the dedicated `i18n` package are **not** implemented (`i18n` is a
> scaffold).

## D-013 · No bundled price data without traceable source

- **Why**: legal/licensing uncertainty and correctness. Repository and fixtures contain only synthetic or licensed data.

> **Current status — implemented, strengthened by the official source.** The
> repository bundles the **official 1404 price book**: the source PDF (at the repo
> root) and the verified staged dataset, bound to the source file by SHA-256
> (`sourceFileHash`) with full provenance and 193 integrity tests. The official
> circular is the traceable source; no synthetic or invented price data exists
> anywhere in the repository.

## D-014 · UI deferred until engine, data and exports are proven (Proposed)

- **Why**: correctness of numbers and exports is the product's core value; UI built on a stable API contract.

> **Current status — superseded (the deferral ran its course).** The engine, dataset
> and Excel/PDF exports were proven first, and the production React UI (`apps/web`,
> Phase 18) then shipped on the stabilized API contract — exactly the sequencing this
> decision called for. The UI is a pure HTTP consumer of the API with no duplicated
> calculation.

## D-015 · Dimensional quantities through the frozen S1 engine, exact-only, with line-level provenance (Accepted)

- **Date**: 2026-09-27 · **Status**: Accepted (owner execution order D1:A D2:A D3:A D4:A D5:A D6:B)
- **What**: the frozen `@costgenius/calc-engine` (`calculateQuantities`, CG-RCS@0.1.0)
  computes dimensional line quantities for S1 units only (`m`, `m2`, `m3`, `each`;
  profiles m: count×L, m2: count×L×W, m3: count×L×W×H, each: count). One dimensional
  item becomes exactly one BOQ line; no aggregation of multiple dimensional entries into
  one line.
- **Wiring (minimal boundary)**: `packages/projects/src/takeoff-quantities.ts` is a pure
  adapter (shape mapping + provenance collection; no arithmetic, no rounding, no unit
  conversion, no validation of its own). The quantity a line carries IS the engine's own
  canonical output, verbatim — never reformatted. `boq` owns the persisted provenance
  type (`TakeoffProvenance`), imported type-only from the engine's frozen types.
- **Exact-only (D3-A)**: no `RoundingPolicy` is ever constructed anywhere; the preview
  API **rejects** a `rounding` field outright (strict schema).
- **Provenance (D4-A)**: `boq_lines.trace.takeoff = { input, output, specVersion,
engineVersion }` through the existing JSONB `trace` path — no DDL, no new table, no
  Takeoff resource/lifecycle. `createBoqLine` guards that the line's quantity equals
  `takeoff.output.qty` (existing `LINE_MISMATCH`), so a caller can never assert a
  computed quantity or provenance it did not receive from the engine. Manual lines keep
  the exact pre-D-015 trace shape (byte-compatible).
- **Deductions (D2-A)**: engine-canonical — the sign comes only from
  `kind: "deduction"` with non-negative factors and item net ≥ 0; a signed quantity is
  never a deduction mechanism. Owner-approved re-baseline: the former
  `-10 × -1037000 = 10370000` regression (two negatives make a positive amount) is now
  an explicit `NEGATIVE_QUANTITY` rejection at the application boundary. No
  signed-quantity↔deduction conversion was invented. The UI mirrors this: negative
  manual quantities are rejected client-side with a کسر بها explanation, and dimensional
  factors are non-negative by pattern.
- **API (D5-A)**: `POST /takeoff/quantities/preview` — stateless (no estimate context, no
  persistence), strict Zod, decimals as exact strings. Engine error codes are NEVER
  public (`UNIT_MISMATCH`/`INVALID_DECIMAL` collide with existing public codes): every
  engine failure is one stable public code, `TAKEOFF_QUANTITIES_REJECTED` (422), with
  the engine's own errors only under `details.failures` — mirroring the
  `BOQ_LINES_REJECTED` contract. The lines endpoint accepts exactly one of `quantity` |
  `takeoff` per line and the **server** computes dimensional quantities and attaches the
  provenance (a client-computed quantity or provenance is never trusted); quantity-only
  requests are unchanged.
- **UI (D6-B)**: dimensional entry lives inside the existing add-line dialog only —
  per-unit factor fields, non-negative patterns, integer count, a preview action showing
  the exact quantity plus concise provenance (engine versions), and a commit that sends
  only the factors. Unsupported units (kg, ton_km, …) stay manual. No sheets, drawing
  management, references/expressions or CoefficientForm changes.
- **Why**: ریز متره (dimensional measurement) is in project scope; wiring the already
  frozen, 283-test-proven S1 engine keeps a single quantity semantics while provenance
  on the line makes every persisted/finalized dimensional quantity replayable.
- **Golden parity guarantee**: the same estimate built manually vs dimensionally yields
  byte-identical `s4_result` and `rollup` (after identity normalization), and a
  `report_model` identical modulo the added `trace.takeoff` (report_model embeds
  BoqLine including its trace, so the dimensional report necessarily carries the extra
  provenance — asserted explicitly, never silently).

> **Current status — amended for the Full Takeoff workstream by D-016 (2026-09).** The
> quick-entry path this decision shipped (add-line dialog → lines-endpoint factors →
> frozen `calculateQuantities`, exact-only, line-level provenance) remains implemented
> and unchanged. D-016 supersedes D3-A/D4-A/D5-A/D6-B only for the new Full Takeoff
> workstream; D2-A and the frozen engine contract remain valid.

## D-016 · Full Takeoff as a first-class product capability (Accepted — IMPLEMENTED, Phases 0–6 complete)

- **Date**: 2026-09-27 · **Status**: Accepted — the nine scope decisions of the owner
  session (2026-09-27) are final. The phased implementation ran under separate owner
  execution orders and is complete through Phase 6 (2026-09): Phase 0
  specification/decision closure → Phase 1 engine → Phase 2 persistence/lifecycle →
  Phase 3 API → Phase 4 Takeoff → BOQ → Phase 5 UI → Phase 6 PDF/Excel reporting.
- **What**: build the complete Takeoff (متره) workflow of `CG-IR-MEASUREMENT-SPEC@0.1.0`
  into the product — Takeoff documents with sheets, document-unique lineIds, dimensional
  lines, line references, the restricted structured expression tree, separate
  `floorCount`/`similarCount` factors, item/sheet totals, topological resolution,
  explicit document-scoped rounding, deterministic canonicalization and full
  traceability. The measurement spec leaves specification-only status as the
  implementation contract of this workstream (its status line is updated in Phase 0).
- **Amends D-015 — only for the Full Takeoff workstream**: D3-A → an explicit document
  RoundingRuleSet is allowed (exact values stay authoritative and are always computed);
  D4-A → Takeoff becomes an independent persisted resource with its own lifecycle;
  D5-A → stateful Takeoff lifecycle routes are added beside the unchanged stateless
  preview; D6-B → a full Takeoff workspace (sheets, references, expressions,
  floorCount/similarCount) replaces the dialog ceiling for this workstream. The D-015
  quick-entry path remains implemented, exact-only, and its preview still rejects a
  `rounding` field.
- **Remains valid from D-015**: D2-A deduction semantics (sign only from `kind`, never
  a signed quantity); the frozen `calculateQuantities` (CG-RCS@0.1.0) —
  `calculateTakeoff` is a sibling contract beside it, never a rewrite; exact decimal
  strings on the wire; no unit conversion; server-authoritative computation;
  byte-compatible manual lines.
- **Closed scope decisions (owner session, 2026-09-27)**:
  - **G1 Persistence = A** — versioned relational mirror: `takeoff_documents`,
    `takeoff_sheets`, `takeoff_lines`, `finalized_takeoffs`; revisions traceable;
    finalized Takeoff immutable and snapshot-based (canonical byte-compare).
  - **G1b Deletion = C** — soft-delete/archive of drafts only; no hard-delete of Takeoff
    history; archived drafts stay recoverable/auditable per the eventual lifecycle
    contract.
  - **G2 BOQ transfer = B** — one BOQ line per itemCode/itemTotal; uncoded lines remain
    in Takeoff (never silently converted); provenance links each BOQ line to its
    contributing Takeoff lineIds; S2/S3/S4 arithmetic semantics unchanged.
  - **G4 Draft mutation = B** — editable drafts with optimistic concurrency: mutations
    carry `expectedRevision`; conflicts return deterministic `409 PERSISTENCE_CONFLICT`;
    no last-write-wins; finalized Takeoff stays immutable.
  - **G5 Expression UI = B** — structured builder plus a deterministic canonical
    human-readable formula display; no free-form parser and no text evaluation in V1;
    division/power/π stay excluded (Q-IR-4) unless a future spec version approves them.
  - **G6 Reporting = A** — one standard detailed Takeoff report (PDF + Excel) rendered
    from the finalized snapshot; no organization-customizable template system in V1.
  - **R1 Totals = A** — totals always accumulate EXACT line values; the applicable
    total rule then rounds once; rounded intermediates are never accumulation inputs.
  - **R2 BOQ quantity = C** — BOQ consumes the itemTotal (the G2 level): rounded iff an
    applicable rule targeted that itemTotal, otherwise exact; never re-rounded in
    S2/S3/S4.
  - **R3 Authored rules = A** — only document-authored `sourceStatus: "design"` rounding
    rules in V1; no organization-policy infrastructure; no invented Iranian rounding
    rules (Q-1/Q-IR-5 remain unresolved without an authoritative source).
- **Why**: ریز متره با برگه‌ها، ارجاع‌ها و عبارت‌ها قلب کار برآوردگر است (PROJECT_SCOPE §2)
  و مشخصات کامل آن از Phase 3 در مخزن موجود است.

> **Current status — implemented; D-016 Phases 0–6 complete (2026-09).** The Full
> Takeoff workstream is built and validated end-to-end: `calculateTakeoff`
> (CG-IR-MEAS@0.2.0, a pure sibling of the FROZEN `calculateQuantities`), takeoff
> persistence (migration `0001_d016_takeoff`, four tables, immutable byte-compared
> finalized snapshots), the draft/archive/finalized lifecycle with optimistic
> concurrency, follow-up revisions, the project-scoped Takeoff API, the Takeoff → BOQ
> transfer (G2=B, `trace.takeoffDocument` provenance), the Full Takeoff workspace UI,
> and standard Takeoff PDF/Excel reporting (G6=A) rendered from the finalized
> snapshot only. All nine scope decisions (G1=A, G1b=C, G2=B, G4=B, G5=B, G6=A,
> R1=A, R2=C, R3=A) are implemented as decided and unchanged. D-015 remains CLOSED
> and its quick-entry path untouched (the preview still rejects a `rounding` field;
> golden parity intact). Phase 7 — the D-017 contract follow-through (the project-scoped
> takeoff list, the stateless draft calculation preview, and the two env-gated
> PostgreSQL test repairs) — is COMPLETE under the owner's execution order
> (D-P7-1=A, D-P7-2=A, 2026-09-28).

## D-017 · V1 boundary and Phase 7 contract closure (Accepted — contracts ONLY, NOT implemented)

- **Date**: 2026-09-28 · **Status**: Accepted — the four owner decisions of the post-Phase-6
  decision gate (D-V1=A, D-LIST=B, D-PREVIEW=B, D-ERROR=C) are final. This is a
  **contract-closure** decision only: NO implementation, no schema/migration, no API
  route, no UI and no engine change has been made. The approved capabilities exist as
  contracts in `CG-FT-TAKEOFF-SPEC@0.2.0` (§15, §16) awaiting a separate execution order.
- **D-V1 = A — V1 is the current implemented slice**:
  - _Estimation_: Project, Estimate, BOQ, official 1404 ابنیه pricebook, S2 exact binding,
    S3 exact pricing, S4 calculation, immutable finalized estimate snapshot, PDF/Excel
    reporting.
  - _D-015_: frozen `calculateQuantities`, dimensional quick entry, exact quantity,
    line-level provenance, stateless dimensional preview.
  - _D-016 Phases 0–6_: `calculateTakeoff`, Takeoff persistence, draft/archive/finalized
    lifecycle, optimistic concurrency, immutable finalized Takeoff snapshot, Takeoff API,
    Takeoff → BOQ transfer, Full Takeoff UI, Takeoff PDF/Excel reporting.
  - _Explicitly deferred beyond V1_: live Excel formulas (D-010), reviewer sign-off
    workflow, full audit trail, authentication, RBAC, RLS, organizations, D-007 audit
    implementation, D-006 manual overrides, market pricing, AI (D-008), Docker artifact,
    load testing, drawing import/OCR, worker architecture, O-2/O-3/O-4. PROJECT_SCOPE
    §5.6/§6 carry status annotations recording this; the historical requirement text is
    preserved.
- **D-LIST = B — project-scoped Takeoff list** (contract: CG-FT@0.2.0 §15):
  `GET /projects/:projectId/takeoffs`; projection rows (`documentId`, `takeoffId`,
  `documentNumber`, `title`, `status`, `revision`, `createdAt`, `finalizedAt?`); all
  statuses listed; follow-ups as independent rows; deterministic `(takeoffId,
documentNumber)` ordering; no filtering/pagination in V1; project isolation mandatory;
  never calculates, mutates, exposes snapshot internals, does pricebook lookup or
  transfers. Persistence precedent: the existing `findByProjectId` contract. NOT
  implemented.
- **D-PREVIEW = B — stateless draft calculation preview** (contract: CG-FT@0.2.0 §16):
  `POST /projects/:projectId/takeoffs/:documentId/calculate`; draft-only (archived and
  finalized rejected with the existing lifecycle semantics); server reconstructs the
  canonical input and invokes the existing `calculateTakeoff`; returns the engine result
  verbatim (exact authoritative, explicit rounding, no document total); persists and
  mutates nothing; a preview result is NEVER transferable to BOQ (transfer requires a
  finalized snapshot). NOT implemented.
- **D-ERROR = C — two-layer error contract** (contract: CG-FT@0.2.0 §12): finalization
  keeps `422 TAKEOFF_CALCULATION_FAILED` exactly as implemented and shipped (engine codes
  in the message; atomic; nothing finalized; document stays an editable draft). The new
  stateless preview surface uses `422 TAKEOFF_SOLUTION_REJECTED` with structured
  `details.failures` (the `BOQ_LINES_REJECTED`/`TAKEOFF_QUANTITIES_REJECTED` pattern).
  The two codes are distinct contracts — never aliases, never interchangeable. The 0.1.0
  spec statements that wrongly described finalization with `TAKEOFF_SOLUTION_REJECTED`,
  and its "solve routes" architecture phrase, are corrected in 0.2.0; no implementation
  behavior changes.
- **Consequences**: CG-FT-TAKEOFF-SPEC version 0.1.0 → 0.2.0 (additive contract, MINOR
  bump per the CG-RCS §1 semver doctrine; 0.1.0 preserved as superseded history); the
  engine contract CG-IR-MEAS@0.2.0 is untouched; the API route count remains 26 until
  implementation actually ships; the UI keeps open-by-documentId and the draft UI keeps
  formula-display-only editing until then; D-015 remains CLOSED; D-016 Phases 0–6 remain
  COMPLETE; `calculateQuantities` remains FROZEN; the D-015 golden total remains
  69,011,321.1668.

> Phase 7 implementation is not authorized by this contract-closure task; only the
> contracts for the selected Phase 7 capabilities have been closed.

> **Current status — the §15/§16 contracts are implemented (Phase 7, 2026-09-28).**
> Under the owner's execution order (D-P7-1=A authorizing P7-S1 list + P7-S2 preview,
> D-P7-2=A authorizing the two env-gated test repairs), the list route
> (`GET /projects/:projectId/takeoffs`) and the stateless draft preview
> (`POST /projects/:projectId/takeoffs/:documentId/calculate`, the §12.2
> `TAKEOFF_SOLUTION_REJECTED` + `details.failures` contract) are implemented and
> validated end-to-end (unit, HTTP, browser E2E, production smoke); the two stale
> env-gated test files were repaired against the verified nine-table schema. The
> implementation follows the closed contracts with no deviation; the API route count is
> 28 and the D-015 golden total remains 69,011,321.1668.

## D-018 · Phase 8 (P8-A) Governance & Trust — contract closure (Accepted — S0+S1+S2 implemented; S3/S4 not started)

- **Date**: 2026-09-28 · **Status**: Accepted — the three owner decisions of the
  Phase-8 decision gate are final and authoritative. This is a **contract-closure**
  decision only (stage S0): NO implementation, no source, no migration, no route, no
  UI, no test for S1–S4 has been made. The contracts live in
  `apps/api/spec/CG-GOV-SPEC@0.1.0.md` awaiting a separate execution order.
- **D-P8-1 = A — the Phase-8 layer is Governance & Trust** (the Phase-8 decision-gate
  audit found the contract queue empty after Phase 7: every next step begins with an
  owner decision; governance is the declared prerequisite of the pricebook pipeline,
  D-006 overrides, AI acceptance and reviewer sign-off, and the only layer whose
  absence makes deployment to a professional office unsafe). Phase 8 = P8-A with
  stages **S0** contract closure (this entry) → **S1** authentication/session identity
  → **S2** minimal RBAC → **S3** actor-stamped append-only audit → **S4** minimal
  reviewer sign-off, each gated green before the next.
- **D-P8-2 = A — single organization, local accounts, username/password + server-side
  sessions.** scrypt (`node:crypto`, no new dependency) password storage; opaque
  session token (SHA-256-at-rest) in an HttpOnly/SameSite=Strict cookie; absolute
  12-hour expiration; uniform `401 AUTH_INVALID_CREDENTIALS` login failure (no
  enumeration); bootstrap initial org_admin via env vars, fail-closed on an empty
  users table. Organizations, membership, PostgreSQL RLS, OAuth/external IdP, MFA,
  password reset and email verification are **explicitly deferred**.
- **D-P8-3 = A — minimal reviewer sign-off on finalized versions/documents only**:
  a nullable approved/locked state (approved_by + approved_at on
  `finalized_estimates`/`finalized_takeoffs`), Reviewer/Org-Admin authorization, a
  four-eyes rule (the approver must differ from the user who finalized; legacy
  pre-V1.1 rows have no finalizing actor and may be approved by any Reviewer+),
  irreversibility in this phase, and audit events. NO comments, rejection workflow,
  review states, multi-reviewer workflow, review assignments or approval delegation.
  Sign-off never mutates the frozen snapshots and never changes rendered bytes.
- **P8-A boundary (V1/V1.1)**: D-V1 = A stands — the current V1 is unchanged. Phase 8
  is the proposed **V1.1** governance layer. Explicitly OUTSIDE Phase 8: pricebook
  pipeline, multi-edition pricebooks, market pricing, D-006 manual overrides, AI,
  drawing/OCR/CAD, صورت‌وضعیت/تعدیل, live Excel formulas, customizable templates,
  worker, Docker, load testing, offline/desktop, Iranian rounding (Q-1/Q-IR-5),
  division/power/π (Q-IR-4), additional disciplines.
- **Hygiene repairs riding with Phase 8** (not product features): (1)
  `apps/api/test/workflow.test.ts` — the env-gated real-server leg's stale five-table
  clean-slate drop fails with 42P07 on a used disposable DB (proven 2026-09-28);
  repair at S1 to drop all nine current tables children-before-parents (the P7-S3
  pattern), no assertion weakening. (2) `DEPLOYMENT.md` — the stale "exactly the five
  domain tables" smoke description corrected to the nine-table truth (done at S0).
- **Consequences**: the API route count stays **28** until implementation (CG-GOV §3
  plans 38: +`/auth/login`, `/auth/logout`, `/auth/session`, `/auth/password`,
  `/users`, `GET /users`, `/users/:userId/role`, `/users/:userId/deactivate`, and the
  two `/approve` routes); DB tables stay **9** until implementation (CG-GOV §7 plans
  12: `users`, `sessions`, `audit_events` plus sign-off columns on the two finalized
  tables — no organizations/RLS/permissions tables); new public error codes reserved
  (`UNAUTHENTICATED`, `AUTH_INVALID_CREDENTIALS`, `FORBIDDEN`,
  `SIGNOFF_SELF_APPROVAL_FORBIDDEN`, `USERNAME_ALREADY_TAKEN`,
  `CANNOT_DEACTIVATE_LAST_ORG_ADMIN`, `SIGNOFF_ALREADY_GIVEN`, `USER_NOT_FOUND`)
  without altering any existing code, including the D-ERROR=C two-layer takeoff
  contract; `CG-RCS@0.1.0`, `CG-IR-MEAS@0.2.0`, `CG-FT-TAKEOFF@0.2.0` and the
  D-015/D-016/D-017 behavior are preserved; the pure engines never see actors, roles
  or sessions (CG-GOV §6); V1.1 is a breaking deployment change (authenticated API +
  bootstrap env vars), recorded here deliberately.
- **Why**: PROJECT_SCOPE §1/§4 define a multi-actor product and §6 makes reviewer
  sign-off + audit trail the v1 success criterion — exactly the clause D-V1 deferred
  ("single-user V1"); the API currently binds 0.0.0.0 with no authentication.

> **Current status — S0 contract closure COMPLETE; S1 authentication COMPLETE
> (2026-09-28, under the owner's S1 execution order); S2 RBAC enforcement COMPLETE
> (2026-09-28, under the owner's S2 execution order); S3/S4 NOT STARTED.**
> S1 delivered exactly the §1 contract: the `0002_p8_governance` migration (9→12
> tables; `users`/`sessions`/`audit_events`), the scrypt password records
> (`scrypt$16384$8$1$salt$hash`, constant-time verify), 256-bit session tokens stored
> only as SHA-256, the `cg_session` HttpOnly/SameSite=Strict/Secure cookie with 12-hour
> absolute expiry, login/logout/session/password-change (password change revokes every
> other session; logout and deactivation delete session rows), the fail-closed
> bootstrap admin (`CG_BOOTSTRAP_ADMIN_*` — one org_admin on an empty users table, or
> non-zero exit; ignored once any user exists), the uniform `401
AUTH_INVALID_CREDENTIALS` (no enumeration) and `401 UNAUTHENTICATED` error codes,
> identity propagation to the existing routes without making any of them
> role-dependent, and the authenticated test infrastructure (real sessions everywhere —
> no global auth bypass). The API route count is now **32** (+`/auth/login`,
> `/auth/logout`, `/auth/session`, `/auth/password`); no new auth dependency, no CORS,
> no JWT, and every preserved contract (calculations, takeoff, previews, transfer,
> reporting, pricebook, lifecycle, immutable snapshots) is verified unchanged by the
> full unit/browser-E2E/production-smoke matrices.
>
> **S2 (2026-09-28, the owner's S2 execution order) delivered exactly the §2/§3
> contract**: the centralized route-policy table (`apps/api/src/authz.ts` — the §3
> matrix as code, cross-checked by a test), the role lattice (org_admin ⊇
> estimator/reviewer/viewer/data_steward; estimator/reviewer/data_steward ⊇ viewer),
> the four user-management routes (POST /users, GET /users, POST /users/:userId/role,
> POST /users/:userId/deactivate — org_admin only; the API route count is now **36**),
> `403 FORBIDDEN` with the §2.2 `details.requiredRole` (authorization decided before
> any handler logic; authentication failures stay 401), the §2.3 guard rails
> (self-deactivation 403, last-active-org_admin demotion/deactivation 409, soft
> deactivation revoking every session), and the real-role test infrastructure (one
> real DB-backed user per role with real session cookies; a 37-test route × role
> matrix covering all 34 protected routes against all five roles + anonymous with
> zero-side-effect proofs; per-role browser E2E through the real login UI;
> production-smoke and real-PostgreSQL denials). No new migration (the users/sessions
> schema of `0002_p8_governance` suffices), no permissions tables, no role checks in
> the engines, and no 403 anywhere in the S1 auth surface.
>
> S3 (the audit writer) and S4 (reviewer sign-off, incl. the #37/#38 approve routes)
> remain NOT STARTED and require a separate owner execution order.

## Open decisions

- O-1: ~~Exact v1 disciplines (ابنیه only vs. + mechanical/electrical)~~ — resolved
  in practice: V1 is ابنیه only (the resolution is recorded in PROJECT_SCOPE §7);
  mechanical and electrical disciplines remain future scope.
- O-2: Self-hosted LLM/vision model selection for extraction.
- O-3: Desktop/offline packaging (e.g. Tauri) for site use — evaluate after v1.
- O-4: Scope and timing of صورت‌وضعیت and تعدیل modules.
