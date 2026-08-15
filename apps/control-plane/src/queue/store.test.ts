import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { checkInvariants } from "@thwip/queue-domain";
import { BranchQueueStore, type SubmittedEvent } from "./store.js";
import { cellOf, SnapshotQueueStore, type SnapshotCell } from "./snapshot-store.js";
import type { SqlLike } from "./sql.js";

/**
 * The Durable Object's state layer under the conditions §53.3 demands: eviction
 * between every command, duplicate alarms, out-of-order and replayed callbacks,
 * and a crash between "the merge write started" and "the workflow committed".
 *
 * better-sqlite3 gives real SQLite semantics, and dropping the in-memory
 * snapshot is exactly what an eviction does, so a rehydrated store must land in
 * the same place as one that stayed warm.
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

const IDENTITY = { queueKey: "qk", repositoryId: "1315419165", baseRef: "refs/heads/main" };

/**
 * Both stores, one suite.
 *
 * The document store exists to take the Durable Object out of the path of every
 * decision, and the only way to believe it is a drop-in is to hold it to the
 * tests the SQL store already passes, eviction chaos included. A behaviour that
 * appears in one implementation and not the other fails here rather than in a
 * repository whose queue has stopped.
 *
 * `backing` is whatever the store persists into: a SQLite handle for one, the
 * stored document for the other. Reopening over the same backing is a restart in
 * both cases.
 */
type AnyStore = BranchQueueStore | SnapshotQueueStore;

/**
 * Take the pull request number back off every merge write in the backing, the
 * way the rows written before the column existed already are. `ALTER TABLE`
 * leaves the old rows NULL, and the document store's old rows simply have no
 * such key.
 */
function stripPullRequestNumbers(sql: SqlLike): void {
  sql.exec("UPDATE merge_operations SET pull_request_number = NULL");
}

function stripPullRequestNumbersFromDocument(cell: SnapshotCell): void {
  const held = cell.read();
  if (held === null) return;
  const doc = JSON.parse(held) as { mergeOperations: Array<Record<string, unknown>> };
  for (const row of doc.mergeOperations) delete row.pullRequestNumber;
  cell.write(JSON.stringify(doc));
}

const IMPLEMENTATIONS = [
  {
    name: "BranchQueueStore",
    backing: () => sqlite() as never,
    open: (b: never, id: typeof IDENTITY): AnyStore => BranchQueueStore.open(b as SqlLike, id),
    legacy: (b: never) => stripPullRequestNumbers(b as SqlLike),
  },
  {
    name: "SnapshotQueueStore",
    backing: () => cellOf() as never,
    open: (b: never, id: typeof IDENTITY): AnyStore => SnapshotQueueStore.open(b as SnapshotCell, id),
    legacy: (b: never) => stripPullRequestNumbersFromDocument(b as SnapshotCell),
  },
  {
    // The same store with compaction turned up as far as it goes, so anything the
    // queue still needs after history is dropped has to be something compaction
    // keeps. If dropping history changed a decision, it would change one here.
    name: "SnapshotQueueStore (compacted hard)",
    backing: () => cellOf() as never,
    open: (b: never, id: typeof IDENTITY): AnyStore =>
      SnapshotQueueStore.open(b as SnapshotCell, id, { terminalEntries: 1, transitions: 1 }),
    legacy: (b: never) => stripPullRequestNumbersFromDocument(b as SnapshotCell),
  },
];

let n = 0;
function ev(body: Omit<SubmittedEvent, "idempotencyKey" | "at">, key?: string): SubmittedEvent {
  n += 1;
  return {
    idempotencyKey: key ?? `k${n}`,
    at: new Date(Date.UTC(2026, 6, 29, 12, 0, n)).toISOString(),
    ...body,
  } as SubmittedEvent;
}

