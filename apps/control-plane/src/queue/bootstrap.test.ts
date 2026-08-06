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
  type BootstrapRun,
  type ManualRulesetChange,
  type SetupPullRequestState,
  type StoredRuleset,
} from "./bootstrap.js";
import {
  GITHUB_ACTIONS_INTEGRATION_ID,
  OWNERSHIP_RULESET_NAME,
  POLICY_RULESET_NAME,
  type Ruleset,
} from "./rulesets.js";
import { PROOF_CHECK, TURN_CHECK, WORKFLOW_CHECK } from "./turn-check.js";

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

/** The App publishes `thwip` only once an administrator has enforced it. */
function enforceAppProofCheck(): void {
  d1.raw.prepare("UPDATE projects SET proof_check_mode = 'enforced' WHERE id = 'proj_1'").run();
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
  hideBypassActors = false;
  omitFalseUpdateParameters = false;
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
    const stored = this.rulesets.get(name) ?? null;
    if (stored === null) return null;
    const readBack = {
      ...stored.ruleset,
      rules: stored.ruleset.rules.map((rule) =>
        this.omitFalseUpdateParameters &&
        rule.type === "update" &&
        rule.parameters?.["update_allows_fetch_and_merge"] === false
          ? { type: rule.type }
          : rule,
      ),
    };
    if (!this.hideBypassActors) return { id: stored.id, ruleset: readBack };
    const { bypass_actors: _hidden, ...ruleset } = readBack;
    return { id: stored.id, ruleset: ruleset as Ruleset };
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

function deps(
  github: BootstrapGitHub,
  confirmRulesetBypassActors = false,
  confirmQueueEnforcement = true,
) {
  return {
    db: d1.db,
    github,
    integrationId: APP_INTEGRATION_ID,
    endpoint: "https://thwip.example.test",
    actionRef: "recallnet/thwip@v1",
    ...(confirmQueueEnforcement ? { confirmQueueEnforcement: true } : {}),
    ...(confirmRulesetBypassActors ? { confirmRulesetBypassActors: true } : {}),
  };
}

async function applyManualRulesets(
  github: FakeGitHub,
  changes: readonly ManualRulesetChange[],
): Promise<void> {
  for (const change of changes) {
    if (change.operation === "create") await github.createRuleset(change.ruleset);
    else await github.replaceRuleset(change.rulesetId, change.ruleset);
  }
}

/** Simulate the repository administrator applying each payload setup returns. */
async function runAsRepositoryAdministrator(
  github: FakeGitHub,
  confirmRulesetBypassActors = true,
  confirmQueueEnforcement = true,
): Promise<BootstrapRun> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const project = await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF);
    if (project === null) throw new Error("enrolment did not persist");
    const run = await runBootstrap(
      deps(github, confirmRulesetBypassActors, confirmQueueEnforcement),
      project,
    );
    const last = run.outcomes.at(-1);
    if (last?.kind === "waiting" && last.manualRulesets !== undefined) {
      await applyManualRulesets(github, last.manualRulesets);
      continue;
    }
    if (last?.kind === "waiting" && last.step === "merge-setup-pr" && github.pull?.merged === true) {
      continue;
    }
    return run;
  }
  throw new Error("manual bootstrap did not converge");
}

