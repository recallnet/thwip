import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { setupPullRequestBody, setupPullRequestFiles, SETUP_BRANCH } from "./bootstrap-workflows.js";
import { PROOF_CHECK } from "./turn-check.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const files = setupPullRequestFiles({
  endpoint: "https://thwip.example.test",
  actionRef: "recallnet/thwip@v1.2.3",
  mergeWriter: "app",
});

const legacyFiles = setupPullRequestFiles({
  endpoint: "https://thwip.example.test",
  actionRef: "recallnet/thwip@v1.2.3",
  mergeWriter: "workflow",
});

const overrideFiles = setupPullRequestFiles({
  endpoint: "https://thwip.example.test",
  actionRef: "recallnet/thwip@v1.2.3",
  mergeWriter: "app",
  includeRepositoryConfig: true,
});

function file(path: string): string {
  const found = files.find((f) => f.path === path);
  if (found === undefined) throw new Error(`no generated file at ${path}`);
  return found.content;
}

function legacyFile(path: string): string {
  const found = legacyFiles.find((f) => f.path === path);
  if (found === undefined) throw new Error(`no legacy generated file at ${path}`);
  return found.content;
}

describe("setupPullRequestFiles", () => {
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

  it("publishes the proof check GitHub Actions is the source of", () => {
    const workflow = parse(file(".github/workflows/thwip-required.yml")) as {
      name: string;
      jobs: Record<string, { name: string }>;
    };
    expect(workflow.name).toBe(PROOF_CHECK);
    expect(workflow.jobs[PROOF_CHECK]?.name).toBe(PROOF_CHECK);
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
    expect(file(".github/workflows/thwip-required.yml")).not.toContain("thwip.recall.net");
  });

  it("needs no merge workflow or repository write token when the App writes", () => {
    expect(files.map((generated) => generated.path)).not.toContain(".github/workflows/thwip-merge.yml");
    expect(files.map((generated) => generated.content).join("\n")).not.toContain("THWIP_ENQUEUE_TOKEN");
    const body = setupPullRequestBody({
      endpoint: "https://thwip.example.test",
      actionRef: "recallnet/thwip@v1.2.3",
      mergeWriter: "app",
    });
    expect(body).toMatch(/does not request `administration: write`/);
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
 * that emits YAML, so lint never saw it. This repository's merge workflow was
 * fixed to bind the base and the template was not, and every adopted repository
 * went on merging onto whatever the branch happened to be. Same rules, same
 * messages, applied to what the template emits.
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

/**
 * A squash commit has one parent and does not contain the pull request head, so
 * the branch's own required checks refuse the ref update and GitHub cannot see
 * that the pull request was merged. There is no other primitive to bind it with.
 * Refusing costs a squash repository its merges; merging anyway costs everyone
 * the one claim this queue makes.
 */
describe("a merge method the queue cannot bind", () => {
  const merge = legacyFile(".github/workflows/thwip-merge.yml");

  it("refuses it by name instead of performing it", () => {
    expect(merge).toContain('if [ "$method" != "merge" ]; then');
    expect(merge).toMatch(/::error::this repository merges by \$method/);
  });

  it("hands the lane back rather than holding it until a deadline", () => {
    const refusal = merge.slice(merge.indexOf('if [ "$method" != "merge" ]'));
    expect(refusal.slice(0, refusal.indexOf("exit 1"))).toContain("/not-merged");
  });

  it("says so in the pull request a repository reviews before enabling the queue", () => {
    const body = setupPullRequestBody({
      endpoint: "https://thwip.example.test",
      actionRef: "recallnet/thwip@v1.2.3",
      mergeWriter: "workflow",
    });
    expect(body).toMatch(/squash/i);
  });
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
    expect(generated.jobs[PROOF_CHECK]?.name).toBe(live.jobs[PROOF_CHECK]?.name);
  });

  /**
   * The merge is not compared any more, because there is one of it.
   *
   * Comparing was what this test used to do, and it compared the triggers and
   * the concurrency group while the two copies disagreed about the thing that
   * mattered: this repository composed its merge on the base the queue pinned
   * and every adopted repository asked GitHub to merge onto whatever the branch
   * was. So the checked-in file is now what the template renders, byte for byte,
   * and a change to either is a change to both.
   */
  it.each([".github/workflows/thwip-merge.yml", ".github/workflows/thwip-queue-verify.yml"])(
    "is what %s is written from",
    (path) => {
      const live = readFileSync(join(repoRoot, path), "utf8");
      expect(live).toBe(
        setupPullRequestFiles({
          endpoint: PRODUCTION_ENDPOINT,
          actionRef: "recallnet/thwip@v1",
          mergeWriter: path.endsWith("thwip-merge.yml") ? "workflow" : "app",
        }).find(
          (f) => f.path === path,
        )?.content,
      );
    },
  );
});
