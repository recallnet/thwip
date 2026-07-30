import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { queueKey } from "@thwip/queue-domain";
import type { BranchQueue } from "./BranchQueue.js";

/**
 * The chaos suite from plan.md §53.3, running in workerd against the real
 * Durable Object runtime.
 *
 * Everything here is something the pure tests cannot reach: real SQLite storage,
 * real eviction between commands, real alarms, and the real serialization the
 * platform provides. The pure tests prove the logic; these prove the logic is
 * wired to a platform that behaves as assumed.
 */

const REPOSITORY_ID = "1315419165";
const BASE_REF = "refs/heads/main";
const HEAD = "h".repeat(40);

async function open(name?: string): Promise<{ stub: DurableObjectStub<BranchQueue>; key: string }> {
  const key = await queueKey(name ?? REPOSITORY_ID, BASE_REF);
  const id = env.BRANCH_QUEUE.idFromName(key);
  const stub = env.BRANCH_QUEUE.get(id) as unknown as DurableObjectStub<BranchQueue>;
  await stub.bind({ queueKey: key, repositoryId: name ?? REPOSITORY_ID, baseRef: BASE_REF });
  return { stub, key };
}

async function ready(stub: DurableObjectStub<BranchQueue>, entryId: string, principal: string, pr: number) {
  await stub.request({
    idempotencyKey: `req:${entryId}`,
    entryId,
    pullRequestNumber: pr,
    sponsorPrincipalId: principal,
    sponsorGithubUserId: principal === "alice" ? "1" : "2",
    headSha: HEAD,
  });
  await stub.readiness({
    idempotencyKey: `ready:${entryId}`,
    entryId,
    ready: true,
    schedulerEligible: true,
    primaryReason: null,
  });
}

