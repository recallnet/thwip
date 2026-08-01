import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKER_PREFIXES, isWorkerOwnedPath } from "./worker-routes.js";

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

/**
 * Reaching the Worker is half the problem. The other half shipped to staging:
 * GET /v1/definitely-not-a-route answered 200 with the dashboard's HTML,
 * because the catch-all handed every unmatched path to the asset binding and
 * that binding is configured to answer anything with the app shell.
 *
 * A renamed endpoint therefore kept reporting success.
 */
describe("paths the Worker must answer itself", () => {
  it("claims the paths it owns", () => {
    for (const path of ["/health", "/v1/queue/1/chain", "/api/anything", "/admin/seed", "/.well-known/thwip-keys"]) {
      expect(isWorkerOwnedPath(path), `${path} would be answered by the dashboard's HTML`).toBe(true);
    }
  });

  it("claims an unmatched path under a prefix it owns, so it 404s instead of serving a page", () => {
    expect(isWorkerOwnedPath("/v1/definitely-not-a-route")).toBe(true);
    expect(isWorkerOwnedPath("/api/definitely-not-a-route")).toBe(true);
  });

  it("leaves the site and the dashboard to the assets", () => {
    for (const path of ["/", "/faq", "/install", "/dashboard/projects/recallnet/thwip", "/assets/index.js"]) {
      expect(isWorkerOwnedPath(path), `${path} must still be served as a page`).toBe(false);
    }
  });

  /** `/v1x` starts with `/v1` as a string and is not under `/v1/`. */
  it("does not claim a path that merely shares a prefix's opening characters", () => {
    expect(isWorkerOwnedPath("/v1x")).toBe(false);
    expect(isWorkerOwnedPath("/healthy")).toBe(false);
  });

  it("keeps its list equal to the one the deploy configuration uses", () => {
    expect([...WORKER_PREFIXES].sort()).toEqual(runWorkerFirst().sort());
  });
});
