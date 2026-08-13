import { describe, expect, it } from "vitest";
import { bytesDigest } from "@thwip/protocol";
import {
  deriveEffectiveProjectConfig,
  deriveProjectConfig,
  exclusivePathMatches,
  MAX_EXCLUSIVE_PATH_LENGTH,
  MAX_EXCLUSIVE_PATHS,
  MAX_PIPELINE_MODULE_PATH_LENGTH,
  parseThwipYaml,
  repositoryDirectoryPrefix,
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
    const prefix = repositoryDirectoryPrefix(path);
    return [...this.files.keys()].filter((candidate) => candidate.startsWith(prefix));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`missing ${path}`);
    return bytes;
  }
}

/**
 * Two of the four profiles promise something nothing produces.
 *
 * Fresh and Audited are defined as issuing an assignment and requiring an
 * integration receipt signed where the suites ran. Nothing issues an assignment
 * and nothing signs a receipt, so a repository selecting either got what Remote
 * gives — suites run in GitHub Actions against the candidate — under a name that
 * claims more. Refusing is better than quietly delivering something else.
 */
describe("profiles the service can actually deliver", () => {
  const withProfile = (profile: string) => `
version: 3
profile: ${profile}
required: [lint, test]
policy:
  minimum_permission: maintain
`;
  // Async so a parse rejection reaches `.rejects`, the same as the config path.
  const derive = async (profile: string) => {
    const yaml = withProfile(profile);
    return deriveProjectConfig(
      parseThwipYaml(yaml),
      { ownerId: "10", repositoryId: "20" },
      new MemorySnapshot({ "thwip.yaml": yaml, "pnpm-lock.yaml": "lockfileVersion: '9.0'" }),
    );
  };

  it("accepts the two it can deliver", async () => {
    for (const profile of ["fast", "remote"]) {
      await expect(derive(profile), profile).resolves.toBeDefined();
    }
  });

  /**
   * These two were refused while nothing signed an integration receipt. The
   * queue issues a signed assignment now, the device signs a receipt over the
   * tree it built, and the merge gate refuses without one, so selecting them
   * delivers what their names claim.
   */
  it("accepts the two that require an integration receipt", async () => {
    for (const profile of ["fresh", "audited"]) {
      await expect(derive(profile), profile).resolves.toBeDefined();
    }
  });

  it("still refuses a profile that is not one at all", async () => {
    await expect(derive("turbo")).rejects.toThrow(/profile/i);
  });
});

