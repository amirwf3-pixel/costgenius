# Browser E2E — real Chromium against the production build

The full product workflow runs in a **real browser** against the **production web build**:

```
real Chromium (npm-distributed binary)
→ vite preview (production dist, /api proxied)
→ HTTP
→ Fastify + Zod (createApiServer — the real API)
→ projects (real domain)
→ Drizzle
→ PostgreSQL-in-process (PGlite, real migrations, official 1404 dataset)
```

## How the browser binary is obtained (repeatable, no CDN)

This environment cannot reach the Playwright CDN (`cdn.playwright.dev`,
`playwright.azureedge.net`) or Google's chrome-for-testing storage — both are blocked.
The npm registry, however, is reachable, so the browser comes from npm:

| package                       | role                                                    |
| ----------------------------- | ------------------------------------------------------- |
| `@playwright/test@1.63.0`     | the test runner (never downloads browsers by itself)    |
| `@sparticuz/chromium@153.0.0` | Chromium **153.0.8010** packaged inside the npm tarball |

Playwright 1.63 bundles Chromium 153 (revision 1243) natively, so the versions are
matched by design. The sparticuz package also ships the NSS/NSPR shared libraries
Chromium needs on hosts that lack them (`bin/al2023.tar.br`); `e2e/browser-launcher.ts`
extracts them and exports `LD_LIBRARY_PATH` (the package itself only does this
automatically on Amazon Linux 2023).

## Deterministic lifecycle

`e2e/global-setup.ts` (single worker, fixed ports, no randomness):

1. builds the production web bundle (`vite build`),
2. starts the real API on **127.0.0.1:3101** (PGlite in-process, real Drizzle migrations,
   official 1404 dataset, **no seed data** — specs create their own state; the
   deterministic TEST bootstrap admin comes from `CG_BOOTSTRAP_ADMIN_*` passed to the
   API process by the setup itself),
3. **logs in through the real `/auth/login`** (P8-A S1) and writes the session cookie to
   `.auth/state.json` — Playwright's `storageState` authenticates every spec with a
   REAL server-side session, never a mocked one; the state file is deleted in teardown,
4. starts `vite preview` on **127.0.0.1:4173** serving the production build with `/api`
   proxied to the API,
5. fails fast if either port is already in use (leftover run).

Specs that arrange data over direct HTTP (`e2e/helpers.ts`) log in the same way and
carry the `cg_session` cookie on every arrangement call — there is no unauthenticated
back door.

`e2e/global-teardown.ts` stops both processes. The network-failure spec (which runs
last, alphabetical order) stops the API process for real via SIGTERM.

## Run

```bash
pnpm --filter @costgenius/web e2e
```

Prerequisites: the workspace devDependencies installed (`pnpm install`), `tar` on PATH
(for the one-time NSS extraction), and ports 3101/4173 free. No browser download, no
CDN access, no Docker.

## Suites

