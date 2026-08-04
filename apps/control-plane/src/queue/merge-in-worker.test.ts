import { afterEach, describe, expect, it } from "vitest";
import { queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import type { MergeIntent, MergeWriteOutcome } from "./merge-write.js";

/**
 * The merge write, performed by the Worker rather than by the adopter's
 * workflow.
 *
 * The write was shell in every adopter's `thwip-merge.yml`, behind a
 * `THWIP_ENQUEUE_TOKEN` they minted and pasted into Actions. Moving it here
 * takes a branch-write credential out of every adopter's Actions secrets and
 * puts the fast-forward guard in code this repository tests.
 *
 * One writer at a time. A repository still running the workflow is answered
 * with the pins and writes its own merge; one that has stopped is answered with
 * none and this writes it. Two writers racing for one turn is how a merge that
 * landed gets reported as a base that moved.
 */

const open: Array<{ close(): void }> = [];

const REPO = "1315419165";
const REF = "refs/heads/main";
const TREE = "7".repeat(40);
const HEAD = "5".repeat(40);
const BASE = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const LANDED = "e".repeat(40);

/** A head carrying a proof bound to the policy the stub below activates. */
const PROVEN = `feat: something

thwip-proof: v1.eyJwYXlsb2FkVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24iLCJwYXlsb2FkIjoiZXlKZmRIbHdaU0k2SW1oMGRIQnpPaTh2YVc0dGRHOTBieTVwYnk5VGRHRjBaVzFsYm5RdmRqRWlMQ0p6ZFdKcVpXTjBJanBiZXlKdVlXMWxJam9pWjJsMExYUnlaV1VpTENKa2FXZGxjM1FpT25zaWMyaGhNU0k2SWpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056Y2lmWDFkTENKd2NtVmthV05oZEdWVWVYQmxJam9pZFhKdU9uUm9kMmx3T21GMGRHVnpkR0YwYVc5dU9tTnBMWEoxYmpwMk1TSXNJbkJ5WldScFkyRjBaU0k2ZXlKelkyaGxiV0ZXWlhKemFXOXVJam9pTVNJc0luSmxjRzl6YVhSdmNua2lPbnNpY0hKdmRtbGtaWElpT2lKbmFYUm9kV0lpTENKdmQyNWxja2xrSWpvaU1TSXNJbkpsY0c5emFYUnZjbmxKWkNJNklqRXpNVFUwTVRreE5qVWlmU3dpWjJsMElqcDdJbTlpYW1WamRFWnZjbTFoZENJNkluTm9ZVEVpTENKMGNtVmxUMmxrSWpvaU56YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOemMzTnpjM056YzNOeUlzSW5CaGNtVnVkRTlwWkhNaU9sc2lZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWWlKZExDSmlZWE5sVW1WbUlqb2ljbVZtY3k5b1pXRmtjeTl0WVdsdUlpd2lZbUZ6WlZOb1lTSTZJbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1JaUxDSmxkbUZzZFdGMGFXOXVUVzlrWlNJNkltaGxZV1F0ZEhKbFpTSjlMQ0p3YjJ4cFkza2lPbnNpWkdsblpYTjBJam9pYzJoaE1qVTJPbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUppWW1KaVltSmlZbUlpTENKMlpYSnphVzl1SWpveGZTd2ljR2x3Wld4cGJtVWlPbnNpWkdsblpYTjBJam9pYzJoaE1qVTJPbU5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk5qWTJOalkyTmpZMk1pTENKeWRXNXVaWElpT2lKamIyMXRZVzVrSW4wc0luSjFiaUk2ZXlKemRHRnlkR1ZrUVhRaU9pSXlNREkyTFRBeExUQXhWREF3T2pBd09qQXdMakF3TUZvaUxDSm1hVzVwYzJobFpFRjBJam9pTWpBeU5pMHdNUzB3TVZRd01Eb3dNVG93TUM0d01EQmFJaXdpYm1WMGQyOXlhMDF2WkdVaU9pSmthWE5oWW14bFpDSXNJbU5oWTJobFRXOWtaU0k2SW1ScGMyRmliR1ZrSWl3aWMzVnBkR1Z6SWpwYmV5SnBaQ0k2SW5WdWFYUWlMQ0p6ZEdGMGRYTWlPaUp3WVhOelpXUWlMQ0prZFhKaGRHbHZiazF6SWpveGZWMTlMQ0p6YVdkdVpYSWlPbnNpYTJWNVNXUWlPaUpUU0VFeU5UWTZhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJ0cmF5SXNJbWRwZEdoMVlsVnpaWEpKWkNJNklqRWlmWDE5Iiwic2lnbmF0dXJlcyI6W3sia2V5aWQiOiJTSEEyNTY6a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2trayIsInNpZyI6IkFBQUEifV19
`;

let raw: import("better-sqlite3").Database;

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  t.raw
    .prepare("INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_1", "1", "acme");
  t.raw
    .prepare(
      "INSERT OR IGNORE INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  t.raw
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
  return queueRoutes(
    queueRouteDeps({ repositoryId: REPO, baseRef: REF, baseSha: BASE, treeOid: TREE, candidateSha: CANDIDATE, headShaFor: () => HEAD }, {
      queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge", mergeWriter: "app" }),
      commitFacts: async (_e: unknown, _r: string, sha: string) =>
        sha === LANDED
          ? { treeOid: TREE, parentShas: [BASE, HEAD], message: "Merge pull request #117 (Thwip Queue)" }
          : { treeOid: TREE, parentShas: [BASE, "6".repeat(40)], message: PROVEN },
      baseContainsSha: async () => true,
      pullRequestMergeState: async () => ({ merged: true, mergeCommitSha: LANDED }),
      ...over,
    }) as Parameters<typeof queueRoutes>[0],
  );
}

/** A write port that records the intent it was handed and answers as told. */
function writer(outcome: MergeWriteOutcome): {
  intents: MergeIntent[];
  port: (env: unknown, repositoryId: string, intent: MergeIntent) => Promise<MergeWriteOutcome>;
} {
  const intents: MergeIntent[] = [];
  return {
    intents,
    port: async (_env, _repositoryId, intent) => {
      intents.push(intent);
      return outcome;
    },
  };
}

async function authorize(
  app: ReturnType<typeof routes>,
  e: QueueRouteEnv,
): Promise<Record<string, unknown>> {
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
      }),
    },
    e,
  );
  return (await response.json()) as Record<string, unknown>;
}