function request(store: AnyStore, entryId: string, principal: string, pr: number) {
  store.append(
    ev({
      type: "QueueRequested",
      entryId,
      pullRequestNumber: pr,
      sponsorPrincipalId: principal,
      sponsorGithubUserId: principal === "alice" ? "1" : "2",
      headSha: "h".repeat(40),
    }),
  );
  store.append(
    ev({
      type: "ReadinessEvaluated",
      entryId,
      ready: true,
      schedulerEligible: true,
      primaryReason: null,
      secondaryReasons: [],
    }),
  );
}

describe.each(IMPLEMENTATIONS)("$name", ({ backing, open, legacy }) => {
  it("creates its schema and meta row once", () => {
    const sql = backing();
    const first = open(sql, IDENTITY);
    const second = open(sql, IDENTITY);
    expect(first.generation()).toBe(0);
    expect(second.state().entries.size).toBe(0);
  });

  it("applies an event and advances the generation", () => {
    const store = open(backing(), IDENTITY);
    const result = store.append(
      ev({
        type: "QueueRequested",
        entryId: "e1",
        pullRequestNumber: 7,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "1",
        headSha: "h".repeat(40),
      }),
    );
    expect(result).toMatchObject({ status: "applied", sequence: 1, generation: 1 });
    expect(store.state().entries.get("e1")!.fairnessOrdinal).toBe(1n);
  });

  it("writes nothing when the reducer rejects the command", () => {
    const store = open(backing(), IDENTITY);
    const before = store.generation();
    const rejected = store.append(
      ev({
        type: "ReadinessEvaluated",
        entryId: "missing",
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
        secondaryReasons: [],
      }),
    );
    expect(rejected).toMatchObject({ status: "rejected" });
    expect(store.generation()).toBe(before);
    expect(store.state().entries.size).toBe(0);
  });

  it("returns the committed result for a duplicate idempotency key", () => {
    const store = open(backing(), IDENTITY);
    const event = ev(
      {
        type: "QueueRequested",
        entryId: "e1",
        pullRequestNumber: 7,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "1",
        headSha: "h".repeat(40),
      },
      "same",
    );
    const first = store.append(event);
    const second = store.append(event);
    expect(first.status).toBe("applied");
    expect(second).toMatchObject({ status: "duplicate", sequence: 1 });
    expect(store.state().entries.size).toBe(1);
    expect(store.generation()).toBe(1);
  });

  it("does not consume a sequence for an event the reducer treats as a no-op", () => {
    // A no-op that consumed a sequence would leave a recorded event ahead of
    // lastSequence, and the next append would reuse that sequence — which is
    // otherwise surfaces later as a UNIQUE constraint failure.
    const store = open(backing(), IDENTITY);
    request(store, "e1", "alice", 7);
    const before = store.state().lastSequence;

    // Requesting the same entry again is a no-op in the reducer.
    const repeat = store.append(
      ev({
        type: "QueueRequested",
        entryId: "e1",
        pullRequestNumber: 7,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "1",
        headSha: "h".repeat(40),
      }),
    );
    expect(repeat.status).toBe("duplicate");
    expect(store.state().lastSequence).toBe(before);

    // And the next real command still applies rather than colliding.
    expect(
      store.append(ev({ type: "EntryHeadChanged", entryId: "e1", headSha: "z".repeat(40) })).status,
    ).toBe("applied");
  });

  describe("eviction", () => {
    it("rehydrates to the same state after every command", () => {
      const sql = backing();
      const store = open(sql, IDENTITY);
      const events: SubmittedEvent[] = [];

      request(store, "e1", "alice", 7);
      request(store, "e2", "bob", 8);

      const chosen = store.nextTurn("2026-07-29T12:10:00Z")!;
      events.push(
        ev({
          type: "TurnOffered",
          entryId: chosen.entryId,
          attemptId: "a1",
          offerDeadline: "2026-07-29T12:11:30Z",
          decisionDigest: "sha256:dec",
        }),
        ev({ type: "OfferClaimed", attemptId: "a1", executionMode: "device", deviceId: "d1" }),
        ev({
          type: "CandidatePrepared",
          attemptId: "a1",
          baseSha: "b".repeat(40),
          headSha: "h".repeat(40),
          candidateSha: "c".repeat(40),
          candidateTree: "t".repeat(40),
          policyDigest: "sha256:pol",
          runner: "dagger",
        }),
      );

      for (const event of events) {
        // Evict before and after every command, as the platform may.
        store.evict();
        const applied = store.append(event);
        expect(applied.status).toBe("applied");
        const warm = JSON.stringify(dump(store));
        store.evict();
        expect(JSON.stringify(dump(store))).toEqual(warm);
      }

      const fresh = open(sql, IDENTITY);
      expect(JSON.stringify(dump(fresh))).toEqual(JSON.stringify(dump(store)));
      expect(checkInvariants(fresh.state())).toEqual([]);
    });

    it("keeps deduplication working across an eviction", () => {
      const sql = backing();
      const store = open(sql, IDENTITY);
      const event = ev(
        {
          type: "QueueRequested",
          entryId: "e1",
          pullRequestNumber: 7,
          sponsorPrincipalId: "alice",
          sponsorGithubUserId: "1",
          headSha: "h".repeat(40),
        },
        "dedupe-me",
      );
      store.append(event);
      const rehydrated = open(sql, IDENTITY);
      expect(rehydrated.append(event)).toMatchObject({ status: "duplicate" });
      expect(rehydrated.state().entries.size).toBe(1);
    });
  });

  describe("scheduling", () => {
    it("refuses to pick a turn while the lane is busy or the queue is paused", () => {
      const store = open(backing(), IDENTITY);
      request(store, "e1", "alice", 7);
      expect(store.nextTurn("2026-07-29T12:10:00Z")).not.toBeNull();

      store.append(
        ev({
          type: "TurnOffered",
          entryId: "e1",
          attemptId: "a1",
          offerDeadline: "2026-07-29T12:11:30Z",
          decisionDigest: "sha256:dec",
        }),
      );
      expect(store.nextTurn("2026-07-29T12:10:00Z")).toBeNull();

      store.append(ev({ type: "OfferExpired", attemptId: "a1", cooldownUntil: "2026-07-29T12:16:00Z" }));
      expect(store.nextTurn("2026-07-29T12:12:00Z")).toBeNull(); // deferred, cooling down

      // The alarm re-evaluates readiness after the cooldown, which is what
      // returns the entry to the pool (§9.3).
      store.append({
        idempotencyKey: "after-cooldown",
        at: "2026-07-29T12:16:01Z",
        type: "ReadinessEvaluated",
        entryId: "e1",
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
        secondaryReasons: [],
      });
      expect(store.nextTurn("2026-07-29T12:20:00Z")).not.toBeNull();

      store.append(ev({ type: "QueuePaused", actorPrincipalId: "admin", reason: "incident" }));
      expect(store.nextTurn("2026-07-29T12:20:00Z")).toBeNull();
    });

    it("does not offer to an offline entry but keeps its place", () => {
      const store = open(backing(), IDENTITY);
      request(store, "e1", "alice", 7);
      const ordinal = store.state().entries.get("e1")!.fairnessOrdinal;
      store.append(
        ev({
          type: "ReadinessEvaluated",
          entryId: "e1",
          ready: true,
          schedulerEligible: false,
          primaryReason: "AGENT_OFFLINE",
          secondaryReasons: [],
        }),
      );
      expect(store.nextTurn("2026-07-29T12:10:00Z")).toBeNull();
      expect(store.state().entries.get("e1")!.state).toBe("Ready");
      expect(store.state().entries.get("e1")!.fairnessOrdinal).toBe(ordinal);
    });
  });

  describe("deadlines and the single alarm", () => {
    it("schedules the earliest deadline and reports what is due", () => {
      const store = open(backing(), IDENTITY);
      request(store, "e1", "alice", 7);
      store.append(
        ev({
          type: "TurnOffered",
          entryId: "e1",
          attemptId: "a1",
          offerDeadline: "2026-07-29T12:11:30Z",
          decisionDigest: "sha256:dec",
        }),
        {
          setDeadlines: [
            { kind: "offer", attemptId: "a1", dueAt: "2026-07-29T12:11:30Z" },
            { kind: "readiness", attemptId: "a1", dueAt: "2026-07-29T12:30:00Z" },
          ],
        },
      );
      expect(store.earliestDeadline()).toBe("2026-07-29T12:11:30Z");
      expect(store.dueDeadlines("2026-07-29T12:12:00Z").map((d) => d.kind)).toEqual(["offer"]);
      expect(store.dueDeadlines("2026-07-29T12:00:00Z")).toEqual([]);
    });

    it("survives an alarm delivered twice", () => {
      const store = open(backing(), IDENTITY);
      request(store, "e1", "alice", 7);
      store.append(
        ev({
          type: "TurnOffered",
          entryId: "e1",
          attemptId: "a1",
          offerDeadline: "2026-07-29T12:11:30Z",
          decisionDigest: "sha256:dec",
        }),
        { setDeadlines: [{ kind: "offer", attemptId: "a1", dueAt: "2026-07-29T12:11:30Z" }] },
      );

      // The alarm handler expires the offer. Delivered twice, the second pass
      // must find nothing to do rather than expiring a second attempt.
      const expire = ev(
        { type: "OfferExpired", attemptId: "a1", cooldownUntil: "2026-07-29T12:16:30Z" },
        "alarm-offer-a1",
      );
      const first = store.append(expire, { clearDeadlines: [{ kind: "offer", attemptId: "a1" }] });
      const second = store.append(expire, { clearDeadlines: [{ kind: "offer", attemptId: "a1" }] });
      expect(first.status).toBe("applied");
      expect(second.status).toBe("duplicate");
      expect(store.dueDeadlines("2026-07-29T13:00:00Z")).toEqual([]);
      expect(checkInvariants(store.state())).toEqual([]);
    });
  });

  describe("outbox", () => {
    it("holds an item until it is acknowledged and counts attempts", () => {
      const store = open(backing(), IDENTITY);
      request(store, "e1", "alice", 7);
      store.append(
        ev({
          type: "TurnOffered",
          entryId: "e1",
          attemptId: "a1",
          offerDeadline: "2026-07-29T12:11:30Z",
          decisionDigest: "sha256:dec",
        }),
        { outbox: [{ kind: "start-workflow", attemptId: "a1", payload: { attemptId: "a1" } }] },
      );

      const pending = store.pendingOutbox();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.kind).toBe("start-workflow");

      store.recordOutboxAttempt(pending[0]!.outboxId);
      expect(store.pendingOutbox()[0]!.attempts).toBe(1);

      store.acknowledgeOutbox(pending[0]!.outboxId);
      expect(store.pendingOutbox()).toEqual([]);
    });

    it("does not duplicate an outbox item when its command is retried", () => {
      const store = open(backing(), IDENTITY);
      request(store, "e1", "alice", 7);
      const offer = ev(
        {
          type: "TurnOffered",
          entryId: "e1",
          attemptId: "a1",
          offerDeadline: "2026-07-29T12:11:30Z",
          decisionDigest: "sha256:dec",
        },
        "offer-once",
      );
      const options = { outbox: [{ kind: "start-workflow", attemptId: "a1", payload: {} }] };
      store.append(offer, options);
      store.append(offer, options);
      expect(store.pendingOutbox()).toHaveLength(1);
    });
  });

  describe("callback classification", () => {
    it("tells a stale attempt from a conflicted current one", () => {
      const store = open(backing(), IDENTITY);
      request(store, "e1", "alice", 7);
      store.append(
        ev({
          type: "TurnOffered",
          entryId: "e1",
          attemptId: "a1",
          offerDeadline: "2026-07-29T12:11:30Z",
          decisionDigest: "sha256:dec",
        }),
      );
      const revision = store.attemptRevision();
      expect(store.classifyCallback("a1", revision)).toBe("current");
      expect(store.classifyCallback("a0", revision)).toBe("STALE_ATTEMPT");
      expect(store.classifyCallback("a1", revision + 5)).toBe("CURRENT_ATTEMPT_INVARIANT_CONFLICT");
    });

    it("bumps the revision only when asked", () => {
      const store = open(backing(), IDENTITY);
      request(store, "e1", "alice", 7);
      const before = store.attemptRevision();
      store.append(ev({ type: "EntryHeadChanged", entryId: "e1", headSha: "z".repeat(40) }));
      expect(store.attemptRevision()).toBe(before);
      store.append(ev({ type: "EntryHeadChanged", entryId: "e1", headSha: "y".repeat(40) }), {
        bumpAttemptRevision: true,
      });
      expect(store.attemptRevision()).toBe(before + 1);
    });
  });

  describe("merge write guard", () => {
    const op = {
      operationId: "op-1",
      attemptId: "a1",
      attemptRevision: 3,
      expectedBaseSha: "b".repeat(40),
      expectedHeadSha: "h".repeat(40),
      expectedTreeOid: "t".repeat(40),
      pullRequestNumber: 42,
      at: "2026-07-29T12:20:00Z",
    };

    it("records the write before the network call and refuses a second start", () => {
      const store = open(backing(), IDENTITY);
      expect(store.beginMergeOperation(op)).toEqual({ status: "started" });
      expect(store.beginMergeOperation(op)).toEqual({ status: "already-started", outcome: null });
    });

    it("still refuses after a crash, because the row outlives the workflow", () => {
      const sql = backing();
      const store = open(sql, IDENTITY);
      store.beginMergeOperation(op);
      // The workflow died before committing its step and re-enters from scratch.
      const restarted = open(sql, IDENTITY);
      expect(restarted.beginMergeOperation(op)).toMatchObject({ status: "already-started" });
    });

    it("remembers how an operation resolved", async () => {
      const store = open(backing(), IDENTITY);
      store.beginMergeOperation(op);
      await store.resolveMergeOperation("op-1", "MERGED", "2026-07-29T12:21:00Z");
      expect(store.mergeOperation("op-1")).toMatchObject({ attemptId: "a1", outcome: "MERGED" });
      expect(store.beginMergeOperation(op)).toEqual({ status: "already-started", outcome: "MERGED" });
      expect(store.mergeOperation("nope")).toBeNull();
    });

    /**
     * The pull request a write was sent for, carried on the row rather than
     * looked up through the attempt: the attempt is exactly what the sweep
     * cannot rely on once it is stranded.
     */
    it("carries the pull request the write was sent for", () => {
      const store = open(backing(), IDENTITY);
      store.beginMergeOperation(op);
      expect(store.unresolvedMergeOperations("2026-07-29T12:25:00Z")).toEqual([
        expect.objectContaining({ operationId: "op-1", pullRequestNumber: 42 }),
      ]);
    });

    /**
     * An operation nobody resolved is the failure this whole guard exists around,
     * and until now nothing could find one.
     *
     * A merge can land that way when the workflow authorizes, GitHub answers 405
     * while it is still working out mergeability, the
     * workflow exited saying it was leaving the outcome to reconciliation, and
     * the merge landed anyway. The attempt was terminated and compacted, so the
     * only thing that ever swept these rows is gone, and the operation remains
     * unresolved without a chain link.
     *
     * So the operation carries the obligation, not the attempt. Finding one is
     * the first thing the sweep needs and the reason these tests exist.
     */
    describe("operations nobody resolved", () => {
      it("finds a write that was started and never resolved", () => {
        const store = open(backing(), IDENTITY);
        store.beginMergeOperation(op);
        expect(store.unresolvedMergeOperations("2026-07-29T12:25:00Z")).toEqual([
          {
            operationId: "op-1",
            attemptId: "a1",
            attemptRevision: 3,
            expectedBaseSha: "b".repeat(40),
            expectedHeadSha: "h".repeat(40),
            expectedTreeOid: "t".repeat(40),
            pullRequestNumber: 42,
            writeStartedAt: "2026-07-29T12:20:00Z",
          },
        ]);
      });

      it("leaves a resolved write alone", async () => {
        const store = open(backing(), IDENTITY);
        store.beginMergeOperation(op);
        await store.resolveMergeOperation("op-1", "MERGED", "2026-07-29T12:21:00Z");
        expect(store.unresolvedMergeOperations("2026-07-29T12:25:00Z")).toEqual([]);
      });

      /**
       * A write sent a moment ago is in flight, not orphaned. Sweeping it would
       * race the workflow that is about to report the same operation.
       */
      it("leaves a write that is still young enough to report for itself", () => {
        const store = open(backing(), IDENTITY);
        store.beginMergeOperation(op);
        // The argument is the cutoff: anything started at or after it is still in
        // flight. This write began a second later than the cutoff allows for.
        expect(store.unresolvedMergeOperations("2026-07-29T12:19:59Z")).toEqual([]);
      });

      it("finds one whose attempt no longer exists", () => {
        const sql = backing();
        const store = open(sql, IDENTITY);
        store.beginMergeOperation(op);
        // Nothing here ever created the attempt, which is the state after the
        // attempt has been compacted away.
        const reopened = open(sql, IDENTITY);
        expect(reopened.unresolvedMergeOperations("2026-07-29T12:25:00Z")).toHaveLength(1);
      });

      it("returns the oldest first, so a sweep clears the longest-stranded merge first", () => {
        const store = open(backing(), IDENTITY);
        store.beginMergeOperation({ ...op, operationId: "op-2", at: "2026-07-29T12:22:00Z" });
        store.beginMergeOperation(op);
        expect(store.unresolvedMergeOperations("2026-07-29T12:25:00Z").map((o) => o.operationId)).toEqual([
          "op-1",
          "op-2",
        ]);
      });

      /**
       * A write that predates the column has no pull request number. Reporting that
       * as a number sends the sweep to `GET /pulls/undefined`, which 404s on
       * every tick, which is a row that can never settle.
       */
      it("reports a write written before the column existed as having no pull request number", () => {
        const b = backing();
        const store = open(b, IDENTITY);
        store.beginMergeOperation(op);
        legacy(b);
        const found = open(b, IDENTITY).unresolvedMergeOperations("2026-07-29T12:25:00Z");
        expect(found).toHaveLength(1);
        expect(found[0]?.pullRequestNumber).toBeNull();
      });
    });
  });

  it("keeps the attempt DAG edges it is told about", () => {
    const store = open(backing(), IDENTITY);
    request(store, "e1", "alice", 7);
    store.append(
      ev({
        type: "TurnOffered",
        entryId: "e1",
        attemptId: "a1",
        offerDeadline: "2026-07-29T12:11:30Z",
        decisionDigest: "sha256:dec",
      }),
    );
    store.append(ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "CI_FAILED" }));
    store.append(
      ev({
        type: "ReadinessEvaluated",
        entryId: "e1",
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
        secondaryReasons: [],
      }),
    );
    store.append(
      ev({
        type: "TurnOffered",
        entryId: "e1",
        attemptId: "a2",
        offerDeadline: "2026-07-29T12:30:00Z",
        decisionDigest: "sha256:dec2",
      }),
    );
    expect(store.state().attempts.get("a2")!.parentAttemptId).toBe("a1");
    expect(checkInvariants(store.state())).toEqual([]);
  });
});

