import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { QUEUE_ACTION_REF, setupPullRequestBody, setupPullRequestFiles, SETUP_BRANCH } from "./bootstrap-workflows.js";
import { PROOF_CHECK, WORKFLOW_CHECK } from "./turn-check.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const files = setupPullRequestFiles({
  endpoint: "https://thwip.example.test",
  actionRef: "recallnet/thwip@v1.2.3",
});

const overrideFiles = setupPullRequestFiles({
  endpoint: "https://thwip.example.test",
  actionRef: "recallnet/thwip@v1.2.3",
  includeRepositoryConfig: true,
});

function file(path: string): string {
  const found = files.find((f) => f.path === path);
  if (found === undefined) throw new Error(`no generated file at ${path}`);
  return found.content;
}

describe("setupPullRequestFiles", () => {
  it("pins new repositories to the current immutable Action release", () => {
    expect(QUEUE_ACTION_REF).toBe("recallnet/thwip@2c47d61a145c2a7cc245326ccae090c279378962");
  });

  it("offers only the workflows while inheriting organization defaults", () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      ".github/workflows/thwip-queue-verify.yml",
      ".github/workflows/thwip-required.yml",
    ]);
  });

  /**
   * `remote` and `audited` claim the integrated candidate was run, and the run
   * happens in a workflow the control plane dispatches by
   * `repository_dispatch: thwip-queue-verify`. The template emitted no such
   * file, so every repository enrolled through the product got a dispatch
   * nothing listened to.
   */
  it("answers the candidate dispatch the control plane sends", () => {
    const verify = parse(file(".github/workflows/thwip-queue-verify.yml")) as {
      name: string;
      on: { repository_dispatch: { types: string[] } };
    };
    expect(verify.name).toBe("thwip-queue-verify");
    expect(verify.on.repository_dispatch.types).toEqual(["thwip-queue-verify"]);
  });

  /**
   * Which suites the verdict has to cover comes from the activated policy, which
   * only the control plane holds. Reading it out of the candidate checkout would
   * let a pull request shrink its own suite list.
   */
  it("runs the suites the dispatch named, not a list baked into the file", () => {
    const verify = file(".github/workflows/thwip-queue-verify.yml");
    expect(verify).toContain("github.event.client_payload.requiredSuites");
    expect(verify).not.toMatch(/for suite in lint typecheck test/);
  });

  it("keeps candidate code outside every OIDC and write-capable job", () => {
    const verify = parse(file(".github/workflows/thwip-queue-verify.yml")) as {
      jobs: Record<string, {
        permissions?: Record<string, string>;
        steps?: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
      }>;
    };
    expect(verify.jobs["prepare"]?.permissions).toEqual({});
    expect(verify.jobs["verify"]?.permissions).toEqual({ contents: "read" });
    expect(verify.jobs["report"]?.permissions).toEqual({ "id-token": "write" });
    const candidate = JSON.stringify(verify.jobs["verify"]);
    expect(candidate).not.toContain("id-token");
    expect(candidate).not.toContain("ACTIONS_ID_TOKEN");
    expect(candidate).not.toContain("artifact");
    expect(candidate).not.toContain("cache");
    expect(candidate).not.toMatch(/\\bwrite\\b/);
    expect(verify.jobs["verify"]?.steps?.[0]).toMatchObject({
      uses: expect.stringMatching(/^actions\/checkout@[0-9a-f]{40}$/),
      with: { "persist-credentials": false },
    });
  });

  it("gives the clean reporter only a pending-report identity", () => {
    const verify = parse(file(".github/workflows/thwip-queue-verify.yml")) as {
      jobs: Record<string, { permissions?: Record<string, string>; steps?: Array<{ uses?: string; run?: string }> }>;
    };
    const report = verify.jobs["report"];
    expect(report?.permissions).toEqual({ "id-token": "write" });
    expect(report?.steps).toHaveLength(1);
    expect(report?.steps?.[0]?.uses).toBeUndefined();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("actions:read");
    expect(serialized).not.toContain("checkout");
    expect(serialized).not.toContain("artifact");
    expect(serialized).not.toContain("outputs.");
    expect(serialized).not.toContain("requiredSuites");
    expect(serialized).not.toContain("accepted");
    expect(serialized).not.toContain("reasonCodes");
    expect(serialized).not.toContain("candidateSha");
    expect(serialized).toContain("dispatchNonce");
  });

  it("publishes the proof check GitHub Actions is the source of", () => {
    const workflow = parse(file(".github/workflows/thwip-required.yml")) as {
      name: string;
      jobs: Record<string, { name: string }>;
    };
    expect(workflow.name).toBe(PROOF_CHECK);
    expect(workflow.jobs["thwip"]?.name).toBe(WORKFLOW_CHECK);
  });

  it("produces workflows GitHub can parse and will run", () => {
    for (const generated of files) {
      if (!generated.path.endsWith(".yml") || generated.path === "thwip.yaml") continue;
      const workflow = parse(generated.content) as Record<string, unknown>;
      expect(Object.hasOwn(workflow, "on")).toBe(true);
    }
  });

  it("points a foreign repository at the published action, never at a local checkout", () => {
    const required = file(".github/workflows/thwip-required.yml");
    expect(required).toContain("uses: recallnet/thwip@v1.2.3");
    expect(required).not.toMatch(/uses:\s*\.\/\s*$/m);
  });

  it("carries the endpoint the control plane is deployed at", () => {
    expect(file(".github/workflows/thwip-required.yml")).toContain("https://thwip.example.test");
    expect(file(".github/workflows/thwip-queue-verify.yml")).toContain("https://thwip.example.test");
  });

  it("needs no merge workflow or repository write token when the App writes", () => {
    expect(files.map((generated) => generated.path)).not.toContain(".github/workflows/thwip-merge.yml");
    expect(files.map((generated) => generated.content).join("\n")).not.toContain("THWIP_ENQUEUE_TOKEN");
    const body = setupPullRequestBody({
      endpoint: "https://thwip.example.test",
      actionRef: "recallnet/thwip@v1.2.3",
    });
    expect(body).toMatch(/does not request `administration: write`/);
    expect(body).toMatch(/`workflows: write` when a reviewed merge changes CI definitions/);
    expect(body).toMatch(/No repository merge token is needed/);
  });

  it("commits a thwip.yaml only when the team explicitly chooses a repository override", () => {
    expect(files.map((generated) => generated.path)).not.toContain("thwip.yaml");
    const source = overrideFiles.find((generated) => generated.path === "thwip.yaml")?.content;
    expect(source).toBeDefined();
    const policy = parse(source!) as { version: number; required: string[] };
    expect(policy.version).toBeGreaterThanOrEqual(4);
    expect(policy.required.length).toBeGreaterThan(0);
  });

  it("names a branch that cannot collide with a working branch", () => {
    expect(SETUP_BRANCH).toBe("thwip/setup");
  });
});

