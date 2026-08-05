/** Commit text and operation identity shared by the App writer and its records. */

import { QUEUE_MERGE_TRAILER } from "./external-push.js";

/** Title bound by the signed intent and written by the App. */
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

/** Body bound by the signed intent and written by the App. */
export function mergeCommitMessage(operationId: string): string {
  return `Integrated by Thwip Queue.\n\n${queueAttributionTrailer(operationId)}\n`;
}

/** The complete commit message sent to GitHub's commit-object API. */
export function mergeCommitText(pullRequestNumber: number, operationId: string): string {
  return `${mergeCommitTitle(pullRequestNumber)}\n\n${mergeCommitMessage(operationId)}`;
}
