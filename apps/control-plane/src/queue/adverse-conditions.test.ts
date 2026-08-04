import { afterEach, describe, expect, it, vi } from "vitest";
import { queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { queueRoutes, runOnQueue, type QueueRouteEnv } from "./routes.js";
import type { TurnCheckUpdate } from "./turn-check.js";
import { externalPushFromWebhook, QUEUE_MERGE_TRAILER } from "./external-push.js";
import { b64stdEncode, encodeCarrier, utf8Encode } from "@thwip/protocol";
import type { Env } from "../env.js";

// `../index.js` statically re-exports the Durable Object class, which needs
// `cloudflare:workers` and only resolves under the Workers pool. Stubbing that
// one export lets `queueFromPullRequest` load under plain node, the same way
// every other control-plane unit test avoids the Workers pool.
vi.mock("./BranchQueue.js", () => ({ BranchQueue: class {} }));
// `driveTurnFor` (the webhook's own dispatcher, module-level in `../index.js`)
// signs a real GitHub App JWT before it ever reaches `fetch`. Stubbing
// `installationToken` lets a test that only cares whether the dispatch was
// attempted skip carrying a real private key.
vi.mock("../github-app.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-app.js")>();
  return { ...actual, installationToken: async () => "test-installation-token" };
});
const { queueFromPullRequest } = await import("../index.js");

/**
 * The queue under the conditions that actually broke it.
 *
 * Every case here is something that happened to a live repository rather than
 * something imagined: a pull request closed while it held the lane, a merge
 * GitHub refused, a base branch that moved underneath a turn, and several checks
 * arriving at once. Each cost hours to diagnose, and none of them could be
 * written as a test while the queue lived in a Durable Object.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  // Every session-authenticated queue route establishes membership before it
  // acts, so the session this file's `routes()` stub holds has to belong to the
  // organization that owns the repository or nothing here reaches its subject.
  seedMembership("alice", "1");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
// A real object id: the signed records refuse anything that is not one.
const TREE = "7".repeat(40);

/**
 * A commit message carrying a readable proof, as a shipped head does.
 *
 * The payload is a real predicate rather than an empty statement, because the
 * merge gate reads what the proof bound: the policy and pipeline it satisfied,
 * and the suites it ran. Defaults match the policy `routes()` stubs.
 */
function provenCommit(
  over: {
    policyDigest?: string;
    pipelineDigest?: string;
    suites?: Array<{ id: string; status: "passed" | "failed" }>;
  } = {},
): string {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "git-tree", digest: { sha1: TREE } }],
    predicateType: "urn:thwip:attestation:ci-run:v1",
    predicate: {
      schemaVersion: "1",
      repository: { provider: "github", ownerId: "1", repositoryId: REPO },
      git: {
        objectFormat: "sha1",
        treeOid: TREE,
        parentOids: ["b".repeat(40)],
        baseRef: REF,
        baseSha: "b".repeat(40),
        evaluationMode: "head-tree",
      },
      policy: { digest: over.policyDigest ?? `sha256:${"b".repeat(64)}`, version: 1 },
      pipeline: { digest: over.pipelineDigest ?? `sha256:${"c".repeat(64)}`, runner: "command" },
      run: {
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
        networkMode: "disabled",
        cacheMode: "disabled",
        suites: (over.suites ?? [{ id: "unit", status: "passed" as const }]).map((s) => ({
          ...s,
          durationMs: 1,
        })),
      },
      signer: { keyId: `SHA256:${"k".repeat(43)}`, githubUserId: "1" },
    },
  };
  const envelope = {
    payloadType: "application/vnd.in-toto+json",
    payload: b64stdEncode(utf8Encode(JSON.stringify(statement))),
    signatures: [{ keyid: `SHA256:${"k".repeat(43)}`, sig: "AAAA" }],
  };
  return `feat: something\n\n${encodeCarrier(envelope as never)}\n`;
}

const PROVEN = provenCommit();

const published: TurnCheckUpdate[] = [];

/**
 * The commits GitHub holds, for the routes that read one.
 *
 * A merge report names a commit and says nothing else about it: the tree and
 * the parents come from GitHub. So a test that reports a merge says here what
 * GitHub answers for that commit. Every other sha is a pull request head, and
 * the default below describes those as carrying a proof.
 */
const commits = new Map<string, { treeOid: string; parentShas: string[] }>();

/** What GitHub holds for the commit a test is about to report as merged. */
function landed(sha: string, treeOid: string, parentShas: readonly string[]): void {
  commits.set(sha, { treeOid, parentShas: [...parentShas] });
}

function routes(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  published.length = 0;
  commits.clear();
  return queueRoutes(
    queueRouteDeps({ repositoryId: REPO, baseRef: REF, treeOid: TREE }, {
      publishTurnCheck: async (_e: unknown, _r: string, update: never) => {
        published.push(update);
      },
      commitFacts: async (_e: unknown, _r: string, sha: string) =>
        commits.get(sha) ?? { treeOid: TREE, parentShas: ["b".repeat(40), "6".repeat(40)], message: PROVEN },
      // A refusal the queue can confirm: GitHub says not merged and the base does
      // not contain the head. Every test that reports a refusal means this one,
      // and the tests that mean a stale read say so themselves.
      pullRequestMergeState: async () => ({ merged: false, mergeCommitSha: null }),
      // Two questions reach this. The head has not landed, which is the refusal
      // above; the commit a test reports as merged has, which is what lets its
      // record be signed. Head shas here are a pull request number padded with
      // "a" and no test reports one as its merge, so the prefix separates them.
      baseContainsSha: async (_e: unknown, _r: string, _ref: string, sha: string) => !sha.startsWith("a"),
      ...over,
    }) as Parameters<typeof queueRoutes>[0],
  );
}

interface Verdict {
  authorized: boolean;
  reason: string;
  entryId: string;
  operationId: string | null;
  merge?: {
    baseRef: string;
    baseSha: string;
    headSha: string;
    treeOid: string;
    parentShas: string[];
  } | null;
}

type App = ReturnType<typeof routes>;

async function authorize(app: App, e: QueueRouteEnv, pr: number, over: Record<string, unknown> = {}) {
  acceptProof(raw, REPO, (over["headSha"] as string | undefined) ?? String(pr).padStart(40, "a"));
  const response = await app.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber: pr,
        headSha: String(pr).padStart(40, "a"),
        baseRef: REF,
        authorGithubUserId: String(pr),
        draft: false,
        ...over,
      }),
    },
    e,
  );
  return (await response.json()) as Verdict;
}

/** A device id shaped the way `thwip queue work` sends one: a signing key fingerprint. */
const DEVICE = `SHA256:${"a".repeat(43)}`;

/** The repository's organization, its project row, and one principal in it. */
function seedMembership(principalId: string, githubUserId: string): void {
  raw
    .prepare("INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_1", "1", "acme");
  raw
    .prepare(
      "INSERT OR IGNORE INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  raw
    .prepare(
      "INSERT OR IGNORE INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run(principalId, "org_1", githubUserId, `author${githubUserId}`);
}

/**
 * Post a heartbeat as `principalId`, the way a connected device does before a
 * device-only entry can ever become scheduler-eligible. `routes()`'s own
 * `authenticate` stub is fixed to "alice", so callers that need a different
 * connected principal — `principalFor` maps a pull request's author to
 * `principal_<githubUserId>`, not to the session's principal — must build
 * their own app with `authenticate` overridden to match.
 *
 * The route also refuses a principal who is not in the organization that owns
 * the repository, so a test that heartbeats calls `seedMembership` first.
 */
async function heartbeat(app: App, e: QueueRouteEnv, deviceKeyId = DEVICE) {
  return app.request(
    `/v1/queue/${REPO}/runners/heartbeat`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKeyId }) },
    e,
  );
}

async function liveState(app: App, e: QueueRouteEnv) {
  const response = await app.request(`/v1/queue/${REPO}?ref=${encodeURIComponent(REF)}&live=1`, {}, e);
  return (await response.json()) as {
    activeAttemptId: string | null;
    paused: boolean;
    rebaselineRequired: boolean;
    entries: Array<{ pullRequestNumber: number; state: string; headSha: string | null }>;
  };
}

