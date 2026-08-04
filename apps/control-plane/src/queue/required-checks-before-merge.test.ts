import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import { unsatisfiedRequiredChecks } from "./github-port.js";
import { nonThwipCheckState } from "./readiness.js";
import { PROOF_CHECK, TURN_CHECK } from "./turn-check.js";

/**
 * The merge the queue can tell will be refused, before it asks for it.
 *
 * A branch ruleset requires two checks. When one of them is not on the head,
 * GitHub answers the merge PUT with 405 and the queue found that out from the
 * rejection: it had already given the entry a turn, signed a merge intent and
 * minted an operation, and the attempt sat holding the lane while everything
 * behind it stopped. That happened repeatedly on recallnet/thwip in one day, and
 * clearing it took a person each time.
 *
 * Both facts are readable first. The branch rules name the contexts and the head
 * carries the runs, so a merge that cannot succeed is refused with a sentence
 * naming the missing check rather than discovered from GitHub's answer.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "7".repeat(40);
const HEAD = "5".repeat(40);
/**
 * A head as `thwip ship` leaves it: a proof bound to the policy the stub below
 * activates, the pipeline it names, and the one suite it requires. The merge
 * gate reads all three off the proof, so a placeholder payload here would be
 * refused the way a stale proof is.
 */
const PROVEN = `feat: something\n\nthwip-proof: v1.eyJwYXlsb2FkVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24iLCJwYXlsb2FkIjoiZXlKZmRIbHdaU0k2SW1oMGRIQnpPaTh2YVc0dGRHOTBieTVwYnk5VGRHRjBaVzFsYm5RdmRqRWlMQ0p6ZFdKcVpXTjBJanBiZXlKdVlXMWxJam9pWjJsMExYUnlaV1VpTENKa2FXZGxjM1FpT25zaWMyaGhNU0k2SWpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056Y2lmWDFkTENKd2NtVmthV05oZEdWVWVYQmxJam9pZFhKdU9uUm9kMmx3T21GMGRHVnpkR0YwYVc5dU9tTnBMWEoxYmpwMk1TSXNJbkJ5WldScFkyRjBaU0k2ZXlKelkyaGxiV0ZXWlhKemFXOXVJam9pTVNJc0luSmxjRzl6YVhSdmNua2lPbnNpY0hKdmRtbGtaWElpT2lKbmFYUm9kV0lpTENKdmQyNWxja2xrSWpvaU1TSXNJbkpsY0c5emFYUnZjbmxKWkNJNklqRXpNVFUwTVRreE5qVWlmU3dpWjJsMElqcDdJbTlpYW1WamRFWnZjbTFoZENJNkluTm9ZVEVpTENKMGNtVmxUMmxrSWpvaU56YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOeUlzSW5CaGNtVnVkRTlwWkhNaU9sc2lZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWWlKZExDSmlZWE5sVW1WbUlqb2ljbVZtY3k5b1pXRmtjeTl0WVdsdUlpd2lZbUZ6WlZOb1lTSTZJbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1JaUxDSmxkbUZzZFdGMGFXOXVUVzlrWlNJNkltaGxZV1F0ZEhKbFpTSjlMQ0p3YjJ4cFkza2lPbnNpWkdsblpYTjBJam9pYzJoaE1qVTJPbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUlpTENKMlpYSnphVzl1SWpveGZTd2ljR2x3Wld4cGJtVWlPbnNpWkdsblpYTjBJam9pYzJoaE1qVTJPbU5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk1pTENKeWRXNXVaWElpT2lKamIyMXRZVzVrSW4wc0luSjFiaUk2ZXlKemRHRnlkR1ZrUVhRaU9pSXlNREkyTFRBeExUQXhWREF3T2pBd09qQXdMakF3TUZvaUxDSm1hVzVwYzJobFpFRjBJam9pTWpBeU5pMHdNUzB3TVZRd01Eb3dNVG93TUM0d01EQmFJaXdpYm1WMGQyOXlhMDF2WkdVaU9pSmthWE5oWW14bFpDSXNJbU5oWTJobFRXOWtaU0k2SW1ScGMyRmliR1ZrSWl3aWMzVnBkR1Z6SWpwYmV5SnBaQ0k2SW5WdWFYUWlMQ0p6ZEdGMGRYTWlPaUp3WVhOelpXUWlMQ0prZFhKaGRHbHZiazF6SWpveGZWMTlMQ0p6YVdkdVpYSWlPbnNpYTJWNVNXUWlPaUpUU0VFeU5UWTZhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJ0cmF5SXNJbWRwZEdoMVlsVnpaWEpKWkNJNklqRWlmWDE5Iiwic2lnbmF0dXJlcyI6W3sia2V5aWQiOiJTSEEyNTY6a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2trayIsInNpZyI6IkFBQUEifV19\n`;

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
    .run("alice", "org_1", "1", "author1");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function routes(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  return queueRoutes({
    publishTurnCheck: async () => {},
    authenticate: async () => ({ ok: true, principalId: "alice", githubUserId: "1", isAdmin: true }),
    verifyOidc: async () => ({ repository_id: REPO }),
    pinnedVerifier: async () => null,
    activePolicy: async () => ({
      policyDigest: `sha256:${"b".repeat(64)}`,
      pipelineDigest: `sha256:${"c".repeat(64)}`,
      requiredSuites: ["unit"],
      securityProfile: "fast",
      organizationId: "org_1",
      verifier: null,
    }),
    proofCheckRunId: async () => "778899",
    signRecordBytes: async (_e, bytes) => `jws.${bytes.byteLength}`,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
    principalFor: async (_e, githubUserId) => `principal_${githubUserId}`,
    pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF, authorIsBot: false }),
    driveTurn: async () => {},
    integratedCandidate: async () => ({
      status: "pinned",
      baseSha: "b".repeat(40),
      headSha: HEAD,
      candidateSha: "c".repeat(40),
      candidateTreeOid: TREE,
    }),
    commitFacts: async () => ({ treeOid: TREE, parentShas: ["b".repeat(40), "6".repeat(40)], message: PROVEN }),
    sleep: async () => {},
    ...over,
  });
}