| spec                    | covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-empty-404-rtl-a11y` | empty states on a fresh DB, 404 error UX, RTL/LTR isolation, a11y baseline (keyboard-opened dialog, labelled inputs, Escape, focus restore, real disabled)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `05-auth`               | P8-A S1: the session gate — anonymous load shows the login page (nothing else renders), a wrong password shows the uniform 401 message (no credential material anywhere), login enters the app with the current-user bar, logout returns to the gate; opts OUT of storageState to test the anonymous path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `06-rbac`               | P8-A S2: the org_admin creates one real user per role through POST /users; each role logs in through the REAL login page in a fresh anonymous context — estimator mutates through the UI but is 403 on user management (direct API); reviewer/viewer/data_steward get viewer-class reads + exports (incl. the finalized Excel render) but 403 on mutations (UI alert AND direct API, with zero rows created); the org_admin answers the user-management surface (list/create/role-change/self-deactivate-guard); anonymous API calls are 401 through the web proxy too. Denials are re-proven with `page.request` carrying the very role's real session cookie — no authorization bypass via direct API calls.                                                                                                                                          |
| `10-golden-workflow`    | the §2 product story end-to-end: project → estimate → version → 8 real 1404 lines → calculate → exact S4 chain (69,011,321.1668) → finalize → reload → Excel/PDF downloads (filename, PK/%PDF, workbook content) → byte-determinism → v2 append-only → v1 unchanged incl. PDF bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `20-pricebook-lookup`   | code + description search, unit/price display, and the proof that submitted code/unit come from the selected API row (request payload captured), never free text; client-side validation errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `30-error-ux`           | the real 409 contract via a stale-tab race (two pages, one finalizes, the other's mutations get 409 + Persian message); invalid-unit 422 shape at the API level                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `40-dimensional-entry`  | D-015: متره‌ای mode in the add-line dialog — exact S1 preview (quantity + engine versions), commit payload carries ONLY the factors (request-captured; never a client-computed quantity), server-computed amount in the table, negative manual quantity rejected (D2-A), kg manual-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `50-takeoff-workspace`  | D-016 Phase 5+6, 21 steps: UI-created takeoff → sheets → dimensional (explicit floorCount)/manual (justification)/reference lines → design rounding rule → canonical save (revision replaced) → archive → unarchive → finalize (engine result: exact 112.5 → rounded 113, uncoded stays in takeoff) → follow-up (number 2, stable lineIds) → PDF report download (real %PDF, `costgenius-takeoff-<id>.pdf`) → Excel report download (zip read-back: 112.5 exact / 113 rounded-effective / 100 uncoded + «بدون کد»; takeoff unchanged after both) → transfer to BOQ (113 m2 + skipped) → BOQ row in the target version → repeat transfer = exact ALREADY_TRANSFERRED 422 → concurrent API edit = exact 409 message + دریافت نسخهٔ جدید                                                                                                                   |
| `55-takeoff-list`       | P7-S1: the project-scoped takeoff list — empty state → UI-created takeoff → back to the project page → discoverable + listed with status → opens the workspace → existing behavior intact (sheet/line/save) → still exactly one row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `56-takeoff-preview`    | P7-S2: the stateless draft calculation preview — valid draft → preview (exact engine result 100) → break it semantically (delete the referenced line; UI warns, allows) → preview again (422 TAKEOFF_SOLUTION_REJECTED → Persian hint, never raw codes, no stale result) → repair → preview (100 again) → finalize unchanged; the single intentional 422 is allow-listed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `57-pricebook-editions` | P8-B S4: the steward editions management page — the admin sees the seeded 1404 edition with its lifecycle metadata; a real data_steward (created through POST /users) imports a staged JSON via the file picker → inline import report → the DRAFT card; the self-activation hits the server's four-eyes 403 (rendered inline, list unchanged); a semantically invalid document renders the 422 structured failures + the nothing-stored guarantee (and the real API confirms zero new editions); the admin activates the import (three-fact confirmation; the seeded 1404 auto-archives), exercises the 0-active-state archive, then restores the seeded ACTIVE baseline (ARCHIVED→ACTIVE); an estimator never sees the navigation entry, and the direct URL is the read-only list. The intentional 403/422 and the fresh-login 401s are allow-listed. |
| `99-network-failure`    | API process really stopped → unreachable error state, retry, no fake data, no stuck spinner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Every page collects console errors, page errors, HTTP ≥ 400 responses and network
failures (`e2e/fixtures.ts` → `noise`); the happy paths assert **zero** unexpected
noise. Intentional error-path noise is allowlisted per spec, narrowly.

## Known limitations

- Transient busy states (calculate/finalize/download spinners) are too fast to assert
  deterministically against the real API; they are covered by the component tests and
  the E2E asserts the end states (and the absence of stuck spinners).
- Screenshots/rendering with Persian glyphs rely on the app's bundled Vazirmatn webfont
  (assertions are DOM-level, not pixel-level).