function stateOf(snapshot: Awaited<ReturnType<typeof liveState>>, pr: number) {
  return snapshot.entries.find((entry) => entry.pullRequestNumber === pr)?.state;
}

describe("several pull requests arriving at once", () => {
  it("gives the lane to exactly one, however they interleave", async () => {
    const e = env();
    const app = routes();

    // Genuinely concurrent, which is what a repository with several open pull
    // requests does every time somebody pushes.
    const verdicts = await Promise.all([59, 61, 65, 66, 67].map((pr) => authorize(app, e, pr)));

    expect(verdicts.filter((v) => v.reason === "HOLDS_TURN")).toHaveLength(1);
    expect((await liveState(app, e)).entries.filter((entry) => entry.state === "Active")).toHaveLength(1);
  });

  it("keeps giving one lane no matter how many rounds they ask for", async () => {
    const e = env();
    const app = routes();
    for (let round = 0; round < 4; round += 1) {
      await Promise.all([59, 61, 65].map((pr) => authorize(app, e, pr)));
      const snapshot = await liveState(app, e);
      const holding = snapshot.entries.filter((entry) =>
        ["Offered", "Active", "Verifying", "MergeGuard", "Merging"].includes(entry.state),
      );
      expect(holding, `round ${round}`).toHaveLength(1);
    }
  });
});

describe("the pull request holding the lane goes away", () => {
  /**
   * A closed pull request is never coming back to take its turn, so a queue that
   * keeps it holding the lane stops entirely. This happened: the webhook that
   * cancels a closed entry was still writing to storage nothing read, and the
   * lane sat on a pull request that no longer existed.
   */
  it("frees the lane and offers it to somebody who can use it", async () => {
    const e = env();
    const app = routes();
    const first = await authorize(app, e, 59);
    await authorize(app, e, 61);
    expect(first.reason).toBe("HOLDS_TURN");

    const removed = await app.request(
      `/v1/queue/${REPO}/entries/${first.entryId}?ref=${encodeURIComponent(REF)}&reason=closed`,
      { method: "DELETE" },
      e,
    );
    expect(removed.status).toBe(200);

    expect((await authorize(app, e, 61)).reason).toBe("HOLDS_TURN");
  });
});

/**
 * A pull request that has left must not keep taking turns.
 *
 * Twice in production a merged pull request was still an entry, was offered the
 * turn, and starved the queue behind it until an operator ejected it by hand.
 * The `closed` webhook does cancel an entry, so what matters is the case it was
 * missing: the entry holding a live attempt when its pull request goes away.
 */
describe("a pull request that leaves while holding the lane", () => {
  /**
   * The entry holds the lane and nothing has been sent to GitHub for it. That
   * is the case a close has an answer for. An attempt whose merge write is
   * already in flight is a different question, and the reducer refuses to
   * cancel it: only confirmation may say what a write did.
   */
  it("frees the lane instead of holding it", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59);
    expect(holder.reason).toBe("HOLDS_TURN");

    const response = await app.request(
      `/v1/queue/${REPO}/entries/entry_${REPO}_59?ref=${encodeURIComponent(REF)}&reason=${encodeURIComponent("the pull request was closed")}`,
      { method: "DELETE" },
      e,
    );
    expect(response.status).toBe(200);

    const after = await liveState(app, e);
    expect(after.activeAttemptId).toBeNull();
    expect(stateOf(after, 59)).toBe("Cancelled");
  });
});

/**
 * The actual `closed` webhook, not the DELETE route it drives.
 *
 * Three times in one night a merged pull request — 78, 96 and 97 — stayed an
 * entry, was offered the turn, and starved the queue behind it. The reducer
 * cancels a live attempt fine (see above); what stopped the cancel from
 * reaching it was `queueFromPullRequest` itself. It gated the cancel behind
 * two lookups that exist to decide whether a *new* entry may be placed — a
 * configured project row and the author's activated principal — neither of
 * which a pull request that is only leaving needs. When either lookup came up
 * empty after the entry was already placed, the whole handler returned early
 * and the cancel it should have issued never ran.
 */
