import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import {
  claimTick,
  failTick,
  finishTick,
  readClock,
  tickAgeSeconds,
  tickOwedByTraffic,
  TICK_STALE_SECONDS,
} from "./clock.js";
import type { D1Like } from "./projection.js";

/**
 * A fake D1 holding the one row, with the compare-and-swap the claim needs.
 *
 * Two callers claiming at the same instant is the case that matters. The queue
 * runs one tick per lane, and two ticks against one lane is the bug the row
 * exists to prevent.
 */
function fakeDb(row: { started_at: string; finished_at: string | null; source: string }): D1Like {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const api = {
        bind: (...values: unknown[]) => {
          args = values;
          return api;
        },
        run: async () => {
          if (sql.includes("UPDATE queue_clock SET started_at")) {
            const [startedAt, source, notBefore] = args as [string, string, string];
            if (row.started_at >= notBefore) return { meta: { changes: 0 } };
            row.started_at = startedAt;
            row.source = source;
            return { meta: { changes: 1 } };
          }
          const [finishedAt] = args as [string];
          row.finished_at = finishedAt;
          return { meta: { changes: 1 } };
        },
        first: async <T>() =>
          ({
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            source: row.source,
          }) as T,
        all: async <T>() => ({ results: [] as T[] }),
      };
      return api;
    },
    batch: async () => undefined,
  };
}

const FRESH = {
  started_at: "2026-08-05T12:00:00.000Z",
  finished_at: "2026-08-05T12:00:03.000Z",
  source: "cron",
};

