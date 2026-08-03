import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import type { PullRequestGates } from "./readiness.js";

/**
 * The four gates GitHub enforces, read before the turn is offered.
 *
 * A repository can require two approving reviews, a code owner, approval after
 * the last push and resolved conversations, and none of it was readable to this
 * queue. `reviewsSatisfied`, `codeOwnerReviewSatisfied`,
 * `approvalAfterPushSatisfied` and `conversationsResolved` had no writer, so
 * every caller of `deriveReadiness` got the permissive default and the four
 * reason codes could not be produced at all.
 *
 * What that cost: the pull request was called ready, given the lane ahead of
 * everyone waiting, run through the full pipeline on a developer's machine, and
 * handed a signed merge-intent attestation. Then the merge workflow's ref update
 * came back 422, the entry was blocked with "GitHub refused the merge. Read the
 * branch protection rules on the base branch.", and the sentence that actually
 * explained it — "at least 1 approving review is required" — sat in one line of
 * an Actions log. Everyone behind that pull request waited for the turn it spent.
 *
 * Every fact needed to refuse before the offer was readable at the moment the
 * offer went out. One read of the branch rules and the pull request answers all
 * four, at the same place the required checks are already read.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "7".repeat(40);
const HEAD = "5".repeat(40);
/**
 * A head as `thwip ship` leaves it: a proof bound to the policy the stub below
 * activates, the pipeline it names, and the one suite it requires.
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

/** A branch with every review rule on, and a pull request that satisfies them. */
function gates(over: Partial<PullRequestGates["review"]> = {}, mergeable: boolean | null = true): PullRequestGates {
  return {
    mergeable,
    review: {
      requiredApprovingReviewCount: 1,
      requireCodeOwnerReview: true,
      requireLastPushApproval: true,
      requireThreadResolution: true,
      reviewDecision: "APPROVED",
      pendingCodeOwnerReview: false,
      approvals: 1,
      approvalsOnHead: 1,
      unresolvedThreads: 0,
      ...over,
    },
  };
}

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

async function askForTurn(app: ReturnType<typeof routes>, e: QueueRouteEnv): Promise<Verdict> {
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

describe("what GitHub requires of a pull request, read before the offer", () => {
  it("refuses a pull request nobody has approved, before it takes the lane", async () => {
    const e = env();
    const app = routes({
      pullRequestGates: async () =>
        gates({ reviewDecision: "REVIEW_REQUIRED", approvals: 0, approvalsOnHead: 0 }),
    });

    const verdict = await askForTurn(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toBe("REVIEW_REQUIRED");
    // Nothing was signed and nothing holds the lane. The 422 this replaces
    // arrived after both.
    expect(verdict.operationId).toBeNull();
    const attestations = raw.prepare("SELECT COUNT(*) AS n FROM queue_attestations").get() as { n: number };
    expect(attestations.n).toBe(0);
  });

  it("names the code owner when that is the rule going unmet", async () => {
    const e = env();
    const app = routes({
      pullRequestGates: async () =>
        gates({
          reviewDecision: "REVIEW_REQUIRED",
          pendingCodeOwnerReview: true,
          approvals: 0,
          approvalsOnHead: 0,
        }),
    });

    expect((await askForTurn(app, e)).reason).toBe("CODEOWNER_REVIEW_REQUIRED");
  });

  it("names the push when the approval predates it", async () => {
    const e = env();
    const app = routes({
      pullRequestGates: async () =>
        gates({ reviewDecision: "REVIEW_REQUIRED", approvals: 2, approvalsOnHead: 0 }),
    });

    expect((await askForTurn(app, e)).reason).toBe("APPROVAL_AFTER_PUSH_REQUIRED");
  });

  it("reports a review thread the branch requires resolved", async () => {
    const e = env();
    const app = routes({ pullRequestGates: async () => gates({ unresolvedThreads: 1 }) });

    expect((await askForTurn(app, e)).reason).toBe("CONVERSATION_UNRESOLVED");
  });

  it("reports a conflict with the base branch rather than running the turn", async () => {
    const e = env();
    const app = routes({ pullRequestGates: async () => gates({}, false) });

    expect((await askForTurn(app, e)).reason).toBe("MERGE_CONFLICT");
  });

  it("does not call a mergeability GitHub has not computed a conflict", async () => {
    const e = env();
    const app = routes({ pullRequestGates: async () => gates({}, null) });

    expect((await askForTurn(app, e)).reason).toBe("HOLDS_TURN");
  });

  it("offers the turn when every rule is satisfied", async () => {
    const e = env();
    const app = routes({ pullRequestGates: async () => gates() });

    const verdict = await askForTurn(app, e);
    expect(verdict.reason).toBe("HOLDS_TURN");
    expect(verdict.operationId).not.toBeNull();
  });

  it("goes ahead when GitHub could not be read, because unknown is not a refusal", async () => {
    // A bad minute at GitHub must not stop the queue for everyone. This is the
    // same treatment the required-check read gets, one line above it.
    const e = env();
    const app = routes({ pullRequestGates: async () => null });

    expect((await askForTurn(app, e)).operationId).not.toBeNull();
  });

  it("goes ahead when nothing supplies the read at all", async () => {
    const e = env();
    const app = routes({});

    expect((await askForTurn(app, e)).operationId).not.toBeNull();
  });
});

/**
 * What the policy requires of the head's proof, read before the offer.
 *
 * The merge gate makes these two comparisons when it assembles the evidence, by
 * which point the pull request has already spent its turn. Readiness makes the
 * same two, from the same function, so the two gates cannot reach different
 * verdicts about one head.
 */
describe("what the policy requires of the head's proof", () => {
  const POLICY = {
    policyDigest: `sha256:${"b".repeat(64)}`,
    pipelineDigest: `sha256:${"c".repeat(64)}`,
    requiredSuites: ["unit"],
    securityProfile: "fast",
    organizationId: "org_1",
    verifier: null,
  };

  it("refuses a proof that never ran a suite the policy now requires", async () => {
    const e = env();
    const app = routes({
      activePolicy: async () => ({ ...POLICY, requiredSuites: ["unit", "integration"] }),
      pullRequestGates: async () => gates(),
    });

    const verdict = await askForTurn(app, e);

    expect(verdict.reason).toBe("POLICY_CHANGED");
    expect(verdict.operationId).toBeNull();
    const attestations = raw.prepare("SELECT COUNT(*) AS n FROM queue_attestations").get() as { n: number };
    expect(attestations.n).toBe(0);
  });

  it("refuses a proof that ran a pipeline the policy no longer names", async () => {
    const e = env();
    const app = routes({
      activePolicy: async () => ({ ...POLICY, pipelineDigest: `sha256:${"e".repeat(64)}` }),
      pullRequestGates: async () => gates(),
    });

    expect((await askForTurn(app, e)).reason).toBe("POLICY_CHANGED");
  });

  it("lets a policy edit that changed no requirement through", async () => {
    // A different policy digest, the same pipeline and the same suites. Refusing
    // on identity is what made every proof in flight go stale over a change to
    // the minimum permission or the lease rules.
    const e = env();
    const app = routes({
      activePolicy: async () => ({ ...POLICY, policyDigest: `sha256:${"9".repeat(64)}` }),
      pullRequestGates: async () => gates(),
    });

    expect((await askForTurn(app, e)).reason).toBe("HOLDS_TURN");
  });
});
