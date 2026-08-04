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

/** Written into every merge commit the queue makes. */
export const QUEUE_MERGE_TRAILER = "thwip-queue-operation";

/**
 * Whether a commit message says the queue performed this merge.
 *
 * Every path that writes a merge commit and every path that reads one asks this
 * function, so the writer and the reader cannot drift into disagreeing about
 * what attribution looks like. They used to agree by both spelling the trailer
 * by hand, and the driver's message never spelled it at all.
 */
export function carriesQueueAttribution(message: string): boolean {
  return message.includes(`${QUEUE_MERGE_TRAILER}:`);
}


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
  if (typeof message === "string" && carriesQueueAttribution(message)) return null;

  return { repositoryId: String(repositoryId), baseRef, observedBaseSha };
}

/**
 * A push to the branch a queue guards, whoever made it.
 *
 * `externalPushFromWebhook` answers a narrower question and refuses the queue's
 * own merges, which is right for pausing and wrong for waking: the merge the
 * queue just wrote is exactly the event that frees the lane for whoever is
 * next. So this names the branch and says nothing about who moved it.
 */
export function pushedQueueBranch(
  event: string,
  payload: PushPayload,
): { repositoryId: string; baseRef: string } | null {
  if (event !== "push") return null;
  if (payload.deleted === true) return null;

  const repositoryId = payload.repository?.id;
  const defaultBranch = payload.repository?.default_branch;
  if (typeof repositoryId !== "number" && typeof repositoryId !== "string") return null;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) return null;

  const baseRef = `refs/heads/${defaultBranch}`;
  if (payload.ref !== baseRef) return null;
  return { repositoryId: String(repositoryId), baseRef };
}
