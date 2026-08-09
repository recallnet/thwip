import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkInvariants } from "@thwip/queue-domain";
import { BranchQueueStore } from "./store.js";
import { cellOf, SnapshotQueueStore } from "./snapshot-store.js";
import type { QueueStateStore } from "./store.js";
import type { SqlLike } from "./sql.js";
import { DEFAULT_TIMINGS, QueueCommands } from "./commands.js";

/**
 * The command layer end to end, including the alarm. Time and identifiers are
 * injected so a whole turn can be driven deterministically, which is the only
 * way to assert that an at-least-once alarm is genuinely idempotent.
 */

const open: Array<{ close(): void }> = [];

function sqlite(): SqlLike {
  const db = new Database(":memory:");
  open.push(db);
  return {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      if (statement.reader) return { toArray: () => statement.all(...(bindings as never[])) as T[] };
      statement.run(...(bindings as never[]));
      return { toArray: () => [] as T[] };
    },
  };
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

class Clock {
  constructor(private t = Date.UTC(2026, 6, 29, 12, 0, 0)) {}
  now(): string {
    return new Date(this.t).toISOString();
  }
  advance(seconds: number): void {
    this.t += seconds * 1000;
  }
}

const IDENTITY = { queueKey: "qk", repositoryId: "1315419165", baseRef: "refs/heads/main" };

/** When the clock above starts. */
const START = Date.UTC(2026, 6, 29, 12, 0, 0);

/** An instant this many seconds after the clock started. */
const atOffset = (seconds: number): string => new Date(START + seconds * 1000).toISOString();

/**
 * Far enough past an offer for the sweep to end it, taken from the window
 * rather than written again. A literal here is how the window and the test that
 * checks it drift apart.
 */
const PAST_THE_OFFER = DEFAULT_TIMINGS.offerSeconds + 30;

/** The same, for the other two windows the sweep ends. */
const PAST_THE_GRACE = DEFAULT_TIMINGS.graceSeconds + 30;
const PAST_THE_MERGE_CONFIRM = DEFAULT_TIMINGS.mergeConfirmSeconds + 30;

/**
 * The command layer, over both places the state can live.
 *
 * The commands are where the queue's rules turn into events, so running them
 * only against the Durable Object's SQLite would leave the D1 document trusted
 * on the strength of a store-level comparison alone.
 */
const STORES = [
  { name: "BranchQueueStore", make: () => BranchQueueStore.open(sqlite(), IDENTITY) },
  { name: "SnapshotQueueStore", make: () => SnapshotQueueStore.open(cellOf(), IDENTITY) },
  {
    // Compaction turned up as far as it goes. A command that needed history the
    // queue had dropped would fail here and nowhere else.
    name: "SnapshotQueueStore (compacted hard)",
    make: () => SnapshotQueueStore.open(cellOf(), IDENTITY, { terminalEntries: 1, transitions: 1 }),
  },
];

let makeStore: () => QueueStateStore = STORES[0]!.make;

function harness() {
  const store = makeStore();
  const clock = new Clock();
  let counter = 0;
  const ids = {
    attemptId: () => `att-${++counter}`,
    operationId: () => `op-${++counter}`,
    nonce: () => `nonce-${++counter}`,
    claimToken: () => `tok-${++counter}`,
  };
  return { store, clock, commands: new QueueCommands(store, clock, ids) };
}

/** Pinned to SQLite, for the tests that reach past the store's own surface. */
function sqlHarness() {
  const sql = sqlite();
  const store = BranchQueueStore.open(sql, IDENTITY);
  const clock = new Clock();
  let counter = 0;
  const ids = {
    attemptId: () => `att-${++counter}`,
    operationId: () => `op-${++counter}`,
    nonce: () => `nonce-${++counter}`,
    claimToken: () => `tok-${++counter}`,
  };
  return { sql, store, clock, commands: new QueueCommands(store, clock, ids) };
}

