/**
 * The commit the merge workflow is told to write.
 *
 * A merge intent binds the commit title and the digest of the commit message,
 * which only means something if the queue and the workflow agree on both. The
 * workflow is YAML and cannot import this, so the strings live here, the record
 * binds what the queue expected, and a drift shows up as a mismatch between the
 * signed intent and the commit that landed rather than as a silent divergence.
 *
 * `merge-commit.test.ts` reads the workflow and fails if the two ever disagree.
 */

/** Matches `commit_title` in .github/workflows/thwip-merge.yml. */
export function mergeCommitTitle(pullRequestNumber: number): string {
  return `Merge pull request #${pullRequestNumber} (Thwip Queue)`;
}

/**
 * Matches `commit_message` in .github/workflows/thwip-merge.yml.
 *
 * The trailer names the operation this merge performed, which is also how the
 * queue tells its own merges from somebody else's push.
 */
export function mergeCommitMessage(operationId: string): string {
  return `Integrated by Thwip Queue.\n\nthwip-queue-operation: ${operationId}\n`;
}
