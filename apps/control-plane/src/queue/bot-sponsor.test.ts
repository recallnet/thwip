import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { TURN_CHECK, turnCheckRun } from "./turn-check.js";
import type { Env } from "../env.js";

// `../index.js` statically re-exports the Durable Object class, which needs
// `cloudflare:workers` and only resolves under the Workers pool.
vi.mock("./BranchQueue.js", () => ({ BranchQueue: class {} }));
vi.mock("../github-app.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  installationToken: async () => "installation-token",
}));
const { queueFromPullRequest } = await import("../index.js");

/**
 * Who sponsors a pull request nobody can be accountable for.
 *
 * The sponsor is the author, read from GitHub. That was a deliberate fix: the
 * join route used to sponsor whoever called it while the `pull_request` webhook
 * sponsored the author, so one pull request had two sponsors depending on which
 * arrived first, and under `fresh` the turn went to one person while the queue
 * waited for a machine belonging to the other.
 *
 * The rule left a hole. An App bot such as `renovate[bot]` has no principal, so
 * a bot-authored pull request read as unplaceable with no fix at all: the check
 * said "the queue has nobody to give this turn to" and nothing anybody did
 * cleared it. `SPONSOR_REQUIRED` had a sentence on every surface and no writer,
 * because `authorIsBot` had none either.
 *
 * The rule now: the author sponsors when the author is a principal; a human who
 * joins sponsors a bot's pull request. What stops the two-sponsor bug returning
 * is that the sponsor is decided once, at entry creation, and no later path
 * recomputes it.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const HEAD = "5".repeat(40);
const BOT_USER_ID = 99;

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, ?, ?, ?)")
    .run("org_1", "1", "acme", "9001");
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  raw
    .prepare(
      "INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, project_id) VALUES (?, ?, ?, ?, 1, 'enforced', ?)",
    )
    .run("qp_1", "org_1", REPO, REF, "proj_1");
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("alice", "org_1", "1", "alice");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (open.length > 0) open.pop()!.close();
});

function botPayload(action = "opened") {
  return {
    action,
    pull_request: {
      number: 120,
      draft: false,
      state: "open",
      base: { ref: "main", repo: { id: Number(REPO) } },
      head: { sha: HEAD },
      user: { id: BOT_USER_ID, login: "renovate[bot]", type: "Bot" },
    },
  };
}

function routes(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  return queueRoutes({
    publishTurnCheck: async () => {},
    authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: true }),
    verifyOidc: async () => ({ repository_id: REPO }),
    pinnedVerifier: async () => null,
    activePolicy: async () => null,
    proofCheckRunId: async () => null,
    signRecordBytes: async (_e, bytes) => `jws.${bytes.byteLength}`,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced", projectId: "proj_1" }),
    principalFor: async (_e, _repositoryId, githubUserId) => (githubUserId === "1" ? "alice" : null),
    pullRequestPlacement: async () => ({
      authorGithubUserId: String(BOT_USER_ID),
      baseRef: REF,
      authorIsBot: true,
    }),
    commitFacts: async () => null,
    sleep: async () => {},
    ...over,
  });
}

function sponsorOf(entryId: string): { sponsor_principal_id: string } | undefined {
  return raw
    .prepare("SELECT sponsor_principal_id FROM queue_entries_index WHERE entry_id = ?")
    .get(entryId) as { sponsor_principal_id: string } | undefined;
}

describe("a bot pull request needs a human behind it", () => {
  it("does not let the webhook place a bot's pull request with no sponsor", async () => {
    const e = env();

    const outcome = await queueFromPullRequest(e as unknown as Env, botPayload());

    expect(outcome.handled).toBe(false);
    expect(outcome.detail).toContain("sponsor");
    expect(sponsorOf(`entry_${REPO}_120`)).toBeUndefined();
  });

  it("says so on the check, rather than leaving a required check nothing explains", async () => {
    const e = env();
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (typeof init?.body === "string") posted.push(init.body);
        return new Response("{}", { status: 200 });
      }),
    );

    await queueFromPullRequest(e as unknown as Env, botPayload());

    const check = posted.find((body) => body.includes(TURN_CHECK));
    expect(check).toBeDefined();
    expect(check).toContain("failure");
    // The sentence a developer reads, from the one renderer every surface uses.
    expect(check).toContain(
      turnCheckRun({
        entryId: `entry_${REPO}_120`,
        pullRequestNumber: 120,
        headSha: HEAD,
        state: "unplaceable",
        waiting: 0,
        primaryReason: "SPONSOR_REQUIRED",
      }).title,
    );
  });

  it("makes the human who joins the sponsor", async () => {
    const e = env();
    const app = routes();

    const response = await app.request(
      `/v1/queue/${REPO}/entries?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pullRequestNumber: 120, headSha: HEAD }),
      },
      e,
    );

    expect(response.status).toBe(202);
    expect(sponsorOf(`entry_${REPO}_120`)?.sponsor_principal_id).toBe("alice");
  });

  it("leaves the sponsor alone once it is recorded", async () => {
    const e = env();
    const app = routes();
    await app.request(
      `/v1/queue/${REPO}/entries?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pullRequestNumber: 120, headSha: HEAD }),
      },
      e,
    );

    // The bot pushes again. This is where the two-sponsor bug lived: two writers
    // deciding the sponsor from different facts, whichever ran last winning.
    const outcome = await queueFromPullRequest(e as unknown as Env, botPayload("synchronize"));

    expect(outcome.handled).toBe(true);
    expect(sponsorOf(`entry_${REPO}_120`)?.sponsor_principal_id).toBe("alice");
  });

  it("still refuses a human author with no activated principal", async () => {
    // Unchanged. A person who has not activated is a different problem with a
    // different fix, and calling it a missing sponsor would send them to the
    // wrong place.
    const e = env();
    const app = routes({
      pullRequestPlacement: async () => ({ authorGithubUserId: "7", baseRef: REF, authorIsBot: false }),
    });

    const response = await app.request(
      `/v1/queue/${REPO}/entries?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pullRequestNumber: 121, headSha: HEAD }),
      },
      e,
    );

    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toBe("AUTHOR_NOT_ACTIVATED");
  });

  it("keeps the author as sponsor when the author is a person", async () => {
    // Sponsorship still comes from GitHub for a human author, so a colleague
    // joining on someone else's behalf does not take their fairness share.
    const e = env();
    const app = routes({
      principalFor: async (_e, _repositoryId, githubUserId) => (githubUserId === "7" ? "carol" : null),
      pullRequestPlacement: async () => ({ authorGithubUserId: "7", baseRef: REF, authorIsBot: false }),
    });

    await app.request(
      `/v1/queue/${REPO}/entries?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pullRequestNumber: 122, headSha: HEAD }),
      },
      e,
    );

    expect(sponsorOf(`entry_${REPO}_122`)?.sponsor_principal_id).toBe("carol");
  });

  it("tells the merge gate a bot pull request needs a sponsor, not that it is unplaceable", async () => {
    const e = env();
    const app = routes();

    const response = await app.request(
      `/v1/queue/${REPO}/authorize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pullRequestNumber: 123,
          headSha: HEAD,
          baseRef: REF,
          authorGithubUserId: String(BOT_USER_ID),
          proofAccepted: true,
          draft: false,
        }),
      },
      e,
    );

    const verdict = (await response.json()) as { authorized: boolean; reason: string };
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toBe("SPONSOR_REQUIRED");
  });
});
