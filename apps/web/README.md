# @costgenius/web — رابط کاربری تولیدی CostGenius (فاز ۱۸ + فاز ۵ D-016 + P8-A S1)

Production React UI for the full estimation workflow:
**پروژه‌ها → پروژه → برآوردها → برآورد → نسخه → ردیف‌های BOQ → محاسبه/بازبینی → نهایی‌سازی → گزارش‌ها**,
plus the **Full Takeoff workspace** (D-016 Phase 5):
**پروژه → سند صورت‌برداشت (متره) → برگه‌ها/ردیف‌ها/قواعد گرد کردن → ذخیره → نهایی‌سازی → سند پیرو → انتقال به برآورد** at
`/projects/:projectId/takeoffs/:documentId`.

The UI is a **pure consumer of the HTTP API** (the final law of Phase 18):

- no direct database access from the browser;
- no pricebook dataset in the browser — rows arrive only through `GET /pricebook/rows`
  (search, capped at 50 rows per request);
- no duplicated S4/rollup calculation in the frontend — every number is computed by the
  backend and rendered as the **exact decimal string** the API returned;
- one typed client (`src/api/client.ts`) — every component goes through
  `useApi()`; the base URL comes from config (`VITE_API_BASE_URL`, default `/api`).

Domain rules the UI enforces visually (the backend remains the authority):

