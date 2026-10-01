// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**'] },
  { ...js.configs.recommended, files: ['**/*.{js,ts}'] },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='eval'], NewExpression[callee.name='Function']",
          message: 'Dynamic code evaluation is forbidden.',
        },
      ],
    },
  },
  {
    // The pure core must stay free of I/O, clock and randomness (ARCHITECTURE.md §3, D-003).
    files: ['packages/domain/src/**/*.ts', 'packages/calc-engine/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message: 'Pure core: no I/O modules.',
            },
            {
              group: [
                '@costgenius/db',
                '@costgenius/ai-assist',
                '@costgenius/reporting',
                '@costgenius/reporting-excel',
                '@costgenius/reporting-pdf',
                '@costgenius/projects',
              ],
              message: 'Pure core may not depend on outer layers.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Pure core must be deterministic.' },
        { object: 'Date', property: 'now', message: 'Pure core must not read the clock.' },
      ],
    },
  },
  {
    // CostGenius business-calculation layer (S2/S3/S4): pure, and only domain + pricebook below it.
    files: ['packages/cost-calculation/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message: 'Business-calculation layer is pure: no I/O modules.',
            },
            {
              group: ['@costgenius/*', '!@costgenius/domain', '!@costgenius/pricebook'],
              message:
                'cost-calculation may depend only on @costgenius/domain and @costgenius/pricebook.',
            },
            {
              group: ['**/test/**', '**/spec/**'],
              message: 'Production code must not import tests or spec data.',
            },
            { group: ['decimal.js'], message: 'Use @costgenius/domain value types.' },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Business layer must be deterministic.' },
        { object: 'Date', property: 'now', message: 'Business layer must not read the clock.' },
      ],
    },
  },
  {
    // BOQ layer (estimate/version/rollup): pure, and only domain + pricebook + cost-calculation below it.
    files: ['packages/boq/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message: 'BOQ layer is pure: no I/O modules.',
            },
            {
              group: [
                '@costgenius/*',
                '!@costgenius/domain',
                '!@costgenius/pricebook',
                '!@costgenius/calc-engine',
                '!@costgenius/cost-calculation',
              ],
              message:
                'boq may depend only on domain, pricebook, cost-calculation and calc-engine (takeoff provenance types, D-015).',
            },
            {
              group: ['**/test/**', '**/spec/**'],
              message: 'Production code must not import tests or spec data.',
            },
            { group: ['decimal.js'], message: 'Use @costgenius/domain value types.' },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'BOQ layer must be deterministic.' },
        { object: 'Date', property: 'now', message: 'BOQ layer must not read the clock.' },
      ],
    },
  },
  {
    // Reporting layer (ReportModel): pure, and only domain + pricebook + cost-calculation + boq below it.
    files: ['packages/reporting/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message: 'Reporting layer is pure: no I/O modules.',
            },
            {
              group: [
                '@costgenius/*',
                '!@costgenius/domain',
                '!@costgenius/pricebook',
                '!@costgenius/cost-calculation',
                '!@costgenius/boq',
                '!@costgenius/calc-engine',
              ],
              message:
                'reporting may depend only on domain, pricebook, cost-calculation, boq and calc-engine (takeoff snapshot types, D-016 Phase 6).',
            },
            {
              group: ['**/test/**', '**/spec/**'],
              message: 'Production code must not import tests or spec data.',
            },
            { group: ['decimal.js'], message: 'Use @costgenius/domain value types.' },
            {
              group: ['xlsx', 'exceljs', 'pdfkit', 'jspdf', 'react', 'puppeteer'],
              message:
                'No renderers in the ReportModel layer (stage 1 only; renderers are a later stage).',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Reporting layer must be deterministic.' },
        { object: 'Date', property: 'now', message: 'Reporting layer must not read the clock.' },
      ],
    },
  },
  {
    // Excel renderer (ReportModel → XLSX): presentation only. In-memory, no I/O; only the
    // ReportModel layer, the BOQ validator and the exceljs adapter below it.
    files: ['packages/reporting-excel/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message:
                'Excel renderer is pure in-memory: no I/O modules (the caller writes the bytes).',
            },
            {
              group: ['@costgenius/*', '!@costgenius/reporting', '!@costgenius/boq'],
              message:
                'reporting-excel may depend only on @costgenius/reporting and @costgenius/boq (plus the exceljs adapter).',
            },
            {
              group: ['**/test/**', '**/spec/**'],
              message: 'Production code must not import tests or spec data.',
            },
            { group: ['decimal.js'], message: 'Carry the ReportModel values; recompute nothing.' },
            {
              group: ['xlsx', 'xlsx-populate', 'write-excel-file', 'pdfkit', 'jspdf', 'react'],
              message: 'One XLSX engine (exceljs); no other renderers in this package.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Renderer must be deterministic.' },
        { object: 'Date', property: 'now', message: 'Renderer must not read the clock.' },
      ],
    },
  },
  {
    // PDF renderer (ReportModel → PDF): presentation only. In-memory, one XLSX-free I/O
    // exception: fonts.ts reads the bundled Vazirmatn assets. Only @costgenius/reporting,
    // @costgenius/boq (line validator), pdfkit and bidi-js below it.
    files: ['packages/reporting-pdf/src/**/*.ts'],
    ignores: ['packages/reporting-pdf/src/fonts.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message:
                'PDF renderer is pure in-memory: no I/O modules (fonts.ts is the only asset-loading exception).',
            },
            {
              group: ['@costgenius/*', '!@costgenius/reporting', '!@costgenius/boq'],
              message:
                'reporting-pdf may depend only on @costgenius/reporting and @costgenius/boq (plus pdfkit/bidi-js).',
            },
            {
              group: ['**/test/**', '**/spec/**'],
              message: 'Production code must not import tests or spec data.',
            },
            { group: ['decimal.js'], message: 'Carry the ReportModel values; recompute nothing.' },
            {
              group: [
                'xlsx',
                'exceljs',
                'pdfmake',
                '@react-pdf/renderer',
                'react',
                'puppeteer',
                'playwright',
              ],
              message: 'One PDF engine (pdfkit); no other renderers or browsers in this package.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Renderer must be deterministic.' },
        { object: 'Date', property: 'now', message: 'Renderer must not read the clock.' },
      ],
    },
  },
  {
    // Application/orchestration layer (Phase 13): composes the whole pure stack —
    // pricebook → cost-calculation → boq → reporting → renderers — but owns no formula
    // and no formatting. Itself pure: no I/O (the caller supplies datasets/bytes),
    // no clock, no randomness; identities and instants are injected.
    files: ['packages/projects/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message:
                'Orchestration layer is pure in-memory: no I/O modules (the caller supplies datasets and persists bytes).',
            },
            {
              group: [
                '@costgenius/*',
                '!@costgenius/domain',
                '!@costgenius/pricebook',
                '!@costgenius/calc-engine',
                '!@costgenius/cost-calculation',
                '!@costgenius/boq',
                '!@costgenius/reporting',
                '!@costgenius/reporting-excel',
                '!@costgenius/reporting-pdf',
              ],
              message:
                'projects may depend only on domain, calc-engine, pricebook, cost-calculation, boq, reporting and the two renderers.',
            },
            {
              group: ['**/test/**', '**/spec/**'],
              message: 'Production code must not import tests or spec data.',
            },
            { group: ['decimal.js'], message: 'Use @costgenius/domain value types.' },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Orchestration layer must be deterministic.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Orchestration layer must not read the clock.',
        },
      ],
    },
  },
  {
    // Persistence adapter (Phase 14): implements the @costgenius/projects repository
    // contracts over PostgreSQL/Drizzle. It is the outer, impure edge — node:*, pg and
    // drizzle are allowed here — but it owns no business rule: decimals stay exact
    // strings, finalized history is append-only, and no clock or randomness is read
    // (IDs and instants are domain-supplied and only re-validated here).
    files: ['packages/db/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@costgenius/*',
                '!@costgenius/domain',
                '!@costgenius/pricebook',
                '!@costgenius/cost-calculation',
                '!@costgenius/boq',
                '!@costgenius/reporting',
                '!@costgenius/projects',
              ],
              message:
                'db may depend only on the domain stack (domain, pricebook, cost-calculation, boq, reporting) and the projects repository contracts.',
            },
            {
              group: ['**/test/**', '**/spec/**'],
              message: 'Production code must not import tests or spec data.',
            },
            { group: ['decimal.js'], message: 'Business decimals are exact strings here.' },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Persistence adapter must be deterministic.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Persistence adapter must not read the clock.',
        },
      ],
    },
  },
  {
    // HTTP API (Phase 15): an impure orchestration edge above the whole stack. It may
    // use node:*, fastify and zod, but only the projects application layer, the db
    // adapter (composition root only) and the pricebook dataset loader below it — never
    // the engines directly, never a renderer, never a calculation. No clock reads inside
    // the server (the clock is injected); no randomness at all.
    // The web app is a pure HTTP consumer (Phase 18): browser code imports NO workspace
    // package and no Node builtins — every value comes from the API client.
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@costgenius/*'],
              message:
                'web consumes the API over HTTP only; import no workspace package at runtime (types are mirrored locally and pinned by the integration test).',
            },
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message: 'Browser code must not import Node builtins.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'No randomness in UI state; ids come from crypto.randomUUID.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'No clock reads in the UI; time comes from the API (injected clock).',
        },
      ],
      // React event handlers legitimately ignore setState's void return
      // (`onClick={() => setCreating(true)}` is idiomatic and safe). Promise
      // discipline is still enforced by no-floating-promises below.
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@costgenius/*',
                '!@costgenius/domain',
                '!@costgenius/pricebook',
                '!@costgenius/projects',
                '!@costgenius/db',
              ],
              message:
                'api may depend only on domain, pricebook (dataset publish), projects (application layer) and db (composition root).',
            },
            {
              group: ['**/test/**', '**/spec/**'],
              message: 'Production code must not import tests or spec data.',
            },
            { group: ['decimal.js'], message: 'Business decimals are exact strings here.' },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'API must be deterministic.' },
        { object: 'Date', property: 'now', message: 'API must use the injected clock.' },
      ],
    },
  },
  {
    // fonts.ts: the single bundled-asset loading point (no business data, no network).
    files: ['packages/reporting-pdf/src/fonts.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:fs/promises', 'http', 'https', 'crypto', 'child_process'],
              message: 'fonts.ts only reads bundled assets with node:fs/node:url.',
            },
            {
              group: ['@costgenius/*', '!@costgenius/reporting', '!@costgenius/boq'],
              message:
                'reporting-pdf may depend only on @costgenius/reporting and @costgenius/boq.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Renderer must be deterministic.' },
        { object: 'Date', property: 'now', message: 'Renderer must not read the clock.' },
      ],
    },
  },
  {
    // calc-engine production code: no test/oracle imports and no direct decimal.js (use @costgenius/domain).
    files: ['packages/calc-engine/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message: 'Pure core: no I/O modules.',
            },
            {
              group: ['@costgenius/*', '!@costgenius/domain'],
              message: 'calc-engine may depend only on @costgenius/domain.',
            },
            {
              group: ['**/test/**', '**/reference-oracle*', '**/spec/**'],
              message: 'Production code must not import tests, the oracle or spec data.',
            },
            { group: ['decimal.js'], message: 'Use @costgenius/domain value types.' },
          ],
        },
      ],
    },
  },
);