describe("the closed webhook itself, once the project or principal it looked up is gone", () => {
  const org = "org_1";
  const authorGithubUserId = "59";

  function seed(raw: import("better-sqlite3").Database) {
    raw
      .prepare(
        "INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)",
      )
      .run(org, "1", "acme");
    raw
      .prepare(
        "INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state) VALUES (?, ?, ?, ?, 1, 'enforced')",
      )
      .run("qp_1", org, REPO, REF);
    raw
      .prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
      .run("principal_59", org, authorGithubUserId, "author59");
  }

  function closedPayload() {
    return {
      action: "closed",
      pull_request: {
        number: 59,
        draft: false,
        state: "closed",
        base: { ref: "main", repo: { id: Number(REPO) } },
        head: { sha: String(59).padStart(40, "a") },
        user: { id: 59, login: "author59", type: "User" },
      },
    };
  }

  it("still cancels the entry when the project row has since gone missing", async () => {
    const e = env();
    seed(raw);
    const app = routes();
    const holder = await authorize(app, e, 59);
    expect(holder.reason).toBe("HOLDS_TURN");

    // The project row that placed this entry is gone by the time it closes —
    // disabled, reconfigured, whatever the reason. The entry it already
    // placed still exists and still needs to leave.
    raw.prepare("DELETE FROM queue_projects WHERE id = 'qp_1'").run();

    const result = await queueFromPullRequest(e as unknown as Env, closedPayload());
    expect(result).toEqual({ handled: true, detail: "entry cancelled" });

    const after = await liveState(app, e);
    expect(after.activeAttemptId).toBeNull();
    expect(stateOf(after, 59)).toBe("Cancelled");
  });

  it("still cancels the entry when the author's principal has since gone missing", async () => {
    const e = env();
    seed(raw);
    const app = routes();
    const holder = await authorize(app, e, 59);
    expect(holder.reason).toBe("HOLDS_TURN");

    // The author's principal that placed this entry is gone by the time it
    // closes. The entry it already placed still exists and still needs to
    // leave; cancelling it never needed to know who the author was.
    raw.prepare("DELETE FROM principals WHERE id = 'principal_59'").run();

    const result = await queueFromPullRequest(e as unknown as Env, closedPayload());
    expect(result).toEqual({ handled: true, detail: "entry cancelled" });

    const after = await liveState(app, e);
    expect(after.activeAttemptId).toBeNull();
    expect(stateOf(after, 59)).toBe("Cancelled");
  });

  /**
   * The same family as the eject route and the queue-result callback: freeing
   * the lane is only half of it. `queueFromPullRequest`'s `closed` branch
   * cancels the entry through `commands.cancel` directly, bypassing the
   * `driveLane` every route uses, so a pull request closed while it held the
   * lane never told whoever was offered it next.
   */
  it("drives whoever gets the turn after the closed webhook frees the lane", async () => {
    const e = env();
    seed(raw);
    raw
      .prepare("UPDATE organizations SET installation_id = ? WHERE id = ?")
      .run("inst_1", org);
    raw
      .prepare(
        // Replace: the environment already seeded this project row so the
        // session has a membership to be checked against.
        "INSERT OR REPLACE INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
      )
      .run("proj_1", org, REPO, "acme/repo");
    const app = routes();
    await authorize(app, e, 59);
    await authorize(app, e, 61);

    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const result = await queueFromPullRequest(e as unknown as Env, closedPayload());
      expect(result).toEqual({ handled: true, detail: "entry cancelled" });

      // The lane moved to 61, so something has to tell it. Nothing did, and
      // the offer expired unclaimed.
      const dispatch = fetch.mock.calls.find(([url]) => String(url).includes("/dispatches"));
      expect(dispatch).toBeDefined();
      const body = JSON.parse(String(dispatch![1]?.body));
      expect(body.client_payload.pullRequestNumber).toBe(61);
    } finally {
      fetch.mockRestore();
    }
  });

  /**
   * `driveLane`, the dispatcher every route goes through, withholds Actions
   * for `fresh`/`audited`: those profiles have no fallback, so dispatching
   * would spend a run to be told there is nothing for it to do. The `closed`
   * webhook's own call to `driveTurnFor` — added to fix the starvation above —
   * bypassed `driveLane` and, with it, that check. This proves the fix: a
   * closed pull request still frees a device-only lane, but no longer pays
   * GitHub Actions to find that out.
   */
  it("frees a device-only lane after the closed webhook, without dispatching Actions for it", async () => {
    const e = env();
    seed(raw);
    raw
      .prepare("UPDATE organizations SET installation_id = ? WHERE id = ?")
      .run("inst_1", org);
    raw
      .prepare(
        // Replace: the environment already seeded this project row so the
        // session has a membership to be checked against.
        "INSERT OR REPLACE INTO projects (id, organization_id, github_repository_id, github_name, enabled, active_policy_digest) VALUES (?, ?, ?, ?, 1, ?)",
      )
      .run("proj_1", org, REPO, "acme/repo", `sha256:${"d".repeat(64)}`);
    raw
      .prepare(
        "INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status) VALUES (?, ?, 1, ?, 'active')",
      )
      .run(`sha256:${"d".repeat(64)}`, "proj_1", JSON.stringify({ schemaVersion: "1", securityProfile: "fresh", version: 1 }));
    const app = routes();
    await authorize(app, e, 59);
    await authorize(app, e, 61);

    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    try {
      const result = await queueFromPullRequest(e as unknown as Env, closedPayload());
      expect(result).toEqual({ handled: true, detail: "entry cancelled" });

      // The lane moved to 61 and 61 is offered, but under `fresh` only a
      // connected device ever claims it — dispatching Actions here would be
      // a wasted run.
      const after = await liveState(app, e);
      expect(stateOf(after, 61)).toBe("Offered");
      const dispatch = fetch.mock.calls.find(([url]) => String(url).includes("/dispatches"));
      expect(dispatch).toBeUndefined();
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("ejecting an entry", () => {
  it("drives whoever gets the turn after an eject", async () => {
    const e = env();
    const driven: number[] = [];
    const app = routes({ driveTurn: async (_e, _r, pr) => void driven.push(pr) });
    await authorize(app, e, 59);
    await authorize(app, e, 60);

    driven.length = 0;
    await app.request(
      `/v1/queue/${REPO}/entries/entry_${REPO}_59?ref=${encodeURIComponent(REF)}`,
      { method: "DELETE" },
      e,
    );

    // The lane moved, so something has to tell the new holder. Nothing did, and
    // the offer expired unclaimed.
    expect(driven).toContain(60);
  });
});

describe("GitHub's read is behind GitHub's own write", () => {
  /**
   * Pull request 105 merged at 16:41:38 on 2026-08-01. The merge run read the
   * pull request 1.5 seconds later, was told it was not merged, and reported a
   * refusal. The queue believed it: the operation resolved CONFIRMED_NOT_MERGED,
   * no transition record was written, and the entry went Deferred while the
   * merge commit sat on main. Three pull requests were lost from the chain this
   * way before anybody noticed, because a chain that stops early is the one
   * break verifyChain cannot see.
   */
  async function heldTurn(app: App, e: QueueRouteEnv) {
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    expect(holder.operationId).not.toBeNull();
    return { operationId: holder.operationId!, attemptId: holder.operationId!.replace("merge_", "") };
  }

  function report(app: App, e: QueueRouteEnv, held: { operationId: string; attemptId: string }) {
    return app.request(
      `/v1/queue/${REPO}/not-merged`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRef: REF,
          attemptId: held.attemptId,
          operationId: held.operationId,
          detail: "405 Merge already in progress",
        }),
      },
      e,
    );
  }

  async function outcomeOf(e: QueueRouteEnv, operationId: string) {
    const { result } = await runOnQueue(e, REPO, REF, ({ store }) => store.mergeOperation(operationId));
    return result?.outcome ?? null;
  }

  it("refuses to record a merge as not-merged when the next read says it merged", async () => {
    const e = env();
    let reads = 0;
    const app = routes({
      pullRequestMergeState: async () => {
        reads += 1;
        return reads === 1
          ? { merged: false, mergeCommitSha: null }
          : { merged: true, mergeCommitSha: "a".repeat(40) };
      },
    });
    const held = await heldTurn(app, e);

    const response = await report(app, e, held);
    expect(response.status).toBe(200);

    // The merge happened. Nothing durable may say otherwise.
    expect(await outcomeOf(e, held.operationId)).not.toBe("CONFIRMED_NOT_MERGED");
    const snapshot = await liveState(app, e);
    expect(stateOf(snapshot, 59)).not.toBe("Deferred");
    expect(stateOf(snapshot, 59)).toBe("Reconciling");
  });

  it("believes git over the pull request when the base already contains the head", async () => {
    const e = env();
    const app = routes({
      pullRequestMergeState: async () => ({ merged: false, mergeCommitSha: null }),
      baseContainsSha: async () => true,
    });
    const held = await heldTurn(app, e);

    await report(app, e, held);

    expect(await outcomeOf(e, held.operationId)).not.toBe("CONFIRMED_NOT_MERGED");
    expect(stateOf(await liveState(app, e), 59)).toBe("Reconciling");
  });

  it("does not conclude anything from a read that failed", async () => {
    const e = env();
    const app = routes({ pullRequestMergeState: async () => null, baseContainsSha: async () => null });
    const held = await heldTurn(app, e);

    await report(app, e, held);

    expect(await outcomeOf(e, held.operationId)).not.toBe("CONFIRMED_NOT_MERGED");
    expect(stateOf(await liveState(app, e), 59)).toBe("Reconciling");
  });

  it("still confirms a refusal every read agrees on", async () => {
    const e = env();
    const app = routes();
    const held = await heldTurn(app, e);

    await report(app, e, held);

    expect(await outcomeOf(e, held.operationId)).toBe("CONFIRMED_NOT_MERGED");
    expect(stateOf(await liveState(app, e), 59)).toBe("Deferred");
  });
});

describe("GitHub refuses the merge", () => {
  it("releases the lane and does not record the pull request as merged", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    expect(holder.operationId).not.toBeNull();

    const refused = await app.request(
      `/v1/queue/${REPO}/not-merged`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRef: REF,
          attemptId: holder.operationId!.replace("merge_", ""),
          operationId: holder.operationId,
          detail: "405 Repository rule violations found",
        }),
      },
      e,
    );
    expect(refused.status).toBe(200);

    // Nothing merged, and the failed turn is over.
    const snapshot = await liveState(app, e);
    expect(stateOf(snapshot, 59)).not.toBe("Merged");
    expect(stateOf(snapshot, 59)).toBe("Deferred");
  });

  it("hands the lane to somebody else rather than back to the pull request that failed", async () => {
    const e = env();
    const app = routes();
    // 59 takes the lane, 61 waits behind it.
    await authorize(app, e, 59);
    await authorize(app, e, 61);
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    const attemptId = holder.operationId!.replace("merge_", "");

    await app.request(
      `/v1/queue/${REPO}/not-merged`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRef: REF, attemptId, operationId: holder.operationId }),
      },
      e,
    );

    // Whatever refused that merge is usually still true a second later, so 59 is
    // deferred and the queue offers the turn to 61 instead of spinning on 59.
    const after = await liveState(app, e);
    expect(stateOf(after, 59)).toBe("Deferred");
    expect(stateOf(after, 61)).toBe("Offered");
  });
});

describe("a losing merge run reports GitHub's refusal", () => {
  /**
   * `not-merged` is the path a losing merge run takes when GitHub refuses its
   * merge, so it fires in normal operation. `mergeOutcomeUnknown` plus
   * `confirmNotMerged` frees the lane exactly like a cancel or a merge does,
   * and nothing was telling the next holder about the offer that followed.
   */
  it("drives whoever gets the turn after not-merged frees the lane", async () => {
    const e = env();
    const driven: number[] = [];
    const app = routes({ driveTurn: async (_e, _r, pr) => void driven.push(pr) });
    await authorize(app, e, 59);
    await authorize(app, e, 61);
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    const attemptId = holder.operationId!.replace("merge_", "");

    driven.length = 0;
    await app.request(
      `/v1/queue/${REPO}/not-merged`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRef: REF, attemptId, operationId: holder.operationId }),
      },
      e,
    );

    // The lane moved to 61, so something has to tell it. Nothing did, and the
    // offer expired unclaimed.
    expect(driven).toContain(61);
  });
});

