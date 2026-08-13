import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import { fixturePolicy, queueRouteDeps } from "../../test/queue-deps.js";
import { acceptProof } from "../../test/proof.js";
import type { MergeIntent } from "./merge-write.js";
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
  vi.useRealTimers();
  while (open.length > 0) open.pop()!.close();
});

function routes(over: Partial<Parameters<typeof queueRoutes>[0]> = {}) {
  return queueRoutes(
    queueRouteDeps({ repositoryId: REPO, baseRef: REF, baseSha: BASE, treeOid: TREE, candidateSha: CANDIDATE, headShaFor: () => HEAD }, {
      commitFacts: async () => ({ treeOid: TREE, parentShas: [BASE, "6".repeat(40)], message: PROVEN }),
      ...over,
    }) as Parameters<typeof queueRoutes>[0],
  );
}

async function enrol(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
  extra: Record<string, unknown> = {},
): Promise<void> {
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
        ...extra,
      }),
    },
    e,
  );
}

async function drive(app: ReturnType<typeof routes>, e: QueueRouteEnv): Promise<void> {
  await enrol(app, e);
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
async function pinCandidateWhilePaused(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
  makeCandidateReadable: () => void,
): Promise<void> {
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
  makeCandidateReadable();
  await app.request(`/v1/queue/${REPO}/nudge?ref=${encodeURIComponent(REF)}`, { method: "POST" }, e);
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
    let readable = false;
    const app = routes({
      integratedCandidate: async () =>
        readable
          ? { status: "pinned", baseSha: base, headSha: HEAD, candidateSha: CANDIDATE, candidateTreeOid: TREE }
          : { status: "pending", reason: "MERGEABILITY_UNKNOWN" },
    });
    await pinCandidateWhilePaused(app, e, () => {
      readable = true;
    });
    const signedSoFar = intents();
    // The two assertions below both hold over an empty list, so this pins that
    // there is something for them to be about. A test that cannot fail was
    // shipped here before.
    expect(signedSoFar.length).toBeGreaterThan(0);

    base = MOVED;
    await drive(app, e);

    // Nothing new was signed, and nothing signed names the base the branch moved to.
    expect(intents()).toEqual(signedSoFar);
    expect(intents().every((git) => git.baseSha === BASE)).toBe(true);
  });

  it("hands the turn back, so the pull request takes another one", async () => {
    const e = env();
    let base = BASE;
    let readable = false;
    const app = routes({
      integratedCandidate: async () =>
        readable
          ? { status: "pinned", baseSha: base, headSha: HEAD, candidateSha: CANDIDATE, candidateTreeOid: TREE }
          : { status: "pending", reason: "MERGEABILITY_UNKNOWN" },
    });
    await pinCandidateWhilePaused(app, e, () => {
      readable = true;
    });

    base = MOVED;
    await drive(app, e);

    // Deferred keeps the place in line. The turn is spent, and the candidate
    // for the base that is there now is built on the next one.
    expect(await entryState(app, e)).toBe("Deferred");
  });

  it("will not pin a base it could not read", async () => {
    const e = env();
    const app = routes({ integratedCandidate: async () => null });

    await drive(app, e);

    expect(intents()).toEqual([]);
    expect(await entryState(app, e)).toBe("Active");
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

    await drive(app, e);

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

    await drive(app, e);

    const after = await lane(app, e);
    expect(after.state).toBe("Cancelled");
    expect(after.activeAttemptId).toBeNull();
  });

  it("names the state GitHub is still computing rather than calling the base unreadable", async () => {
    const e = env();
    const app = routes({
      integratedCandidate: async () => ({ status: "pending", reason: "MERGEABILITY_UNKNOWN" }),
    });

    await drive(app, e);

    // Transient, so the place in line and the turn are both kept.
    expect(await entryState(app, e)).toBe("Active");
  });

  it("frees the lane for a stale merge ref, then retries the same head once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-05T20:55:44.000Z");
    const e = env();
    let candidateReads = 0;
    let mergeWrites = 0;
    let writtenIntent: MergeIntent | null = null;
    const app = routes({
      integratedCandidate: async () => {
        candidateReads += 1;
        return candidateReads === 1
          ? { status: "blocked" as const, reason: "CANDIDATE_STALE" as const }
          : {
              status: "pinned" as const,
              baseSha: MOVED,
              headSha: HEAD,
              candidateSha: CANDIDATE,
              candidateTreeOid: TREE,
            };
      },
      mergeWrite: async (_env, _repositoryId, intent) => {
        mergeWrites += 1;
        writtenIntent = intent;
        return { kind: "unknown" as const, detail: "the test keeps GitHub unchanged" };
      },
    });

    await drive(app, e);

    const deferred = await lane(app, e);
    expect(deferred).toEqual({ state: "Deferred", activeAttemptId: null });
    expect(mergeWrites).toBe(0);

    const explanation = await app.request(
      `/v1/queue/${REPO}/explain?ref=${encodeURIComponent(REF)}&events=5`,
      {},
      e,
    );
    const first = (await explanation.json()) as {
      snapshot: { entries: Array<{ pullRequestNumber: number; headSha: string; primaryReason: string | null }> };
      why: Array<{ pullRequestNumber: number; blockedBy: string | null }>;
    };
    expect(first.snapshot.entries.find((entry) => entry.pullRequestNumber === 117)).toMatchObject({
      headSha: HEAD,
      primaryReason: "CANDIDATE_STALE",
    });
    expect(first.why.find((entry) => entry.pullRequestNumber === 117)?.blockedBy).toMatch(
      /^CANDIDATE_STALE; cooling down until /,
    );

    vi.advanceTimersByTime(5 * 60_000 + 1);
    const tick = await app.request(
      `/v1/queue/${REPO}/tick?ref=${encodeURIComponent(REF)}`,
      { method: "POST" },
      e,
    );
    expect(tick.status).toBe(200);

    expect(candidateReads).toBe(2);
    expect(mergeWrites).toBe(1);
    expect(writtenIntent).toMatchObject({ baseSha: MOVED, headSha: HEAD });
    const retrying = await lane(app, e);
    expect(retrying.activeAttemptId).not.toBeNull();

    // A repeated wake observes the unknown write; it cannot send another one.
    await app.request(`/v1/queue/${REPO}/nudge?ref=${encodeURIComponent(REF)}`, { method: "POST" }, e);
    expect(mergeWrites).toBe(1);
  });

  it("runs a rebuilt fast candidate after the base moves through an exclusive path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-05T20:55:44.000Z");
    const e = env();
    let candidateReads = 0;
    let pathReads = 0;
    let dispatches = 0;
    let mergeWrites = 0;
    const rebuiltTree = "8".repeat(40);
    const app = routes({
      activePolicy: async () =>
        fixturePolicy({
          exclusivePaths: ["migrations/**"],
          verifier: { workflowRef: "acme/repo/.github/workflows/thwip-candidate.yml@refs/heads/main", workflowSha: null },
        }),
      integratedCandidate: async () => {
        candidateReads += 1;
        return candidateReads === 1
          ? { status: "blocked" as const, reason: "CANDIDATE_STALE" as const }
          : {
              status: "pinned" as const,
              baseSha: MOVED,
              headSha: HEAD,
              candidateSha: CANDIDATE,
              candidateTreeOid: rebuiltTree,
            };
      },
      candidateChangedPaths: async (_env, _repositoryId, input) => {
        pathReads += 1;
        expect(input.candidateTreeOid).toBe(rebuiltTree);
        return { status: "exact" as const, paths: ["migrations/0033_second.sql"] };
      },
      dispatchCandidateVerification: async (_env, _repositoryId, payload) => {
        dispatches += 1;
        expect(payload).toMatchObject({ baseSha: MOVED, candidateTreeOid: rebuiltTree });
        return { ok: true as const };
      },
      mergeWrite: async () => {
        mergeWrites += 1;
        return { kind: "unknown" as const, detail: "must wait for the rebuilt candidate run" };
      },
    });

    await drive(app, e);
    expect(candidateReads).toBe(1);
    expect(pathReads).toBe(0);
    expect(dispatches).toBe(0);

    // Remote verification is available only after the repository has merged
    // and activated the reviewed protocol-v3 workflow.
    raw.prepare("UPDATE queue_projects SET verifier_protocol = 3 WHERE github_repository_id = ?").run(REPO);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    await app.request(`/v1/queue/${REPO}/tick?ref=${encodeURIComponent(REF)}`, { method: "POST" }, e);

    expect(candidateReads).toBe(2);
    expect(pathReads).toBe(1);
    expect(dispatches).toBe(1);
    expect(mergeWrites).toBe(0);
  });

  it("pins what GitHub says the candidate is, not fields sent to the check API", async () => {
    const e = env();
    const app = routes();

    await enrol(app, e, {
      candidate: {
        baseSha: BASE,
        candidateSha: "e".repeat(40),
        candidateTreeOid: "9".repeat(40),
        parentShas: ["9".repeat(40)],
      },
    });
    await app.request(`/v1/queue/${REPO}/nudge?ref=${encodeURIComponent(REF)}`, { method: "POST" }, e);

    expect(intents()).toEqual([
      expect.objectContaining({ baseSha: BASE, candidateTreeOid: TREE, candidateParentOids: [BASE, HEAD] }),
    ]);
  });
});
