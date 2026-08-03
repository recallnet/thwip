import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testD1, type TestD1 } from "../../test/d1.js";
import { bootstrapRouteResponse, bootstrapStatusResponse, type BootstrapRouteEnv } from "./bootstrap-route.js";
import type { BootstrapGitHub, SetupPullRequestState, StoredRuleset } from "./bootstrap.js";
import { POLICY_RULESET_NAME, type Ruleset } from "./rulesets.js";

/**
 * The route, because the route is what was missing.
 *
 * `handleBootstrapRequest` has had tests since it was written and enrolling a
 * repository still meant typing a `queue_projects` row into production D1, so a
 * suite that exercises the sequence again proves nothing. What is checked here
 * is who may ask, what a repository nobody installed the App on gets back, and
 * that a call an administrator makes leaves the row behind.
 */

const REPOSITORY_ID = "987654321";
const APP_INTEGRATION_ID = 4419870;

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
  private nextId = 100;

  async baseSha(): Promise<string> {
    return "b".repeat(40);
  }

  async setupPullRequest(): Promise<SetupPullRequestState | null> {
    return this.pull;
  }

  async openSetupPullRequest(): Promise<SetupPullRequestState> {
    this.pull = { number: 7, merged: true, headSha: "c".repeat(40) };
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
      { githubOrgRole: "member" },
      REPOSITORY_ID,
      {},
      port,
    );
    expect(response.status).toBe(403);
    // Setup writes rulesets and a pull request into somebody's repository, so a
    // refusal has to happen before any of it, not after enrolment.
    expect(queueProjectRow()).toBeUndefined();
    expect(github.rulesets.size).toBe(0);
  });

  it("answers 404 for a repository the App is not installed on", async () => {
    const response = await bootstrapRouteResponse(
      env(),
      { githubOrgRole: "admin" },
      "1234",
      {},
      port,
    );
    expect(response.status).toBe(404);
  });

  it("answers 404 when the organization has no installation to act through", async () => {
    seedInstalledRepository({ installationId: null });
    const response = await bootstrapRouteResponse(
      env(),
      { githubOrgRole: "admin" },
      REPOSITORY_ID,
      {},
      port,
    );
    expect(response.status).toBe(404);
    expect(queueProjectRow()).toBeUndefined();
  });

  it("enrols the repository the operator used to write by hand", async () => {
    seedInstalledRepository();
    // Already reviewed and merged, which is the second call an administrator
    // makes. The first opens the pull request and stops.
    github.pull = { number: 7, merged: true, headSha: "c".repeat(40) };
    const response = await bootstrapRouteResponse(
      env(),
      { githubOrgRole: "admin" },
      REPOSITORY_ID,
      {},
      port,
    );

    expect(response.status).toBe(200);
    const row = queueProjectRow();
    expect(row?.organization_id).toBe("org_1");
    expect(row?.base_ref).toBe("refs/heads/main");
    expect(row?.enabled).toBe(1);
    expect(row?.activation_state).toBe("observe");
    expect(github.rulesets.get(POLICY_RULESET_NAME)?.ruleset.enforcement).toBe("active");
  });

  it("lets an owner run setup, not only an admin", async () => {
    seedInstalledRepository();
    github.pull = { number: 7, merged: true, headSha: "c".repeat(40) };
    const response = await bootstrapRouteResponse(
      env(),
      { githubOrgRole: "owner" },
      REPOSITORY_ID,
      {},
      port,
    );
    expect(response.status).toBe(200);
  });

  it("takes the backend the caller asked for", async () => {
    seedInstalledRepository();
    await bootstrapRouteResponse(
      env(),
      { githubOrgRole: "admin" },
      REPOSITORY_ID,
      { backend: "native", mergeMethod: "merge" },
      port,
    );
    const row = queueProjectRow();
    expect(row?.backend).toBe("native");
    expect(row?.merge_method).toBe("merge");
  });

  it("waits rather than finishing while the setup pull request is unmerged", async () => {
    seedInstalledRepository();
    github.openSetupPullRequest = async () => {
      github.pull = { number: 7, merged: false, headSha: "c".repeat(40) };
      return github.pull;
    };
    const response = await bootstrapRouteResponse(
      env(),
      { githubOrgRole: "admin" },
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
      (await bootstrapStatusResponse(env(), { githubOrgRole: "member" }, REPOSITORY_ID)).status,
    ).toBe(403);
  });

  it("answers 404 before the repository is enrolled", async () => {
    seedInstalledRepository();
    expect(
      (await bootstrapStatusResponse(env(), { githubOrgRole: "admin" }, REPOSITORY_ID)).status,
    ).toBe(404);
  });

  it("reports where setup got to without doing any of it again", async () => {
    seedInstalledRepository();
    github.openSetupPullRequest = async () => {
      github.pull = { number: 7, merged: false, headSha: "c".repeat(40) };
      return github.pull;
    };
    await bootstrapRouteResponse(env(), { githubOrgRole: "admin" }, REPOSITORY_ID, {}, port);

    const status = await bootstrapStatusResponse(env(), { githubOrgRole: "admin" }, REPOSITORY_ID);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ nextStep: "merge-setup-pr", complete: false, enabled: false });
    // Reading state opens nothing: the pull request the run left behind is the
    // only one there is.
    expect(github.pull?.number).toBe(7);
  });
});