interface Verdict {
  authorized: boolean;
  reason: string;
  detail?: string;
  operationId: string | null;
}

async function prepareMerge(app: ReturnType<typeof routes>, e: QueueRouteEnv): Promise<Verdict> {
  const response = await app.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber: 120,
        headSha: HEAD,
        baseRef: REF,
        authorGithubUserId: "1",
        proofAccepted: true,
        draft: false,
        prepare: true,
        candidate: {
          baseSha: "b".repeat(40),
          candidateSha: "c".repeat(40),
          candidateTreeOid: TREE,
          parentShas: ["b".repeat(40), "6".repeat(40)],
        },
      }),
    },
    e,
  );
  return (await response.json()) as Verdict;
}

describe("what the branch requires, read before the merge is asked for", () => {
  it("refuses the merge and names the check nothing has published", async () => {
    const e = env();
    const app = routes({
      requiredCheckState: async () => ({
        required: [PROOF_CHECK, TURN_CHECK],
        // The shape observed on pull requests 114 and 120: the workflow's proof
        // check landed and the App's turn check never did.
        runs: [{ name: PROOF_CHECK, status: "completed", conclusion: "success" }],
      }),
    });

    const verdict = await prepareMerge(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.operationId).toBeNull();
    expect(verdict.reason).toBe("REQUIRED_CHECK_MISSING");
    expect(verdict.detail).toContain(TURN_CHECK);
  });

  it("prepares the merge when every required check is on the head", async () => {
    const e = env();
    const app = routes({
      requiredCheckState: async () => ({
        required: [PROOF_CHECK, TURN_CHECK],
        runs: [
          { name: PROOF_CHECK, status: "completed", conclusion: "success" },
          { name: TURN_CHECK, status: "completed", conclusion: "success" },
        ],
      }),
    });

    const verdict = await prepareMerge(app, e);

    expect(verdict.reason).toBe("HOLDS_TURN");
    expect(verdict.operationId).not.toBeNull();
  });

  it("prepares the merge when the branch rules cannot be read, because unknown is not a refusal", async () => {
    const e = env();
    const app = routes({ requiredCheckState: async () => null });

    const verdict = await prepareMerge(app, e);

    expect(verdict.operationId).not.toBeNull();
  });
});

