import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testD1, type TestD1 } from "../../test/d1.js";
import { GithubApiError } from "../github-error.js";
import { bootstrapRouteResponse, bootstrapStatusResponse, type BootstrapRouteEnv } from "./bootstrap-route.js";
import type {
  BootstrapGitHub,
  ManualRulesetChange,
  SetupPullRequestState,
  StoredRuleset,
} from "./bootstrap.js";
import { POLICY_RULESET_NAME, type Ruleset } from "./rulesets.js";
import { QUEUE_ACTION_REF, verifierWorkflowFile } from "./bootstrap-workflows.js";

/**
 * The route, because the route is what was missing.
 *
 * This checks who may ask, what a repository without the App receives, and that
 * an administrator's request leaves the durable setup row behind.
 */

const REPOSITORY_ID = "987654321";
const APP_INTEGRATION_ID = 4419870;
const viewer = (githubOrgRole: string) => ({ organizationId: "org_1", githubOrgRole });

let d1: TestD1;

function env(): BootstrapRouteEnv {
  return {
    DB: d1.db as unknown as D1Database,
    PUBLIC_ORIGIN: "https://thwip.example.test",
    GITHUB_APP_ID: String(APP_INTEGRATION_ID),
    // The port is injected, so nothing here ever mints a token.
    GITHUB_APP_PRIVATE_KEY: "",
  };
}

/**
 * The App publishes `thwip` only where the proof check is enforced. Setup will
 * not replace the Actions-owned workflow context or activate ownership until it
 * does. A repository that has not enforced is enrolled and observing under its
 * existing controls, with that handoff still waiting, which is a 202.
 */
function enforceAppProofCheck(): void {
  d1.raw.prepare("UPDATE projects SET proof_check_mode = 'enforced' WHERE id = 'proj_1'").run();
}

function seedInstalledRepository(options: { installationId?: string | null } = {}): void {
  d1.raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, ?, ?, ?)")
    .run("org_1", "42", "acme", options.installationId === undefined ? "5001" : options.installationId);
  d1.raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES (?, ?, ?, ?, ?)",
    )
    .run("proj_1", "org_1", REPOSITORY_ID, "acme/widgets", "main");
}

/** A repository that accepts everything, so the test is about the route. */
class FakeGitHub implements BootstrapGitHub {
  rulesets = new Map<string, StoredRuleset>();
  pull: SetupPullRequestState | null = null;
  upgradePull: SetupPullRequestState | null = null;
  openedFiles: string[] = [];
  private nextId = 100;
  verifierContent = verifierWorkflowFile({
    endpoint: "https://thwip.example.test",
    actionRef: QUEUE_ACTION_REF,
  }).content;

  async baseSha(): Promise<string> {
    return "b".repeat(40);
  }

  async setupPullRequest(): Promise<SetupPullRequestState | null> {
    return this.pull;
  }

  async openSetupPullRequest(input: { files: ReadonlyArray<{ path: string; content?: string }> }): Promise<SetupPullRequestState> {
    this.openedFiles = input.files.map((file) => file.path);
    this.verifierContent = input.files.find((file) => file.path === ".github/workflows/thwip-queue-verify.yml")?.content
      ?? this.verifierContent;
    this.pull = { number: 7, merged: true, headSha: "c".repeat(40) };
    return this.pull;
  }

  async verifierUpgradePullRequest(): Promise<SetupPullRequestState | null> {
    return this.upgradePull;
  }

  async verifierWorkflowAtBase() {
    return { commitSha: "b".repeat(40), blobSha: "f".repeat(40), content: this.verifierContent };
  }

  async installationPermissions() {
    return { actions: "read" };
  }

