// apps/control-plane/src/queue/scheduled-tick.test.ts
import { afterEach, describe, expect, it } from "vitest";
import type { Sha256 } from "@thwip/queue-protocol";
import { testD1 } from "../../test/d1.js";
import { tickAllQueues } from "./scheduled-tick.js";
import { runOnQueue, type QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";
import { commandsFor, buildSnapshot } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import { recordHeartbeat } from "./runners.js";
import { signReusedIntent } from "./attestation.js";
import type { RecordFromIntentDeps } from "./record-from-intent.js";
import type { ReconciliationReads } from "./deadlines.js";

/**
 * The queue moves when something calls it, and nothing called it on a timer.
 *
 * Deadlines are advanced inside a queue transaction, so an expired offer went
 * unnoticed until unrelated traffic arrived. On a quiet repository that is
 * indefinitely. This is the heartbeat, and it must be cheap enough to run often
 * and quiet enough not to drive a lane nobody holds.
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

/**
 * Wraps a real D1Like so that any statement bound with `repositoryId` among its
 * parameters rejects, while every other statement runs against the real
 * database untouched. Used to make one repository's work fail for real, rather
 * than stubbing `driveTurn` in a way the code under test never reaches.
 */
function withFailingRepository(db: D1Like, repositoryId: string): D1Like {
  return {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => {
        const fails = values.includes(repositoryId);
        const real = db.prepare(query).bind(...values);
        const failure = () => Promise.reject(new Error(`database unavailable for repository ${repositoryId}`));
        return {
          run: () => (fails ? failure() : real.run()),
          first: <T,>() => (fails ? (failure() as Promise<T | null>) : real.first<T>()),
          all: <T,>() => (fails ? (failure() as Promise<{ results: T[] }>) : real.all<T>()),
        };
      },
    }),
    batch: (statements: unknown[]) => db.batch(statements),
  };
}

