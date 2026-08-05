/**
 * The blog writes its output into the control-plane's client asset tree, so it
 * cannot build until that tree exists. Nothing in the blog imports the
 * control-plane, so the workspace graph does not know that and pnpm is free to
 * run the blog first.
 *
 * It did, on CI, and every release run on 4 August failed there:
 * `merge-into-client.mjs` found no `dist/client`, the job stopped, and the CLI
 * never published. Ten runs reported failure and nobody was watching.
 *
 * The order lives in the root build script, which runs the blog on its own
 * after everything else. A declared devDependency would say the same thing to
 * pnpm, but it would be a dependency no file imports, and the dead-code lint is
 * right to call that out.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

describe("workspace build order", () => {
  it("runs the blog after the rest of the workspace", () => {
    const build = read("package.json").scripts.build;
    const [bulk, blog] = build.split("&&").map((part) => part.trim());
    expect(bulk).toContain("!@thwip/blog");
    expect(blog).toBe("pnpm --filter @thwip/blog run build");
  });

  it("builds the blog once, not again from inside the control-plane", () => {
    const controlPlane = read("apps/control-plane/package.json");
    expect(controlPlane.scripts.build).not.toContain("@thwip/blog");
  });
});