  async openVerifierUpgradePullRequest(input: { files: ReadonlyArray<{ path: string }> }): Promise<SetupPullRequestState> {
    this.openedFiles = input.files.map((file) => file.path);
    this.upgradePull = { number: 8, merged: false, headSha: "d".repeat(40) };
    return this.upgradePull;
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

  async publishBootstrapCheck(): Promise<{ appId: number }> {
    return { appId: APP_INTEGRATION_ID };
  }
}

let github: FakeGitHub;
const port = async (): Promise<BootstrapGitHub> => github;

beforeEach(() => {
  d1 = testD1();
  github = new FakeGitHub();
});

afterEach(() => {
  d1.close();
});

function queueProjectRow(): Record<string, unknown> | undefined {
  return d1.raw
    .prepare("SELECT * FROM queue_projects WHERE github_repository_id = ?")
    .get(REPOSITORY_ID) as Record<string, unknown> | undefined;
}

async function applyManualRulesets(changes: readonly ManualRulesetChange[]): Promise<void> {
  for (const change of changes) {
    if (change.operation === "create") await github.createRuleset(change.ruleset);
    else await github.replaceRuleset(change.rulesetId, change.ruleset);
  }
}

async function postThroughManualSetup(
  githubOrgRole: "admin" | "owner" = "admin",
  confirmQueueEnforcement = true,
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await bootstrapRouteResponse(
      env(),
      viewer(githubOrgRole),
      REPOSITORY_ID,
      {
        ...(confirmQueueEnforcement ? { confirmQueueEnforcement: true } : {}),
        confirmRulesetBypassActors: true,
      },
      port,
    );
    const body = response.body as {
      outcomes?: Array<{ kind: string; manualRulesets?: readonly ManualRulesetChange[] }>;
    };
    const changes = body.outcomes?.at(-1)?.manualRulesets;
    if (changes !== undefined) {
      await applyManualRulesets(changes);
      continue;
    }
    return response;
  }
  throw new Error("manual route setup did not converge");
}

