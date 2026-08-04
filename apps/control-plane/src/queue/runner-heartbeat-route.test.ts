import { afterEach, describe, expect, it } from "vitest";
import { queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { commandsFor, buildSnapshot } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";

/**
 * `POST /v1/queue/:repositoryId/runners/heartbeat` (plan.md §5.0).
 *
 * The scheduler withholds an offer from a Ready entry until a compatible
 * runner is connected; this is the transport that tells it one just showed
 * up. It must clear `AGENT_OFFLINE` on arrival and write nothing on a
 * heartbeat that changes nothing, or a runner polling every fifteen seconds
 * would write to the queue document every fifteen seconds.
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

const REPO = "1315419165";
const REF = "refs/heads/main";
const ORG = "org_1";

/**
 * Device ids shaped the way `thwip queue work` sends them — the fingerprint of
 * the signing key it also signs proofs with. The route refuses anything it
 * could not have issued, because every distinct string it accepts becomes a
 * row in `queue_runners`'s primary key.
 */
const DEVICE = `SHA256:${"a".repeat(43)}`;
const SECOND_DEVICE = `SHA256:${"b".repeat(43)}`;

function routes(principalId = "alice") {
  return queueRoutes(
    queueRouteDeps({ repositoryId: REPO, baseRef: REF, principalId, isAdmin: false }, {
      verifyOidc: async () => null,
      activePolicy: async () => null,
      principalFor: async () => null,
    }) as Parameters<typeof queueRoutes>[0],
  );
}

function heartbeat(app: ReturnType<typeof routes>, e: QueueRouteEnv, deviceKeyId = DEVICE) {
  return app.request(
    `/v1/queue/${REPO}/runners/heartbeat`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKeyId }) },
    e,
  );
}

async function readyButOffline(db: D1Like, entryId: string, principal: string, pr: number): Promise<void> {
  await withQueueState(db, REPO, REF, (store) => {
    const commands = commandsFor(store);
    commands.requestQueue({
      idempotencyKey: `req-${entryId}`,
      entryId,
      pullRequestNumber: pr,
      sponsorPrincipalId: principal,
      sponsorGithubUserId: pr.toString(),
      headSha: "h".repeat(40),
    });
    commands.evaluateReadiness({
      idempotencyKey: `ready-${entryId}`,
      entryId,
      ready: true,
      schedulerEligible: false,
      primaryReason: "AGENT_OFFLINE",
    });
  });
}

/**
 * The repository, its organization, and the principals that belong to it.
 *
 * The project and principal rows are not decoration: the route refuses a
 * caller whose principal is not in the organization that owns the repository,
 * because the path it guards writes the queue document and dispatches Actions.
 */
