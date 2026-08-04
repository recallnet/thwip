import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { buildSnapshot, commandsFor } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";

/**
 * Who a turn belongs to, and what happens when a pull request comes back.
 *
 * One pull request has one sponsor: the person who wrote it. Two routes place
 * entries — this one and the `pull_request` webhook — and while they disagreed
 * about that, a `fresh` queue offered the turn to one person and waited for
 * another person's machine to claim it, which nobody ever did.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const ORG = "org_1";

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  seed();
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

/** The repository, its queue, and the two people who show up below. */
function seed(): void {
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run(ORG, "1", "acme");
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", ORG, REPO, "acme/repo");
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state)
       VALUES ('qp_1', ?, ?, ?, 1, 'enforced')`,
    )
    .run(ORG, REPO, REF);
  for (const [id, githubUserId] of [
    ["alice", "1"],
    ["bob", "2"],
  ]) {
    raw
      .prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
      .run(id, ORG, githubUserId, id);
  }
}

/**
 * Alice is signed in. Bob wrote pull request 7, so bob sponsors it however it
 * reaches the queue.
 */
function app(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  return queueRoutes({
    authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: true }),
    verifyOidc: async () => ({ repository_id: REPO }),
    pinnedVerifier: async () => null,
    activePolicy: async () => null,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
    principalFor: async (_e: unknown, githubUserId: string) => (githubUserId === "2" ? "bob" : "alice"),
    pullRequestPlacement: async () => ({ authorGithubUserId: "2", baseRef: REF, authorIsBot: false }),
    driveTurn: async () => {},
    commitFacts: async () => ({ treeOid: "t".repeat(40), parentShas: ["p".repeat(40)] }),
    ...over,
  });
}

function join(routes: ReturnType<typeof app>, e: QueueRouteEnv, over: Record<string, unknown> = {}) {
  return routes.request(
    `/v1/queue/${REPO}/entries?ref=${encodeURIComponent(REF)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pullRequestNumber: 7, headSha: "a".repeat(40), ...over }),
    },
    e,
  );
}

async function entry(e: QueueRouteEnv, entryId = `entry_${REPO}_7`) {
  const snapshot = await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) => buildSnapshot(store));
  return snapshot.entries.find((x) => x.entryId === entryId);
}

describe("joining the queue", () => {
  it("sponsors the entry with the pull request's author, not the caller", async () => {
    const e = env();
    const response = await join(app(), e);
    expect(response.status).toBe(202);
    expect((await entry(e))?.sponsorPrincipalId).toBe("bob");
  });

  it("refuses a pull request whose author has no activated principal", async () => {
    const e = env();
    const response = await join(app({ principalFor: async () => null }), e);
    expect(response.status).toBe(409);
    expect(await entry(e)).toBeUndefined();
  });

  /**
   * The caller names the branch, and nothing used to check it against the
   * branch the pull request actually targets. A mismatch put a second entry for
   * one pull request on a second queue document, each with its own sponsor and
   * its own turn.
   */
  it("refuses to place a pull request on a branch it does not target", async () => {
    const e = env();
    const routes = app({
      pullRequestPlacement: async () => ({ authorGithubUserId: "2", baseRef: "refs/heads/release", authorIsBot: false }),
    });
    const response = await join(routes, e);
    expect(response.status).toBe(409);
    expect(await entry(e)).toBeUndefined();
  });

  it("refuses when the pull request cannot be read, rather than sponsoring the caller", async () => {
    const e = env();
    const response = await join(app({ pullRequestPlacement: async () => null }), e);
    expect(response.status).toBe(502);
    expect(await entry(e)).toBeUndefined();
  });
});

/**
 * Closing and reopening a pull request cancels its entry. Every attempt to
 * queue it again answered "duplicate" — the entry existed, so the request was
 * discarded without anybody looking at what state it was in — and the pull
 * request could never be merged again.
 */
