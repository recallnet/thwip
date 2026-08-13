import { buildSnapshot, type QueueSnapshot } from "./queue-operations.js";
import { loadQueueState } from "./queue-state.js";
import { projectQueueState, projectionMessageFrom, type D1Like } from "./projection.js";

/**
 * Republish the current queue authority, including an idempotent replay of its
 * transition tail.
 *
 * Merge-record recovery reads the transition index, so it must first close the
 * only legitimate gap: queue_state committed while its best-effort projection
 * failed. A current-generation replay repairs that gap without changing queue
 * authority or inventing a link.
 */
export async function projectAuthoritativeQueue(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<QueueSnapshot> {
  const { store } = await loadQueueState(db, repositoryId, baseRef);
  const snapshot = buildSnapshot(store);
  await projectQueueState(db, projectionMessageFrom(repositoryId, baseRef, snapshot));
  return snapshot;
}