/**
 * The same GitHub answer, read one step earlier.
 *
 * `ReadinessFacts.nonThwipChecks` had no writer at all: both callers of
 * `deriveReadiness` spread `NO_OBJECTION`, whose default is "passing", so
 * `REQUIRED_CHECK_FAILED` and `REQUIRED_CHECK_PENDING` were unreachable and a
 * pull request whose CI had gone red was called ready. It was offered a turn,
 * the turn ran on somebody's machine, and only the walk to the merge refused
 * it — on the rules and the runs that were readable before the offer.
 */
describe("a required check the queue does not publish", () => {
  it("does not call an entry ready while its own CI is failing", async () => {
    const e = env();
    const app = routes({
      requiredCheckState: async () => ({
        required: [TURN_CHECK, "lint"],
        runs: [
          { name: TURN_CHECK, status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "failure" },
        ],
      }),
    });

    const verdict = await prepareMerge(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toBe("REQUIRED_CHECK_FAILED");
    expect(verdict.operationId).toBeNull();
  });

  it("waits on a required check that is still running", async () => {
    const e = env();
    const app = routes({
      requiredCheckState: async () => ({
        required: ["lint"],
        runs: [{ name: "lint", status: "in_progress", conclusion: null }],
      }),
    });

    const verdict = await prepareMerge(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toBe("REQUIRED_CHECK_PENDING");
  });

  it("does not hold an entry back on the check the queue publishes for it", async () => {
    // `thwip / turn` is required on the branch and published from this
    // endpoint's own answer. Counting it here would wire the gate to itself.
    const e = env();
    const app = routes({
      requiredCheckState: async () => ({
        required: [PROOF_CHECK, TURN_CHECK],
        runs: [
          { name: PROOF_CHECK, status: "completed", conclusion: "success" },
          { name: TURN_CHECK, status: "completed", conclusion: "success" },
        ],
      }),
    });

    expect((await prepareMerge(app, e)).reason).toBe("HOLDS_TURN");
  });

  it("reads the same GitHub answer the merge gate does", () => {
    // Two readings that disagreed would offer a turn the walk then refuses,
    // which is the round trip this whole file exists to remove.
    for (const conclusion of ["success", "neutral", "skipped", "failure", "timed_out", "cancelled"]) {
      const state = { required: ["lint"], runs: [{ name: "lint", status: "completed", conclusion }] };
      expect(nonThwipCheckState(state) === "failing", conclusion).toBe(
        unsatisfiedRequiredChecks(state).length > 0,
      );
    }
  });
});

describe("which required checks a head certainly fails", () => {
  it("names one nothing published and one that concluded badly", () => {
    expect(
      unsatisfiedRequiredChecks({
        required: ["thwip", TURN_CHECK, "lint"],
        runs: [
          { name: "thwip", status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "failure" },
        ],
      }),
    ).toEqual([
      { context: TURN_CHECK, state: "absent" },
      { context: "lint", state: "failed" },
    ]);
  });

  it("leaves a check that is still running alone, because it may yet pass", () => {
    expect(
      unsatisfiedRequiredChecks({
        required: [TURN_CHECK],
        runs: [{ name: TURN_CHECK, status: "in_progress", conclusion: null }],
      }),
    ).toEqual([]);
  });

  it("counts neutral and skipped as satisfied, the way GitHub does", () => {
    expect(
      unsatisfiedRequiredChecks({
        required: ["neutral-suite", "skipped-suite"],
        runs: [
          { name: "neutral-suite", status: "completed", conclusion: "neutral" },
          { name: "skipped-suite", status: "completed", conclusion: "skipped" },
        ],
      }),
    ).toEqual([]);
  });
});
