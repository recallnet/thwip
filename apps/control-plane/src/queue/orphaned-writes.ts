import type { UnresolvedMergeOperation } from "./store.js";
import type { RecordFromIntentResult } from "./record-from-intent.js";

/**
 * Settling a merge write the workflow walked away from.
 *
 * A write is authorized, GitHub answers 405 while it is still working out
 * mergeability, and the workflow exits saying it leaves the outcome to
 * reconciliation. There was no reconciliation for this: the only sweep keyed off
 * a surviving attempt, and the attempt is terminated and compacted long before
 * anybody looks. Four merges reached `main` that way on 2 August 2026 and the
 * chain has no link for any of them.
 *
 * So the write settles itself, from git, and the workflow's report becomes the
 * fast path rather than the only path.
 *
 * Every arm that cannot conclude leaves the row alone. The row is the only
 * surviving evidence that a write is outstanding, and clearing it on a read
 * nobody could complete is how the original failure worked.
 */

/** Ten minutes. Longer than any merge workflow run observed on this repository. */
export const ORPHANED_WRITE_GRACE_MS = 10 * 60 * 1000;

export interface OrphanedWriteReads {
  /** What the pull request says about itself, or null when it could not be read. */
  readMergeState(): Promise<{ merged: boolean; mergeCommitSha: string | null } | null>;
  /** Whether the base branch contains the head commit, from git ancestry. */
  baseContainsHead(): Promise<boolean | null>;
  /** Build, sign and record the transition from the signed merge intent. */
  recordMerge(mergeSha: string): Promise<RecordFromIntentResult>;
  /**
   * Async because clearing this row is the last step in settling a write nobody
   * else will settle. A fire-and-forget write here, cut off by the Worker
   * exiting, is the same class of loss the whole sweep exists to close.
   */
  resolve(operationId: string, outcome: "MERGED" | "CONFIRMED_NOT_MERGED"): Promise<void>;
}

export type OrphanedWriteOutcome =
  | { readonly settled: "merged"; readonly operationId: string; readonly mergeSha: string }
  | { readonly settled: "not-merged"; readonly operationId: string }
  | { readonly settled: "unknown"; readonly operationId: string; readonly reason: string };

export async function settleOrphanedWrite(
  write: UnresolvedMergeOperation,
  reads: OrphanedWriteReads,
): Promise<OrphanedWriteOutcome> {
  const pull = await reads.readMergeState();
  const contains = await reads.baseContainsHead();

  // Git settles it either way round. A pull request that reports itself merged
  // is enough, and so is ancestry when the pull request has not caught up with
  // its own merge.
  const landed = pull?.merged === true || contains === true;

  if (landed) {
    // `merge_commit_sha` on an open pull request holds the test merge GitHub
    // computes for it, which has the real merge's tree and parents and is on no
    // branch, so it is only trusted once the pull request reports itself
    // merged. Ancestry alone names no commit at all, only that the expected
    // head is reachable from base, so the expected head is offered instead.
    // Nothing here is taken on faith: `recordMerge` reads the commit back from
    // git and refuses anything whose tree and parents do not match what the
    // queue authorized, so a wrong guess here comes back "refused" rather than
    // recording something nobody signed for.
    const mergeSha = pull?.merged === true ? pull.mergeCommitSha : contains === true ? write.expectedHeadSha : null;
    if (mergeSha === null) {
      return { settled: "unknown", operationId: write.operationId, reason: "the merge landed and GitHub named no commit" };
    }
    const recorded = await reads.recordMerge(mergeSha);
    if (recorded.status === "refused") {
      return { settled: "unknown", operationId: write.operationId, reason: recorded.detail };
    }
    await reads.resolve(write.operationId, "MERGED");
    return { settled: "merged", operationId: write.operationId, mergeSha };
  }

  if (pull !== null && contains === false) {
    await reads.resolve(write.operationId, "CONFIRMED_NOT_MERGED");
    return { settled: "not-merged", operationId: write.operationId };
  }

  return { settled: "unknown", operationId: write.operationId, reason: "GitHub could not be read well enough to say" };
}
