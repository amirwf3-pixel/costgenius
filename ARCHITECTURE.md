# CostGenius — Architecture

Status: **implemented** — the estimation vertical slice (projects → estimates → BOQ
versions → S4 calculation → finalization → Excel/PDF reports) and the Full Takeoff
workstream (D-016 Phases 0–6: takeoff documents with sheets, references and
structured expressions → immutable finalized snapshots → Takeoff → BOQ transfer →
Takeoff PDF/Excel reports; plus its Phase-7 follow-through: the project-scoped takeoff
list and the stateless draft calculation preview) are built, tested and release-audited
(_PRODUCTION RELEASE READY WITH LIMITATIONS_ — see DEPLOYMENT.md).
This document describes the repository **as it exists today**. PROJECT_SCOPE.md
describes the fuller intended product (largely unimplemented); DECISIONS.md is the
decision log.

## 1. Principles (as enforced today)

1. **Pure core, impure edges.** The calculation stack is pure: no I/O, no clock, no
   randomness — datasets, repositories and instants are injected. Enforced by ESLint
   import/property restrictions per layer (§3) and by boundary tests.
2. **Immutable once finalized.** Price-book editions and finalized estimate versions
   are never mutated; changes go through a new version (append-only).
3. **Every number is an explicit, recorded input.** Exact decimal strings end-to-end;
   edition, coefficients, traces and source references travel with every result.
4. **Exports render from the same computed result.** Excel/PDF are rendered from the
   ReportModel stored in the finalized snapshot — never recalculated.
5. **The official 1404 price book is the only price source.** The database is never
   the price master; clients cannot inject prices.

## 2. Stack (as implemented)

| Concern      | Choice                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language     | TypeScript (strict) end-to-end                                                                                                                     |
| Monorepo     | pnpm workspaces + Turborepo                                                                                                                        |
| Decimal math | `decimal.js` wrapped by `@costgenius/domain` (`Decimal`/`Money`/`Qty`, explicit `RoundingRule`)                                                    |
| Web UI       | React 18 + Vite SPA (`react-router-dom`), Persian RTL, Vazirmatn — static `dist/`, no SSR                                                          |
| API          | Fastify + Zod (`apps/api`); TypeScript executed directly via `tsx` (§7)                                                                            |
| Auth         | P8-A S1+S2 (CG-GOV §1–§3): local accounts, scrypt hashes (`node:crypto`), server-side sessions, centralized RBAC route policy — no auth dependency |
| Database     | PostgreSQL 16 — Drizzle ORM, versioned SQL migrations, node-postgres pool                                                                          |
| Excel        | ExcelJS + JSZip (`reporting-excel`)                                                                                                                |
| PDF          | pdfkit + bidi-js + embedded Vazirmatn (`reporting-pdf`) — no headless browser                                                                      |
| Testing      | Vitest (all packages), Testing Library (web), Playwright + npm-distributed Chromium (E2E), embedded-postgres (production smoke)                    |
| CI           | GitHub Actions: install → format → lint → typecheck → test → build (§8)                                                                            |
| Deployment   | same-origin static web + API process; no container artifact yet (documented limitation)                                                            |

## 3. Repository structure and layering

```
costgenius/
├─ apps/
│  ├─ web/      # React SPA (production static build in dist/)
│  ├─ api/      # Fastify HTTP API — the only production entry point
│  └─ worker/   # scaffold only (README)
├─ packages/
│  ├─ domain/            # pure core: Decimal/Money/Qty, units, rounding, IDs, instants
│  ├─ calc-engine/       # S1 quantity stage — frozen calculateQuantities (CG-RCS@0.1.0, D-015) + calculateTakeoff (CG-IR-MEAS@0.2.0, D-016)
│  ├─ pricebook/         # official 1404 dataset, provenance, statuses, validation
│  ├─ cost-calculation/  # S2 exact-code binding, S3 pricing, S4 estimate (5 stages)
│  ├─ boq/               # estimate/version/line lifecycle, append-only rules
│  ├─ projects/          # application layer: workflow orchestration + repository contracts
│  ├─ db/                # Drizzle/PostgreSQL adapter implementing those contracts
│  ├─ reporting/         # ReportModel builder (renderer-agnostic)
│  ├─ reporting-excel/   # ReportModel → XLSX
│  ├─ reporting-pdf/     # ReportModel → PDF
│  └─ market-prices, audit, ai-assist, contracts, i18n, ui   # scaffolds only
├─ .github/workflows/ci.yml
├─ DEPLOYMENT.md  PROJECT_SCOPE.md  DECISIONS.md
└─ فهرست‌بهای واحد پایه رشته ابنیه ۱۴۰۴ — PDF رسمی.pdf   # official source (hash-bound)
```

