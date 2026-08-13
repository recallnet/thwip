import { buildSnapshot, type QueueSnapshot } from "./queue-operations.js";
import { loadQueueState, withQueueState } from "./queue-state.js";
import {
  projectQueueState,
  projectTerminalEntryHistory,
  pruneTerminalEntryHistory,
  projectionMessageFrom,
  terminalEntryHistoryFromRecentEvents,
  type D1Like,
} from "./projection.js";
import { acquireProjectWriteLease, type ProjectWriteLease } from "../project-lifecycle.js";

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
  lifecycleLease?: ProjectWriteLease,
): Promise<QueueSnapshot> {
  const { store, projectId } = await loadQueueState(db, repositoryId, baseRef);
  if (projectId === null) throw new Error(`repository ${repositoryId} project is unavailable`);
  const borrowed = lifecycleLease !== undefined;
  const lease = lifecycleLease ?? await acquireProjectWriteLease(db, repositoryId, projectId);
  if (lease === null || lease.projectId !== projectId) {
    if (!borrowed) await lease?.release();
    throw new Error(`repository ${repositoryId} project is unavailable`);
  }
  try {
    await lease.renew();
    const snapshot = buildSnapshot(store);
    const pending = [...store.pendingTerminalEntryProjections()];
    const legacy = await terminalEntryHistoryFromRecentEvents(
      db,
      repositoryId,
      baseRef,
      snapshot.entries,
      store.recentEvents(200),
    );
    const terminal = [...pending, ...legacy];
    // History first. If this fails, the queue document keeps the backlog and a
    // later empty heartbeat retries it. Only an accepted D1 write earns the
    // acknowledgement that lets authority forget the handoff.
    await projectTerminalEntryHistory(db, repositoryId, baseRef, terminal, projectId);
    await projectQueueState(
      db,
      projectionMessageFrom(repositoryId, baseRef, snapshot, projectId),
      lease,
    );
    await pruneTerminalEntryHistory(db, repositoryId, baseRef, projectId);
    if (pending.length > 0) {
      await withQueueState(db, repositoryId, baseRef, (current) => {
        current.acknowledgeTerminalEntryProjections(pending.map((row) => row.projectionId));
      }, { expectedProjectId: projectId, lease });
    }
    return snapshot;
  } finally {
    if (!borrowed) await lease.release();
  }
}
