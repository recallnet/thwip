import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe("the action bundle GitHub runs", () => {
  it("matches what its source builds today", async () => {
    const built = await build({
      entryPoints: ["src/entry.ts"],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      write: false,
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