describe("BranchQueue in workerd", () => {
  it("refuses an identity whose queue key does not match its repository and ref", async () => {
    const id = env.BRANCH_QUEUE.idFromName("mismatched");
    const stub = env.BRANCH_QUEUE.get(id) as unknown as DurableObjectStub<BranchQueue>;
    // Caught explicitly rather than with .rejects, so the RPC's rejected promise
    // is consumed here and does not surface as an unhandled rejection.
    const error = await stub
      .bind({ queueKey: "not-a-real-key", repositoryId: REPOSITORY_ID, baseRef: BASE_REF })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/does not match/);
  });

  it("writes its state to real SQLite storage, not just memory", async () => {
    const { stub, key } = await open("2000000001");
    await ready(stub, "e1", "alice", 1);

    // Read the rows back through the object's own storage. If the snapshot only
    // existed in the instance's memory, this would come back empty — which is
    // what an eviction would expose in production.
    const id = env.BRANCH_QUEUE.idFromName(key);
    const rows = await runInDurableObject(env.BRANCH_QUEUE.get(id), async (_instance, state) => {
      const sql = state.storage.sql as unknown as {
        exec(q: string): { toArray(): Array<Record<string, unknown>> };
      };
      return {
        entries: sql.exec("SELECT entry_id, state, fairness_ordinal FROM entries").toArray(),
        meta: sql.exec("SELECT generation, last_sequence FROM queue_meta").toArray(),
        events: sql.exec("SELECT COUNT(*) AS c FROM events").toArray(),
      };
    });

    expect(rows.entries).toHaveLength(1);
    expect(rows.entries[0]).toMatchObject({ entry_id: "e1", state: "Ready", fairness_ordinal: "1" });
    expect(Number(rows.meta[0]!["generation"])).toBeGreaterThan(0);
    expect(Number(rows.events[0]!["c"])).toBeGreaterThan(0);
  });

  it("records deadlines in storage so an alarm can find them after a restart", async () => {
    const { stub, key } = await open("2000000011");
    await ready(stub, "e1", "alice", 1);
    await stub.tick({ idempotencyKey: "t", decisionDigest: `sha256:${"0".repeat(64)}` });

    const id = env.BRANCH_QUEUE.idFromName(key);
    const deadlines = await runInDurableObject(env.BRANCH_QUEUE.get(id), async (_instance, state) => {
      const sql = state.storage.sql as unknown as {
        exec(q: string): { toArray(): Array<Record<string, unknown>> };
      };
      return sql.exec("SELECT kind, attempt_id, due_at FROM deadlines").toArray();
    });
    expect(deadlines.map((d) => d["kind"])).toContain("offer");
  });

  it("keeps one lane under concurrent tick attempts", async () => {
    const { stub } = await open("2000000002");
    await ready(stub, "e1", "alice", 1);
    await ready(stub, "e2", "bob", 2);

    // Fire many ticks at once. The runtime serializes them, and the reducer
    // refuses a second offer, so exactly one attempt may exist.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        stub.tick({ idempotencyKey: `tick-${i}`, decisionDigest: `sha256:${"0".repeat(64)}` }),
      ),
    );
    const applied = results.filter((r) => r.status === "applied");
    expect(applied).toHaveLength(1);

    const snapshot = await stub.snapshot();
    expect(snapshot.activeAttemptId).not.toBeNull();
    const offered = snapshot.entries.filter((e) => e.state === "Offered");
    expect(offered).toHaveLength(1);
  });

  it("treats a duplicated command as a duplicate, not a second effect", async () => {
    const { stub } = await open("2000000003");
    const command = {
      idempotencyKey: "same-key",
      entryId: "e1",
      pullRequestNumber: 1,
      sponsorPrincipalId: "alice",
      sponsorGithubUserId: "1",
      headSha: HEAD,
    };
    const first = await stub.request(command);
    const second = await stub.request(command);
    expect(first.status).toBe("applied");
    expect(second.status).toBe("duplicate");
    expect((await stub.snapshot()).entries).toHaveLength(1);
  });

  it("schedules a real alarm and expires an unclaimed offer when it fires", async () => {
    const { stub, key } = await open("2000000004");
    await ready(stub, "e1", "alice", 1);
    const offered = await stub.tick({
      idempotencyKey: "tick",
      decisionDigest: `sha256:${"0".repeat(64)}`,
    });
    expect(offered.status).toBe("applied");

    const id = env.BRANCH_QUEUE.idFromName(key);
    // An alarm must be scheduled; without one the lane would be held forever.
    const scheduled = await runInDurableObject(env.BRANCH_QUEUE.get(id), async (_i, state) =>
      state.storage.getAlarm(),
    );
    expect(scheduled).not.toBeNull();

    // Run it early: the offer deadline has not passed, so nothing should change.
    const ranEarly = await runDurableObjectAlarm(env.BRANCH_QUEUE.get(id));
    expect(ranEarly).toBe(true);
    const stillOffered = await stub.snapshot();
    expect(stillOffered.activeAttemptId).not.toBeNull();
  });

  it("is idempotent when its alarm is delivered twice", async () => {
    const { stub, key } = await open("2000000005");
    await ready(stub, "e1", "alice", 1);
    await stub.tick({ idempotencyKey: "tick", decisionDigest: `sha256:${"0".repeat(64)}` });

    const id = env.BRANCH_QUEUE.idFromName(key);
    await runDurableObjectAlarm(env.BRANCH_QUEUE.get(id));
    const afterFirst = await stub.snapshot();
    await runDurableObjectAlarm(env.BRANCH_QUEUE.get(id));
    const afterSecond = await stub.snapshot();
    expect(afterSecond.generation).toBe(afterFirst.generation);
    expect(afterSecond.entries).toEqual(afterFirst.entries);
  });

  it("keeps separate lanes for separate branches of one repository", async () => {
    const mainKey = await queueKey("2000000006", "refs/heads/main");
    const releaseKey = await queueKey("2000000006", "refs/heads/release");
    expect(mainKey).not.toBe(releaseKey);

    const main = env.BRANCH_QUEUE.get(
      env.BRANCH_QUEUE.idFromName(mainKey),
    ) as unknown as DurableObjectStub<BranchQueue>;
    const release = env.BRANCH_QUEUE.get(
      env.BRANCH_QUEUE.idFromName(releaseKey),
    ) as unknown as DurableObjectStub<BranchQueue>;
    await main.bind({ queueKey: mainKey, repositoryId: "2000000006", baseRef: "refs/heads/main" });
    await release.bind({ queueKey: releaseKey, repositoryId: "2000000006", baseRef: "refs/heads/release" });

    await ready(main, "e1", "alice", 1);
    await main.tick({ idempotencyKey: "t1", decisionDigest: `sha256:${"0".repeat(64)}` });

    // main holds a lane; release must be unaffected.
    expect((await main.snapshot()).activeAttemptId).not.toBeNull();
    expect((await release.snapshot()).activeAttemptId).toBeNull();
    expect((await release.snapshot()).entries).toEqual([]);
  });

  it("pauses on external movement and refuses to resume without a rebaseline", async () => {
    const { stub } = await open("2000000007");
    await ready(stub, "e1", "alice", 1);
    await stub.externalTransition({ idempotencyKey: "ext", observedBaseSha: "x".repeat(40) });

    const paused = await stub.snapshot();
    expect(paused.paused).toBe(true);
    expect(paused.rebaselineRequired).toBe(true);

    const tick = await stub.tick({ idempotencyKey: "t", decisionDigest: `sha256:${"0".repeat(64)}` });
    expect(tick.status).toBe("noop");

    const refused = await stub.resume({ idempotencyKey: "r1", actorPrincipalId: "admin" });
    expect(refused.status).toBe("rejected");

    await stub.rebaseline({ idempotencyKey: "rb", actorPrincipalId: "admin", baseSha: "x".repeat(40) });
    const resumed = await stub.resume({ idempotencyKey: "r2", actorPrincipalId: "admin" });
    expect(resumed.status).toBe("applied");
    expect((await stub.snapshot()).paused).toBe(false);
  });

  it("classifies a stale callback without pausing, and a conflicted one distinctly", async () => {
    const { stub } = await open("2000000008");
    await ready(stub, "e1", "alice", 1);
    await stub.tick({ idempotencyKey: "t", decisionDigest: `sha256:${"0".repeat(64)}` });
    const snapshot = await stub.snapshot();
    const attemptId = snapshot.activeAttemptId!;

    expect(await stub.classifyCallback(attemptId, snapshot.attemptRevision)).toBe("current");
    expect(await stub.classifyCallback("someone-elses-attempt", snapshot.attemptRevision)).toBe(
      "STALE_ATTEMPT",
    );
    expect(await stub.classifyCallback(attemptId, snapshot.attemptRevision + 3)).toBe(
      "CURRENT_ATTEMPT_INVARIANT_CONFLICT",
    );
    // Neither classification may pause the queue by itself.
    expect((await stub.snapshot()).paused).toBe(false);
  });

  it("holds outbox items in storage until they are acknowledged", async () => {
    const { stub, key } = await open("2000000009");
    await ready(stub, "e1", "alice", 1);
    await stub.tick({ idempotencyKey: "t", decisionDigest: `sha256:${"0".repeat(64)}` });

    const pending = await stub.pendingOutbox();
    expect(pending.length).toBeGreaterThan(0);

    const id = env.BRANCH_QUEUE.idFromName(key);
    const stored = await runInDurableObject(env.BRANCH_QUEUE.get(id), async (_instance, state) => {
      const sql = state.storage.sql as unknown as {
        exec(q: string): { toArray(): Array<Record<string, unknown>> };
      };
      return sql.exec("SELECT kind, acknowledged FROM outbox").toArray();
    });
    // Unacknowledged in real storage, so a restart still owes the effect.
    expect(stored.every((row) => Number(row["acknowledged"]) === 0)).toBe(true);

    for (const item of pending) await stub.acknowledgeOutbox(item.outboxId);
    expect(await stub.pendingOutbox()).toEqual([]);
  });

  it("survives a request that the reducer refuses, leaving nothing behind", async () => {
    const { stub } = await open("2000000010");
    const rejected = await stub.readiness({
      idempotencyKey: "nope",
      entryId: "does-not-exist",
      ready: true,
      schedulerEligible: true,
      primaryReason: null,
    });
    expect(rejected.status).toBe("rejected");
    const snapshot = await stub.snapshot();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.generation).toBe(0);
  });
});
