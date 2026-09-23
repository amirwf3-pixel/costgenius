# Architecture Decision Log

Format: ID · Decision · Rationale · Consequences. Status is "Accepted" unless noted.

## D-001 · TypeScript end-to-end monorepo (pnpm + Turborepo)

- **Why**: shared types/validation between engine, API, UI and exports; one toolchain; strong hiring pool.
- **Consequences**: numeric correctness must be enforced by a decimal library (D-002), since JS numbers are floats. Python rejected mainly for split-language type sharing with the UI.

## D-002 · Decimal arithmetic everywhere; no floats for money or quantities

- **Why**: auditability and exact reproduction of manual/Excel calculations.
- **How**: `decimal.js` wrapped in `Money`/`Qty` value types; Postgres `numeric`; lint rule forbidding raw arithmetic on these types; explicit rounding policy per estimate.

## D-003 · Calculation engine is a pure, versioned library

- **Why**: determinism, testability, reproducibility of locked versions.
- **Consequences**: all data resolved before calling the engine; `engineVersion` persisted; behavior changes ship as new versions with golden-test updates.

## D-004 · Coefficients and price-book rules are data, not code

- **Why**: rules change per edition/year; hard-coding risks silently wrong or fabricated regulations.
- **Consequences**: each edition's coefficient definitions are transcribed from official documents, expert-verified, and stored with source references. The engine implements only generic rule mechanics.

## D-005 · Immutable, versioned reference data; locked estimate snapshots

- **Why**: an estimate submitted in one year must re-render identically later.
- **How**: editions and market snapshots immutable after publish; locked version stores canonical input/result JSON + SHA-256.

## D-006 · Manual overrides are layers, never edits

- **Why**: original source values must remain visible for review.
- **How**: `PriceOverride` records with mandatory reason; reports include an overrides appendix.

## D-007 · Append-only audit log in the same transaction

- **Why**: full auditability; no audit gaps from async failures.
- **Consequences**: write amplification acceptable; DB privileges prevent UPDATE/DELETE on audit tables.

## D-008 · AI is advisory and sandboxed

- **Why**: AI must never invent quantities, prices, regulations or BOQ items.
- **How**: AI output → `Proposal` staging; item references validated against existing editions; human acceptance required; provenance recorded; no AI write path to prices/editions; provider-agnostic with self-hosted option; app fully functional with AI disabled.

## D-009 · PostgreSQL as the single stateful store (+ S3-compatible storage)

- **Why**: relational integrity, `numeric`, RLS, JSONB for traces, pg-boss queue — minimal infrastructure for on-prem Iranian deployments.
- **Rejected**: separate queue/broker, NoSQL primary store.

## D-010 · Two-stage reporting: ReportModel → renderers

- **Why**: Excel and PDF must show identical numbers from one source.
- **How**: ExcelJS with real formulas and verification tests that recompute formulas vs engine totals; PDF via HTML + headless Chromium for reliable Persian RTL shaping and font embedding.
- **Rejected**: low-level PDF libraries (weak Arabic-script shaping), value-only Excel exports (not editable).

## D-011 · Deployable without foreign SaaS dependencies

- **Why**: sanctions, connectivity, and data-residency realities for Iranian companies.
- **Consequences**: Docker Compose deployment; self-hosted fonts, auth, storage; npm mirror/offline build considered in CI.

## D-012 · Fa-IR/RTL-first, UTC storage, Jalali display

- **Why**: correct time math and audit ordering; native user experience.
- **Consequences**: dedicated `i18n` package for Jalali dates, Persian digits, Rial/Toman formatting (Toman display only).

## D-013 · No bundled price data without traceable source

- **Why**: legal/licensing uncertainty and correctness. Repository and fixtures contain only synthetic or licensed data.

## D-014 · UI deferred until engine, data and exports are proven (Proposed)

- **Why**: correctness of numbers and exports is the product's core value; UI built on a stable API contract.

## Open decisions

- O-1: Exact v1 disciplines (ابنیه only vs. + mechanical/electrical) — needs product/domain input.
- O-2: Self-hosted LLM/vision model selection for extraction.
- O-3: Desktop/offline packaging (e.g. Tauri) for site use — evaluate after v1.
- O-4: Scope and timing of صورت‌وضعیت and تعدیل modules.
