import { afterEach, describe, expect, it } from "vitest";
import { queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";

/**
 * The merge gate, end to end, over the storage it actually uses.
 *
 * This could not be written while the queue lived in a Durable Object, because a
 * route needed a namespace no test could provide, so the one property the product
 * exists to guarantee was only ever checked on staging. It needs D1 now, and D1 is
 * SQLite, so the question "can two pull requests be told they hold the lane at
 * once" can finally be asked in a unit test.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  seedSessionMembership("alice", "1");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

/**
 * The organization that owns the repository, its project row, and the session's
 * own membership of it.
 *
 * Every session-authenticated queue route establishes membership before it acts,
 * so a test whose caller belongs to no organization is refused before it reaches
 * the behaviour it is about. Seeded with the environment rather than per test,
 * because the caller belonging somewhere is a precondition of all of them.
 */
function seedSessionMembership(principalId: string, githubUserId: string): void {
  raw
    .prepare("INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_1", "1", "acme");
  raw
    .prepare(
      "INSERT OR IGNORE INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_session", "org_1", REPO, "acme/repo");
  raw
    .prepare(
      "INSERT OR IGNORE INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run(principalId, "org_1", githubUserId, principalId);
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";

/** Every pull request is sponsored by a different principal, so fairness applies. */
const driven: number[] = [];

function app(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  driven.length = 0;
  return queueRoutes(
    queueRouteDeps({ repositoryId: REPO, baseRef: REF }, {
      activePolicy: async () => null,
      driveTurn: async (_e: unknown, _r: string, pullRequestNumber: number) => {
        driven.push(pullRequestNumber);
      },
      commitFacts: async () => ({ treeOid: "t".repeat(40), parentShas: ["p".repeat(40)] }),
      ...over,
    }) as Parameters<typeof queueRoutes>[0],
  );
}

/**
 * Make the projection credit the lane to somebody who does not hold it, and
 * insist it actually changed something so the test cannot pass by describing a
 * projection that was never written.
 */
function lie(): void {
  const marks = raw
    .prepare("UPDATE queue_projection_marks SET active_attempt_id = 'att_somebody_else'")
    .run();
  const entries = raw
    .prepare("UPDATE queue_entries_index SET last_attempt_id = 'att_somebody_else' WHERE pull_request_number = 61")
    .run();
  expect(marks.changes).toBeGreaterThan(0);
  expect(entries.changes).toBeGreaterThan(0);
}

interface Verdict {
  authorized: boolean;
  reason: string;
  entryId: string;
  operationId: string | null;
}

/**
 * Ask the gate about a pull request whose head the App has verified.
 *
 * `proven: false` leaves the verdict absent, which is the only way a caller can
 * now affect it: the request body used to carry `proofAccepted` and the queue
 * believed it.
 */
async function authorize(
  routes: ReturnType<typeof app>,
  e: QueueRouteEnv,
  pullRequestNumber: number,
  over: Record<string, unknown> = {},
  proven = true,
): Promise<Verdict> {
  if (proven) acceptProof(raw, REPO, (over["headSha"] as string | undefined) ?? String(pullRequestNumber).padStart(40, "a"));
  const response = await routes.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber,
        headSha: String(pullRequestNumber).padStart(40, "a"),
        baseRef: REF,
        authorGithubUserId: String(pullRequestNumber),
        draft: false,
        ...over,
      }),
    },
    e,
  );
  return (await response.json()) as Verdict;
}