describe("a pull request that comes back", () => {
  async function cancel(routes: ReturnType<typeof app>, e: QueueRouteEnv) {
    const response = await routes.request(
      `/v1/queue/${REPO}/entries/entry_${REPO}_7?ref=${encodeURIComponent(REF)}&reason=closed`,
      { method: "DELETE" },
      e,
    );
    expect(response.status).toBe(200);
    expect((await entry(e))?.state).toBe("Cancelled");
  }

  it("takes its place in line again", async () => {
    const e = env();
    const routes = app();
    await join(routes, e);
    await cancel(routes, e);

    await join(routes, e, {});
    const back = await entry(e);
    expect(back?.state).not.toBe("Cancelled");
    expect(back?.sponsorPrincipalId).toBe("bob");
  });

  it("goes to the back of the line rather than keeping its old place", async () => {
    const e = env();
    const routes = app();
    await join(routes, e);
    const before = (await entry(e))!.fairnessOrdinal;
    await cancel(routes, e);
    await join(routes, e);
    expect(BigInt((await entry(e))!.fairnessOrdinal)).toBeGreaterThan(BigInt(before));
  });

  it("is placed again by the merge gate, which is what reruns after a reopen", async () => {
    const e = env();
    const routes = app();
    await join(routes, e);
    await cancel(routes, e);

    acceptProof(raw, REPO, "a".repeat(40));
    const response = await routes.request(
      `/v1/queue/${REPO}/authorize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pullRequestNumber: 7,
          headSha: "a".repeat(40),
          baseRef: REF,
          authorGithubUserId: "2",
        }),
      },
      e,
    );
    expect(response.status).toBe(200);
    expect((await entry(e))?.state).not.toBe("Cancelled");
  });
});

/**
 * The turn goes to the sponsor, so the machine the queue waits for has to be
 * the sponsor's. `/authorize` read presence for the pull request's author while
 * the offer went to the sponsor, so a queue could wait forever on a laptop
 * belonging to somebody who was never going to run the turn.
 */
describe("whose machine a fresh turn waits for", () => {
  const FRESH = {
    policyDigest: "sha256:policy",
    pipelineDigest: "sha256:pipeline",
    requiredSuites: ["unit"],
    securityProfile: "fresh",
    organizationId: ORG,
    verifier: null,
  };

  /** An entry sponsored by bob, placed the way the webhook places one. */
  async function placedByWebhook(e: QueueRouteEnv): Promise<void> {
    await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) => {
      commandsFor(store).requestQueue({
        idempotencyKey: "webhook:request:entry",
        entryId: `entry_${REPO}_7`,
        pullRequestNumber: 7,
        sponsorPrincipalId: "bob",
        sponsorGithubUserId: "2",
        headSha: "a".repeat(40),
      });
    });
  }

  function connected(principalId: string): void {
    raw
      .prepare(
        `INSERT INTO queue_runners (github_repository_id, principal_id, device_key_id, last_heartbeat_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(REPO, principalId, `SHA256:${"a".repeat(43)}`, new Date().toISOString());
  }

  /**
   * The gate is told the author is alice while the entry it finds is sponsored
   * by bob. Only one of the two can own the turn, and the entry's sponsor is the
   * one the scheduler offers it to.
   */
  async function authorize(routes: ReturnType<typeof app>, e: QueueRouteEnv) {
    acceptProof(raw, REPO, "a".repeat(40));
    const response = await routes.request(
      `/v1/queue/${REPO}/authorize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pullRequestNumber: 7,
          headSha: "a".repeat(40),
          baseRef: REF,
          authorGithubUserId: "1",
        }),
      },
      e,
    );
    return (await response.json()) as { reason: string };
  }

  it("waits for the sponsor's machine", async () => {
    const e = env();
    await placedByWebhook(e);
    connected("bob");
    const verdict = await authorize(app({ activePolicy: async () => FRESH }), e);
    expect(verdict.reason).toBe("HOLDS_TURN");
    expect((await entry(e))?.primaryReason).toBeNull();
  });

  it("withholds the turn while the sponsor's machine is away, whoever else is here", async () => {
    const e = env();
    await placedByWebhook(e);
    connected("alice");
    const verdict = await authorize(app({ activePolicy: async () => FRESH }), e);
    expect(verdict.reason).not.toBe("HOLDS_TURN");
    expect((await entry(e))?.primaryReason).toBe("AGENT_OFFLINE");
  });
});
