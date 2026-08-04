import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testD1, type TestD1 } from "../../test/d1.js";
import {
  advanceBootstrap,
  bootstrapStatus,
  enrollQueueProject,
  handleBootstrapRequest,
  readQueueProject,
  runBootstrap,
  type BootstrapGitHub,
  type SetupPullRequestState,
  type StoredRuleset,
} from "./bootstrap.js";
import {
  GITHUB_ACTIONS_INTEGRATION_ID,
  OWNERSHIP_RULESET_NAME,
  POLICY_RULESET_NAME,
  type Ruleset,
} from "./rulesets.js";
import { PROOF_CHECK, TURN_CHECK } from "./turn-check.js";

const REPOSITORY_ID = "987654321";
const BASE_REF = "refs/heads/main";
const APP_INTEGRATION_ID = 4419870;
const BASE_SHA = "b".repeat(40);

let d1: TestD1;

function seedInstalledRepository(): void {
  d1.raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_1", "42", "acme");
  d1.raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES (?, ?, ?, ?, ?)",
    )
    .run("proj_1", "org_1", REPOSITORY_ID, "acme/widgets", "main");
}

/**
 * A GitHub that remembers what was done to it, so a test can assert on the
 * repository's resulting configuration rather than on the calls made.
 */
class FakeGitHub implements BootstrapGitHub {
  rulesets = new Map<string, StoredRuleset>();
  pull: SetupPullRequestState | null = null;
  openedFiles: string[] = [];
  publishedChecks: Array<{ name: string; headSha: string; conclusion: string }> = [];
  appId = APP_INTEGRATION_ID;
  private nextId = 100;

  constructor(private readonly options: { mergesSetupPr?: boolean } = {}) {}

  async baseSha(): Promise<string> {
    return BASE_SHA;
  }

  async setupPullRequest(): Promise<SetupPullRequestState | null> {
    return this.pull;
  }

  async openSetupPullRequest(input: {
    files: ReadonlyArray<{ path: string; content: string }>;
    baseSha: string;
  }): Promise<SetupPullRequestState> {
    this.openedFiles = input.files.map((f) => f.path);
    this.pull = {
      number: 7,
      merged: this.options.mergesSetupPr === true,
      headSha: "c".repeat(40),
    };
    return this.pull;
  }

  async rulesetNamed(name: string): Promise<StoredRuleset | null> {
    return this.rulesets.get(name) ?? null;
  }

  async createRuleset(ruleset: Ruleset): Promise<StoredRuleset> {
    const stored = { id: (this.nextId += 1), ruleset };
    this.rulesets.set(ruleset.name, stored);
    return stored;
  }

  async replaceRuleset(id: number, ruleset: Ruleset): Promise<StoredRuleset> {
    const stored = { id, ruleset };
    this.rulesets.set(ruleset.name, stored);
    return stored;
  }

  async publishBootstrapCheck(run: {
    name: string;
    head_sha: string;
    conclusion: string;
  }): Promise<{ appId: number }> {
    this.publishedChecks.push({ name: run.name, headSha: run.head_sha, conclusion: run.conclusion });
    return { appId: this.appId };
  }

  requiredChecks(): Array<{ context: string; integration_id?: number }> {
    const policy = this.rulesets.get(POLICY_RULESET_NAME);
    if (policy === undefined) return [];
    const rule = policy.ruleset.rules.find((r) => r.type === "required_status_checks");
    return (rule?.parameters?.["required_status_checks"] ?? []) as Array<{
      context: string;
      integration_id?: number;
    }>;
  }
}

function deps(github: BootstrapGitHub) {
  return {
    db: d1.db,
    github,
    integrationId: APP_INTEGRATION_ID,
    endpoint: "https://thwip.example.test",
    actionRef: "recallnet/thwip@v1",
    review: { requiredApprovingReviewCount: 1, requireCodeOwnerReview: false },
  };
}

beforeEach(() => {
  d1 = testD1();
  seedInstalledRepository();
});

afterEach(() => {
  d1.close();
});

