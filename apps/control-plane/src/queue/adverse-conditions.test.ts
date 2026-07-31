import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";

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
let raw: Database.Database;

function env(): QueueRouteEnv {
  const db = new Database(":memory:");
  open.push(db);
  raw = db;
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations");
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    for (const statement of readFileSync(join(dir, file), "utf8").split(";")) {
      const sql = statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (sql.length === 0) continue;
      try {
        db.exec(sql);
      } catch {
        /* migrations altering tables these tests do not use */
      }
    }
  }
  const d1 = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => ({ meta: { changes: db.prepare(query).run(...(values as never[])).changes } }),
        first: async <T,>() => (db.prepare(query).get(...(values as never[])) ?? null) as T | null,
        all: async <T,>() => ({ results: db.prepare(query).all(...(values as never[])) as T[] }),
      }),
    }),
    batch: async (statements: Array<{ run(): Promise<unknown> }>) => {
      for (const s of statements) await s.run();
    },
  };
  return { DB: d1, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "t".repeat(40);

function routes(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  return queueRoutes({
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
    entries: Array<{ pullRequestNumber: number; state: string }>;
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

    const snapshot = await liveState(app, e);
    expect(stateOf(snapshot, 59)).not.toBe("Merged");
    expect(snapshot.activeAttemptId).toBeNull();
  });

  it("lets the next pull request take the lane afterwards", async () => {
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

    const after = await liveState(app, e);
    expect(after.activeAttemptId).toBeNull();
    // And the queue can go on: somebody still waiting gets offered the turn.
    const next = await Promise.all([59, 61].map((pr) => authorize(app, e, pr)));
    expect(next.filter((v) => v.reason === "HOLDS_TURN")).toHaveLength(1);
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

describe("the base branch moves underneath a turn", () => {
  it("stops merging until somebody rebaselines", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);

    const paused = await app.request(
      `/v1/queue/${REPO}/pause?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "the base moved outside the queue" }),
      },
      e,
    );
    expect(paused.status).toBe(200);

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
