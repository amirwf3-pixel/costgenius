# CostGenius

Professional quantity-takeoff (متره) and cost-estimation (برآورد) for Iranian **building works (ابنیه)**.
Deterministic, auditable calculations; official price-book and market pricing with full source tracking;
Excel/PDF as first-class outputs; AI strictly advisory.

See [PROJECT_SCOPE.md](PROJECT_SCOPE.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [DECISIONS.md](DECISIONS.md).

**Status:** Phase 0 (foundation). Only `@costgenius/domain` is implemented; other packages are
boundaries described in their READMEs.

## Requirements

- Node.js ≥ 22
- pnpm 10 (`corepack enable` picks up the version pinned in `package.json`)

## Commands

| Command          | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `pnpm install`   | Install dependencies                     |
| `pnpm check`     | Format check + lint + type-check + tests |
| `pnpm lint`      | ESLint (type-aware, zero warnings)       |
| `pnpm typecheck` | `tsc --noEmit` in every package          |
| `pnpm test`      | Vitest in every package                  |
| `pnpm build`     | Build packages to `dist/`                |
| `pnpm format`    | Apply Prettier                           |

## Layout

```
apps/       web, api, worker
packages/   domain, calc-engine, pricebook, market-prices, projects, audit,
            reporting, ai-assist, db, contracts, i18n, ui
```

The pure core (`domain`, `calc-engine`) is lint-restricted from importing I/O modules, outer layers,
`Math.random` and `Date.now`.

## Data policy

The repository contains no Iranian price-book data, coefficients, regulations or market prices.
Such data enters only through the audited import pipelines described in ARCHITECTURE.md.
