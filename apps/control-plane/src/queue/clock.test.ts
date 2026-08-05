import { describe, expect, it, vi } from "vitest";
import {
  claimTick,
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
 * The queue kept answering webhooks for eleven hours on 5 August while its own
 * clock was dead, so the traffic needed to run a tick was arriving the whole
 * time and nothing was allowed to use it. This is what uses it.
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
