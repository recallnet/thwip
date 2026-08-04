// apps/control-plane/src/queue/scheduled-tick.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import type { Sha256 } from "@thwip/queue-protocol";
import { testD1 } from "../../test/d1.js";
import { tickAllQueues } from "./scheduled-tick.js";
import { runOnQueue, type QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";
import { commandsFor, buildSnapshot } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import { recordHeartbeat } from "./runners.js";
import { readChain, signReusedIntent } from "./attestation.js";
import type { RecordFromIntentDeps } from "./record-from-intent.js";
import type { ReconciliationReads } from "./deadlines.js";
import { serviceKey } from "../service-signing.js";
import type { Env } from "../env.js";

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

let signingKeys = 0;

/**
 * An env carrying a real ES256 signing key, unique per call. `serviceKey`
 * (service-signing.ts) only inserts a key into `service_keys` the first time
 * its kid is seen on this process, so a shared kid across tests would let one
 * test's insert stand in for another's and hide the exact race this file
 * exists to catch.
 */
async function envWithSigningKey(): Promise<QueueRouteEnv> {
  const e = env();
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(pair.privateKey)), kid: `tick-test-${++signingKeys}`, alg: "ES256" };
  return { ...e, THWIP_SERVICE_SIGNING_PRIVATE_JWK: JSON.stringify(jwk) } as unknown as QueueRouteEnv;
}

