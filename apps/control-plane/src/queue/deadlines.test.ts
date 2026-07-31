import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";

/**
 * A Durable Object has an alarm. D1 does not, so nothing wakes up to expire a
 * turn nobody finished, and a turn that never expires holds the lane forever.
 * That is the failure this queue spent a week in, from the other direction.
 *
 * The replacement is that every command run against the queue handles whatever
 * is already due before doing its own work. These tests age the stored document
 * rather than waiting out a real deadline, then ask whether the queue recovers on
 * the next thing that touches it.
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

function routes() {
  return queueRoutes({
    authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: true }),
    verifyOidc: async () => ({ repository_id: REPO }),
    pinnedVerifier: async () => null,
    activePolicy: async () => null,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced" }),
    principalFor: async (_e, githubUserId) => `principal_${githubUserId}`,
    driveTurn: async () => {},
    commitFacts: async () => ({ treeOid: "t".repeat(40), parentShas: ["p".repeat(40)] }),
  });
}

async function authorize(app: ReturnType<typeof routes>, e: QueueRouteEnv, pullRequestNumber: number) {
  const response = await app.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber,
        headSha: String(pullRequestNumber).padStart(40, "a"),
        baseRef: REF,
        authorGithubUserId: String(pullRequestNumber),
        proofAccepted: true,
        draft: false,
      }),
    },
    e,
  );
  return (await response.json()) as { authorized: boolean; reason: string };
}

/** Age every deadline in the stored document, as waiting would. */
function ageDeadlines(): number {
  const row = raw
    .prepare("SELECT document FROM queue_state WHERE github_repository_id = ? AND base_ref = ?")
    .get(REPO, REF) as { document: string } | undefined;
  if (row === undefined) return 0;
  const doc = JSON.parse(row.document) as { deadlines: Array<{ dueAt: string }> };
  for (const deadline of doc.deadlines) deadline.dueAt = "2000-01-01T00:00:00.000Z";
  raw
    .prepare("UPDATE queue_state SET document = ? WHERE github_repository_id = ? AND base_ref = ?")
    .run(JSON.stringify(doc), REPO, REF);
  // The projection last moved when the lane was last swept, so aging the
  // deadlines without aging that would leave the fast path still answering.
  raw
    .prepare("UPDATE queue_projection_marks SET projected_at = ? WHERE github_repository_id = ? AND base_ref = ?")
    .run("2000-01-01T00:00:00.000Z", REPO, REF);
  return doc.deadlines.length;
}

describe("a turn that ran out, with nothing to wake the queue up", () => {
  it("does not hold the lane forever", async () => {
    const e = env();
    const app = routes();

    expect((await authorize(app, e, 59)).reason).toBe("HOLDS_TURN");
    expect((await authorize(app, e, 61)).reason).toBe("WAITING_FOR_TURN");

    // The holder goes away and never comes back.
    expect(ageDeadlines()).toBeGreaterThan(0);

    // The next thing to touch the queue is the pull request that was waiting.
    expect((await authorize(app, e, 61)).reason).toBe("HOLDS_TURN");
  });

  it("leaves a turn that has not run out alone", async () => {
    const e = env();
    const app = routes();
    expect((await authorize(app, e, 59)).reason).toBe("HOLDS_TURN");
    for (let i = 0; i < 3; i += 1) {
      expect((await authorize(app, e, 61)).reason).toBe("WAITING_FOR_TURN");
    }
    expect((await authorize(app, e, 59)).reason).toBe("HOLDS_TURN");
  });

  it("recovers even when nobody is waiting to ask", async () => {
    const e = env();
    const app = routes();
    await authorize(app, e, 59);
    ageDeadlines();

    // A webhook, rather than a pull request asking about itself.
    const ticked = await app.request(
      `/v1/queue/${REPO}/tick?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    expect(ticked.status).toBe(200);

    const response = await app.request(`/v1/queue/${REPO}?ref=${encodeURIComponent(REF)}&live=1`, {}, e);
    const state = (await response.json()) as { activeAttemptId: string | null };
    // The lapsed turn released the lane rather than keeping it after the holder
    // stopped answering.
    expect(state.activeAttemptId).toBeNull();
  });
});
