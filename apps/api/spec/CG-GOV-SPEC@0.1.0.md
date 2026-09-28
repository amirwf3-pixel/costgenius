# CG-GOV-SPEC@0.1.0: Governance & Trust Specification (Authentication · Roles · Audit · Sign-off)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spec ID         | `CG-GOV`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Version         | `0.1.0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Status          | **P8-A S0 closed + S1 + S2 + S3 IMPLEMENTED (2026-09-28); S4 NOT STARTED.** §1 (authentication), §2/§3 (roles + the route matrix, incl. the §2.3 user-management routes and guard rails), §4 (the append-only audit writer: the 20-event catalog, session-derived actors, same-transaction writes, DB-level UPDATE/DELETE denial for the application role), §7 (migration `0002_p8_governance`), §8 (the 401/403/409/404 codes of S1+S2) and §9 (the test contract, incl. the §4 audit proofs) are implemented and verified; §5 (sign-off, incl. the #37/#38 approve routes) remains contract-only. |
| Owner decisions | D-P8-1 = A (governance layer) · D-P8-2 = A (single organization, local accounts, server-side sessions) · D-P8-3 = A (minimal sign-off) — recorded in `DECISIONS.md` D-018                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Home            | `apps/api` — the enforcement surface (HTTP authentication/authorization); the audit and sign-off contracts cross into `packages/projects` and `packages/db` as described in §6                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Supersedes      | nothing (first version)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Preserves       | `CG-RCS@0.1.0` (frozen) · `CG-IR-MEAS@0.2.0` · `CG-FT-TAKEOFF@0.2.0` · all D-015/D-016/D-017 behavior and error codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Implementation status (maintained with the implementation)

