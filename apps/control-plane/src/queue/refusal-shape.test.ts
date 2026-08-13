import { afterEach, describe, expect, it, vi } from "vitest";
import { queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { queueExternalMove } from "./external-move.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";

vi.mock("./BranchQueue.js", () => ({ BranchQueue: class {} }));

/**
 * One way for a route to say no.
 *
 * Almost every refusal in the control plane is `{ error }`, sometimes with a
 * `detail` sentence beside it, and the dashboard's `api()` helper reads exactly
 * that. Three administrative queue routes answered a refused command with
 * `{ result: { status: "rejected", detail } }` and a 409 instead, so the reason
 * the queue gave never reached the screen: the reader was shown "409".
 *
 * The dashboard worked around it by fetching those three routes directly, which
 * moves the problem rather than fixing it. A client cannot be the place that
 * knows every shape a server might refuse in, because the next route to invent a
 * shape will not come with a client change.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "7".repeat(40);
const MOVED = "e".repeat(40);

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
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
    .run("alice", "org_1", "1", "alice");
  raw
    .prepare(
      `INSERT OR IGNORE INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, project_id)
       VALUES ('qp_1', 'org_1', ?, ?, 1, 'enforced', ?)`,
    )
    .run(REPO, REF, "proj_1");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function routes() {
  return queueRoutes(
    queueRouteDeps({ repositoryId: REPO, baseRef: REF, treeOid: TREE }, {
      activePolicy: async () => null,
    }) as Parameters<typeof queueRoutes>[0],
  );
}

/**
 * A branch that moved outside the queue. The queue pauses itself and refuses to
 * resume until somebody rebaselines it, which is the refusal a reader is most
 * likely to meet and the one that most needs explaining.
 */
async function movedOutsideTheQueue(e: QueueRouteEnv): Promise<void> {
  await queueExternalMove(e, { repositoryId: REPO, baseRef: REF, observedBaseSha: MOVED });
}

describe("how a queue route refuses", () => {
  it("says why a resume was refused, in the shape every other route refuses in", async () => {
    const e = env();
    const app = routes();
    await movedOutsideTheQueue(e);

    const refused = await app.request(
      `/v1/queue/${REPO}/resume?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    expect(refused.status).toBe(409);

    const body = (await refused.json()) as { error?: string; detail?: string };
    expect(body.error, "a refusal carries an error field, like every other route").toBeTypeOf("string");
    expect(body.detail, "and the sentence the queue actually gave").toContain("rebaseline");
  });

  /**
   * The reason has to survive as prose. Reduced to a code, the one reader who
   * can act on it is told `QUEUE_REFUSED` and has to go and look it up.
   */
  it("keeps the queue's own words rather than a code standing in for them", async () => {
    const e = env();
    const app = routes();
    await movedOutsideTheQueue(e);

    const refused = await app.request(
      `/v1/queue/${REPO}/resume?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    const body = (await refused.json()) as { detail?: string };
    expect(body.detail?.length ?? 0).toBeGreaterThan(20);
  });

  it("still reports an accepted command as a result rather than as a refusal", async () => {
    const e = env();
    const app = routes();

    const paused = await app.request(
      `/v1/queue/${REPO}/pause?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "looking into something" }),
      },
      e,
    );
    expect(paused.status).toBe(200);
    expect((await paused.json()) as { result?: unknown }).toHaveProperty("result");
  });
});
