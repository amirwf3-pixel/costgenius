# CostGenius — Deployment Guide

Production architecture (verified by the production smoke test — see below):

```
Browser
→ static web build (apps/web/dist — plain files, no server-side code)
→ same-origin reverse proxy: /api/* → API process
→ API (apps/api — Fastify + Zod + domain packages, TS entry via tsx)
→ projects/domain layer (Drizzle)
→ PostgreSQL (node-postgres pool; exact numeric columns, JSONB finalized snapshots)
```

The web app is a pure HTTP consumer: no database access, no pricebook dataset, and no
workspace package in the browser bundle (enforced by ESLint and verified by bundle
inspection). The official 1404 pricebook dataset is loaded by the API from
`DATASET_PATH` (in-memory); it is **not** copied into the database.

## Environment variables (API)

| variable                      | required                    | default                                                    | validation / behavior                                                                                          |
| ----------------------------- | --------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | **yes**                     | —                                                          | must be `postgres://` or `postgresql://`; no fallback, no default secret. Startup **fails closed** without it. |
| `PORT`                        | no                          | `3000`                                                     | must be a valid TCP port.                                                                                      |
| `HOST`                        | no                          | `0.0.0.0`                                                  | bind address (all interfaces by default — set `HOST=127.0.0.1` to restrict).                                   |
| `DATASET_PATH`                | no                          | the published 1404 dataset bundled in `packages/pricebook` | path to the published dataset JSON.                                                                            |
| `CG_BOOTSTRAP_ADMIN_USERNAME` | first boot only (see below) | —                                                          | the initial `org_admin` username (`^[a-z0-9._-]{3,64}$`).                                                      |
| `CG_BOOTSTRAP_ADMIN_PASSWORD` | first boot only (see below) | —                                                          | the initial `org_admin` password (8–128 characters).                                                           |

Web (build time only): `VITE_API_BASE_URL` overrides the API base (default `/api` —
same-origin). Dev-only: `VITE_API_PROXY_TARGET` (vite dev/preview proxy target).

No secrets live in the source tree; the database credential and the first-boot
bootstrap password enter the runtime only through the environment.

## First boot — the bootstrap admin (P8-A S1, fail closed)

Since Phase 8 S1 the API authenticates every request (CG-GOV §1): all routes except
`/health` and `POST /auth/login` require the `cg_session` cookie issued by login.
A database with **zero users cannot serve any login** — so the first boot is explicit:

1. On an **empty** `users` table the API creates exactly **one** `org_admin` from
   `CG_BOOTSTRAP_ADMIN_USERNAME` / `CG_BOOTSTRAP_ADMIN_PASSWORD`, then serves.
2. On an empty `users` table **without** both variables, startup **fails closed**
   (non-zero exit before listening) — a half-bootstrapped instance never accepts
   requests, and no default credential is ever invented.
3. Once **any** user exists, both variables are **ignored** (restarts need nothing
   special; re-running them never creates or changes an account).

The bootstrap password is used once to derive the stored scrypt hash
(`scrypt$16384$8$1$…`); it is never logged and never returned by any route. Choose
the credential the same way as `DATABASE_URL` — from your secret manager/environment,
not from the source tree.

```bash
# first boot (fresh database):
DATABASE_URL=postgres://… \
CG_BOOTSTRAP_ADMIN_USERNAME=admin \
CG_BOOTSTRAP_ADMIN_PASSWORD='<a 8–128 character secret>' \
pnpm --filter @costgenius/api start
# every later boot: DATABASE_URL alone (the variables are ignored)
```

## Build

```bash
pnpm install
pnpm build --force      # tsc for packages + vite build for apps/web (3 tasks)
```

Artifacts: compiled package outputs + `apps/web/dist` (static files incl. hashed fonts
and `favicon.svg`; no sourcemaps, no dev/test code, no Node builtins — verified).

## Run the API (production)

```bash
DATABASE_URL=postgres://user:pass@host:5432/costgenius \
PORT=3000 \
pnpm --filter @costgenius/api start
# equivalent to: node --conditions=source --import tsx apps/api/src/main.ts
```