Runtime layering (these arrows are the only legal directions):

```
apps/web ──HTTP──▶ apps/api ─▶ projects ─▶ { boq, cost-calculation, reporting } ─▶ domain
                                   │                    │
                                   ▼                    ▼
                             db (Drizzle)      reporting-excel / reporting-pdf
                                   │
                                   ▼
                             PostgreSQL
```

Enforced boundaries (ESLint `no-restricted-imports` + API boundary tests):

- the pure packages (`domain`, `pricebook`, `cost-calculation`, `calc-engine`) may not
  import I/O modules, `Math.random` or `Date.now`;
- `apps/web/src` may not import any `@costgenius/*` workspace package or Node builtin —
  the browser bundle is a pure HTTP consumer;
- `apps/api/src` touches `@costgenius/db` only in the composition root, never the
  engines, and contains no SQL.

## 4. Calculation boundary

- **Frontend**: display/orchestration only; renders the exact decimal strings the API
  returned (no arithmetic on business numbers).
- **API**: no calculation — delegates entirely to `@costgenius/projects`.
- **projects**: pure orchestration (no formulas) over the engine packages.
- **cost-calculation**: S2 binds each line to the pricebook by **exact code** (no fuzzy
  match, no unit conversion); S3 prices lines with exact decimals (NULL stays NULL,
  negatives stay negative, leading zeros preserved); S4 chains five traced stages —
  base-subtotal → floor → overhead → regional → site-setup — and aggregates status (a
  pending input yields a NULL total, never 0).
- **calc-engine**: the S1 quantity engine (rules R1–R9 over `Qty`, frozen
  CG-RCS@0.1.0) computes dimensional line quantities (D-015) — S1 units only
  (`m`/`m2`/`m3`/`each`), exact-only (no rounding policy is ever constructed; the
  preview API rejects a `rounding` field). The pure adapter
  `packages/projects/src/takeoff-quantities.ts` is the only boundary: it maps
  single-line items to the engine input, and the engine's canonical output qty becomes
  the line quantity verbatim, with the provenance (`{input, output, specVersion,
engineVersion}`) persisted on `boq_lines.trace.takeoff` (existing JSONB path, no DDL;
  `createBoqLine` guards quantity/provenance consistency via `LINE_MISMATCH`).
  Manually entered quantities remain supported; a negative quantity is rejected
  (`NEGATIVE_QUANTITY`, D-015/D2-A re-baseline) — deductions are priced کسر بها rows or
  the engine's `kind` semantics, never signed quantities.
