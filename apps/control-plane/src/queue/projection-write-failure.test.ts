import { afterEach, describe, expect, it, vi } from "vitest";
import { queueRouteDeps } from "../../test/queue-deps.js";
import { seedActiveProject, testD1 } from "../../test/d1.js";
import { queueRoutes, runOnQueue, type QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";

/**
 * The projection write at the end of `runOnQueue`, and the backfill inside the
 * read route, both swallow a failed write with a bare `catch {}`. That is the
 * right call for the command's own result — the object is authority, the
 * projection is a cache, and a stale cache costs a reader a stale answer, not a
 * wrong one. What a bare catch leaves out is any way to tell a write that always
 * fails from a write that never does; both look, from the outside, like a
 * dashboard that is merely a few seconds behind. That is how a dashboard came to
 * show `PR_DRAFT` for a pull request that had gone ready: the write was failing
 * on every attempt and nothing said so.
 *
 * These tests break only the projection's own write — the `queue_projection_marks`
 * insert `projectQueueState` always issues — while leaving every other statement
 * on the same database working, so a passing test proves the command's result
 * (or the read's answer) is unaffected by the projection failing, and a failing
 * one proves the failure went unlogged.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";

function brokenProjectionDb(db: D1Like): D1Like {
  return {
    prepare: (query: string) => {
      if (query.includes("INSERT INTO queue_projection_marks")) {
        return {
          bind: () => ({
            run: async () => {
              throw new Error("D1_ERROR: projection marks write failed");
            },
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      }
      return db.prepare(query);
    },
    batch: (statements) => db.batch(statements),
  } as unknown as D1Like;
}

/** A queue environment whose projection write always fails; the rest of the schema works. */
function env(): QueueRouteEnv {
  const t = testD1();
  seedActiveProject(t, { repositoryId: REPO, organizationId: "org_1", projectId: "proj_1" });
  open.push(t);
  raw = t.raw;
  return { DB: brokenProjectionDb(t.db), PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

function seedMembership(principalId: string, githubUserId: string): void {
  raw
    .prepare("INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_1", "1", "acme");
  raw
    .prepare(
      "INSERT OR IGNORE INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  raw
    .prepare(
      "INSERT OR IGNORE INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run(principalId, "org_1", githubUserId, `author${githubUserId}`);
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  vi.restoreAllMocks();
});

describe("runOnQueue: the post-command projection write", () => {
  it("logs the failure and still returns the command's own result", async () => {
    const e = env();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // A no-op `decide` leaves the store's generation at zero, which
    // `projectQueueState` reads as nothing new and returns from before ever
    // writing — the write under test needs a real state change to reach it.
    const { result } = await runOnQueue(e, REPO, REF, ({ commands }) =>
      commands.pause({ idempotencyKey: "pause-1", actorPrincipalId: "alice", reason: "test" }),
    );

    expect(result.status).toBe("applied");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, error] = errorSpy.mock.calls[0]!;
    expect(message).toContain(REPO);
    expect(message).toContain(REF);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("GET /v1/queue/:repositoryId: the backfill projection write", () => {
  it("logs the failure and still answers from the queue it just read", async () => {
    const e = env();
    seedMembership("alice", "1");

    // A queue with nothing that ever happened to it projects at generation
    // zero, which reads as "nothing new" and never reaches the write under
    // test. Pausing gives the read something real to project — done against
    // the same broken database, so nothing gets projected here either, and
    // the read below still finds nothing to serve from the projection and
    // falls into the backfill this test is about. That setup call fails its
    // own projection write too, which is not what this test is checking, so
    // it runs before the spy that counts calls exists.
    await runOnQueue(e, REPO, REF, ({ commands }) =>
      commands.pause({ idempotencyKey: "pause-1", actorPrincipalId: "alice", reason: "test" }),
    );

    const app = queueRoutes(queueRouteDeps({ repositoryId: REPO, baseRef: REF }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request(`/v1/queue/${REPO}?ref=${encodeURIComponent(REF)}`, {}, e);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { source: string };
    expect(body.source).toBe("queue");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, error] = errorSpy.mock.calls[0]!;
    expect(message).toContain(REPO);
    expect(message).toContain(REF);
    expect(error).toBeInstanceOf(Error);
  });
});
