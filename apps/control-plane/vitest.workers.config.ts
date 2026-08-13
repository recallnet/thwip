import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * The chaos suite runs in workerd, against the real Durable
 * Object runtime. Everything the pure tests cannot reach lives here: actual
 * eviction, actual alarms, actual SQLite storage, actual concurrency.
 *
 * A separate config because these tests need a Worker environment, and the rest
 * of the suite must stay fast on plain Node.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-07-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { BRANCH_QUEUE: { className: "BranchQueue", useSQLite: true } },
      },
      wrangler: { configPath: "../../wrangler.jsonc", environment: "staging" },
    }),
  ],
  test: {
    include: ["src/queue/**/*.workers.test.ts"],
    maxWorkers: 1,
    // Per-file storage isolation stacks a fresh storage layer that cannot cope
    // with a Durable Object that initializes under blockConcurrencyWhile;
    // each test uses its own repository id instead, which is real isolation.
    isolate: false,
  },
});