async function handleAsRepositoryAdministrator(github: FakeGitHub) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await handleBootstrapRequest({
      ...deps(github, true),
      repositoryId: REPOSITORY_ID,
      baseRef: BASE_REF,
    });
    const body = response.body as { outcomes?: BootstrapRun["outcomes"] };
    const last = body.outcomes?.at(-1);
    if (last?.kind === "waiting" && last.manualRulesets !== undefined) {
      await applyManualRulesets(github, last.manualRulesets);
      continue;
    }
    if (last?.kind === "waiting" && last.step === "merge-setup-pr" && github.pull?.merged === true) {
      continue;
    }
    return response;
  }
  throw new Error("manual bootstrap request did not converge");
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
    expect(row.chain_public).toBe(0);
    expect(row.bootstrap_progress_json).toBe("{}");
    const columns = d1.raw.prepare("PRAGMA table_info(queue_projects)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("backend");
    expect(columns.map((column) => column.name)).not.toContain("merge_method");
    expect(columns.map((column) => column.name)).not.toContain("merge_writer");
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

  it("persists an explicit chain-publication choice and changes it only when asked", async () => {
    const enrolled = await enrollQueueProject(d1.db, {
      repositoryId: REPOSITORY_ID,
      baseRef: BASE_REF,
      chainPublic: true,
    });
    expect(enrolled).toMatchObject({ ok: true, project: { chainPublic: true } });

    await enrollQueueProject(d1.db, { repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    expect((await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))?.chainPublic).toBe(true);

    await enrollQueueProject(d1.db, {
      repositoryId: REPOSITORY_ID,
      baseRef: BASE_REF,
      chainPublic: false,
    });
    expect((await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))?.chainPublic).toBe(false);
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
    expect(github.openedFiles).not.toContain(".github/workflows/thwip-merge.yml");
    expect(github.openedFiles).not.toContain("thwip.yaml");

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

  it("asks an administrator for a disabled unpinned policy, then verifies it", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    const state = await project();
    await advanceBootstrap(deps(github), state);
    await advanceBootstrap(deps(github), await project());
    const requested = await advanceBootstrap(deps(github), await project());
    expect(requested).toMatchObject({
      kind: "waiting",
      step: "create-disabled-policy-without-source",
      manualRulesets: [{ operation: "create" }],
    });
    if (requested.kind === "waiting") {
      await applyManualRulesets(github, requested.manualRulesets ?? []);
    }
    const verified = await advanceBootstrap(deps(github), await project());
    expect(verified).toMatchObject({ kind: "advanced", step: "create-disabled-policy-without-source" });
    await advanceBootstrap(deps(github), await project());

    const policy = github.rulesets.get(POLICY_RULESET_NAME);
    expect(policy?.ruleset.enforcement).toBe("disabled");
    expect(github.requiredChecks()).toEqual([{ context: WORKFLOW_CHECK }, { context: TURN_CHECK }]);
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
    // The App has to be the one publishing `thwip` before setup can pin the
    // context to it, so a repository that has enforced finishes in one go.
    enforceAppProofCheck();
    await enrolled();
    const run = await runAsRepositoryAdministrator(github);

    expect(run.outcomes.at(-1)).toEqual({ kind: "complete" });
    expect(run.enabled).toBe(true);

    const project = await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF);
    expect(project?.enabled).toBe(true);
    expect(project?.activationState).toBe("enforced");
    expect(project?.progress).toMatchObject({
      "merge-setup-pr": true,
      "create-disabled-policy-without-source": true,
      "publish-bootstrap-check": true,
      "attach-integration-id-while-disabled": true,
      "canary-negative-test": true,
      "activate-policy-and-ownership": true,
      "record-genesis": true,
      "pin-proof-check-to-app": true,
    });
  });

  it("leaves the repository requiring exactly the checks something publishes", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();
    await runAsRepositoryAdministrator(github);

    // Still Actions: this repository has not enforced the App's proof check, so
    // the App does not publish `thwip` and a pin on it would block the branch.
    expect(github.requiredChecks()).toEqual([
      { context: WORKFLOW_CHECK, integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
      { context: TURN_CHECK, integration_id: APP_INTEGRATION_ID },
    ]);
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");
    expect(github.rulesets.has(OWNERSHIP_RULESET_NAME)).toBe(false);
  });

  it("gives the installed App ownership of the branch", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    enforceAppProofCheck();
    await enrolled();
    await runAsRepositoryAdministrator(github);

    const ownership = github.rulesets.get(OWNERSHIP_RULESET_NAME);
    expect(ownership?.ruleset.bypass_actors).toEqual([
      { actor_id: APP_INTEGRATION_ID, actor_type: "Integration", bypass_mode: "always" },
    ]);
  });

  it("requires a human confirmation when read-only ruleset access hides bypass actors", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    github.hideBypassActors = true;
    enforceAppProofCheck();
    await enrolled();

    const waiting = await runAsRepositoryAdministrator(github, false);
    expect(waiting.outcomes.at(-1)).toMatchObject({
      kind: "waiting",
      step: "pin-proof-check-to-app",
      confirmationRequired: "ruleset-bypass-actors",
    });
    expect(waiting.enabled).toBe(true);
    expect(waiting.outcomes.at(-1)).toMatchObject({
      expectedBypassActors: [
        { ruleset: POLICY_RULESET_NAME, bypassActors: [] },
      ],
    });

    const continued = await runBootstrap(
      deps(github, true),
      (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!,
    );
    expect(continued.enabled).toBe(true);
    expect(continued.status.activationState).toBe("canary");
    const changes = continued.outcomes.at(-1);
    expect(changes).toMatchObject({
      kind: "waiting",
      step: "activate-policy-and-ownership",
      manualRulesets: [{ operation: "create" }, { operation: "update" }],
    });
    if (changes?.kind !== "waiting") throw new Error("expected the enforcement rulesets");
    await applyManualRulesets(github, changes.manualRulesets ?? []);

    const completed = await runBootstrap(
      deps(github, true),
      (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!,
    );
    expect(completed.status.activationState).toBe("enforced");
    expect(completed.outcomes.at(-1)).toEqual({ kind: "complete" });
  });

  it("accepts GitHub read-back that omits the false update-rule parameter", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    github.omitFalseUpdateParameters = true;
    enforceAppProofCheck();
    await enrolled();

    const run = await runAsRepositoryAdministrator(github);

    expect(run.status.activationState).toBe("enforced");
    expect(run.outcomes.at(-1)).toEqual({ kind: "complete" });
  });

  it("observes before an explicit, recoverable enforcement handoff", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();

    const proofObservation = await runAsRepositoryAdministrator(github, true, false);
    expect(proofObservation.outcomes.at(-1)).toMatchObject({
      kind: "waiting",
      step: "pin-proof-check-to-app",
    });
    expect(proofObservation.status.activationState).toBe("observe");
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");
    expect(github.rulesets.has(OWNERSHIP_RULESET_NAME)).toBe(false);

    enforceAppProofCheck();
    const observing = await runAsRepositoryAdministrator(github, true, false);
    expect(observing.outcomes.at(-1)).toMatchObject({
      kind: "waiting",
      step: "activate-policy-and-ownership",
      confirmationRequired: "queue-enforcement",
    });
    expect(observing.status.activationState).toBe("observe");
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");
    expect(github.rulesets.has(OWNERSHIP_RULESET_NAME)).toBe(false);

    const started = await runBootstrap(
      deps(github, true, true),
      (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!,
    );
    const changes = started.outcomes.at(-1);
    expect(changes).toMatchObject({
      kind: "waiting",
      step: "activate-policy-and-ownership",
      manualRulesets: [{ ruleset: { name: OWNERSHIP_RULESET_NAME } }, { ruleset: { name: POLICY_RULESET_NAME } }],
    });
    expect(started.status.activationState).toBe("canary");
    if (changes?.kind !== "waiting") throw new Error("expected the enforcement rulesets");
    await applyManualRulesets(github, changes.manualRulesets ?? []);

    const enforced = await runBootstrap(
      deps(github, true, false),
      (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!,
    );
    expect(enforced.status.activationState).toBe("enforced");
    expect(enforced.outcomes.at(-1)).toEqual({ kind: "complete" });
  });

  it("refuses to pin an integration the check did not come from", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    github.appId = 111;
    await enrolled();
    const run = await runAsRepositoryAdministrator(github);

    expect(run.outcomes.at(-1)).toMatchObject({ kind: "refused", step: "publish-bootstrap-check" });
    expect(run.enabled).toBe(false);
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");
  });

  it("keeps waiting when the administrator's source-pin update was not stored", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();
    await runBootstrap(deps(github), (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!);
    const create = await runBootstrap(
      deps(github),
      (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!,
    );
    const createChanges = create.outcomes.at(-1);
    if (createChanges?.kind !== "waiting") throw new Error("expected the initial manual ruleset");
    await applyManualRulesets(github, createChanges.manualRulesets ?? []);

    const attach = await runBootstrap(
      deps(github),
      (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!,
    );
    const attachChanges = attach.outcomes.at(-1);
    if (attachChanges?.kind !== "waiting") throw new Error("expected the source-pin update");

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

    await applyManualRulesets(github, attachChanges.manualRulesets ?? []);
    const run = await runBootstrap(
      deps(github),
      (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!,
    );

    expect(run.outcomes.at(-1)).toMatchObject({
      kind: "waiting",
      step: "attach-integration-id-while-disabled",
      manualRulesets: [{ operation: "update" }],
    });
    expect(run.enabled).toBe(false);
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");
  });

  it("is safe to run again after it has finished", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    enforceAppProofCheck();
    await enrolled();
    await runAsRepositoryAdministrator(github);
    const again = await runAsRepositoryAdministrator(github);
    expect(again.outcomes).toEqual([{ kind: "complete" }]);
    expect(again.enabled).toBe(true);
  });
});