describe("the queue clock", () => {
  it("hands the tick to one caller when two ask at the same instant", async () => {
    const db = fakeDb({ ...FRESH });
    const both = await Promise.all([
      claimTick(db, "2026-08-05T12:20:00.000Z", "2026-08-05T12:15:00.000Z", "cron"),
      claimTick(db, "2026-08-05T12:20:00.000Z", "2026-08-05T12:15:00.000Z", "traffic"),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a claim while the last tick is recent enough", async () => {
    const db = fakeDb({ ...FRESH });
    expect(await claimTick(db, "2026-08-05T12:01:00.000Z", "2026-08-05T11:56:00.000Z", "cron")).toBe(false);
  });

  it("records when the tick finished, so a tick that starts and dies reads as stale", async () => {
    const db = fakeDb({ ...FRESH });
    await finishTick(db, "2026-08-05T12:20:04.000Z");
    expect((await readClock(db)).finishedAt).toBe("2026-08-05T12:20:04.000Z");
  });

  /**
   * The number `/health` publishes and the workflow reads. Fifteen minutes is
   * three missed firings of a five minute trigger, past anything Cloudflare's
   * own scheduling jitter accounts for.
   */
  it("counts the age from the last finished tick", () => {
    const age = tickAgeSeconds(
      { startedAt: FRESH.started_at, finishedAt: FRESH.finished_at, source: "cron" },
      "2026-08-05T12:20:03.000Z",
    );
    expect(age).toBe(1200);
    expect(age).toBeGreaterThan(TICK_STALE_SECONDS);
  });

  it("reads a clock that has never finished a tick as stale, not as fresh", () => {
    const age = tickAgeSeconds(
      { startedAt: FRESH.started_at, finishedAt: null, source: "none" },
      "2026-08-05T12:20:04.000Z",
    );
    expect(age).toBeGreaterThan(TICK_STALE_SECONDS);
  });
});

/**
 * What a request does about a clock that has stopped.
 *
 * The Worker may keep answering webhooks while its scheduled clock is dead.
 * This path lets that traffic run the overdue tick.
 */
describe("tickOwedByTraffic", () => {
  const fresh = { startedAt: "2026-08-05T12:00:00.000Z", finishedAt: "2026-08-05T12:00:03.000Z", source: "cron" };

  it("runs nothing while the clock is fresh", async () => {
    const run = vi.fn();
    await tickOwedByTraffic(
      { readClock: async () => fresh, claim: async () => true, finish: async () => {}, run },
      "2026-08-05T12:04:00.000Z",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the tick once the clock is stale", async () => {
    const run = vi.fn();
    await tickOwedByTraffic(
      { readClock: async () => fresh, claim: async () => true, finish: async () => {}, run },
      "2026-08-05T12:20:00.000Z",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * A cron that starts a tick every five minutes and never finishes one must
   * not lock traffic out of the queue.
   *
   * The claim once compared `started_at` against the same interval that defines
   * staleness. Each failing firing could then refresh `started_at` and postpone
   * traffic takeover again.
   *
   * Two different questions were being asked of one column. Whether a tick is
   * already running is about `started_at` and is answered in minutes. Whether
   * the queue has stopped is about `finished_at` and is answered in quarter
   * hours.
   */
  it("takes over from a cron that keeps starting ticks and never finishing one", async () => {
    const run = vi.fn();
    await tickOwedByTraffic(
      {
        readClock: async () => ({
          startedAt: "2026-08-05T19:10:47.000Z",
          finishedAt: "2026-08-05T18:46:42.000Z",
          source: "cron",
        }),
        claim: async (_now, notBefore) =>
          // The real compare-and-swap: the row is only taken when the last
          // start is older than `notBefore`.
          "2026-08-05T19:10:47.000Z" < notBefore,
        finish: async () => {},
        run,
      },
      "2026-08-05T19:14:52.000Z",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves a tick that is genuinely in flight alone", async () => {
    const run = vi.fn();
    await tickOwedByTraffic(
      {
        readClock: async () => ({
          startedAt: "2026-08-05T19:14:30.000Z",
          finishedAt: "2026-08-05T18:46:42.000Z",
          source: "cron",
        }),
        claim: async (_now, notBefore) => "2026-08-05T19:14:30.000Z" < notBefore,
        finish: async () => {},
        run,
      },
      "2026-08-05T19:14:52.000Z",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("runs nothing when another request already took the claim", async () => {
    const run = vi.fn();
    await tickOwedByTraffic(
      { readClock: async () => fresh, claim: async () => false, finish: async () => {}, run },
      "2026-08-05T12:20:00.000Z",
    );
    expect(run).not.toHaveBeenCalled();
  });

  /**
   * The response has already gone out by the time this runs. A throw that
   * escaped would be an unhandled rejection in the Worker, and the caller was
   * told the truth about their own request before any of this started.
   *
   * The attempt is deliberately left unfinished, so `/health` keeps reporting a
   * clock whose ticks throw as stale.
   */
  it("swallows a failed tick and leaves the clock reading stale", async () => {
    const finish = vi.fn();
    await expect(
      tickOwedByTraffic(
        {
          readClock: async () => ({ startedAt: fresh.startedAt, finishedAt: null, source: "none" }),
          claim: async () => true,
          finish,
          run: async () => {
            throw new Error("no");
          },
        },
        "2026-08-05T12:20:00.000Z",
      ),
    ).resolves.toBeUndefined();
    expect(finish).not.toHaveBeenCalled();
  });
});

/**
 * A stopped clock that says only how long it has been stopped.
 *
 * An age alone does not explain why the clock stopped, so the failure is stored
 * with the clock.
 */
describe("why the last tick did not finish", () => {
  const held: Array<{ close(): void }> = [];
  const database = (): D1Like => {
    const t = testD1();
    held.push(t);
    return t.db as unknown as D1Like;
  };
  afterEach(() => {
    while (held.length > 0) held.pop()!.close();
  });

  it("keeps the reason a tick threw", async () => {
    const db = database();

    await failTick(db, "2026-08-09T12:00:00.000Z", new Error("Worker exceeded resource limits"));

    const clock = await readClock(db);
    expect(clock.lastError).toContain("exceeded resource limits");
    expect(clock.lastErrorAt).toBe("2026-08-09T12:00:00.000Z");
  });

  /** A cause left standing for a queue that has recovered is the same lie as a stale comment. */
  it("forgets it once a tick finishes cleanly", async () => {
    const db = database();

    await failTick(db, "2026-08-09T12:00:00.000Z", new Error("Worker exceeded resource limits"));
    await finishTick(db, "2026-08-09T12:05:00.000Z");

    const clock = await readClock(db);
    expect(clock.lastError).toBeNull();
    expect(clock.lastErrorAt).toBeNull();
  });

  it("says nothing about a clock that has never failed", async () => {
    expect((await readClock(database())).lastError).toBeNull();
  });
});
