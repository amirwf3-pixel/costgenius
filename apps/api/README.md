# @costgenius/api

Minimal production API (Phase 15) over the estimate vertical slice, the D-016
Full Takeoff resource family (Phase 3), and the P8-A S1+S2 governance layer
(CG-GOV §1–§3 — local accounts, server-side sessions, role-based access control):

```
HTTP → Fastify → Zod → @costgenius/projects (application layer)
                        → repository contracts → @costgenius/db (Drizzle)
                        → node-postgres → PostgreSQL
```

## Endpoints

| Method | Path                                                      | Purpose                                                                                                                                              |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /health                                                   | liveness (public — the only unauthenticated route besides /auth/login)                                                                               |
| POST   | /auth/login                                               | issue the `cg_session` cookie (P8-A S1); wrong credentials → uniform `401 AUTH_INVALID_CREDENTIALS`                                                  |
| POST   | /auth/logout                                              | revoke the session row and clear the cookie (204) — any authenticated role                                                                           |
| GET    | /auth/session                                             | the current user projection `{userId, username, role, expiresAt}` — any authenticated role                                                           |
| POST   | /auth/password                                            | change password (validates the current one; revokes every OTHER session) — self-service                                                              |
| POST   | /users                                                    | create a user (P8-A S2, org_admin only); duplicate → `409 USERNAME_ALREADY_TAKEN`                                                                    |
| GET    | /users                                                    | list every account, no hashes (org_admin only)                                                                                                       |
| POST   | /users/:userId/role                                       | change a user's role (org_admin only); last-active-org_admin demotion → `409 CANNOT_DEACTIVATE_LAST_ORG_ADMIN`; unknown → `404 USER_NOT_FOUND`       |
| POST   | /users/:userId/deactivate                                 | soft-deactivate + revoke every session (org_admin only); self → `403 FORBIDDEN`; last admin → `409`                                                  |
| POST   | /projects                                                 | create project (201)                                                                                                                                 |
| GET    | /projects                                                 | list projects                                                                                                                                        |
| GET    | /projects/:projectId                                      | reload project                                                                                                                                       |
| POST   | /projects/:projectId/estimates                            | create estimate (201)                                                                                                                                |
| GET    | /projects/:projectId/estimates                            | list the project's estimates                                                                                                                         |
| GET    | /estimates/:estimateId                                    | reload the aggregate                                                                                                                                 |
| POST   | /estimates/:estimateId/versions                           | start a draft version (201)                                                                                                                          |
| GET    | /pricebook/rows                                           | presentation-only pricebook search for the add-line dialog (capped at 50)                                                                            |
| GET    | /estimate-versions/:versionId                             | finalized bundle or draft version                                                                                                                    |
| POST   | /estimate-versions/:versionId/lines                       | add BOQ lines (exact-code binding; per line exactly one of `quantity` \| `takeoff` — D-015)                                                          |
| POST   | /takeoff/quantities/preview                               | stateless dimensional quantity preview (D-015, exact-only)                                                                                           |
| POST   | /estimate-versions/:versionId/calculate                   | S4 preview (not persisted)                                                                                                                           |
| POST   | /estimate-versions/:versionId/finalize                    | finalize + persist atomically (201)                                                                                                                  |
| GET    | /estimate-versions/:versionId/render/excel                | XLSX from the reloaded snapshot                                                                                                                      |
| GET    | /estimate-versions/:versionId/render/pdf                  | PDF from the reloaded snapshot                                                                                                                       |
| POST   | /projects/:projectId/takeoffs                             | create a takeoff draft — new chain, documentNumber 1 (201, D-016)                                                                                    |
| GET    | /projects/:projectId/takeoffs                             | the project-scoped takeoff list — pure projection rows, all statuses, (takeoffId, documentNumber) order (P7-S1)                                      |
| GET    | /projects/:projectId/takeoffs/:documentId                 | the document (draft/archived) or the finalized bundle (the version-route convention)                                                                 |
| POST   | /projects/:projectId/takeoffs/:documentId/save            | full-document replace under `expectedRevision` (G4=B; revision +1)                                                                                   |
| POST   | /projects/:projectId/takeoffs/:documentId/archive         | soft archive (G1b=C; content and revision unchanged)                                                                                                 |
| POST   | /projects/:projectId/takeoffs/:documentId/unarchive       | restore an archived draft (content and revision unchanged)                                                                                           |
| POST   | /projects/:projectId/takeoffs/:documentId/finalize        | calculate via the domain + persist the immutable snapshot atomically (201)                                                                           |
| POST   | /projects/:projectId/takeoffs/:documentId/calculate       | stateless draft calculation preview: engine result verbatim, nothing persisted (P7-S2; failures 422 TAKEOFF_SOLUTION_REJECTED with details.failures) |
| POST   | /projects/:projectId/takeoffs/:documentId/follow-up       | copy a finalized document as the chain's next draft (documentNumber +1)                                                                              |
| POST   | /projects/:projectId/takeoffs/:documentId/transfer-to-boq | transfer the FINALIZED takeoff into a draft estimate version (G2=B; one BOQ line per itemCode itemTotal)                                             |
| GET    | /projects/:projectId/takeoffs/:documentId/render/excel    | takeoff XLSX from the finalized snapshot only (D-016 Phase 6, G6=A)                                                                                  |
| GET    | /projects/:projectId/takeoffs/:documentId/render/pdf      | takeoff PDF from the finalized snapshot only (D-016 Phase 6, G6=A)                                                                                   |