describe("enrollQueueProject", () => {
  it("writes the queue_projects row nobody should have to write by hand", async () => {
    const enrolled = await enrollQueueProject(d1.db, { repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    expect(enrolled.ok).toBe(true);

    const row = d1.raw
      .prepare("SELECT * FROM queue_projects WHERE github_repository_id = ?")
      .get(REPOSITORY_ID) as Record<string, unknown>;
    expect(row.organization_id).toBe("org_1");
    expect(row.base_ref).toBe(BASE_REF);
    expect(row.enabled).toBe(0);
    expect(row.activation_state).toBe("configured");
    expect(row.bootstrap_progress_json).toBe("{}");
  });

  it("refuses a repository the App is not installed on", async () => {
    const enrolled = await enrollQueueProject(d1.db, { repositoryId: "1", baseRef: BASE_REF });
    expect(enrolled).toMatchObject({ ok: false });
    if (!enrolled.ok) expect(enrolled.reason).toMatch(/not installed/);
  });

  it("is safe to call twice", async () => {
    await enrollQueueProject(d1.db, { repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    const again = await enrollQueueProject(d1.db, { repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    expect(again.ok).toBe(true);
    const rows = d1.raw
      .prepare("SELECT COUNT(*) AS n FROM queue_projects WHERE github_repository_id = ?")
      .get(REPOSITORY_ID) as { n: number };
    expect(rows.n).toBe(1);
  });

  /**
   * `remote` and `audited` refuse every merge with NO_PINNED_VERIFIER unless
   * `queue_projects.verifier_json` names one, and no code path ever wrote that
   * column. This repository's own row was typed into D1 by hand, which is why
   * nobody noticed that enrolment never produced one.
   */
  it("pins the verifier the candidate dispatch will run", async () => {
    await enrollQueueProject(d1.db, { repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    const row = d1.raw
      .prepare("SELECT verifier_json FROM queue_projects WHERE github_repository_id = ?")
      .get(REPOSITORY_ID) as { verifier_json: string | null };
    expect(row.verifier_json).not.toBeNull();
    expect(JSON.parse(row.verifier_json!)).toEqual({
      repositoryId: REPOSITORY_ID,
      repositoryOwnerId: "42",
      workflowRef: "acme/widgets/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
      workflowSha: null,
      reusableWorkflowRef: "acme/widgets/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
      reusableWorkflowSha: null,
      expectedEventName: "repository_dispatch",
      defaultBranchRef: BASE_REF,
    });
  });

  it("does not enable the queue merely by enrolling", async () => {
    await enrollQueueProject(d1.db, { repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    const project = await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF);
    expect(project?.enabled).toBe(false);
  });
});

describe("advanceBootstrap", () => {
  async function project() {
    await enrollQueueProject(d1.db, { repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    const loaded = await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF);
    if (loaded === null) throw new Error("enrolment did not persist");
    return loaded;
  }

  it("opens the setup pull request and waits for a human to merge it", async () => {
    const github = new FakeGitHub();
    const outcome = await advanceBootstrap(deps(github), await project());

    expect(outcome).toMatchObject({ kind: "waiting", step: "merge-setup-pr" });
    expect(github.openedFiles).toContain(".github/workflows/thwip-required.yml");
    expect(github.openedFiles).toContain(".github/workflows/thwip-merge.yml");
    expect(github.openedFiles).toContain("thwip.yaml");

    const after = await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF);
    expect(after?.progress["merge-setup-pr"]).toBeUndefined();
  });

  it("does not open a second setup pull request", async () => {
    const github = new FakeGitHub();
    await advanceBootstrap(deps(github), await project());
    github.openedFiles = [];
    await advanceBootstrap(deps(github), await project());
    expect(github.openedFiles).toEqual([]);
  });

  it("records the step once the setup pull request has merged", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await advanceBootstrap(deps(github), await project());
    const outcome = await advanceBootstrap(deps(github), await project());
    expect(outcome).toMatchObject({ kind: "advanced", step: "merge-setup-pr" });
    const after = await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF);
    expect(after?.progress["merge-setup-pr"]).toBe(true);
  });

  it("creates the policy disabled and unpinned, because GitHub will not pin a new context", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    const state = await project();
    await advanceBootstrap(deps(github), state);
    await advanceBootstrap(deps(github), await project());
    await advanceBootstrap(deps(github), await project());

    const policy = github.rulesets.get(POLICY_RULESET_NAME);
    expect(policy?.ruleset.enforcement).toBe("disabled");
    expect(github.requiredChecks()).toEqual([{ context: PROOF_CHECK }, { context: TURN_CHECK }]);
  });

  it("refuses to drop a control the repository already had", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await github.createRuleset({
      name: POLICY_RULESET_NAME,
      target: "branch",
      enforcement: "disabled",
      bypass_actors: [],
      conditions: { ref_name: { include: [BASE_REF], exclude: [] } },
      rules: [{ type: "required_signatures" }],
    });
    await advanceBootstrap(deps(github), await project());
    await advanceBootstrap(deps(github), await project());
    const outcome = await advanceBootstrap(deps(github), await project());
    expect(outcome).toMatchObject({ kind: "refused", step: "create-disabled-policy-without-source" });
    if (outcome.kind === "refused") expect(outcome.detail).toMatch(/required_signatures/);
  });
});

describe("runBootstrap", () => {
  async function enrolled() {
    await enrollQueueProject(d1.db, { repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    const loaded = await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF);
    if (loaded === null) throw new Error("enrolment did not persist");
    return loaded;
  }

  it("stops at the setup pull request until it merges", async () => {
    const github = new FakeGitHub();
    const run = await runBootstrap(deps(github), await enrolled());
    expect(run.outcomes.at(-1)).toMatchObject({ kind: "waiting", step: "merge-setup-pr" });
    expect(run.enabled).toBe(false);
    expect(github.rulesets.size).toBe(0);
  });

  it("enrols a repository end to end once the setup pull request has merged", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await runBootstrap(deps(github), await enrolled());
    const run = await runBootstrap(deps(github), await enrolled());

    expect(run.outcomes.at(-1)).toEqual({ kind: "complete" });
    expect(run.enabled).toBe(true);

    const project = await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF);
    expect(project?.enabled).toBe(true);
    expect(project?.activationState).toBe("observe");
    expect(project?.progress).toMatchObject({
      "merge-setup-pr": true,
      "create-disabled-policy-without-source": true,
      "publish-bootstrap-check": true,
      "attach-integration-id-while-disabled": true,
      "canary-negative-test": true,
      "activate-policy-and-ownership": true,
      "record-genesis": true,
    });
  });

  it("leaves the repository requiring exactly the checks something publishes", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await runBootstrap(deps(github), await enrolled());
    await runBootstrap(deps(github), await enrolled());

    expect(github.requiredChecks()).toEqual([
      { context: PROOF_CHECK, integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
      { context: TURN_CHECK, integration_id: APP_INTEGRATION_ID },
    ]);
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("active");
  });

  it("gives the App the branch, on a managed backend", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await runBootstrap(deps(github), await enrolled());
    await runBootstrap(deps(github), await enrolled());

    const ownership = github.rulesets.get(OWNERSHIP_RULESET_NAME);
    expect(ownership?.ruleset.bypass_actors).toEqual([
      { actor_id: APP_INTEGRATION_ID, actor_type: "Integration", bypass_mode: "pull_request" },
    ]);
  });

  it("publishes the bootstrap check as the App context, against the disabled policy", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await runBootstrap(deps(github), await enrolled());
    await runBootstrap(deps(github), await enrolled());

    expect(github.publishedChecks).toEqual([
      { name: TURN_CHECK, headSha: BASE_SHA, conclusion: "neutral" },
    ]);
  });

  it("refuses to pin an integration the check did not come from", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    github.appId = 111;
    await runBootstrap(deps(github), await enrolled());
    const run = await runBootstrap(deps(github), await enrolled());

    expect(run.outcomes.at(-1)).toMatchObject({ kind: "refused", step: "publish-bootstrap-check" });
    expect(run.enabled).toBe(false);
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");
  });

  it("refuses to activate when GitHub did not store the source pin it was sent", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    const replace = github.replaceRuleset.bind(github);
    github.replaceRuleset = async (id, ruleset) => {
      // GitHub accepting the payload and dropping the pin is the failure that
      // leaves a branch requiring a check no source can satisfy.
      const stripped: Ruleset = {
        ...ruleset,
        rules: ruleset.rules.map((rule) =>
          rule.type === "required_status_checks"
            ? {
                type: rule.type,
                parameters: {
                  ...rule.parameters,
                  required_status_checks: (
                    rule.parameters?.["required_status_checks"] as Array<{ context: string }>
                  ).map((c) => ({ context: c.context })),
                },
              }
            : rule,
        ),
      };
      return replace(id, stripped);
    };

    await runBootstrap(deps(github), await enrolled());
    const run = await runBootstrap(deps(github), await enrolled());

    expect(run.outcomes.at(-1)).toMatchObject({ kind: "refused", step: "canary-negative-test" });
    expect(run.enabled).toBe(false);
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");
  });

  it("is safe to run again after it has finished", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await runBootstrap(deps(github), await enrolled());
    await runBootstrap(deps(github), await enrolled());
    const again = await runBootstrap(deps(github), await enrolled());
    expect(again.outcomes).toEqual([{ kind: "complete" }]);
    expect(again.enabled).toBe(true);
  });
});