describe("an operator reconciles a lane that never merged", () => {
  /**
   * Reconciliation ends the held attempt the same way a cancel or a merge
   * does. All three `observed` branches free the lane, so one is enough to
   * prove the route drives the next holder rather than leaving the offer for
   * somebody to notice. `merged-outside-the-turn` needs no prior deadline, so
   * it is the branch that can be reached from a plain held attempt.
   */
  it("drives whoever gets the turn after reconciling merged-outside-the-turn", async () => {
    const e = env();
    const driven: number[] = [];
    const app = routes({ driveTurn: async (_e, _r, pr) => void driven.push(pr) });
    await authorize(app, e, 59);
    await authorize(app, e, 61);

    driven.length = 0;
    const response = await app.request(
      `/v1/queue/${REPO}/reconcile?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          observed: "merged-outside-the-turn",
          reason: "operator found it merged by hand",
          mergeSha: "d".repeat(40),
        }),
      },
      e,
    );
    expect(response.status).toBe(200);

    // The lane moved to 61, so something has to tell it. Nothing did, and the
    // offer expired unclaimed.
    expect(driven).toContain(61);
  });
});

describe("a verifier rejects the candidate", () => {
  /**
   * `queue-result` is the verifier's callback. A rejected verdict terminates
   * the attempt and frees the lane exactly like an eject, a reconcile or a
   * not-merged does, and nothing was telling the next holder about the offer
   * that followed.
   */
  it("drives whoever gets the turn after a rejected verdict frees the lane", async () => {
    const e = env();
    const driven: number[] = [];
    const pinned = {
      repositoryId: REPO,
      repositoryOwnerId: "162603603",
      workflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
      workflowSha: null,
      reusableWorkflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify-impl.yml@refs/heads/main",
      reusableWorkflowSha: null,
      expectedEventName: "repository_dispatch" as const,
      defaultBranchRef: "refs/heads/main",
    };
    const claims = {
      repository_id: REPO,
      repository_owner_id: "162603603",
      workflow_ref: pinned.workflowRef,
      workflow_sha: "5".repeat(40),
      job_workflow_ref: pinned.reusableWorkflowRef,
      job_workflow_sha: "6".repeat(40),
      run_id: "998877",
      run_attempt: "1",
      event_name: "repository_dispatch",
      ref: "refs/heads/main",
      jti: "jti-1",
    };
    const app = routes({
      driveTurn: async (_e, _r, pr) => void driven.push(pr),
      verifyOidc: async () => claims,
      pinnedVerifier: async () => pinned,
    });
    await authorize(app, e, 59);
    await authorize(app, e, 61);

    const held = await liveState(app, e);
    const attemptId = held.activeAttemptId;
    expect(attemptId).not.toBeNull();

    // Walk the attempt to "verification started" through the domain commands
    // directly. This is the path a real runner takes outside the fast-reuse
    // shortcut `authorize` itself exercises, and it is the only way to reach a
    // live nonce a verifier's callback could plausibly answer.
    const { result: nonce } = await runOnQueue(e, REPO, REF, ({ commands }) => {
      commands.candidatePrepared({
        idempotencyKey: "prep",
        attemptId: attemptId!,
        baseSha: "b".repeat(40),
        headSha: String(59).padStart(40, "a"),
        candidateSha: "c".repeat(40),
        candidateTree: TREE,
        policyDigest: `sha256:${"b".repeat(64)}`,
        runner: "dagger",
      });
      commands.submitReceipt({
        idempotencyKey: "receipt",
        attemptId: attemptId!,
        receiptDigest: `sha256:${"d".repeat(64)}`,
      });
      const started = commands.startVerification({ idempotencyKey: "verify", attemptId: attemptId! });
      return "nonce" in started ? started.nonce : undefined;
    });
    expect(nonce).toBeDefined();

    driven.length = 0;
    const response = await app.request(
      "/api/github-actions/queue-result",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryId: REPO,
          baseRef: REF,
          attemptId,
          nonce,
          accepted: false,
          resultDigest: `sha256:${"e".repeat(64)}`,
        }),
      },
      e,
    );
    expect(response.status).toBe(202);

    // The rejection blocks 59 and frees the lane; the queue immediately offers
    // it to 61.
    const after = await liveState(app, e);
    expect(stateOf(after, 59)).toBe("Blocked");
    expect(stateOf(after, 61)).toBe("Offered");

    // The lane moved to 61, so something has to tell it. Nothing did, and the
    // offer expired unclaimed.
    expect(driven).toContain(61);
  });
});

describe("a merge that is not the one the queue authorized", () => {
  it("is refused rather than recorded", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    const attemptId = holder.operationId!.replace("merge_", "");

    // What GitHub holds for the commit this run reports: not the tree the queue
    // pinned for this turn, so something other than the candidate landed.
    landed("9".repeat(40), "0".repeat(40), ["b".repeat(40), "6".repeat(40)]);
    const response = await app.request(
      `/v1/queue/${REPO}/merged`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRef: REF,
          attemptId,
          operationId: holder.operationId,
          mergeSha: "9".repeat(40),
        }),
      },
      e,
    );
    expect(response.status).toBe(409);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "RESULT_NOT_AUTHORIZED" });
    expect(stateOf(await liveState(app, e), 59)).not.toBe("Merged");
  });

  it("accepts the tree it did authorize, and says so once however many times it is told", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    const attemptId = holder.operationId!.replace("merge_", "");
    landed("9".repeat(40), TREE, ["b".repeat(40), String(59).padStart(40, "a")]);
    const body = JSON.stringify({
      baseRef: REF,
      attemptId,
      operationId: holder.operationId,
      mergeSha: "9".repeat(40),
    });
    const post = () =>
      app.request(
        `/v1/queue/${REPO}/merged`,
        { method: "POST", headers: { "content-type": "application/json" }, body },
        e,
      );

    const firstResponse = await post();
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as { transitionDigest: string | null };
    // At-least-once delivery: the workflow can report the same merge twice.
    const secondResponse = await post();
    expect(secondResponse.status).toBe(200);
    const secondBody = (await secondResponse.json()) as { transitionDigest: string | null };

    const snapshot = await liveState(app, e);
    expect(stateOf(snapshot, 59)).toBe("Merged");
    expect(snapshot.activeAttemptId).toBeNull();

    const links = raw
      .prepare("SELECT COUNT(*) AS c FROM queue_transitions_index WHERE github_repository_id = ?")
      .get(REPO) as { c: number };
    // One merge is one link, however many times it was reported.
    expect(links.c).toBe(1);

    // The stronger property: one merge signs one record. Two racing reports of
    // the same merge used to each sign a fresh record — a new observedAt made a
    // new digest every time — so the chain carried two links claiming sequence
    // 47. Every report of this merge must resolve to the same signed row.
    expect(secondBody.transitionDigest).toBe(firstBody.transitionDigest);
    const attestations = raw
      .prepare(
        "SELECT COUNT(*) AS c FROM queue_attestations WHERE attempt_id = ? AND transition_sequence IS NOT NULL",
      )
      .get(attemptId) as { c: number };
    expect(attestations.c).toBe(1);
  });
});

/**
 * Who describes the commit that landed.
 *
 * The merge workflow runs in Actions and used to hand the queue the merged
 * commit's tree and its parents, and those numbers went straight into a signed
 * record. GitHub holds the commit, so GitHub answers for it, and a report the
 * queue cannot check against GitHub is refused instead of written down.
 */
describe("the merge report", () => {
  const BASE = "b".repeat(40);
  const MERGE = "9".repeat(40);
  const HEAD59 = String(59).padStart(40, "a");

  /** GitHub's answer for the merge commit; anything else keeps the default. */
  function facts(over: { merged: { treeOid: string; parentShas: string[] } | null }) {
    return async (_e: unknown, _r: string, sha: string) =>
      sha === MERGE ? over.merged : { treeOid: TREE, parentShas: [BASE, "6".repeat(40)], message: PROVEN };
  }

  async function report(app: App, e: QueueRouteEnv, body: Record<string, unknown>) {
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: BASE,
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: [BASE, "6".repeat(40)],
      },
    });
    return app.request(
      `/v1/queue/${REPO}/merged`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRef: REF,
          attemptId: holder.operationId!.replace("merge_", ""),
          operationId: holder.operationId,
          mergeSha: MERGE,
          ...body,
        }),
      },
      e,
    );
  }

  it("records the tree and parents GitHub gives, not the ones its caller sent", async () => {
    const e = env();
    const app = routes({ commitFacts: facts({ merged: { treeOid: TREE, parentShas: [BASE, HEAD59] } }) });

    const response = await report(app, e, {
      // A caller inventing both halves of what the record will certify.
      mergeTree: "0".repeat(40),
      parentShas: ["f".repeat(40), "e".repeat(40)],
    });
    expect(response.status).toBe(200);
    const merged = (await response.json()) as { transition: string; transitionDigest: string | null };
    expect(merged.transition).toBe("applied");

    const stored = await app.request(`/v1/queue/records/${merged.transitionDigest}`, {}, e);
    const found = (await stored.json()) as {
      record: { after: { treeOid: string; parentOids: string[] } };
    };
    expect(found.record.after.treeOid).toBe(TREE);
    expect(found.record.after.parentOids).toEqual([BASE, HEAD59]);
  });

  it("refuses a merge GitHub will not describe", async () => {
    const e = env();
    const app = routes({ commitFacts: facts({ merged: null }) });

    const response = await report(app, e, {
      mergeTree: TREE,
      parentShas: [BASE, HEAD59],
    });
    expect(response.status).toBe(404);
    expect(stateOf(await liveState(app, e), 59)).not.toBe("Merged");
    const links = raw
      .prepare("SELECT COUNT(*) AS c FROM queue_transitions_index WHERE github_repository_id = ?")
      .get(REPO) as { c: number };
    expect(links.c).toBe(0);
  });
});

/**
 * What a chain link actually is now.
 *
 * A link used to be the merge commit id padded out to sixty-four characters: a
 * value shaped like a digest that was the digest of nothing. The product's claim
 * is that a reader can check what was verified before a merge landed, and that
 * claim had nothing behind it. These pin the replacement.
 */
describe("the record behind a merge", () => {
  async function mergeOne(app: App, e: QueueRouteEnv, pr: number) {
    const holder = await authorize(app, e, pr, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    landed("9".repeat(40), TREE, ["b".repeat(40), String(pr).padStart(40, "a")]);
    const response = await app.request(
      `/v1/queue/${REPO}/merged`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRef: REF,
          attemptId: holder.operationId!.replace("merge_", ""),
          operationId: holder.operationId,
          mergeSha: "9".repeat(40),
        }),
      },
      e,
    );
    return (await response.json()) as { transition: string; transitionDigest: string | null; detail?: string };
  }

  it("is the digest of a record, not the merge commit dressed up as one", async () => {
    const e = env();
    const app = routes();
    const merged = await mergeOne(app, e, 59);

    expect(merged.transition).toBe("applied");
    expect(merged.transitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The old link was the merge sha padded with zeroes. Nothing should ever
    // produce that again.
    expect(merged.transitionDigest).not.toBe(`sha256:${"9".repeat(40)}${"0".repeat(24)}`);
  });

  it("can be read back and says what the merge rested on", async () => {
    const e = env();
    const app = routes();
    const merged = await mergeOne(app, e, 59);

    const response = await app.request(`/v1/queue/records/${merged.transitionDigest}`, {}, e);
    expect(response.status).toBe(200);
    const found = (await response.json()) as {
      kind: string;
      jws: string;
      record: { kind: string; reusedProof: Record<string, unknown> };
    };
    expect(found.kind).toBe("reused-proof-merge");
    expect(found.jws).not.toBe("");
    // The developer's own proof, by its digest, is what the merge cites.
    expect(found.record.reusedProof["workReceiptDigest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(found.record.reusedProof["checkRunId"]).toBe("778899");
    // And nothing it could not have known.
    expect(found.record.reusedProof).not.toHaveProperty("verifierResultDigest");
    expect(found.record.reusedProof).not.toHaveProperty("assignmentDigest");
  });

  it("is nothing for a digest the queue never signed", async () => {
    const e = env();
    const response = await routes().request(`/v1/queue/records/sha256:${"0".repeat(64)}`, {}, e);
    expect(response.status).toBe(404);
  });

  /**
   * A queue with no policy has nothing to certify against, so it can build no
   * record. Refusing is the point: the alternative is a merge whose record names
   * a policy that does not exist.
   */
  it("refuses to prepare a merge for a repository with no active policy", async () => {
    const e = env();
    const app = routes({ activePolicy: async () => null });
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    expect(holder.authorized).toBe(false);
    expect(holder.reason).toBe("MERGE_EVIDENCE_INCOMPLETE");
    expect(holder.operationId).toBeNull();
  });

  /**
   * A repository adds a required suite. The proof on the head was signed before
   * that, so it never ran the new suite, and its check is still green because
   * nothing re-verified the head. Stamping the new policy's digests over it
   * would sign a binding the proof does not carry.
   */
  it("refuses a reuse whose proof predates a required suite the policy now names", async () => {
    const e = env();
    const app = routes({
      activePolicy: async () => ({
        policyDigest: `sha256:${"d".repeat(64)}`,
        pipelineDigest: `sha256:${"e".repeat(64)}`,
        requiredSuites: ["unit", "integration"],
        securityProfile: "fast",
        organizationId: "org_1",
        verifier: null,
      }),
      // Signed under the policy that required "unit" alone.
      commitFacts: async () => ({
        treeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
        message: PROVEN,
      }),
    });
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    expect(holder.authorized).toBe(false);
    expect(holder.reason).toBe("POLICY_CHANGED");
    expect(holder.operationId).toBeNull();
  });

  /**
   * The mirror, and the reason the policy's own digest is not compared here.
   *
   * Editing anything in a policy changes its digest, including settings a proof
   * cannot fail: the minimum permission, the allowed key algorithms, the lease
   * rules. Refusing on identity made a cosmetic edit invalidate every proof in
   * flight, and the App carried a twenty-four hour list of retired digests to
   * hide that. The list is gone. A proof is good while it satisfies what the
   * policy requires, so the same pipeline and the same suites still merge under
   * a policy whose digest has moved.
   */
  it("allows a reuse under a policy edit that changed no requirement", async () => {
    const e = env();
    const app = routes({
      activePolicy: async () => ({
        // A different policy digest, same pipeline, same required suites.
        policyDigest: `sha256:${"d".repeat(64)}`,
        pipelineDigest: `sha256:${"c".repeat(64)}`,
        requiredSuites: ["unit"],
        securityProfile: "fast",
        organizationId: "org_1",
        verifier: null,
      }),
      commitFacts: async () => ({
        treeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
        message: PROVEN,
      }),
    });
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    expect(holder.reason).not.toBe("POLICY_CHANGED");
  });

  /** The same, where the proof check cannot be found for the head. */
  it("refuses when no passing proof check can be found for the head", async () => {
    const e = env();
    const app = routes({ proofCheckRunId: async () => null });
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    expect(holder.authorized).toBe(false);
    expect(holder.reason).toBe("MERGE_EVIDENCE_INCOMPLETE");
  });

  /**
   * `mergeOne` always merged with two parents, the shape a "merge" record
   * demands. This exercises the method a queue project actually names,
   * squash included, so a single-parent landing is not something only the
   * default case gets to happen for.
   */
  async function mergeOneAs(app: App, e: QueueRouteEnv, pr: number, parentShas: readonly string[]) {
    const holder = await authorize(app, e, pr, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: [...parentShas],
      },
    });
    landed("9".repeat(40), TREE, parentShas);
    const response = await app.request(
      `/v1/queue/${REPO}/merged`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRef: REF,
          attemptId: holder.operationId!.replace("merge_", ""),
          operationId: holder.operationId,
          mergeSha: "9".repeat(40),
        }),
      },
      e,
    );
    return (await response.json()) as { transition: string; transitionDigest: string | null; detail?: string };
  }

  /**
   * The defect this whole change exists to close. `attestation.ts` used to
   * hardcode `mergeMethod: "merge"` no matter what a repository's queue
   * project actually named. A squash-configured repository's landed commit
   * has one parent; the hardcoded record demanded two; `checkMergeConsistency`
   * refused it; `recordMergedTransition` took its `skip(...)` path; and the
   * merge — which really landed — never advanced the chain. Nothing failed
   * loudly: the endpoint still answered 200, and the next merge silently
   * reused the same sequence number. This is the failure mode: before the
   * fix, `merged.transition` here is `"skipped"`, not `"applied"`.
   */
  it("still writes a chain link for a squash-configured repository, rather than silently skipping it", async () => {
    const e = env();
    const app = routes({
      queueProject: async () => ({ activationState: "enforced", mergeMethod: "squash" }),
    });
    const merged = await mergeOneAs(app, e, 59, ["b".repeat(40)]);

    expect(merged.transition).toBe("applied");
    expect(merged.transitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const links = raw
      .prepare("SELECT COUNT(*) AS c FROM queue_transitions_index WHERE github_repository_id = ?")
      .get(REPO) as { c: number };
    expect(links.c).toBe(1);

    const response = await app.request(`/v1/queue/records/${merged.transitionDigest}`, {}, e);
    expect(response.status).toBe(200);
    const found = (await response.json()) as { kind: string };
    expect(found.kind).toBe("reused-proof-merge");
  });

  /** The other side of the same binding: a merge-configured repository is unaffected. */
  it("still merges with two parents for a merge-configured repository, exactly as before", async () => {
    const e = env();
    const app = routes({
      queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
    });
    // The second parent of a two-parent merge must be the pull request head,
    // which `authorize` pins to `String(pr).padStart(40, "a")`.
    const merged = await mergeOneAs(app, e, 59, ["b".repeat(40), String(59).padStart(40, "a")]);

    expect(merged.transition).toBe("applied");
    expect(merged.transitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  /**
   * Where the merge went, not just what shape it is.
   *
   * Four merges in this repository's history landed on a base nobody checked,
   * and the parent vector is what tells the two apart: a commit with the right
   * tree and the wrong first parent is a merge onto a branch the queue never
   * assigned. The count alone would pass it. So both parents are matched by
   * identity against the base and the head this attempt was assigned, and a
   * report that fails either signs nothing and takes no chain position.
   */
  async function reportParents(app: App, e: QueueRouteEnv, pr: number, parentShas: readonly string[]) {
    const holder = await authorize(app, e, pr, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), String(pr).padStart(40, "a")],
      },
    });
    landed("9".repeat(40), TREE, parentShas);
    const response = await app.request(
      `/v1/queue/${REPO}/merged`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRef: REF,
          attemptId: holder.operationId!.replace("merge_", ""),
          operationId: holder.operationId,
          mergeSha: "9".repeat(40),
        }),
      },
      e,
    );
    return (await response.json()) as {
      transition?: string;
      transitionDigest?: string | null;
      detail?: string;
      code?: string;
      error?: string;
    };
  }

  function linkCount(): number {
    return (
      raw.prepare("SELECT COUNT(*) AS c FROM queue_transitions_index WHERE github_repository_id = ?").get(REPO) as {
        c: number;
      }
    ).c;
  }

  it("signs no record for a merge whose first parent is not the assigned base", async () => {
    const e = env();
    const app = routes();

    // Two parents and the authorized tree, so every shape check passes. It sits
    // on a commit this attempt was never assigned, which the queue refuses to
    // confirm as its own merge: an intent binds the parents as well as the
    // tree, so nothing signed could ever name this commit.
    const merged = await reportParents(app, e, 59, ["d".repeat(40), String(59).padStart(40, "a")]);

    expect(merged.code).toBe("RESULT_NOT_AUTHORIZED");
    expect(merged.error).toMatch(/first parent/i);
    expect(linkCount()).toBe(0);
  });

  it("signs no record for a merge whose second parent is not the assigned head", async () => {
    const e = env();
    const app = routes();

    const merged = await reportParents(app, e, 59, ["b".repeat(40), "d".repeat(40)]);

    expect(merged.transition).toBe("skipped");
    expect(merged.transitionDigest).toBeNull();
    expect(linkCount()).toBe(0);
  });

  it("signs no record for a squash whose parent is not the assigned base", async () => {
    const e = env();
    const app = routes({ queueProject: async () => ({ activationState: "enforced", mergeMethod: "squash" }) });

    const merged = await reportParents(app, e, 59, ["d".repeat(40)]);

    expect(merged.code).toBe("RESULT_NOT_AUTHORIZED");
    expect(merged.error).toMatch(/first parent/i);
    expect(linkCount()).toBe(0);
  });
});

/**
 * The base branch moving underneath a turn.
 *
 * This used to be asserted by calling the pause endpoint, which proved that
 * pausing pauses and said nothing about whether anything notices a branch that
 * moved. Nothing did: the reducer, the invariant and the command all existed
 * with no caller. So this drives the detector the webhook actually uses.
 */
describe("the base branch moves underneath a turn", () => {
  const pushed = (over: Record<string, unknown> = {}) => ({
    ref: REF,
    after: "e".repeat(40),
    deleted: false,
    repository: { id: Number(REPO), default_branch: "main" },
    head_commit: { id: "e".repeat(40), message: "merged by hand, around the queue", ...(over["head_commit"] as object ?? {}) },
    ...over,
  });

  it("is seen for a push the queue did not make", () => {
    expect(externalPushFromWebhook("push", pushed())).toEqual({
      repositoryId: REPO,
      baseRef: REF,
      observedBaseSha: "e".repeat(40),
    });
  });

  it("is not seen for the queue's own merge", () => {
    const own = pushed({
      head_commit: {
        id: "e".repeat(40),
        message: `Merge pull request #1 (Thwip Queue)\n\n${QUEUE_MERGE_TRAILER}: merge_att_1\n`,
      },
    });
    expect(externalPushFromWebhook("push", own)).toBeNull();
  });

  it("stops the queue authorizing anybody once it has been told", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59);
    await authorize(app, e, 61);
    expect(holder.reason).toBe("HOLDS_TURN");

    // What the webhook does with what the detector returned.
    await app.request(
      `/v1/queue/${REPO}/pause?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "the base moved outside the queue" }),
      },
      e,
    );

    expect((await authorize(app, e, 59)).authorized).toBe(false);
    expect((await authorize(app, e, 61)).authorized).toBe(false);
    expect((await liveState(app, e)).paused).toBe(true);
  });

  it("runs again once an operator resumes it", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    await app.request(
      `/v1/queue/${REPO}/pause?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "looking into something" }),
      },
      e,
    );
    const resumed = await app.request(
      `/v1/queue/${REPO}/resume?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    expect(resumed.status).toBe(200);
    expect((await liveState(app, e)).paused).toBe(false);
    expect((await authorize(app, e, 59)).reason).toBe("HOLDS_TURN");
  });
});

describe("the queue keeps its footing over a long run", () => {
  /**
   * Compaction drops history the queue can no longer reach a decision through.
   * The thing to prove is that a queue which has merged a great deal still gives
   * the same answers, and that its document has stopped growing.
   */
  it("still holds one lane after many merges, with a bounded document", async () => {
    const e = env();
    // A candidate per pull request, so each merge lands its own tree.
    const app = routes({
      integratedCandidate: async (_e, _r, _ref, pr) => ({
        status: "pinned",
        baseSha: "b".repeat(40),
        headSha: String(pr).padStart(40, "a"),
        candidateSha: String(pr).padStart(40, "c"),
        candidateTreeOid: String(pr).padStart(40, "7"),
      }),
    });

    for (let pr = 100; pr < 140; pr += 1) {
      const holder = await authorize(app, e, pr, { prepare: true });
      if (holder.operationId === null) continue;
      landed(String(pr).padStart(40, "9"), String(pr).padStart(40, "7"), [
        "b".repeat(40),
        String(pr).padStart(40, "a"),
      ]);
      await app.request(
        `/v1/queue/${REPO}/merged`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRef: REF,
            attemptId: holder.operationId.replace("merge_", ""),
            operationId: holder.operationId,
            mergeSha: String(pr).padStart(40, "9"),
          }),
        },
        e,
      );
    }

    const row = raw
      .prepare("SELECT document FROM queue_state WHERE github_repository_id = ?")
      .get(REPO) as { document: string };
    const document = JSON.parse(row.document) as {
      state: { entries: unknown[]; attempts: unknown[]; transitions: unknown[] };
    };

    // Bounded by the compaction window rather than by how much has merged.
    expect(document.state.transitions.length).toBeLessThanOrEqual(20);
    expect(document.state.entries.length).toBeLessThanOrEqual(25);
    expect(document.state.attempts.length).toBeLessThanOrEqual(25);

    // The full history is still in the projection, which is what a reader uses.
    const links = raw
      .prepare("SELECT COUNT(*) AS c FROM queue_transitions_index WHERE github_repository_id = ?")
      .get(REPO) as { c: number };
    expect(links.c).toBeGreaterThan(20);

    // And it still behaves: one lane, to one pull request.
    const verdicts = await Promise.all([200, 201, 202].map((pr) => authorize(app, e, pr)));
    expect(verdicts.filter((v) => v.reason === "HOLDS_TURN")).toHaveLength(1);
  });
});

describe("the check that says whose turn it is", () => {
  it("goes green for the holder and stays running for everyone else", async () => {
    const e = env();
    const app = routes();

    const first = await authorize(app, e, 59);
    await authorize(app, e, 61);
    await authorize(app, e, 65);

    const holder = published.filter((u) => u.state === "holds");
    expect(holder).toHaveLength(1);
    expect(`entry_${REPO}_${holder[0]!.pullRequestNumber}`).toBe(first.entryId);
    // Nobody is told they failed for waiting, which is what used to leave a red
    // check that went on refusing the merge after the queue said yes.
    expect(published.filter((u) => u.state === "waiting").length).toBeGreaterThan(0);
  });

  it("follows the lane when it moves, without a workflow re-run", async () => {
    const e = env();
    const app = routes();
    const first = await authorize(app, e, 59);
    await authorize(app, e, 61);
    published.length = 0;

    await app.request(
      `/v1/queue/${REPO}/entries/${first.entryId}?ref=${encodeURIComponent(REF)}&reason=closed`,
      { method: "DELETE" },
      e,
    );

    // The lane moved to 61 and its check was published by the queue itself.
    expect(published.filter((u) => u.state === "holds").map((u) => u.pullRequestNumber)).toEqual([61]);
  });

  it("tells everyone the queue has halted", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    await authorize(app, e, 61);
    published.length = 0;

    await app.request(
      `/v1/queue/${REPO}/pause?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "the base moved outside the queue" }),
      },
      e,
    );

    expect(published.length).toBeGreaterThan(0);
    expect(published.every((u) => u.state === "halted")).toBe(true);
  });

  it("says nothing when nothing moved, rather than one call per entry per ask", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    await authorize(app, e, 61);
    published.length = 0;

    await authorize(app, e, 61);
    await authorize(app, e, 61);
    expect(published).toEqual([]);
  });

  /**
   * This check is required, so a pull request that gets none can never merge and
   * has nothing on the page saying why. The queue publishes a failure instead,
   * because an author with no activated principal is a real problem that will not
   * resolve on its own.
   */
  it("says so when it cannot place a pull request at all", async () => {
    const e = env();
    const app = routes({ principalFor: async () => null });
    await authorize(app, e, 59);
    expect(published.map((u) => u.state)).toContain("unplaceable");
  });

  /**
   * Joining the queue is keyed by the entry, so a pull request already in it kept
   * whatever commit it joined with. The turn check is published against that
   * commit, so a stale one puts the check on an old commit and leaves the current
   * head without one — and a required check that never arrives blocks the merge
   * forever.
   */
  it("follows a pull request to its new commit when it is pushed to", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    published.length = 0;

    const moved = "f".repeat(40);
    await authorize(app, e, 59, { headSha: moved });

    expect(published.map((u) => u.headSha)).toContain(moved);
    const snapshot = await liveState(app, e);
    expect(snapshot.entries.find((entry) => entry.pullRequestNumber === 59)).toBeDefined();
  });

  it("keeps the queue working when publishing fails", async () => {
    const e = env();
    const app = routes({
      publishTurnCheck: async () => {
        throw new Error("GitHub is having a moment");
      },
    });
    expect((await authorize(app, e, 59)).reason).toBe("HOLDS_TURN");
    expect((await authorize(app, e, 61)).reason).toBe("WAITING_FOR_TURN");
  });
});

