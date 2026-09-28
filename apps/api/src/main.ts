/**
 * Standalone production entry point (Production Release Audit §4).
 *
 * `src/index.ts` deliberately never auto-invokes `main()` on import (embedders
 * compose it themselves); this file is the runnable composition for a standalone
 * process: it starts the API (config validation → pool → migrations → listen),
 * and `main()` wires SIGTERM/SIGINT to the graceful shutdown.
 *
 * Run:  pnpm --filter @costgenius/api start
 *       (equivalently: node --conditions=source --import tsx apps/api/src/main.ts)
 */
import { main } from './index.js';

await main();
