import type { QueueRouteEnv } from "./routes.js";
import { authorizeTurn, type AuthorizeTurnDeps } from "./authorize-turn.js";
import type { OnQueue } from "./merge-lane.js";
import { loadQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";

/** The states in which an entry is the one the lane belongs to. */
const HOLDING = ["Offered", "Active", "Verifying", "MergeGuard", "Merging"];

/**
 * Take whoever holds the lane as far as this repository's writer can take them.
 *
 * For a repository that still runs `thwip-merge.yml` this does nothing: the
 * dispatch starts the workflow and the workflow asks for the pins. For one
 * whose writer is the App there is no workflow to start, so the walk has to
 * happen here.
 *
 * Called when the base branch moves. That covers both cases worth waking for:
 * the queue's own merge landing, which frees the lane for whoever is next, and
 * a push from outside it, which changes the base every waiting candidate was
 * integrated against.
 *
 * One entry per call, by design. Each merge produces the push that wakes the
 * next, so a queue drains one link at a time under a trigger GitHub sends
 * rather than a loop this Worker has to bound.
 */
export async function driveQueue<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: AuthorizeTurnDeps<TEnv>,
  onQueue: OnQueue<TEnv>,
  input: { repositoryId: string; baseRef: string },
): Promise<number> {
  const project = await deps.queueProject(env, input.repositoryId, input.baseRef);
  if (project?.mergeWriter !== "app") return 0;

  const { store } = await loadQueueState(env.DB as unknown as D1Like, input.repositoryId, input.baseRef);
  const holder = [...store.state().entries.values()].find((e) => HOLDING.includes(e.state));
  if (holder === undefined) return 0;

  // Read from GitHub rather than taken from the entry. The entry's head is what
  // it was placed with, and a push that landed while the turn was being offered
  // moves it; walking the old one signs an intent for a tree nothing will take.
  const placement = await deps.pullRequestPlacement(env, input.repositoryId, holder.pullRequestNumber);
  if (placement === null) return 0;

  await authorizeTurn(env, deps, onQueue, {
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    pullRequestNumber: holder.pullRequestNumber,
    headSha: placement.headSha,
    authorGithubUserId: placement.authorGithubUserId,
    draft: placement.draft,
    prepare: true,
  });
  return 1;
}
