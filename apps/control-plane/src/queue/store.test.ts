import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { checkInvariants } from "@thwip/queue-domain";
import { BranchQueueStore, type SubmittedEvent } from "./store.js";
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

let n = 0;
function ev(body: Omit<SubmittedEvent, "idempotencyKey" | "at">, key?: string): SubmittedEvent {
  n += 1;
  return {
    idempotencyKey: key ?? `k${n}`,
    at: new Date(Date.UTC(2026, 6, 29, 12, 0, n)).toISOString(),
    ...body,
  } as SubmittedEvent;
}

function request(store: BranchQueueStore, entryId: string, principal: string, pr: number) {
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

describe("BranchQueueStore", () => {
  it("creates its schema and meta row once", () => {
    const sql = sqlite();
    const first = BranchQueueStore.open(sql, IDENTITY);
    const second = BranchQueueStore.open(sql, IDENTITY);
    expect(first.generation()).toBe(0);
    expect(second.state().entries.size).toBe(0);
  });

  it("applies an event and advances the generation", () => {
    const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
    const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
    const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
    // A no-op that consumed a sequence would leave an events row ahead of
    // lastSequence, and the next append would collide on that sequence — which is
    // exactly how this surfaced in production, as a UNIQUE constraint failure.
    const sql = sqlite();
    const store = BranchQueueStore.open(sql, IDENTITY);
    request(store, "e1", "alice", 7);

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

    const maxSequence = sql
      .exec<{ m: number | null }>("SELECT MAX(sequence) AS m FROM events")
      .toArray()[0]!.m;
    expect(store.state().lastSequence).toBe(maxSequence);

    // And the next real command still applies rather than colliding.
    expect(
      store.append(ev({ type: "EntryHeadChanged", entryId: "e1", headSha: "z".repeat(40) })).status,
    ).toBe("applied");
  });

  describe("eviction", () => {
    it("rehydrates to the same state after every command", () => {
      const sql = sqlite();
      const store = BranchQueueStore.open(sql, IDENTITY);
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

      const fresh = BranchQueueStore.open(sql, IDENTITY);
      expect(JSON.stringify(dump(fresh))).toEqual(JSON.stringify(dump(store)));
      expect(checkInvariants(fresh.state())).toEqual([]);
    });

    it("keeps deduplication working across an eviction", () => {
      const sql = sqlite();
      const store = BranchQueueStore.open(sql, IDENTITY);
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
      const rehydrated = BranchQueueStore.open(sql, IDENTITY);
      expect(rehydrated.append(event)).toMatchObject({ status: "duplicate" });
      expect(rehydrated.state().entries.size).toBe(1);
    });
  });

  describe("scheduling", () => {
    it("refuses to pick a turn while the lane is busy or the queue is paused", () => {
      const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
      const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
      const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
      const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
      const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
      const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
      const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
      const store = BranchQueueStore.open(sqlite(), IDENTITY);
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
      at: "2026-07-29T12:20:00Z",
    };

    it("records the write before the network call and refuses a second start", () => {
      const store = BranchQueueStore.open(sqlite(), IDENTITY);
      expect(store.beginMergeOperation(op)).toEqual({ status: "started" });
      expect(store.beginMergeOperation(op)).toEqual({ status: "already-started", outcome: null });
    });

    it("still refuses after a crash, because the row outlives the workflow", () => {
      const sql = sqlite();
      const store = BranchQueueStore.open(sql, IDENTITY);
      store.beginMergeOperation(op);
      // The workflow died before committing its step and re-enters from scratch.
      const restarted = BranchQueueStore.open(sql, IDENTITY);
      expect(restarted.beginMergeOperation(op)).toMatchObject({ status: "already-started" });
    });

    it("remembers how an operation resolved", () => {
      const store = BranchQueueStore.open(sqlite(), IDENTITY);
      store.beginMergeOperation(op);
      store.resolveMergeOperation("op-1", "MERGED", "2026-07-29T12:21:00Z");
      expect(store.mergeOperation("op-1")).toMatchObject({ attemptId: "a1", outcome: "MERGED" });
      expect(store.beginMergeOperation(op)).toEqual({ status: "already-started", outcome: "MERGED" });
      expect(store.mergeOperation("nope")).toBeNull();
    });
  });

  it("keeps the attempt DAG edges it is told about", () => {
    const store = BranchQueueStore.open(sqlite(), IDENTITY);
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

/** Comparable snapshot of everything that must survive an eviction. */
function dump(store: BranchQueueStore): unknown {
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