| Stage | Contents                                    | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S0    | this contract                               | **COMPLETE** (2026-09-28)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| S1    | §1 authentication + §7 migration + §8 codes | **COMPLETE** (2026-09-28, the owner's S1 execution order): migration `0002_p8_governance.sql` (12 tables; 0000/0001 untouched), the `users`/`sessions` repositories and contracts, `apps/api/src/auth.ts` (scrypt N=16384/r=8/p=1, constant-time verify, 256-bit token, SHA-256-only storage), the four `/auth` routes (28→32), the Fastify auth gate (`401 UNAUTHENTICATED`; `/health` and `/auth/login` public), the fail-closed bootstrap admin, the web login/session/logout/password-change UI, and the real-session test infrastructure (api `auth.test.ts`, web UI tests, browser E2E authenticated from a REAL login, production smoke on real PostgreSQL 16.9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| S2    | §2 roles + §3 route matrix                  | **COMPLETE** (2026-09-28, the owner's S2 execution order): the centralized policy `apps/api/src/authz.ts` (ROUTE_POLICIES = the §3 matrix as code, fail-closed to org_admin on a missing key), the gate enforcing 401-then-403 BEFORE any handler logic, the four §2.3 user-management routes (org_admin only; 32→36 routes) with the guard rails (self-deactivation 403, last-active-org_admin 409, soft deactivation + full session revocation, USERNAME_ALREADY_TAKEN 409, USER_NOT_FOUND 404), and the full test matrix (all 34 protected routes × all five real roles + anonymous, zero-side-effect denials, 403-before-404 ordering, per-role browser E2E, real-PostgreSQL + production-smoke denials). NO new migration, NO permissions tables, NO engine changes.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| S3    | §4 audit                                    | **COMPLETE** (2026-09-28, the owner's S3 execution order): the canonical append-only writer — `packages/projects/src/audit.ts` (the exact 20-event catalog as frozen builders: 14 domain §4.3 + 6 governance §4.4 with the exact action strings; the two `approved` events are built but UNREACHABLE until S4 provides the approve mutations) and the INSERT-only `DrizzleAuditEventRepository` — with `actorUserId` from the authenticated session ONLY (the org_admin as the user-management actor, never the target; `auth.login_failed`'s null actor is the contract's single null-actor, unauthenticated write path), every catalog mutation + its event(s) in ONE DB transaction on the caller's connection (failure ⇒ ZERO events; never commit-then-audit), the event appended only after the mutation reached its successful in-transaction state, details limited to the contract-approved structured fields, DB-level append-only for the application role (REVOKE UPDATE, DELETE ON audit_events — proven by env-gated real-PostgreSQL 42501 denials and the smoke's direct tamper probes), NO audit read API/UI, NO new migration (0002 already satisfied §7), NO new routes. |
| S4    | §5 sign-off                                 | **NOT STARTED** — no sign-off columns/routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 0. Scope and boundary

Phase 8 = **P8-A — Governance & Trust**, the proposed **V1.1** layer on top of the
unchanged V1 (D-V1 = A). Stages: **S0** contract closure (this document) → **S1**
authentication/session identity → **S2** minimal RBAC → **S3** actor-stamped
append-only audit → **S4** minimal reviewer sign-off. Two proven hygiene repairs ride
with Phase 8 (§12). Implementation of S1–S4 requires a separate owner execution order.

**In scope**: local accounts (username/password), server-side sessions, the five
PROJECT_SCOPE §4 roles, a route authorization matrix over the existing 28 routes, an
append-only audit trail of declared mutations, and minimal reviewer sign-off on
finalized estimate versions and finalized takeoff documents.

**Out of scope (explicitly deferred — do not build)**: organizations/membership,
multi-tenancy, PostgreSQL RLS, OAuth/external IdP, MFA, password reset, email
verification, comments/rejection/multi-stage review workflow, review assignment,
approval delegation, idle-timeout sessions, CSRF tokens (see §1.7), login rate
limiting (see §1.8), pricebook pipeline, multi-edition pricebooks, market pricing,
D-006 manual overrides, AI, drawing/OCR/CAD, صورت‌وضعیت/تعدیل, live Excel formulas,
customizable templates, worker, Docker, load testing, offline/desktop, Iranian
rounding (Q-1/Q-IR-5), division/power/π, additional disciplines.

## 1. Authentication contract (S0-A → S1)

### 1.1 User identity model

- `User = { userId: UUID, username: string, passwordHash: string, role: Role, isActive: boolean, createdAt: Instant }`.
- Single organization. There is **no organization or tenant concept** in this phase;
  every user is a member of the one implicit organization. The schema must not paint
  itself into a corner for future orgs (§7 stays additive).
- `username`: 3–64 characters, allowed set `a-z 0-9 . _ -`, **stored lowercase**
  (uniqueness is case-insensitive; login matches the normalized form). Immutable after
  creation (no rename route).
- No email field, no display-name field, no profile — out of scope.

### 1.2 Password semantics

- `password`: 8–128 characters (UTF-8), any characters allowed; no composition rules
  (no forced complexity classes — length is the policy).
- **Storage**: `scrypt` from Node's built-in `node:crypto` (no new dependency, no
  native module — preserves the deployable-without-foreign-SaaS posture, D-011).
  Parameters: `N=16384, r=8, p=1`, key length 64, per-user random 16-byte salt.
  Stored as one text field: `scrypt$<N>$<r>$<p>$<salt-hex>$<hash-hex>`.
- Verification is constant-time. The password (plain or hashed) is **never** returned
  by any API route, never written to logs, never included in audit `details`.
- Password change is self-service only: `POST /auth/password` with
  `{currentPassword, newPassword}` (see §3, new routes). No admin reset, no recovery
  flow (deferred).

### 1.3 Server-side session model

- Session = one row in `sessions`; the client holds an opaque 256-bit random token in
  a cookie; the DB stores only `SHA-256(token)` (a leaked DB does not yield usable
  tokens).
- Cookie: name `cg_session`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure`
  (set whenever the deployment serves HTTPS; the same-origin reverse-proxy posture of
  DEPLOYMENT.md is unchanged — the API adds no CORS).
- **Expiration: absolute only** — 12 hours from login. No idle/sliding timeout in this
  phase (deferred). Expired or unknown tokens are unauthenticated.
- Expired session rows are deleted lazily on lookup; logout deletes the row
  immediately. Session deletion is a normal mutation (not audit history).

### 1.4 Login / logout behavior

- `POST /auth/login` `{username, password}` → `200` with the session cookie and
  `{userId, username, role, expiresAt}`; audit `auth.login_succeeded`.
- Failure (unknown username, wrong password, or deactivated user) → **one identical
  `401 AUTH_INVALID_CREDENTIALS`** — no enumeration, no distinction in body, log, or
  audit `details` (beyond the attempted username). Audit `auth.login_failed` (§4.4).
- `POST /auth/logout` (authenticated) → `204`; the session row is deleted and the
  cookie cleared. Logout with no valid session → `401 UNAUTHENTICATED` (uniform
  unauthenticated semantics). Logout is not audited (the row deletion is the record).
- `GET /auth/session` (authenticated) → `200 {userId, username, role, expiresAt}` —
  the UI's session-validity check; expired/invalid → `401 UNAUTHENTICATED`.

### 1.5 First-user bootstrap (deployment migration)

- New env vars `CG_BOOTSTRAP_ADMIN_USERNAME` and `CG_BOOTSTRAP_ADMIN_PASSWORD`
  (validated with the same rules as §1.1/§1.2).
- At startup, **after migrations**: if the `users` table is empty and both vars are
  set → create the initial `org_admin` user; if the table is empty and they are not
  set → **startup fails closed** (exit non-zero before listening, like a missing
  `DATABASE_URL`). Once ≥ 1 user exists the vars are ignored.
- Rationale: V1.1 puts authentication in front of everything; a fresh or upgraded
  deployment must consciously declare its first administrator or it would be
  unreachable. This is a documented breaking deployment change of V1.1.

### 1.6 Authentication error contract

- Any authenticated route without a valid session → `401` body
  `{error:{code:'UNAUTHENTICATED', message:'…', details?}}` — the established
  `{error:{code,message,details?}}` shape; the code is new and reserved, existing
  codes are untouched.
- Login failure → `401 AUTH_INVALID_CREDENTIALS` (§1.4).
- Deactivated user: all their sessions are invalid immediately → `401
UNAUTHENTICATED` on every route (deactivation revokes sessions).

### 1.7 CSRF posture (accepted, deliberate)

Same-origin deployment only (DEPLOYMENT.md), `SameSite=Strict` cookie, no CORS on the
API ⇒ cross-site browser requests cannot carry the session cookie. **No CSRF token in
V1.1.** If a cross-origin deployment mode is ever added, this decision must be
revisited.

### 1.8 Rate limiting (deferred, recorded)

Login brute-force rate limiting is **deferred** for V1.1 (single-organization,
self-hosted/LAN threat model). `auth.login_failed` audit events (§4.4) provide the
detection signal. Listed here so the deferral is explicit, not accidental.

## 2. Role contract (S0-B → S2)

### 2.1 Roles — exactly the five of PROJECT_SCOPE §4, no others

| Role (machine value) | Human name   | Capability summary (V1.1)                                                                                     |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `org_admin`          | Org Admin    | everything any role can do + user management (create, list, change role, deactivate)                          |
| `estimator`          | Estimator    | all Viewer reads/exports + every domain mutation (create/edit/finalize/transfer)                              |
| `reviewer`           | Reviewer     | all Viewer reads/exports + sign-off approval on finalized versions/documents                                  |
| `viewer`             | Viewer       | read-only: all GET routes including renders/exports; no mutation, no previews                                 |
| `data_steward`       | Data Steward | Viewer reads; **no additional grants in V1.1** (role reserved for the future pricebook/market-price pipeline) |

### 2.2 Semantics

- **Global roles**: a user has exactly one role, global to the deployment. There is no
  project-level role scoping in this phase (deferred with organizations). Storage: a
  `role` column on `users` with a CHECK constraint — **no permissions tables**, no
  role hierarchy tables; the matrix in §3 is code-enforced and spec-frozen.
- The permission lattice is: `org_admin` ⊇ {`estimator`, `reviewer`, `viewer`,
  `data_steward`}; `estimator` ⊇ `viewer`; `reviewer` ⊇ `viewer`; `data_steward` ⊇
  `viewer`. "Viewer+" below means all five roles; "Estimator+" means
  `estimator`/`org_admin`; "Reviewer+" means `reviewer`/`org_admin`.
- **Insufficient permission** → `403` body `{error:{code:'FORBIDDEN', message:'…',
details:{requiredRole:'<role>'}}}` — stable, machine-readable; the same code for
  every route (the required-role detail carries the specificity). Authentication
  failures are always `401` (§1.6); authorization failures are always `403`.
- Domain calculation contracts are untouched: role checks happen at the HTTP boundary
  before any handler logic; the pure engines never see roles (§6).

### 2.3 User-management rules (org_admin only)

- Create: `POST /users` `{username, password, role}` → `201` user (no password
  material in the response). Duplicate (case-insensitive) username → `409
USERNAME_ALREADY_TAKEN`.
- Change role: `POST /users/:userId/role` `{role}` → `200` user. Unknown user → `404
USER_NOT_FOUND`.
- Deactivate: `POST /users/:userId/deactivate` → `200` user; deactivation is soft
  (no delete — append-only posture), revokes all sessions, and is reversible only by
  role management conventions defined at implementation (no activate route in the
  V1.1 contract; reactivation, if provided, is an implementation detail that must be
  audited as `user.role_changed`-equivalent — see §4.3 note).
- **Guard rails**: you cannot deactivate your own account (`403 FORBIDDEN`), and you
  cannot deactivate or demote the **last active `org_admin`** (`409
CANNOT_DEACTIVATE_LAST_ORG_ADMIN`) — the instance must never lock itself out
  (§1.5 bootstrap does not re-run while any user exists).
- Self-service: `POST /auth/password` (any authenticated user; requires
  `currentPassword`) — audited as `auth.password_changed` (§4.4), never with password
  material in `details`.

## 3. Route authorization matrix (S0-F)

All 28 existing routes, unchanged, plus the 10 new routes this contract requires (28 →
**38 planned at implementation**; the count stays 28 until then). `Audit` names the
§4 event; stateless previews are pure computations — never audited, never audited-as-
reads. 401/403 behavior on every protected route is exactly §1.6/§2.2.

| #   | Route                                                            | Auth | Role       | Class       | Audit event                                  |
| --- | ---------------------------------------------------------------- | ---- | ---------- | ----------- | -------------------------------------------- |
| 1   | GET `/health`                                                    | NO   | public     | read        | —                                            |
| 2   | POST `/projects`                                                 | YES  | Estimator+ | mutation    | `project.created`                            |
| 3   | GET `/projects`                                                  | YES  | Viewer+    | read        | —                                            |
| 4   | GET `/projects/:projectId`                                       | YES  | Viewer+    | read        | —                                            |
| 5   | GET `/pricebook/rows`                                            | YES  | Viewer+    | read        | —                                            |
| 6   | GET `/projects/:projectId/estimates`                             | YES  | Viewer+    | read        | —                                            |
| 7   | POST `/projects/:projectId/estimates`                            | YES  | Estimator+ | mutation    | `estimate.created`                           |
| 8   | GET `/estimates/:estimateId`                                     | YES  | Viewer+    | read        | —                                            |
| 9   | POST `/estimates/:estimateId/versions`                           | YES  | Estimator+ | mutation    | `estimate_version.created`                   |
| 10  | GET `/estimate-versions/:versionId`                              | YES  | Viewer+    | read        | —                                            |
| 11  | POST `/estimate-versions/:versionId/lines`                       | YES  | Estimator+ | mutation    | `boq_lines.added`                            |
| 12  | POST `/takeoff/quantities/preview`                               | YES  | Estimator+ | computation | — (stateless, D-015)                         |
| 13  | POST `/estimate-versions/:versionId/calculate`                   | YES  | Estimator+ | computation | — (stateless preview)                        |
| 14  | POST `/estimate-versions/:versionId/finalize`                    | YES  | Estimator+ | mutation    | `estimate_version.finalized`                 |
| 15  | GET `/estimate-versions/:versionId/render/excel`                 | YES  | Viewer+    | read/export | —                                            |
| 16  | GET `/estimate-versions/:versionId/render/pdf`                   | YES  | Viewer+    | read/export | —                                            |
| 17  | POST `/projects/:projectId/takeoffs`                             | YES  | Estimator+ | mutation    | `takeoff_document.created`                   |
| 18  | GET `/projects/:projectId/takeoffs`                              | YES  | Viewer+    | read        | —                                            |
| 19  | GET `/projects/:projectId/takeoffs/:documentId`                  | YES  | Viewer+    | read        | —                                            |
| 20  | POST `/projects/:projectId/takeoffs/:documentId/save`            | YES  | Estimator+ | mutation    | `takeoff_document.saved`                     |
| 21  | POST `/projects/:projectId/takeoffs/:documentId/archive`         | YES  | Estimator+ | mutation    | `takeoff_document.archived`                  |
| 22  | POST `/projects/:projectId/takeoffs/:documentId/unarchive`       | YES  | Estimator+ | mutation    | `takeoff_document.unarchived`                |
| 23  | POST `/projects/:projectId/takeoffs/:documentId/finalize`        | YES  | Estimator+ | mutation    | `takeoff_document.finalized`                 |
| 24  | POST `/projects/:projectId/takeoffs/:documentId/calculate`       | YES  | Estimator+ | computation | — (stateless preview, P7-S2)                 |
| 25  | POST `/projects/:projectId/takeoffs/:documentId/follow-up`       | YES  | Estimator+ | mutation    | `takeoff_document.follow_up_created`         |
| 26  | POST `/projects/:projectId/takeoffs/:documentId/transfer-to-boq` | YES  | Estimator+ | mutation    | `takeoff_document.transferred_to_boq`        |
| 27  | GET `/projects/:projectId/takeoffs/:documentId/render/excel`     | YES  | Viewer+    | read/export | —                                            |
| 28  | GET `/projects/:projectId/takeoffs/:documentId/render/pdf`       | YES  | Viewer+    | read/export | —                                            |
| 29  | POST `/auth/login`                                               | NO   | public     | auth        | `auth.login_succeeded` / `auth.login_failed` |
| 30  | POST `/auth/logout`                                              | YES  | any role   | auth        | — (session row deleted)                      |
| 31  | GET `/auth/session`                                              | YES  | any role   | read        | —                                            |
| 32  | POST `/auth/password`                                            | YES  | self       | auth        | `auth.password_changed`                      |
| 33  | POST `/users`                                                    | YES  | org_admin  | mutation    | `user.created`                               |
| 34  | GET `/users`                                                     | YES  | org_admin  | read        | —                                            |
| 35  | POST `/users/:userId/role`                                       | YES  | org_admin  | mutation    | `user.role_changed`                          |
| 36  | POST `/users/:userId/deactivate`                                 | YES  | org_admin  | mutation    | `user.deactivated`                           |
| 37  | POST `/estimate-versions/:versionId/approve`                     | YES  | Reviewer+  | mutation    | `estimate_version.approved`                  |
| 38  | POST `/projects/:projectId/takeoffs/:documentId/approve`         | YES  | Reviewer+  | mutation    | `takeoff_document.approved`                  |

Matrix rationale (frozen): Viewer is strictly stored-data + exports — previews
(#12/#13/#24) are Estimator+ because they compute new engine results. Reviewer gains
nothing but sign-off (#37/#38). Data Steward equals Viewer until the pricebook
pipeline exists. No existing route changes shape, status code, or error semantics;
the only additive change to existing routes is the auth gate in front of them.

## 4. Audit contract (S0-C → S3)

### 4.1 Event record

`AuditEvent = { eventId: UUID, at: Instant (UTC ISO), actorUserId: UUID | null, action: string, resourceType: string, resourceId: string, projectId: UUID | null, details: JSONB }` —
WHO (`actorUserId`), WHAT (`action` + `resourceType`/`resourceId`), WHEN (`at`),
WHICH RESOURCE (`resourceType`/`resourceId`/`projectId`), RESULT/CONTEXT
(`details`). `details` is structured JSON (never stringified payloads), and carries
only what §4.3/§4.4 list (revision transitions, counts, ids — never passwords, never
snapshot bodies).

### 4.2 Append-only semantics

- Events are INSERT-only. **No application code path updates or deletes audit
  rows**, and the V1.1 migration additionally `REVOKE`s `UPDATE` and `DELETE` on
  `audit_events` from the application's DB role (DB-level enforcement of D-007's
  intent; the repository's application-layer-immutability convention is thereby
  doubled for audit history).
- There is **no audit read API in V1.1** (reads are a DB/ops concern; an audit UI is
  future scope).
- Transaction boundary: **every domain mutation and its audit event(s) commit in the
  same DB transaction** (D-007: no audit gaps, no orphan events). A failed mutation
  leaves zero events; an event never exists without its mutation.

### 4.3 Domain-mutation event inventory (exactly these, nothing else)

| Action                                | Route | Resource (`resourceType`/`resourceId`)  | `projectId` | `details`                                 |
| ------------------------------------- | ----- | --------------------------------------- | ----------- | ----------------------------------------- |
| `project.created`                     | #2    | `project` / new projectId               | self        | `{title}`                                 |
| `estimate.created`                    | #7    | `estimate` / new estimateId             | yes         | `{estimateNumber?}`                       |
| `estimate_version.created`            | #9    | `estimate_version` / new versionId      | yes         | `{versionNumber}`                         |
| `boq_lines.added`                     | #11   | `estimate_version` / versionId          | yes         | `{count, lineIds}` (all-or-nothing batch) |
| `estimate_version.finalized`          | #14   | `estimate_version` / versionId          | yes         | `{rollupTotal}` (null-safe)               |
| `takeoff_document.created`            | #17   | `takeoff_document` / new documentId     | yes         | `{documentNumber, title}`                 |
| `takeoff_document.saved`              | #20   | `takeoff_document` / documentId         | yes         | `{expectedRevision, revision}`            |
| `takeoff_document.archived`           | #21   | `takeoff_document` / documentId         | yes         | `{revision}`                              |
| `takeoff_document.unarchived`         | #22   | `takeoff_document` / documentId         | yes         | `{revision}`                              |
| `takeoff_document.finalized`          | #23   | `takeoff_document` / documentId         | yes         | `{documentNumber}`                        |
| `takeoff_document.follow_up_created`  | #25   | `takeoff_document` / **new** documentId | yes         | `{sourceDocumentId, documentNumber}`      |
| `takeoff_document.transferred_to_boq` | #26   | `takeoff_document` / documentId         | yes         | `{targetVersionId, lineCount}`            |
| `estimate_version.approved`           | #37   | `estimate_version` / versionId          | yes         | — (actor+at are the payload)              |
| `takeoff_document.approved`           | #38   | `takeoff_document` / documentId         | yes         | — (actor+at are the payload)              |

The three stateless previews (#12/#13/#24), every GET (including renders/exports),
logout, and `/health` emit **no** events. `boq_lines.added` emits exactly one event
per successful batch (with the line list in `details`), not one per line.

### 4.4 Governance event inventory

| Action                  | Route | Actor                          | `details`                                                                   |
| ----------------------- | ----- | ------------------------------ | --------------------------------------------------------------------------- |
| `auth.login_succeeded`  | #29   | the user                       | `{username}`                                                                |
| `auth.login_failed`     | #29   | **null** (the only null actor) | `{username}` — never a reason distinguishing unknown-user vs wrong-password |
| `auth.password_changed` | #32   | the user (self)                | — (never password material)                                                 |
| `user.created`          | #33   | the org_admin                  | `{username, role}`                                                          |
| `user.role_changed`     | #35   | the org_admin                  | `{from, to}`                                                                |
| `user.deactivated`      | #36   | the org_admin                  | `{username}`                                                                |

`auth.login_failed` is the single, documented event with a null actor (there is no
authenticated actor); it is also the single unauthenticated write path into
`audit_events` — accepted deliberately (failed-login history is the intrusion signal;
rate limiting is deferred, §1.8).

## 5. Reviewer sign-off contract (S0-D → S4)

- **Applies to**: finalized estimate versions (`finalized_estimates`) and finalized
  takeoff documents (`finalized_takeoffs`) — nothing else.
- **State**: nullable `finalized_by` (who finalized — written at finalization by S1+
  actor stamping), `approved_by`, `approved_at` columns on those two tables
  (§7). `approved_by IS NULL` = not approved; both set = **approved/locked**.
- **Flow**: `FINALIZED → (Reviewer+ approve) → APPROVED/LOCKED`. Nothing more — no
  comments, no rejection, no review states, no assignments, no delegation, no
  multi-reviewer.
- **Authorization**: `reviewer` or `org_admin` only (§3 #37/#38). **Four-eyes rule**:
  the approver must differ from `finalized_by` → self-approval is `403
SIGNOFF_SELF_APPROVAL_FORBIDDEN`. Legacy rows finalized before V1.1 have
  `finalized_by IS NULL` and may be approved by any Reviewer+ (there was no actor to
  collide with; recorded here so the rule is total).
- **Preconditions**: approving a non-finalized version/document → `409
VERSION_NOT_FINALIZED` / `409 TAKEOFF_INVALID_TRANSITION` (existing codes, existing
  semantics); approving an already-approved one → `409 SIGNOFF_ALREADY_GIVEN`
  (idempotent conflict, never a silent 200).
- **Immutability**: approval is **irreversible in this phase** — no withdraw, change,
  or un-approve route exists. Sign-off writes only `approved_by`/`approved_at`; the
  frozen calculation snapshots (`s4_*`/`input`/`result`/`report_model` JSONB) are
  **byte-unchanged**, and renders stay byte-identical (approval is metadata, not part
  of the ReportModel). GET bundles expose the approval state additively:
  `approvedBy: {userId, username} | null`, `approvedAt: string | null`.
- Engine behavior, finalize behavior, BOQ transfer behavior: unchanged by sign-off.

## 6. Cross-cutting contract (S0-E) — actor flow and purity

```
HTTP (cookie) → auth middleware (session → {userId, username, role}) → route handler
  → passes an explicit Actor value into @costgenius/projects service calls
  → service orchestrates the mutation + audit event in ONE db transaction
  → @costgenius/db executes both writes
```

- The pure/frozen stack — `calculateQuantities`, `calculateTakeoff`, S2 binding, S3
  pricing, S4 calculation, snapshot rendering — **never sees an Actor, a role, a
  session, or any authentication type**. Authentication, authorization and audit live
  at the API boundary (middleware), the application layer (`projects` — explicit
  Actor parameter) and the persistence layer (`db` — transactional audit write).
  The existing ESLint layer-boundary rules extend to this discipline at
  implementation (engines/`domain`/`cost-calculation` keep importing nothing outer).
- Authorization is decided **before** any handler/domain work (fail fast, 401/403
  without side effects — no audit event for a 401/403).
- The actor on every audit event is the authenticated user resolved at the boundary —
  never a client-supplied identity. (Except `auth.login_failed`, §4.4.)

## 7. Database contract (S0-G) — migration `0002_p8_governance` (at implementation)

Planned tables **9 → 12**; no organizations, no RLS policies, no permissions tables:

1. `users` — `user_id uuid PK`, `username text NOT NULL UNIQUE` (lowercase),
   `password_hash text NOT NULL` (§1.2 encoding), `role text NOT NULL CHECK (role IN
('org_admin','estimator','reviewer','viewer','data_steward'))`, `is_active boolean
NOT NULL DEFAULT true`, `created_at text NOT NULL` (UTC ISO, house convention).
2. `sessions` — `session_id text PK` (SHA-256 hex of the token), `user_id uuid NOT
NULL REFERENCES users(user_id)`, `created_at text NOT NULL`, `expires_at text NOT
NULL`; index `(user_id)`, index `(expires_at)` for lazy cleanup.
3. `audit_events` — `event_id uuid PK`, `at text NOT NULL`, `actor_user_id uuid NULL
REFERENCES users(user_id)`, `action text NOT NULL`, `resource_type text NOT
NULL`, `resource_id text NOT NULL`, `project_id uuid NULL REFERENCES
projects(project_id)`, `details jsonb NOT NULL DEFAULT '{}'`; indexes `(at)`,
   `(resource_type, resource_id)`, `(actor_user_id)`; **`REVOKE UPDATE, DELETE`** for
   the application role (§4.2).
4. Sign-off representation — **no new table**: `ALTER TABLE finalized_estimates ADD
COLUMN finalized_by uuid NULL REFERENCES users(user_id), approved_by uuid NULL
REFERENCES users(user_id), approved_at text NULL`; the same three columns on
   `finalized_takeoffs`. Existing rows keep NULL (legacy, §5).

Migrations 0000/0001 and all nine existing tables are untouched. Still no pricebook
table (the dataset stays in-memory, D-013).

## 8. Error-contract additions (new codes only — nothing existing changes)

| Code                               | Status | Meaning                                              |
| ---------------------------------- | ------ | ---------------------------------------------------- |
| `UNAUTHENTICATED`                  | 401    | missing/expired/invalid session on a protected route |
| `AUTH_INVALID_CREDENTIALS`         | 401    | login failure (uniform — no enumeration)             |
| `FORBIDDEN`                        | 403    | authenticated, insufficient role (§2.2)              |
| `SIGNOFF_SELF_APPROVAL_FORBIDDEN`  | 403    | four-eyes violation (§5)                             |
| `USERNAME_ALREADY_TAKEN`           | 409    | case-insensitive duplicate username                  |
| `CANNOT_DEACTIVATE_LAST_ORG_ADMIN` | 409    | last-active-admin guard (§2.3)                       |
| `SIGNOFF_ALREADY_GIVEN`            | 409    | re-approval attempt (§5)                             |
| `USER_NOT_FOUND`                   | 404    | admin route, unknown userId                          |

`INVALID_REQUEST` (400) keeps covering body validation, including the new routes'
payloads. Every existing code — including `TAKEOFF_CALCULATION_FAILED` vs
`TAKEOFF_SOLUTION_REJECTED` (D-ERROR=C) — is preserved verbatim.

## 9. Test contract (S0-J — required at implementation)

- **Authentication**: login success; login failure (unknown user / wrong password /
  deactivated → byte-identical 401 bodies); session validity (GET /auth/session
  ok / expired 401); logout invalidates (subsequent requests 401); cookie flags
  (HttpOnly, SameSite=Strict, Secure); password never present in any response body
  or log; bootstrap fail-closed startup (empty users + no env → non-zero exit, never
  listens; with env → initial admin; non-empty users → env ignored).
- **RBAC**: for every protected route in §3 and every one of the five roles — allowed
  roles get the route's normal contract, every other role gets 403 `FORBIDDEN` with
  the required-role detail; unauthenticated always 401; the §2.3 guard rails
  (self-deactivate, last-org_admin).
- **Audit**: every inventory row of §4.3/§4.4 emits **exactly one** event with the
  correct actor/action/resource/projectId/details on the success path; failed
  mutations (validation error, 409 conflict, engine-rejected finalize) emit **zero**
  events (same-transaction proof); batch lines → one event; append-only (no
  update/delete path; the REVOKE is effective for the app role).
- **Sign-off**: Reviewer+ approves both resource kinds; estimator/viewer/data_steward
  → 403; self-approval → 403; non-finalized → 409; double approval → 409; the frozen
  snapshot columns and rendered Excel/PDF bytes are identical before/after approval;
  no route can alter or withdraw an approval.
- **Regression**: all existing 1,271+ unit tests stay green (existing suites are
  re-wired to an authenticated test actor without changing any behavioral
  assertion); all 25 browser E2E stay green (fixtures gain login/bootstrap — flows
  and assertions unchanged); production smoke stays green with the bootstrap env
  (fail-closed legs included) and the golden total `69011321.1668` unchanged; the
  repaired nine-table reset behavior (§12) preserved; engine outputs byte-frozen.

## 10. Preserved contracts (S0-I)

`CG-RCS@0.1.0`, `CG-IR-MEAS@0.2.0`, `CG-FT-TAKEOFF@0.2.0` are untouched by this
spec. D-015/D-016/D-017 historical decision text is unmodified (annotations only,
per house convention). §8 adds new codes only. Route shapes, status codes, decimals
on the wire, snapshot semantics, BOQ transfer semantics, pricebook posture — all
unchanged.

## 11. Staging (informational — execution requires the owner's order)

S1 authentication core (users/sessions/login/logout/password + middleware on all
routes + bootstrap + e2e/test fixture actor + hygiene repair §12.1) → S2 RBAC
matrix enforcement (+ user-management routes) → S3 audit writer + full §4 inventory →
S4 sign-off (columns, routes, four-eyes). Each stage gated green before the next,
Phase-7 style.

## 12. Phase-8 hygiene repairs (authorized with Phase 8, not product features)

1. `apps/api/test/workflow.test.ts` — the env-gated real-server leg still drops only
   the five estimate-family tables; a re-run on a used disposable DB fails 42P07
   (proven 2026-09-28). Repair at S1: drop all nine current tables, children before
   parents (the P7-S3 pattern), assertions otherwise unchanged.
2. `DEPLOYMENT.md` — the stale "exactly the five domain tables" smoke description is
   corrected to the nine-table truth (done at S0; documentation-only).

## Changelog

### 0.1.0 (2026-09-28 — P8-A S0 contract closure)

First version. Contracts for authentication (D-P8-2=A model), the five-role
authorization matrix, the append-only audit model with its complete event inventory,
and minimal reviewer sign-off (D-P8-3=A), plus the cross-cutting actor-flow, database,
error and test contracts. Contract only — nothing implemented.