describe("bootstrapStatus", () => {
  it("names the step a repository is waiting on", async () => {
    await enrollQueueProject(d1.db, { repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    const project = await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF);
    const status = bootstrapStatus(project!);
    expect(status.nextStep).toBe("merge-setup-pr");
    expect(status.complete).toBe(false);
    expect(status.mayActivate).toMatchObject({ ok: false });
  });
});

describe("handleBootstrapRequest", () => {
  it("enrols and bootstraps in one call", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    const first = await handleBootstrapRequest({
      ...deps(github),
      repositoryId: REPOSITORY_ID,
      baseRef: BASE_REF,
    });
    expect(first.status).toBe(202);

    const second = await handleBootstrapRequest({
      ...deps(github),
      repositoryId: REPOSITORY_ID,
      baseRef: BASE_REF,
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ enabled: true, complete: true });
  });

  it("answers 404 for a repository the App is not installed on", async () => {
    const github = new FakeGitHub();
    const response = await handleBootstrapRequest({
      ...deps(github),
      repositoryId: "1",
      baseRef: BASE_REF,
    });
    expect(response.status).toBe(404);
  });

  it("reports a refusal as a conflict rather than a success", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    github.appId = 111;
    await handleBootstrapRequest({ ...deps(github), repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    const response = await handleBootstrapRequest({
      ...deps(github),
      repositoryId: REPOSITORY_ID,
      baseRef: BASE_REF,
    });
    expect(response.status).toBe(409);
  });
});
