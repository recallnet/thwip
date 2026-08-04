import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";

/**
 * The base the queue pins, read at the moment it pins one.
 *
 * On 2 August 2026 four pull requests merged into recallnet/thwip and no chain
 * record could be written for any of them. The queue signed an intent pinning a
 * tree and a pair of parents, the base branch moved while that was happening,
 * and GitHub merged the head onto the tip the branch actually had. Pull request
 * 117's intent was signed sixteen seconds after its base had already been
 * superseded, and none of the seventy stored intents pins any of the four trees
 * that landed. `authorizationFor` compares the exact tree and the exact
 * parents, so every one of those merges could only be filed as an external
 * transition.
 *
 * The base came from the caller. A workflow read the pull request, sent what it
 * saw, and the queue signed against that reading however old it was by the time
 * it arrived. So the queue reads the base for itself now, in the same guard that
 * signs, and a candidate integrated against a base the branch has left gets no
 * intent at all.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "7".repeat(40);
const HEAD = "5".repeat(40);
const BASE = "b".repeat(40);
/** The commit the base branch moved on to while this candidate was being signed. */
const MOVED = "d".repeat(40);
const CANDIDATE = "c".repeat(40);

/** A head carrying a proof bound to the policy the stub below activates. */
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
    commitFacts: async () => ({ treeOid: TREE, parentShas: [BASE, "6".repeat(40)], message: PROVEN }),
    integratedCandidate: async () => ({
      status: "pinned",
      baseSha: BASE,
      headSha: HEAD,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
    }),
    sleep: async () => {},
    ...over,
  });
}

interface Verdict {
  authorized: boolean;
  reason: string;
  detail?: string;
  operationId: string | null;
  merge?: { baseSha: string; treeOid: string; parentShas: string[] } | null;
}

async function prepareMerge(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
  candidate: Record<string, unknown> = {
    baseSha: BASE,
    candidateSha: CANDIDATE,
    candidateTreeOid: TREE,
    parentShas: [BASE, HEAD],
  },
): Promise<Verdict> {
  acceptProof(raw, REPO, HEAD);
  const response = await app.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber: 117,
        headSha: HEAD,
        baseRef: REF,
        authorGithubUserId: "1",
        draft: false,
        prepare: true,
        candidate,
      }),
    },
    e,
  );
  return (await response.json()) as Verdict;
}

/** Every merge intent the queue signed, oldest first. */
function intents(): Array<{ baseSha: string; candidateTreeOid: string; candidateParentOids: string[] }> {
  const rows = raw
    .prepare("SELECT bytes FROM queue_attestations WHERE kind = 'merge-intent' ORDER BY created_at, digest")
    .all() as Array<{ bytes: string }>;
  return rows.map((row) => (JSON.parse(row.bytes) as { git: never }).git);
}

/**
 * A turn whose candidate is already pinned against a base the branch has left.
 *
 * The reducer holds a pinned candidate immutable, so an attempt in this state
 * can only ever produce a merge onto a base that is gone. Pausing is what gets
 * a test there: the walk pins the candidate and the reducer then refuses the
 * merge intent, which leaves the attempt holding the lane with its base pinned.
 */