/** `recordDepsThatRecord()` with the stub signer replaced by the real one `RECORD_FROM_INTENT_DEPS` uses in production, so signing goes through `serviceKey` and can mint a row in `service_keys`. */
function recordDepsThatSignForReal(): RecordFromIntentDeps<QueueRouteEnv> {
  return {
    ...recordDepsThatRecord(),
    async signRecordBytes(e, bytes, typ) {
      const { key, kid } = await serviceKey(e as unknown as Env);
      return new CompactSign(bytes).setProtectedHeader({ alg: "ES256", kid, typ }).sign(key);
    },
  };
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

/**
 * `epochStartsAt` names the first attested sequence (`attested_from_sequence`).
 * Left at the schema default of 0 for every test that does not care about the
 * chain, since `MISSING_PREFIX` only fires when a served chain's first link
 * sits strictly past that boundary — a genuinely first-ever link at sequence 1
 * needs an epoch of 1 to read as having no gap before it (`verify-chain.ts`,
 * `anchor`).
 */
function queue(repositoryId: string, enabled: number, epochStartsAt = 0) {
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, attested_from_sequence)
       VALUES (?, 'org_1', ?, 'refs/heads/main', ?, 'enforced', ?)`,
    )
    .run(`qp_${repositoryId}`, repositoryId, enabled, epochStartsAt);
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
      reconsiderHead: async () => 0,
      reconsiderHead: async () => 0,
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
      reconsiderHead: async () => 0,
      reconsiderHead: async () => 0,
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
      reconsiderHead: async () => 0,
      reconsiderHead: async () => 0,
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
      reconsiderHead: async () => 0,
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

/** An entry the queue is holding back for a reason GitHub told it. */
async function blockedEntry(
  db: D1Like,
  repositoryId: string,
  entryId: string,
  pr: number,
  reason: string,
  headSha = "h".repeat(40),
): Promise<void> {
  await withQueueState(db, repositoryId, REF, async (store) => {
    const commands = commandsFor(store);
    commands.requestQueue({
      idempotencyKey: `req-${entryId}`,
      entryId,
      pullRequestNumber: pr,
      sponsorPrincipalId: "alice",
      sponsorGithubUserId: pr.toString(),
      headSha,
    });
    commands.evaluateReadiness({
      idempotencyKey: `blocked-${entryId}`,
      entryId,
      ready: false,
      schedulerEligible: false,
      primaryReason: reason as never,
    });
  });
}

/**
 * Readiness that stopped being true and nothing noticed.
 *
 * The projection write after a command is best-effort, so a failed write leaves
 * the row holding whatever it last held. Pull request 56 was marked ready for
 * review on GitHub and the queue kept `PR_DRAFT`, so the dashboard told its
 * author to do the thing they had already done. The webhook is the fast path
 * and nothing owned the slow one.
 */
describe("readiness nothing else came back to fix", () => {
  it("re-reads the pull request behind an entry blocked on what GitHub said", async () => {
    const e = env();
    queue("1", 1);
    const db = e.DB as unknown as D1Like;
    await blockedEntry(db, "1", "entry_a", 56, "PR_DRAFT");

    const asked: Array<{ repositoryId: string; headSha: string }> = [];
    const result = await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async (repositoryId, headSha) => {
        asked.push({ repositoryId, headSha });
        return 1;
      },
    });

    expect(asked).toEqual([{ repositoryId: "1", headSha: "h".repeat(40) }]);
    expect(result.readinessRechecked).toBe(1);
  });

  it("re-reads an entry blocked on a pull request GitHub said was closed", async () => {
    const e = env();
    queue("1", 1);
    await blockedEntry(e.DB as unknown as D1Like, "1", "entry_a", 56, "PR_CLOSED");
    let asked = 0;
    await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => {
        asked += 1;
        return 1;
      },
    });
    expect(asked).toBe(1);
  });

  it("spends no GitHub read on a reason GitHub is not the source of", async () => {
    // A review nobody has given is not a fact a re-read of the pull request
    // can change, and this account has a daily quota it has already exhausted
    // once.
    const e = env();
    queue("1", 1);
    await blockedEntry(e.DB as unknown as D1Like, "1", "entry_a", 56, "REVIEW_REQUIRED");
    let asked = 0;
    await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => {
        asked += 1;
        return 1;
      },
    });
    expect(asked).toBe(0);
  });

  it("spends no GitHub read on a queue with nothing blocked", async () => {
    const e = env();
    queue("1", 1);
    await readyEntry(e.DB as unknown as D1Like, "1", "entry_a", "alice", 41);
    let asked = 0;
    await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => {
        asked += 1;
        return 1;
      },
    });
    expect(asked).toBe(0);
  });

  it("re-reads at most three entries on one queue in one tick", async () => {
    const e = env();
    queue("1", 1);
    const db = e.DB as unknown as D1Like;
    for (const n of [1, 2, 3, 4, 5]) {
      await blockedEntry(db, "1", `entry_${n}`, n, "PR_DRAFT", String(n).repeat(40).slice(0, 40));
    }
    let asked = 0;
    const result = await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => {
        asked += 1;
        return 1;
      },
    });
    expect(asked).toBe(3);
    expect(result.readinessRechecked).toBe(3);
  });

  it("keeps ticking the rest of the fleet when one re-read throws", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    await blockedEntry(e.DB as unknown as D1Like, "1", "entry_a", 56, "PR_DRAFT");
    const ticked: string[] = [];
    const result = await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: (repositoryId) => ticked.push(repositoryId),
      onQueueFailed: () => {},
      reconsiderHead: async () => {
        throw new Error("GitHub is unreachable");
      },
    });
    expect(ticked.sort()).toEqual(["1", "2"]);
    expect(result.readinessRechecked).toBe(0);
  });
});

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

    await tickAllQueues(e, { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 });

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
    await tickAllQueues(e, { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 });

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

    await tickAllQueues(e, { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 });

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
      reconsiderHead: async () => 0,
      reconsiderHead: async () => 0,
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
      reconsiderHead: async () => 0,
      reconsiderHead: async () => 0,
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
      reconsiderHead: async () => 0,
      reconsiderHead: async () => 0,
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
      reconsiderHead: async () => 0,
      reconsiderHead: async () => 0,
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
      reconsiderHead: async () => 0,
      reconsiderHead: async () => 0,
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
      reconsiderHead: async () => 0,
      reconsiderHead: async () => 0,
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

    await tickAllQueues(e, { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 });

    // `withQueueState` only saves on a real change (queue-state.ts). An empty
    // queue has nothing for `runAlarm()` or the settling `tick()` to change, so
    // this must still write no row — this runs every five minutes across every
    // enabled queue on an account that deliberately stays inside a free tier.
    expect(row()).toBeUndefined();
  });
});

/**
 * The shape of the four merges that landed on 2 August 2026 with no chain
 * link: a signed merge intent survives, the attempt that authorized it does
 * not, and nothing but the `merge_operations` row says a write was ever sent.
 *
 * Module scope, not local to one describe block: the chain-integration tests
 * below need the same production write path — `seedIntent` and `beginWrite`
 * through `tickAllQueues` — to put a real, signed link in `queue_attestations`,
 * rather than a hand-rolled chain shape that could drift from what production
 * actually writes.
 */
interface OrphanShape {
  readonly attemptId: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeSha: string;
  readonly treeOid: string;
  readonly beforeTree: string;
}

const ORPHAN: OrphanShape = {
  attemptId: "att_orphan",
  pullRequestNumber: 115,
  baseSha: "a1".repeat(20),
  headSha: "b2".repeat(20),
  mergeSha: "c3".repeat(20),
  treeOid: "d4".repeat(20),
  beforeTree: "e5".repeat(20),
};

/**
 * A second orphan whose base and merge shas share nothing with `ORPHAN`'s.
 * Recording both through the same production path (`seedIntent` /
 * `beginWrite` / `sweepOrphanedWrites`) leaves two real, signed links whose
 * base moves do not join into one path — exactly the shape `BASE_DISCONTINUITY`
 * exists to name, built without hand-rolling a second chain shape.
 */
const ORPHAN_B: OrphanShape = {
  attemptId: "att_orphan_b",
  pullRequestNumber: 116,
  baseSha: "f1".repeat(20),
  headSha: "f2".repeat(20),
  mergeSha: "f3".repeat(20),
  treeOid: "f4".repeat(20),
  beforeTree: "f5".repeat(20),
};

/** Every commit fact `commitFacts` may be asked for, across every orphan a test seeds. */
function commitsFor(...shapes: readonly OrphanShape[]): Record<string, { treeOid: string; parentShas: string[] }> {
  const commits: Record<string, { treeOid: string; parentShas: string[] }> = {};
  for (const shape of shapes) {
    commits[shape.baseSha] = { treeOid: shape.beforeTree, parentShas: ["5c".repeat(20)] };
    commits[shape.mergeSha] = { treeOid: shape.treeOid, parentShas: [shape.baseSha, shape.headSha] };
  }
  return commits;
}

const COMMITS = commitsFor(ORPHAN);

/** Write the merge intent exactly as the authorize route writes it. */
async function seedIntent(shape: OrphanShape = ORPHAN): Promise<void> {
  const signed = await signReusedIntent({
    operationId: `merge_${shape.attemptId}`,
    attemptId: shape.attemptId,
    git: {
      objectFormat: "sha1",
      repositoryId: "1",
      baseRef: REF,
      baseSha: shape.baseSha,
      headRepositoryId: "1",
      headSha: shape.headSha,
      candidateSha: shape.mergeSha,
      candidateTreeOid: shape.treeOid,
      candidateParentOids: [shape.baseSha, shape.headSha],
    },
    position: { queueEpoch: 0, turnSequence: 1, transitionSequence: 1, previousTransitionDigest: null },
    pullRequestNumber: shape.pullRequestNumber,
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
      shape.attemptId,
      new TextDecoder().decode(signed.bytes),
      signed.jws,
      "2026-08-02T07:50:00.000Z",
    );
}

/**
 * The write started twenty minutes ago and nothing ever resolved it. No
 * attempt is ever created, the same state the queue was in when it stranded
 * four merges: `state.attempts` held none of them.
 */
async function beginWrite(
  db: D1Like,
  pullRequestNumber: number,
  shape: OrphanShape = ORPHAN,
  operationId = `merge_${shape.attemptId}`,
): Promise<void> {
  await withQueueState(db, "1", REF, async (store) =>
    store.beginMergeOperation({
      operationId,
      attemptId: shape.attemptId,
      attemptRevision: 1,
      expectedBaseSha: shape.baseSha,
      expectedHeadSha: shape.headSha,
      expectedTreeOid: shape.treeOid,
      pullRequestNumber,
      at: "2026-08-02T07:55:00.000Z",
    }),
  );
}

/** Take the key back off every merge write, as the live rows already are. */
function forgetPullRequestNumbers(): void {
  const row = raw
    .prepare("SELECT document FROM queue_state WHERE github_repository_id = ? AND base_ref = ?")
    .get("1", REF) as { document: string };
  const doc = JSON.parse(row.document) as { mergeOperations: Array<Record<string, unknown>> };
  for (const op of doc.mergeOperations) delete op.pullRequestNumber;
  raw
    .prepare("UPDATE queue_state SET document = ? WHERE github_repository_id = ? AND base_ref = ?")
    .run(JSON.stringify(doc), "1", REF);
}

function recordDepsThatRecord(): RecordFromIntentDeps<QueueRouteEnv> {
  return {
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
}

/** Nothing waits out the confirmation backoff in a test. */
function readsThatSayMerged(): ReconciliationReads {
  return {
    pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: ORPHAN.mergeSha }),
    baseContainsSha: async () => true,
    pullRequestNumbersForCommit: async () => [ORPHAN.pullRequestNumber],
    commitFacts: async (_env, _repositoryId, sha) => COMMITS[sha] ?? null,
    sleep: async () => {},
  };
}

describe("settling a write the workflow walked away from", () => {
  it("settles a merge write left unresolved by a workflow that exited", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);
    const recordDeps = recordDepsThatRecord();

    const result = await tickAllQueues(
      e,
      { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 },
      readsThatSayMerged(),
      recordDeps,
    );

    expect(result.settledWrites).toBe(1);
    const remaining = await withQueueState(db, "1", REF, async (store) =>
      store.unresolvedMergeOperations(new Date().toISOString()),
    );
    expect(remaining).toEqual([]);
  });

  /**
   * What the four stranded rows actually look like in production D1: no
   * `pullRequestNumber` key at all, because they were written before the row
   * carried one. A sweep that reads that absence as a number asks GitHub about
   * pull request `undefined`, is refused, and leaves the row exactly where it
   * found it on every tick forever.
   */
  it("settles a write whose row never carried a pull request number", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);
    forgetPullRequestNumbers();

    const asked: number[] = [];
    const reads: ReconciliationReads = {
      ...readsThatSayMerged(),
      pullRequestNumbersForCommit: async () => [ORPHAN.pullRequestNumber],
      pullRequestMergeState: async (_env, _repositoryId, pullRequestNumber) => {
        asked.push(pullRequestNumber);
        return { merged: true, mergeCommitSha: ORPHAN.mergeSha };
      },
    };

    const result = await tickAllQueues(
      e,
      { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 },
      reads,
      recordDepsThatRecord(),
    );

    expect(asked).toEqual([ORPHAN.pullRequestNumber]);
    expect(result.settledWrites).toBe(1);
    const remaining = await withQueueState(db, "1", REF, async (store) =>
      store.unresolvedMergeOperations(new Date().toISOString()),
    );
    expect(remaining).toEqual([]);
  });

  /**
   * A write that landed, was resolved, and never got a record.
   *
   * The obligation to finish a merge write used to end at "resolved", and
   * resolved is not finished: the record is. On 4 August 2026 pull request 183
   * merged under the App's own write, the queue confirmed it, the ancestry read
   * that gates the record had not caught up, and the operation was resolved
   * MERGED with no link in the chain. The sweep looked only at unresolved rows,
   * so nothing owned it and nothing ever came back for it.
   */
  it("records a merge that was resolved and never written down", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);
    await withQueueState(db, "1", REF, async (store) =>
      store.resolveMergeOperation(`merge_${ORPHAN.attemptId}`, "MERGED", new Date().toISOString()),
    );
    expect(await readChain(db, "1", REF)).toHaveLength(0);

    const result = await tickAllQueues(
      e,
      { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {} },
      readsThatSayMerged(),
      recordDepsThatRecord(),
    );

    expect(result.settledWrites).toBe(1);
    expect(await readChain(db, "1", REF)).toHaveLength(1);
  });

  /** And it stops asking once the record is there. */
  it("leaves a merge that already has its record alone", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);

    const ports = { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {} };
    await tickAllQueues(e, ports, readsThatSayMerged(), recordDepsThatRecord());
    const again = await tickAllQueues(e, ports, readsThatSayMerged(), recordDepsThatRecord());

    expect(again.settledWrites).toBe(0);
    expect(await readChain(db, "1", REF)).toHaveLength(1);
  });

  /** A row that came back unknown was examined, not settled. */
  it("counts only the writes it actually settled", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await beginWrite(db, ORPHAN.pullRequestNumber);

    const result = await tickAllQueues(
      e,
      { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 },
      { ...readsThatSayMerged(), pullRequestMergeState: async () => null, baseContainsSha: async () => null },
      recordDepsThatRecord(),
    );

    expect(result.settledWrites).toBe(0);
    const remaining = await withQueueState(db, "1", REF, async (store) =>
      store.unresolvedMergeOperations(new Date().toISOString()),
    );
    expect(remaining).toHaveLength(1);
  });

  /**
   * The sweep is bounded because the tick is. Every write costs GitHub
   * subrequests, this account stays inside the free tier on purpose, and a
   * per-invocation cap that the whole tick fails against would take the clock
   * and the lane driving down with the backlog.
   */
  it("settles at most five writes for one queue in one tick", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    for (let i = 0; i < 7; i += 1) await beginWrite(db, 200 + i, ORPHAN, `merge_att_${i}`);

    const asked = new Set<number>();
    await tickAllQueues(
      e,
      { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 },
      {
        ...readsThatSayMerged(),
        pullRequestMergeState: async (_env, _repositoryId, pullRequestNumber) => {
          asked.add(pullRequestNumber);
          return null;
        },
        baseContainsSha: async () => null,
      },
      recordDepsThatRecord(),
    );

    expect(asked.size).toBe(5);
  });

  /**
   * The sweep reads GitHub and writes the chain, and both can throw. A queue
   * with a write it cannot settle must still have its turn driven, or one
   * stranded row stops that queue moving at all.
   */
  it("drives the held turn even when settling a write throws", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await offeredEntry(db, "1", "entry_a", "alice", 41);
    await beginWrite(db, ORPHAN.pullRequestNumber);

    let drives = 0;
    const failures: string[] = [];
    const result = await tickAllQueues(
      e,
      {
        driveTurn: async () => void drives++,
        onQueueTicked: () => {},
        onQueueFailed: (repositoryId) => failures.push(repositoryId),
        reconsiderHead: async () => 0,
      },
      {
        ...readsThatSayMerged(),
        pullRequestMergeState: async () => {
          throw new Error("GitHub is unreachable");
        },
      },
      recordDepsThatRecord(),
    );

    expect(drives).toBe(1);
    expect(result.driven).toBe(1);
    expect(failures).toEqual(["1"]);
  });
});

describe("the chain check reads the keys the sweep just minted", () => {
  /**
   * `sweepOrphanedWrites` (scheduled-tick.ts) can call `recordMergeFromIntent`,
   * which signs through `serviceKey()` and inserts a row into `service_keys`
   * the first time this isolate uses that kid. The chain check for the same
   * queue runs later in the same tick. A key set read once before the
   * per-queue loop is the key set from before that insert, so the record the
   * sweep just signed correctly reads as unverifiable — a false `BAD_SIGNATURE`
   * on the exact signal this whole feature exists to make trustworthy.
   */
  it("does not report BAD_SIGNATURE for a record the sweep just signed with a key minted this tick", async () => {
    const e = await envWithSigningKey();
    const db = e.DB as unknown as D1Like;
    queue("1", 1, 1);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);

    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));

    const result = await tickAllQueues(
      e,
      { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 },
      readsThatSayMerged(),
      recordDepsThatSignForReal(),
    );

    vi.restoreAllMocks();

    expect(result.settledWrites).toBe(1);
    const badSignature = errors.filter((args) => String(args[0]).includes("BAD_SIGNATURE"));
    expect(badSignature).toEqual([]);
    expect(result.chainFindings).toBe(0);
  });
});

describe("tickAllQueues reads the queue's own chain", () => {
  /**
   * The regression this guards is a tick that always reports `chainFindings: 0`
   * whether the chain is broken or not — wrong argument, wrong table, wrong
   * ref, or the check never called. Every existing test in this file passes
   * through the chain check incidentally, against an empty chain, asserting
   * nothing about it; none would catch that regression.
   */
  it("reports a base discontinuity found in the queue's own stored chain, and logs it", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1, 1);

    // Two merges recorded through the production write path
    // (`seedIntent` / `beginWrite` / `sweepOrphanedWrites`), whose base moves
    // share nothing: `ORPHAN` leaves `ORPHAN.baseSha` for `ORPHAN.mergeSha`,
    // `ORPHAN_B` leaves `ORPHAN_B.baseSha` for `ORPHAN_B.mergeSha`. Two real,
    // signed links whose edges cannot join into one path.
    await seedIntent(ORPHAN);
    await beginWrite(db, ORPHAN.pullRequestNumber, ORPHAN);
    await seedIntent(ORPHAN_B);
    await beginWrite(db, ORPHAN_B.pullRequestNumber, ORPHAN_B);

    const commits = commitsFor(ORPHAN, ORPHAN_B);
    const recordDeps: RecordFromIntentDeps<QueueRouteEnv> = {
      ...recordDepsThatRecord(),
      commitFacts: async (_env, _repositoryId, sha) => commits[sha] ?? null,
    };
    const reads: ReconciliationReads = {
      ...readsThatSayMerged(),
      pullRequestNumbersForCommit: async (_env, _repositoryId, sha) =>
        sha === ORPHAN_B.mergeSha ? [ORPHAN_B.pullRequestNumber] : [ORPHAN.pullRequestNumber],
      pullRequestMergeState: async (_env, _repositoryId, pullRequestNumber) =>
        pullRequestNumber === ORPHAN_B.pullRequestNumber
          ? { merged: true, mergeCommitSha: ORPHAN_B.mergeSha }
          : { merged: true, mergeCommitSha: ORPHAN.mergeSha },
    };

    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));

    const result = await tickAllQueues(
      e,
      { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 },
      reads,
      recordDeps,
    );

    vi.restoreAllMocks();

    expect(result.settledWrites).toBe(2);
    expect(result.chainFindings).toBeGreaterThan(0);
    expect(
      errors.some(
        (args) => String(args[0]).includes("chain finding") && String(args[0]).includes("BASE_DISCONTINUITY"),
      ),
    ).toBe(true);
  });

  it("finds nothing on a queue whose stored chain is intact", async () => {
    const e = await envWithSigningKey();
    const db = e.DB as unknown as D1Like;
    queue("1", 1, 1);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);

    const result = await tickAllQueues(
      e,
      { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 },
      readsThatSayMerged(),
      recordDepsThatSignForReal(),
    );

    expect(result.settledWrites).toBe(1);
    expect(result.chainFindings).toBe(0);
    // `readChain` is what the check actually reads; a passing count with no
    // link behind it would be as hollow as the regression this suite exists
    // to catch.
    const links = await readChain(db, "1", REF);
    expect(links).toHaveLength(1);
  });

  it("reports NOTHING_CHECKED for a chain entirely below epochStartsAt, rather than a silent zero", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    // Every link this tick will read sits below this epoch, so the walk
    // verifies no signature at all — the shape a caller reading only
    // `chainFindings === 0` would mistake for a clean chain.
    queue("1", 1, 999);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);

    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));

    const result = await tickAllQueues(
      e,
      { driveTurn: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0 },
      readsThatSayMerged(),
      recordDepsThatRecord(),
    );

    vi.restoreAllMocks();

    expect(result.settledWrites).toBe(1);
    expect(result.chainFindings).toBeGreaterThan(0);
    expect(
      errors.some((args) => String(args[0]).includes("chain finding") && String(args[0]).includes("NOTHING_CHECKED")),
    ).toBe(true);
  });
});
