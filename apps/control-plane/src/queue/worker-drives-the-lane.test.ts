import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { fixturePolicy } from "../../test/queue-deps.js";
import { provenCommit } from "../../test/proven-commit.js";
import type { QueueRouteEnv } from "./routes.js";
import { runOnQueue } from "./routes.js";
import { loadQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";
import { driveQueue } from "./drive-queue.js";

// `../index.js` statically re-exports the Durable Object class, which needs
// `cloudflare:workers` and only resolves under the Workers pool.
vi.mock("./BranchQueue.js", () => ({ BranchQueue: class {} }));
vi.mock("../github-app.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  installationToken: async () => "installation-token",
}));
const { queueFromPullRequest } = await import("../index.js");

/**
 * The Worker taking its own lane to a merge.
 *
 * The queue walks the holder itself. It never dispatches repository automation
 * to perform the write, and the push from its own merge wakes the next entry.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const HEAD = "5".repeat(40);
const BASE = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const TREE = "7".repeat(40);

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
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
    .run("alice", "org_1", "1", "alice");
  acceptProof(raw, REPO, HEAD);
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (open.length > 0) open.pop()!.close();
});

const onQueue = ((e, repositoryId, baseRef, decide) =>
  runOnQueue(e, repositoryId, baseRef, decide)) as Parameters<typeof driveQueue>[2];

function opened() {
  return {
    action: "opened",
    pull_request: {
      number: 120,
      draft: false,
      state: "open",
      base: { ref: "main", repo: { id: Number(REPO) } },
      head: { sha: HEAD },
      user: { id: 1, login: "alice", type: "User" },
    },
  };
}

async function entry(e: QueueRouteEnv) {
  const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
  return store.state().entries.get(`entry_${REPO}_120`);
}

/**
 * Every call the Worker makes to GitHub, so a dispatch that did or did not
 * happen is observed rather than assumed. `queueFromPullRequest` runs the real
 * deps, and a stub array they never touch would pass whatever the code did.
 */
function watchGithub(): string[] {
  const called: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    called.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  return called;
}

function reads(over: Record<string, unknown> = {}) {
  return {
    queueProject: async () => ({
      activationState: "enforced",
    }),
    principalFor: async () => "alice",
    pullRequestPlacement: async () => ({
      authorGithubUserId: "1",
      baseRef: REF,
      authorIsBot: false,
      draft: false,
      headSha: HEAD,
    }),
    pullRequestNumbersForCommit: async () => [120],
    activePolicy: async () => fixturePolicy(),
    dispatchCandidateVerification: async () => ({ ok: true }),
    integratedCandidate: async () => ({
      status: "pinned" as const,
      baseSha: BASE,
      headSha: HEAD,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
    }),
    mergeWrite: async () => ({ kind: "unknown", detail: "test does not land the merge" }),
    publishTurnCheck: async () => {},
    commitFacts: async () => ({
      treeOid: TREE,
      parentShas: [BASE],
      message: provenCommit({ repositoryId: REPO, baseRef: REF, treeOid: TREE, baseSha: BASE }),
    }),
    proofCheckRunId: async () => "778899",
    baseContainsSha: async () => true,
    signRecordBytes: async () => "jws",
    ...over,
  };
}

describe("who drives the lane", () => {
  it("does not dispatch repository automation to perform an App write", async () => {
    const e = env();
    const called = watchGithub();

    await queueFromPullRequest(e as never, opened());

    expect((await entry(e))?.state).toBe("Active");
    expect(called.filter((url) => url.endsWith("/dispatches"))).toEqual([]);
  });

  it("walks nobody when the lane is idle", async () => {
    const e = env();

    const walked = await driveQueue(e, reads() as never, onQueue, { repositoryId: REPO, baseRef: REF });

    expect(walked).toBe(0);
  });

  it("publishes the held turn before a heartbeat-offered lane writes", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());

    const order: string[] = [];
    await driveQueue(
      e,
      reads({
        publishTurnCheck: async (_env: QueueRouteEnv, repositoryId: string, update: { state: string; headSha: string }) => {
          expect(repositoryId).toBe(REPO);
          expect(update).toMatchObject({ state: "holds", headSha: HEAD });
          order.push("turn-check");
        },
        mergeWrite: async () => {
          order.push("merge-write");
          return { kind: "unknown" as const, detail: "test does not land the merge" };
        },
      }) as never,
      onQueue,
      { repositoryId: REPO, baseRef: REF },
    );

    expect(order).toEqual(["turn-check", "merge-write"]);
  });

  it("does not write the branch when the held-turn publication fails", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());

    let mergeWrites = 0;
    await expect(
      driveQueue(
        e,
        reads({
          publishTurnCheck: async () => {
            throw new Error("GitHub refused the turn check");
          },
          mergeWrite: async () => {
            mergeWrites += 1;
            return { kind: "unknown" as const, detail: "must not be reached" };
          },
        }) as never,
        onQueue,
        { repositoryId: REPO, baseRef: REF },
      ),
    ).rejects.toThrow("GitHub refused the turn check");
    expect(mergeWrites).toBe(0);
  });

  it("does not write the branch without a held-turn publisher", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());

    let mergeWrites = 0;
    await driveQueue(
      e,
      reads({
        publishTurnCheck: undefined,
        mergeWrite: async () => {
          mergeWrites += 1;
          return { kind: "unknown" as const, detail: "must not be reached" };
        },
      }) as never,
      onQueue,
      { repositoryId: REPO, baseRef: REF },
    );
    expect(mergeWrites).toBe(0);
  });

});