describe("the Worker performing the merge", () => {
  it("hands the writer the base, the tree and the parents the queue pinned", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    await authorize(routes({ mergeWrite: w.port }), e);

    expect(w.intents).toHaveLength(1);
    expect(w.intents[0]).toMatchObject({
      baseRef: REF,
      pullRequestNumber: 117,
      baseSha: BASE,
      headSha: HEAD,
      treeOid: TREE,
      parentShas: [BASE, HEAD],
    });
  });

  /**
   * The trailer is how the queue tells its own merges from somebody else's
   * push, and the operation id in it is what the record binds.
   */
  it("writes the message the record binds", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    await authorize(routes({ mergeWrite: w.port }), e);
    expect(w.intents[0]?.message).toMatch(/Merge pull request #117 \(Thwip Queue\)/);
    expect(w.intents[0]?.message).toMatch(/thwip-queue-operation: merge_/);
  });

  /**
   * An old workflow reading this answer finds no pins and errors rather than
   * merging, which is the loud half of a repository that flipped the writer
   * without dropping the workflow. Silence there would be two writers.
   */
  it("hands out no pins once it is the writer", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    const answer = await authorize(routes({ mergeWrite: w.port }), e);
    expect(answer["merge"]).toBeNull();
    expect(answer["mergeWriter"]).toBe("app");
    expect(answer["merged"]).toBe(true);
  });

  it("leaves the pins alone for a repository still running the workflow", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    const answer = await authorize(
      routes({
        mergeWrite: w.port,
        queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
      }),
      e,
    );
    expect(answer["mergeWriter"]).toBe("workflow");
    expect(answer["merge"]).toMatchObject({ baseSha: BASE, treeOid: TREE });
    expect(w.intents).toEqual([]);
  });

  it("writes a signed record for the merge it performed", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    const answer = await authorize(routes({ mergeWrite: w.port }), e);
    expect(answer["recorded"]).toBe(true);
    expect(answer["transitionDigest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  /**
   * The candidate was verified against a base that no longer exists, so the
   * queue takes the turn back rather than reaching for the new base.
   */
  it("frees the lane when the base moved under it", async () => {
    const e = env();
    const w = writer({ kind: "base-moved", detail: "the base branch is no longer " + BASE });
    const answer = await authorize(routes({ mergeWrite: w.port }), e);
    expect(answer).toMatchObject({ merged: false, reason: "BASE_MOVED" });
  });

  it("leaves an outcome it could not read to reconciliation", async () => {
    const e = env();
    const w = writer({ kind: "unknown", detail: "GitHub could not be read" });
    const answer = await authorize(routes({ mergeWrite: w.port }), e);
    expect(answer).toMatchObject({ merged: false, reason: "MERGE_OUTCOME_UNKNOWN" });
  });

  /**
   * A squash commit does not contain the pull request head, so the branch's own
   * required checks refuse the ref update and GitHub cannot tell the pull
   * request was merged. Nothing is written, and the lane is handed back.
   */
  it("refuses a squash rather than performing one it cannot bind", async () => {
    const e = env();
    const w = writer({ kind: "merged", mergeSha: LANDED });
    const answer = await authorize(
      routes({
        mergeWrite: w.port,
        queueProject: async () => ({
          activationState: "enforced",
          mergeMethod: "squash",
          mergeWriter: "app",
        }),
      }),
      e,
    );
    expect(answer).toMatchObject({ merged: false, reason: "SQUASH_UNBINDABLE" });
    expect(w.intents).toEqual([]);
  });

  /**
   * A deployment with no way to reach GitHub with the App's own credential
   * cannot write, and must go on letting the workflow do it rather than
   * answering with neither pins nor a merge.
   */
  it("keeps the pins where the deployment cannot write at all", async () => {
    const e = env();
    const answer = await authorize(routes({}), e);
    expect(answer["merge"]).toMatchObject({ baseSha: BASE });
  });
});
