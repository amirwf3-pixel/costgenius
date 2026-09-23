# CostGenius — Architecture

Status: proposed (discovery phase). Repository currently contains only `README.md`; no code, CI, issues or PRs exist.

## 1. Principles

1. **Pure core, impure edges** (hexagonal). The calculation engine is a pure library with no I/O, DB, clock, or network access.
2. **Data is versioned and immutable once referenced.** Price-book editions, market-price snapshots and locked estimate versions are never mutated.
3. **Everything that affects a number is an explicit, recorded input** (quantities, price source, edition, coefficients, overrides, rounding rules).
4. **AI is a proposal generator**, isolated behind an interface; its output lands in a staging area, never directly in calculations.
5. **Exports are rendered from the same computed result object** the UI displays — one source of truth.

## 2. Stack

| Concern               | Choice                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Language              | TypeScript (strict) end-to-end                                                                       |
| Monorepo              | pnpm workspaces + Turborepo                                                                          |
| Decimal math          | `decimal.js` wrapped in an internal `Money`/`Qty` value type                                         |
| Expression evaluation | Own small, sandboxed formula parser (no `eval`)                                                      |
| API                   | Node.js, Fastify, Zod-validated contracts (shared types)                                             |
| Database              | PostgreSQL 16                                                                                        |
| ORM / migrations      | Drizzle ORM + SQL migrations                                                                         |
| Jobs                  | pg-boss (Postgres-backed queue; no extra infra)                                                      |
| Object storage        | S3-compatible (MinIO on-prem) for source files and exports                                           |
| Excel                 | ExcelJS (formulas, styles, RTL sheets, named ranges)                                                 |
| PDF                   | HTML/CSS templates rendered by headless Chromium (Playwright); Vazirmatn font embedded               |
| Web UI (later)        | Next.js (App Router), React, Tailwind, shadcn/ui (Radix), TanStack Table/virtualized grid, RTL-first |
| Auth                  | Session-based auth in API (Lucia-style/own), RBAC; OIDC optional later                               |
| Testing               | Vitest, fast-check (property tests), Playwright (E2E), golden files                                  |
| Deployment            | Docker Compose (on-prem / Iranian cloud); no mandatory foreign SaaS                                  |

## 3. Repository structure

```
costgenius/
├─ apps/
│  ├─ web/                 # Next.js UI (phase 4+)
│  ├─ api/                 # Fastify HTTP API, auth, orchestration
│  └─ worker/              # background jobs: imports, exports, AI tasks
├─ packages/
│  ├─ domain/              # entities, value types (Money, Qty, Unit), IDs, errors
│  ├─ calc-engine/         # PURE: takeoff formulas, pricing, coefficients, rollups
│  ├─ pricebook/           # official price-book schema, importers, validators
│  ├─ market-prices/       # market price sources, snapshots, resolution policy
│  ├─ projects/            # project/estimate/version services (uses repositories)
│  ├─ audit/               # audit event model + writer
│  ├─ reporting/           # report model builder, Excel + PDF renderers, templates
│  ├─ ai-assist/           # provider-agnostic AI adapters, extraction → proposals
│  ├─ db/                  # Drizzle schema, migrations, repositories
│  ├─ contracts/           # Zod API schemas shared by api/web
│  ├─ i18n/                # fa-IR strings, Jalali dates, Persian digit/number formatting
│  └─ ui/                  # design system components (later)
├─ fixtures/               # golden test cases (synthetic or licensed data only)
├─ docs/                   # ADR follow-ups, domain glossary
├─ ARCHITECTURE.md  PROJECT_SCOPE.md  DECISIONS.md
```

Dependency rule (enforced via lint `import/no-restricted-paths` / dependency-cruiser):
`domain` ← `calc-engine` ← (`pricebook`, `market-prices`, `projects`, `reporting`) ← `apps/*`.
`calc-engine` and `domain` may not import `db`, `ai-assist`, or any I/O module. `ai-assist` may not import `calc-engine` write paths.

## 4. Modules

### 4.1 Calculation engine (`calc-engine`) — deterministic core

- Input: a fully resolved, immutable `EstimateInput` (takeoff lines, resolved unit prices with source refs, coefficient set, rounding policy, engine version).
- Output: `EstimateResult` — line amounts, chapter subtotals, coefficient applications, totals, plus a **calculation trace** (per-number derivation tree).
- Takeoff line: `count × length × width × height` (nullable dims) or a restricted formula expression over named variables; deductions as negative lines. Units are typed; unit mismatch is an error, not a conversion guess.
- Rounding: explicit per-stage policy (line, chapter, total) stored with the estimate; never implicit.
- Coefficient rules are **data** (loaded from the price-book edition), interpreted by a small rule model (multiplicative/additive, scope = item/chapter/total). No regulation is hard-coded.
- Versioned: `engineVersion` stored on every result; behavior changes require a new version and golden-test updates.

### 4.2 Official price-book (`pricebook`)

- Hierarchy: `Discipline → Edition(year, publisher, source file hash) → Chapter → Item(code, description, unit, unit price components)`; plus edition-specific notes (مقدمه/شرح فصل) and coefficient definitions.
- Importers per source format (Excel/PDF-extracted tables) produce a **staged import** → validation report (duplicates, missing units, code format, totals) → human approval → published immutable edition.
- Every item keeps `sourceDocumentId`, page/row reference, import timestamp and importer version.
- Non-listed/star items are project-scoped items with required analysis (تجزیه قیمت) and justification.

### 4.3 Market-price engine (`market-prices`)

