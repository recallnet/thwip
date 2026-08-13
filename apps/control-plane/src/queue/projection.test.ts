import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrationStatements } from "../../test/d1.js";
import { projectQueueState, readProjectedQueue, type D1Like, type ProjectionMessage } from "./projection.js";

/**
 * The projection is fed by an at-least-once queue with no ordering guarantee, so
 * the tests that matter are the out-of-order and replay ones. A retried older
 * message that overwrote newer truth would leave the dashboard wrong until the
 * next change, which is the failure mode a reader cannot detect.
 */

const open: Array<{ close(): void }> = [];

/** A D1-shaped adapter over better-sqlite3, including batch(). */
function d1(): D1Like {
  const db = new Database(":memory:");
  open.push(db);
  // Build the schema from the migrations rather than restating it here. Two
  // copies drift: a column added to a migration left this file describing a
  // different table, and every test kept passing against the old one.
  for (const sql of migrationStatements()) {
    try {
      db.exec(sql);
    } catch (error) {
      // Migrations for tables this suite does not exercise reference schema it
      // never creates. Anything touching a queue projection table must work.
      if (/queue_(entries|transitions)_index|queue_projection_marks/.test(sql)) throw error;
    }
  }

  const prepare = (query: string) => ({
    bind: (...values: unknown[]) => ({
      async run() {
        db.prepare(query).run(...(values as never[]));
      },
      async first<T>() {
        return (db.prepare(query).get(...(values as never[])) ?? null) as T | null;
      },
      async all<T>() {
        return { results: db.prepare(query).all(...(values as never[])) as T[] };
      },
      /** Captured so batch() can replay it. */
      __exec: () => db.prepare(query).run(...(values as never[])),
    }),
  });

  return {
    prepare,
    async batch(statements: unknown[]) {
      const run = db.transaction(() => {
        for (const s of statements) (s as { __exec(): void }).__exec();
      });
      run();
    },
  } as unknown as D1Like;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function message(over: Partial<ProjectionMessage> = {}): ProjectionMessage {
  return {
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
    queueEpoch: 0,
    generation: 5,
    entries: [
      {
        entryId: "e1",
        pullRequestNumber: 42,
        sponsorPrincipalId: "alice",
        state: "Ready",
        primaryReason: null,
        fairnessOrdinal: "1",
      },
    ],
    transitions: [],
    ...over,
  };
}

function rows(db: D1Like, table: string) {
  return db.prepare(`SELECT * FROM ${table}`).bind().all<Record<string, unknown>>();
}

describe("projectQueueState", () => {
  it("projects entries and records the generation", async () => {
    const db = d1();
    const result = await projectQueueState(db, message());
    expect(result).toEqual({ applied: true, entries: 1, transitions: 0 });
    const entries = (await rows(db, "queue_entries_index")).results;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entry_id: "e1", state: "Ready", fairness_ordinal: "1" });
  });

  it("updates an entry in place on a later generation", async () => {
    const db = d1();
    await projectQueueState(db, message());
    await projectQueueState(
      db,
      message({
        generation: 6,
        entries: [
          {
            entryId: "e1",
            pullRequestNumber: 42,
            sponsorPrincipalId: "alice",
            state: "Merged",
            primaryReason: null,
            fairnessOrdinal: "1",
          },
        ],
      }),
    );
    const entries = (await rows(db, "queue_entries_index")).results;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ state: "Merged" });
  });

  describe("ordering", () => {
    it("drops a message from an older generation instead of moving backwards", async () => {
      const db = d1();
      await projectQueueState(db, message({ generation: 6, entries: [readyEntry("Merged")] }));
      const stale = await projectQueueState(db, message({ generation: 5, entries: [readyEntry("Ready")] }));
      expect(stale).toEqual({ applied: false, reason: "STALE_GENERATION", seen: 6 });
      expect((await rows(db, "queue_entries_index")).results[0]).toMatchObject({ state: "Merged" });
    });

    it("replays the current generation idempotently so it can repair missing rows", async () => {
      const db = d1();
      await projectQueueState(db, message());
      expect(await projectQueueState(db, message())).toMatchObject({ applied: true });
      expect((await rows(db, "queue_entries_index")).results).toHaveLength(1);
    });

    it("is unaffected by the arrival order of two messages", async () => {
      const forwards = d1();
      await projectQueueState(forwards, message({ generation: 5, entries: [readyEntry("Ready")] }));
      await projectQueueState(forwards, message({ generation: 6, entries: [readyEntry("Merged")] }));

      const backwards = d1();
      await projectQueueState(backwards, message({ generation: 6, entries: [readyEntry("Merged")] }));
      await projectQueueState(backwards, message({ generation: 5, entries: [readyEntry("Ready")] }));

      const a = (await rows(forwards, "queue_entries_index")).results[0];
      const b = (await rows(backwards, "queue_entries_index")).results[0];
      expect(b?.["state"]).toBe(a?.["state"]);
      expect(b?.["state"]).toBe("Merged");
    });

    it("keeps separate marks per branch, so one branch cannot stall another", async () => {
      const db = d1();
      await projectQueueState(db, message({ generation: 9 }));
      const other = await projectQueueState(
        db,
        message({ baseRef: "refs/heads/release", generation: 2 }),
      );
      expect(other).toMatchObject({ applied: true });
    });
  });

  describe("transitions", () => {
    const transition = {
      transitionSequence: 1,
      kind: "verified",
      digest: `sha256:${"a".repeat(64)}`,
      priorDigest: null,
      baseSha: "b".repeat(40),
      attemptId: "att-1",
      witnessCount: 1,
      observedAt: "2026-07-29T12:00:00Z",
    };

    it("records a transition once", async () => {
      const db = d1();
      await projectQueueState(db, message({ generation: 5, transitions: [transition] }));
      expect((await rows(db, "queue_transitions_index")).results).toHaveLength(1);
    });

    it("restores a missing transition from a replay of current authority", async () => {
      const db = d1();
      const current = message({ generation: 5, transitions: [transition] });
      await projectQueueState(db, current);
      await db.prepare("DELETE FROM queue_transitions_index").bind().run();

      await projectQueueState(db, current);

      expect((await rows(db, "queue_transitions_index")).results).toHaveLength(1);
    });

    it("never rewrites a transition, because they are immutable", async () => {
      const db = d1();
      await projectQueueState(db, message({ generation: 5, transitions: [transition] }));
      await projectQueueState(
        db,
        message({
          generation: 6,
          transitions: [{ ...transition, digest: `sha256:${"9".repeat(64)}` }],
        }),
      );
      const stored = (await rows(db, "queue_transitions_index")).results;
      expect(stored).toHaveLength(1);
      // The original digest survives: a projection cannot rewrite history.
      expect(stored[0]).toMatchObject({ digest: `sha256:${"a".repeat(64)}` });
    });

    it("keeps transitions from different epochs apart", async () => {
      const db = d1();
      await projectQueueState(db, message({ generation: 5, transitions: [transition] }));
      await projectQueueState(
        db,
        message({ generation: 6, queueEpoch: 1, transitions: [transition] }),
      );
      expect((await rows(db, "queue_transitions_index")).results).toHaveLength(2);
    });
  });

  it("writes everything for one message atomically", async () => {
    const db = d1();
    await projectQueueState(
      db,
      message({
        generation: 7,
        entries: [readyEntry("Ready"), { ...readyEntry("Blocked"), entryId: "e2", pullRequestNumber: 43 }],
      }),
    );
    // Two entries and one mark, or none of it.
    expect((await rows(db, "queue_entries_index")).results).toHaveLength(2);
    expect((await rows(db, "queue_projection_marks")).results).toHaveLength(1);
  });

  it("drops an old projection delivery after project removal", async () => {
    const db = d1();
    await db.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org', '1', 'owner')").bind().run();
    await db.prepare(
      "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES ('org', ?, 'now', '7')",
    ).bind(message().repositoryId).run();

    expect(await projectQueueState(db, message())).toEqual({ applied: false, reason: "PROJECT_REMOVED", seen: 0 });
    expect((await rows(db, "queue_entries_index")).results).toEqual([]);
    expect((await rows(db, "queue_projection_marks")).results).toEqual([]);
  });
});