describe("the merge gate", () => {
  it("gives the lane to exactly one pull request", async () => {
    const e = env();
    const routes = app();

    const first = await authorize(routes, e, 59);
    const second = await authorize(routes, e, 61);
    const third = await authorize(routes, e, 65);

    const holders = [first, second, third].filter((v) => v.reason === "HOLDS_TURN");
    expect(holders).toHaveLength(1);
    expect(holders[0]!.authorized).toBe(true);

    for (const waiting of [first, second, third].filter((v) => v.reason !== "HOLDS_TURN")) {
      expect(waiting.authorized).toBe(false);
      expect(waiting.reason).toBe("WAITING_FOR_TURN");
    }
  });

  it("keeps giving the same answer while nothing changes", async () => {
    const e = env();
    const routes = app();
    const first = await authorize(routes, e, 59);
    await authorize(routes, e, 61);

    for (let i = 0; i < 4; i += 1) {
      expect((await authorize(routes, e, 59)).reason).toBe(first.reason);
      expect((await authorize(routes, e, 61)).reason).toBe("WAITING_FOR_TURN");
    }
  });

  it("asks GitHub to run the merge for whoever holds the lane", async () => {
    const e = env();
    const routes = app();
    const first = await authorize(routes, e, 59);
    expect(first.reason).toBe("HOLDS_TURN");
    expect(driven).toContain(59);
  });

  it("refuses a pull request the App has not verified", async () => {
    const e = env();
    const routes = app();
    const verdict = await authorize(routes, e, 59, {}, false);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toBe("LOCAL_RECEIPT_MISSING");
  });

  it("refuses a draft", async () => {
    const e = env();
    const routes = app();
    const verdict = await authorize(routes, e, 59, { draft: true });
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toBe("PR_DRAFT");
  });

  it("says yes to everyone on a branch with no queue, rather than failing the check", async () => {
    const e = env();
    const routes = app({ queueProject: async () => null });
    const verdict = await authorize(routes, e, 59);
    expect(verdict).toMatchObject({ authorized: true, reason: "QUEUE_NOT_CONFIGURED" });
  });

  it("observes without enforcing", async () => {
    const e = env();
    const routes = app({ queueProject: async () => ({ activationState: "observe", mergeMethod: "merge" }) });
    await authorize(routes, e, 59);
    // The second pull request is told what would have happened and let through
    // anyway, which is what makes adoption reversible.
    const second = await authorize(routes, e, 61);
    expect(second).toMatchObject({ authorized: true, reason: "WAITING_FOR_TURN" });
  });

  it("passes the lane on once the holder has merged", async () => {
    const e = env();
    const routes = app();

    const first = await authorize(routes, e, 59);
    const second = await authorize(routes, e, 61);
    expect(first.reason).toBe("HOLDS_TURN");
    expect(second.reason).toBe("WAITING_FOR_TURN");

    // The holder leaves the queue, as a merge would take it out.
    const held = first.entryId;
    const removed = await routes.request(
      `/v1/queue/${REPO}/entries/${held}?ref=${encodeURIComponent(REF)}&reason=merged`,
      { method: "DELETE" },
      e,
    );
    expect(removed.status).toBe(200);

    expect((await authorize(routes, e, 61)).reason).toBe("HOLDS_TURN");
  });

  /**
   * There used to be a fast path that declined from the projection. A stale
   * decline was reasoned to be safe because it only cost a pull request one more
   * round, but this endpoint is a required check: a declined check goes red and
   * stays red, GitHub then refuses the merge on the red check even once the queue
   * has authorized, and the queue re-offers a turn to a pull request that can
   * never take it. The lane wedged on its own holder.
   */
  it("answers from the queue even when the projection says otherwise", async () => {
    const e = env();
    const routes = app();
    const first = await authorize(routes, e, 59);
    expect(first.reason).toBe("HOLDS_TURN");
    expect((await authorize(routes, e, 61)).reason).toBe("WAITING_FOR_TURN");

    // A projection that has fallen behind and credits the lane to somebody else.
    lie();

    expect((await authorize(routes, e, 59)).reason).toBe("HOLDS_TURN");
    expect((await authorize(routes, e, 61)).reason).toBe("WAITING_FOR_TURN");
  });

  it("reads back what it decided", async () => {
    const e = env();
    const routes = app();
    await authorize(routes, e, 59);

    const response = await routes.request(`/v1/queue/${REPO}?ref=${encodeURIComponent(REF)}&live=1`, {}, e);
    const state = (await response.json()) as {
      activeAttemptId: string | null;
      entries: Array<{ pullRequestNumber: number; state: string }>;
    };
    expect(state.activeAttemptId).not.toBeNull();
    expect(state.entries.find((entry) => entry.pullRequestNumber === 59)?.state).toBe("Active");
  });

  it("pauses the whole queue when an operator says so", async () => {
    const e = env();
    const routes = app();
    await routes.request(
      `/v1/queue/${REPO}/pause?ref=${encodeURIComponent(REF)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "investigating a bad merge" }),
      },
      e,
    );
    const verdict = await authorize(routes, e, 59);
    expect(verdict.authorized).toBe(false);
  });
});
