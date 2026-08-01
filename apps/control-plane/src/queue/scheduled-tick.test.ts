// apps/control-plane/src/queue/scheduled-tick.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { tickAllQueues } from "./scheduled-tick.js";
import type { QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";

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

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

/**
 * Wraps a real D1Like so that any statement bound with `repositoryId` among its
 * parameters rejects, while every other statement runs against the real
 * database untouched. Used to make one repository's work fail for real, rather
 * than stubbing `driveTurn` in a way the code under test never reaches.
 */
function withFailingRepository(db: D1Like, repositoryId: string): D1Like {
  return {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => {
        const fails = values.includes(repositoryId);
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

function queue(repositoryId: string, enabled: number) {
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state)
       VALUES (?, 'org_1', ?, 'refs/heads/main', ?, 'enforced')`,
    )
    .run(`qp_${repositoryId}`, repositoryId, enabled);
}

describe("the queue heartbeat", () => {
  it("visits every enabled queue", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    const visited: string[] = [];
    const result = await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: (repositoryId) => visited.push(repositoryId),
    });
    expect(visited.sort()).toEqual(["1", "2"]);
    expect(result.ticked).toBe(2);
  });

  it("leaves a disabled queue alone", async () => {
    const e = env();
    queue("1", 0);
    const result = await tickAllQueues(e, { driveTurn: async () => {}, onQueueTicked: () => {} });
    expect(result.ticked).toBe(0);
  });

  /** A lane nobody holds needs no dispatch, and dispatching costs a CI run. */
  it("drives nobody when no lane is held", async () => {
    const e = env();
    queue("1", 1);
    let drives = 0;
    await tickAllQueues(e, { driveTurn: async () => void drives++, onQueueTicked: () => {} });
    expect(drives).toBe(0);
  });

  /** One queue failing must not stop the rest from being ticked. */
  it("keeps going when one queue throws", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    // Repository "1" is unreachable at the database, not merely undriven: this
    // is the seam that actually throws inside the per-queue try block, unlike
    // stubbing driveTurn, which is never called when no lane is held.
    const failingEnv = { ...e, DB: withFailingRepository(e.DB as unknown as D1Like, "1") } as unknown as QueueRouteEnv;
    const result = await tickAllQueues(failingEnv, {
      driveTurn: async () => {},
      onQueueTicked: () => {},
    });
    expect(result.ticked).toBe(2);
  });
});