function queueProject(): void {
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run(ORG, "1", "acme");
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state)
       VALUES ('qp_1', ?, ?, ?, 1, 'enforced')`,
    )
    .run(ORG, REPO, REF);
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", ORG, REPO, "acme/repo");
  for (const [id, githubUserId, login] of [
    ["alice", "1", "alice"],
    ["bob", "2", "bob"],
  ]) {
    raw
      .prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
      .run(id, ORG, githubUserId, login);
  }
}

describe("the heartbeat endpoint", () => {
  it("makes a Ready-but-offline entry eligible on arrival", async () => {
    const e = env();
    queueProject();
    await readyButOffline(e.DB as unknown as D1Like, "entry_a", "alice", 41);

    const app = routes("alice");
    const response = await heartbeat(app, e);
    expect(response.status).toBe(200);

    const snapshot = await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) => buildSnapshot(store));
    const entry = snapshot.entries.find((x) => x.entryId === "entry_a");
    expect(entry?.schedulerEligible).toBe(true);
    expect(entry?.primaryReason).toBeNull();
  });

  it("writes nothing to the queue document on a second heartbeat", async () => {
    const e = env();
    queueProject();
    await readyButOffline(e.DB as unknown as D1Like, "entry_a", "alice", 41);

    const app = routes("alice");
    await heartbeat(app, e);
    const generationAfterFirst = raw
      .prepare("SELECT generation FROM queue_state WHERE github_repository_id = ? AND base_ref = ?")
      .get(REPO, REF) as { generation: number };

    await heartbeat(app, e);
    const generationAfterSecond = raw
      .prepare("SELECT generation FROM queue_state WHERE github_repository_id = ? AND base_ref = ?")
      .get(REPO, REF) as { generation: number };

    expect(generationAfterSecond.generation).toBe(generationAfterFirst.generation);
  });

  it("does not touch an entry sponsored by a different principal", async () => {
    const e = env();
    queueProject();
    await readyButOffline(e.DB as unknown as D1Like, "entry_bob", "bob", 42);

    const app = routes("alice");
    await heartbeat(app, e);

    const snapshot = await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) => buildSnapshot(store));
    const entry = snapshot.entries.find((x) => x.entryId === "entry_bob");
    expect(entry?.schedulerEligible).toBe(false);
    expect(entry?.primaryReason).toBe("AGENT_OFFLINE");
  });

  /**
   * A cancelled entry is finished. The reducer has said so since a merged entry
   * was flipped to Cancelled by a late eject, and this path went around it: the
   * heartbeat re-derived readiness onto whatever carried AGENT_OFFLINE, so a
   * permanently cancelled entry came back from a heartbeat claiming to be
   * schedulable with nothing blocking it.
   */
  it("leaves a cancelled entry finished", async () => {
    const e = env();
    queueProject();
    const db = e.DB as unknown as D1Like;
    await readyButOffline(db, "entry_a", "alice", 41);
    await withQueueState(db, REPO, REF, (store) => {
      commandsFor(store).cancel({
        idempotencyKey: "cancel-entry-a",
        entryId: "entry_a",
        actorPrincipalId: "github",
        reason: "the pull request was closed",
      });
    });

    const response = await heartbeat(routes("alice"), e);
    expect(response.status).toBe(200);

    const snapshot = await withQueueState(db, REPO, REF, (store) => buildSnapshot(store));
    const entry = snapshot.entries.find((x) => x.entryId === "entry_a");
    expect(entry?.state).toBe("Cancelled");
    expect(entry?.schedulerEligible).toBe(false);
    expect(entry?.primaryReason).toBe("AGENT_OFFLINE");
  });

  it("reports holding an offer in the same call once the entry has been offered a turn", async () => {
    const e = env();
    queueProject();
    await readyButOffline(e.DB as unknown as D1Like, "entry_a", "alice", 41);

    const app = routes("alice");
    const first = (await (await heartbeat(app, e)).json()) as { holdsOffer: boolean };
    // Eligibility clearing runs the queue's own settle-tick, so the entry is
    // offered the lane in the same call that made it eligible.
    expect(first.holdsOffer).toBe(true);

    const second = (await (await heartbeat(app, e, SECOND_DEVICE)).json()) as { holdsOffer: boolean };
    expect(second.holdsOffer).toBe(true);
  });

  it("does not dispatch Actions for a lane held under a device-only profile", async () => {
    const e = env();
    queueProject();
    await readyButOffline(e.DB as unknown as D1Like, "entry_a", "alice", 41);

    let driven = 0;
    const app = queueRoutes({
      authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: false }),
      verifyOidc: async () => null,
      pinnedVerifier: async () => null,
      activePolicy: async () => ({ securityProfile: "fresh" }),
      dispatchCandidateVerification: async () => ({ ok: true }),
      queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
      principalFor: async () => null,
      pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF, authorIsBot: false }),
      driveTurn: async () => {
        driven += 1;
      },
      commitFacts: async () => ({ treeOid: "t".repeat(40), parentShas: ["p".repeat(40)] }),
    });

    const response = await heartbeat(app, e);
    expect(response.status).toBe(200);
    // The offer clears AGENT_OFFLINE and is offered in the same call — the
    // finding this guards is that this exact settle path used to dispatch
    // Actions for a lane no Actions run would ever claim.
    const snapshot = await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) => buildSnapshot(store));
    expect(snapshot.entries.find((x) => x.entryId === "entry_a")?.state).toBe("Offered");
    expect(driven).toBe(0);
  });

  it("still dispatches Actions for a lane held under a profile that needs it", async () => {
    const e = env();
    queueProject();
    await readyButOffline(e.DB as unknown as D1Like, "entry_a", "alice", 41);

    let driven = 0;
    const app = queueRoutes({
      authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: false }),
      verifyOidc: async () => null,
      pinnedVerifier: async () => null,
      activePolicy: async () => ({ securityProfile: "fast" }),
      dispatchCandidateVerification: async () => ({ ok: true }),
      queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
      principalFor: async () => null,
      pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF, authorIsBot: false }),
      driveTurn: async () => {
        driven += 1;
      },
      commitFacts: async () => ({ treeOid: "t".repeat(40), parentShas: ["p".repeat(40)] }),
    });

    const response = await heartbeat(app, e);
    expect(response.status).toBe(200);
    expect(driven).toBe(1);
  });

  it("rejects a heartbeat with no device key", async () => {
    const e = env();
    queueProject();
    const app = routes("alice");
    const response = await app.request(
      `/v1/queue/${REPO}/runners/heartbeat`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      e,
    );
    expect(response.status).toBe(400);
  });
});