## Contract rules

- **Authentication (P8-A S1, CG-GOV §1)**: every route except `/health` and
  `POST /auth/login` requires the `cg_session` cookie — HttpOnly, `SameSite=Strict`,
  `Secure` on https, `Path=/`, 12-hour absolute expiry — else `401 UNAUTHENTICATED`.
  Passwords are scrypt records (`scrypt$16384$8$1$…`, constant-time verify, 8–128
  characters, username `^[a-z0-9._-]{3,64}$`); the 256-bit session token exists only in
  the cookie while the database stores its SHA-256; logout and deactivation delete
  session rows; password change revokes every other session. The first boot
  **fail-closed** bootstrap reads `CG_BOOTSTRAP_ADMIN_USERNAME`/`_PASSWORD` (one
  `org_admin` on an empty users table, or a non-zero exit; ignored once any user
  exists — no default credential is ever invented). Login failures are uniform —
  unknown username and wrong password answer the same `401 AUTH_INVALID_CREDENTIALS`
  with no timing-independent detail beyond the code; no password, hash or token ever
  appears in a response or a log line. Roles are NOT enforced yet (S2): the `role`
  value is carried on the session projection only. No CORS, no JWT, no new auth
  dependency — `node:crypto` only.
- **Authorization (P8-A S2, CG-GOV §2/§3)**: one central route-policy table
  (`src/authz.ts`) decides in the session gate, BEFORE any handler logic, whether the
  authenticated role satisfies the route's class — otherwise `403 FORBIDDEN` with
  `details:{requiredRole}` (authentication failures stay 401; authorization is never
  a 404). The classes: user management = `org_admin`; domain mutations and the
  stateless previews = estimator+ (`org_admin`, `estimator`); every read, render and
  export = viewer+ (ALL five roles); the `/auth` surface = any authenticated role.
  A route missing from the policy table fails closed to `org_admin`. The five roles
  are exactly `org_admin, estimator, reviewer, viewer, data_steward` (global — one
  role per user; no project scoping, no permissions tables); the lattice is
  org_admin ⊇ estimator/reviewer/viewer/data_steward, and estimator/reviewer/
  data_steward ⊇ viewer. The approve routes (#37/#38 of the §3 matrix) are S4 scope
  and are not registered yet.
- **Decimals are strings** (`"quantity": "12.5"`); JSON numbers are rejected with 400.
- **No client prices**: line payloads are strict-schema — `basePrice`/`unitPrice`/
  `lineAmount` are rejected. Prices come only from the verified 1404 pricebook (S2/S3).
- **Exact-code binding only** — no fuzzy/nearest/prefix matching; `70612` is not `010101`.
- **Exact units** — `ton_km ≠ t`, `m2_month ≠ m2`; no conversion.
- **Errors are stable JSON** `{error:{code,message,details?}}`; domain codes surface
  verbatim (PRICEBOOK_ROW_NOT_FOUND, UNIT_MISMATCH, INVALID_DECIMAL, UNKNOWN_UNIT,
  FINALIZED_ESTIMATE_IMMUTABLE, PERSISTENCE_CONFLICT, …); no stack traces in responses.
- Rendering a **draft** version answers `409 VERSION_NOT_FINALIZED` — only a finalized
  snapshot has an immutable report to render. The takeoff render routes follow the same
  convention: a draft answers `409 TAKEOFF_NOT_FINALIZED`; a document of another project
  is a bare 404 (isolation before lifecycle disclosure).
- The clock is injected (`createApiServer({..., clock})`); the server never reads it.
- **D-015 dimensional quantities** (S1 units `m`/`m2`/`m3`/`each` only): a line may
  carry `takeoff` factors (`kind`, `unit`, `count`, and the unit's required dimensions)
  instead of `quantity` — never both. The **server** computes the quantity via the
  frozen calc-engine and persists the provenance on `boq_lines.trace.takeoff`
  (`{input, output, specVersion, engineVersion}`); a client-computed quantity or
  provenance is never trusted. Quantities are exact-only: a `rounding` field is
  rejected. `POST /takeoff/quantities/preview` is stateless (no estimate context, no
  persistence) and answers `{specVersion, engineVersion, items:[{lineId, quantity,
unit, takeoff}]}`. Engine error codes are never public (`UNIT_MISMATCH`/
  `INVALID_DECIMAL` collide with existing public codes): every engine failure is the
  single stable code `TAKEOFF_QUANTITIES_REJECTED` (422) with the engine's own errors
  only under `details.failures`. Negative quantities are rejected
  (`NEGATIVE_QUANTITY` in `details.failures` of `BOQ_LINES_REJECTED`) — a deduction is
  a priced کسر بها row or the engine's `kind` semantics, never a signed quantity.

- **D-016 Full Takeoff** (a stateful resource family beside the unchanged D-015 preview):
  - **Addressing is by `documentId`** — the per-revision identity CG-FT §2.2 fixes as the
    API identity; `takeoffId` is the chain a follow-up continues. Every route is
    project-scoped: a document of another project is indistinguishable from a missing one
    (404, no cross-project existence disclosure).
  - **Mutations are POST-only** (CG-FT §4) and every mutation body carries
    `expectedRevision`. A stale revision is `409 PERSISTENCE_CONFLICT` — no
    last-write-wins, no silent merge, no partial mutation; the persisted revision is the
    only authority and `save` is a FULL-document replace (title, sheets, lines, rounding).
  - **Lifecycle**: `draft → archived → draft` (soft, reversible, content byte-identical)
    and `draft → finalized` (one-way, atomic with the immutable `finalized_takeoffs`
    snapshot — byte-compared, never rewritten). Editing, archiving or finalizing a
    non-draft, unarchiving a non-archived document, or a follow-up from a draft are `409
TAKEOFF_INVALID_TRANSITION`; a sequential re-finalize is also a 409 (the domain guard
    fires first — concurrent identical finalizations may both succeed via store
    idempotency). Finalization runs `calculateTakeoff` through the domain: a
    non-calculating draft is `422 TAKEOFF_CALCULATION_FAILED` (engine codes in the
    message) with NOTHING finalized. The stateless draft preview
    (`POST …/calculate`, P7-S2) is the second, distinct layer (D-ERROR=C): it solves the
    persisted draft through the same engine, returns the result verbatim, persists and
    mutates nothing, is never BOQ-transferable, and answers engine failure with `422
TAKEOFF_SOLUTION_REJECTED` + structured `details.failures` (codes never in the
    message; never an alias of TAKEOFF_CALCULATION_FAILED).
  - **Quantities are the approved structured trees** (CG-FT §6): a closed discriminated
    union (`dimensional` L/LW/LWH/count + separate `floorCount`/`similarCount`,
    `reference` terms, `expression` nodes `const`/`ref`/`add`/`mul`/`sub`/`round`,
    `manual` value + mandatory justification). Division, powers, π and arbitrary
    functions do not exist on the wire — a malformed tree is a `400 INVALID_REQUEST`
    before any engine call; decimal SEMANTICS (syntax, profile fit, reference resolution)
    stay in the engine and surface at finalization. Decimals are exact STRINGS on the way
    in and out — `1.005` never passes through a JavaScript number.
  - **Rounding is explicit and design-authored only** (R1=A/R3=A): the document's
    `rounding` rule set travels verbatim to the engine — no default, no accumulate-rounded,
    no organization policy. A rule with `sourceStatus` ≠ `"design"` is an authoring-policy
    `422 TAKEOFF_DOCUMENT_REJECTED` (nothing saved). Exact values are always computed and
    retained; a matching rule rounds ONCE at its target; `itemTotal.qty` is the rounded
    value iff a rule matched, otherwise the exact value.
  - **V1 authors `origin: "user"` lines only** (CG-FT §13 — `import`/`ai-accepted` are
    reserved and rejected at the edge).
  - Responses are the canonical domain representations (document, or the finalized bundle
    `{document, finalizedAt, input, result}` after finalization) — never raw DB rows;
    sheet order (array position) and line order (`rowNo`) are preserved exactly.

- **D-016 Takeoff → BOQ transfer (G2=B, Phase 4)** —
  `POST /projects/:projectId/takeoffs/:documentId/transfer-to-boq` with `{versionId}`:
  - **Source**: only a FINALIZED takeoff (the immutable snapshot — never mutable draft
    rows); draft/archived sources are `409 TAKEOFF_INVALID_TRANSITION`. **Target**: a
    DRAFT estimate version of the SAME project (bare 404 on wrong project or unknown
    identity; a finalized target is the existing `409 VERSION_FINALIZED`).
  - **One BOQ line per itemCode itemTotal** — never one per Takeoff line: the engine's
    own `result.itemTotals` is the only aggregation (this layer never re-sums, never
    rounds). The BOQ quantity is the itemTotal's effective `qty` VERBATIM (R2=C: rounded
    iff an item-total rule matched, otherwise the exact aggregate); exact decimals are
    strings end to end and S2/S3/S4 never re-round.
  - **Line identity is deterministic** (`tk-<documentId>-<itemCode>`), so a repeated
    transfer can never duplicate: a second transfer of the same source is
    `422 TAKEOFF_TRANSFER_REJECTED` with `ALREADY_TRANSFERRED` in
    `details.failures`. Unrelated manual lines (same itemCode or not) are never merged or
    overwritten — they coexist with their own identities.
  - **All-or-nothing**: any itemCode that fails the existing S2 binding
    (`PRICEBOOK_ROW_NOT_FOUND`, `UNIT_MISMATCH`, … in `details.failures`) rejects the
    whole transfer and the estimate version is unchanged; the commit is the store's
    single append-only transaction. Concurrent identical transfers serialize on the
    version row — the second commits as a byte-identical no-op, never a duplicate.
  - **Uncoded itemTotals are never transferred** — they stay in the Takeoff and are
    reported as `skipped` (no blank-code BOQ line, no inferred code, no invented price).
  - **Provenance**: every transferred line carries `trace.takeoffDocument`
    (CG-FT §8.1: `takeoffDocumentId`, `takeoffId`, `documentNumber`, `itemCode`, `unit`,
    contributing `lineIds`, `exactQty`, `roundedQty?`, `qty`, `specVersion`,
    `engineVersion`) — separate from D-015's `trace.takeoff`, answering "which Takeoff
    lines produced this BOQ line?". The matched item-total rule entry is deliberately
    not duplicated here (the frozen engine result does not expose it; the complete rule
    set stays in the finalized snapshot's `input.rounding`).
  - **Success (200)** answers `{transferred: [{itemCode, unit, lineId, quantity,
lineIds, exactQty, roundedQty?}], skipped: [...], lines: [{lineId, pricebookCode,
quantity, unit, lineAmount, calculationStatus}]}`; the transferred version then
    calculates/finalizes through the unchanged S2/S3/S4 workflow (verified byte-parity
    with the equivalent manual line in `packages/projects/test/takeoff-transfer.test.ts`).

## Running

Embedded (composition root):

```ts
import { main } from '@costgenius/api';
await main(); // reads DATABASE_URL (+ optional PORT/HOST/DATASET_PATH), migrates, listens
```

Standalone production process:

```bash
DATABASE_URL=postgres://… pnpm --filter @costgenius/api start
# node --conditions=source --import tsx src/main.ts — config → pool → migrations → listen,
# SIGTERM/SIGINT → graceful shutdown (exit 0)
```

Production-path smoke test against a **real PostgreSQL server** (embedded binaries from
npm — no Docker needed):

```bash
pnpm --filter @costgenius/api run smoke:production
```

It verifies startup/migrations on a fresh database, the full golden workflow over real
HTTP (exact `69011321.1668`), finalized immutability, byte-deterministic Excel/PDF,
transport-error hygiene (malformed JSON → 400 `INVALID_REQUEST`, oversized body → 413
`PAYLOAD_TOO_LARGE`, unknown route → stable 404), graceful shutdown (exit 0) and
restart idempotency. See `/DEPLOYMENT.md` for the full deployment guide.

Tests run the full HTTP chain against real in-process PostgreSQL (PGlite) with the
actual migrations. The node-postgres → PostgreSQL **server** leg is verified by
`test/node-postgres-smoke.test.ts`, which runs only when
`COSTGENIUS_SMOKE_DATABASE_URL` is set (a disposable database) and otherwise reports
`NOT RUN — environment not available`.

## Production readiness (Phase 16)

- **Lifecycle** — `startApi(config)` builds pool → migrations → repositories → listens
  (startup fails closed when the database is unreachable). `RunningApi.stop()` performs
  the ordered shutdown: stop accepting requests → close Fastify → end the pool.
  `main()` wires `SIGTERM`/`SIGINT` to that shutdown and exits 0/1 by outcome. Signal
  wiring is thin (`process.once` → `stop`); the shutdown itself is covered by the
  env-gated lifecycle test.
- **/health is liveness-only** (by contract: `{status:"ok"}` while the process lives).
  Database unavailability after startup surfaces on data routes as the stable
  `500 INTERNAL_ERROR` body — no driver detail, no stack traces, no credentials.
  A `/readiness` split was evaluated and deliberately NOT added: no orchestrator in
  the current architecture consumes it (fail-closed startup + deterministic 500s is
  the deployed posture).
- **Config** — `DATABASE_URL` is required and must be `postgres://` or `postgresql://`
  (no fallback database, no default secret); `PORT` must be a TCP port; `HOST` and
  `DATASET_PATH` keep documented defaults.
- **Workflow (Phase 17)** — the full production story runs over HTTP and is regression-
  tested end-to-end (`test/workflow.test.ts`, against PGlite always and against a real
  PostgreSQL server when `COSTGENIUS_SMOKE_DATABASE_URL` is set): create project →
  create estimate → start v1 → add real 1404 lines → calculate (review) → finalize →
  reload (canonical snapshot equality) → render Excel/PDF (byte-deterministic) →
  create v2 → revise → recalculate → v1 byte-unchanged. The golden fixture lives in
  `test/golden-estimate.ts` (010101/270320/270403/220925/090320 — null stays null,
  negatives stay negative, leading zeros stay text).
- **Concurrency (verified on a real server)** — finalization and line-append on the
  same version serialize on the version row (`SELECT … FOR UPDATE` in `syncEstimate`);
  the loser fails with a stable 409-contract error and the finalized snapshot always
  matches the stored `boq_lines` rows. `test/node-postgres-concurrency.test.ts` (same
  env gate as the smoke test) verifies immutability across connections, the
  finalize/append race, identical/different concurrent finalizations, transaction
  rollback and atomic finalization.
