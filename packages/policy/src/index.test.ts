import { describe, expect, it } from "vitest";
import { bytesDigest } from "@thwip/protocol";
import {
  deriveEffectiveProjectConfig,
  deriveProjectConfigFromText,
  parseThwipYaml,
  resolveThwipYaml,
  type RepositorySnapshot,
  type ThwipYaml,
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

  it("derives a policy from organization defaults when the repository has no yaml", async () => {
    const defaults: ThwipYaml = {
      version: 4,
      profile: "fast",
      required: ["lint", "test"],
      suites: { lint: "npm run lint", test: "npm test" },
      policy: { minimum_permission: "maintain" },
    };
    const config = await deriveEffectiveProjectConfig(
      defaults,
      null,
      { ownerId: "10", repositoryId: "20" },
      new MemorySnapshot({ "package-lock.json": "{}" }),
    );

    expect(config.configSource).toBe("global");
    expect(config.policy).toMatchObject({
      version: 4,
      securityProfile: "fast",
      minimumPermission: "maintain",
      pipeline: { requiredSuites: ["lint", "test"] },
    });
    expect(config.pipeline.suites).toEqual([
      { id: "lint", command: ["sh", "-c", "npm run lint"] },
      { id: "test", command: ["sh", "-c", "npm test"] },
    ]);
  });

  it("lets repository yaml override selected global fields without discarding the rest", () => {
    const defaults: ThwipYaml = {
      version: 3,
      profile: "fast",
      required: ["lint", "test"],
      remote: ["windows"],
      suites: { lint: "npm run lint", test: "npm test" },
      policy: {
        minimum_permission: "write",
        allow_author_as_signer: true,
        proof_max_age_seconds: 3600,
      },
    };
    const resolved = resolveThwipYaml(
      defaults,
      `
version: 4
profile: audited
required: [lint, integration]
suites:
  integration: npm run integration
policy:
  allow_author_as_signer: false
`,
    );

    expect(resolved).toEqual({
      source: "repository-override",
      config: {
        version: 4,
        profile: "audited",
        required: ["lint", "integration"],
        remote: ["windows"],
        suites: {
          lint: "npm run lint",
          test: "npm test",
          integration: "npm run integration",
        },
        policy: {
          minimum_permission: "write",
          allow_author_as_signer: false,
          proof_max_age_seconds: 3600,
        },
      },
    });
  });

  it("requires either global defaults or a complete repository document", () => {
    expect(() => resolveThwipYaml(null, null)).toThrow("no thwip.yaml or organization defaults");
    expect(() => resolveThwipYaml(null, "profile: fast")).toThrow("version must be a positive integer");
  });

  it("rejects malformed policy defaults instead of silently weakening them", () => {
    expect(() =>
      resolveThwipYaml(
        {
          version: 1,
          profile: "fast",
          required: ["test"],
          policy: "not-a-mapping" as never,
        },
        null,
      ),
    ).toThrow("policy");
    expect(() =>
      resolveThwipYaml(
        {
          version: 1,
          profile: "fast",
          required: ["test"],
          policy: { minimum_permission: "read" as never },
        },
        null,
      ),
    ).toThrow("minimum_permission");
  });
});
