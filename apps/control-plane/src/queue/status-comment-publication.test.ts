import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import { COMMENT_MARKER } from "./status-comment.js";
import type { QueueRouteEnv } from "./routes.js";
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
 * The comment reaching a real pull request, through the delivery that places
 * the entry.
 *
 * Written this way on purpose. Twice in this repository a surface was built,
 * unit tested, and wired to nothing, and the tests all passed because they
 * called the thing directly. This one goes in at the webhook and reads what
 * GitHub was asked to do.
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

function seed(options: { enabled?: number; activation?: string } = {}) {
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, ?, ?, ?)")
    .run("org_1", "1", "acme", "9001");
  raw
    .prepare(
      "INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("qp_1", "org_1", REPO, REF, options.enabled ?? 1, options.activation ?? "enforced");
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

function openedPayload(pullRequestNumber: number, headSha: string, over: Record<string, unknown> = {}) {
  return {
    action: "opened",
    pull_request: {
      number: pullRequestNumber,
      draft: false,
      state: "open",
      base: { ref: "main", repo: { id: Number(REPO) } },
      head: { sha: headSha },
      user: { id: 7, login: "author7", type: "User" },
      ...over,
    },
  };
}

/** A GitHub that keeps the comments it is given, and reports them back. */
function recordingGithub() {
  const comments: Array<{ id: number; body: string; pullRequestNumber: number }> = [];
  let next = 500;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const issueComments = /\/issues\/(\d+)\/comments/.exec(url);
      if (issueComments !== null && (init?.method ?? "GET") === "GET") {
        const number = Number(issueComments[1]);
        return Response.json(comments.filter((c) => c.pullRequestNumber === number));
      }
      if (issueComments !== null && init?.method === "POST") {
        const id = next++;
        const body = JSON.parse(String(init.body ?? "{}")) as { body: string };
        comments.push({ id, body: body.body, pullRequestNumber: Number(issueComments[1]) });
        return Response.json({ id });
      }
      const edit = /\/issues\/comments\/(\d+)/.exec(url);
      if (edit !== null && init?.method === "PATCH") {
        const found = comments.find((c) => c.id === Number(edit[1]));
        if (found !== undefined) found.body = (JSON.parse(String(init.body ?? "{}")) as { body: string }).body;
        return Response.json({ id: Number(edit[1]) });
      }
      if (url.includes("/check-runs")) {
        return (init?.method ?? "GET") === "GET" ? Response.json({ check_runs: [] }) : Response.json({ id: 1 });
      }
      return Response.json({});
    }),
  );
  return comments;
}

describe("the comment on a queued pull request", () => {
  it("appears on the pull request the delivery placed", async () => {
    const e = env();
    seed();
    const comments = recordingGithub();

    await queueFromPullRequest(e as unknown as Env, openedPayload(120, HEAD));

    const mine = comments.filter((c) => c.body.includes(COMMENT_MARKER));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.pullRequestNumber).toBe(120);
    expect(mine[0]!.body).toContain("**thwip**");
  });

  it("edits the one it wrote rather than adding another", async () => {
    const e = env();
    seed();
    const comments = recordingGithub();

    await queueFromPullRequest(e as unknown as Env, openedPayload(120, HEAD));
    await queueFromPullRequest(e as unknown as Env, {
      ...openedPayload(120, "6".repeat(40), { draft: true }),
      action: "converted_to_draft",
    });

    expect(comments.filter((c) => c.body.includes(COMMENT_MARKER))).toHaveLength(1);
    expect(comments[0]!.body).toContain("draft");
  });

  /**
   * The App is installed on repositories that never enrolled. A bot that starts
   * commenting on those is uninstalled the same day, so the gate is the same
   * `enabled = 1` the tick reads and there is one answer to whether the queue
   * runs on a branch.
   */
  it("says nothing at all on a repository whose queue is switched off", async () => {
    const e = env();
    seed({ enabled: 0 });
    const comments = recordingGithub();

    await queueFromPullRequest(e as unknown as Env, openedPayload(120, HEAD));

    expect(comments.filter((c) => c.body.includes(COMMENT_MARKER))).toEqual([]);
  });

  /**
   * Observing is not switched off. The repository enrolled, the entry is real,
   * and the queue merges nothing yet, so the comment says that.
   */
  it("comments on a repository that is only observing, and says so", async () => {
    const e = env();
    seed({ activation: "observe" });
    const comments = recordingGithub();

    await queueFromPullRequest(e as unknown as Env, openedPayload(120, HEAD));

    const mine = comments.filter((c) => c.body.includes(COMMENT_MARKER));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain("observing");
  });
});
