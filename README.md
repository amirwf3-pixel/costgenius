# CostGenius

Professional quantity-takeoff (متره) and cost-estimation (برآورد) for Iranian **building works (ابنیه)**.
Deterministic, auditable calculations on the official 1404 price book; Excel/PDF as
first-class outputs.

See [PROJECT_SCOPE.md](PROJECT_SCOPE.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[DECISIONS.md](DECISIONS.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

**Status:** the estimation vertical slice is implemented — projects → estimates → BOQ
versions → S4 calculation → finalization → Excel/PDF reports, over the official 1404
price book — together with the Full Takeoff (متره) workstream of D-016, Phases 0–6:
takeoff documents with sheets, dimensional/manual/reference/expression quantities,
explicit rounding, a draft/archive/finalized lifecycle with immutable snapshots and
follow-up revisions, transfer into BOQ estimate versions, and standard Takeoff
PDF/Excel reports. Both are covered by a real-browser E2E suite (Chromium 153) plus a
production-path smoke test on a real PostgreSQL 16.9 server. Phase 8 S1 adds the
authentication layer (CG-GOV §1): local accounts with scrypt passwords, server-side
12-hour sessions, login/logout/password-change, and a fail-closed first-boot bootstrap
admin. Everything else in PROJECT_SCOPE.md (role enforcement, audit, sign-off, market
prices, AI, worker, …) remains an unimplemented boundary.

## Requirements

- Node.js ≥ 22
- pnpm 10 (`corepack enable` picks up the version pinned in `package.json`)

## The three environments

The repository keeps three strictly separated environments; the tooling of one never
leaks into the others.

### Development

```bash
pnpm install

# UI development without any PostgreSQL server: a dev backend runs the REAL API
# (Fastify + Zod + projects + Drizzle) on PostgreSQL-in-process (PGlite) with the
# real migrations and the official 1404 dataset, and seeds one demo project through
# the real HTTP API:
node --conditions=source --import tsx apps/web/scripts/dev-backend.ts   # API on 127.0.0.1:3001
pnpm --filter @costgenius/web dev                                       # UI on :5173, /api proxied

# full stack against a real PostgreSQL server:
DATABASE_URL=postgres://… pnpm --filter @costgenius/api start           # API on :3000
pnpm --filter @costgenius/web dev
```

`pnpm check` (format check + lint + type-check + tests) is the development
verification loop; `pnpm build` produces the package and web artifacts.

### E2E / Test

- Component/integration tests: Vitest per package. The API test suite runs the full
  HTTP chain against PGlite (in-process PostgreSQL) with the real migrations and
  dataset; the node-postgres → server legs run only when
  `COSTGENIUS_SMOKE_DATABASE_URL` is provided (otherwise reported `NOT RUN`).
- Browser E2E: a **real Chromium** (npm-distributed binary; the Playwright CDN is not
  used) drives the production web build against the real API on **PGlite** —
  in-process PostgreSQL with the real migrations, **not** a PostgreSQL server. The
  PostgreSQL-server leg is proven by the production smoke below, not by E2E.

```bash
pnpm --filter @costgenius/web e2e   # deterministic lifecycle, fixed ports 3101/4173
```

### Production

- **API** — a standalone Node process: Fastify + Zod over `@costgenius/projects` and
  `@costgenius/db` (Drizzle, node-postgres) → PostgreSQL. The service executes its
  TypeScript source directly via `tsx`, a declared **runtime** dependency (a
  deliberate, documented decision — no separate build step for the API; see
  [DEPLOYMENT.md](DEPLOYMENT.md)). Migrations are applied automatically at startup,
  before the server listens; startup fails closed on a missing/malformed
  `DATABASE_URL` or an unreachable database.
- **Web** — `pnpm --filter @costgenius/web build` emits a static `dist/` (no
  server-side code, no workspace package in the browser bundle), served same-origin
  behind a reverse proxy that forwards `/api/*` to the API process. No CORS
  configuration exists by design.
- **Environment** — `DATABASE_URL` is required (no fallback, no default secret).
  Optional: `PORT` (default `3000`), `HOST` (default `0.0.0.0`), `DATASET_PATH`
  (default: the bundled 1404 dataset).
- **Operations** — `/health` is liveness-only (`{"status":"ok"}`);
  `SIGTERM`/`SIGINT` → stop accepting requests → close Fastify → end the pool →
  exit 0.

```bash
pnpm build --force
DATABASE_URL=postgres://… pnpm --filter @costgenius/api start
```

### Production smoke (real PostgreSQL)

```bash
pnpm --filter @costgenius/api run smoke:production
```

Boots a **real PostgreSQL 16.9 server** (npm binaries — no Docker), runs the **real
production entry** against it and verifies over real HTTP: fail-closed startup
scenarios, fresh-database migrations (schema, constraints, indexes, exact numerics,
JSONB snapshots, migration journal, zero seed data), the full golden workflow (exact
`69011321.1668`), finalized immutability (409), the append-only v2 story with a
NULL-price line (total stays NULL, never 0), byte-deterministic Excel/PDF with
content-verified sharedStrings, transport error hygiene, graceful shutdown (exit 0)
and restart idempotency (journal + row counts unchanged). Details:
[DEPLOYMENT.md](DEPLOYMENT.md).

## Commands

| Command                                              | Purpose                                    |
| ---------------------------------------------------- | ------------------------------------------ |
| `pnpm install`                                       | Install dependencies                       |
| `pnpm check`                                         | Format check + lint + type-check + tests   |
| `pnpm lint` / `pnpm typecheck` / `pnpm test`         | The individual gates                       |
| `pnpm build [--force]`                               | Build packages + the web production bundle |
| `pnpm --filter @costgenius/web e2e`                  | Real-browser E2E (Chromium 153)            |
| `pnpm --filter @costgenius/api run smoke:production` | Production smoke on real PostgreSQL        |

## Layout

```
apps/       web (React UI), api (Fastify API), worker (scaffold)
packages/   implemented: domain, calc-engine, pricebook, cost-calculation, boq,
            projects, db, reporting, reporting-excel, reporting-pdf
            scaffolds:  market-prices, audit, ai-assist, contracts, i18n, ui
```

The pure core (`domain`, `calc-engine`) is lint-restricted from importing I/O modules,
outer layers, `Math.random` and `Date.now`.

## Data policy

The only price data in this repository is the **official 1404 price book** (فهرست
بهای واحد پایه رشته ابنیه ۱۴۰۴): the source PDF at the repository root and the
verified staged dataset in `packages/pricebook/data/`, bound to the source file by
its SHA-256 (`c49e3155…16fae0f`) — asserted by the pricebook test suite together
with the row count (1564). The dataset is immutable: no row, price, unit or status
mutations, no old-edition imports, no regional values. No other prices, coefficients
or regulations live in the repository, and the database is never the price master.