- **Full Takeoff (D-016 — implemented, Phases 0–6)**: the complete متره workflow runs
  on `calculateTakeoff` (CG-IR-MEAS@0.2.0, a pure sibling of the frozen
  `calculateQuantities`): takeoff documents with sheets and document-unique lineIds,
  dimensional / manual / reference / structured-expression quantities (no parser, no
  `eval`), explicit `floorCount`/`similarCount` factors, document-scoped rounding
  (exact values always authoritative; rounded derived, one rounding at its target),
  item/sheet totals with contributing-lineIds provenance, and a draft/archive/finalized
  lifecycle with optimistic concurrency (`expectedRevision`), follow-up revisions and
  immutable, byte-compared finalized snapshots. A finalized takeoff transfers into a
  draft estimate version as one BOQ line per priced itemCode itemTotal (G2=B; uncoded
  lines stay in the takeoff) and renders standard PDF/Excel reports from the snapshot
  (§10). Its Phase-7 follow-through (the D-017 contracts, CG-FT@0.2.0 §15/§16) is built
  beside it: a project-scoped takeoff list (a pure projection of the existing
  `findByProjectId`, deterministic chain order) and a stateless draft calculation
  preview (the persisted draft solved by the same engine, nothing persisted, failures
  as the structured `422 TAKEOFF_SOLUTION_REJECTED` contract). The product contracts
  live in `packages/projects/spec/CG-FT-TAKEOFF-SPEC@0.2.0.md` (0.1.0 superseded); the
  D-015 quick-entry path is unchanged beside it.
- **Decimal arithmetic and rounding**: only via `@costgenius/domain`; rounding is
  explicit (`RoundingMode` + `RoundingRule`), never implicit.

## 5. Pricebook architecture

```
official 1404 PDF (repo root, SHA-256 c49e3155…16fae0f)
   → verified staged dataset  packages/pricebook/data/verified-1404.staged.v0.1.0.json
     (formatVersion 1 · edition ir-1404-abniye · 1564 rows · bound by sourceFileHash)
   → P8-B S1: persisted as the ACTIVE edition in pricebook_editions by the first-boot
     seed (the SAME import gate; contentHash a669ddd4…4de786; DB = source of truth)
   → SEED ARTIFACT ONLY since P8-B S3: the API loads NO dataset at boot — every
     runtime resolution (version creation, line-add, takeoff transfer, rows search)
     resolves the persisted pricebook_editions registry, and the version's immutable
     edition_id decides its dataset (hash-verified, cached per edition, never
     substituted; D-PB-1 = B, D-PB-3 = B)
```

- The dataset is immutable; 193 pricebook tests pin the row count, the source hash and
  the row invariants.
- Since P8-B S1 the database stores the **pricebook_editions registry** (migration
  `0004_p8b_pricebook_editions`, the 13th table): immutable edition rows guarded at
  the database level (trigger-enforced content/provenance immutability, no delete,
  0-or-1 ACTIVE per discipline, version bindings stamped and pinned). The staged file
  remains the seed artifact and the provenance reference; prices still freeze into
  BOQ lines at line-add and never resolve from the registry at calculation time.
- Line payloads are strict-schema: `basePrice`/`unitPrice`/`lineAmount` from a client
  are rejected with 400.
- Row statuses: `VERIFIED_SPEC_ONLY` / `INCOMPLETE` / `EXTERNAL_DEPENDENCY` (4 rows).
  Regional-coefficient **values** are an external dependency (circular 94/69416 annex)
  and are never substituted — a missing Rᵢ keeps the result `EXTERNAL_DEPENDENCY`.

## 6. API surface (43 routes — the complete list)

15 GET + 28 POST; no PATCH/PUT/DELETE. Every error — domain, validation, transport and
unknown routes — answers the stable shape `{error:{code,message,details?}}`.

**Authentication (P8-A S1)**: every route except `GET /health` and
`POST /auth/login` requires the `cg_session` cookie (HttpOnly, `SameSite=Strict`,
`Secure` on https, 12-hour absolute expiry). An absent/expired/revoked session answers
`401 UNAUTHENTICATED`; wrong credentials answer a uniform `401
AUTH_INVALID_CREDENTIALS` (identical for unknown usernames — no enumeration). Identity
arrives as an authenticated user object at the HTTP/application boundary only; the
engines and repositories stay actor-free (CG-GOV §6).

