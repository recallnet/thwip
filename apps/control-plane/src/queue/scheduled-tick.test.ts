// apps/control-plane/src/queue/scheduled-tick.test.ts
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import type { Sha256 } from "@thwip/queue-protocol";
import { seedActiveProject, testD1 } from "../../test/d1.js";
import { tickAllQueues } from "./scheduled-tick.js";
import { runOnQueue, type QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";
import { commandsFor, buildSnapshot } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import { recordHeartbeat } from "./runners.js";
import { readChain, signReusedIntent } from "./attestation.js";
import { recordMergeFromIntent, type RecordFromIntentDeps } from "./record-from-intent.js";
import type { ReconciliationReads } from "./deadlines.js";
import { serviceKey } from "../service-signing.js";
import type { Env } from "../env.js";
import { mergeCommitText } from "./merge-commit.js";

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
let fixtureSigningKey: CryptoKey;
let fixturePublicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  fixtureSigningKey = pair.privateKey;
  fixturePublicJwk = { ...(await exportJWK(pair.publicKey)), kid: "scheduled-tick-fixture", alg: "ES256" };
});

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw
    .prepare("INSERT OR IGNORE INTO service_keys (kid, public_jwk) VALUES (?, ?)")
    .run(fixturePublicJwk.kid, JSON.stringify(fixturePublicJwk));
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
 * than stubbing the queue driver in a way the code under test never reaches.
 */