/**
 * Replacing the required workflow proof context with the App proof context.
 *
 * The two publishers have distinct names so an in-progress workflow check
 * cannot be mistaken for, or interfere with, the App gate. Setup must still
 * move the requirement from one publisher to the other without a gap.
 *
 * The order is the whole problem. The App publishes `thwip` only where
 * `proof_check_mode` is `enforced`; in `observe` it publishes
 * `thwip / proof (observe)` and never the enforced name. The publisher moves,
 * the disabled policy replaces `thwip / workflow` with `thwip`, and only then
 * do ownership and policy enforcement activate. No active queue ever waits on
 * the workflow job that is currently calling it.
 */
describe("the required proof check moving to the App", () => {
  async function enrolled() {
    await enrollQueueProject(d1.db, { repositoryId: REPOSITORY_ID, baseRef: BASE_REF });
    const loaded = await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF);
    if (loaded === null) throw new Error("enrolment did not persist");
    return loaded;
  }

  it("leaves the pin with Actions while the App is still only observing", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();
    const run = await runAsRepositoryAdministrator(github);

    expect(github.requiredChecks()).toContainEqual({
      context: WORKFLOW_CHECK,
      integration_id: GITHUB_ACTIONS_INTEGRATION_ID,
    });
    // Enabled only for observation. Existing controls still own merging.
    expect(run.enabled).toBe(true);
    expect(run.outcomes.at(-1)).toMatchObject({ kind: "waiting", step: "pin-proof-check-to-app" });
    expect(run.status.activationState).toBe("observe");
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");
    expect(github.rulesets.has(OWNERSHIP_RULESET_NAME)).toBe(false);
  });

  it("says what an administrator has to do before the pin can move", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();
    const run = await runAsRepositoryAdministrator(github);
    const waiting = run.outcomes.at(-1);
    expect(waiting?.kind).toBe("waiting");
    if (waiting?.kind === "waiting") expect(waiting.detail).toMatch(/enforce/i);
  });

  it("moves the pin to the App once the App is the one publishing the check", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();
    await runAsRepositoryAdministrator(github);

    enforceAppProofCheck();
    const run = await runAsRepositoryAdministrator(github);

    expect(run.outcomes.at(-1)).toEqual({ kind: "complete" });
    expect(github.requiredChecks()).toEqual([
      { context: PROOF_CHECK, integration_id: APP_INTEGRATION_ID },
      { context: TURN_CHECK, integration_id: APP_INTEGRATION_ID },
    ]);
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("active");
  });

  it("returns a corrective payload when visible bypass actors drift", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();
    await runAsRepositoryAdministrator(github);
    enforceAppProofCheck();

    const policy = github.rulesets.get(POLICY_RULESET_NAME)!;
    github.rulesets.set(POLICY_RULESET_NAME, {
      ...policy,
      ruleset: {
        ...policy.ruleset,
        bypass_actors: [{ actor_id: 99, actor_type: "RepositoryRole", bypass_mode: "always" }],
      },
    });

    const run = await runBootstrap(
      deps(github, true),
      (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!,
    );
    expect(run.outcomes.at(-1)).toMatchObject({
      kind: "waiting",
      step: "pin-proof-check-to-app",
      manualRulesets: [{ operation: "update", ruleset: { bypass_actors: [] } }],
    });
  });

  /**
   * The same failure `canary-negative-test` exists for, at the pin that now
   * carries the weight. A ruleset that accepted the payload and dropped the
   * source leaves `thwip` satisfiable by any workflow in the repository, which
   * is the thing this change removes.
   */
  it("keeps waiting when GitHub drops the proof-check pin", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();
    await runAsRepositoryAdministrator(github);

    enforceAppProofCheck();
    const requested = await runBootstrap(
      deps(github, true),
      (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!,
    );
    const change = requested.outcomes.at(-1);
    if (change?.kind !== "waiting") throw new Error("expected the proof-pin update");
    const replace = github.replaceRuleset.bind(github);
    github.replaceRuleset = async (id, ruleset) =>
      replace(id, {
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
      });

    await applyManualRulesets(github, change.manualRulesets ?? []);
    const run = await runBootstrap(
      deps(github, true),
      (await readQueueProject(d1.db, REPOSITORY_ID, BASE_REF))!,
    );
    expect(run.outcomes.at(-1)).toMatchObject({
      kind: "waiting",
      step: "pin-proof-check-to-app",
      manualRulesets: [{ operation: "update" }],
    });
  });

  it("does not activate ownership before the proof contexts have been replaced", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();
    const run = await runAsRepositoryAdministrator(github);

    expect(run.outcomes.at(-1)).toMatchObject({ kind: "waiting", step: "pin-proof-check-to-app" });
    expect(github.rulesets.has(OWNERSHIP_RULESET_NAME)).toBe(false);
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");
  });

  /**
   * GitHub offers an App as the expected source of a context only where the App
   * has recently published a check by that name. The turn check gets that
   * treatment already; the proof check needs it for the same reason.
   */
  it("publishes the proof context from the App so GitHub will offer it as a source", async () => {
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();
    await runAsRepositoryAdministrator(github);

    expect(github.publishedChecks).toEqual([
      { name: TURN_CHECK, headSha: BASE_SHA, conclusion: "neutral" },
      { name: PROOF_CHECK, headSha: BASE_SHA, conclusion: "neutral" },
    ]);
  });

  it("pins the App from the start where the App was already enforcing", async () => {
    enforceAppProofCheck();
    const github = new FakeGitHub({ mergesSetupPr: true });
    await enrolled();
    const run = await runAsRepositoryAdministrator(github);

    expect(run.outcomes.at(-1)).toEqual({ kind: "complete" });
    expect(github.requiredChecks()).toEqual([
      { context: PROOF_CHECK, integration_id: APP_INTEGRATION_ID },
      { context: TURN_CHECK, integration_id: APP_INTEGRATION_ID },
    ]);
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
    enforceAppProofCheck();
    const first = await handleBootstrapRequest({
      ...deps(github),
      repositoryId: REPOSITORY_ID,
      baseRef: BASE_REF,
    });
    expect(first.status).toBe(202);

    const second = await handleAsRepositoryAdministrator(github);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ enabled: true, complete: true });
  });

  it("returns the stored chain-publication choice on every bootstrap response", async () => {
    const github = new FakeGitHub();
    const response = await handleBootstrapRequest({
      ...deps(github),
      repositoryId: REPOSITORY_ID,
      baseRef: BASE_REF,
      chainPublic: true,
    });
    expect(response.body).toMatchObject({ chainPublic: true });
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
    const response = await handleAsRepositoryAdministrator(github);
    expect(response.status).toBe(409);
  });
});
