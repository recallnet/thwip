import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  QUEUE_ACTION_REF,
  setupPullRequestBody,
  setupPullRequestFiles,
  SETUP_BRANCH,
  sourceRepositoryRequiredWorkflowFile,
} from "./bootstrap-workflows.js";
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
    expect(QUEUE_ACTION_REF).toBe("recallnet/thwip@ca2a4d70946fe2b2aa364998dbae227ae81e8186");
  });

  it("offers only the workflows while inheriting organization defaults", () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      ".github/workflows/thwip-queue-verify.yml",
      ".github/workflows/thwip-required.yml",
    ]);
  });

  it("answers the candidate dispatch the control plane sends", () => {
    const verify = parse(file(".github/workflows/thwip-queue-verify.yml")) as {
      name: string;
      on: { repository_dispatch: { types: string[] } };
    };
    expect(verify.name).toBe("thwip-queue-verify");
    expect(verify.on.repository_dispatch.types).toEqual(["thwip-queue-verify"]);
  });

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
      jobs: Record<string, {
        permissions?: Record<string, string>;
        steps?: Array<{ uses?: string; run?: string; env?: Record<string, string> }>;
      }>;
    };
    const report = verify.jobs["report"];
    expect(report?.permissions).toEqual({ "id-token": "write" });
    expect(report?.steps).toHaveLength(1);
    expect(report?.steps?.[0]?.uses).toBe("recallnet/thwip@v1.2.3");
    expect(report?.steps?.[0]?.run).toBeUndefined();
    expect(report?.steps?.[0]?.env).toBeUndefined();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("actions:read");
    expect(serialized).not.toContain("checkout");
    expect(serialized).not.toContain("artifact");
    expect(serialized).not.toContain("outputs.");
    expect(serialized).not.toContain("requiredSuites");
    expect(serialized).not.toContain("accepted");
    expect(serialized).not.toContain("reasonCodes");
    expect(serialized).not.toContain("candidateSha");
    expect(serialized).not.toContain("dispatchNonce");
  });

  it("publishes the proof check GitHub Actions is the source of", () => {
    const workflow = parse(file(".github/workflows/thwip-required.yml")) as {
      name: string;
      jobs: Record<string, { name: string }>;
    };
    expect(workflow.name).toBe(PROOF_CHECK);
    expect(workflow.jobs["thwip"]?.name).toBe(WORKFLOW_CHECK);
  });

  it("keeps the public proof workflow to one Action step", () => {
    const workflow = parse(file(".github/workflows/thwip-required.yml")) as {
      jobs: Record<string, { steps: Array<{ uses?: string; run?: string; env?: Record<string, string> }> }>;
    };
    const steps = workflow.jobs["thwip"]?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.uses).toBe("recallnet/thwip@v1.2.3");
    expect(steps[0]?.run).toBeUndefined();
    expect(steps[0]?.env).toBeUndefined();
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
    expect(body).toMatch(/does not need repository administration access or a merge token/);
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

const PRODUCTION_ENDPOINT = "https://thwip.ai";
function validateWorkflow(filename: string, source: string): void {
  const workflow = parse(source) as { on?: { schedule?: unknown } } | null;
  if (workflow === null || typeof workflow !== "object" || Array.isArray(workflow) || !("on" in workflow)) {
    throw new Error(`${filename}: no trigger`);
  }
  if (workflow.on?.schedule !== undefined && source.includes("rerun-failed-jobs")) {
    throw new Error(`${filename}: scheduled workflows must retry current state, not failed runs`);
  }
}

describe("the generated workflows under the workflow lint", () => {
  for (const generated of files.filter((f) => f.path.startsWith(".github/workflows/"))) {
    it(`passes every rule for ${generated.path}`, () => {
      expect(() => validateWorkflow(generated.path, generated.content)).not.toThrow();
    });
  }
});

describe("drift against this repository's own workflows", () => {
  it("keeps this repository on the exact managed proof workflow", () => {
    const live = readFileSync(join(repoRoot, ".github/workflows/thwip-required.yml"), "utf8");
    const generated = sourceRepositoryRequiredWorkflowFile({
      endpoint: PRODUCTION_ENDPOINT,
      actionRef: QUEUE_ACTION_REF,
    }).content;
    expect(generated).toContain("uses: ./");
    expect(live).toBe(generated);
  });

  it("keeps this repository on the exact reviewed v3 workflow after cutover", () => {
    const live = readFileSync(join(repoRoot, ".github/workflows/thwip-queue-verify.yml"), "utf8");
    const upgrade = setupPullRequestFiles({
      endpoint: PRODUCTION_ENDPOINT,
      actionRef: QUEUE_ACTION_REF,
    }).find((f) => f.path === ".github/workflows/thwip-queue-verify.yml")?.content;
    expect(live).toContain("Thwip verifier callback protocol: 3");
    expect(live).toBe(upgrade);
  });
});
