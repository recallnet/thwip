import { afterEach, describe, expect, it } from "vitest";
import { queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { tickAllQueues } from "./scheduled-tick.js";
import { buildSnapshot, commandsFor } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";
import type { ReconciliationReads } from "./deadlines.js";

/**
 * A Durable Object has an alarm. D1 does not, so nothing wakes up to expire a
 * turn nobody finished, and a turn that never expires holds the lane forever.
 * That is the failure this queue spent a week in, from the other direction.
 *
 * The replacement is that every command run against the queue handles whatever
 * is already due before doing its own work. These tests age the stored document
 * rather than waiting out a real deadline, then ask whether the queue recovers on
 * the next thing that touches it.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  seedSessionMembership("alice", "1");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

/**
 * The organization that owns the repository, its project row, and the session's
 * own membership of it.
 *
 * Every session-authenticated queue route establishes membership before it acts,
 * so a test whose caller belongs to no organization is refused before it reaches
 * the behaviour it is about. Seeded with the environment rather than per test,
 * because the caller belonging somewhere is a precondition of all of them.
 */
function seedSessionMembership(principalId: string, githubUserId: string): void {
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
    .run(principalId, "org_1", githubUserId, principalId);
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";

function routes() {
  return queueRoutes(
    queueRouteDeps({ repositoryId: REPO, baseRef: REF }, {
      // These deadline tests exercise the queue clock, not the merge writer.
      // With no active policy the internal App wake leaves the offered turn in
      // place, which is the same precondition a device that stopped answering
      // creates in production.
      activePolicy: async () => null,
      commitFacts: async () => ({ treeOid: "t".repeat(40), parentShas: ["p".repeat(40)] }),
    }) as Parameters<typeof queueRoutes>[0],
  );
}

async function authorize(app: ReturnType<typeof routes>, e: QueueRouteEnv, pullRequestNumber: number) {
  acceptProof(raw, REPO, String(pullRequestNumber).padStart(40, "a"));
  const response = await app.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber,
        headSha: String(pullRequestNumber).padStart(40, "a"),
        baseRef: REF,
        authorGithubUserId: String(pullRequestNumber),
        draft: false,
      }),
    },
    e,
  );
  return (await response.json()) as { authorized: boolean; reason: string };
}

/** Age every deadline in the stored document, as waiting would. */
function ageDeadlines(): number {
  const row = raw
    .prepare("SELECT document FROM queue_state WHERE github_repository_id = ? AND base_ref = ?")
    .get(REPO, REF) as { document: string } | undefined;
  if (row === undefined) return 0;
  const doc = JSON.parse(row.document) as { deadlines: Array<{ dueAt: string }> };
  for (const deadline of doc.deadlines) deadline.dueAt = "2000-01-01T00:00:00.000Z";
  raw
    .prepare("UPDATE queue_state SET document = ? WHERE github_repository_id = ? AND base_ref = ?")
    .run(JSON.stringify(doc), REPO, REF);
  // The projection last moved when the lane was last swept, so aging the
  // deadlines without aging that would leave the fast path still answering.
  raw
    .prepare("UPDATE queue_projection_marks SET projected_at = ? WHERE github_repository_id = ? AND base_ref = ?")
    .run("2000-01-01T00:00:00.000Z", REPO, REF);
  return doc.deadlines.length;
}

