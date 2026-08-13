import type { QueueRouteEnv } from "./routes.js";
import { authorizeTurn, type AuthorizeTurnDeps } from "./authorize-turn.js";
import { driveQueue } from "./drive-queue.js";
import type { OnQueue } from "./merge-lane.js";
import type { D1Like } from "./projection.js";
import { acquireProjectWriteLease } from "../project-lifecycle.js";

/** What naming the pull requests on a commit needs of GitHub. */
export interface ReconsiderHeadDeps<TEnv extends QueueRouteEnv> extends AuthorizeTurnDeps<TEnv> {
  /**
   * The pull requests a commit belongs to, or null when GitHub could not be
   * read. Null is not the empty list: one means the read did not happen, the
   * other means the commit belongs to no pull request.
   */
  pullRequestNumbersForCommit(env: TEnv, repositoryId: string, sha: string): Promise<number[] | null>;
}

/**
 * Walk the queue again for every pull request sitting on a head.
 *
 * Readiness is derived from facts that change while nothing is asking. The App
 * finishes verifying a proof; a required check goes green; a review lands. Each
 * of those changes the answer, and the only thing that used to notice was a
 * workflow polling `/authorize` every twenty seconds — which is the workflow
 * this exists to remove.
 *
 * So the App tells itself. Whoever changes a fact about a commit calls this,
 * and the same check-facing walk the `pull_request` delivery makes runs again
 * with the new answer. The write remains a separate internal App wake.
 */
export async function reconsiderHead<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: ReconsiderHeadDeps<TEnv>,
  onQueue: OnQueue<TEnv>,
  input: { repositoryId: string; headSha: string; expectedProjectId?: string },
): Promise<number> {
  const lease = await acquireProjectWriteLease(
    env.DB as unknown as D1Like,
    input.repositoryId,
    input.expectedProjectId,
  );
  if (lease === null) return 0;
  try {
  await lease.renew();
  const numbers = await deps.pullRequestNumbersForCommit(env, input.repositoryId, input.headSha);
  if (numbers === null) return 0;

  let walked = 0;
  for (const pullRequestNumber of numbers) {
    const placement = await deps.pullRequestPlacement(env, input.repositoryId, pullRequestNumber);
    if (placement === null) continue;
    // Only the pull request this commit is the head of. `/commits/{sha}/pulls`
    // answers with every pull request the commit appears in, and a commit that
    // is merely an ancestor of another branch's head says nothing about that
    // branch's readiness.
    if (placement.headSha !== input.headSha) continue;
    await authorizeTurn(env, deps, onQueue, {
      repositoryId: input.repositoryId,
      baseRef: placement.baseRef,
      pullRequestNumber,
      headSha: input.headSha,
      authorGithubUserId: placement.authorGithubUserId,
      draft: placement.draft,
    });
    await driveQueue(env, deps, onQueue, {
      repositoryId: input.repositoryId,
      baseRef: placement.baseRef,
    });
    walked += 1;
  }
  return walked;
  } finally {
    await lease.release();
  }
}
