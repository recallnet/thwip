/**
 * A push to the protected branch that the queue did not cause.
 *
 * The queue's claim is that it knows what is on the branch it guards. If somebody
 * merges around it, every turn it has offered is against a base that no longer
 * exists, and it has to stop and be rebaselined rather than go on certifying
 * merges onto a tree it never saw.
 *
 * The reducer has paused on this since the beginning and nothing ever told it.
 * The event existed, the invariant existed, the command existed, and no caller
 * did — so a queue whose branch moved underneath it would have carried on
 * merging, which is the one thing it exists to prevent.
 *
 * Telling the queue's own merges from everybody else's is the whole difficulty.
 * Pausing on its own merge would stop the queue every time it succeeded, and
 * comparing shas depends on whether the push webhook or the merge callback
 * arrives first. The merge commit the queue writes names the operation it
 * performed, which is true the moment the commit exists and does not depend on
 * delivery order.
 */

/** Written into every merge commit the queue makes, by the merge workflow. */
export const QUEUE_MERGE_TRAILER = "thwip-queue-operation";

/**
 * Written into the other commits thwip's own workflows push to the branch.
 *
 * The release workflow pushes a version bump straight to the default branch,
 * which is a push the queue did not make and would otherwise read as somebody
 * merging around it — pausing the queue after every publish.
 *
 * Skipping it is safe because it is not what protects an in-flight turn. The
 * queue pins the candidate tree it authorized and refuses to confirm a merge
 * whose tree is not that one, so a base that moved underneath a turn is caught
 * when the merge is reported, whatever this decides.
 */
export const AUTOMATION_TRAILER = "thwip-automated";

export interface ExternalPush {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly observedBaseSha: string;
}

interface PushPayload {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  repository?: { id?: unknown; default_branch?: unknown } | null;
  head_commit?: { id?: unknown; message?: unknown } | null;
}

function sha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value) ? value : null;
}

export function externalPushFromWebhook(event: string, payload: PushPayload): ExternalPush | null {
  if (event !== "push") return null;
  if (payload.deleted === true) return null;

  const repositoryId = payload.repository?.id;
  const defaultBranch = payload.repository?.default_branch;
  if (typeof repositoryId !== "number" && typeof repositoryId !== "string") return null;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) return null;

  // Only the branch the queue guards. A push to a feature branch is ordinary work.
  const baseRef = `refs/heads/${defaultBranch}`;
  if (payload.ref !== baseRef) return null;

  const observedBaseSha = sha(payload.head_commit?.id) ?? sha(payload.after);
  if (observedBaseSha === null) return null;

  // The queue's own merge. A push with no commit message to read cannot be
  // attributed to the queue, and is treated as external — the safe direction,
  // because the cost of being wrong is a pause an administrator clears, not a
  // merge onto a branch nobody checked.
  const message = payload.head_commit?.message;
  if (typeof message === "string") {
    if (message.includes(`${QUEUE_MERGE_TRAILER}:`)) return null;
    if (message.includes(`${AUTOMATION_TRAILER}:`)) return null;
  }

  return { repositoryId: String(repositoryId), baseRef, observedBaseSha };
}