async function pinCandidateWhilePaused(app: ReturnType<typeof routes>, e: QueueRouteEnv): Promise<void> {
  // The turn first, so there is an attempt for the walk below to pin against.
  acceptProof(raw, REPO, HEAD);
  await app.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber: 117,
        headSha: HEAD,
        baseRef: REF,
        authorGithubUserId: "1",
        draft: false,
      }),
    },
    e,
  );
  await app.request(
    `/v1/queue/${REPO}/pause?ref=${encodeURIComponent(REF)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "holding the lane still" }),
    },
    e,
  );
  expect((await prepareMerge(app, e)).reason).toBe("QUEUE_PAUSED");
  const resumed = await app.request(`/v1/queue/${REPO}/resume?ref=${encodeURIComponent(REF)}`, { method: "POST" }, e);
  expect(resumed.status).toBe(200);
}

async function lane(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
): Promise<{ state: string | undefined; activeAttemptId: string | null }> {
  const response = await app.request(`/v1/queue/${REPO}?ref=${encodeURIComponent(REF)}&live=1`, {}, e);
  const state = (await response.json()) as {
    activeAttemptId: string | null;
    entries: Array<{ pullRequestNumber: number; state: string }>;
  };
  return {
    state: state.entries.find((entry) => entry.pullRequestNumber === 117)?.state,
    activeAttemptId: state.activeAttemptId,
  };
}

async function entryState(app: ReturnType<typeof routes>, e: QueueRouteEnv): Promise<string | undefined> {
  return (await lane(app, e)).state;
}

describe("the base a merge intent pins", () => {
  it("signs nothing once the branch has left the base this attempt was integrated against", async () => {
    const e = env();
    let base = BASE;
    const app = routes({
      integratedCandidate: async () => ({
        status: "pinned",
        baseSha: base,
        headSha: HEAD,
        candidateSha: CANDIDATE,
        candidateTreeOid: TREE,
      }),
    });
    await pinCandidateWhilePaused(app, e);
    const signedSoFar = intents();
    // The two assertions below both hold over an empty list, so this pins that
    // there is something for them to be about. A test that cannot fail was
    // shipped here before.
    expect(signedSoFar.length).toBeGreaterThan(0);

    base = MOVED;
    const verdict = await prepareMerge(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toBe("CANDIDATE_BASE_MOVED");
    expect(verdict.operationId).toBeNull();
    // A refusal names nothing to merge.
    expect(verdict.merge ?? null).toBeNull();
    // Nothing new was signed, and nothing signed names the base the branch moved to.
    expect(intents()).toEqual(signedSoFar);
    expect(intents().every((git) => git.baseSha === BASE)).toBe(true);
  });

  it("hands the turn back, so the pull request takes another one", async () => {
    const e = env();
    let base = BASE;
    const app = routes({
      integratedCandidate: async () => ({
        status: "pinned",
        baseSha: base,
        headSha: HEAD,
        candidateSha: CANDIDATE,
        candidateTreeOid: TREE,
      }),
    });
    await pinCandidateWhilePaused(app, e);

    base = MOVED;
    await prepareMerge(app, e);

    // Deferred keeps the place in line. The turn is spent, and the candidate
    // for the base that is there now is built on the next one.
    expect(await entryState(app, e)).toBe("Deferred");
  });

  it("will not pin a base it could not read", async () => {
    const e = env();
    const app = routes({ integratedCandidate: async () => null });

    const verdict = await prepareMerge(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toBe("BASE_UNREADABLE");
    expect(verdict.operationId).toBeNull();
    expect(intents()).toEqual([]);
  });

  /**
   * Eight states reached the operator as one sentence about GitHub being
   * unreadable. A pull request that developed a conflict after it was offered
   * the turn was told the base could not be read, the workflow printed that and
   * exited 0, and the attempt held the lane until the execution deadline reaped
   * it. A conflict is a blocked ending, and the queue knows it the moment it
   * reads the pull request.
   */
  it("ends the turn on a conflict instead of holding the lane", async () => {
    const e = env();
    const app = routes({
      integratedCandidate: async () => ({ status: "blocked", reason: "MERGE_CONFLICT" }),
    });

    const verdict = await prepareMerge(app, e);

    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toBe("MERGE_CONFLICT");
    expect(verdict.operationId).toBeNull();
    expect(intents()).toEqual([]);
    // The lane is free and the entry says what the developer has to fix.
    const after = await lane(app, e);
    expect(after.state).toBe("Blocked");
    expect(after.activeAttemptId).toBeNull();
  });

  it("ends the turn on a closed pull request instead of holding the lane", async () => {
    const e = env();
    const app = routes({
      integratedCandidate: async () => ({ status: "blocked", reason: "PR_CLOSED" }),
    });

    const verdict = await prepareMerge(app, e);

    expect(verdict.reason).toBe("PR_CLOSED");
    const after = await lane(app, e);
    expect(after.state).toBe("Cancelled");
    expect(after.activeAttemptId).toBeNull();
  });

  it("names the state GitHub is still computing rather than calling the base unreadable", async () => {
    const e = env();
    const app = routes({
      integratedCandidate: async () => ({ status: "pending", reason: "MERGEABILITY_UNKNOWN" }),
    });

    const verdict = await prepareMerge(app, e);

    expect(verdict.reason).toBe("MERGEABILITY_UNKNOWN");
    // Transient, so the place in line and the turn are both kept.
    expect(await entryState(app, e)).toBe("Active");
  });

  /**
   * A merge run is dispatched about a second after the one ahead of it lands,
   * and GitHub has invalidated mergeability for every open pull request without
   * having recomputed it. The refusal spends the run. Nothing re-drove the lane,
   * so the next attempt waited for the five-minute cron, and merges dropped to
   * one per five minutes whenever the recompute outran the backoff.
   */
  it("re-drives the lane when it cannot read a base", async () => {
    const e = env();
    const driven: number[] = [];
    const app = routes({
      integratedCandidate: async () => null,
      driveTurn: async (_env, _repositoryId, pullRequestNumber) => {
        driven.push(pullRequestNumber);
      },
    });

    expect((await prepareMerge(app, e)).reason).toBe("BASE_UNREADABLE");
    expect(driven).toEqual([117]);
  });

  it("re-drives the lane when the head moved under it", async () => {
    const e = env();
    const driven: number[] = [];
    const app = routes({
      integratedCandidate: async () => ({
        status: "pinned",
        baseSha: BASE,
        headSha: "a".repeat(40),
        candidateSha: CANDIDATE,
        candidateTreeOid: TREE,
      }),
      driveTurn: async (_env, _repositoryId, pullRequestNumber) => {
        driven.push(pullRequestNumber);
      },
    });

    expect((await prepareMerge(app, e)).reason).toBe("HEAD_MOVED");
    expect(driven).toEqual([117]);
  });

  it("pins what GitHub says the candidate is, not what the caller sent", async () => {
    const e = env();
    const app = routes();

    const verdict = await prepareMerge(app, e, {
      // A caller naming its own tree and its own parents. Both are read from
      // GitHub, so neither of these reaches a signed record.
      baseSha: BASE,
      candidateSha: "e".repeat(40),
      candidateTreeOid: "9".repeat(40),
      parentShas: ["9".repeat(40)],
    });

    expect(verdict.reason).toBe("HOLDS_TURN");
    expect(verdict.merge?.treeOid).toBe(TREE);
    expect(intents()).toEqual([
      expect.objectContaining({ baseSha: BASE, candidateTreeOid: TREE, candidateParentOids: [BASE, HEAD] }),
    ]);
  });
});