/**
 * The merge record has to cite the proof the developer signed. Binding a
 * constant there, which is what this did, made every downstream claim about
 * "what was checked" empty — so a head with no readable proof stops the merge
 * rather than falling back to one.
 */
describe("the work receipt behind a merge", () => {
  const candidate = {
    baseSha: "b".repeat(40),
    candidateSha: "c".repeat(40),
    candidateTreeOid: TREE,
    parentShas: ["b".repeat(40), "6".repeat(40)],
  };

  it("prepares the merge when the head carries a readable proof", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59, { prepare: true, candidate });
    expect(holder.operationId).not.toBeNull();
  });

  it("refuses to prepare a merge for a head with no proof", async () => {
    const e = env();
    const app = routes({
      commitFacts: async () => ({ treeOid: TREE, parentShas: ["b".repeat(40), "6".repeat(40)], message: "no proof here" }),
    });
    const holder = await authorize(app, e, 59, { prepare: true, candidate });
    expect(holder).toMatchObject({ authorized: false, reason: "WORK_RECEIPT_UNREADABLE" });
    expect(holder.operationId).toBeNull();
  });

  it("refuses when the proof cannot be read, rather than citing a placeholder", async () => {
    const e = env();
    const app = routes({
      commitFacts: async () => ({
        treeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
        message: "x\n\nthwip-proof: v1.not-base64\n",
      }),
    });
    expect(await authorize(app, e, 59, { prepare: true, candidate })).toMatchObject({
      authorized: false,
      reason: "WORK_RECEIPT_UNREADABLE",
    });
  });

  it("refuses when the commit cannot be read at all", async () => {
    const e = env();
    const app = routes({ commitFacts: async () => null });
    expect(await authorize(app, e, 59, { prepare: true, candidate })).toMatchObject({
      authorized: false,
      reason: "WORK_RECEIPT_UNREADABLE",
    });
  });
});

