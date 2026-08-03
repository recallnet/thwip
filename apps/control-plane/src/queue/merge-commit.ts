/**
 * The commit the merge workflow is told to write, and the method it writes it
 * with.
 *
 * A merge intent binds the commit title and the digest of the commit message,
 * which only means something if the queue and the workflow agree on both. The
 * workflow is YAML and cannot import this, so the strings live here, the record
 * binds what the queue expected, and a drift shows up as a mismatch between the
 * signed intent and the commit that landed rather than as a silent divergence.
 *
 * The merge method is the same kind of value, for the same reason: the record
 * signed before a merge and the workflow that performs it must agree on whether
 * it is a merge or a squash, or a squash-configured repository's landed commit
 * — one parent — fails the two-parent shape a `"merge"` record demands, signing
 * is refused, and the merge lands with no chain link and no finding.
 *
 * `merge-commit.test.ts` reads the workflow and fails if any of the three ever
 * disagree.
 */

import { QUEUE_MERGE_TRAILER } from "./external-push.js";

export type MergeMethod = "merge" | "squash";

/**
 * The merge method used when a repository's queue project row cannot be read.
 *
 * `queue_projects.merge_method` is the configured source per repository; this
 * is only the fallback for a branch the authorize endpoint declines to answer
 * for (no queue configured) — a case that never reaches a merge. It exists so
 * the workflow's own default, read from the authorize response, has exactly
 * one place it comes from rather than a string typed again in the YAML.
 */
export const DEFAULT_MERGE_METHOD: MergeMethod = "merge";

/** Matches `commit_title` in .github/workflows/thwip-merge.yml. */
export function mergeCommitTitle(pullRequestNumber: number): string {
  return `Merge pull request #${pullRequestNumber} (Thwip Queue)`;
}

/** The operation id a merge for this attempt is performed under. */
export function mergeOperationId(attemptId: string): string {
  return `merge_${attemptId}`;
}

/**
 * The trailer naming the operation a merge performed, which is also how the
 * queue tells its own merges from somebody else's push. Any path that writes a
 * merge commit ends its message with this line.
 */
export function queueAttributionTrailer(operationId: string): string {
  return `${QUEUE_MERGE_TRAILER}: ${operationId}`;
}

/**
 * Matches `commit_message` in .github/workflows/thwip-merge.yml.
 */
export function mergeCommitMessage(operationId: string): string {
  return `Integrated by Thwip Queue.\n\n${queueAttributionTrailer(operationId)}\n`;
}
