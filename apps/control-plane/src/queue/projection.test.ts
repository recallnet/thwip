import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { projectQueueState, type D1Like, type ProjectionMessage } from "./projection.js";

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
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations");
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    // Comments come out before the file is split into statements, not after.
    // A comment can contain a semicolon of its own — "the Durable Object is
    // live authority; these tables serve organization-wide reads" — and
    // splitting first cut a comment mid-sentence, leaving a fragment that
    // is not SQL in the same chunk as the statement that followed it.
    const withoutComments = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    for (const statement of withoutComments.split(";")) {
      const sql = statement.trim();
      if (sql.length === 0) continue;
      try {
        db.exec(sql);
      } catch (error) {
        // Migrations for tables this suite does not exercise reference schema it
        // never creates. Anything touching a queue projection table must work.
        if (/queue_(entries|transitions)_index|queue_projection_marks/.test(sql)) throw error;
      }
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

    it("drops a replay of the current generation", async () => {
      const db = d1();
      await projectQueueState(db, message());
      expect(await projectQueueState(db, message())).toMatchObject({ applied: false });
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
