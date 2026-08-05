/**
 * A published build has to be able to say which commit it came from.
 *
 * The release job set the version by rewriting packages/cli/package.json in the
 * checkout and then building. That rewrite is an uncommitted change, so
 * `buildStamp` correctly reported the tree as dirty, and every published
 * release stamped itself `<sha>-dirty`. `thwip version` on a clean install from
 * npm said the same thing a local hack would say, which is the one case the
 * suffix exists to distinguish.
 *
 * The version now arrives through THWIP_RELEASE_VERSION and the file is left
 * alone.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("release stamping", () => {
  it("takes the published version from the environment, leaving the checkout clean", () => {
    for (const script of ["build-npm.mjs", "stamp-build.mjs"]) {
      const source = readFileSync(join(root, "scripts", script), "utf8");
      expect(source).toContain("THWIP_RELEASE_VERSION");
    }
  });

  it("does not rewrite a tracked file to carry the version", () => {
    const workflow = readFileSync(join(root, ".github/workflows/thwip-release.yml"), "utf8");
    expect(workflow).not.toContain("packages/cli/package.json > /tmp/pkg.json");
    expect(workflow).toContain("THWIP_RELEASE_VERSION");
  });

  it("stamps a clean checkout without the dirty suffix", () => {
    const stamp = execFileSync("node", [join(root, "scripts/build-sha.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).length > 0;
    expect(stamp.endsWith("-dirty")).toBe(dirty);
  });
});
