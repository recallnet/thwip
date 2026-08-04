import { afterEach, describe, expect, it } from "vitest";
import { queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { acceptProof } from "../../test/proof.js";
import { provenCommit } from "../../test/proven-commit.js";
import { authorizeTurn } from "./authorize-turn.js";
import { driveQueue } from "./drive-queue.js";
import { mergeOperationId } from "./merge-commit.js";
import type { D1Like } from "./projection.js";
import { buildSnapshot } from "./queue-operations.js";
import { loadQueueState } from "./queue-state.js";
import { runOnQueue, type QueueRouteEnv } from "./routes.js";

const REPO = "1315419165";
const REF = "refs/heads/main";
const BASE = "b".repeat(40);
const HEAD_A = "5".repeat(40);
const HEAD_B = "6".repeat(40);
const TREE = "7".repeat(40);
const CANDIDATE = "c".repeat(40);

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_1", "1", "acme");
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("alice", "org_1", "1", "alice");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const baseOnQueue = ((e, repositoryId, baseRef, decide) =>
  runOnQueue(e, repositoryId, baseRef, decide)) as Parameters<typeof driveQueue>[2];

function deps(writes: number[]) {
  return queueRouteDeps(
    {
      repositoryId: REPO,
      baseRef: REF,
      baseSha: BASE,
      treeOid: TREE,
      candidateSha: CANDIDATE,
      headShaFor: (pr) => (pr === 1 ? HEAD_A : HEAD_B),
    },
    {
      commitFacts: async () => ({
        treeOid: TREE,
        parentShas: [BASE],
        message: provenCommit({ repositoryId: REPO, treeOid: TREE, baseRef: REF, baseSha: BASE }),
      }),
      baseContainsSha: async () => true,
      mergeWrite: async () => {
        writes.push(1);
        return { kind: "unknown" as const, detail: "test write" };
      },
    },
  ) as Parameters<typeof driveQueue>[1];
}

async function place(e: QueueRouteEnv, reads: ReturnType<typeof deps>, pr: 1 | 2): Promise<void> {
  const headSha = pr === 1 ? HEAD_A : HEAD_B;
  acceptProof(raw, REPO, headSha);
  await authorizeTurn(e, reads, baseOnQueue, {
    repositoryId: REPO,
    baseRef: REF,
    pullRequestNumber: pr,
    headSha,
    authorGithubUserId: "1",
    draft: false,
  });
}

/** Mutate the queue after authorization has created the operation, before driveQueue reloads it. */
function racingOnQueue(
  mutate: (parts: Parameters<Parameters<typeof runOnQueue>[3]>[0], attemptId: string) => void | Promise<void>,
): Parameters<typeof driveQueue>[2] {
  let raced = false;
  return (async (e, repositoryId, baseRef, decide) => {
    const answer = await runOnQueue(e, repositoryId, baseRef, decide);
    const operationId = (answer.result as { operationId?: string | null } | undefined)?.operationId;
    if (!raced && typeof operationId === "string") {
      raced = true;
      const attemptId = operationId.replace(/^merge_/, "");
      await runOnQueue(e, repositoryId, baseRef, (parts) => mutate(parts, attemptId));
    }
    return answer;
  }) as Parameters<typeof driveQueue>[2];
}

describe("the final App-write revalidation", () => {
  it("does not combine the old operation with a replacement lane holder", async () => {
    const e = env();
    const writes: number[] = [];
    const reads = deps(writes);
    await place(e, reads, 1);
    await place(e, reads, 2);

    const onQueue = racingOnQueue(async ({ commands }, attemptId) => {
      commands.mergeOutcomeUnknown({ idempotencyKey: "race:unknown", attemptId });
      await commands.confirmNotMerged({
        idempotencyKey: "race:not-merged",
        attemptId,
        operationId: mergeOperationId(attemptId),
      });
    });
    await driveQueue(e, reads, onQueue, { repositoryId: REPO, baseRef: REF });

    const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
    expect(buildSnapshot(store).activeEntryId).toBe(`entry_${REPO}_2`);
    expect(writes).toEqual([]);
  });

  it("does not write after the queue is paused between authorization and reload", async () => {
    const e = env();
    const writes: number[] = [];
    const reads = deps(writes);
    await place(e, reads, 1);

    const onQueue = racingOnQueue(({ commands }) => {
      commands.pause({ idempotencyKey: "race:pause", actorPrincipalId: "operator", reason: "review" });
    });
    await driveQueue(e, reads, onQueue, { repositoryId: REPO, baseRef: REF });

    const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
    expect(buildSnapshot(store).paused).toBe(true);
    expect(writes).toEqual([]);
  });

  it("does not write after an external base move requires rebaseline", async () => {
    const e = env();
    const writes: number[] = [];
    const reads = deps(writes);
    await place(e, reads, 1);

    const onQueue = racingOnQueue(({ commands }) => {
      commands.observedExternalTransition({ idempotencyKey: "race:base", observedBaseSha: "d".repeat(40) });
    });
    await driveQueue(e, reads, onQueue, { repositoryId: REPO, baseRef: REF });

    const { store } = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
    expect(buildSnapshot(store).rebaselineRequired).toBe(true);
    expect(writes).toEqual([]);
  });
});