function withFailingRepository(db: D1Like, repositoryId: string): D1Like {
  return {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => {
        // Let the lifecycle lease be acquired so the injected repository
        // failure still happens inside the queue's per-row recovery boundary.
        // The test is about isolating one broken queue, not about the lease
        // helper's own database error propagation.
        const fails = !query.includes("project_write_leases") && values.includes(repositoryId);
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
  const projectId = seedActiveProject(
    { raw },
    { repositoryId, organizationId: "org_1", projectId: `prj_${repositoryId}`, githubName: "recallnet/thwip" },
  );
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, attested_from_sequence, project_id)
       VALUES (?, 'org_1', ?, 'refs/heads/main', ?, 'enforced', ?, ?)`,
    )
    .run(`qp_${repositoryId}`, repositoryId, enabled, epochStartsAt, projectId);
}

/** An active policy bundle naming `securityProfile`, for `readActivePolicy`. */
function activePolicy(repositoryId: string, securityProfile: string) {
  const digest = `sha256:${"b".repeat(64)}`;
  raw
    .prepare(
      `UPDATE projects
          SET active_policy_digest = ?, security_profile = ?, enabled = 1
        WHERE id = ? AND github_repository_id = ?`,
    )
    .run(digest, securityProfile, `prj_${repositoryId}`, repositoryId);
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
      driveQueue: async () => {},
      onQueueTicked: (repositoryId) => visited.push(repositoryId),
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
    });
    expect(visited.sort()).toEqual(["1", "2"]);
    expect(result.ticked).toBe(2);
  });

  it("ticks every queue before running a bounded rotating maintenance pass", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    queue("3", 1);
    const order: string[] = [];
    const result = await tickAllQueues(e, {
      maintenanceQueuesPerTick: 1,
      driveQueue: async () => {},
      onQueueTicked: (repositoryId) => order.push(`tick:${repositoryId}`),
      onQueueFailed: () => {},
      reconsiderHead: async () => 0,
      publishStatusComments: async (repositoryId) => void order.push(`maintain:${repositoryId}`),
      retireStatusComments: async () => {},
    });

    expect(result.ticked).toBe(3);
    expect(order.filter((event) => event.startsWith("tick:"))).toEqual(["tick:1", "tick:2", "tick:3"]);
    expect(order.filter((event) => event.startsWith("maintain:"))).toHaveLength(1);
    expect(order.findIndex((event) => event.startsWith("maintain:"))).toBeGreaterThan(
      order.findLastIndex((event) => event.startsWith("tick:")),
    );
  });

  it("can skip maintenance without skipping any queue clock", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    const ticked: string[] = [];
    let maintained = 0;
    const result = await tickAllQueues(e, {
      maintenanceQueuesPerTick: 0,
      driveQueue: async () => {},
      onQueueTicked: (repositoryId) => ticked.push(repositoryId),
      onQueueFailed: () => {},
      reconsiderHead: async () => 0,
      publishStatusComments: async () => void maintained++,
      retireStatusComments: async () => {},
    });

    expect(result.ticked).toBe(2);
    expect(ticked).toEqual(["1", "2"]);
    expect(maintained).toBe(0);
  });

  it("leaves a disabled queue alone", async () => {
    const e = env();
    queue("1", 0);
    const result = await tickAllQueues(e, {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
    });
    expect(result.ticked).toBe(0);
  });

  /** A lane nobody holds needs no App continuation. */
  /**
   * The condition under which the clock stopped and nobody could say why.
   *
   * Every lane was paused for the App-native cutover on 5 August, so no queue
   * had eligible work and none was driven. A pass that only recorded itself when
   * it moved something would have reported an idle fleet as a stopped clock,
   * which is exactly the reading that cost eleven hours: the health clock said
   * "stale" and the cause was a paused fleet doing nothing wrong.
   */
  it("ticks a paused queue, so a quiet fleet is not read as a stopped clock", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    for (const repositoryId of ["1", "2"]) {
      await withQueueState(e.DB as unknown as D1Like, repositoryId, "refs/heads/main", (store) => {
        commandsFor(store).pause({
          idempotencyKey: `pause:${repositoryId}`,
          actorPrincipalId: "operator",
          reason: "the cutover is under way",
        });
      });
    }

    const result = await tickAllQueues(e, {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
    });

    expect(result.ticked).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("drives nobody when no lane is held", async () => {
    const e = env();
    queue("1", 1);
    let drives = 0;
    await tickAllQueues(e, {
      driveQueue: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
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
    // stubbing the queue driver, which is never called when no lane is held.
    const failingEnv = { ...e, DB: withFailingRepository(e.DB as unknown as D1Like, "1") } as unknown as QueueRouteEnv;
    const failures: Array<{ repositoryId: string; error: unknown }> = [];
    const ticked: string[] = [];
    const result = await tickAllQueues(failingEnv, {
      driveQueue: async () => {},
      onQueueTicked: (repositoryId) => ticked.push(repositoryId),
      onQueueFailed: (repositoryId, error) => failures.push({ repositoryId, error }),
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
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

describe("terminal pull requests missed by the webhook", () => {
  it("republishes the queue and status snapshot after cancelling a closed entry", async () => {
    const e = env();
    queue("1", 1);
    await blockedEntry(e.DB as unknown as D1Like, "1", "entry_a", 56, "REVIEW_REQUIRED");
    const published: Array<{ state: string }[]> = [];

    const result = await tickAllQueues(
      e,
      {
        driveQueue: async () => {},
        onQueueTicked: () => {},
        onQueueFailed: () => {},
        reconsiderHead: async () => 0,
        publishStatusComments: async (_repositoryId, _baseRef, snapshot) => {
          published.push(snapshot.entries.map((entry) => ({ state: entry.state })));
        },
        retireStatusComments: async () => {},
      },
      readsThatSayMerged(),
      recordDepsThatRecord(),
      {
        pullRequestState: async () => ({
          state: "closed",
          merged: false,
          mergeCommitSha: null,
          headSha: "h".repeat(40),
        }),
      },
    );

    expect(result).toMatchObject({ terminalEntriesExamined: 1, terminalEntriesReconciled: 1 });
    expect(published.at(-1)).toEqual([{ state: "Cancelled" }]);
    const projected = await (e.DB as unknown as D1Like)
      .prepare(
        "SELECT state FROM queue_entries_index WHERE github_repository_id = ? AND base_ref = ? AND entry_id = ?",
      )
      .bind("1", REF, "entry_a")
      .first<{ state: string }>();
    expect(projected?.state).toBe("Cancelled");
  });

  it("publishes the committed terminal status before a later lane drive fails", async () => {
    const e = env();
    queue("1", 1);
    await runOnQueue(e, "1", REF, async ({ commands }) => {
      for (const [entryId, pr, sponsor] of [
        ["entry_closed", 56, "alice"],
        ["entry_next", 57, "bob"],
      ] as const) {
        commands.requestQueue({
          idempotencyKey: `req-${entryId}`,
          entryId,
          pullRequestNumber: pr,
          sponsorPrincipalId: sponsor,
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
      }
      await commands.tick({ idempotencyKey: "offer-closed-entry" });
    });
    const published: string[][] = [];
    let drives = 0;

    const result = await tickAllQueues(
      e,
      {
        driveQueue: async () => {
          drives += 1;
          if (drives > 1) throw new Error("injected drive failure after repair");
        },
        onQueueTicked: () => {},
        onQueueFailed: () => {},
        reconsiderHead: async () => 0,
        publishStatusComments: async (_repositoryId, _baseRef, snapshot) => {
          published.push(snapshot.entries.map((entry) => entry.state));
        },
        retireStatusComments: async () => {},
      },
      readsThatSayMerged(),
      recordDepsThatRecord(),
      {
        pullRequestState: async (_environment, _repositoryId, pullRequestNumber) => ({
          state: pullRequestNumber === 56 ? "closed" : "open",
          merged: false,
          mergeCommitSha: null,
          headSha: "h".repeat(40),
        }),
      },
    );

    expect(result.failed).toBe(1);
    expect(published.at(-1)).toEqual(["Cancelled", "Offered"]);
  });

  it("reconciles a closed lane holder even when its first drive fails", async () => {
    const e = env();
    queue("1", 1);
    await runOnQueue(e, "1", REF, async ({ commands }) => {
      commands.requestQueue({
        idempotencyKey: "req-closed-holder",
        entryId: "entry_closed",
        pullRequestNumber: 56,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "56",
        headSha: "h".repeat(40),
      });
      commands.evaluateReadiness({
        idempotencyKey: "ready-closed-holder",
        entryId: "entry_closed",
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
      });
      await commands.tick({ idempotencyKey: "offer-closed-holder" });
    });
    const db = e.DB as unknown as D1Like;
    const published: string[][] = [];
    const failed: unknown[] = [];
    let pullRequestReads = 0;

    const result = await tickAllQueues(
      e,
      {
        driveQueue: async () => {
          throw new Error("injected first drive failure");
        },
        onQueueTicked: () => {},
        onQueueFailed: (_repositoryId, error) => failed.push(error),
        reconsiderHead: async () => 0,
        publishStatusComments: async (_repositoryId, _baseRef, snapshot) => {
          published.push(snapshot.entries.map((entry) => entry.state));
        },
        retireStatusComments: async () => {},
      },
      readsThatSayMerged(),
      recordDepsThatRecord(),
      {
        pullRequestState: async () => {
          pullRequestReads += 1;
          return {
            state: "closed",
            merged: false,
            mergeCommitSha: null,
            headSha: "h".repeat(40),
          };
        },
      },
    );

    expect(result).toMatchObject({
      failed: 1,
      driven: 0,
      terminalEntriesExamined: 1,
      terminalEntriesReconciled: 1,
    });
    expect(failed).toHaveLength(1);
    expect(pullRequestReads).toBe(1);
    expect(published.at(-1)).toEqual(["Cancelled"]);
    const projected = await db
      .prepare(
        "SELECT state FROM queue_entries_index WHERE github_repository_id = ? AND base_ref = ? AND entry_id = ?",
      )
      .bind("1", REF, "entry_closed")
      .first<{ state: string }>();
    expect(projected?.state).toBe("Cancelled");
  });
});

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
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async (repositoryId, headSha) => {
        asked.push({ repositoryId, headSha });
        return 1;
      },
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
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
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => {
        asked += 1;
        return 1;
      },
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
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
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => {
        asked += 1;
        return 1;
      },
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
    });
    expect(asked).toBe(0);
  });

  it("spends no GitHub read on a queue with nothing blocked", async () => {
    const e = env();
    queue("1", 1);
    await readyEntry(e.DB as unknown as D1Like, "1", "entry_a", "alice", 41);
    let asked = 0;
    await tickAllQueues(e, {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => {
        asked += 1;
        return 1;
      },
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
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
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => {
        asked += 1;
        return 1;
      },
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
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
      driveQueue: async () => {},
      onQueueTicked: (repositoryId) => ticked.push(repositoryId),
      onQueueFailed: () => {},
      reconsiderHead: async () => {
        throw new Error("GitHub is unreachable");
      },
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
    });
    expect(ticked.sort()).toEqual(["1", "2"]);
    expect(result.readinessRechecked).toBe(0);
  });
});

describe("stale-runner retirement on the tick", () => {
  it.each(["fresh", "audited"])(
    "retires a runner under %s, makes its entries ineligible, and keeps their fairness ordinal",
    async (profile) => {
      const e = env();
      queue("1", 1);
      activePolicy("1", profile);
      const db = e.DB as unknown as D1Like;

      await readyEntry(db, "1", "entry_a", "alice", 41);
      const before = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
      const ordinalBefore = entryFrom(before, "entry_a")?.fairnessOrdinal;
      expect(ordinalBefore).toBeDefined();

      await recordHeartbeat(db, {
        repositoryId: "1",
        principalId: "alice",
        deviceKeyId: "d1",
        now: new Date().toISOString(),
      });
      ageHeartbeats(raw);

      await tickAllQueues(e, {
        driveQueue: async () => {},
        onQueueTicked: () => {},
        onQueueFailed: () => {},
        reconsiderHead: async () => 0,
        publishStatusComments: async () => {},
        retireStatusComments: async () => {},
      });

      const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
      const entry = entryFrom(after, "entry_a");
      expect(entry?.schedulerEligible).toBe(false);
      expect(entry?.primaryReason).toBe("AGENT_OFFLINE");
      expect(entry?.fairnessOrdinal).toBe(ordinalBefore);
    },
  );

  it.each(["fast", "remote"])("does not apply stale device presence to a %s entry", async (profile) => {
    const e = env();
    queue("1", 1);
    activePolicy("1", profile);
    const db = e.DB as unknown as D1Like;

    await readyEntry(db, "1", "entry_a", "alice", 41);
    await recordHeartbeat(db, {
      repositoryId: "1",
      principalId: "alice",
      deviceKeyId: "d1",
      now: new Date().toISOString(),
    });
    ageHeartbeats(raw);

    await tickAllQueues(e, {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0,
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
    });

    const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(entryFrom(after, "entry_a")).toMatchObject({
      schedulerEligible: true,
      primaryReason: null,
    });
  });

  it("an offline entry does not block a Ready entry behind it", async () => {
    const e = env();
    queue("1", 1);
    activePolicy("1", "fresh");
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
    await tickAllQueues(e, { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, });

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
    activePolicy("1", "fresh");
    const db = e.DB as unknown as D1Like;

    await readyEntry(db, "1", "entry_a", "alice", 41);
    await recordHeartbeat(db, { repositoryId: "1", principalId: "alice", deviceKeyId: "d1", now: new Date().toISOString() });

    await tickAllQueues(e, { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, });

    const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(entryFrom(after, "entry_a")?.schedulerEligible).toBe(true);
  });
});

describe("driving a held lane against the active profile", () => {
  it("asks the App to re-evaluate a device-only offer without changing its state", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    activePolicy("1", "fresh");
    await offeredEntry(db, "1", "entry_a", "alice", 41);

    let drives = 0;
    const result = await tickAllQueues(e, {
      driveQueue: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
    });

    const after = await withQueueState(db, "1", REF, (store) => buildSnapshot(store));
    expect(entryFrom(after, "entry_a")?.state).toBe("Offered");
    expect(drives).toBe(1);
    expect(result.driven).toBe(1);
  });

  it("asks the App to continue a server-executable lane", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    activePolicy("1", "fast");
    await offeredEntry(db, "1", "entry_a", "alice", 41);

    let drives = 0;
    const result = await tickAllQueues(e, {
      driveQueue: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
    });

    expect(drives).toBe(1);
    expect(result.driven).toBe(1);
  });

  it("asks the App to merge after a device-only run is answered", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    activePolicy("1", "fresh");
    await verifyingEntry(db, "1", "entry_a", "alice", 41);

    let drives = 0;
    const result = await tickAllQueues(e, {
      driveQueue: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
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
      driveQueue: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
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
      driveQueue: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
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
      driveQueue: async () => void drives++,
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
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

    await tickAllQueues(e, { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, });

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
function commitsFor(
  ...shapes: readonly OrphanShape[]
): Record<string, { treeOid: string; parentShas: string[]; message: string }> {
  const commits: Record<string, { treeOid: string; parentShas: string[]; message: string }> = {};
  for (const shape of shapes) {
    commits[shape.baseSha] = { treeOid: shape.beforeTree, parentShas: ["5c".repeat(20)], message: "base" };
    commits[shape.mergeSha] = {
      treeOid: shape.treeOid,
      parentShas: [shape.baseSha, shape.headSha],
      message: mergeCommitText(shape.pullRequestNumber, `merge_${shape.attemptId}`),
    };
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
    // Signed-record schema compatibility; the runtime path always writes merge commits.
    mergeMethod: "merge",
    evidence: {
      workReceiptDigest: `sha256:${"1".repeat(64)}` as Sha256,
      organizationId: "org_acme",
      policyDigest: `sha256:${"2".repeat(64)}` as Sha256,
      pipelineDigest: `sha256:${"3".repeat(64)}` as Sha256,
      requiredSuitesDigest: `sha256:${"4".repeat(64)}` as Sha256,
      proofCheckRunId: "91289436271",
    },
    createdAt: "2026-08-02T07:50:00.000Z",
    signer: { sign: async () => "jws-intent" },
  });
  if ("error" in signed) throw new Error(signed.error);
  raw
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws, created_at, project_id)
       VALUES (?, 'merge-intent', ?, ?, NULL, ?, ?, ?, ?, 'prj_1')`,
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
    pullRequestMergeState: async (_env, _repositoryId, pullRequestNumber) => {
      const shape = [ORPHAN, ORPHAN_B].find((candidate) => candidate.pullRequestNumber === pullRequestNumber);
      return { merged: shape !== undefined, mergeCommitSha: shape?.mergeSha ?? null };
    },
    activePolicy: async () => ({
      projectId: "prj_1",
      policyDigest: `sha256:${"2".repeat(64)}`,
      pipelineDigest: `sha256:${"3".repeat(64)}`,
      requiredSuites: ["unit"],
      organizationId: "org_acme",
    }),
    signRecordBytes: async (_environment, bytes, typ) =>
      new CompactSign(bytes)
        .setProtectedHeader({ alg: "ES256", kid: fixturePublicJwk.kid, typ })
        .sign(fixtureSigningKey),
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

describe("settling a merge write whose response was lost", () => {
  it("settles a merge write left unresolved by an interrupted request", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);
    const recordDeps = recordDepsThatRecord();

    const result = await tickAllQueues(
      e,
      { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, },
      readsThatSayMerged(),
      recordDeps,
    );

    expect(result.settledWrites).toBe(1);
    const remaining = await withQueueState(db, "1", REF, async (store) =>
      store.unresolvedMergeOperations(new Date().toISOString(), new Date().toISOString()),
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
      { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, },
      reads,
      recordDepsThatRecord(),
    );

    expect(asked).toEqual([ORPHAN.pullRequestNumber]);
    expect(result.settledWrites).toBe(1);
    const remaining = await withQueueState(db, "1", REF, async (store) =>
      store.unresolvedMergeOperations(new Date().toISOString(), new Date().toISOString()),
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
      {
        driveQueue: async () => {},
        onQueueTicked: () => {},
        onQueueFailed: () => {},
        reconsiderHead: async () => 0,
        publishStatusComments: async () => {},
        retireStatusComments: async () => {},
      },
      readsThatSayMerged(),
      recordDepsThatRecord(),
    );

    expect(result.settledWrites).toBe(1);
    expect(await readChain(db, "1", REF)).toHaveLength(1);
  });

  it("repairs a settled merge whose legacy positioned row has no durable queue link", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);
    await withQueueState(db, "1", REF, async (store) =>
      store.resolveMergeOperation(`merge_${ORPHAN.attemptId}`, "MERGED", new Date().toISOString()),
    );
    const input = {
      repositoryId: "1",
      baseRef: REF,
      mergeSha: ORPHAN.mergeSha,
      witnessPrincipalId: "prn_thwip_service",
      reason: "seed the legacy positioned row",
      attemptId: ORPHAN.attemptId,
    };
    const legacy = await recordMergeFromIntent(e, recordDepsThatRecord(), input);
    if (legacy.status !== "recorded") throw new Error("the legacy record fixture did not record");

    // This is the old store-before-link crash shape: D1 says the attestation is
    // positioned, but neither the queue authority nor its durable link index
    // carries it. Recreate the settled operation so the scheduled sweep owns
    // the missing transition.
    raw.prepare("DELETE FROM queue_transitions_index").run();
    raw.prepare("DELETE FROM queue_state").run();
    raw.prepare("DELETE FROM queue_projection_marks").run();
    await beginWrite(db, ORPHAN.pullRequestNumber);
    await withQueueState(db, "1", REF, async (store) =>
      store.resolveMergeOperation(`merge_${ORPHAN.attemptId}`, "MERGED", new Date().toISOString()),
    );

    const result = await tickAllQueues(
      e,
      {
        driveQueue: async () => {},
        onQueueTicked: () => {},
        onQueueFailed: () => {},
        reconsiderHead: async () => 0,
        publishStatusComments: async () => {},
        retireStatusComments: async () => {},
      },
      readsThatSayMerged(),
      recordDepsThatRecord(),
    );

    expect(result.settledWrites).toBe(1);
    const chain = await readChain(db, "1", REF);
    expect(chain).toHaveLength(1);
    // The authentic staged bytes are recovered. Re-signing here would leave a
    // second durable record for the same merge after exactly the crash window
    // this repair owns.
    expect(chain[0]?.digest).toBe(legacy.transitionDigest);
    expect(raw.prepare("SELECT digest FROM queue_attestations WHERE kind LIKE '%merge'").all()).toHaveLength(1);
    expect(
      raw.prepare("SELECT transition_sequence AS sequence FROM queue_attestations WHERE digest = ?").get(legacy.transitionDigest),
    ).toEqual({ sequence: 1 });
  });

  /**
   * What re-epoching this repository did on 5 August, before this was fixed.
   *
   * The attested range moved past every existing record, and the two lookups
   * that answer "does the chain hold this merge" were scoped to the current
   * range. Fifty-nine merges recorded below it read back as unrecorded, and the
   * sweep began writing a second record for each at the head, so the new range
   * said the base had moved to a commit the branch had left days before.
   *
   * A range boundary says which records a verifier is asked to check. It does
   * not un-record a merge.
   */
  it("writes no second record for a merge the chain holds behind the attested range", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);

    const ports = {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0,
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
    };
    await tickAllQueues(e, ports, readsThatSayMerged(), recordDepsThatRecord());
    const recorded = await readChain(db, "1", REF);
    expect(recorded).toHaveLength(1);

    // The range moves past it, the way `/re-epoch` moves it.
    raw
      .prepare("UPDATE queue_projects SET attested_from_sequence = 99 WHERE github_repository_id = ?")
      .run("1");

    const again = await tickAllQueues(e, ports, readsThatSayMerged(), recordDepsThatRecord());

    expect(again.settledWrites).toBe(0);
    expect(await readChain(db, "1", REF)).toHaveLength(1);
  });

  /** And it stops asking once the record is there. */
  it("leaves a merge that already has its record alone", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await seedIntent();
    await beginWrite(db, ORPHAN.pullRequestNumber);

    const ports = {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0,
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
    };
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
      { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, },
      { ...readsThatSayMerged(), pullRequestMergeState: async () => null, baseContainsSha: async () => null },
      recordDepsThatRecord(),
    );

    expect(result.settledWrites).toBe(0);
    // The row is open and named. It waits out a backoff before the sweep reads
    // GitHub about it again, so it is read from the full list rather than from
    // the sweep's own selection.
    const remaining = await withQueueState(db, "1", REF, async (store) => store.mergeOperations());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ outcome: null });
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
      { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, },
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
   * What four merge operations on this repository cost, tick after tick.
   *
   * Each was examined every five minutes, refused every time for the same
   * reason, and each refusal ran the full three-round absence backoff. The
   * sweep spent its GitHub budget on them before it reached a write nobody had
   * looked at, and on 4 August that spent the invocation's subrequests and
   * failed both queues. Nothing about a row changes between two ticks five
   * minutes apart, so the second read could never have learned anything the
   * first did not.
   */
  it("spends no GitHub reads on a write it examined and refused last tick", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    queue("1", 1);
    await beginWrite(db, ORPHAN.pullRequestNumber);

    let asked = 0;
    const reads = {
      ...readsThatSayMerged(),
      // Merged with no commit named: the arm that can never conclude. It is
      // exactly the shape of the four writes that would not clear.
      pullRequestMergeState: async () => {
        asked += 1;
        return { merged: true, mergeCommitSha: null };
      },
      baseContainsSha: async () => {
        asked += 1;
        return null;
      },
    };
    const ports = {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0,
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
    };

    await tickAllQueues(e, ports, reads, recordDepsThatRecord());
    expect(asked).toBeGreaterThan(0);

    const spentOnce = asked;
    await tickAllQueues(e, ports, reads, recordDepsThatRecord());
    expect(asked).toBe(spentOnce);

    // Held back, and still open, still named, with the reason it was refused
    // for. A write nobody can settle stays visible.
    const [row] = await withQueueState(db, "1", REF, async (store) => store.mergeOperations());
    expect(row).toMatchObject({ outcome: null, refusalCount: 1 });
    expect(row!.refusalReason).toMatch(/named no commit/);
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
        driveQueue: async () => void drives++,
        onQueueTicked: () => {},
        onQueueFailed: (repositoryId) => failures.push(repositoryId),
        reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {},
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
      { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, },
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
      { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, },
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
      { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, },
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
      { driveQueue: async () => {}, onQueueTicked: () => {}, onQueueFailed: () => {}, reconsiderHead: async () => 0, publishStatusComments: async () => {}, retireStatusComments: async () => {}, },
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

/**
 * A comment nobody rewrote.
 *
 * This is the defect family this repository keeps producing: a surface that
 * answered correctly once and goes on displaying that answer as current. The
 * comment is written on transition, and a transition whose write GitHub refused
 * leaves the page behind the queue with nothing that owns coming back for it.
 * The tick already enumerates every enabled queue, so it is what comes back.
 */
describe("the status comments the heartbeat keeps in step", () => {
  function tickPorts(over: Partial<Parameters<typeof tickAllQueues>[1]> = {}) {
    return {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0,
      publishStatusComments: async () => {},
      retireStatusComments: async () => {},
      ...over,
    };
  }

  it("hands every enabled queue's snapshot to the comment publisher", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    const seen: string[] = [];

    await tickAllQueues(
      e,
      tickPorts({ publishStatusComments: async (repositoryId: string) => void seen.push(repositoryId) }),
    );

    expect(seen.sort()).toEqual(["1", "2"]);
  });

  it("does not go near a queue that is switched off", async () => {
    const e = env();
    queue("1", 0);
    const seen: string[] = [];

    await tickAllQueues(
      e,
      tickPorts({ publishStatusComments: async (repositoryId: string) => void seen.push(repositoryId) }),
    );

    expect(seen).toEqual([]);
  });

  /**
   * A project disabled after a comment exists. Freezing on the last state that
   * was true would leave the page claiming a place in a line nothing tracks.
   */
  it("retires the comments left on a branch the queue has stopped managing", async () => {
    const e = env();
    queue("1", 0);
    raw
      .prepare(
        "INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at, project_id) VALUES (?, ?, ?, ?, ?, ?, 'prj_1')",
      )
      .run("1", REF, 184, 500, "abcd1234", "2026-08-04T21:00:00.000Z");
    const retired: Array<{ repositoryId: string; numbers: readonly number[] }> = [];

    const result = await tickAllQueues(
      e,
      tickPorts({
        retireStatusComments: async (repositoryId: string, _baseRef: string, numbers: readonly number[]) =>
          void retired.push({ repositoryId, numbers }),
      }),
    );

    expect(retired).toEqual([{ repositoryId: "1", numbers: [184] }]);
    expect(result.retiredComments).toBe(1);
  });

  it("retires each abandoned comment once, so a disabled project is not swept forever", async () => {
    const e = env();
    queue("1", 0);
    raw
      .prepare(
        "INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at, project_id) VALUES (?, ?, ?, ?, ?, ?, 'prj_1')",
      )
      .run("1", REF, 184, 500, "abcd1234", "2026-08-04T21:00:00.000Z");

    await tickAllQueues(e, tickPorts());
    const second = await tickAllQueues(e, tickPorts());

    expect(second.retiredComments).toBe(0);
  });

  it("leaves the comments on a queue that is still running alone", async () => {
    const e = env();
    queue("1", 1);
    raw
      .prepare(
        "INSERT INTO queue_status_comments (github_repository_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at, project_id) VALUES (?, ?, ?, ?, ?, ?, 'prj_1')",
      )
      .run("1", REF, 184, 500, "abcd1234", "2026-08-04T21:00:00.000Z");
    const retired: number[] = [];

    await tickAllQueues(
      e,
      tickPorts({
        retireStatusComments: async (_r: string, _b: string, numbers: readonly number[]) => void retired.push(...numbers),
      }),
    );

    expect(retired).toEqual([]);
  });
});

