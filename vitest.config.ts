import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    // The workerd chaos suite imports cloudflare:test and needs the Workers pool.
    // It runs under `pnpm test:workers`, not here.
    exclude: ["**/node_modules/**", "**/*.workers.test.ts"],
    poolOptions: { threads: { maxThreads: 2 } },
  },
});
