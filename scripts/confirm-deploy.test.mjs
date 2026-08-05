import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { dirtyShaCaveat, waitForBuildSha } from "./confirm-deploy.mjs";

/** A fake clock and sleep that advance together, so a timeout test runs instantly. */
function fakeClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
}

describe("waiting for the deployed sha to serve", () => {
  it("succeeds the moment /health reports the sha just deployed", async () => {
    const { now, sleep } = fakeClock();
    const fetchImpl = async () => ({ ok: true, json: async () => ({ buildSha: "abc123" }) });

    const result = await waitForBuildSha({
      url: "https://example.test/health",
      expectedSha: "abc123",
      fetchImpl,
      now,
      sleep,
    });

    expect(result.ok).toBe(true);
    expect(result.sha).toBe("abc123");
    expect(result.attempts).toBe(1);
  });

  /**
   * A real deploy propagates over a few seconds: /health answers with the
   * previous sha on the first polls, then the new one.
   */
  it("keeps polling through a stale answer until the new sha appears", async () => {
    const { now, sleep } = fakeClock();
    let call = 0;
    const seen = ["old-sha", "old-sha", "new-sha"];
    const fetchImpl = async () => ({ ok: true, json: async () => ({ buildSha: seen[call++] }) });

    const result = await waitForBuildSha({
      url: "https://example.test/health",
      expectedSha: "new-sha",
      fetchImpl,
      now,
      sleep,
      sleepMs: 1000,
      timeoutMs: 60000,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });

  /**
   * The failure this script exists to catch: wrangler exits zero, and /health
   * never reports the sha that was just deployed. A confirmation that passes
   * on a timeout is worse than none, so this must fail, not warn.
   */
  it("fails when the expected sha never appears before the timeout", async () => {
    const { now, sleep } = fakeClock();
    const fetchImpl = async () => ({ ok: true, json: async () => ({ buildSha: "stale-sha" }) });

    const result = await waitForBuildSha({
      url: "https://example.test/health",
      expectedSha: "new-sha",
      fetchImpl,
      now,
      sleep,
      sleepMs: 5000,
      timeoutMs: 20000,
    });

    expect(result.ok).toBe(false);
    expect(result.sha).toBe("stale-sha");
    expect(result.waitedMs).toBeGreaterThanOrEqual(20000);
  });

  it("fails, rather than hangs, when /health cannot be read at all", async () => {
    const { now, sleep } = fakeClock();
    const fetchImpl = async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    };

    const result = await waitForBuildSha({
      url: "https://example.test/health",
      expectedSha: "new-sha",
      fetchImpl,
      now,
      sleep,
      sleepMs: 5000,
      timeoutMs: 10000,
    });

    expect(result.ok).toBe(false);
    expect(result.sha).toBeNull();
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("treats a response body with no buildSha field as not a match, not a crash", async () => {
    const { now, sleep } = fakeClock();
    const fetchImpl = async () => ({ ok: true, json: async () => ({}) });

    const result = await waitForBuildSha({
      url: "https://example.test/health",
      expectedSha: "new-sha",
      fetchImpl,
      now,
      sleep,
      sleepMs: 5000,
      timeoutMs: 10000,
    });

    expect(result.ok).toBe(false);
    expect(result.sha).toBeNull();
  });
});

describe("a sha stamped from a dirty tree", () => {
  it("is flagged as not unique across dirty deploys", () => {
    const caveat = dirtyShaCaveat("385bafd91c2a-dirty");
    expect(caveat).toMatch(/not unique/);
  });

  it("says nothing about a clean commit sha", () => {
    expect(dirtyShaCaveat("385bafd91c2a")).toBeNull();
  });
});

describe("the deploy command", () => {
  const pkg = readFileSync(fileURLToPath(new URL("../apps/control-plane/package.json", import.meta.url)), "utf8");
  const scripts = JSON.parse(pkg).scripts;

  /**
   * The whole point breaks if the sha that gets deployed and the sha this
   * script confirms against are computed by two separate calls to
   * build-sha.mjs: a dirty tree edited between them would deploy one sha and
   * confirm a different one, failing for a reason that has nothing to do with
   * whether the deploy worked. `deploy:staging` must compute it once and reuse
   * the value for both.
   */
  it("computes BUILD_SHA once and passes the same value to wrangler and to confirm-deploy", () => {
    const command = scripts["deploy:staging"];
    expect(command).toContain("confirm-deploy.mjs");
    const assignments = command.match(/BUILD_SHA=/g) ?? [];
    expect(assignments.length).toBe(1);
    expect(command).toMatch(/--var BUILD_SHA:"\$BUILD_SHA"/);
    expect(command).toMatch(/confirm-deploy\.mjs --env staging --sha "\$BUILD_SHA"/);
  });

  it("still refuses to fail silently: confirm-deploy runs after wrangler deploy, chained with &&", () => {
    const command = scripts["deploy:staging"];
    const deployIndex = command.indexOf("wrangler deploy");
    const confirmIndex = command.indexOf("confirm-deploy.mjs");
    expect(deployIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(deployIndex);
    const between = command.slice(0, confirmIndex);
    expect(between).toMatch(/&&\s+node\s+\S*$/);
  });
});