/**
 * The template is a workflow, so the rules workflows are held to apply to it.
 *
 * `scripts/lint.mjs` reads `.github/workflows`, and the template is TypeScript
 * that emits YAML, so lint does not see it. Apply the same workflow validation
 * to the generated setup files.
 */
const { validateWorkflow } = (await import(join(repoRoot, "scripts/workflow-lint.mjs"))) as {
  validateWorkflow: (filename: string, source: string) => void;
};

const { PRODUCTION_ENDPOINT } = (await import(join(repoRoot, "scripts/generate-workflows.mjs"))) as {
  PRODUCTION_ENDPOINT: string;
};

describe("the generated workflows under the workflow lint", () => {
  for (const generated of files.filter((f) => f.path.startsWith(".github/workflows/"))) {
    it(`passes every rule for ${generated.path}`, () => {
      expect(() => validateWorkflow(generated.path, generated.content)).not.toThrow();
    });
  }
});

describe("drift against this repository's own workflows", () => {
  /**
   * The generated proof workflow is a copy of the one this repository runs, so a
   * change to the original that never reaches the template would enrol new
   * repositories on a workflow that no longer matches the check the ruleset
   * requires. Names are what the ruleset pins, so names are what this compares.
   */
  it("agrees with .github/workflows/thwip-required.yml on the names the ruleset pins", () => {
    const live = parse(readFileSync(join(repoRoot, ".github/workflows/thwip-required.yml"), "utf8")) as {
      name: string;
      jobs: Record<string, { name: string }>;
    };
    const generated = parse(file(".github/workflows/thwip-required.yml")) as {
      name: string;
      jobs: Record<string, { name: string }>;
    };
    expect(generated.name).toBe(live.name);
    expect(Object.keys(generated.jobs)).toEqual(Object.keys(live.jobs));
    expect(generated.jobs["thwip"]?.name).toBe(WORKFLOW_CHECK);
    expect(generated.jobs["thwip"]?.name).toBe(live.jobs["thwip"]?.name);
  });

  it("keeps this repository on v2 until the explicit production cutover", () => {
    const live = readFileSync(join(repoRoot, ".github/workflows/thwip-queue-verify.yml"), "utf8");
    const upgrade = setupPullRequestFiles({
      endpoint: PRODUCTION_ENDPOINT,
      actionRef: "recallnet/thwip@v1",
    }).find((f) => f.path === ".github/workflows/thwip-queue-verify.yml")?.content;
    expect(live).toContain("Thwip verifier callback protocol: 2");
    expect(live).not.toBe(upgrade);
    expect(upgrade).toContain("Thwip verifier callback protocol: 3");
  });
});