Startup order (fail-closed): config validation → connection pool → **Drizzle
migrations** → listen → `/health`. If the database is unreachable the process exits
with an error and never accepts requests. `tsx` is a declared runtime dependency of
`apps/api` (the service ships TypeScript source; no build step needed for the API).

- `/health` is **liveness only**: `{"status":"ok"}` while the process lives. Database
  trouble after startup surfaces on data routes as the stable
  `500 INTERNAL_ERROR` body (no driver detail, no stack traces). A `/readiness`
  endpoint was deliberately NOT added (documented Phase 16 decision: no orchestrator
  consumes it in the current architecture).
- Graceful shutdown: `SIGTERM`/`SIGINT` → stop accepting requests → close Fastify →
  end the pool → exit code 0.

## Migrations

Applied automatically at startup (`migrateDatabase`, Drizzle journal-based). Fresh
database → full schema (tables, FKs, unique constraints, indexes, exact `numeric`
columns, JSONB snapshot columns). Re-running against an already-migrated database is a
journal-based no-op (idempotent) — verified by the restart leg of the smoke test. No
seed data is ever inserted; the 1404 pricebook is not a database table.

## The application database role (P8-A S3 — append-only)

The audit trail's append-only guarantee is enforced by PostgreSQL itself, not only by
application discipline: the API's database role may INSERT into `audit_events` but
never UPDATE or DELETE it. The production smoke provisions and verifies exactly this
role (`cg_smoke_app` there) — for a real deployment, provision the application role
with this exact grant set:

```sql
CREATE ROLE <app_role> LOGIN PASSWORD '<secret>';
GRANT USAGE ON SCHEMA public TO <app_role>;
-- the Drizzle migrator runs `CREATE SCHEMA IF NOT EXISTS "drizzle"` on every boot,
-- and PostgreSQL checks the privilege even when the object already exists:
GRANT CREATE ON DATABASE <database> TO <app_role>;
-- the application's own tables: full CRUD on the domain/governance tables …
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO <app_role>;
-- … the migrator's journal bootstrap (`CREATE TABLE IF NOT EXISTS
-- "drizzle"."__drizzle_migrations"`) also needs CREATE on the drizzle schema:
GRANT USAGE, CREATE ON SCHEMA drizzle TO <app_role>;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO <app_role>;
-- … everything granted, EXCEPT the audit history (INSERT/SELECT only — append-only):
REVOKE UPDATE, DELETE ON TABLE audit_events FROM <app_role>;
```

(This is the exact grant sequence the production smoke enforces and verifies.)

Why the two `CREATE` grants do **not** weaken append-only: they allow creating NEW
objects (a schema, the migration journal table when absent) — the `REVOKE` is at the
TABLE level and covers `UPDATE`/`DELETE` on the existing `audit_events` regardless.
The role cannot alter the table, its privileges, or drop it (it is not the owner).
Removing the `CREATE` grants is possible only if migrations are run by a separate
owner role before the application connects; as deployed, the API runs migrations at
boot and therefore needs them. The 42501 denials are asserted by the env-gated
real-PostgreSQL test suite and by the smoke's direct tamper probes from a
role-connected client.

## Serve the web build

`apps/web/dist` is static. Any static host + a reverse proxy that forwards `/api/*`
(same-origin) to the API process. `vite preview` does exactly this for local checks:

```bash
VITE_API_PROXY_TARGET=http://127.0.0.1:3000 \
pnpm --filter @costgenius/web preview
```

Cross-origin deployments instead set `VITE_API_BASE_URL` at **build** time. CORS: the
API ships no CORS configuration on purpose — the supported deployment is same-origin
(web behind one origin, `/api` proxied). No wildcard permissive CORS was added.

## Production smoke test (real PostgreSQL)

```bash
pnpm --filter @costgenius/api run smoke:production
```

Boots a **real PostgreSQL 16.9 server** (binaries from the npm package
`embedded-postgres` — no Docker, no external downloads), runs the **real production
entry** (`src/main.ts`) against it and verifies, over real HTTP:

