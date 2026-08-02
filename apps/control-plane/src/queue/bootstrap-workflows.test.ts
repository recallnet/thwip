import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { setupPullRequestFiles, SETUP_BRANCH } from "./bootstrap-workflows.js";
import { PROOF_CHECK } from "./turn-check.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const files = setupPullRequestFiles({
  endpoint: "https://thwip.example.test",
  actionRef: "recallnet/thwip@v1.2.3",
});

function file(path: string): string {
  const found = files.find((f) => f.path === path);
  if (found === undefined) throw new Error(`no generated file at ${path}`);
  return found.content;
}

describe("setupPullRequestFiles", () => {
  it("offers the two workflows and the policy a new repository has none of", () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      ".github/workflows/thwip-merge.yml",
      ".github/workflows/thwip-required.yml",
      "thwip.yaml",
    ]);
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
    expect(file(".github/workflows/thwip-merge.yml")).toContain("https://thwip.example.test");
    expect(file(".github/workflows/thwip-required.yml")).not.toContain("thwip.recall.net");
  });

  it("keeps the merge workflow reading the enqueue token it needs", () => {
    expect(file(".github/workflows/thwip-merge.yml")).toContain("secrets.THWIP_ENQUEUE_TOKEN");
  });

  it("commits a thwip.yaml the policy layer can read", () => {
    const policy = parse(file("thwip.yaml")) as { version: number; required: string[] };
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
    expect(generated.jobs[PROOF_CHECK]?.name).toBe(live.jobs[PROOF_CHECK]?.name);
  });

  it("agrees with .github/workflows/thwip-merge.yml on its triggers", () => {
    const live = parse(readFileSync(join(repoRoot, ".github/workflows/thwip-merge.yml"), "utf8")) as {
      on: Record<string, unknown>;
    };
    const generated = parse(file(".github/workflows/thwip-merge.yml")) as { on: Record<string, unknown> };
    expect(Object.keys(generated.on).sort()).toEqual(Object.keys(live.on).sort());
  });

  /**
   * A lane is one pull request at a time on one base branch, and the concurrency
   * group is what GitHub enforces that with. This repository's copy is linted by
   * scripts/workflow-lint.mjs; the generated copy is not lint's to see, so it is
   * held to the live file instead. Adopting repositories then get the group this
   * repository proved, rather than the one pull requests 114, 117 and 119 merged
   * unverified trees under.
   */
  it("agrees with .github/workflows/thwip-merge.yml on the lane", () => {
    type Concurrency = { group: string; "cancel-in-progress": boolean };
    const live = parse(readFileSync(join(repoRoot, ".github/workflows/thwip-merge.yml"), "utf8")) as {
      concurrency: Concurrency;
    };
    const generated = parse(file(".github/workflows/thwip-merge.yml")) as { concurrency: Concurrency };
    expect(generated.concurrency.group).toBe(live.concurrency.group);
    expect(generated.concurrency["cancel-in-progress"]).toBe(false);
    expect(live.concurrency["cancel-in-progress"]).toBe(false);
  });
});