- **D-015 dimensional entry** (متره‌ای): the add-line dialog offers, for S1 units only
  (`m`/`m2`/`m3`/`each`), factor entry (count × the unit's dimensions) next to manual
  entry. The UI computes NOTHING: a stateless preview (`POST /takeoff/quantities/preview`)
  shows the exact engine quantity with its spec/engine versions, and the commit payload
  carries **only the factors** — the server computes the quantity and attaches the
  provenance. Non-S1 units (kg, ton_km, …) stay manual; negative manual quantities are
  rejected with a کسر بها explanation (D2-A), never accepted as signed deductions;
- **D-016 Full Takeoff workspace** (فاز ۵): one page per takeoff document — sheets,
  lines and the four quantity forms only (dimensional / reference / expression /
  manual — a structured builder, never a text parser), explicit
  `floorCount`/`similarCount`, design-only rounding rules, and G4=B whole-document
  save under `expectedRevision`. The UI computes nothing and rounds nothing: drafts
  carry no result at all until finalization; exact values always render, rounded
  values only when the engine produced one. A `409 PERSISTENCE_CONFLICT` shows the
  exact message «این سند در جای دیگری تغییر کرده است. ابتدا نسخه جدید را دریافت کنید.»
  and never overwrites local edits; finalized documents are fully read-only and reach
  BOQ only through the transfer dialog (with the exact ALREADY_TRANSFERRED message on
  a repeat);
- draft versions: add lines, calculate, finalize only; finalized versions are read-only
  (mutation controls removed, reports enabled);
- finalize always asks for confirmation, and a `409 VERSION_FINALIZED` /
  `FINALIZED_ESTIMATE_IMMUTABLE` renders as «این نسخه نهایی شده…», never as a generic crash;
- `null` price renders as «ثبت نشده» — **never** `0`; negatives stay explicit
  (e.g. `−1,037,000`); no `Math.round`/`Number()` in business paths;
- codes, decimals and UUIDs render LTR inside the RTL Persian layout (`dir="rtl"`,
  Vazirmatn, green semantic accent);
- loading/empty/error states everywhere — the UI never invents data; API unavailable →
  error state with retry;
- **P8-A S1 authentication**: the whole app sits behind a session gate
  (`AuthenticatedApp`) — no session (401) → the login page (`LoginPage`, RTL, the
  uniform «نام کاربری یا گذرواژه نادرست است.» 401 message — no enumeration hints, no
  credential material in the DOM); logged in → the app plus a minimal account bar
  (username, «تغییر گذرواژه», «خروج»); logout ends the session server-side and shows
  «نشست شما پایان یافت.»; a password-change dialog validates the current password and
  an 8–128-character match. A **network failure is never mistaken for "no session"**
  (§14): only a real 401 opens the login page — an unreachable API shows the standard
  «CostGenius API در دسترس نیست.» error state with «تلاش مجدد». The session cookie is
  HttpOnly — the browser code never touches the token; `401 UNAUTHENTICATED` on any API
  call surfaces as the login page, never as a partial crash.

## Scripts

```bash
pnpm --filter @costgenius/web dev        # vite dev server (proxies /api)
pnpm --filter @costgenius/web build      # production build
pnpm --filter @costgenius/web test       # vitest run (4 suites, see below)
pnpm --filter @costgenius/web typecheck  # tsc --noEmit (strict)
pnpm --filter @costgenius/web preview    # serve the production build
```

## Local development

1. Start the API. Either the full stack against a real PostgreSQL server:

   ```bash
   DATABASE_URL=postgres://… PORT=3001 pnpm --filter @costgenius/api start
   # node --conditions=source --import tsx src/main.ts — config → migrations → listen
   ```

   or, for UI work without any database server, the dev backend (the REAL API on
   PostgreSQL-in-process PGlite with the official 1404 dataset and one demo project
   seeded through the real HTTP API — development only, never a production fallback):

   ```bash
   node --conditions=source --import tsx apps/web/scripts/dev-backend.ts   # 127.0.0.1:3001
   ```

2. Start the web dev server; the Vite proxy forwards `/api/*` to the API:

   ```bash
   pnpm --filter @costgenius/web dev
   # override the proxy target if the API is not on 127.0.0.1:3001:
   VITE_API_PROXY_TARGET=http://127.0.0.1:3000 pnpm --filter @costgenius/web dev
   ```

3. Same-origin deployments need no configuration (`/api` default). Cross-origin
   deployments set `VITE_API_BASE_URL` at **build** time.

## Testing strategy — what is and is not covered

| Suite                              | File  | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format.test.ts` (9)               | jsdom | exact-decimal formatting: null → «ثبت نشده», grouping, negatives, fa-IR instants, labels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `api-client.test.ts` (11)          | jsdom | the single client over a stubbed `fetch`: error-code → Persian message map, exact-string payload, `content-disposition` filename + fallback, `NetworkError`, health                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `components.test.tsx` (58)         | jsdom | every page family with an injected fake client (loading/empty/error/retry, add-line exact submit, finalized read-only §29, reports gating) **plus the D-016 takeoff workspace tests A–AB: canonical save body, exact 409 conflict message with kept local edits, cross-sheet references, expression tree, dependency warnings, rounding rules, archive/unarchive, finalize + engine-failure hints, follow-up, transfer + ALREADY_TRANSFERRED, and the Phase-6 report buttons (finalized-only, draft hint, download calls + inline error)** — **plus the P8-A S1 auth UI tests: login submit/handoff, uniform 401 message with no credential material, required-field validation, the session gate (401 → login page, gated content never renders), current-user bar + logout, password-change validation, and the network-failure ≠ no-session rule (§14) with retry** |
| `workflow.integration.test.ts` (4) | node  | the app's **real** client over **real HTTP** → real login (session cookie carried on every call through the client's fetch seam) → Fastify + Zod + projects → PGlite with the **real** Drizzle migrations, fixed clock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Browser E2E (added in Phase 19):** a **real Chromium** now runs the full product
workflow against the production build — see [`e2e/README.md`](e2e/README.md). The
browser binary comes from npm (`@sparticuz/chromium`, Chromium 153 matched to
`@playwright/test` 1.63) because the Playwright CDN is unreachable in the build
environment; everything is repeatable with `pnpm --filter @costgenius/web e2e`.
The D-016 takeoff lifecycle (21 steps: create → sheets → dimensional/manual/reference
lines → rounding rule → save → archive → unarchive → finalize → follow-up → back to the
finalized document → PDF report download (real %PDF bytes, stable filename) → Excel
report download (zip read-back: exact/rounded/effective + «بدون کد», takeoff unchanged
after both) → transfer to BOQ → repeat transfer 422 → concurrent-edit 409) runs in
`e2e/specs/50-takeoff-workspace.spec.ts` against the real API, with only its two
intentional 4xx responses allow-listed in the zero-noise assertion.
What remains covered only by the integration suite below is the jsdom-level unit
surface; the browser glue itself (HTML entry, anchor-click downloads, focus/keyboard
behavior) is now verified by the real-browser suite.

## Architecture boundaries (enforced by ESLint)

`apps/web/src/**` is linted with `no-restricted-imports` banning **all**
`@costgenius/*` workspace imports and Node builtins — the browser bundle must contain no
server code. The local view types in `src/api/types.ts` are pinned to the API's real
responses by the integration suite. Promise discipline is kept via
`no-floating-promises`; `no-confusing-void-expression` is disabled for this app only,
because idiomatic React event handlers (`onClick={() => setX(true)}`) legitimately ignore
`setState`'s void return.