describe("canonical project policy derivation", () => {
  it("signs sorted exclusive path globs into the policy bundle", async () => {
    const yaml = `
version: 4
profile: fast
required: [lint, test]
policy:
  exclusive_paths:
    - "schema/*/generated?.sql"
    - "migrations/**"
`;
    const config = await deriveProjectConfig(
      parseThwipYaml(yaml),
      { ownerId: "10", repositoryId: "20" },
      new MemorySnapshot({ "pnpm-lock.yaml": "" }),
    );

    expect(config.policy.exclusivePaths).toEqual(["migrations/**", "schema/*/generated?.sql"]);
  });

  it("leaves the legacy bundle shape unchanged when no exclusive paths are configured", async () => {
    const config = await deriveProjectConfig(
      { version: 4, profile: "fast", required: ["test"] },
      { ownerId: "10", repositoryId: "20" },
      new MemorySnapshot({ "pnpm-lock.yaml": "" }),
    );
    expect(config.policy).not.toHaveProperty("exclusivePaths");
  });

  it("rejects ambiguous, escaping, duplicated and unbounded exclusive globs", () => {
    const document = (patterns: readonly string[]) => `
version: 4
profile: fast
required: [test]
policy:
  exclusive_paths: ${JSON.stringify(patterns)}
`;
    for (const patterns of [
      ["../migrations/**"],
      ["/migrations/**"],
      ["migrations\\**"],
      ["migrations/**.sql"],
      ["migrations//*.sql"],
      ["migrations/**", "migrations/**"],
      ["x".repeat(MAX_EXCLUSIVE_PATH_LENGTH + 1)],
      Array.from({ length: MAX_EXCLUSIVE_PATHS + 1 }, (_, index) => `p${index}`),
    ]) {
      expect(() => parseThwipYaml(document(patterns)), JSON.stringify(patterns)).toThrow(/exclusive_paths/);
    }
  });

  it("applies exclusive glob validation to direct policy derivation too", async () => {
    await expect(
      deriveProjectConfig(
        {
          version: 4,
          profile: "fast",
          required: ["test"],
          policy: { exclusive_paths: ["../migrations/**"] },
        },
        { ownerId: "10", repositoryId: "20" },
        new MemorySnapshot({ "pnpm-lock.yaml": "" }),
      ),
    ).rejects.toThrow(/exclusive_paths/);
  });

  it("matches only the documented repository-relative glob language", () => {
    expect(exclusivePathMatches("migrations/**", "migrations/0033/add.sql")).toBe(true);
    expect(exclusivePathMatches("migrations/**", "migrations/0033.sql")).toBe(true);
    expect(exclusivePathMatches("schema/*/generated?.sql", "schema/users/generated1.sql")).toBe(true);
    expect(exclusivePathMatches("schema/*/generated?.sql", "schema/users/nested/generated1.sql")).toBe(false);
    expect(exclusivePathMatches("migrations/*.sql", "migrations/nested/0033.sql")).toBe(false);
    expect(exclusivePathMatches("**/manifest.json", "manifest.json")).toBe(true);
    expect(exclusivePathMatches("**/manifest.json", "packages/a/manifest.json")).toBe(true);
    expect(exclusivePathMatches("../**", "migrations/0033.sql")).toBe(false);
  });

  it("derives command policy from the frozen repository tree", async () => {
    const yaml = `
version: 3
profile: remote
required: [lint, test]
remote: [build-darwin]
policy:
  minimum_permission: maintain
`;
    const config = await deriveProjectConfig(
      parseThwipYaml(yaml),
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
      securityProfile: "remote",
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
    const config = await deriveProjectConfig(
      parseThwipYaml(yaml),
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

  it("preserves accepted and rejected repository path forms", async () => {
    const accepted = ["dagger", "./dagger", ".//dagger", "dagger/", "dagger///", ".\\dagger\\"];
    for (const module of accepted) {
      const config = await deriveProjectConfig(
        parseThwipYaml(`
version: 1
profile: fast
required: [check]
pipeline:
  module: '${module}'
`),
        { ownerId: "10", repositoryId: "20" },
        new MemorySnapshot({ "dagger/main.ts": "export default {}" }),
      );
      expect(config.pipeline.moduleDigest, module).toMatch(/^sha256:/);
    }

    for (const module of ["", "/", "///", ".", "..", "././dagger", "dagger/./sub", "dagger/../sub"]) {
      expect(
        () =>
          parseThwipYaml(`
version: 1
profile: fast
required: [check]
pipeline:
  module: '${module}'
`),
        module,
      ).toThrow(/path to a Dagger module|stay inside the repository/);
    }
  });

  it("bounds the module path before normalization", () => {
    const atLimit = "a".repeat(MAX_PIPELINE_MODULE_PATH_LENGTH);
    expect(() =>
      parseThwipYaml(`
version: 1
profile: fast
required: [check]
pipeline:
  module: '${atLimit}'
`),
    ).not.toThrow();

    const overLimit = `${atLimit}a`;
    expect(() =>
      parseThwipYaml(`
version: 1
profile: fast
required: [check]
pipeline:
  module: '${overLimit}'
`),
    ).toThrow(`pipeline.module must be ${MAX_PIPELINE_MODULE_PATH_LENGTH} characters or fewer`);
  });

  it("applies the path bound to direct policy derivation too", async () => {
    const module = "a".repeat(MAX_PIPELINE_MODULE_PATH_LENGTH + 1);
    await expect(
      deriveProjectConfig(
        { version: 1, profile: "fast", required: ["check"], pipeline: { module } },
        { ownerId: "10", repositoryId: "20" },
        new MemorySnapshot({}),
      ),
    ).rejects.toThrow(`pipeline.module must be ${MAX_PIPELINE_MODULE_PATH_LENGTH} characters or fewer`);
  });

  it("handles an adversarial slash run followed by a non-slash in linear code", () => {
    const path = `${"/".repeat(100_000)}x`;
    expect(repositoryDirectoryPrefix(path)).toBe(`${path}/`);
    const trailingSlashes = `dagger${"/".repeat(100_000)}`;
    expect(repositoryDirectoryPrefix(trailingSlashes)).toBe("dagger/");
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
profile: remote
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
        profile: "remote",
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

/**
 * What each profile derives, so a profile cannot be a name with no consequence.
 *
 * The profile contract is the source: Fresh always issues a new assignment
 * and requires a post-assignment local integration receipt, and Audited is
 * fresh local receipt plus a full rerun in GitHub Actions before merge. The lease is the proof-layer form of the first: a window this
 * service opened for this exact tree, which the run has to sit inside. The
 * rerun is the second, and it is full rather than sampled, so every required
 * suite has to be proven by GitHub's own checks as well as by the signer.
 */
describe("what a profile derives", () => {
  const ids = { ownerId: "162603603", repositoryId: "1315419165" };
  const snapshot = new MemorySnapshot({ "pnpm-lock.yaml": "" });
  const yaml = (profile: ThwipYaml["profile"], extra?: Partial<ThwipYaml>): ThwipYaml => ({
    version: 1,
    profile,
    required: ["lint", "test"],
    ...extra,
  });

  it("asks for no lease under fast and a lease under every other profile", async () => {
    for (const profile of ["fast", "fresh", "audited", "remote"] as const) {
      const { policy } = await deriveProjectConfig(yaml(profile), ids, snapshot);
      expect(policy.lease.required, profile).toBe(profile !== "fast");
    }
  });

  it("makes audited re-run every required suite in GitHub Actions", async () => {
    const { policy } = await deriveProjectConfig(yaml("audited"), ids, snapshot);
    expect(policy.pipeline.remoteSuites).toEqual(["lint", "test"]);
  });

  it("keeps the suites a project already names remote alongside the audited rerun", async () => {
    const { policy } = await deriveProjectConfig(yaml("audited", { remote: ["e2e"] }), ids, snapshot);
    expect(policy.pipeline.remoteSuites).toEqual(["lint", "test", "e2e"]);
  });

  it("re-runs nothing under the profiles that never promised a second execution", async () => {
    for (const profile of ["fast", "fresh"] as const) {
      const { policy } = await deriveProjectConfig(yaml(profile), ids, snapshot);
      expect(policy.pipeline.remoteSuites, profile).toBeUndefined();
    }
  });
});

/**
 * A policy field nothing sets is not a control. It reads as one to whoever
 * opens the policy, and the verifier spends a branch on data no part of the
 * system produces. These three carried that shape and are gone.
 */
describe("fields a policy no longer carries", () => {
  const ids = { ownerId: "162603603", repositoryId: "1315419165" };
  const snapshot = new MemorySnapshot({ "pnpm-lock.yaml": "" });

  it("names no evaluation mode, audit rate or GitHub key requirement", async () => {
    for (const profile of ["fast", "remote"] as const) {
      const { policy } = await deriveProjectConfig(
        { version: 1, profile, required: ["lint"] },
        ids,
        snapshot,
      );
      const keys = Object.keys(policy);
      expect(keys, profile).not.toContain("evaluationMode");
      expect(keys, profile).not.toContain("audit");
      expect(keys, profile).not.toContain("requireGithubKeyPresence");
    }
  });
});