- **fail-closed startup** (§18): missing `DATABASE_URL`, malformed `DATABASE_URL` and
  an unreachable database each exit non-zero, promptly, with no unhandled-rejection
  noise and without ever listening;
- startup + migrations on a fresh database, fresh-schema assertions (exactly the
  twelve tables — the nine domain tables plus `users`, `sessions`, `audit_events` —
  FKs, unique constraints, indexes, exact `numeric` columns, JSONB snapshot columns,
  migration journal) and an **empty database** (no seed, the 1404 pricebook is not a
  DB table);
- the full workflow (golden chain `69011321.1668`), finalized immutability (409), the
  append-only v2 story with a NULL-price line (total stays NULL, never 0;
  v1's Excel stays byte-identical);
- byte-deterministic Excel/PDF with content verification (sharedStrings preserve the
  exact decimals; the PDF carries a valid `%%EOF` trailer);
- error hygiene (malformed JSON → 400, unknown route → stable 404, no stack/SQL in
  the API log);
- graceful shutdown (exit 0), restart (idempotent migrations — journal and row counts
  unchanged — persisted data, identical Excel bytes);
- the **S3 audit blocks**: user-management/auth/domain events with exact payloads and
  actors (`user.created`, two null-actor `auth.login_failed`, `auth.login_succeeded`,
  `auth.password_changed`, `project.created`, `estimate_version.created`, the
  `boq_lines.added` batch event, `estimate_version.finalized` with the golden
  `69011321.1668`), zero events for denied/failed mutations, an audit history that
  survives the restart byte-identically, and a second restart **as a restricted
  application role** that still writes events while direct `UPDATE`/`DELETE` on
  `audit_events` answer PostgreSQL `42501` (append-only enforced at the DB layer).

## Verification commands

```bash
pnpm format:check && pnpm lint && pnpm typecheck   # pnpm check runs all three + tests
pnpm test                                           # full workspace suite
pnpm build --force                                  # production builds
pnpm --filter @costgenius/web e2e                   # real-browser E2E (Chromium 153)
pnpm --filter @costgenius/api run smoke:production  # production path on real PostgreSQL
```

## Known limitations

- **Docker/container artifact: NOT PROVIDED.** No Docker daemon is available in the
  build environment, so no container was built or tested — providing one untested
  would be a false claim. A container should: install with `pnpm install --prod`
  semantics for the API (runtime deps: `tsx`, `fastify`, `zod`, `pg` via
  `@costgenius/db`, workspace packages as source), run `pnpm --filter @costgenius/api
start` with `DATABASE_URL`, and serve `apps/web/dist` behind a proxy. Every piece of
  that path is what the smoke test exercises natively.
- Single-process API; horizontal scaling was not in scope and is untested.
- The dataset path default assumes the bundled 1404 dataset; `DATASET_PATH` overrides it.
- Authentication, role-based authorization and the append-only audit trail are
  implemented (Phase-8 S1+S2+S3, CG-GOV §1–§4): local accounts, server-side 12-hour
  sessions, password change, five global roles (`org_admin`, `estimator`, `reviewer`,
  `viewer`, `data_steward`), a centralized route-policy matrix, org_admin-only user
  management via the `/users` routes, and the 20-event audit catalog written in the
  same transaction as the mutation (DB-level `UPDATE`/`DELETE` denial for the
  application role — see the section above). Reviewer sign-off (S4) is
  **implemented** (the #37/#38 approve routes — Reviewer+, four-eyes, irreversible;
  approval state persisted on the finalized tables); there is deliberately NO audit read API or
  UI in V1.1 (ops reads `audit_events` directly in PostgreSQL).
- Managing users today means the `/users` API surface (no admin UI yet — deliberately
  out of the S2 UI scope).
- Login rate limiting and CSRF tokens are deliberately deferred (CG-GOV §1.7/§1.8);
  the API must not be exposed beyond a trusted same-origin proxy in the meantime.
