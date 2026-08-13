import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { fixturePolicy } from "../../test/queue-deps.js";
import { provenCommit } from "../../test/proven-commit.js";
import type { QueueRouteEnv } from "./routes.js";
import { runOnQueue } from "./routes.js";
import { loadQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";
import { driveQueue } from "./drive-queue.js";
import { candidateResultDigest } from "./candidate-verdict.js";

// `../index.js` statically re-exports the Durable Object class, which needs
// `cloudflare:workers` and only resolves under the Workers pool.
vi.mock("./BranchQueue.js", () => ({ BranchQueue: class {} }));
vi.mock("../github-app.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  installationToken: async () => "installation-token",
}));
const { queueFromPullRequest } = await import("../index.js");

/**
 * The Worker taking its own lane to a merge.
 *
 * The queue walks the holder itself. It never dispatches repository automation
 * to perform the write, and the push from its own merge wakes the next entry.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const REF = "refs/heads/main";
const HEAD = "5".repeat(40);
const BASE = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const TREE = "7".repeat(40);

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, ?, ?, ?)")
    .run("org_1", "1", "acme", "9001");
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  raw
    .prepare(
      "INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, project_id, verifier_protocol) VALUES (?, ?, ?, ?, 1, 'enforced', ?, 3)",
    )
    .run("qp_1", "org_1", REPO, REF, "proj_1");
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("alice", "org_1", "1", "alice");
  acceptProof(raw, REPO, HEAD);
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (open.length > 0) open.pop()!.close();
});

const onQueue = ((e, repositoryId, baseRef, decide) =>
  runOnQueue(e, repositoryId, baseRef, decide)) as Parameters<typeof driveQueue>[2];

function opened(pullRequestNumber = 120, headSha = HEAD) {
  return {
    action: "opened",
    pull_request: {
      number: pullRequestNumber,
      draft: false,
      state: "open",
      base: { ref: "main", repo: { id: Number(REPO) } },
      head: { sha: headSha },
      user: { id: 1, login: "alice", type: "User" },
    },
  };
}

async function entry(e: QueueRouteEnv) {
  const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
  return store.state().entries.get(`entry_${REPO}_120`);
}

/**
 * Every call the Worker makes to GitHub, so a dispatch that did or did not
 * happen is observed rather than assumed. `queueFromPullRequest` runs the real
 * deps, and a stub array they never touch would pass whatever the code did.
 */
function watchGithub(): string[] {
  const called: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    called.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  return called;
}

function reads(over: Record<string, unknown> = {}) {
  return {
    queueProject: async () => ({
      activationState: "enforced",
      projectId: "proj_1",
      verifierProtocol: 3,
    }),
    principalFor: async () => "alice",
    pullRequestPlacement: async () => ({
      authorGithubUserId: "1",
      baseRef: REF,
      authorIsBot: false,
      draft: false,
      headSha: HEAD,
    }),
    pullRequestNumbersForCommit: async () => [120],
    activePolicy: async () => fixturePolicy(),
    dispatchCandidateVerification: async () => ({ ok: true }),
    integratedCandidate: async () => ({
      status: "pinned" as const,
      baseSha: BASE,
      headSha: HEAD,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
    }),
    mergeWrite: async () => ({ kind: "unknown", detail: "test does not land the merge" }),
    publishTurnCheck: async () => {},
    commitFacts: async () => ({
      treeOid: TREE,
      parentShas: [BASE],
      message: provenCommit({ repositoryId: REPO, baseRef: REF, treeOid: TREE, baseSha: BASE }),
    }),
    proofCheckRunId: async () => "778899",
    baseContainsSha: async () => true,
    signRecordBytes: async () => "jws",
    ...over,
  };
}