/** A policy bundle naming `securityProfile`, with the other fields `driveLane` needs. */
function policyNamed(securityProfile: string) {
  return async () => ({
    policyDigest: `sha256:${"b".repeat(64)}`,
    pipelineDigest: `sha256:${"c".repeat(64)}`,
    requiredSuites: ["unit"],
    securityProfile,
    organizationId: "org_1",
    verifier: null,
  });
}

describe("nudging a held lane", () => {
  /**
   * Same family as the tick loop's own `driveLane` guard (scheduled-tick.test.ts):
   * `/nudge` called `deps.driveTurn` directly, bypassing the check that keeps
   * Actions out of a lane a connected device already claimed over its heartbeat.
   */
  it("does not dispatch Actions for a lane held under a device-only profile", async () => {
    const e = env();
    const driven: number[] = [];
    const app = routes({
      driveTurn: async (_e, _r, pr) => void driven.push(pr),
      activePolicy: policyNamed("fresh"),
      // `principalFor` maps pull request 59's author to "principal_59"; that is
      // the principal that has to be connected for a device-only entry to be
      // scheduler-eligible at all.
      authenticate: async () => ({ ok: true, principalId: "principal_59", githubUserId: "59", isAdmin: true }),
    });
    seedMembership("principal_59", "59");
    await heartbeat(app, e);
    await authorize(app, e, 59);

    const response = await app.request(
      `/v1/queue/${REPO}/nudge?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ nudged: false, reason: "DEVICE_ONLY", pullRequestNumber: 59 });
    expect(driven).toEqual([]);
  });

  it("still dispatches Actions for a lane held under a profile that needs it", async () => {
    const e = env();
    const driven: number[] = [];
    const app = routes({
      driveTurn: async (_e, _r, pr) => void driven.push(pr),
      activePolicy: policyNamed("fast"),
    });
    await authorize(app, e, 59);

    // `authorize` itself already drove the fresh offer once; only the nudge
    // under test is under scrutiny here.
    driven.length = 0;
    const response = await app.request(
      `/v1/queue/${REPO}/nudge?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ nudged: true, pullRequestNumber: 59 });
    expect(driven).toEqual([59]);
  });
});