**Authorization (P8-A S2)**: one central route-policy table (`apps/api/src/authz.ts`,
the CG-GOV §3 matrix as code) decides, in the same gate and BEFORE any handler logic,
whether the authenticated role satisfies the route's class — `403 FORBIDDEN` with
`details.requiredRole` otherwise (never a 401; never a 404). Classes: user management
= org_admin only; domain mutations and stateless previews = estimator+ (org_admin,
estimator); reads, renders and exports = viewer+ (all five roles); the pricebook
lifecycle mutations (#41–#43) = data_steward+ (org_admin, data_steward — CG-GOV §2.1's
reserved pipeline role, granted its first capabilities by P8-B S2); the /auth surface =
any authenticated role. A route missing from the policy table fails closed to
org_admin. Role **checks exist only at this boundary** — the engines never see roles.

**Audit trail (P8-A S3, CG-GOV §4)**: every catalog mutation appends its contract
event to `audit_events` through ONE canonical append-only writer
(`packages/projects/src/audit.ts` defines the exact 23-event catalog as frozen
builders — 17 domain + 6 governance, the three pricebook-edition events of P8-B
included; `DrizzleAuditEventRepository` exposes `append`
only). The actor is derived exclusively from the gate-resolved session (never from a
body/query/route parameter); `auth.login_failed` is the contract's single null-actor,
unauthenticated write path. The mutation and its event(s) are written in the SAME
database transaction on the caller's connection — a failed mutation leaves zero
events, and the event is appended only after the mutation reached its successful
in-transaction state. `details` carries contract-approved structured fields only
(never credentials, tokens or arbitrary bodies). There is NO audit read API or UI in
V1.1 — the table is write-only from the application; the two `approved` events of the
catalog are written ONLY by the S4 sign-off routes (#37/#38), in the same transaction
as the approval mutation; the three `pricebook_edition.*` events are written by the
P8-B seed (S1) and lifecycle routes (S2), in the same transaction as their mutation.
401/403 denials write nothing.

| Route                                                                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST `/auth/login` · POST `/auth/logout`                                                              | issue the session cookie (200) / revoke the session row and clear the cookie (204)                                                                                                                                                                                                                                                                                                                                                   |
| GET `/auth/session` · POST `/auth/password`                                                           | the current user projection / change password (revokes every OTHER session)                                                                                                                                                                                                                                                                                                                                                          |
| GET `/health`                                                                                         | liveness (`{"status":"ok"}`)                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST `/projects` · GET `/projects` · GET `/projects/:id`                                              | project create (201) / list / reload                                                                                                                                                                                                                                                                                                                                                                                                 |
| GET `/pricebook/rows?search&limit&editionId`                                                          | presentation-only search for the add-line dialog (capped at 50); since P8-B S2 it resolves the discipline's PERSISTED ACTIVE edition — `409 EDITION_NOT_ACTIVE` in the 0-active state, never a fallback; since P8-B S3 an explicit `editionId` searches exactly that ACTIVE/ARCHIVED edition (DRAFT → `409 EDITION_NOT_SELECTABLE`, unknown → `404 EDITION_NOT_FOUND`) — the dialog of a bound version always passes its own edition |
| GET · POST `/projects/:id/estimates`                                                                  | estimate list / create (201)                                                                                                                                                                                                                                                                                                                                                                                                         |
| GET · POST `/pricebook/editions` · GET `/pricebook/editions/:editionId`                               | P8-B S2 edition lifecycle: the deterministic `(importedAt, editionId)` list and the detail with its stored import report (Viewer+); the staged-document import as a new DRAFT through the SAME gate (data_steward+, 8 MiB route body limit)                                                                                                                                                                                          |
| POST `/pricebook/editions/:editionId/{activate,archive}`                                              | P8-B S2: atomic activation (four-eyes on DRAFT→ACTIVE; the previous ACTIVE edition auto-archived in the same transaction; both events together; the partial unique index decides races — exactly one winner) and archive (DRAFT discard / ACTIVE archive; the legal 0-active state) — data_steward+                                                                                                                                  |
| GET `/estimates/:id`                                                                                  | full estimate aggregate                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST `/estimates/:id/versions`                                                                        | new draft version (201); since P8-B S3 the optional `editionId` binds the version's pricebook edition — omitted → the ACTIVE edition resolved BEFORE any mutation (0 active → `409 EDITION_NOT_ACTIVE`), explicit ACTIVE/ARCHIVED bound verbatim, DRAFT → `409 EDITION_NOT_SELECTABLE`, unknown → `404 EDITION_NOT_FOUND`; the binding is immutable for the version's life and rides the response additively (`editionId`)           |
| GET `/estimate-versions/:id`                                                                          | finalized bundle, or the draft version                                                                                                                                                                                                                                                                                                                                                                                               |
| POST `/estimate-versions/:id/lines`                                                                   | add BOQ lines (exact-code, batch, all-or-nothing); per line exactly one of `quantity` \| `takeoff` (D-015: the server computes dimensional quantities and attaches the provenance); since P8-B S3 every line resolves against the TARGET VERSION's bound edition — never the currently ACTIVE one, never a fallback                                                                                                                  |
| POST `/takeoff/quantities/preview`                                                                    | stateless dimensional quantity preview (D-015/D5-A; exact-only, `rounding` rejected; engine errors → `TAKEOFF_QUANTITIES_REJECTED` with engine details only)                                                                                                                                                                                                                                                                         |
| POST `/estimate-versions/:id/calculate`                                                               | S4 preview (not persisted)                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST `/estimate-versions/:id/finalize`                                                                | atomic finalization (201)                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST `/estimate-versions/:id/approve`                                                                 | reviewer sign-off (#37; Reviewer+, four-eyes, irreversible)                                                                                                                                                                                                                                                                                                                                                                          |
| GET `/estimate-versions/:id/render/excel` · `/render/pdf`                                             | deterministic render from the snapshot (a draft → 409 VERSION_NOT_FINALIZED)                                                                                                                                                                                                                                                                                                                                                         |
| POST `/projects/:id/takeoffs`                                                                         | create a takeoff chain's first draft document (201, D-016)                                                                                                                                                                                                                                                                                                                                                                           |
| GET `/projects/:id/takeoffs`                                                                          | the project-scoped takeoff list — a pure projection (all statuses, `(takeoffId, documentNumber)` order, no filtering/pagination; P7-S1)                                                                                                                                                                                                                                                                                              |
| GET `/projects/:id/takeoffs/:documentId`                                                              | the draft/archived document, or the finalized bundle (the estimate-version convention)                                                                                                                                                                                                                                                                                                                                               |
| POST `/projects/:id/takeoffs/:documentId/{save,archive,unarchive,finalize,follow-up,transfer-to-boq}` | full-document lifecycle under `expectedRevision` (409 on stale); finalize runs the engine and persists the immutable snapshot (201); transfer creates one BOQ line per priced itemCode itemTotal (G2=B) priced with the TARGET VERSION's bound edition (P8-B S3)                                                                                                                                                                     |
| POST `/projects/:id/takeoffs/:documentId/approve`                                                     | reviewer sign-off (#38; Reviewer+, four-eyes, irreversible)                                                                                                                                                                                                                                                                                                                                                                          |
| POST `/projects/:id/takeoffs/:documentId/calculate`                                                   | stateless draft calculation preview — the engine result verbatim, nothing persisted/mutated/transferable; failures `422 TAKEOFF_SOLUTION_REJECTED` with structured `details.failures` (P7-S2)                                                                                                                                                                                                                                        |
| GET `/projects/:id/takeoffs/:documentId/render/{excel,pdf}`                                           | standard Takeoff report from the finalized snapshot only (a draft → 409 TAKEOFF_NOT_FINALIZED)                                                                                                                                                                                                                                                                                                                                       |

The takeoff error contract is two-layer (D-ERROR=C): finalization keeps
`422 TAKEOFF_CALCULATION_FAILED` (engine codes in the message; atomic; nothing
finalized) while the preview surface answers `422 TAKEOFF_SOLUTION_REJECTED` with the
engine's structured failures under `details.failures` — distinct codes, never aliased.

## 7. Production runtime and build

- **Run**: `DATABASE_URL=postgres://… pnpm --filter @costgenius/api start` —
  `node --conditions=source --import tsx src/main.ts`.
- **`tsx` is a deliberate runtime dependency**: the API ships TypeScript source and
  executes it directly (no separate build step for the service; workspace packages
  export their TS source through the `source` condition). The path is verified
  end-to-end by the production smoke test against a real PostgreSQL 16.9 server and
  documented in DEPLOYMENT.md.
- **Startup order** (fail-closed): config validation → pool → migrations → listen →
  `/health`. A missing/malformed `DATABASE_URL` or an unreachable database exits
  non-zero without ever listening.
- **Shutdown**: SIGTERM/SIGINT → stop accepting requests → close Fastify → end the
  pool → exit 0.
- **Web**: `pnpm build --force` emits `apps/web/dist` (static files); serve same-origin
  behind a reverse proxy forwarding `/api/*` (no CORS by design).
- **Smoke**: `pnpm --filter @costgenius/api run smoke:production` (89 checks on a real
  PostgreSQL server, incl. the S3 audit blocks: governance + domain event payloads,
  zero-event denials, restart persistence and restricted-role append-only probes).

## 8. CI

`.github/workflows/ci.yml` — on push (main) and pull requests:
`pnpm install --frozen-lockfile` → `format:check` → `lint` → `typecheck` → `test` →
`build --force`. No external services. The browser E2E suite and the real-PostgreSQL
smoke run outside CI (they rely on environment-specific channels — the npm-distributed
Chromium and the embedded PostgreSQL binaries).

## 9. Persistence

Twelve tables — the estimate family (`projects`, `estimates`, `estimate_versions`,
`boq_lines`, `finalized_estimates`), the takeoff family (`takeoff_documents`,
`takeoff_sheets`, `takeoff_lines`, `finalized_takeoffs`, D-016), and the P8-A S1
governance family (`users`, `sessions`, `audit_events` — CG-GOV §7) — with foreign
keys, a unique `(estimate_id, version_number)` and a unique `(takeoff_id,
document_number)` chain key. Passwords are stored only as
`scrypt$16384$8$1$salt$hash` records (never reversible material); sessions store only
the SHA-256 of the 64-hex token, with the raw token existing solely in the HttpOnly
cookie. `audit_events` is append-only: the application writes through one canonical
INSERT-only writer, and the application role's `UPDATE`/`DELETE` privileges on the
table are revoked at the database level (env-gated real-PostgreSQL 42501 denial
tests; the production smoke restarts the API as the restricted role and probes
tampering directly — Postgres-specific, enforced on the real server, PGlite cannot
reproduce privilege checks and is never used to weaken them). Quantities and prices
are exact `numeric` columns; finalized snapshots are
JSONB (`s4_input`, `s4_result`, `rollup`, `report_model` for estimates; `input`,
`result` plus `spec_version`/`engine_version` for takeoffs). Immutability is enforced
at the application layer (`VERSION_FINALIZED`/`TAKEOFF_DOCUMENT_IMMUTABLE` rules,
byte-compared snapshots, and `SELECT … FOR UPDATE` serialization of finalize/append on
the owning row); there are no DB-level triggers. Three versioned migrations
(`0000_phase14_initial_schema.sql`, `0001_d016_takeoff.sql`,
`0002_p8_governance.sql`), journal-based, idempotent, seed-free — the first two are
byte-untouched by Phase 8.

## 10. Reporting

A single `ReportModel` (built by `reporting` from the estimate and its authoritative
rollup) feeds both renderers: **Excel** (business values as exact text, `null` → empty
cell, no live formulas) and **PDF** (RTL with real Arabic shaping, repeated table
headers, Persian page numbering, `null` → «—»). Rendering is byte-deterministic and
always renders the **reloaded finalized snapshot** — never a recalculation. The takeoff
branch (D-016 Phase 6, G6=A) is parallel, not second: `TakeoffReportModel` (built from
the finalized takeoff snapshot, everything verbatim, §6.3 canonical formula column)
feeds the SAME two renderers through `renderTakeoffReportToPdf/Xlsx`; reports are
finalized-only (draft → 409) and never mutate the snapshot.

## 11. Testing strategy (as implemented)

| Layer                                                                  | What runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| domain · calc-engine · cost-calculation · boq · pricebook · reporting* | Vitest unit + golden tests (exact decimals, statuses, provenance)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| db                                                                     | repository tests over PGlite with the real migrations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| api                                                                    | full HTTP chain over PGlite (fixed clock) incl. the 14-test S1 auth suite, the S2+ route × role matrix (all 41 protected routes incl. the five P8-B S2 lifecycle routes, with real DB-backed role users and real session cookies), the audit matrix (event payloads, rollback/zero-event proofs with a failing writer on the caller's transaction, duplicate prevention, credential-leak scans) and the 22-test P8-B S2 lifecycle suite (import/list/detail/activate/archive, the 0-active state, §14 byte-identity across an activation); env-gated node-postgres suites for the real-server legs (incl. a used-database rerun proving the children-first drop repair, the real-PG append-only/atomicity suite, and the P8-B suites: edition persistence + lifecycle concurrency — two simultaneous activations → exactly one ACTIVE, racing imports → one row, runbook app-role grants)              |
| web                                                                    | jsdom component tests (incl. the S1 login/session/logout/password-change UI) + a node-env integration test (real client → real login → real API → PGlite)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| browser E2E                                                            | real Chromium (npm-distributed binary) driving the production build — 33 tests (incl. the S1 gate/logout spec, authenticated via Playwright storageState from a REAL login, and the S2 RBAC spec: per-role UI logins, allowed work, 403 denials UI + direct-API, no bypass)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| production smoke                                                       | real PostgreSQL 16.9 + the real `src/main.ts` process — 133 checks (incl. the auth gate, uniform 401s, bootstrap, DB-backed sessions surviving restart, logout revocation, credential-free logs, the S2 denials: bootstrap admin is org_admin, viewer reads/exports OK, viewer mutations 403 with zero side effects, §2.3 guard rails; the S3 audit blocks: user-mgmt/auth/domain event payloads exact, zero-event denials, byte-identical history across a restart, the API restarted AS a restricted app role still writing events while UPDATE/DELETE on audit_events answer 42501; the P8-B blocks: the S1 seed state + edition immutability under the app role, and the S2 lifecycle on the production path — steward import, four-eyes, atomic handover with both events, the ACTIVE-following default search, the legal 0-active state failing closed, golden bytes identical across the churn) |

Fixtures use the official 1404 rows (the golden estimate) — never invented prices.

## 12. Not implemented (boundaries only — no claim of existence)

`apps/worker`; the scaffold packages `market-prices`, `audit`, `ai-assist`,
`contracts`, `i18n`, `ui`; the pricebook edition selection and UI (Phase-8 **P8-B** — contract closed in `packages/pricebook/spec/CG-IR-PRICEBOOK-SPEC@0.2.0.md`; **S1 and S2 are implemented**: the `pricebook_editions` registry, migration 0004, the first-boot 1404 seed, the estimate-version edition bindings, the database-level immutability guards, and the lifecycle routes #39–#43 with the ACTIVE-resolving default edition search; edition selection on version creation, the rows `editionId` parameter and the edition UI are NOT implemented — S3); an audit read
API/UI (the `audit_events` table is write-only from the application in V1.1);
organizations and RLS; drawing management (unspecified); Excel live formulas; a
Docker/container artifact; load testing; login rate limiting and CSRF tokens
(deliberately deferred, CG-GOV §1.7/§1.8). Phase-8 **S1 authentication, S2 RBAC and
S3 the audit writer are implemented** (local accounts, server-side sessions,
login/logout/session/password-change, bootstrap admin, 401 handling, the centralized
route-policy matrix, user management, 403 handling, the append-only 20-event audit
trail — see `apps/api/spec/CG-GOV-SPEC@0.1.0.md`, DECISIONS.md D-018). See
PROJECT_SCOPE.md for the full intended product.
