import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildStamp } from "./build-sha.mjs";

const fakeGit =
  (head, porcelain) =>
  (...args) =>
    args[0] === "status" ? porcelain : head;

describe("the stamp a deploy carries", () => {
  it("names the commit", () => {
    expect(buildStamp(fakeGit("385bafd91c2a", ""))).toBe("385bafd91c2a");
  });

  /**
   * A dirty tree deploys code that exists in no commit, so the stamp must not
   * point at one and imply otherwise.
   */
  it("says so when the tree has uncommitted changes", () => {
    expect(buildStamp(fakeGit("385bafd91c2a", " M src/index.ts\n"))).toBe("385bafd91c2a-dirty");
  });
});

/**
 * The helper is worthless if the deploy never calls it. This is the same class
 * of failure as `/.well-known/thwip-keys` returning HTML: the code was right and
 * the deploy configuration did not use it.
 */
describe("the deploy command", () => {
  const pkg = readFileSync(fileURLToPath(new URL("../apps/control-plane/package.json", import.meta.url)), "utf8");
  const scripts = JSON.parse(pkg).scripts;

  it("stamps the real commit into every deploy", () => {
    for (const [name, command] of Object.entries(scripts)) {
      if (!name.startsWith("deploy")) continue;
      expect(command, `${name} would ship BUILD_SHA "dev"`).toContain("BUILD_SHA:");
      expect(command, `${name} must derive the stamp, not hard-code one`).toContain("build-sha.mjs");
    }
  });

  it("has a deploy script to check", () => {
    expect(Object.keys(scripts).filter((n) => n.startsWith("deploy")).length).toBeGreaterThan(0);
  });
});
