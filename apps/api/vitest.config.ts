import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: { resolve: { conditions: ['source'] } },
  resolve: { conditions: ['source'] },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // API integration tests run the full HTTP → projects → repository → PostgreSQL (PGlite) chain
    testTimeout: 120_000,
    // Files run sequentially: the two real-server suites (smoke + concurrency) share the
    // single disposable database named by COSTGENIUS_SMOKE_DATABASE_URL.
    fileParallelism: false,
  },
});