/**
 * Only the SQL store can be corrupted this particular way, so this stays outside
 * the shared suite rather than being watered down until both can run it.
 */
describe("BranchQueueStore, on storage an earlier build wrote", () => {
  it("heals a stored sequence counter that has fallen behind the event log", () => {
    // Trusting the counter would make every later append collide on the primary
    // key.
    const sql = sqlite();
    const store = BranchQueueStore.open(sql, IDENTITY);
    request(store, "e1", "alice", 7);
    const real = store.state().lastSequence;
    sql.exec("UPDATE queue_meta SET last_sequence = ? WHERE id = 1", real - 1);

    const reopened = BranchQueueStore.open(sql, IDENTITY);
    expect(reopened.state().lastSequence).toBe(real);
    expect(
      reopened.append(ev({ type: "EntryHeadChanged", entryId: "e1", headSha: "z".repeat(40) })).status,
    ).toBe("applied");
  });
});

/** Comparable snapshot of everything that must survive an eviction. */
function dump(store: AnyStore): unknown {
  const state = store.state();
  return {
    lastSequence: state.lastSequence,
    turnSequence: state.turnSequence.toString(),
    ordinalSequence: state.ordinalSequence.toString(),
    paused: state.paused,
    pauseReason: state.pauseReason,
    rebaselineRequired: state.rebaselineRequired,
    baseSha: state.baseSha,
    activeAttemptId: state.activeAttemptId,
    entries: [...state.entries.entries()]
      .sort()
      .map(([k, v]) => [k, { ...v, fairnessOrdinal: v.fairnessOrdinal.toString() }]),
    attempts: [...state.attempts.entries()].sort(),
    lastServedTurn: [...state.lastServedTurn.entries()].sort().map(([k, v]) => [k, v.toString()]),
    transitions: state.transitions,
  };
}

