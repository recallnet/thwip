import type { UnresolvedMergeOperation } from "./store.js";
import type { RecordFromIntentResult } from "./record-from-intent.js";
import { confirmMergeAbsence, type PullMergeState } from "./merge-absence.js";

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

/**
 * How far back a tick looks for a merge that landed and was never recorded.
 *
 * A day, which covers every tick outage this deployment has had and stops well
 * short of re-examining history. A row older than this is either recorded or is
 * a chain finding for a person to answer, and a sweep quietly writing records
 * for last week's merges is not a repair anybody asked for.
 */
export const MERGED_WITHOUT_RECORD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many stranded writes one queue settles per tick.
 *
 * Settling one write costs a pull request read and a base comparison per
 * confirmation round, plus the commit reads that build the record, and every one
 * of those is a Worker subrequest, and `githubJson` mints an installation token
 * per call, so each read costs two. A row GitHub cannot answer runs the full
 * three-round backoff and costs about fourteen. This account stays inside the
 * free tier on purpose, and an unbounded sweep over a backlog would exhaust the
 * per-invocation budget and fail the whole tick.
 *
 * Five does not guarantee the tick fits. Five unreadable rows across several
 * queues can still run the budget out, and the honest reason that is survivable
 * is ordering rather than arithmetic: the sweep runs after the lane is driven,
 * so a tick that dies here has already done the work a queue stops without, and
 * the rows wait for the next cron.
 */
export const ORPHANED_WRITE_SWEEP_LIMIT = 5;

export interface OrphanedWriteReads {
  /**
   * The pull requests GitHub associates with the head commit this write pinned,
   * or null when the read failed. Asked only for a row written before
   * `merge_operations` carried a pull request number, which is what the four
   * stranded writes are.
   */
  pullRequestNumbersForHead(): Promise<readonly number[] | null>;
  /** What the pull request says about itself, or null when it could not be read. */
  readMergeState(pullRequestNumber: number): Promise<PullMergeState | null>;
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
  /** The backoff between confirmation rounds. Overridden so tests do not wait. */
  sleep?(ms: number): Promise<void>;
}

export type OrphanedWriteOutcome =
  | { readonly settled: "merged"; readonly operationId: string; readonly mergeSha: string }
  | { readonly settled: "not-merged"; readonly operationId: string }
  | { readonly settled: "unknown"; readonly operationId: string; readonly reason: string };

export async function settleOrphanedWrite(
  write: UnresolvedMergeOperation,
  reads: OrphanedWriteReads,
): Promise<OrphanedWriteOutcome> {
  const unknown = (reason: string): OrphanedWriteOutcome => ({
    settled: "unknown",
    operationId: write.operationId,
    reason,
  });

  const pullRequestNumber = await pullRequestFor(write, reads);
  if (pullRequestNumber === null) {
    return unknown("the pull request this write was sent for could not be named");
  }

  // `confirmMergeAbsence` is the rule this codebase already settled on, and it
  // is reused rather than restated. One pull request read that has not caught up
  // with its own merge is how four merges lost their links; a negative needs
  // every read, from both sources, across the backoff.
  const verdict = await confirmMergeAbsence(
    {
      readPull: () => reads.readMergeState(pullRequestNumber),
      baseContainsHead: () => reads.baseContainsHead(),
    },
    reads.sleep === undefined ? {} : { sleep: reads.sleep },
  );

  if (verdict.kind === "merged") {
    // A merge with no sha is the ancestry-only arm: the base contains the head,
    // which says a merge landed and says nothing about what landed. Offering the
    // head commit here is what `merge-absence.ts` refuses to do and for the same
    // reason. On a squash queue the squash tree equals the head tree while the
    // branch sits on base, so a head commit parented on base passes every gate
    // and the chain would claim main became the pull request's own commit. The
    // row stays open and the next tick asks again.
    if (verdict.mergeSha === null) {
      return unknown("the merge landed and GitHub named no commit");
    }
    const recorded = await reads.recordMerge(verdict.mergeSha);
    if (recorded.status === "refused") return unknown(recorded.detail);
    await reads.resolve(write.operationId, "MERGED");
    return { settled: "merged", operationId: write.operationId, mergeSha: verdict.mergeSha };
  }

  if (verdict.kind === "unknown") return unknown(verdict.reason);

  await reads.resolve(write.operationId, "CONFIRMED_NOT_MERGED");
  return { settled: "not-merged", operationId: write.operationId };
}

/**
 * Which pull request this write was sent for.
 *
 * The row carries the number for every write started since the column existed.
 * The four writes the sweep was built for predate it and carry nothing, so the
 * number is read back from the head commit they pinned. Two candidates is not an
 * answer: picking one would be the guess this whole file exists to avoid.
 */
async function pullRequestFor(
  write: UnresolvedMergeOperation,
  reads: OrphanedWriteReads,
): Promise<number | null> {
  if (write.pullRequestNumber !== null) return write.pullRequestNumber;
  const candidates = await reads.pullRequestNumbersForHead();
  if (candidates === null || candidates.length !== 1) return null;
  return candidates[0] ?? null;
}
