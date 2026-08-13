import { defineConfig } from "vitest/config";

/**
 * Workspace packages resolve to their sources under test, not to `dist`.
 *
 * Several tests exist to force a decision when a shared vocabulary grows — the
 * dashboard's guidance table is checked for an entry per blocking reason, for
 * instance. Resolving through `dist` made those tests report on whatever was last
 * built: a new reason code was added, no guidance was written for it, and the
 * suite passed anyway. A test that reads a stale artifact is not a test.
 */
const workspaceSource = Object.fromEntries(
  [
    "action",
    "cli",
    "policy",
    "prompts",
    "protocol",
    "queue-domain",
    "queue-protocol",
    "sshsig",
    "verifier",
    "vocabulary",
  ].map(
    (name) => [`@thwip/${name}`, new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname],
  ),
);

/**
 * Test-support subpaths, ahead of the package aliases above.
 *
 * Vite matches a string alias by prefix, so a bare `@thwip/vocabulary` entry
 * swallows `@thwip/vocabulary/test` and resolves it to the package index, where
 * the helper is not exported. Order decides which wins.
 */
const testSupport = {
  "@thwip/vocabulary/test": new URL(
    "./packages/vocabulary/src/test/reason-codes.ts",
    import.meta.url,
  ).pathname,
  "@thwip/queue-protocol/test/verify-chain-fixtures": new URL(
    "./packages/queue-protocol/src/test/verify-chain-fixtures.ts",
    import.meta.url,
  ).pathname,
};

export default defineConfig({
  resolve: { alias: { ...testSupport, ...workspaceSource } },
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // The workerd chaos suite imports cloudflare:test and needs the Workers pool.
    // It runs under `pnpm test:workers`, not here.
    exclude: ["**/node_modules/**", "**/*.workers.test.ts"],
    maxWorkers: 2,
  },
});
