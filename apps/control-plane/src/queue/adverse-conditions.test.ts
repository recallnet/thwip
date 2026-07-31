import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import type { TurnCheckUpdate } from "./turn-check.js";
import { externalPushFromWebhook, QUEUE_MERGE_TRAILER } from "./external-push.js";

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
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "t".repeat(40);

const published: TurnCheckUpdate[] = [];

function routes(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  published.length = 0;
  return queueRoutes({
    publishTurnCheck: async (_e, _r, update) => {
      published.push(update);
    },
    authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: true }),
    verifyOidc: async () => ({ repository_id: REPO }),
    pinnedVerifier: async () => null,
    activePolicy: async () => null,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced" }),
    principalFor: async (_e, githubUserId) => `principal_${githubUserId}`,
    driveTurn: async () => {},
    commitFacts: async () => ({ treeOid: TREE, parentShas: ["p".repeat(40)] }),
    ...over,
  });
}

interface Verdict {
  authorized: boolean;
  reason: string;
  entryId: string;
  operationId: string | null;
}

type App = ReturnType<typeof routes>;

async function authorize(app: App, e: QueueRouteEnv, pr: number, over: Record<string, unknown> = {}) {
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
        proofAccepted: true,
        draft: false,
        ...over,
      }),
    },
    e,
  );
  return (await response.json()) as Verdict;
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
        parentShas: ["p".repeat(40)],
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
        parentShas: ["p".repeat(40)],
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
        parentShas: ["p".repeat(40)],
      },
    });
    const attemptId = holder.operationId!.replace("merge_", "");

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
          // Not the tree the queue pinned for this turn.
          mergeTree: "0".repeat(40),
          parentShas: ["p".repeat(40)],
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
        parentShas: ["p".repeat(40)],
      },
    });
    const attemptId = holder.operationId!.replace("merge_", "");
    const body = JSON.stringify({
      baseRef: REF,
      attemptId,
      operationId: holder.operationId,
      mergeSha: "9".repeat(40),
      mergeTree: TREE,
      parentShas: ["p".repeat(40)],
    });
    const post = () =>
      app.request(
        `/v1/queue/${REPO}/merged`,
        { method: "POST", headers: { "content-type": "application/json" }, body },
        e,
      );

    expect((await post()).status).toBe(200);
    // At-least-once delivery: the workflow can report the same merge twice.
    expect((await post()).status).toBe(200);

    const snapshot = await liveState(app, e);
    expect(stateOf(snapshot, 59)).toBe("Merged");
    expect(snapshot.activeAttemptId).toBeNull();

    const links = raw
      .prepare("SELECT COUNT(*) AS c FROM queue_transitions_index WHERE github_repository_id = ?")
      .get(REPO) as { c: number };
    // One merge is one link, however many times it was reported.
    expect(links.c).toBe(1);
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
    const app = routes();

    for (let pr = 100; pr < 140; pr += 1) {
      const holder = await authorize(app, e, pr, {
        prepare: true,
        candidate: {
          baseSha: "b".repeat(40),
          candidateSha: String(pr).padStart(40, "c"),
          candidateTreeOid: String(pr).padStart(40, "t"),
          parentShas: ["p".repeat(40)],
        },
      });
      if (holder.operationId === null) continue;
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
            mergeTree: String(pr).padStart(40, "t"),
            parentShas: ["p".repeat(40)],
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
