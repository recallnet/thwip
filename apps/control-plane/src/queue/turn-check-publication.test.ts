import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import { TURN_CHECK } from "./turn-check.js";
import type { QueueRouteEnv } from "./routes.js";
import type { Env } from "../env.js";

// `../index.js` statically re-exports the Durable Object class, which needs
// `cloudflare:workers` and only resolves under the Workers pool.
vi.mock("./BranchQueue.js", () => ({ BranchQueue: class {} }));
// The App's installation token is a signed JWT and a round trip to GitHub.
// Neither is what these tests are about.
vi.mock("../github-app.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  installationToken: async () => "installation-token",
}));
const { queueFromPullRequest } = await import("../index.js");

/**
 * The turn check reaches the commit the webhook placed.
 *
 * Whose turn it is is published only when the turn *changes*, which is right:
 * republishing for every entry on every command is a request to GitHub per entry
 * per check. It relies on every writer of queue state publishing what it changed,
 * and the pull-request webhook did not. It is the first writer for almost every
 * pull request — GitHub delivers `opened` before the required workflow runs — so
 * it is the one that moves an entry from absent to waiting. `/authorize` then
 * found the entry already waiting, changed nothing, and published nothing.
 *
 * A pull request that was later offered the lane got its check on that
 * transition and looked fine. One that sat waiting never got a check at all, and
 * `thwip / turn` is required, so it could not merge and nothing on the page said
 * why. Observed live on recallnet/thwip: 116 and 118 held the lane and carry the
 * check; 114 and 120 waited and carry no check run of that name on their heads.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const HEAD = "5".repeat(40);

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (open.length > 0) open.pop()!.close();
});

function seed() {
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, ?, ?, ?)")
    .run("org_1", "1", "acme", "9001");
  raw
    .prepare(
      "INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state) VALUES (?, ?, ?, ?, 1, 'enforced')",
    )
    .run("qp_1", "org_1", REPO, REF);
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("principal_7", "org_1", "7", "author7");
}

function openedPayload(pullRequestNumber: number, headSha: string) {
  return {
    action: "opened",
    pull_request: {
      number: pullRequestNumber,
      draft: false,
      state: "open",
      base: { ref: "main", repo: { id: Number(REPO) } },
      head: { sha: headSha },
      user: { id: 7, login: "author7", type: "User" },
    },
  };
}

/** Records what the App asked GitHub to do, and reports no existing check runs. */
function recordingGithub() {
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" || init?.method === "PATCH") {
        posted.push({ url, body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
        return Response.json({ id: 1 });
      }
      if (url.includes("/check-runs")) return Response.json({ check_runs: [] });
      return Response.json({});
    }),
  );
  return posted;
}

describe("the check that says whose turn it is", () => {
  it("is published for the commit the pull-request webhook placed, before anything asks for a turn", async () => {
    const e = env();
    seed();
    const posted = recordingGithub();

    // One pull request takes the lane, so the next one waits — which is the case
    // that never got a check, because waiting is the state nothing changed it out
    // of.
    await queueFromPullRequest(e as unknown as Env, openedPayload(118, "8".repeat(40)));
    const placed = await queueFromPullRequest(e as unknown as Env, openedPayload(120, HEAD));
    expect(placed.handled).toBe(true);

    const turn = posted.find((call) => call.body["name"] === TURN_CHECK && call.body["head_sha"] === HEAD);
    expect(turn, "the webhook placed the entry and published no turn check").toBeDefined();
    // Waiting is reported as still running: a required check that has failed goes
    // on refusing the merge after the queue has authorized.
    expect(turn!.body["status"]).toBe("in_progress");
    expect(turn!.body["conclusion"]).toBeUndefined();
  });

  it("says the same thing once, however many events arrive for one commit", async () => {
    const e = env();
    seed();
    let published: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/check-runs")) {
          published = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
          return Response.json({ id: 1 });
        }
        if (init?.method === "PATCH") return Response.json({ id: 1 });
        if (url.includes("/check-runs")) {
          // What the commit already says, which is what the publisher reads to
          // stay quiet rather than making a new check run per event.
          return Response.json({
            check_runs:
              published === null
                ? []
                : [
                    {
                      id: 1,
                      status: published["status"],
                      conclusion: published["conclusion"] ?? null,
                      output: (published["output"] as { title: string }) ?? null,
                    },
                  ],
          });
        }
        return Response.json({});
      }),
    );

    await queueFromPullRequest(e as unknown as Env, openedPayload(120, HEAD));
    const afterFirst = published;
    await queueFromPullRequest(e as unknown as Env, { ...openedPayload(120, HEAD), action: "synchronize" });

    expect(afterFirst).not.toBeNull();
    expect(published).toEqual(afterFirst);
  });
});
