import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Which paths reach the Worker at all.
 *
 * Static assets are served in front of the Worker, and `run_worker_first` is the
 * only thing that lets a request past them. A path missing from that list is not
 * a 404: the single-page-application fallback answers it with the dashboard's
 * HTML, so the endpoint looks like it exists and returns a web page.
 *
 * That shipped once. `/.well-known/thwip-keys` publishes the keys that verify
 * every signed merge record, and it returned the dashboard in production while
 * passing every test and every review, because the routing lives in deploy
 * configuration rather than in code.
 *
 * So this asserts the two stay in step. Adding a new top-level path prefix to
 * the Worker means adding it here and to `wrangler.jsonc` together.
 */

const wrangler = readFileSync(fileURLToPath(new URL("../../../wrangler.jsonc", import.meta.url)), "utf8");

/** Every top-level prefix the Worker answers on. */
const WORKER_PREFIXES = [
  "/api/*",
  "/v1/*",
  "/admin/*",
  "/health",
  // Publishes the verification keys. Public and unauthenticated on purpose.
  "/.well-known/*",
];

function runWorkerFirst(): string[] {
  const match = wrangler.match(/"run_worker_first"\s*:\s*\[([^\]]*)\]/);
  if (match === null) throw new Error("wrangler.jsonc no longer declares run_worker_first");
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("paths that reach the Worker", () => {
  it("routes every prefix the Worker serves past the static assets", () => {
    const declared = runWorkerFirst();
    for (const prefix of WORKER_PREFIXES) {
      expect(declared, `${prefix} would be answered by the dashboard's HTML`).toContain(prefix);
    }
  });

  /**
   * The keys endpoint specifically, because its failure is the quiet kind: a
   * verifier fetching HTML sees no usable key and would otherwise conclude the
   * records are unsigned.
   */
  it("routes the verification keys past them", () => {
    expect(runWorkerFirst()).toContain("/.well-known/*");
  });
});
