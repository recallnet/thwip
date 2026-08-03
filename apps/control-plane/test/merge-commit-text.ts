import { mergeCommitMessage, mergeCommitTitle } from "../src/queue/merge-commit.js";

/**
 * The whole message of a merge commit, as one string.
 *
 * The workflow joins the title and the message in shell, and this is what that
 * join is checked against. Two suites need the same oracle:
 * `merge-commit.test.ts` pins the join shape, and `merge-attribution.test.ts`
 * runs the workflow's own printf lines through bash and compares the result to
 * this. Nothing in production joins them — the merge commit is written by the
 * workflow — so it lives out here rather than being an export of a shipping
 * module that only tests call.
 */
export function mergeCommitText(pullRequestNumber: number, operationId: string): string {
  return `${mergeCommitTitle(pullRequestNumber)}\n\n${mergeCommitMessage(operationId)}`;
}