function ready(commands: QueueCommands, entryId: string, principal: string, pr: number) {
  commands.requestQueue({
    idempotencyKey: `req-${entryId}`,
    entryId,
    pullRequestNumber: pr,
    sponsorPrincipalId: principal,
    sponsorGithubUserId: principal === "alice" ? "1" : "2",
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

describe.each(STORES)("QueueCommands over $name", ({ make }) => {
  beforeEach(() => {
    makeStore = make;
  });

  it("reports noop when nothing is eligible", async () => {
    const { commands } = harness();
    expect(await commands.tick({ idempotencyKey: "t1"})).toMatchObject({
      status: "noop",
    });
  });

  it("offers a turn, sets the offer deadline, and queues an outbox item", async () => {
    const { store, commands } = harness();
    ready(commands, "e1", "alice", 7);
    const offered = await commands.tick({ idempotencyKey: "t1"});
    expect(offered.status).toBe("applied");
    expect(store.earliestDeadline()).toBe(atOffset(DEFAULT_TIMINGS.offerSeconds));
    expect(store.pendingOutbox().map((o) => o.kind)).toEqual(["offer-created"]);
  });

  it("refuses a device claim with no device id", async () => {
    const { commands } = harness();
    ready(commands, "e1", "alice", 7);
    const offered = await commands.tick({ idempotencyKey: "t1"}) as { attemptId: string };
    expect(
      commands.claim({ idempotencyKey: "c1", attemptId: offered.attemptId, executionMode: "device" }),
    ).toMatchObject({ status: "rejected" });
  });

  it("lets the server claim its own turn for fast reuse", async () => {
    const { store, commands } = harness();
    ready(commands, "e1", "alice", 7);
    const offered = await commands.tick({ idempotencyKey: "t1"}) as { attemptId: string };
    expect(
      commands.claim({ idempotencyKey: "c1", attemptId: offered.attemptId, executionMode: "fast-reuse" }),
    ).toMatchObject({ status: "applied" });
    expect(store.pendingOutbox().map((o) => o.kind)).toEqual(["offer-created", "start-workflow"]);
  });

  it("drives a full turn to a recorded transition", async () => {
    const { store, commands, clock } = harness();
    ready(commands, "e1", "alice", 7);
    const offered = await commands.tick({ idempotencyKey: "t1"}) as { attemptId: string };
    const attemptId = offered.attemptId;

    commands.claim({ idempotencyKey: "c1", attemptId, executionMode: "device", deviceId: "d1" });
    commands.candidatePrepared({
      idempotencyKey: "p1",
      attemptId,
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
      candidateSha: "c".repeat(40),
      candidateTree: "t".repeat(40),
      policyDigest: "sha256:pol",
      runner: "dagger",
    });
    commands.assign({ idempotencyKey: "a1", attemptId, assignmentDigest: "sha256:asg" });
    commands.heartbeat({ idempotencyKey: "hb-1", attemptId });
    commands.submitReceipt({ idempotencyKey: "r1", attemptId, receiptDigest: "sha256:rcpt" });
    const started = commands.startVerification({ idempotencyKey: "v1", attemptId }) as { nonce: string };
    commands.completeVerification({
      idempotencyKey: "v2",
      attemptId,
      nonce: started.nonce,
      accepted: true,
      resultDigest: "sha256:res",
    });
    commands.createMergeIntent({ idempotencyKey: "i1", attemptId, intentDigest: "sha256:intent" });
    const write = commands.beginMergeWrite({ idempotencyKey: "m1", attemptId, operationId: "op-x" });
    expect(write.status).toBe("applied");
    clock.advance(2);
    await commands.confirmMerge({
      idempotencyKey: "m2",
      attemptId,
      operationId: "op-x",
      mergeSha: "m".repeat(40),
      mergeTree: "t".repeat(40),
      parentShas: ["b".repeat(40), "h".repeat(40)],
    });
    commands.recordTransition({
      idempotencyKey: "tr1",
      kind: "verified",
      transitionSequence: 1,
      priorDigest: null,
      digest: `sha256:${"a".repeat(64)}`,
      baseSha: "m".repeat(40),
      attemptId,
      witnessPrincipalIds: ["alice"],
    });

    const state = store.state();
    expect(state.entries.get("e1")!.state).toBe("Merged");
    expect(state.activeAttemptId).toBeNull();
    expect(state.transitions).toHaveLength(1);
    expect(store.mergeOperation("op-x")).toMatchObject({ outcome: "MERGED" });
    expect(store.earliestDeadline()).toBeNull();
    expect(checkInvariants(state)).toEqual([]);
  });

  describe("the alarm", () => {
    it("expires an unclaimed offer and keeps the entry's place", async () => {
      const { store, commands, clock } = harness();
      ready(commands, "e1", "alice", 7);
      await commands.tick({ idempotencyKey: "t1"});
      const ordinal = store.state().entries.get("e1")!.fairnessOrdinal;

      clock.advance(PAST_THE_OFFER);
      const first = await commands.runAlarm();
      expect(first.handled.map((d) => d.kind)).toEqual(["offer"]);
      expect(first.results[0]).toMatchObject({ status: "applied" });

      const entry = store.state().entries.get("e1")!;
      expect(entry.state).toBe("Deferred");
      expect(entry.fairnessOrdinal).toBe(ordinal);
      expect(store.state().activeAttemptId).toBeNull();
    });

    it("offers the freed lane to the next entry, rather than waiting to be asked", async () => {
      // A repository sat stuck for hours exactly here: an offer expired, the lane
      // went free, four entries were Ready and eligible, and no turn was ever
      // offered because nothing ticked the scheduler again. In steady state an
      // incoming check does that. When every check has already run, nothing does.
      const { store, commands, clock } = harness();
      ready(commands, "e1", "alice", 7);
      ready(commands, "e2", "bob", 8);
      await commands.tick({ idempotencyKey: "t1"});
      const firstHolder = store.state().activeAttemptId;
      expect(firstHolder).not.toBeNull();

      clock.advance(PAST_THE_OFFER);
      await commands.runAlarm();

      const after = store.state();
      expect(after.activeAttemptId).not.toBeNull();
      expect(after.activeAttemptId).not.toBe(firstHolder);
      expect(checkInvariants(after)).toEqual([]);
    });

    it("does not offer a lane that is still held", async () => {
      const { store, commands, clock } = harness();
      ready(commands, "e1", "alice", 7);
      await commands.tick({ idempotencyKey: "t1"});
      const attemptId = store.state().activeAttemptId!;
      commands.claim({ idempotencyKey: "c1", attemptId, executionMode: "device", deviceId: "d1" });

      clock.advance(30);
      await commands.runAlarm();
      expect(store.state().activeAttemptId).toBe(attemptId);
    });

    it("is idempotent when delivered twice", async () => {
      const { store, commands, clock } = harness();
      ready(commands, "e1", "alice", 7);
      await commands.tick({ idempotencyKey: "t1"});
      clock.advance(PAST_THE_OFFER);

      const first = await commands.runAlarm();
      const generationAfterFirst = store.generation();
      const second = await commands.runAlarm();

      expect(first.results[0]).toMatchObject({ status: "applied" });
      expect(second.handled).toEqual([]);
      expect(store.generation()).toBe(generationAfterFirst);
      expect(checkInvariants(store.state())).toEqual([]);
    });

    it("is idempotent when the same deadline is redelivered after a lost clear", async () => {
      // The clear and the action commit together, but alarm delivery is
      // at-least-once and a crash can lose the clear. The second delivery must
      // recognise the action by its deadline-derived key, not by the absence of
      // the row.
      const { sql, store, commands, clock } = sqlHarness();
      ready(commands, "e1", "alice", 7);
      const offered = await commands.tick({ idempotencyKey: "t1"}) as {
        attemptId: string;
      };
      clock.advance(PAST_THE_OFFER);

      const due = store.dueDeadlines(clock.now());
      expect(due).toHaveLength(1);
      const first = await commands.runAlarm();
      expect(first.results[0]).toMatchObject({ status: "applied" });
      const generation = store.generation();

      // Put the identical deadline row back, as a redelivery would find it.
      sql.exec(
        "INSERT INTO deadlines (kind, attempt_id, due_at) VALUES (?, ?, ?)",
        due[0]!.kind,
        due[0]!.attemptId,
        due[0]!.dueAt,
      );
      store.evict();

      const second = await commands.runAlarm();
      expect(second.handled).toHaveLength(1);
      expect(second.results[0]).toMatchObject({ status: "duplicate" });
      expect(store.generation()).toBe(generation);
      expect(store.state().attempts.get(offered.attemptId)!.outcome).toBe("EXPIRED_UNCLAIMED");
      expect(checkInvariants(store.state())).toEqual([]);
    });

    it("supersedes an attempt whose reconnect grace ran out", async () => {
      const { store, commands, clock } = harness();
      ready(commands, "e1", "alice", 7);
      const offered = await commands.tick({ idempotencyKey: "t1"}) as {
        attemptId: string;
      };
      const attemptId = offered.attemptId;
      commands.claim({ idempotencyKey: "c1", attemptId, executionMode: "device", deviceId: "d1" });
      commands.candidatePrepared({
        idempotencyKey: "p1",
        attemptId,
        baseSha: "b".repeat(40),
        headSha: "h".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTree: "t".repeat(40),
        policyDigest: "sha256:pol",
        runner: "dagger",
      });
      commands.assign({ idempotencyKey: "a1", attemptId, assignmentDigest: "sha256:asg" });
      commands.heartbeat({ idempotencyKey: "hb-1", attemptId });

      commands.heartbeatLost({ idempotencyKey: "hl-1", attemptId });
      expect(store.state().entries.get("e1")!.state).toBe("ReconnectGrace");
      expect(store.state().activeAttemptId).toBe(attemptId);

      clock.advance(PAST_THE_GRACE);
      const alarm = await commands.runAlarm();
      expect(alarm.handled.map((d) => d.kind)).toEqual(["grace"]);
      expect(store.state().attempts.get(attemptId)!.outcome).toBe("SUPERSEDED");
      expect(store.state().entries.get("e1")!.state).toBe("Deferred");
      expect(store.state().activeAttemptId).toBeNull();
    });

    it("converts a missing merge confirmation into an unknown outcome, never a retry", async () => {
      const { store, commands, clock } = harness();
      const attemptId = await driveToMergeRequested(commands);

      clock.advance(PAST_THE_MERGE_CONFIRM);
      const alarm = await commands.runAlarm();
      expect(alarm.handled.map((d) => d.kind)).toEqual(["merge-confirm"]);
      expect(store.state().entries.get("e1")!.state).toBe("Reconciling");
      expect(store.pendingOutbox().some((o) => o.kind === "reconcile-merge")).toBe(true);
      // Crucially, no second merge-write item was produced.
      expect(store.pendingOutbox().filter((o) => o.kind === "merge-write")).toHaveLength(1);

      // The unknown event starts one bounded confirmation window. Once that
      // expires, the row remains due for the caller's read-only reconciliation;
      // repeated clock handling neither writes again nor floods the outbox.
      clock.advance(PAST_THE_MERGE_CONFIRM);
      expect((await commands.runAlarm()).handled.map((d) => d.kind)).toEqual(["merge-confirm"]);
      expect((await commands.runAlarm()).handled.map((d) => d.kind)).toEqual(["merge-confirm"]);
      expect(store.pendingOutbox().filter((o) => o.kind === "reconcile-merge")).toHaveLength(1);
      expect(store.pendingOutbox().filter((o) => o.kind === "merge-write")).toHaveLength(1);
    });

    it("keeps a bounded provider explanation on the unknown event", async () => {
      const { store, commands } = harness();
      const attemptId = await driveToMergeRequested(commands);
      commands.mergeOutcomeUnknown({ idempotencyKey: "unknown-detail", attemptId, detail: "x".repeat(800) });

      // Recent diagnostic bodies live in the D1 document store. The legacy
      // Durable Object store is read-only in production and exposes no event
      // tail API, so there is no diagnostic response to assert there.
      if (!(store instanceof SnapshotQueueStore)) return;
      const event = store.recentEvents(1)[0];
      expect(event?.type).toBe("MergeOutcomeUnknown");
      expect((event?.body as { detail?: string }).detail).toBe("x".repeat(500));
    });

    it("reschedules to the next earliest deadline", async () => {
      const { store, commands, clock } = harness();
      ready(commands, "e1", "alice", 7);
      const offered = await commands.tick({ idempotencyKey: "t1"}) as {
        attemptId: string;
      };
      commands.claim({
        idempotencyKey: "c1",
        attemptId: offered.attemptId,
        executionMode: "device",
        deviceId: "d1",
      });
      // The offer deadline is gone; execution is now the earliest.
      expect(store.earliestDeadline()).toBe("2026-07-29T12:20:00.000Z");
      clock.advance(30);
      expect((await commands.runAlarm()).nextAlarm).toBe("2026-07-29T12:20:00.000Z");
    });
  });

  describe("the merge write guard", () => {
    it("refuses a second write for the same operation", async () => {
      const { commands } = harness();
      const attemptId = await driveToMergeRequested(commands);
      const again = commands.beginMergeWrite({ idempotencyKey: "m1b", attemptId, operationId: "op-x" });
      expect(again).toMatchObject({ status: "already-started" });
    });

    it("refuses to start a write for an unpinned candidate", async () => {
      const { commands } = harness();
      ready(commands, "e1", "alice", 7);
      const offered = await commands.tick({ idempotencyKey: "t1"}) as {
        attemptId: string;
      };
      expect(
        commands.beginMergeWrite({ idempotencyKey: "m1", attemptId: offered.attemptId, operationId: "op-y" }),
      ).toMatchObject({ status: "rejected" });
    });

    it("resolves a proven non-merge without creating another operation", async () => {
      const { store, commands } = harness();
      const attemptId = await driveToMergeRequested(commands);
      commands.mergeOutcomeUnknown({ idempotencyKey: "u1", attemptId });
      await commands.confirmNotMerged({ idempotencyKey: "n1", attemptId, operationId: "op-x" });
      expect(store.state().attempts.get(attemptId)!.outcome).toBe("CONFIRMED_NOT_MERGED");
      expect(store.mergeOperation("op-x")).toMatchObject({ outcome: "CONFIRMED_NOT_MERGED" });
      // Deferred with a cooldown, so the lane goes to somebody else before this
      // pull request tries again.
      expect(store.state().entries.get("e1")!.state).toBe("Deferred");
      expect(store.state().entries.get("e1")!.cooldownUntil).not.toBeNull();
      expect(checkInvariants(store.state())).toEqual([]);
    });
  });

  it("pauses on an external transition and demands a rebaseline before resuming", async () => {
    const { store, commands } = harness();
    ready(commands, "e1", "alice", 7);
    commands.observedExternalTransition({ idempotencyKey: "x1", observedBaseSha: "x".repeat(40) });
    expect(store.state().paused).toBe(true);
    expect(await commands.tick({ idempotencyKey: "t1"})).toMatchObject({
      status: "noop",
    });
    expect(commands.resume({ idempotencyKey: "r1", actorPrincipalId: "admin" })).toMatchObject({
      status: "rejected",
    });
    commands.rebaseline({
      idempotencyKey: "rb1",
      actorPrincipalId: "admin",
      baseSha: "x".repeat(40),
      reason: "inspected the commit and accepted it",
    });
    expect(commands.resume({ idempotencyKey: "r1", actorPrincipalId: "admin" })).toMatchObject({
      status: "applied",
    });
    expect(store.state().paused).toBe(false);
  });

  it("bumps the attempt revision when a live attempt's readiness changes", async () => {
    const { store, commands } = harness();
    ready(commands, "e1", "alice", 7);
    const offered = await commands.tick({ idempotencyKey: "t1"}) as {
      attemptId: string;
    };
    commands.claim({
      idempotencyKey: "c1",
      attemptId: offered.attemptId,
      executionMode: "device",
      deviceId: "d1",
    });
    const revision = store.attemptRevision();
    commands.evaluateReadiness({
      idempotencyKey: "ready-changed",
      entryId: "e1",
      ready: false,
      schedulerEligible: false,
      primaryReason: "REVIEW_REQUIRED",
    });
    expect(store.attemptRevision()).toBeGreaterThan(revision);
    expect(store.classifyCallback(offered.attemptId, revision)).toBe("CURRENT_ATTEMPT_INVARIANT_CONFLICT");
  });
});

/** Everything up to and including the merge write starting. */
async function driveToMergeRequested(commands: QueueCommands): Promise<string> {
  ready(commands, "e1", "alice", 7);
  const offered = await commands.tick({ idempotencyKey: "t1"}) as { attemptId: string };
  const attemptId = offered.attemptId;
  commands.claim({ idempotencyKey: "c1", attemptId, executionMode: "device", deviceId: "d1" });
  commands.candidatePrepared({
    idempotencyKey: "p1",
    attemptId,
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    candidateSha: "c".repeat(40),
    candidateTree: "t".repeat(40),
    policyDigest: "sha256:pol",
    runner: "dagger",
  });
  commands.assign({ idempotencyKey: "a1", attemptId, assignmentDigest: "sha256:asg" });
  commands.heartbeat({ idempotencyKey: "hb-1", attemptId });
  commands.submitReceipt({ idempotencyKey: "r1", attemptId, receiptDigest: "sha256:rcpt" });
  const started = commands.startVerification({ idempotencyKey: "v1", attemptId }) as { nonce: string };
  commands.completeVerification({
    idempotencyKey: "v2",
    attemptId,
    nonce: started.nonce,
    accepted: true,
    resultDigest: "sha256:res",
  });
  commands.createMergeIntent({ idempotencyKey: "i1", attemptId, intentDigest: "sha256:intent" });
  commands.beginMergeWrite({ idempotencyKey: "m1", attemptId, operationId: "op-x" });
  return attemptId;
}

/**
 * The alarm has to terminate.
 *
 * Deadlines were cleared as a side effect of the command that handled them, so a
 * deadline whose command was a no-op survived. It stayed due, earliestDeadline
 * kept returning a time in the past, and the alarm rescheduled to that past time
 * and fired again at once: a wake loop writing no events, invisible in the state,
 * that spent an entire day of the object's request budget in a few hours.
 */
describe.each(STORES)("the alarm terminates, over $name", ({ make }) => {
  beforeEach(() => {
    makeStore = make;
  });

  it("never asks to be woken at a time that has already passed", async () => {
    const { store, commands, clock } = harness();
    ready(commands, "e1", "alice", 7);
    ready(commands, "e2", "bob", 8);
    await commands.tick({ idempotencyKey: "t1"});

    for (let i = 0; i < 5; i += 1) {
      clock.advance(600);
      await commands.runAlarm();
      const next = store.earliestDeadline();
      if (next !== null) expect(next > clock.now()).toBe(true);
    }
  });
});
