import { describe, expect, it } from "vitest";
import {
  buildMismatchFailure,
  findCliCheckout,
  parseBuildStamp,
  setupCommandMayUseForeignBuild,
  versionReport,
} from "./build-identity.js";

/**
 * Which build is running, and does it belong to the checkout it is standing in.
 *
 * The machine that found this had one `thwip` on PATH, symlinked into the main
 * worktree. Every agent in every worktree ran that build whatever branch they
 * were on, so a change to the CLI was never the code under test and the CLI's
 * behaviour depended on when main was last compiled.
 */

const identity = { version: "0.1.1", commit: "36b6338a1b2c" };

describe("buildMismatchFailure", () => {
  it("says nothing when the running build comes from this checkout", () => {
    expect(
      buildMismatchFailure({
        runningMainPath: "/repos/thwip/packages/cli/dist/main.js",
        checkoutRoot: "/repos/thwip",
        identity,
      }),
    ).toBeNull();
  });

  it("says nothing outside a checkout that builds its own thwip", () => {
    expect(
      buildMismatchFailure({
        runningMainPath: "/repos/thwip/packages/cli/dist/main.js",
        checkoutRoot: null,
        identity,
      }),
    ).toBeNull();
  });

  it("names both the build and the checkout when they disagree", () => {
    const warning = buildMismatchFailure({
      runningMainPath: "/repos/thwip/packages/cli/dist/main.js",
      checkoutRoot: "/wt/thwip/cli-ship-fixes",
      identity,
    });
    expect(warning).not.toBeNull();
    expect(warning).toContain("/repos/thwip/packages/cli/dist/main.js");
    expect(warning).toContain("/wt/thwip/cli-ship-fixes");
    expect(warning).toContain("0.1.1");
    expect(warning).toContain("36b6338a1b2c");
    expect(warning).toContain("Stop");
    // It has to be actionable, and it has to be one line.
    expect(warning).toContain("pnpm -w thwip <command>");
    expect(warning!.split("\n")).toHaveLength(1);
  });

  it("does not mistake a sibling checkout with a shared prefix for this one", () => {
    // "/repos/thwip-old" starts with "/repos/thwip". A plain string prefix
    // would call that a match and stay silent about the wrong build.
    expect(
      buildMismatchFailure({
        runningMainPath: "/repos/thwip-old/packages/cli/dist/main.js",
        checkoutRoot: "/repos/thwip",
        identity,
      }),
    ).not.toBeNull();
  });

  it("rejects a build elsewhere in the same checkout", () => {
    // Only packages/cli produces a thwip. Anything else under the root that
    // claims to be one is not this checkout's build.
    expect(
      buildMismatchFailure({
        runningMainPath: "/repos/thwip/apps/somewhere/main.js",
        checkoutRoot: "/repos/thwip",
        identity,
      }),
    ).not.toBeNull();
  });

  it("counts the published bundle from this checkout as this checkout's build", () => {
    expect(
      buildMismatchFailure({
        runningMainPath: "/repos/thwip/packages/cli/dist-npm/thwip.mjs",
        checkoutRoot: "/repos/thwip",
        identity,
      }),
    ).toBeNull();
  });
});

describe("findCliCheckout", () => {
  const present = new Set([
    "/wt/thwip/branch/.git",
    "/wt/thwip/branch/packages/cli/package.json",
    "/elsewhere/repo/.git",
  ]);
  const exists = (path: string) => present.has(path);
  const read = (path: string) =>
    path === "/wt/thwip/branch/packages/cli/package.json" ? '{"name":"@thwip/cli"}' : null;

  it("walks up to the checkout that builds its own thwip", () => {
    expect(findCliCheckout("/wt/thwip/branch/packages/cli/src", exists, read)).toBe("/wt/thwip/branch");
  });

  it("finds it from the root itself", () => {
    expect(findCliCheckout("/wt/thwip/branch", exists, read)).toBe("/wt/thwip/branch");
  });

  it("reports nothing for a git repository with no thwip CLI in it", () => {
    expect(findCliCheckout("/elsewhere/repo/src", exists, read)).toBeNull();
  });

  it("reports nothing outside a git repository", () => {
    expect(findCliCheckout("/tmp/scratch", exists, read)).toBeNull();
  });

  it("does not mistake an unrelated monorepo CLI package for Thwip", () => {
    const paths = new Set(["/other/.git", "/other/packages/cli/package.json"]);
    expect(
      findCliCheckout("/other", (path) => paths.has(path), () => '{"name":"@other/cli"}'),
    ).toBeNull();
  });
});

describe("the narrow npx setup exception", () => {
  it.each([["init"], ["login"], ["login", "--endpoint", "https://thwip.ai"], ["keys"], ["keys", "status"], ["queue", "setup"], ["queue", "setup", "--help"]])(
    "allows %s",
    (command, ...rest) => expect(setupCommandMayUseForeignBuild([command, ...rest])).toBe(true),
  );

  it.each([["ship"], ["run"], ["doctor"], ["queue", "status"], ["queue", "join"], ["verify"]])("keeps %s strict", (command, ...rest) => {
    expect(setupCommandMayUseForeignBuild([command, ...rest])).toBe(false);
  });
});

describe("parseBuildStamp", () => {
  const main = "/repos/thwip/packages/cli/dist/main.js";

  it("reads what the build wrote", () => {
    expect(parseBuildStamp('{"version":"0.1.1","commit":"36b6338a1b2c"}', main)).toEqual({
      version: "0.1.1",
      commit: "36b6338a1b2c",
      mainPath: main,
    });
  });

  it("keeps the dirty marker, because a dirty build is not the commit", () => {
    expect(parseBuildStamp('{"version":"0.1.1","commit":"36b6338a1b2c-dirty"}', main).commit).toBe(
      "36b6338a1b2c-dirty",
    );
  });

  it("says unknown for a build with no stamp instead of implying one", () => {
    // A dist compiled before this existed is the case. Naming it unknown is the
    // point: a build that cannot say what it is has to say that.
    expect(parseBuildStamp(null, main)).toEqual({ version: "unknown", commit: "unknown", mainPath: main });
    expect(parseBuildStamp("not json", main).commit).toBe("unknown");
    expect(parseBuildStamp("{}", main).version).toBe("unknown");
  });
});

describe("versionReport", () => {
  it("names the version, the commit, and the file that is running", () => {
    const text = versionReport({ ...identity, mainPath: "/repos/thwip/packages/cli/dist/main.js" });
    expect(text).toContain("0.1.1");
    expect(text).toContain("36b6338a1b2c");
    expect(text).toContain("/repos/thwip/packages/cli/dist/main.js");
  });

  it("says a build carries no stamp rather than implying one", () => {
    const text = versionReport({ version: "unknown", commit: "unknown", mainPath: "/somewhere/thwip.mjs" });
    expect(text).toContain("unknown");
  });
});