/**
 * An entry that forfeited a turn is Deferred, and it used to return to Ready
 * only when a readiness evaluation arrived from a GitHub webhook. With nothing
 * calling, it can remain Deferred with no cooldown beside an idle lane while
 * every tick answers "no eligible entry".
 *
 * These call `eligibleEntries()` and `nextTurn()`. The tests they replace spelled
 * the filter predicate out again inside the assertion, so they passed whatever
 * the store actually did.
 */
describe.each(IMPLEMENTATIONS)("$name: a deferred entry competes again on its own", ({ backing, open }) => {
  const DIGEST = `sha256:${"0".repeat(64)}`;

  /** Offer `entryId` a turn, then end it with an outcome that defers. */
  function forfeitATurn(store: AnyStore, entryId: string, cooldownUntil?: string): void {
    store.append(
      ev({
        type: "TurnOffered",
        entryId,
        attemptId: `att_${entryId}`,
        offerDeadline: "2026-07-29T12:05:00.000Z",
        decisionDigest: DIGEST,
      }),
    );
    store.append(ev({ type: "AttemptTerminated", attemptId: `att_${entryId}`, outcome: "HEAD_MOVED", cooldownUntil }));
  }

  it("comes back on its own once the cooldown a forfeited turn left has elapsed", () => {
    const store = open(backing(), IDENTITY);
    request(store, "e1", "alice", 7);
    forfeitATurn(store, "e1", "2026-07-29T12:30:00.000Z");

    expect(store.state().entries.get("e1")!.state).toBe("Deferred");
    expect(store.eligibleEntries().map((e) => e.entryId)).toEqual(["e1"]);
    // Eligible, and still held: the cooldown is what stops a forfeited turn
    // from being handed straight back to the entry that just gave it up.
    expect(store.nextTurn("2026-07-29T12:10:00.000Z")).toBeNull();
    expect(store.nextTurn("2026-07-29T12:31:00.000Z")?.entryId).toBe("e1");
  });

  it("comes back on its own when the defer left no cooldown at all", () => {
    const store = open(backing(), IDENTITY);
    request(store, "e1", "alice", 7);
    // A termination written before terminations carried a cooldown leaves the
    // entry Deferred with `cooldownUntil` null.
    forfeitATurn(store, "e1");

    const entry = store.state().entries.get("e1")!;
    expect(entry.state).toBe("Deferred");
    expect(entry.cooldownUntil).toBeNull();
    expect(store.eligibleEntries().map((e) => e.entryId)).toEqual(["e1"]);
    expect(store.nextTurn("2026-07-29T12:10:00.000Z")?.entryId).toBe("e1");
  });

  it("stamps a cooldown when a turn ends in a defer, so a re-offer is paced", () => {
    const store = open(backing(), IDENTITY);
    request(store, "e1", "alice", 7);
    forfeitATurn(store, "e1", "2026-07-29T12:30:00.000Z");
    expect(store.state().entries.get("e1")!.cooldownUntil).toBe("2026-07-29T12:30:00.000Z");
  });
});