describe("a turn that ran out, with nothing to wake the queue up", () => {
  it("does not hold the lane forever", async () => {
    const e = env();
    const app = routes();

    expect((await authorize(app, e, 59)).reason).toBe("HOLDS_TURN");
    expect((await authorize(app, e, 61)).reason).toBe("WAITING_FOR_TURN");

    // The holder goes away and never comes back.
    expect(ageDeadlines()).toBeGreaterThan(0);

    // The next thing to touch the queue is the pull request that was waiting.
    expect((await authorize(app, e, 61)).reason).toBe("HOLDS_TURN");
  });

  it("leaves a turn that has not run out alone", async () => {
    const e = env();
    const app = routes();
    expect((await authorize(app, e, 59)).reason).toBe("HOLDS_TURN");
    for (let i = 0; i < 3; i += 1) {
      expect((await authorize(app, e, 61)).reason).toBe("WAITING_FOR_TURN");
    }
    expect((await authorize(app, e, 59)).reason).toBe("HOLDS_TURN");
  });

  it("recovers even when nobody is waiting to ask", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    ageDeadlines();

    // A webhook, rather than a pull request asking about itself.
    const ticked = await app.request(
      `/v1/queue/${REPO}/tick?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    expect(ticked.status).toBe(200);

    const response = await app.request(`/v1/queue/${REPO}?ref=${encodeURIComponent(REF)}&live=1`, {}, e);
    const state = (await response.json()) as { activeAttemptId: string | null };
    // The lapsed turn released the lane rather than keeping it after the holder
    // stopped answering.
    expect(state.activeAttemptId).toBeNull();
  });
});

/**
 * Attempt `att_2dc5e37e` for pull request 114 entered `Reconciling` and stayed
 * there for more than twenty minutes past an execution deadline of
 * 2026-08-02T05:06:04Z. The five-minute cron fired several times in that window
 * and resolved nothing: the alarm's only answer for an overrun turn is
 * `EXPIRED_EXECUTION`, and the reducer refuses that outcome for an attempt whose
 * merge outcome is in doubt, so every sweep rejected its own command, cleared the
 * deadline row and left the lane exactly where it found it. `POST /tick` was a
 * no-op throughout, because the wedged attempt held the lane and no entry was
 * eligible. Pull request 115 sat Ready behind it until an operator ran
 * `POST /reconcile observed=not-merged` by hand.
 *
 * One indeterminate merge stopping the whole queue is the failure the durability
 * work was meant to remove, so the sweep now reads GitHub and settles it.
 */

const TREE = "t".repeat(40);
const MERGE_SHA = "f".repeat(40);

/** A queue row the tick will visit. */
function queueProject(repositoryId: string): void {
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, project_id)
       VALUES (?, 'org_1', ?, 'refs/heads/main', 1, 'enforced', ?)`,
    )
    .run(`qp_${repositoryId}`, repositoryId, "proj_1");
}

/**
 * Pull request 114 driven all the way to a merge write whose outcome is in
 * doubt, with 115 Ready behind it. The execution window is zero seconds rather
 * than twenty minutes, so the deadline is already behind by the time the tick
 * reads it, which is the same condition without waiting out the clock.
 */
async function reconcilingLane(
  db: D1Like,
  timing: { executionSeconds?: number; mergeConfirmSeconds?: number } = {},
): Promise<string> {
  return withQueueState(db, REPO, REF, async (store) => {
    const commands = commandsFor(store, {
      offerSeconds: 90,
      executionSeconds: timing.executionSeconds ?? 0,
      heartbeatSeconds: 20,
      graceSeconds: 60,
      noClaimCooldownSeconds: 300,
      mergeConfirmSeconds: timing.mergeConfirmSeconds ?? 60,
    });
    for (const [entryId, pr] of [
      ["e114", 114],
      ["e115", 115],
    ] as const) {
      commands.requestQueue({
        idempotencyKey: `req-${entryId}`,
        entryId,
        pullRequestNumber: pr,
        sponsorPrincipalId: `principal_${pr}`,
        sponsorGithubUserId: String(pr),
        headSha: String(pr).padStart(40, "a"),
      });
      commands.evaluateReadiness({
        idempotencyKey: `ready-${entryId}`,
        entryId,
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
      });
    }

    const offer = await commands.tick({ idempotencyKey: "offer-114"});
    const attemptId = (offer as { attemptId?: string }).attemptId;
    if (attemptId === undefined) throw new Error("test setup expected an offer");

    commands.claim({ idempotencyKey: `claim-${attemptId}`, attemptId, executionMode: "remote" });
    commands.candidatePrepared({
      idempotencyKey: `candidate-${attemptId}`,
      attemptId,
      baseSha: "b".repeat(40),
      headSha: "114".padStart(40, "a"),
      candidateSha: "c".repeat(40),
      candidateTree: TREE,
      policyDigest: `sha256:${"b".repeat(64)}`,
      runner: "dagger",
    });
    commands.assign({
      idempotencyKey: `assign-${attemptId}`,
      attemptId,
      assignmentDigest: `sha256:${"a".repeat(64)}`,
    });
    commands.submitReceipt({
      idempotencyKey: `receipt-${attemptId}`,
      attemptId,
      receiptDigest: `sha256:${"r".repeat(64)}`,
    });
    const started = commands.startVerification({ idempotencyKey: `verify-${attemptId}`, attemptId });
    commands.completeVerification({
      idempotencyKey: `verdict-${attemptId}`,
      attemptId,
      nonce: started.nonce!,
      accepted: true,
      resultDigest: `sha256:${"d".repeat(64)}`,
    });
    commands.createMergeIntent({
      idempotencyKey: `intent-${attemptId}`,
      attemptId,
      intentDigest: `sha256:${"e".repeat(64)}`,
    });
    commands.beginMergeWrite({
      idempotencyKey: `write-${attemptId}`,
      attemptId,
      operationId: `merge_${attemptId}`,
    });
    commands.mergeOutcomeUnknown({ idempotencyKey: `unknown-${attemptId}`, attemptId });
    return attemptId;
  });
}

async function stateNow(db: D1Like) {
  const snapshot = await withQueueState(db, REPO, REF, (store) => buildSnapshot(store));
  return {
    activeAttemptId: snapshot.activeAttemptId,
    of: (pr: number) => snapshot.entries.find((entry) => entry.pullRequestNumber === pr),
  };
}

const PORTS = {
  driveQueue: async () => {},
  onQueueTicked: () => {},
  onQueueFailed: () => {},
  reconsiderHead: async () => 0,
  publishStatusComments: async () => {},
  retireStatusComments: async () => {},
};

/** Every read agrees the merge did not happen, which is what was true on the day. */
const NOT_MERGED: ReconciliationReads = {
  pullRequestMergeState: async () => ({ merged: false, mergeCommitSha: null }),
  baseContainsSha: async () => false,
  pullRequestNumbersForCommit: async () => [114],
  commitFacts: async () => ({ treeOid: TREE, parentShas: ["b".repeat(40), "114".padStart(40, "a")] }),
  sleep: async () => {},
};

describe("a merge outcome nobody could settle, past its deadline", () => {
  it("settles at merge confirmation without waiting for the execution fallback", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queueProject(REPO);
    const attemptId = await reconcilingLane(db, { executionSeconds: 20 * 60, mergeConfirmSeconds: 0 });

    await tickAllQueues(e, PORTS, NOT_MERGED);

    const after = await stateNow(db);
    expect(after.of(114)?.state).toBe("Deferred");
    expect(after.activeAttemptId).not.toBe(attemptId);
    expect(["Offered", "Active"]).toContain(after.of(115)?.state);
  });

  it("confirms the refusal, frees the lane, and lets the next pull request take a turn", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queueProject(REPO);
    const attemptId = await reconcilingLane(db);

    const before = await stateNow(db);
    expect(before.activeAttemptId).toBe(attemptId);
    expect(before.of(114)?.state).toBe("Reconciling");
    expect(before.of(115)?.state).toBe("Ready");

    await tickAllQueues(e, PORTS, NOT_MERGED);

    const after = await stateNow(db);
    // 114 keeps its place and serves a cooldown, as any refused merge does.
    expect(after.of(114)?.state).toBe("Deferred");
    // The lane went to the pull request that had been waiting behind it.
    expect(["Offered", "Active"]).toContain(after.of(115)?.state);
    expect(after.activeAttemptId).not.toBe(attemptId);
    expect(after.activeAttemptId).not.toBeNull();
  });

  it("records the merge and frees the lane when the reads say it landed", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queueProject(REPO);
    await reconcilingLane(db);

    await tickAllQueues(e, PORTS, {
      ...NOT_MERGED,
      pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: MERGE_SHA }),
      baseContainsSha: async () => true,
    });

    const after = await stateNow(db);
    expect(after.of(114)?.state).toBe("Merged");
    expect(["Offered", "Active"]).toContain(after.of(115)?.state);
  });

  /**
   * The hard case. Every read failed, so the queue still cannot say what became
   * of the merge, and it must not guess, because guessing "not merged" is how
   * four merges left the chain.
   *
   * It frees the lane anyway and blocks the one entry it cannot speak for. The
   * write that may still be in flight belongs to this attempt and this pull
   * request; a blocked entry is not scheduler-eligible, so nothing offers it a
   * second turn and no second write can follow the first. Everything behind it
   * is unrelated work that was never in doubt, and holding the whole queue for
   * one indeterminate merge is the failure being fixed.
   */
  it("frees the lane on an outcome it still cannot determine, and blocks only the entry it cannot speak for", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queueProject(REPO);
    const attemptId = await reconcilingLane(db);

    await tickAllQueues(e, PORTS, {
      ...NOT_MERGED,
      pullRequestMergeState: async () => null,
      baseContainsSha: async () => null,
    });

    const after = await stateNow(db);
    expect(after.of(114)?.state).toBe("Blocked");
    expect(after.of(114)?.primaryReason).toBe("MERGE_OUTCOME_UNKNOWN");
    expect(after.activeAttemptId).not.toBe(attemptId);
    expect(["Offered", "Active"]).toContain(after.of(115)?.state);
    expect(
      await withQueueState(db, REPO, REF, (store) =>
        store.dueDeadlines(new Date().toISOString()).filter((deadline) => deadline.kind === "merge-confirm"),
      ),
    ).toEqual([]);

    // And it stays out of the running. The scheduler considers Ready entries and
    // Deferred entries serving a cooldown; a Blocked one is neither, so no later
    // sweep hands this pull request a second turn on its own.
    await tickAllQueues(e, PORTS, NOT_MERGED);
    expect((await stateNow(db)).of(114)?.state).toBe("Blocked");
  });

  it("reads nothing and settles nothing while the deadline is still ahead", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queueProject(REPO);

    await withQueueState(db, REPO, REF, async (store) => {
      const commands = commandsFor(store);
      commands.requestQueue({
        idempotencyKey: "req-e114",
        entryId: "e114",
        pullRequestNumber: 114,
        sponsorPrincipalId: "principal_114",
        sponsorGithubUserId: "114",
        headSha: "114".padStart(40, "a"),
      });
      commands.evaluateReadiness({
        idempotencyKey: "ready-e114",
        entryId: "e114",
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
      });
      const offer = await commands.tick({ idempotencyKey: "offer"});
      const attemptId = (offer as { attemptId?: string }).attemptId!;
      commands.claim({ idempotencyKey: "claim", attemptId, executionMode: "remote" });
      commands.candidatePrepared({
        idempotencyKey: "candidate",
        attemptId,
        baseSha: "b".repeat(40),
        headSha: "114".padStart(40, "a"),
        candidateSha: "c".repeat(40),
        candidateTree: TREE,
        policyDigest: `sha256:${"b".repeat(64)}`,
        runner: "dagger",
      });
      commands.assign({ idempotencyKey: "assign", attemptId, assignmentDigest: `sha256:${"a".repeat(64)}` });
      commands.submitReceipt({ idempotencyKey: "receipt", attemptId, receiptDigest: `sha256:${"r".repeat(64)}` });
      const started = commands.startVerification({ idempotencyKey: "verify", attemptId });
      commands.completeVerification({
        idempotencyKey: "verdict",
        attemptId,
        nonce: started.nonce!,
        accepted: true,
        resultDigest: `sha256:${"d".repeat(64)}`,
      });
      commands.createMergeIntent({ idempotencyKey: "intent", attemptId, intentDigest: `sha256:${"e".repeat(64)}` });
      commands.beginMergeWrite({ idempotencyKey: "write", attemptId, operationId: `merge_${attemptId}` });
      commands.mergeOutcomeUnknown({ idempotencyKey: "unknown", attemptId });
    });

    let reads = 0;
    await tickAllQueues(e, PORTS, {
      ...NOT_MERGED,
      pullRequestMergeState: async () => {
        reads += 1;
        return { merged: false, mergeCommitSha: null };
      },
    });

    // Reconciliation reads and waits. Nothing about a merge still inside its
    // window is anybody's business yet.
    expect(reads).toBe(0);
    expect((await stateNow(db)).of(114)?.state).toBe("Reconciling");
  });
});