describe("readProjectedQueue", () => {
  const transition = (sequence: number) => ({
    transitionSequence: sequence,
    kind: "verified",
    digest: `sha256:${sequence.toString(16).padStart(64, "0")}`,
    priorDigest: sequence === 1 ? null : `sha256:${(sequence - 1).toString(16).padStart(64, "0")}`,
    baseSha: sequence.toString(16).padStart(40, "0"),
    attemptId: `att-${sequence}`,
    witnessCount: 1,
    observedAt: `2026-08-12T12:${String(sequence % 60).padStart(2, "0")}:00Z`,
  });
  const entry = (sequence: number, state = "Ready") => ({
    entryId: `e${sequence}`,
    pullRequestNumber: 100 + sequence,
    sponsorPrincipalId: "alice",
    state,
    primaryReason: null,
    fairnessOrdinal: String(sequence),
    schedulerEligible: state === "Ready",
    cooldownUntil: null,
    lastAttemptId: `att-${sequence}`,
    headSha: sequence.toString(16).padStart(40, "f"),
  });

  it("pages current entries and current-epoch history independently", async () => {
    const db = d1();
    await projectQueueState(
      db,
      message({
        entries: Array.from({ length: 45 }, (_, index) => entry(index + 1)),
        transitions: Array.from({ length: 45 }, (_, index) => transition(index + 1)),
      }),
    );

    const page = await readProjectedQueue(db, message().repositoryId, message().baseRef, {
      entriesPage: 2,
      transitionsPage: 3,
      pageSize: 20,
    });

    expect(page?.["pagination"]).toEqual({
      entries: { page: 2, pageSize: 20, total: 45, totalPages: 3 },
      transitions: { page: 3, pageSize: 20, total: 45, totalPages: 3 },
    });
    expect((page?.["entries"] as Array<{ pullRequestNumber: number }>).map((row) => row.pullRequestNumber)).toEqual(
      Array.from({ length: 20 }, (_, index) => 121 + index),
    );
    const history = page?.["transitions"] as Array<{
      transitionSequence: number;
      pullRequestNumber: number | null;
    }>;
    expect(history.map((row) => row.transitionSequence)).toEqual([5, 4, 3, 2, 1]);
    expect(history.map((row) => row.pullRequestNumber)).toEqual([105, 104, 103, 102, 101]);
    expect(page?.["chainHead"]).toEqual({ sequence: 45, digest: transition(45).digest });
  });

  it("keeps the unpaged API shape for existing CLI callers", async () => {
    const db = d1();
    await projectQueueState(
      db,
      message({
        entries: Array.from({ length: 25 }, (_, index) => entry(index + 1)),
        transitions: Array.from({ length: 25 }, (_, index) => transition(index + 1)),
      }),
    );

    const snapshot = await readProjectedQueue(db, message().repositoryId, message().baseRef);

    expect(snapshot).not.toHaveProperty("pagination");
    expect(snapshot?.["entries"]).toHaveLength(25);
    expect((snapshot?.["transitions"] as Array<{ transitionSequence: number }>).map((row) => row.transitionSequence)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it("does not return entries left behind by an older projection generation", async () => {
    const db = d1();
    await projectQueueState(db, message({ generation: 5, entries: [entry(1), entry(2)] }));
    await projectQueueState(db, message({ generation: 6, entries: [entry(3), entry(4, "Merged")] }));

    const page = await readProjectedQueue(db, message().repositoryId, message().baseRef, {
      entriesPage: 1,
      transitionsPage: 1,
      pageSize: 20,
    });

    expect(page?.["pagination"]).toMatchObject({ entries: { total: 1 } });
    expect(page?.["entries"]).toEqual([
      expect.objectContaining({ entryId: "e3", pullRequestNumber: 103 }),
    ]);
  });

  it("keeps an older epoch out of the current history page", async () => {
    const db = d1();
    await projectQueueState(db, message({ queueEpoch: 0, generation: 5, transitions: [transition(1)] }));
    const current = { ...transition(1), digest: `sha256:${"9".repeat(64)}` };
    await projectQueueState(db, message({ queueEpoch: 1, generation: 6, transitions: [current] }));

    const page = await readProjectedQueue(db, message().repositoryId, message().baseRef, {
      entriesPage: 1,
      transitionsPage: 1,
      pageSize: 20,
    });

    expect(page?.["pagination"]).toMatchObject({ transitions: { total: 1 } });
    expect(page?.["transitions"]).toEqual([expect.objectContaining({ digest: current.digest })]);
    expect(page?.["chainHead"]).toEqual({ sequence: 1, digest: current.digest });
  });
});

function readyEntry(state: string) {
  return {
    entryId: "e1",
    pullRequestNumber: 42,
    sponsorPrincipalId: "alice",
    state,
    primaryReason: null,
    fairnessOrdinal: "1",
  };
}
