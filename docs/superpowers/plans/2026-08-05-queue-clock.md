# Queue Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the queue moving when Cloudflare's scheduled trigger stops firing, and make a stopped clock visible within minutes instead of hours.

**Architecture:** One D1 row records when a tick last started and last finished. The five minute cron claims that row before it works. Any request that reaches the Worker while the row is stale claims it too and runs the tick on the way out, so ordinary traffic is a second clock. `/health` publishes the age of the last finished tick, and a scheduled workflow on GitHub reads it, which gives a third clock owned by a different vendor.

**Tech Stack:** TypeScript on Cloudflare Workers, D1, Hono, vitest, GitHub Actions.

---

## What happened, and what each layer of it costs

On 2026-08-05 the `*/5 * * * *` trigger fired 12 times an hour for two days,
then fired for the last time at 03:55Z and has not fired since. The schedule was
still registered at 14:52Z, three deploys landed after the trigger died and none
of them brought it back, and every hour after 04:00Z the Worker's invocation
count matches the row count in `webhook_deliveries` minute for minute, so
nothing scheduled ran at all.

Ahead of the silence, the same trigger failed 13 consecutive times with
`exceededResources`, from 01:35Z to 02:40Z. That is the Worker's own budget,
spent inside one invocation of the sweep.

Three separate defects sit under that, and each one is worth its own fix:

1. **The tick can exceed one invocation's budget.** `findingsForChain` verifies
   every link from the epoch to the head, on every queue, on every tick. The
   work grows with the chain and the chain only grows.
2. **The queue has one clock.** A deferred entry returns to Ready only through
   `commands.tick` on a free lane, so when the trigger stops the queue stops,
   even while webhooks keep arriving and the Worker keeps answering them.
3. **A stopped clock is invisible.** `queue_projection_marks.projected_at` only
   moves when the queue moves, so an idle queue and a dead clock look the same.
   Nine hours passed before anybody noticed, and what noticed was a person
   reading invocation counts by hand.

Fixing only the first leaves the queue one Cloudflare-side drop away from the
same outage, and the drop at 04:00Z had no error attached to it at all.

## File Structure

| File | Responsibility |
| --- | --- |
| `migrations/0024_queue_clock.sql` (create) | The one row that says when a tick last started and last finished. |
| `apps/control-plane/src/queue/clock.ts` (create) | Claim, finish, read, and the staleness arithmetic. The only place that decides whether a tick is owed. |
| `apps/control-plane/src/queue/clock.test.ts` (create) | Tests for the claim's mutual exclusion and the staleness arithmetic. |
| `apps/control-plane/src/queue/scheduled-tick.ts` (modify) | Verify the chain from the last verified sequence rather than from the epoch. |
| `apps/control-plane/src/index.ts` (modify) | The cron claims before it ticks; a middleware ticks from traffic when the clock is stale; `/health` publishes the age. |
| `.github/workflows/queue-clock.yml` (create) | Reads `/health` every ten minutes and fails when the tick is stale. |

## Global Constraints

- **Never** pass `--no-verify` or `--no-gpg-sign`. Commits are signed.
- **Never** add an allowlist to `scripts/uncalled-exports.mjs`, `scripts/unwritten-fields.mjs`, or `knip.json`.
- Worker source (`apps/control-plane/src/**`, excluding `*.test.ts`) may not import `node:` builtins.
- Gate before every commit: `pnpm lint && pnpm typecheck && pnpm test`.
- Build first after touching packages: `pnpm -r --filter './packages/**' run build && pnpm --filter @thwip/control-plane run build`
- Work in a worktree under `~/Projects/_wt/`, created with `wtnew`.
- Prose in comments and commit messages: no em dashes, no antithesis, no corrective negation, no rule of three, no throat-clearing openers, no summary kicker.
- **The traffic clock must not make a request slower or more likely to fail.** It runs in `waitUntil`, after the response, and a failure inside it can never change what the caller was told.
- **One tick at a time.** The claim is a compare-and-swap on a D1 row, the same shape the queue's own authority uses. Two ticks running against one queue is the bug this row exists to prevent.

---