/**
 * A comment must never cost a queue its tick.
 *
 * On 4 August the first sweep after the comments shipped ran the Worker out of
 * subrequests. The throw came back through the per-queue block and failed both
 * repositories: no lane driven, no write settled, no chain read, over a
 * sentence on a web page.
 */
describe("what a failing comment publisher costs the heartbeat", () => {
  it("ticks the queue anyway and says what went wrong", async () => {
    const e = env();
    queue("1", 1);
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));

    const result = await tickAllQueues(e, {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0,
      publishStatusComments: async () => Promise.reject(new Error("Too many subrequests")),
      retireStatusComments: async () => {},
    });

    vi.restoreAllMocks();

    expect(result.ticked).toBe(1);
    expect(result.failed).toBe(0);
    expect(errors.some((args) => String(args[0]).includes("could not refresh the status comments"))).toBe(true);
  });
});

/**
 * What the whole sweep may spend, rather than what each queue may.
 *
 * A Worker invocation gets fifty subrequests and the sweep shares them across
 * every queue in the fleet, the merge writes it settles and the lanes it
 * drives. A budget handed out per queue multiplies by the fleet: on 4 August
 * eight writes each across two queues, on top of four settled writes, ran the
 * invocation out and failed both queues.
 */
describe("the comment budget the whole sweep works to", () => {
  it("hands every queue the same budget object, so the fleet shares one", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    const budgets: unknown[] = [];

    await tickAllQueues(e, {
      driveQueue: async () => {},
      onQueueTicked: () => {},
      onQueueFailed: () => {},
      reconsiderHead: async () => 0,
      publishStatusComments: async (_r: string, _b: string, _s: unknown, budget: unknown) => void budgets.push(budget),
      retireStatusComments: async () => {},
    });

    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBe(budgets[1]);
    expect(budgets[0]).toEqual({ remaining: expect.any(Number) });
  });
});
