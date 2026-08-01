import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * The committed bundle is what GitHub actually runs.
 *
 * `dist/index.cjs` is tracked because a GitHub Action runs from the repository,
 * not from a build step. Nothing rebuilt it when its dependencies changed, and
 * the action bundles the workspace packages, so every edit to `queue-domain` or
 * `queue-protocol` staled it without touching a single file under
 * `packages/action/src`. It went 202 lines out of date that way, and CI kept
 * running the old reason codes while the source said otherwise.
 *
 * This is the same failure that put a worker live whose protocol did not know a
 * record kind the same commit had added, and the same one `/.well-known` hit:
 * code that is right and a build that never shipped it.
 */

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe("the action bundle GitHub runs", () => {
  it("matches what its source builds today", async () => {
    const built = await build({
      entryPoints: ["src/main.ts"],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      write: false,
      // esbuild writes each module's path into the bundle as a comment, relative
      // to the working directory. The package's build script runs from the
      // package, so this must too or the comments differ and nothing else does.
      absWorkingDir: here(".."),
    });

    const fresh = built.outputFiles[0]!.text;
    const committed = readFileSync(here("../dist/index.cjs"), "utf8");

    expect(
      fresh,
      "packages/action/dist/index.cjs is stale. Run `pnpm --filter @thwip/action build` and commit the result, " +
        "otherwise GitHub keeps running the previous bundle.",
    ).toBe(committed);
  });
});
