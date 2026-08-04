import type { QueueRouteEnv } from "./routes.js";
import { authorizeAppWrite, type AuthorizeTurnDeps } from "./authorize-turn.js";
import { mergeLaneFor, type OnQueue } from "./merge-lane.js";
import { loadQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";
import { buildSnapshot } from "./queue-operations.js";
import { mergeOperationId } from "./merge-commit.js";
import { readAttestation } from "./attestation.js";
import { parseMergeIntent } from "@thwip/queue-protocol";

/** The states in which an entry is the one the lane belongs to. */
const HOLDING = ["Offered", "Active", "Verifying", "MergeGuard", "Merging"];

/**
 * Take whoever holds the lane as far as the App can take them.
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
  const { store } = await loadQueueState(env.DB as unknown as D1Like, input.repositoryId, input.baseRef);
  const holder = [...store.state().entries.values()].find((e) => HOLDING.includes(e.state));
  if (holder === undefined) return 0;

  // Read from GitHub rather than taken from the entry. The entry's head is what
  // it was placed with, and a push that landed while the turn was being offered
  // moves it; walking the old one signs an intent for a tree nothing will take.
  const placement = await deps.pullRequestPlacement(env, input.repositoryId, holder.pullRequestNumber);
  if (placement === null) return 0;

  const result = await authorizeAppWrite(env, deps, onQueue, {
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    pullRequestNumber: holder.pullRequestNumber,
    headSha: placement.headSha,
    authorGithubUserId: placement.authorGithubUserId,
    draft: placement.draft,
  });

  if (
    result.outcome !== "settled" ||
    !result.enforcing ||
    !result.authorized ||
    result.operationId === null
  ) {
    return 1;
  }

  // The check-facing walk above decides and signs. Only this internal App path
  // writes. Read the resulting queue state instead of accepting merge inputs
  // from the caller that happened to wake the App.
  const { store: ready } = await loadQueueState(
    env.DB as unknown as D1Like,
    input.repositoryId,
    input.baseRef,
  );
  const state = buildSnapshot(ready);
  const attemptId = state.activeAttemptId;
  const candidate = state.activeCandidate;
  if (
    state.paused ||
    state.rebaselineRequired ||
    attemptId === null ||
    candidate === null ||
    state.activeEntryId !== result.entryId ||
    mergeOperationId(attemptId) !== result.operationId
  ) {
    return 1;
  }

  const attempt = ready.state().attempts.get(attemptId);
  const entry = ready.state().entries.get(result.entryId);
  if (attempt?.intentDigest == null || entry === undefined) return 1;

  // Authorization signs before the network write, but another wake may settle
  // that operation and advance the lane before this reload. Bind the write to
  // the intent that is still active now, not to the holder that was active at
  // the start of this call.
  const storedIntent = await readAttestation(env.DB as unknown as D1Like, attempt.intentDigest);
  const parsedIntent = storedIntent?.kind === "merge-intent" ? parseMergeIntent(storedIntent.record) : null;
  if (!parsedIntent?.ok) return 1;
  const intent = parsedIntent.value;
  if (
    intent.repositoryId !== input.repositoryId ||
    intent.baseRef !== input.baseRef ||
    intent.attemptId !== attemptId ||
    intent.operationId !== result.operationId ||
    intent.pullRequestNumber !== entry.pullRequestNumber ||
    intent.mergeMethod !== "merge" ||
    intent.git.baseSha !== candidate.baseSha ||
    intent.git.headSha !== candidate.headSha ||
    intent.git.candidateSha !== candidate.candidateSha ||
    intent.git.candidateTreeOid !== candidate.candidateTree ||
    intent.git.candidateParentOids.length !== 2 ||
    intent.git.candidateParentOids[0] !== candidate.baseSha ||
    intent.git.candidateParentOids[1] !== candidate.headSha
  ) {
    return 1;
  }

  const { performMergeFromWorker } = mergeLaneFor(deps, onQueue);
  await performMergeFromWorker(env, {
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    attemptId,
    operationId: result.operationId,
    pullRequestNumber: entry.pullRequestNumber,
    merge: {
      baseSha: candidate.baseSha,
      headSha: candidate.headSha,
      treeOid: candidate.candidateTree,
      parentShas: [candidate.baseSha, candidate.headSha],
    },
  });
  return 1;
}