describe("an accepted candidate verdict", () => {
  const pinned = {
    repositoryId: REPO,
    repositoryOwnerId: "162603603",
    workflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
    workflowSha: null,
    reusableWorkflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify-impl.yml@refs/heads/main",
    reusableWorkflowSha: null,
    expectedEventName: "repository_dispatch" as const,
    defaultBranchRef: "refs/heads/main",
  };
  const claims = {
    repository_id: REPO,
    repository_owner_id: "162603603",
    workflow_ref: pinned.workflowRef,
    workflow_sha: "5".repeat(40),
    job_workflow_ref: pinned.reusableWorkflowRef,
    job_workflow_sha: "6".repeat(40),
    run_id: "998877",
    run_attempt: "1",
    event_name: "repository_dispatch",
    ref: "refs/heads/main",
    jti: "jti-1",
  };

  function postVerdict(app: App, e: QueueRouteEnv, pr: number) {
    return app.request(
      `/v1/queue/${REPO}/candidate-result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRef: REF,
          pullRequestNumber: pr,
          candidateSha: "c".repeat(40),
          candidateTreeOid: TREE,
          baseSha: "b".repeat(40),
          accepted: true,
          suites: [{ name: "unit", outcome: "passed", durationMs: 100 }],
        }),
      },
      e,
    );
  }

  /**
   * A pinned verifier runs on Actions to check the integrated candidate under
   * every profile that requires one — `fresh` and `audited` included, since a
   * developer's own machine cannot attest to the merge tree itself. What must
   * not happen under those profiles is the *second* dispatch this callback used
   * to fire directly through `deps.driveTurn`, pushing the merge turn through
   * Actions for a lane the connected device already claimed over its heartbeat.
   */
  it("does not dispatch Actions for a lane held under a device-only profile", async () => {
    const e = env();
    const driven: number[] = [];
    const app = routes({
      driveTurn: async (_e, _r, pr) => void driven.push(pr),
      verifyOidc: async () => claims,
      pinnedVerifier: async () => pinned,
      activePolicy: policyNamed("fresh"),
      // `principalFor` maps pull request 59's author to "principal_59"; that is
      // the principal that has to be connected for a device-only entry to be
      // scheduler-eligible at all.
      authenticate: async () => ({ ok: true, principalId: "principal_59", githubUserId: "59", isAdmin: true }),
    });
    seedMembership("principal_59", "59");
    await heartbeat(app, e);
    await authorize(app, e, 59);

    const response = await postVerdict(app, e, 59);
    expect(response.status).toBe(202);
    expect(driven).toEqual([]);
  });

  it("still dispatches Actions for a lane held under a profile that needs it", async () => {
    const e = env();
    const driven: number[] = [];
    const app = routes({
      driveTurn: async (_e, _r, pr) => void driven.push(pr),
      verifyOidc: async () => claims,
      pinnedVerifier: async () => pinned,
      activePolicy: policyNamed("fast"),
    });
    await authorize(app, e, 59);

    // `authorize` itself already drove the fresh offer once; only the verdict
    // callback under test is under scrutiny here.
    driven.length = 0;
    const response = await postVerdict(app, e, 59);
    expect(response.status).toBe(202);
    expect(driven).toEqual([59]);
  });
});

/**
 * The commit a record says the base branch became.
 *
 * Pull request 107 merged as 0b207610. Chain record 54 says main became
 * ff6ea882, the test merge GitHub computes for an open pull request: same
 * parents, same tree, different commit, on no branch. Every consistency check
 * the queue had compares trees and parents, so all of them passed, and the
 * chain carried a base state that never existed until the next record began
 * somewhere else and the verifier found a discontinuity nothing could close.
 *
 * A record asserting a base state is a claim GitHub can be asked about. These
 * make it ask.
 */
describe("the sha a record says the base branch became", () => {
  const BASE = "a5f50bacb82ee5fc16de2efc73d320c7deff30fe";
  const HEAD = "8089c282d8d486af6e3b0465f7d2e0c6a4bde28b";
  /** What main actually became. */
  const LANDED = "0b2076107aa20f8b365d3b510de4838b05d12622";
  /** GitHub's test merge for the open pull request. An ancestor of nothing. */
  const CANDIDATE = "ff6ea882feefd64c4e9f4dff909209e7adb281e3";
  const MERGED_TREE = "febb37430f3fd96c8b11e1b0f60ec0697b9f7cb6";

  /** Only the commit that is on main. The candidate is on no branch. */
  const onMain = async (_e: QueueRouteEnv, _r: string, _ref: string, sha: string) => sha === LANDED;

  /** What GitHub reports for this pull request, which is what the queue pins. */
  const integrated = async () => ({
    status: "pinned" as const,
    baseSha: BASE,
    headSha: HEAD,
    candidateSha: CANDIDATE,
    candidateTreeOid: MERGED_TREE,
  });

  /**
   * The head carries the proof; the two merge commits carry the merged tree
   * over the base and the head. Both commits describe identically, which is the
   * whole difficulty: only the branch tells them apart.
   */
  const facts = async (_e: QueueRouteEnv, _r: string, sha: string) =>
    sha === LANDED || sha === CANDIDATE
      ? { treeOid: MERGED_TREE, parentShas: [BASE, HEAD] }
      : { treeOid: TREE, parentShas: [], message: PROVEN };

  async function report(app: App, e: QueueRouteEnv, mergeSha: string) {
    const holder = await authorize(app, e, 107, { headSha: HEAD, prepare: true });
    const response = await app.request(
      `/v1/queue/${REPO}/merged`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRef: REF,
          attemptId: holder.operationId!.replace("merge_", ""),
          operationId: holder.operationId,
          mergeSha,
        }),
      },
      e,
    );
    return (await response.json()) as { transition: string; transitionDigest: string | null; detail?: string };
  }

  function links(): number {
    return (
      raw
        .prepare("SELECT COUNT(*) AS c FROM queue_transitions_index WHERE github_repository_id = ?")
        .get(REPO) as { c: number }
    ).c;
  }

  it("refuses to sign a record for a commit the base branch does not contain", async () => {
    const e = env();
    const app = routes({
      baseContainsSha: onMain,
      integratedCandidate: integrated,
      commitFacts: facts,
    });

    const reported = await report(app, e, CANDIDATE);

    expect(reported.transitionDigest).toBeNull();
    expect(reported.detail).toMatch(/does not contain/);
    expect(links()).toBe(0);
  });

  it("signs the record for the commit that is on the base branch", async () => {
    const e = env();
    const app = routes({
      baseContainsSha: onMain,
      integratedCandidate: integrated,
      commitFacts: facts,
    });

    const reported = await report(app, e, LANDED);

    expect(reported.transition).toBe("applied");
    expect(reported.transitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(links()).toBe(1);
  });

  it("does not sign when GitHub cannot be asked, rather than signing an unchecked claim", async () => {
    const e = env();
    const app = routes({
      baseContainsSha: async () => null,
      integratedCandidate: integrated,
      commitFacts: facts,
    });

    const reported = await report(app, e, LANDED);

    expect(reported.transitionDigest).toBeNull();
    expect(reported.detail).toMatch(/could not be asked/);
    expect(links()).toBe(0);
  });
});

/**
 * What the answer tells the workflow to merge.
 *
 * The workflow used to compute the base for itself and hand GitHub an expected
 * head and nothing else, so the merge landed on whatever the branch was at that
 * instant. Pull requests 114, 117 and 119 landed on bases their intents never
 * named, with trees nobody had run.
 *
 * The queue signs the intent, so the queue is what names the base. The answer
 * carries the same triple the intent binds, and the workflow merges that or
 * merges nothing.
 */
describe("the base the queue authorizes a merge onto", () => {
  it("names the base, head and tree the intent bound", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });

    expect(holder.operationId).not.toBeNull();
    expect(holder.merge).toEqual({
      baseRef: REF,
      baseSha: "b".repeat(40),
      headSha: String(59).padStart(40, "a"),
      treeOid: TREE,
      // A merge commit's second parent is the pull request head.
      parentShas: ["b".repeat(40), String(59).padStart(40, "a")],
    });
  });

  it("names nothing to merge for a pull request that does not hold the lane", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    const waiting = await authorize(app, e, 61);
    expect(waiting.operationId).toBeNull();
    expect(waiting.merge ?? null).toBeNull();
  });
});
