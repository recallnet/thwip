import { describe, expect, it } from "vitest";
import { bytesDigest } from "@thwip/protocol";
import {
  deriveProjectConfigFromText,
  parseThwipYaml,
  type RepositorySnapshot,
} from "./index.js";

class MemorySnapshot implements RepositorySnapshot {
  private readonly files = new Map<string, Uint8Array>();

  constructor(files: Record<string, string>) {
    const encoder = new TextEncoder();
    for (const [path, content] of Object.entries(files)) this.files.set(path, encoder.encode(content));
  }

  async hasFile(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async listFiles(path: string): Promise<string[]> {
    const prefix = `${path.replace(/\/+$/, "")}/`;
    return [...this.files.keys()].filter((candidate) => candidate.startsWith(prefix));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`missing ${path}`);
    return bytes;
  }
}

describe("canonical project policy derivation", () => {
  it("derives command policy from the frozen repository tree", async () => {
    const yaml = `
version: 3
profile: fresh
required: [lint, test]
remote: [build-darwin]
policy:
  minimum_permission: maintain
`;
    const config = await deriveProjectConfigFromText(
      yaml,
      { ownerId: "10", repositoryId: "20" },
      new MemorySnapshot({ "thwip.yaml": yaml, "pnpm-lock.yaml": "lockfileVersion: '9.0'" }),
    );

    expect(config.pipeline).toEqual({
      schemaVersion: "1",
      runner: "command",
      suites: [
        { id: "lint", command: ["sh", "-c", "pnpm run lint"] },
        { id: "test", command: ["sh", "-c", "pnpm run test"] },
      ],
    });
    expect(config.policy).toMatchObject({
      projectId: "gh:20",
      repositoryId: "20",
      ownerId: "10",
      version: 3,
      securityProfile: "fresh",
      minimumPermission: "maintain",
      pipeline: { digest: config.pipelineDigest, requiredSuites: ["lint", "test"], remoteSuites: ["build-darwin"] },
    });
    expect(config.policyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("preserves the legacy depth-first Dagger module digest from committed bytes", async () => {
    const yaml = `
version: 1
profile: fast
required: [check]
pipeline:
  module: ./dagger
`;
    const config = await deriveProjectConfigFromText(
      yaml,
      { ownerId: "10", repositoryId: "20" },
      new MemorySnapshot({
        "thwip.yaml": yaml,
        "dagger/a.txt": "A",
        "dagger/sub/b.txt": "B",
        "dagger/sdk/ignored.txt": "ignored",
        "dagger/z.txt": "Z",
      }),
    );
    const expected = await bytesDigest(new TextEncoder().encode("a.txtAb.txtBz.txtZ"));
    expect(config.pipeline.moduleDigest).toBe(expected);
  });

  it("rejects a module path that escapes the canonical repository tree", () => {
    expect(() =>
      parseThwipYaml(`
version: 1
profile: fast
required: [test]
pipeline:
  module: ../outside
`),
    ).toThrow("must stay inside the repository");
  });
});