describe("who drives the lane", () => {
  it("does not dispatch repository automation to perform an App write", async () => {
    const e = env();
    const called = watchGithub();

    await queueFromPullRequest(e as never, opened());

    expect((await entry(e))?.state).toBe("Active");
    expect(called.filter((url) => url.endsWith("/dispatches"))).toEqual([]);
  });

  it("walks nobody when the lane is idle", async () => {
    const e = env();

    const walked = await driveQueue(e, reads() as never, onQueue, { repositoryId: REPO, baseRef: REF });

    expect(walked).toBe(0);
  });

  it("publishes the held turn before a heartbeat-offered lane writes", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());

    const order: string[] = [];
    await driveQueue(
      e,
      reads({
        publishTurnCheck: async (_env: QueueRouteEnv, repositoryId: string, update: { state: string; headSha: string }) => {
          expect(repositoryId).toBe(REPO);
          expect(update).toMatchObject({ state: "holds", headSha: HEAD });
          order.push("turn-check");
        },
        mergeWrite: async () => {
          order.push("merge-write");
          return { kind: "unknown" as const, detail: "test does not land the merge" };
        },
      }) as never,
      onQueue,
      { repositoryId: REPO, baseRef: REF },
    );

    expect(order).toEqual(["turn-check", "merge-write"]);
  });

  it("does not write the branch when the held-turn publication fails", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());

    let mergeWrites = 0;
    await expect(
      driveQueue(
        e,
        reads({
          publishTurnCheck: async () => {
            throw new Error("GitHub refused the turn check");
          },
          mergeWrite: async () => {
            mergeWrites += 1;
            return { kind: "unknown" as const, detail: "must not be reached" };
          },
        }) as never,
        onQueue,
        { repositoryId: REPO, baseRef: REF },
      ),
    ).rejects.toThrow("GitHub refused the turn check");
    expect(mergeWrites).toBe(0);
  });

  it("does not write the branch without a held-turn publisher", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());

    let mergeWrites = 0;
    await driveQueue(
      e,
      reads({
        publishTurnCheck: undefined,
        mergeWrite: async () => {
          mergeWrites += 1;
          return { kind: "unknown" as const, detail: "must not be reached" };
        },
      }) as never,
      onQueue,
      { repositoryId: REPO, baseRef: REF },
    );
    expect(mergeWrites).toBe(0);
  });

  it("runs a fast combined candidate again when it changes an exclusive path", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());
    let dispatches = 0;
    let mergeWrites = 0;

    await driveQueue(
      e,
      reads({
        activePolicy: async () =>
          fixturePolicy({
            exclusivePaths: ["migrations/**"],
            verifier: { workflowRef: "acme/repo/.github/workflows/thwip-candidate.yml@refs/heads/main", workflowSha: null },
          }),
        candidateChangedPaths: async (_env: QueueRouteEnv, repositoryId: string, input: Record<string, string>) => {
          expect(repositoryId).toBe(REPO);
          expect(input.candidateTreeOid).toBe(TREE);
          return { status: "exact" as const, paths: ["migrations/0033_new.sql"] };
        },
        dispatchCandidateVerification: async (_env: QueueRouteEnv, repositoryId: string, payload: { baseSha: string; candidateTreeOid: string }) => {
          expect(repositoryId).toBe(REPO);
          expect(payload).toMatchObject({ baseSha: BASE, candidateTreeOid: TREE });
          dispatches += 1;
          return { ok: true as const };
        },
        mergeWrite: async () => {
          mergeWrites += 1;
          return { kind: "unknown" as const, detail: "must wait for the combined run" };
        },
      }) as never,
      onQueue,
      { repositoryId: REPO, baseRef: REF },
    );

    expect(dispatches).toBe(1);
    expect(mergeWrites).toBe(0);
  });

  it("does not inspect a second guarded entry while the first holds the lane", async () => {
    const e = env();
    watchGithub();
    const secondHead = "6".repeat(40);
    acceptProof(raw, REPO, secondHead);
    await queueFromPullRequest(e as never, opened(120, HEAD));
    await queueFromPullRequest(e as never, opened(121, secondHead));
    const candidates: number[] = [];
    let pathReads = 0;

    await driveQueue(
      e,
      reads({
        activePolicy: async () =>
          fixturePolicy({
            exclusivePaths: ["migrations/**"],
            verifier: { workflowRef: "acme/repo/.github/workflows/thwip-candidate.yml@refs/heads/main", workflowSha: null },
          }),
        integratedCandidate: async (_env: QueueRouteEnv, _repositoryId: string, _baseRef: string, pr: number) => {
          candidates.push(pr);
          return {
            status: "pinned" as const,
            baseSha: BASE,
            headSha: pr === 120 ? HEAD : secondHead,
            candidateSha: CANDIDATE,
            candidateTreeOid: TREE,
          };
        },
        candidateChangedPaths: async () => {
          pathReads += 1;
          return { status: "exact" as const, paths: ["migrations/0033.sql"] };
        },
      }) as never,
      onQueue,
      { repositoryId: REPO, baseRef: REF },
    );

    expect(candidates).toEqual([120]);
    expect(pathReads).toBe(1);
  });

  it("merges a guarded fast candidate only after the exact combined run passes", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());
    const policy = fixturePolicy({
      exclusivePaths: ["migrations/**"],
      verifier: { workflowRef: "acme/repo/.github/workflows/thwip-candidate.yml@refs/heads/main", workflowSha: null },
    });
    const queueReads = reads({
      activePolicy: async () => policy,
      candidateChangedPaths: async () => ({ status: "exact" as const, paths: ["migrations/0033_new.sql"] }),
    });
    let mergeWrites = 0;
    queueReads.mergeWrite = async () => {
      mergeWrites += 1;
      return { kind: "unknown" as const, detail: "test keeps GitHub unchanged" };
    };

    await driveQueue(e, queueReads as never, onQueue, { repositoryId: REPO, baseRef: REF });
    expect(mergeWrites).toBe(0);

    const verdict = {
      candidateTreeOid: TREE,
      candidateSha: CANDIDATE,
      baseSha: BASE,
      pullRequestNumber: 120,
      accepted: true,
      policyDigest: policy.policyDigest as string,
      suites: [{ name: "unit", outcome: "passed" as const, durationMs: 17 }],
      reasonCodes: [],
      workflowRef: "acme/repo/.github/workflows/thwip-candidate.yml@refs/heads/main",
      workflowSha: "9".repeat(40),
      runId: "550011",
      observedAt: "2026-08-13T03:00:00.000Z",
    };
    const resultDigest = await candidateResultDigest(verdict);
    raw
      .prepare(
        `INSERT INTO candidate_verdicts
           (github_repository_id, base_ref, project_id, candidate_tree_oid, candidate_sha,
            base_sha, pull_request_number, accepted, result_digest, policy_digest, suites,
            reason_codes, workflow_ref, workflow_sha, run_id, observed_at, verifier_protocol)
         VALUES (?, ?, 'proj_1', ?, ?, ?, ?, 1, ?, ?, ?, '[]', ?, ?, ?, ?, 3)`,
      )
      .run(
        REPO,
        REF,
        verdict.candidateTreeOid,
        verdict.candidateSha,
        verdict.baseSha,
        verdict.pullRequestNumber,
        resultDigest,
        verdict.policyDigest,
        JSON.stringify(verdict.suites),
        verdict.workflowRef,
        verdict.workflowSha,
        verdict.runId,
        verdict.observedAt,
      );

    await driveQueue(e, queueReads as never, onQueue, { repositoryId: REPO, baseRef: REF });
    expect(mergeWrites).toBe(1);
  });

  it("keeps fast proof reuse when the combined change misses every exclusive path", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());
    let dispatches = 0;
    let mergeWrites = 0;

    await driveQueue(
      e,
      reads({
        activePolicy: async () =>
          fixturePolicy({
            exclusivePaths: ["migrations/**"],
            verifier: { workflowRef: "acme/repo/.github/workflows/thwip-candidate.yml@refs/heads/main", workflowSha: null },
          }),
        candidateChangedPaths: async () => ({ status: "exact" as const, paths: ["src/index.ts"] }),
        dispatchCandidateVerification: async () => {
          dispatches += 1;
          return { ok: true as const };
        },
        mergeWrite: async () => {
          mergeWrites += 1;
          return { kind: "unknown" as const, detail: "test keeps GitHub unchanged" };
        },
      }) as never,
      onQueue,
      { repositoryId: REPO, baseRef: REF },
    );

    expect(dispatches).toBe(0);
    expect(mergeWrites).toBe(1);
  });

  it("does not spend a tree read for a repository that did not opt in", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());
    let pathReads = 0;

    await driveQueue(
      e,
      reads({
        candidateChangedPaths: async () => {
          pathReads += 1;
          return { status: "exact" as const, paths: [] };
        },
      }) as never,
      onQueue,
      { repositoryId: REPO, baseRef: REF },
    );

    expect(pathReads).toBe(0);
  });

  it("fails closed when GitHub cannot return a complete combined candidate diff", async () => {
    const e = env();
    watchGithub();
    await queueFromPullRequest(e as never, opened());
    let dispatches = 0;
    let mergeWrites = 0;

    await driveQueue(
      e,
      reads({
        activePolicy: async () =>
          fixturePolicy({
            exclusivePaths: ["migrations/**"],
            verifier: { workflowRef: "acme/repo/.github/workflows/thwip-candidate.yml@refs/heads/main", workflowSha: null },
          }),
        candidateChangedPaths: async () => ({
          status: "unreadable" as const,
          detail: "GitHub truncated a recursive repository tree",
        }),
        dispatchCandidateVerification: async () => {
          dispatches += 1;
          return { ok: true as const };
        },
        mergeWrite: async () => {
          mergeWrites += 1;
          return { kind: "unknown" as const, detail: "must not merge" };
        },
      }) as never,
      onQueue,
      { repositoryId: REPO, baseRef: REF },
    );

    expect(dispatches).toBe(0);
    expect(mergeWrites).toBe(0);
  });

});
