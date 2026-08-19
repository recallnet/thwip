import type { AuthorizeTurnDeps } from "./authorize-turn.js";
import { mergeLaneFor, type MergeLaneDeps, type OnQueue } from "./merge-lane.js";
import { loadQueueState } from "./queue-state.js";
import type { QueueRouteEnv } from "./routes.js";
import { mergeCommitText } from "./merge-commit.js";

/** Durable work queued before the App is allowed to move a protected branch. */
export interface MergeReconciliationTask {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly pullRequestNumber: number;
}

/** Long enough for the normal merge call, short enough not to hold the next turn. */
export const MERGE_RECONCILIATION_DELAY_SECONDS = 15;

/**
 * A pending GitHub read is ordinary eventual consistency, not a failed queue
 * delivery. Re-enqueueing after this delay gives it a fresh retry budget and
 * avoids burning all five delivery retries before GitHub exposes the commit.
 */
export const MERGE_RECONCILIATION_RETRY_DELAY_SECONDS = 30;

export class MergeReconciliationPendingError extends Error {
  readonly delaySeconds = MERGE_RECONCILIATION_RETRY_DELAY_SECONDS;

  constructor(message: string) {
    super(message);
    this.name = "MergeReconciliationPendingError";
  }
}

export type MergeReconciliationResult =
  | { readonly status: "settled"; readonly mergeSha: string; readonly transitionDigest: string }
  | { readonly status: "pending"; readonly detail: string }
  | { readonly status: "stale"; readonly detail: string };

type MergeReconciliationDeps<TEnv extends QueueRouteEnv> = AuthorizeTurnDeps<TEnv> & {
  projectWriteLease: NonNullable<MergeLaneDeps<TEnv>["projectWriteLease"]>;
};

/**
 * Finish one exact App merge from a fresh Worker invocation.
 *
 * The task is accepted by Cloudflare Queues before the GitHub ref write. It may
 * run before that write finishes, so a negative GitHub read is only "pending";
 * it never authorizes another write and never declares the first one absent.
 */
export async function reconcileQueuedMergeWrite<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: MergeReconciliationDeps<TEnv>,
  onQueue: OnQueue<TEnv>,
  task: MergeReconciliationTask,
): Promise<MergeReconciliationResult> {
  const lease = await deps.projectWriteLease(env, task.repositoryId, task.projectId);
  if (lease === null) return { status: "stale", detail: "the repository project is no longer available" };
  try {
    await lease.renew();
    const { store } = await loadQueueState(env.DB, task.repositoryId, task.baseRef);
    const operation = store.mergeOperation(task.operationId);
    if (operation === null) return { status: "stale", detail: "the merge operation no longer exists" };
    if (
      operation.attemptId !== task.attemptId ||
      operation.pullRequestNumber !== task.pullRequestNumber
    ) {
      throw new Error(`merge reconciliation task ${task.operationId} does not match its durable operation`);
    }
    if (operation.outcome === "CONFIRMED_NOT_MERGED") {
      return { status: "stale", detail: "the merge operation was already confirmed not merged" };
    }

    const pull = await deps.pullRequestMergeState(
      env,
      task.repositoryId,
      task.pullRequestNumber,
    );
    if (pull?.merged !== true || pull.mergeCommitSha === null) {
      return { status: "pending", detail: "GitHub has not confirmed the merge yet" };
    }
    const landed = await deps.commitFacts(env, task.repositoryId, pull.mergeCommitSha);
    if (landed?.message === undefined) {
      return { status: "pending", detail: "GitHub has not returned the landed merge commit yet" };
    }
    const expectedMessage = mergeCommitText(task.pullRequestNumber, task.operationId);
    if (landed.message !== expectedMessage && `${landed.message}\n` !== expectedMessage) {
      return {
        status: "stale",
        detail: "the pull request merged without this Thwip operation's commit attribution",
      };
    }

    const { recordLandedMerge } = mergeLaneFor(deps, onQueue);
    const recorded = await recordLandedMerge(env, {
      repositoryId: task.repositoryId,
      baseRef: task.baseRef,
      attemptId: task.attemptId,
      operationId: task.operationId,
      mergeSha: pull.mergeCommitSha,
      witnessPrincipalIds: [],
      writeLease: lease,
    });
    if (!recorded.ok) {
      const detail = `${recorded.code}: ${recorded.detail}`;
      return recorded.code === "RESULT_NOT_AUTHORIZED"
        ? { status: "stale", detail }
        : { status: "pending", detail };
    }
    if (
      recorded.digest === null ||
      (recorded.transition !== "applied" && recorded.transition !== "duplicate")
    ) {
      return {
        status: "pending",
        detail: recorded.detail ?? `transition ${recorded.transition} has no durable signed record`,
      };
    }
    return {
      status: "settled",
      mergeSha: pull.mergeCommitSha,
      transitionDigest: recorded.digest,
    };
  } finally {
    await lease.release();
  }
}