describe("POST /v1/queue/:repositoryId/bootstrap", () => {
  it("refuses a caller with no session", async () => {
    seedInstalledRepository();
    const response = await bootstrapRouteResponse(env(), null, REPOSITORY_ID, {}, port);
    expect(response.status).toBe(401);
    expect(queueProjectRow()).toBeUndefined();
  });

  it("refuses a member who does not administer the organization", async () => {
    seedInstalledRepository();
    const response = await bootstrapRouteResponse(
      env(),
      viewer("member"),
      REPOSITORY_ID,
      {},
      port,
    );
    expect(response.status).toBe(403);
    // Setup opens a pull request and publishes checks in somebody's repository,
    // so a refusal has to happen before any of it, not after enrolment.
    expect(queueProjectRow()).toBeUndefined();
    expect(github.rulesets.size).toBe(0);
  });

  it("does not let an owner read or set up another organization's repository", async () => {
    d1.raw
      .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, ?, ?, ?)")
      .run("org_a", "41", "alpha", "5000");
    d1.raw
      .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, ?, ?, ?)")
      .run("org_b", "42", "beta", "5001");
    d1.raw
      .prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch) VALUES (?, ?, ?, ?, ?)",
      )
      .run("proj_b", "org_b", REPOSITORY_ID, "beta/widgets", "main");

    let portCalls = 0;
    const countedPort = async (): Promise<BootstrapGitHub> => {
      portCalls += 1;
      return github;
    };
    await bootstrapRouteResponse(
      env(),
      { organizationId: "org_b", githubOrgRole: "owner" },
      REPOSITORY_ID,
      {},
      countedPort,
    );
    const before = d1.raw
      .prepare("SELECT * FROM queue_projects WHERE github_repository_id = ?")
      .get(REPOSITORY_ID);
    expect(before).toBeDefined();
    portCalls = 0;

    const otherOwner = { organizationId: "org_a", githubOrgRole: "owner" };
    const post = await bootstrapRouteResponse(env(), otherOwner, REPOSITORY_ID, {}, countedPort);
    const get = await bootstrapStatusResponse(env(), otherOwner, REPOSITORY_ID);

    expect(post.status).toBe(404);
    expect(get.status).toBe(404);
    expect(portCalls).toBe(0);
    expect(
      d1.raw.prepare("SELECT * FROM queue_projects WHERE github_repository_id = ?").get(REPOSITORY_ID),
    ).toEqual(before);
  });

  it("answers 404 for a repository the App is not installed on", async () => {
    const response = await bootstrapRouteResponse(
      env(),
      viewer("admin"),
      "1234",
      {},
      port,
    );
    expect(response.status).toBe(404);
  });

  it("answers 404 when the organization has no installation to act through", async () => {
    seedInstalledRepository({ installationId: null });
    const response = await postThroughManualSetup();
    expect(response.status).toBe(404);
    expect(queueProjectRow()).toBeUndefined();
  });

  it("enrols the repository the operator used to write by hand", async () => {
    seedInstalledRepository();
    enforceAppProofCheck();
    // Already reviewed and merged, which is the second call an administrator
    // makes. The first opens the pull request and stops.
    github.pull = { number: 7, merged: true, headSha: "c".repeat(40) };
    const response = await postThroughManualSetup();

    expect(response.status).toBe(200);
    const row = queueProjectRow();
    expect(row?.organization_id).toBe("org_1");
    expect(row?.base_ref).toBe("refs/heads/main");
    expect(row?.enabled).toBe(1);
    expect(row?.activation_state).toBe("enforced");
    expect(Object.hasOwn(row ?? {}, "backend")).toBe(false);
    expect(Object.hasOwn(row ?? {}, "merge_method")).toBe(false);
    expect(Object.hasOwn(row ?? {}, "merge_writer")).toBe(false);
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("active");
  });

  it("stores, reads back, and updates an administrator's chain-publication choice", async () => {
    seedInstalledRepository();
    const first = await bootstrapRouteResponse(
      env(),
      viewer("admin"),
      REPOSITORY_ID,
      { chainPublic: true },
      port,
    );
    expect(first.body).toMatchObject({ chainPublic: true });
    expect(queueProjectRow()?.chain_public).toBe(1);

    const read = await bootstrapStatusResponse(env(), viewer("admin"), REPOSITORY_ID);
    expect(read.body).toMatchObject({ chainPublic: true });

    const changed = await bootstrapRouteResponse(
      env(),
      viewer("admin"),
      REPOSITORY_ID,
      { chainPublic: false },
      port,
    );
    expect(changed.body).toMatchObject({ chainPublic: false });
    expect(queueProjectRow()?.chain_public).toBe(0);
  });

  it("lets an owner run setup, not only an admin", async () => {
    seedInstalledRepository();
    enforceAppProofCheck();
    github.pull = { number: 7, merged: true, headSha: "c".repeat(40) };
    const response = await postThroughManualSetup("owner");
    expect(response.status).toBe(200);
  });

  it("enables the queue while the proof check is still an administrator's to enforce", async () => {
    seedInstalledRepository();
    github.pull = { number: 7, merged: true, headSha: "c".repeat(40) };
    const response = await postThroughManualSetup();

    expect(response.status).toBe(202);
    expect(queueProjectRow()?.enabled).toBe(1);
  });

  it("keeps ownership disabled until the administrator explicitly enforces after observing", async () => {
    seedInstalledRepository();
    github.pull = { number: 7, merged: true, headSha: "c".repeat(40) };

    const observing = await postThroughManualSetup("admin", false);
    expect(observing).toMatchObject({ status: 202, body: { activationState: "observe" } });
    const outcomes = (observing.body as { outcomes: Array<Record<string, unknown>> }).outcomes;
    expect(outcomes.at(-1)).toMatchObject({
      kind: "waiting",
      step: "pin-proof-check-to-app",
    });
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");

    enforceAppProofCheck();
    const readyToEnforce = await postThroughManualSetup("admin", false);
    expect(readyToEnforce).toMatchObject({ status: 202, body: { activationState: "observe" } });
    const readyOutcomes = (readyToEnforce.body as { outcomes: Array<Record<string, unknown>> }).outcomes;
    expect(readyOutcomes.at(-1)).toMatchObject({
      kind: "waiting",
      step: "activate-policy-and-ownership",
      confirmationRequired: "queue-enforcement",
    });
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("disabled");

    const started = await bootstrapRouteResponse(
      env(),
      viewer("admin"),
      REPOSITORY_ID,
      { confirmQueueEnforcement: true },
      port,
    );
    expect(started).toMatchObject({ status: 202, body: { activationState: "canary" } });
  });

  it("omits repository policy by default and adds it only on explicit request", async () => {
    seedInstalledRepository();
    await bootstrapRouteResponse(env(), viewer("admin"), REPOSITORY_ID, {}, port);
    expect(github.openedFiles).not.toContain("thwip.yaml");
  });

  it("adds a repository policy when the administrator explicitly chooses an override", async () => {
    seedInstalledRepository();
    await bootstrapRouteResponse(
      env(),
      viewer("admin"),
      REPOSITORY_ID,
      { includeRepositoryConfig: true },
      port,
    );
    expect(github.openedFiles).toContain("thwip.yaml");
  });

  it("does not open the setup pull request after GitHub access removal is requested", async () => {
    seedInstalledRepository();
    github.baseSha = async () => {
      d1.raw.prepare(
        `INSERT INTO project_release_requests
           (github_repository_id, project_id, organization_id, github_name, default_branch)
         VALUES (?, 'proj_1', 'org_1', 'acme/widgets', 'main')`,
      ).run(REPOSITORY_ID);
      return "b".repeat(40);
    };

    const response = await bootstrapRouteResponse(
      env(),
      viewer("admin"),
      REPOSITORY_ID,
      {},
      port,
    );

    expect(response).toMatchObject({ status: 409, body: { error: "repository access was removed during setup" } });
    expect(github.pull).toBeNull();
    expect(github.openedFiles).toEqual([]);
  });

  it("returns an exact manual ruleset payload without writing it as the App", async () => {
    seedInstalledRepository();
    github.pull = { number: 7, merged: true, headSha: "c".repeat(40) };

    const response = await bootstrapRouteResponse(
      env(),
      viewer("admin"),
      REPOSITORY_ID,
      {},
      port,
    );

    expect(response.status).toBe(202);
    expect(github.rulesets.size).toBe(0);
    expect(response.body).toMatchObject({
      outcomes: [
        { kind: "advanced", step: "merge-setup-pr" },
        {
          kind: "waiting",
          step: "create-disabled-policy-without-source",
          manualRulesets: [
            {
              operation: "create",
              ruleset: { name: "Thwip Repository Policy", enforcement: "disabled" },
            },
          ],
        },
      ],
    });
  });

  it("structures a GitHub failure while reading rulesets", async () => {
    seedInstalledRepository();
    github.pull = { number: 7, merged: true, headSha: "c".repeat(40) };
    github.rulesetNamed = async () => {
      throw new GithubApiError(
        "/repos/acme/widgets/rulesets",
        403,
        "Resource not accessible by integration",
      );
    };

    const response = await bootstrapRouteResponse(
      env(),
      viewer("admin"),
      REPOSITORY_ID,
      {},
      port,
    );

    expect(response).toMatchObject({
      status: 502,
      body: {
        code: "GITHUB_SETUP_FAILED",
        error: "GitHub refused repository setup",
      },
    });
    const progress = JSON.parse(String(queueProjectRow()?.bootstrap_progress_json)) as Record<
      string,
      boolean
    >;
    expect(progress["merge-setup-pr"]).toBe(true);
  });

  it("waits rather than finishing while the setup pull request is unmerged", async () => {
    seedInstalledRepository();
    github.openSetupPullRequest = async () => {
      github.pull = { number: 7, merged: false, headSha: "c".repeat(40) };
      return github.pull;
    };
    const response = await bootstrapRouteResponse(
      env(),
      viewer("admin"),
      REPOSITORY_ID,
      {},
      port,
    );
    expect(response.status).toBe(202);
    expect(queueProjectRow()?.enabled).toBe(0);
  });
});