function queue(repositoryId: string, enabled: number) {
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state)
       VALUES (?, 'org_1', ?, 'refs/heads/main', ?, 'enforced')`,
    )
    .run(`qp_${repositoryId}`, repositoryId, enabled);
}

/** An active policy bundle naming `securityProfile`, for `readActivePolicy`. */
function activePolicy(repositoryId: string, securityProfile: string) {
  const digest = `sha256:${"b".repeat(64)}`;
  raw
    .prepare("INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES ('org_1', '1', 'recallnet')")
    .run();
  raw
    .prepare(
      `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled, active_policy_digest, security_profile)
       VALUES (?, 'org_1', ?, 'recallnet/thwip', 'main', 1, ?, ?)`,
    )
    .run(`prj_${repositoryId}`, repositoryId, digest, securityProfile);
  raw
    .prepare(
      "INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status) VALUES (?, ?, 4, ?, 'active')",
    )
    .run(digest, `prj_${repositoryId}`, JSON.stringify({ schemaVersion: "1", securityProfile, version: 4 }));
}

describe("the queue heartbeat", () => {
  it("visits every enabled queue", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    const visited: string[] = [];
    const result = await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: (repositoryId) => visited.push(repositoryId),
      onQueueFailed: () => {},
    });
    expect(visited.sort()).toEqual(["1", "2"]);
    expect(result.ticked).toBe(2);
  });

  it("leaves a disabled queue alone", async () => {
    const e = env();
    queue("1", 0);
    const result = await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
    });
    expect(result.ticked).toBe(0);
  });

  /** A lane nobody holds needs no dispatch, and dispatching costs a CI run. */
  it("drives nobody when no lane is held", async () => {
    const e = env();
    queue("1", 1);
    let drives = 0;
    await tickAllQueues(e, {
      driveTurn: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
    });
    expect(drives).toBe(0);
  });

  /**
   * One queue failing must not stop the rest from being ticked, and it must
   * not be counted as ticked: a heartbeat that reports the same number
   * whether it worked or failed cannot show a fleet-wide outage.
   */
  it("keeps going when one queue throws, and counts the throw as failed rather than ticked", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    // Repository "1" is unreachable at the database, not merely undriven: this
    // is the seam that actually throws inside the per-queue try block, unlike
    // stubbing driveTurn, which is never called when no lane is held.
    const failingEnv = { ...e, DB: withFailingRepository(e.DB as unknown as D1Like, "1") } as unknown as QueueRouteEnv;
    const failures: Array<{ repositoryId: string; error: unknown }> = [];
    const ticked: string[] = [];
    const result = await tickAllQueues(failingEnv, {
      driveTurn: async () => {},
      onQueueTicked: (repositoryId) => ticked.push(repositoryId),
      onQueueFailed: (repositoryId, error) => failures.push({ repositoryId, error }),
    });
    expect(result.ticked).toBe(1);
    expect(result.failed).toBe(1);
    expect(ticked).toEqual(["2"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.repositoryId).toBe("1");
  });
});

const REF = "refs/heads/main";

/** A Ready, eligible entry sponsored by `principal`, as if a runner already claimed it. */
async function readyEntry(
  db: D1Like,
  repositoryId: string,
  entryId: string,
  principal: string,
  pr: number,
): Promise<void> {
  await withQueueState(db, repositoryId, REF, async (store) => {
    const commands = commandsFor(store);
    commands.requestQueue({
      idempotencyKey: `req-${entryId}`,
      entryId,
      pullRequestNumber: pr,
      sponsorPrincipalId: principal,
      sponsorGithubUserId: pr.toString(),
      headSha: "h".repeat(40),
    });
    commands.evaluateReadiness({
      idempotencyKey: `ready-${entryId}`,
      entryId,
      ready: true,
      schedulerEligible: true,
      primaryReason: null,
    });
  });
}

/** A Ready, eligible entry, offered the lane — a held turn the tick could drive. */
async function offeredEntry(
  db: D1Like,
  repositoryId: string,
  entryId: string,
  principal: string,
  pr: number,
): Promise<void> {
  await withQueueState(db, repositoryId, REF, async (store) => {
    const commands = commandsFor(store);
    commands.requestQueue({
      idempotencyKey: `req-${entryId}`,
      entryId,
      pullRequestNumber: pr,
      sponsorPrincipalId: principal,
      sponsorGithubUserId: pr.toString(),
      headSha: "h".repeat(40),
    });
    commands.evaluateReadiness({
      idempotencyKey: `ready-${entryId}`,
      entryId,
      ready: true,
      schedulerEligible: true,
      primaryReason: null,
    });
    await commands.tick({ idempotencyKey: `tick-${entryId}`});
  });
}

/**
 * An entry whose device claimed the turn, ran it, and returned a receipt, which
 * is where `fresh` leaves an attempt while it waits for the merge to be written.
 */
async function verifyingEntry(
  db: D1Like,
  repositoryId: string,
  entryId: string,
  principal: string,
  pr: number,
): Promise<void> {
  await offeredEntry(db, repositoryId, entryId, principal, pr);
  await withQueueState(db, repositoryId, REF, (store) => {
    const commands = commandsFor(store);
    const attemptId = buildSnapshot(store).activeAttemptId;
    if (attemptId === null) throw new Error("no attempt holds the lane");
    commands.claim({
      idempotencyKey: `claim-${entryId}`,
      attemptId,
      executionMode: "device",
      deviceId: "SHA256:device",
    });
    commands.candidatePrepared({
      idempotencyKey: `candidate-${entryId}`,
      attemptId,
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
      candidateSha: "c".repeat(40),
      candidateTree: "7".repeat(40),
      policyDigest: `sha256:${"a".repeat(64)}`,
      runner: "local-run" as never,
    });
    commands.assign({
      idempotencyKey: `assign-${entryId}`,
      attemptId,
      assignmentDigest: `sha256:${"1".repeat(64)}`,
    });
    commands.submitReceipt({
      idempotencyKey: `receipt-${entryId}`,
      attemptId,
      receiptDigest: `sha256:${"2".repeat(64)}`,
    });
  });
}

function entryFrom(snapshot: ReturnType<typeof buildSnapshot>, entryId: string) {
  return snapshot.entries.find((e) => e.entryId === entryId);
}

/** Age every heartbeat in `queue_runners` past the grace window. */
function ageHeartbeats(raw: import("better-sqlite3").Database): void {
  raw.prepare("UPDATE queue_runners SET last_heartbeat_at = '2000-01-01T00:00:00.000Z'").run();
}

describe("stale-runner retirement on the tick", () => {
  it("retires a runner that stopped heartbeating, makes its entries ineligible, and keeps their fairness ordinal", async () => {
    const e = env();
    queue("1", 1);
    const db = e.DB as unknown as D1Like;

    await readyEntry(db, "1", "entry_a", "alice", 41);
    const before = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    const ordinalBefore = entryFrom(before, "entry_a")?.fairnessOrdinal;
    expect(ordinalBefore).toBeDefined();

    await recordHeartbeat(db, { repositoryId: "1", principalId: "alice", deviceKeyId: "d1", now: new Date().toISOString() });
    ageHeartbeats(raw);

    await tickAllQueues(e, { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {} });

    const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    const entry = entryFrom(after, "entry_a");
    expect(entry?.schedulerEligible).toBe(false);
    expect(entry?.primaryReason).toBe("AGENT_OFFLINE");
    expect(entry?.fairnessOrdinal).toBe(ordinalBefore);
  });

  it("an offline entry does not block a Ready entry behind it", async () => {
    const e = env();
    queue("1", 1);
    const db = e.DB as unknown as D1Like;

    // alice joined first (an earlier fairness ordinal), then went offline.
    await readyEntry(db, "1", "entry_a", "alice", 41);
    await recordHeartbeat(db, { repositoryId: "1", principalId: "alice", deviceKeyId: "d1", now: new Date().toISOString() });
    ageHeartbeats(raw);

    // bob joined after alice, and is connected.
    await readyEntry(db, "1", "entry_b", "bob", 42);
    await recordHeartbeat(db, { repositoryId: "1", principalId: "bob", deviceKeyId: "d1", now: new Date().toISOString() });

    // The tick retires alice's stale runner. It does not itself offer a new
    // turn to a lane sitting idle (only a held lane needs driving, per the
    // tick's own doc comment); that happens on whatever next touches the
    // queue, exactly as it already does for every other route. Simulate that
    // next touch directly rather than adding a second way to offer a turn.
    await tickAllQueues(e, { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {} });

    const after = await withQueueState(db, "1", REF, async (store) => {
      const commands = commandsFor(store);
      await commands.tick({ idempotencyKey: "next"});
      return buildSnapshot(store);
    });

    expect(entryFrom(after, "entry_a")?.state).toBe("Ready");
    expect(entryFrom(after, "entry_a")?.schedulerEligible).toBe(false);
    expect(entryFrom(after, "entry_b")?.state).toBe("Offered");
  });

  it("leaves a runner still inside the grace window alone", async () => {
    const e = env();
    queue("1", 1);
    const db = e.DB as unknown as D1Like;

    await readyEntry(db, "1", "entry_a", "alice", 41);
    await recordHeartbeat(db, { repositoryId: "1", principalId: "alice", deviceKeyId: "d1", now: new Date().toISOString() });

    await tickAllQueues(e, { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {} });

    const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(entryFrom(after, "entry_a")?.schedulerEligible).toBe(true);
  });
});

describe("driving a held lane against the active profile", () => {
  // A `fresh` or `audited` lane has no fallback to GitHub Actions at all
  // (plan.md §5.0): the connected device claims the offer itself, over the
  // heartbeat response. Dispatching Actions for it spends a whole run to be
  // told there is nothing to do — which is exactly what a previous change
  // made reachable by letting a connected runner clear `AGENT_OFFLINE`.
  it("does not dispatch Actions for a lane held under a device-only profile", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    activePolicy("1", "fresh");
    await offeredEntry(db, "1", "entry_a", "alice", 41);

    let drives = 0;
    const result = await tickAllQueues(e, {
      driveTurn: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
    });

    const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(entryFrom(after, "entry_a")?.state).toBe("Offered");
    expect(drives).toBe(0);
    expect(result.driven).toBe(0);
  });

  it("still dispatches Actions for a lane held under a profile that needs it", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    activePolicy("1", "fast");
    await offeredEntry(db, "1", "entry_a", "alice", 41);

    let drives = 0;
    const result = await tickAllQueues(e, {
      driveTurn: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
    });

    expect(drives).toBe(1);
    expect(result.driven).toBe(1);
  });

  /**
   * The device has finished, and the merge write is still Actions' job.
   *
   * Under `fresh` the receipt route dispatches once, fires and forgets. Nothing
   * else ever asked: this sweep skipped every device-only repository outright,
   * so a dispatch GitHub dropped, a run that lost a race, or a refusal that
   * later stopped being true left the attempt sitting in `RECEIPT_SUBMITTED`
   * until its execution deadline, with the lane held and everything behind it
   * waiting. A device-only lane past the run is this sweep's to drive.
   */
  it("dispatches Actions for a device-only lane whose run is already answered for", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    activePolicy("1", "fresh");
    await verifyingEntry(db, "1", "entry_a", "alice", 41);

    let drives = 0;
    const result = await tickAllQueues(e, {
      driveTurn: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
    });

    const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(entryFrom(after, "entry_a")?.state).toBe("Verifying");
    expect(drives).toBe(1);
    expect(result.driven).toBe(1);
  });
});

/**
 * `runAlarm()` advances the clock; it never asks the scheduler to hand a freed
 * lane to whatever is waiting. `runOnQueue` settles that with `await commands.tick()`
 * after every command (routes.ts); the heartbeat did not, so a queue whose
 * entries came off cooldown between two pieces of unrelated traffic sat frozen
 * with an idle lane and work waiting. These fail against the code before that
 * settling call is added.
 */
describe("the tick offers a turn, not just advances the clock", () => {
  /** A Ready, eligible entry, sponsored by `principal`, never offered a turn. */
  async function readyButUnoffered(
    db: D1Like,
    repositoryId: string,
    entryId: string,
    principal: string,
    pr: number,
  ): Promise<void> {
    await withQueueState(db, repositoryId, REF, async (store) => {
      const commands = commandsFor(store);
      commands.requestQueue({
        idempotencyKey: `req-${entryId}`,
        entryId,
        pullRequestNumber: pr,
        sponsorPrincipalId: principal,
        sponsorGithubUserId: pr.toString(),
        headSha: "h".repeat(40),
      });
      commands.evaluateReadiness({
        idempotencyKey: `ready-${entryId}`,
        entryId,
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
      });
    });
  }

  /**
   * A Deferred entry whose cooldown has already elapsed — the state a lane is
   * left in after an offer goes unclaimed (`OfferExpired`, store.ts). Built with
   * a zero-length cooldown so the elapsed condition (`cooldownUntil <= now`)
   * holds by the time the tick under test reads it, the same way it holds ten
   * minutes later in production; nothing here waits on the real clock.
   */
  async function deferredPastCooldown(
    db: D1Like,
    repositoryId: string,
    entryId: string,
    principal: string,
    pr: number,
  ): Promise<void> {
    await withQueueState(db, repositoryId, REF, async (store) => {
      const commands = commandsFor(store, {
        offerSeconds: 90,
        executionSeconds: 20 * 60,
        heartbeatSeconds: 20,
        graceSeconds: 60,
        noClaimCooldownSeconds: 0,
        mergeConfirmSeconds: 60,
      });
      commands.requestQueue({
        idempotencyKey: `req-${entryId}`,
        entryId,
        pullRequestNumber: pr,
        sponsorPrincipalId: principal,
        sponsorGithubUserId: pr.toString(),
        headSha: "h".repeat(40),
      });
      commands.evaluateReadiness({
        idempotencyKey: `ready-${entryId}`,
        entryId,
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
      });
      const offer = await commands.tick({ idempotencyKey: `tick-${entryId}`});
      const attemptId = (offer as { attemptId?: string }).attemptId;
      if (attemptId === undefined) throw new Error("test setup expected an offer");
      commands.expireOffer({ idempotencyKey: `expire-${entryId}`, attemptId });
    });
  }

  /**
   * A Deferred entry with no cooldown at all, which is where PR 118 sat: it
   * forfeited a turn, the termination that ended the turn carried no cooldown,
   * and the entry kept `schedulerEligible` true with `primaryReason` and
   * `cooldownUntil` null beside an idle lane. Nothing but a `pull_request`
   * webhook moved it, and the App was not subscribed to those, so nothing did.
   *
   * The termination is appended rather than commanded so this stays the shape
   * the live history has, now that `terminateAttempt` stamps a cooldown.
   */
  async function deferredWithNoCooldown(
    db: D1Like,
    repositoryId: string,
    entryId: string,
    principal: string,
    pr: number,
  ): Promise<void> {
    await withQueueState(db, repositoryId, REF, async (store) => {
      const commands = commandsFor(store);
      commands.requestQueue({
        idempotencyKey: `req-${entryId}`,
        entryId,
        pullRequestNumber: pr,
        sponsorPrincipalId: principal,
        sponsorGithubUserId: pr.toString(),
        headSha: "h".repeat(40),
      });
      commands.evaluateReadiness({
        idempotencyKey: `ready-${entryId}`,
        entryId,
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
      });
      const offer = await commands.tick({ idempotencyKey: `tick-${entryId}`});
      const attemptId = (offer as { attemptId?: string }).attemptId;
      if (attemptId === undefined) throw new Error("test setup expected an offer");
      store.append({
        idempotencyKey: `terminate-${entryId}`,
        at: new Date().toISOString(),
        type: "AttemptTerminated",
        attemptId,
        outcome: "HEAD_MOVED",
      });
    });
  }

  it("offers and drives the turn of a Ready entry sitting behind an idle lane", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await readyButUnoffered(db, "1", "entry_a", "alice", 41);

    let drives = 0;
    const result = await tickAllQueues(e, {
      driveTurn: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
    });

    const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(entryFrom(after, "entry_a")?.state).not.toBe("Ready");
    expect(["Offered", "Active"]).toContain(entryFrom(after, "entry_a")?.state);
    expect(drives).toBe(1);
    expect(result.driven).toBe(1);
  });

  it("un-sticks a Deferred entry whose cooldown has already elapsed, and offers it a turn", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await deferredPastCooldown(db, "1", "entry_a", "alice", 41);

    const before = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(entryFrom(before, "entry_a")?.state).toBe("Deferred");

    let drives = 0;
    const result = await tickAllQueues(e, {
      driveTurn: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
    });

    const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(entryFrom(after, "entry_a")?.state).not.toBe("Deferred");
    expect(["Offered", "Active"]).toContain(entryFrom(after, "entry_a")?.state);
    expect(drives).toBe(1);
    expect(result.driven).toBe(1);
  });

  it("un-sticks a Deferred entry with no cooldown at all, and offers it a turn", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await deferredWithNoCooldown(db, "1", "entry_a", "alice", 118);

    const before = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(entryFrom(before, "entry_a")?.state).toBe("Deferred");
    expect(entryFrom(before, "entry_a")?.cooldownUntil).toBeNull();
    expect(entryFrom(before, "entry_a")?.schedulerEligible).toBe(true);

    let drives = 0;
    const result = await tickAllQueues(e, {
      driveTurn: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
    });

    const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(["Offered", "Active"]).toContain(entryFrom(after, "entry_a")?.state);
    expect(drives).toBe(1);
    expect(result.driven).toBe(1);
  });

  it("writes nothing for an idle queue with no entries at all", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);

    const row = () =>
      raw
        .prepare("SELECT generation FROM queue_state WHERE github_repository_id = ? AND base_ref = ?")
        .get("1", REF) as { generation: number } | undefined;

    expect(row()).toBeUndefined();

    await tickAllQueues(e, { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {} });

    // `withQueueState` only saves on a real change (queue-state.ts). An empty
    // queue has nothing for `runAlarm()` or the settling `tick()` to change, so
    // this must still write no row — this runs every five minutes across every
    // enabled queue on an account that deliberately stays inside a free tier.
    expect(row()).toBeUndefined();
  });
});

describe("settling a write the workflow walked away from", () => {
  /**
   * The shape of the four merges that landed on 2 August 2026 with no chain
   * link: a signed merge intent survives, the attempt that authorized it does
   * not, and nothing but the `merge_operations` row says a write was ever sent.
   */
  const ORPHAN = {
    attemptId: "att_orphan",
    pullRequestNumber: 115,
    baseSha: "a1".repeat(20),
    headSha: "b2".repeat(20),
    mergeSha: "c3".repeat(20),
    treeOid: "d4".repeat(20),
    beforeTree: "e5".repeat(20),
  };

  const COMMITS: Record<string, { treeOid: string; parentShas: string[] }> = {
    [ORPHAN.baseSha]: { treeOid: ORPHAN.beforeTree, parentShas: ["5c".repeat(20)] },
    [ORPHAN.mergeSha]: { treeOid: ORPHAN.treeOid, parentShas: [ORPHAN.baseSha, ORPHAN.headSha] },
  };

  /** Write the merge intent exactly as the authorize route writes it. */
  async function seedIntent(): Promise<void> {
    const signed = await signReusedIntent({
      operationId: `merge_${ORPHAN.attemptId}`,
      attemptId: ORPHAN.attemptId,
      git: {
        objectFormat: "sha1",
        repositoryId: "1",
        baseRef: REF,
        baseSha: ORPHAN.baseSha,
        headRepositoryId: "1",
        headSha: ORPHAN.headSha,
        candidateSha: ORPHAN.mergeSha,
        candidateTreeOid: ORPHAN.treeOid,
        candidateParentOids: [ORPHAN.baseSha, ORPHAN.headSha],
      },
      position: { queueEpoch: 0, turnSequence: 1, transitionSequence: 1, previousTransitionDigest: null },
      pullRequestNumber: ORPHAN.pullRequestNumber,
      evidence: {
        workReceiptDigest: `sha256:${"1".repeat(64)}` as Sha256,
        organizationId: "org_acme",
        policyDigest: `sha256:${"2".repeat(64)}` as Sha256,
        pipelineDigest: `sha256:${"3".repeat(64)}` as Sha256,
        requiredSuitesDigest: `sha256:${"4".repeat(64)}` as Sha256,
        proofCheckRunId: "91289436271",
      },
      mergeMethod: "merge",
      createdAt: "2026-08-02T07:50:00.000Z",
      signer: { sign: async () => "jws-intent" },
    });
    if ("error" in signed) throw new Error(signed.error);
    raw
      .prepare(
        `INSERT INTO queue_attestations
           (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws, created_at)
         VALUES (?, 'merge-intent', ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        signed.digest,
        "1",
        REF,
        ORPHAN.attemptId,
        new TextDecoder().decode(signed.bytes),
        signed.jws,
        "2026-08-02T07:50:00.000Z",
      );
  }

  it("settles a merge write left unresolved by a workflow that exited", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await seedIntent();

    // The write started twenty minutes ago and nothing ever resolved it. No
    // attempt was ever created here, the same state the queue was in when it
    // stranded four merges: `state.attempts` held none of them.
    await withQueueState(db, "1", REF, async (store) =>
      store.beginMergeOperation({
        operationId: `merge_${ORPHAN.attemptId}`,
        attemptId: ORPHAN.attemptId,
        attemptRevision: 1,
        expectedBaseSha: ORPHAN.baseSha,
        expectedHeadSha: ORPHAN.headSha,
        expectedTreeOid: ORPHAN.treeOid,
        pullRequestNumber: ORPHAN.pullRequestNumber,
        at: "2026-08-02T07:55:00.000Z",
      }),
    );

    const recordDeps: RecordFromIntentDeps<QueueRouteEnv> = {
      commitFacts: async (_env, _repositoryId, sha) => COMMITS[sha] ?? null,
      baseContainsSha: async () => true,
      activePolicy: async () => ({
        policyDigest: `sha256:${"2".repeat(64)}`,
        pipelineDigest: `sha256:${"3".repeat(64)}`,
        requiredSuites: ["unit"],
        organizationId: "org_acme",
      }),
      signRecordBytes: async () => "jws-record",
      storeEvidence: async () => "no-bucket",
      onQueue: runOnQueue,
    };

    const readsThatSayMerged: ReconciliationReads = {
      pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: ORPHAN.mergeSha }),
      baseContainsSha: async () => true,
      commitFacts: async (_env, _repositoryId, sha) => COMMITS[sha] ?? null,
    };

    const result = await tickAllQueues(
      e,
      { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {} },
      readsThatSayMerged,
      recordDeps,
    );

    expect(result.settledWrites).toBe(1);
    const remaining = await withQueueState(db, "1", REF, async (store) =>
      store.unresolvedMergeOperations(new Date().toISOString()),
    );
    expect(remaining).toEqual([]);
  });
});
