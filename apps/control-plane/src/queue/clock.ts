import type { D1Like } from "./projection.js";

/**
 * When the queue last moved, and what moved it.
 *
 * The five minute trigger was the only thing that ran the sweep. On 5 August
 * Cloudflare stopped dispatching it at 03:55Z, after thirteen consecutive
 * firings that exceeded the Worker's budget, and its own API went on listing
 * the schedule for the eleven hours that followed. Three deploys landed in that
 * window and none of them re-armed it. Webhooks arrived the whole time and not
 * one of them was allowed to move the queue.
 *
 * This row lets anything move it. The cron claims it, and a request that
 * arrives while the row is stale claims it too, so ordinary traffic carries the
 * queue whenever Cloudflare's clock is not. The claim is a compare-and-swap on
 * `started_at`, which is how the queue's own authority is held, so a busy minute
 * cannot start two ticks against one lane.
 */

export interface TickClock {
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly source: string;
}

/** How often the cron may claim: one firing of the five minute trigger. */
export const TICK_INTERVAL_SECONDS = 300;

/**
 * How long the queue may go without a finished tick before traffic takes over
 * and `/health` calls it stale. Three missed firings, which is past the
 * scheduling jitter Cloudflare accounts for and well inside the twenty minutes
 * an offer takes to expire.
 */
export const TICK_STALE_SECONDS = 900;

export function secondsBefore(now: string, seconds: number): string {
  return new Date(Date.parse(now) - seconds * 1000).toISOString();
}

/**
 * Take the tick, or find that somebody else has it.
 *
 * `notBefore` is the instant a claim is allowed to displace: the row is swapped
 * only when the last start is older than it. Written before the work rather
 * than after, so a tick that throws still holds the interval and cannot be
 * retried in a loop by the next request through the door.
 */
export async function claimTick(db: D1Like, now: string, notBefore: string, source: string): Promise<boolean> {
  const result = (await db
    .prepare("UPDATE queue_clock SET started_at = ?, source = ? WHERE id = 'tick' AND started_at < ?")
    .bind(now, source, notBefore)
    .run()) as { meta?: { changes?: number } };
  return (result.meta?.changes ?? 0) === 1;
}

/** Record that the work finished. Liveness is read from this, never from the claim. */
export async function finishTick(db: D1Like, now: string): Promise<void> {
  await db.prepare("UPDATE queue_clock SET finished_at = ? WHERE id = 'tick'").bind(now).run();
}

export async function readClock(db: D1Like): Promise<TickClock> {
  const row = await db
    .prepare("SELECT started_at AS startedAt, finished_at AS finishedAt, source FROM queue_clock WHERE id = 'tick'")
    .bind()
    .first<TickClock>();
  return row ?? { startedAt: "1970-01-01T00:00:00.000Z", finishedAt: null, source: "none" };
}

/**
 * Seconds since a tick last finished.
 *
 * A clock that has started a tick and never finished one reads as the age of
 * the start. A tick that fires every five minutes and dies every time is a
 * stopped clock, and reporting it as a working one is the failure this row
 * exists to end.
 */
export function tickAgeSeconds(clock: TickClock, now: string): number {
  const last = Date.parse(clock.finishedAt ?? clock.startedAt);
  return Math.max(0, Math.round((Date.parse(now) - last) / 1000));
}

/** What a request needs to decide whether it owes the queue a tick. */
export interface TrafficClockPorts {
  readClock: () => Promise<TickClock>;
  claim: (now: string, notBefore: string) => Promise<boolean>;
  finish: (now: string) => Promise<void>;
  run: () => Promise<void>;
}

/**
 * Run a tick on the way out of a request, when nothing else has run one.
 *
 * Cheap on the healthy path: one row read, and the claim is attempted only once
 * the clock is already past `TICK_STALE_SECONDS`. A queue whose cron is firing
 * never reaches the claim, and a queue whose cron has stopped moves on whatever
 * traffic it has.
 *
 * A failure is swallowed on purpose. The response has gone, the claim holds the
 * interval so the next request will not retry immediately, and the tick is left
 * unfinished, so `/health` goes on reporting the clock as stale rather than
 * reporting a tick that threw as a tick that worked.
 */
export async function tickOwedByTraffic(ports: TrafficClockPorts, now: string): Promise<void> {
  const clock = await ports.readClock();
  if (tickAgeSeconds(clock, now) < TICK_STALE_SECONDS) return;
  if (!(await ports.claim(now, secondsBefore(now, TICK_STALE_SECONDS)))) return;
  try {
    await ports.run();
    await ports.finish(now);
  } catch (error) {
    // wrangler tail is how this account observes the Worker, and a clock whose
    // failures vanish is the problem this module exists to prevent.
    console.error("[queue clock] a tick run from traffic failed:", error);
  }
}