- `PriceObservation(resource, value, unit, currency=IRR, region, source, observedAt, validUntil, enteredBy, evidenceFileId?)`.
- `PriceSnapshot` = frozen set of observations used by an estimate version.
- Resolution policy (explicit, per estimate): e.g. latest-within-N-days, region fallback order, median of sources. Output includes which observations were used. Stale/missing prices are surfaced, never silently filled.
- Scrapers/feeds are optional adapters; all data enters as observations with source metadata.

### 4.4 Project data (`projects`)

- `Organization → Project → Estimate → EstimateVersion (draft | in_review | locked)`.
- Draft is editable; locking freezes: takeoff, price-book edition ID, market snapshot ID, coefficient set, overrides, engine version, and stores the computed result hash.
- Supporting: `Building/Zone/Floor` location tree, `Drawing/Document` references, comments.

### 4.5 Overrides & audit (`audit`)

- `PriceOverride(target, originalValue, newValue, reason (required), userId, at)` — layered on top of resolved prices; original always retained.
- Append-only `AuditEvent(entity, entityId, action, before, after, actor, at, requestId, origin: user|import|ai-accepted|system)`; written in the same DB transaction as the change. DB role for the app cannot `UPDATE/DELETE` the audit table.
- All timestamps stored UTC (`timestamptz`), displayed in Jalali, Asia/Tehran.

### 4.6 Reporting/export (`reporting`)

- Stage 1: `ReportModel` builder converts `EstimateResult` + metadata into a renderer-agnostic document model (sections, tables, cells with value + formula intent + formatting).
- Stage 2 renderers:
  - **Excel**: real formulas (`=C5*D5`, `SUM` over ranges), named ranges, sheet per report (ریز متره, خلاصه فصول, برآورد, overrides, sources), RTL sheets, frozen headers, print setup. Post-render verification recomputes formulas (via a formula evaluator in tests) and asserts equality with engine totals.
  - **PDF**: HTML templates → Chromium; RTL, embedded Persian fonts, headers/footers with project, version, Jalali date, page numbers, signature blocks; version hash printed.
- Templates versioned; organizations may customize branding/layout within constrained template slots.
- Exports run in worker; outputs stored with `(estimateVersionId, templateVersion, engineVersion, hash)`.

### 4.7 AI-assisted interpretation (`ai-assist`)

- Provider-agnostic interface (`extractTakeoffCandidates`, `suggestItemMatches`, `explainTrace`); self-hostable model option required for Iranian deployments.
- Outputs are `Proposal` records (staging) with confidence, source region (file/page/bbox) and model/prompt version. Proposals reference only **existing** price-book item IDs (validated; unknown codes rejected).
- Human accept → converted into normal takeoff lines with `origin=ai-accepted` audit metadata. AI has no write path to prices, coefficients or editions.
- Disabled-by-default per org; app is fully functional without it.

### 4.8 UI (`apps/web`, later)

- RTL-first, keyboard-driven spreadsheet-like grids for takeoff (virtualized, 10k+ lines), side-panel trace inspector ("why is this number X?"), diff view between versions, import validation screens, AI proposal review queue. Dark/light, accessible (WCAG AA).

## 5. Data model strategy

- PostgreSQL, normalized relational core; `numeric(precision, scale)` for all quantities and money (never float). Rial stored as integer-valued `numeric`; Toman is display only.
- Immutable, versioned reference data (editions, snapshots) with surrogate UUIDv7 keys plus natural keys (edition + item code).
- Estimate versions reference data by ID; locking stores a canonical JSON of `EstimateInput` and `EstimateResult` + SHA-256 hash for reproducibility.
- JSONB only for trace blobs, report models and import staging — not for core queryable entities.
- Multi-tenancy: `organization_id` on all tenant tables + Postgres Row-Level Security.

## 6. Data flow (pricing an estimate)

```
UI/API → projects: load draft
      → pricebook: resolve items (edition X)
      → market-prices: resolve snapshot (policy P)
      → apply overrides
      → build EstimateInput (immutable)
      → calc-engine.compute(input) → EstimateResult + trace
      → persist (+ audit) → reporting (Excel/PDF)
```

## 7. Testing strategy

| Layer               | Tests                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| calc-engine         | Unit tests; property tests (additivity, deduction symmetry, rounding bounds, order-independence); golden files of expert-verified estimates; 100% branch coverage gate                     |
| formula parser      | Fuzzing; injection/unsafe-expression rejection                                                                                                                                             |
| pricebook importers | Fixture files → snapshot of parsed output; validation-rule tests; round-trip counts/totals checks                                                                                          |
| market-prices       | Resolution-policy tables (staleness, fallback, ties)                                                                                                                                       |
| reporting           | Excel: open generated file, evaluate formulas, assert equals engine totals; structural snapshots. PDF: visual regression (Playwright screenshots) + text extraction checks for RTL/numbers |
| audit               | Every mutating endpoint tested to emit an audit event; DB permissions test for append-only                                                                                                 |
| ai-assist           | Contract tests with recorded responses; assert no proposal references non-existent items; no AI path mutates prices                                                                        |
| API/E2E             | Integration tests against ephemeral Postgres (Testcontainers); Playwright E2E of core flows                                                                                                |
| Determinism         | Same input computed twice/on different machines → identical hash (CI check)                                                                                                                |

Fixtures use synthetic or properly licensed data only; no invented "real" price-book content.

## 8. Cross-cutting

- Security: RBAC + RLS, CSRF-safe sessions, file upload scanning/size limits, signed URLs for exports.
- Observability: structured logs with requestId, OpenTelemetry traces, import/export job metrics.
- Backups: Postgres PITR + object storage versioning; locked versions are legally significant.
- Performance targets: recompute a 10k-line estimate < 1s server-side; Excel export < 30s.
