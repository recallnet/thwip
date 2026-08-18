import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("the public Action contract", () => {
  it("has two documented inputs with safe hosted defaults", () => {
    const metadata = parse(readFileSync(join(root, "action.yml"), "utf8")) as {
      inputs: Record<string, { default?: string }>;
      runs: { using: string; main: string };
    };
    expect(Object.keys(metadata.inputs)).toEqual(["endpoint", "github-token"]);
    expect(metadata.inputs["endpoint"]?.default).toBe("https://thwip.ai");
    expect(metadata.inputs["github-token"]?.default).toBe("${{ github.token }}");
    expect(metadata.runs).toEqual({ using: "node24", main: "packages/action/dist/index.cjs" });
  });
});