describe("GET /v1/queue/:repositoryId/bootstrap", () => {
  it("refuses a caller with no session", async () => {
    seedInstalledRepository();
    expect((await bootstrapStatusResponse(env(), null, REPOSITORY_ID)).status).toBe(401);
  });

  it("refuses a member who does not administer the organization", async () => {
    seedInstalledRepository();
    expect(
      (await bootstrapStatusResponse(env(), viewer("member"), REPOSITORY_ID)).status,
    ).toBe(403);
  });

  it("answers 404 before the repository is enrolled", async () => {
    seedInstalledRepository();
    expect(
      (await bootstrapStatusResponse(env(), viewer("admin"), REPOSITORY_ID)).status,
    ).toBe(404);
  });

  it("reports where setup got to without doing any of it again", async () => {
    seedInstalledRepository();
    github.openSetupPullRequest = async () => {
      github.pull = { number: 7, merged: false, headSha: "c".repeat(40) };
      return github.pull;
    };
    await bootstrapRouteResponse(env(), viewer("admin"), REPOSITORY_ID, {}, port);

    const status = await bootstrapStatusResponse(env(), viewer("admin"), REPOSITORY_ID);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ nextStep: "merge-setup-pr", complete: false, enabled: false });
    // Reading state opens nothing: the pull request the run left behind is the
    // only one there is.
    expect(github.pull?.number).toBe(7);
  });
});