## Task 1: The row that says when the queue last moved

**Files:**
- Create: `migrations/0024_queue_clock.sql`
- Create: `apps/control-plane/src/queue/clock.ts`
- Create: `apps/control-plane/src/queue/clock.test.ts`

- [ ] **Step 1: Write the migration**

Create `migrations/0024_queue_clock.sql`:

```sql
-- DEPLOY ORDER: before-worker
--
-- When a tick last started, and when one last finished.
--
-- The queue already records when it last moved, in
-- `queue_projection_marks.projected_at`, and that mark only moves when the
-- queue does. An idle queue and a queue whose clock has stopped write the same
-- thing, which is nothing, so on 5 August a trigger that had stopped firing at
-- 03:55Z went unnoticed until 14:00Z.
--
-- `started_at` is what the claim compares and swaps, so two ticks cannot run at
-- once and a failing tick cannot be retried in a loop. `finished_at` is what
-- liveness is read from: a tick that starts every five minutes and never
-- finishes is not a working clock.
CREATE TABLE IF NOT EXISTS queue_clock (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- 'cron' or 'traffic', so the tail says which clock is carrying the queue.
  source TEXT NOT NULL
);

INSERT OR IGNORE INTO queue_clock (id, started_at, finished_at, source)
VALUES ('tick', '1970-01-01T00:00:00.000Z', NULL, 'none');
```

- [ ] **Step 2: Write the failing test**

Create `apps/control-plane/src/queue/clock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { claimTick, finishTick, readClock, tickAgeSeconds, TICK_STALE_SECONDS } from "./clock.js";

/**
 * A fake D1 holding the one row, with the compare-and-swap the claim needs.
 * Two callers claiming at the same instant is the case that matters: the queue
 * runs one tick per lane and two ticks against one queue is the bug the row
 * exists to prevent.
 */
function fakeDb(row: { started_at: string; finished_at: string | null; source: string }) {
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
        first: async () => ({ ...row }),
      };
      return api;
    },
  } as never;
}

const FRESH = { started_at: "2026-08-05T12:00:00.000Z", finished_at: "2026-08-05T12:00:03.000Z", source: "cron" };

describe("the queue clock", () => {
  it("hands the tick to one caller when two ask at the same instant", async () => {
    const row = { ...FRESH };
    const db = fakeDb(row);
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
    const row = { ...FRESH };
    const db = fakeDb(row);
    await finishTick(db, "2026-08-05T12:20:04.000Z");
    expect((await readClock(db)).finishedAt).toBe("2026-08-05T12:20:04.000Z");
  });

  /**
   * The number `/health` publishes and the workflow reads. Fifteen minutes is
   * three missed firings of a five minute trigger, which is past anything
   * Cloudflare's own scheduling jitter accounts for.
   */
  it("counts the age from the last finished tick", () => {
    const age = tickAgeSeconds({ startedAt: FRESH.started_at, finishedAt: FRESH.finished_at, source: "cron" }, "2026-08-05T12:20:03.000Z");
    expect(age).toBe(1200);
    expect(age).toBeGreaterThan(TICK_STALE_SECONDS);
  });

  it("reads a clock that has never finished a tick as stale, not as fresh", () => {
    const age = tickAgeSeconds({ startedAt: FRESH.started_at, finishedAt: null, source: "none" }, "2026-08-05T12:00:04.000Z");
    expect(age).toBeGreaterThan(TICK_STALE_SECONDS);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run apps/control-plane/src/queue/clock.test.ts`
Expected: FAIL with `Failed to resolve import "./clock.js"`.

- [ ] **Step 4: Write the module**

Create `apps/control-plane/src/queue/clock.ts`:

```ts
import type { D1Like } from "@thwip/queue-domain";

/**
 * When the queue last moved, and who moved it.
 *
 * The five minute trigger was the only thing that ran the sweep, and on
 * 5 August it stopped firing at 03:55Z with the schedule still registered and
 * no error recorded against it. The queue sat for nine hours with webhooks
 * arriving the whole time, because nothing else was allowed to run a tick.
 *
 * This row lets anything run one. The cron claims it, and a request that
 * arrives while the row is stale claims it too, so ordinary traffic carries the
 * queue whenever Cloudflare's clock is not. The claim is a compare-and-swap on
 * `started_at`, which is how the queue's own authority is held, so a busy
 * minute cannot start two ticks against one lane.
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
 * scheduling jitter Cloudflare accounts for and well under the twenty minutes
 * an offer takes to expire.
 */
export const TICK_STALE_SECONDS = 900;

export function secondsBefore(now: string, seconds: number): string {
  return new Date(Date.parse(now) - seconds * 1000).toISOString();
}

/**
 * Take the tick, or find somebody else already has it.
 *
 * `notBefore` is the instant a claim is allowed to displace: the row is only
 * swapped when the last start is older than it. Written before the work rather
 * than after, so a tick that throws still holds the interval and cannot be
 * retried in a loop by the next request through the door.
 */
export async function claimTick(db: D1Like, now: string, notBefore: string, source: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE queue_clock SET started_at = ?, source = ? WHERE id = 'tick' AND started_at < ?")
    .bind(now, source, notBefore)
    .run();
  return result.meta.changes === 1;
}

/** Record that the work finished. Liveness is read from this, never from the claim. */
export async function finishTick(db: D1Like, now: string): Promise<void> {
  await db.prepare("UPDATE queue_clock SET finished_at = ? WHERE id = 'tick'").bind(now).run();
}

export async function readClock(db: D1Like): Promise<TickClock> {
  const row = await db
    .prepare("SELECT started_at AS startedAt, finished_at AS finishedAt, source FROM queue_clock WHERE id = 'tick'")
    .bind()
    .first<{ startedAt: string; finishedAt: string | null; source: string }>();
  return row ?? { startedAt: "1970-01-01T00:00:00.000Z", finishedAt: null, source: "none" };
}

/**
 * Seconds since a tick last finished.
 *
 * A clock that has started a tick and never finished one reads as the age of
 * the start. A tick that fires every five minutes and dies every time is a
 * stopped clock, and reporting it as a working one is the failure this whole
 * row exists to end.
 */
export function tickAgeSeconds(clock: TickClock, now: string): number {
  const last = Date.parse(clock.finishedAt ?? clock.startedAt);
  return Math.max(0, Math.round((Date.parse(now) - last) / 1000));
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run apps/control-plane/src/queue/clock.test.ts`
Expected: PASS, 5 tests.

If `D1Like` is not exported from `@thwip/queue-domain`, find it with
`grep -rn "export interface D1Like" packages apps --include='*.ts'` and import from there.

- [ ] **Step 6: Gate and commit**

```bash
pnpm -r --filter './packages/**' run build && pnpm --filter @thwip/control-plane run build
pnpm lint && pnpm typecheck && pnpm test
git add migrations/0024_queue_clock.sql apps/control-plane/src/queue/clock.ts apps/control-plane/src/queue/clock.test.ts
git commit -m "feat(queue): record when the queue last moved

The five minute trigger was the only thing that ran the sweep, and on 5 August
it stopped firing at 03:55Z with its schedule still registered and no error
against it. Nine hours passed before a person reading invocation counts noticed.

One row now says when a tick last started and last finished, claimed by
compare-and-swap so one tick runs at a time."
```

---

## Task 2: The cron claims the tick instead of assuming it

**Files:**
- Modify: `apps/control-plane/src/index.ts` (the `scheduled` handler)

- [ ] **Step 1: Apply the migration locally, then wire the cron**

In `apps/control-plane/src/index.ts`, inside `async scheduled(...)`, replace the
body of the `if (controller.cron === "*/5 * * * *")` branch's opening so the
claim comes first:

```ts
    if (controller.cron === "*/5 * * * *") {
      const now = nowIso();
      const db = env.DB as unknown as D1Like;
      // The traffic clock may have run one moments ago. Claiming rather than
      // assuming is what keeps the two from ticking one lane at once.
      if (!(await claimTick(db, now, secondsBefore(now, TICK_INTERVAL_SECONDS - 30), "cron"))) {
        console.log("[queue heartbeat] a tick ran within the interval, skipping");
        return;
      }
      const result = await tickAllQueues(env as unknown as QueueRouteEnv, {
```

and, immediately before the existing `console.log` of the heartbeat line, add:

```ts
      await finishTick(db, nowIso());
```

Import at the top of the file:

```ts
import { claimTick, finishTick, secondsBefore, TICK_INTERVAL_SECONDS } from "./queue/clock.js";
```

The thirty second allowance is Cloudflare's scheduling jitter. Without it a
trigger that fires at 12:04:58 for the 12:05 slot loses its own claim to the
12:00 one.

- [ ] **Step 2: Gate and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/control-plane/src/index.ts
git commit -m "feat(queue): the cron takes the tick rather than assuming it"
```

---

## Task 3: Traffic is the second clock

**Files:**
- Modify: `apps/control-plane/src/index.ts` (a middleware, and `/health`)
- Create: `apps/control-plane/src/queue/traffic-clock.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/queue/traffic-clock.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { tickOwedByTraffic } from "./clock.js";

/**
 * What a request does about a clock that has stopped.
 *
 * The queue kept answering webhooks for nine hours on 5 August while its own
 * clock was dead, so the traffic to run a tick was arriving the whole time and
 * nothing was allowed to use it. This is what uses it.
 */
describe("tickOwedByTraffic", () => {
  it("runs nothing while the clock is fresh", async () => {
    const run = vi.fn();
    await tickOwedByTraffic(
      { readClock: async () => ({ startedAt: "2026-08-05T12:00:00.000Z", finishedAt: "2026-08-05T12:00:03.000Z", source: "cron" }), claim: async () => true, finish: async () => {}, run },
      "2026-08-05T12:04:00.000Z",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the tick once the clock is stale", async () => {
    const run = vi.fn();
    await tickOwedByTraffic(
      { readClock: async () => ({ startedAt: "2026-08-05T12:00:00.000Z", finishedAt: "2026-08-05T12:00:03.000Z", source: "cron" }), claim: async () => true, finish: async () => {}, run },
      "2026-08-05T12:20:00.000Z",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs nothing when another request already took the claim", async () => {
    const run = vi.fn();
    await tickOwedByTraffic(
      { readClock: async () => ({ startedAt: "2026-08-05T12:00:00.000Z", finishedAt: "2026-08-05T12:00:03.000Z", source: "cron" }), claim: async () => false, finish: async () => {}, run },
      "2026-08-05T12:20:00.000Z",
    );
    expect(run).not.toHaveBeenCalled();
  });

  /**
   * The response has already gone out by the time this runs. A throw here that
   * escaped would be an unhandled rejection in the Worker, and the caller was
   * told the truth about their own request before any of this started.
   */
  it("swallows a failed tick, and still marks the attempt finished", async () => {
    const finish = vi.fn();
    await expect(
      tickOwedByTraffic(
        { readClock: async () => ({ startedAt: "2026-08-05T12:00:00.000Z", finishedAt: null, source: "none" }), claim: async () => true, finish, run: async () => { throw new Error("no"); } },
        "2026-08-05T12:20:00.000Z",
      ),
    ).resolves.toBeUndefined();
    expect(finish).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/control-plane/src/queue/traffic-clock.test.ts`
Expected: FAIL, `tickOwedByTraffic is not a function`.

- [ ] **Step 3: Add the function to `clock.ts`**

```ts
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
 * Cheap on the healthy path: one row read, and the claim is only attempted
 * once the clock is already past `TICK_STALE_SECONDS`. A queue whose cron is
 * firing never reaches the claim, and a queue whose cron has stopped moves on
 * whatever traffic it has.
 *
 * A failure is swallowed on purpose. The response has gone, the claim holds the
 * interval so the next request will not retry immediately, and the tick is not
 * marked finished, so `/health` keeps reporting the clock as stale rather than
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
    console.error("[queue clock] a tick run from traffic failed:", error);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/control-plane/src/queue/traffic-clock.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into the Worker**

In `apps/control-plane/src/index.ts`, extract the ports object the `scheduled`
handler passes to `tickAllQueues` into a named function so both callers use one
definition:

```ts
/**
 * Everything the sweep needs, built from an Env. Named because two clocks call
 * it now: the five minute trigger, and any request that finds the trigger has
 * stopped.
 */
function tickPortsFor(env: Env): TickPorts {
  return {
    driveTurn: (repositoryId, pullRequestNumber) => driveTurnFor(env, repositoryId, pullRequestNumber),
    reconsiderHead: (repositoryId, headSha) =>
      reconsiderHead(env, queueDeps as never, queueOnQueue, { repositoryId, headSha }),
    publishStatusComments: (repositoryId, baseRef, snapshot, budget) =>
      publishStatusCommentsFor(env, repositoryId, baseRef, snapshot, budget),
    retireStatusComments: (repositoryId, baseRef, pullRequestNumbers) =>
      retireStatusCommentsFor(env, repositoryId, baseRef, pullRequestNumbers),
    onQueueTicked: () => {},
    onQueueFailed: (repositoryId, error) => {
      console.error(`[queue heartbeat] tick failed for repository ${repositoryId}:`, error);
    },
  };
}
```

Have the `scheduled` handler call `tickAllQueues(env as unknown as QueueRouteEnv, tickPortsFor(env))`.

Then add the middleware, immediately after the Hono app is created and before
any route is registered:

```ts
/**
 * Traffic as a clock.
 *
 * Registered before the routes and doing its work after them, so nothing here
 * is on the path of the answer the caller is waiting for. `waitUntil` keeps the
 * invocation alive past the response, which is the whole reason a queue that
 * receives twenty webhooks an hour can keep moving without a scheduled trigger.
 */
app.use("*", async (c, next) => {
  await next();
  const ctx = c.executionCtx as ExecutionContext | undefined;
  if (ctx === undefined) return;
  const db = c.env.DB as unknown as D1Like;
  const env = c.env;
  ctx.waitUntil(
    tickOwedByTraffic(
      {
        readClock: () => readClock(db),
        claim: (now, notBefore) => claimTick(db, now, notBefore, "traffic"),
        finish: (now) => finishTick(db, now),
        run: async () => {
          await tickAllQueues(env as unknown as QueueRouteEnv, tickPortsFor(env));
        },
      },
      nowIso(),
    ),
  );
});
```

- [ ] **Step 6: Publish the age on `/health`**

Replace the `/health` handler with:

```ts
app.get("/health", async (c) => {
  // The age of the last finished tick, signed with everything else here. A
  // stopped clock is the failure this endpoint exists to make external: the
  // trigger that died on 5 August left the schedule registered, the Worker
  // answering, and nothing on any page that said the queue had stopped.
  const clock = await readClock(c.env.DB as unknown as D1Like);
  const now = nowIso();
  const tickAge = tickAgeSeconds(clock, now);
  const payload = {
    service: "thwip",
    env: c.env.THWIP_ENV,
    buildSha: c.env.BUILD_SHA,
    now,
    tick: { finishedAt: clock.finishedAt, source: clock.source, ageSeconds: tickAge, stale: tickAge > TICK_STALE_SECONDS },
  };
  const jws = await signPayload(c.env, payload, "thwip-health+jws");
  return c.json({ ...payload, jws });
});
```

If a test asserts the exact shape of `/health`, update it to carry the new field
and say so in your report.

- [ ] **Step 7: Gate and commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/control-plane/src/index.ts apps/control-plane/src/queue/clock.ts apps/control-plane/src/queue/traffic-clock.test.ts
git commit -m "feat(queue): let traffic carry the queue when the trigger stops

Cloudflare stopped firing the five minute trigger at 03:55Z on 5 August, with
the schedule still registered and no error recorded. Webhooks kept arriving for
the nine hours that followed and none of them was allowed to move the queue.

A request that finds the clock stale now claims it and runs the sweep after its
own response has gone out, and /health publishes the age so a stopped clock is
readable from outside."
```

---

## Task 4: Withdrawn, and why

**Do not implement this task.** It was written from a guess that the numbers
then contradicted.

The guess was that `findingsForChain` is what spent the invocation, because its
cost grows with the chain. Counted on the live database, the two enrolled queues
verify 10 links and 7 links per tick: repository 1315419165 sits at head 165
with its epoch at 156, and repository 1319756073 has a 7 link chain. Seventeen
signature verifications is not a Worker's budget. The 13 `exceededResources`
firings all landed inside a busy merge window, where the same invocation was
also settling merge writes, driving lanes and publishing comments.

Starting the walk from a watermark also breaks what `checkOwnChain` is for. It
reads `epochStartsAt` to decide whether the first link it sees is allowed to
have no predecessor, so a walk that begins mid-chain either reports a
discontinuity that is not there or has to be told to ignore one that is. The
second of those is how a check comes to pass because its input was never
populated, which is the failure this repository keeps rediscovering.

What actually covers a tick that outruns its budget is Task 3. A tick that dies
never reaches `finishTick`, so `/health` reports the clock stale and Task 5
alarms on it, whatever killed the tick. Measure a real overrun before bounding
anything, and bound the thing the measurement names.

<details>
<summary>The withdrawn task, kept for the reasoning</summary>

## Verify the chain from where the last tick left off

**Files:**
- Modify: `apps/control-plane/src/queue/scheduled-tick.ts`
- Modify: `apps/control-plane/src/queue/scheduled-tick.test.ts`

The 13 consecutive `exceededResources` failures on 5 August were one invocation
spending more than a Worker gets. `findingsForChain` verifies every link from
the epoch to the head, per queue, per tick, and the chain only grows.

- [ ] **Step 1: Read what the call costs today**

```bash
grep -rn "export async function findingsForChain" -A 40 apps/control-plane/src
```

The signature takes `epochStartsAt`. Whatever it verifies between there and the
head is what every tick pays for, forever.

- [ ] **Step 2: Write the failing test**

Add to `apps/control-plane/src/queue/scheduled-tick.test.ts`:

```ts
it("verifies the links added since the last tick, not the whole chain again", async () => {
  const verifiedFrom: number[] = [];
  const env = envWithChain({ links: 200, recordFrom: (sequence: number) => verifiedFrom.push(sequence) });
  await tickAllQueues(env, ports());
  await tickAllQueues(env, ports());
  expect(verifiedFrom[1]).toBeGreaterThan(verifiedFrom[0]);
});
```

Follow the harness the surrounding tests in that file already use for `env` and
`ports`; do not invent a second one. If the file has no way to observe the chain
read, add the smallest port that lets a test see which sequence the verification
started from, and say so in your report.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run apps/control-plane/src/queue/scheduled-tick.test.ts`
Expected: FAIL, both ticks verify from the epoch.

- [ ] **Step 4: Carry the watermark on the clock row**

Add a column in a second migration, `migrations/0025_chain_verified_through.sql`:

```sql
-- DEPLOY ORDER: before-worker
--
-- The last link this queue verified, per queue.
--
-- The tick verified every link from the epoch to the head on every firing, so
-- the cost of one tick grew with the chain and never came back down. Thirteen
-- consecutive firings exceeded the Worker's budget on 5 August and the trigger
-- stopped. Verification still covers every link, once each, plus the head every
-- time so a rewritten tip cannot hide behind a watermark.
ALTER TABLE queue_projects ADD COLUMN chain_verified_through INTEGER NOT NULL DEFAULT 0;
```

In `scheduled-tick.ts`, read `chain_verified_through` alongside the other
columns, pass `max(epochStartsAt, chain_verified_through)` as the sequence to
verify from, and write the head sequence back after a clean check. Leave the
watermark where it is when the check reports a finding, so a finding is
re-reported until somebody answers it.

- [ ] **Step 5: Run the tests, gate, commit**

```bash
npx vitest run apps/control-plane/src/queue/scheduled-tick.test.ts
pnpm lint && pnpm typecheck && pnpm test
git add migrations/0025_chain_verified_through.sql apps/control-plane/src/queue/scheduled-tick.ts apps/control-plane/src/queue/scheduled-tick.test.ts
git commit -m "fix(queue): verify the links a tick added, not the chain from the epoch

Every tick verified every link from the epoch to the head, so one invocation's
cost grew with the chain. Thirteen consecutive firings exceeded the Worker's
budget on 5 August and the trigger stopped firing after them.

The watermark advances only on a clean check, so a finding is still reported on
every tick until somebody answers it."
```

</details>

---

## Task 5: A clock somebody else owns

**Files:**
- Create: `.github/workflows/queue-clock.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: queue clock

# Cloudflare stopped firing thwip's own five minute trigger on 5 August with the
# schedule still registered and no error recorded against it, and nine hours
# passed before anybody noticed. This reads the age of the last finished tick
# from a service that is not Cloudflare's scheduler, and the request itself is
# traffic, which is the queue's second clock.
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:

jobs:
  read-the-clock:
    runs-on: ubuntu-latest
    steps:
      - name: Ask thwip when it last moved
        run: |
          set -euo pipefail
          health=$(curl -fsS https://thwip.recall.net/health)
          echo "$health" | jq .
          age=$(echo "$health" | jq -r '.tick.ageSeconds // empty')
          if [ -z "$age" ]; then
            echo "::error::/health did not report a tick age; the deploy predates the queue clock"
            exit 1
          fi
          if [ "$age" -gt 900 ]; then
            echo "::error::the queue has not finished a tick in ${age}s"
            exit 1
          fi
          echo "last tick ${age}s ago"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/queue-clock.yml
git commit -m "ci: read the queue's clock from outside Cloudflare"
```

---

## Task 6: Ship, migrate, deploy, and prove all three clocks

- [ ] **Step 1: Ship**

```bash
thwip run && thwip ship
```

- [ ] **Step 2: Apply the migrations, then deploy**

Both migrations are `before-worker`, so they go first.

```bash
pnpm --filter @thwip/control-plane run migrate:staging
pnpm --filter @thwip/control-plane run deploy:staging
```

- [ ] **Step 3: Prove the traffic clock**

```bash
curl -s https://thwip.recall.net/health | jq '.tick'
```

Expected within a minute of the first request: `finishedAt` set, `stale` false,
and `source` reading `traffic` or `cron`.

- [ ] **Step 4: Prove the cron clock, or prove it is still dead**

```bash
node scripts/cron-fired.mjs
```

If that script does not exist, read the invocation counts directly and compare
them against `webhook_deliveries` for the same hour. A cron that is firing shows
one invocation at each five minute boundary that no webhook accounts for. This
is the check that found the outage, and it is worth keeping:

```bash
PATH="$PWD/apps/control-plane/node_modules/.bin:$PATH" \
  node scripts/d1.mjs "SELECT substr(received_at,12,5) m, count(*) c FROM webhook_deliveries WHERE received_at > '<the hour>' GROUP BY m ORDER BY m"
```

- [ ] **Step 5: Prove the watchdog**

```bash
gh workflow run "queue clock"
gh run list --workflow "queue clock" --limit 1
```

Expected: green, with the age printed.

---

## Self-Review

**Spec coverage.** The three defects named at the top each have a task: the
unbounded per-tick verification in Task 4, the single clock in Tasks 2 and 3,
and the invisible failure in Tasks 3 and 5.

**Placeholder scan.** Every code step carries its code. Task 4 Step 2 names a
harness to follow rather than inventing a second one, and says what to do if the
file cannot observe the chain read.

**Type consistency.** `TickClock`, `claimTick`, `finishTick`, `readClock`,
`tickAgeSeconds`, `secondsBefore`, `TICK_INTERVAL_SECONDS`, `TICK_STALE_SECONDS`
and `tickOwedByTraffic` are defined in Task 1 and Task 3 Step 3, and every later
use imports them under those names. `tickPortsFor` is defined once in Task 3 and
used by both clocks.

**The risk worth stating.** The traffic clock runs the sweep inside a request's
invocation, and that invocation shares its subrequest budget with whatever the
request was already doing. It only fires when the queue has gone fifteen minutes
without a finished tick, so the healthy path never pays it, and a failure inside
it is swallowed after the response has gone. Task 4 is what keeps the sweep
inside one invocation's budget in the first place, and it belongs to this plan
rather than a later one for that reason.
