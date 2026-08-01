// apps/control-plane/src/queue/scheduled-tick.ts
import { commandsFor, buildSnapshot } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";
import type { QueueRouteEnv } from "./routes.js";

/**
 * Move every queue's clock forward on a timer.
 *
 * Deadlines are advanced inside a queue transaction, so before this existed an
 * expired offer went unnoticed until unrelated traffic happened to arrive. On a
 * quiet repository that is indefinitely: the lane sits held by an offer nobody
 * can take, and the pull request behind it waits forever.
 *
 * Deliberately cheap. One row read per queue, a write only when the clock
 * actually changed something, and a dispatch only when a lane is held.
 */
export interface TickPorts {
  driveTurn(repositoryId: string, pullRequestNumber: number): Promise<void>;
  onQueueTicked(repositoryId: string): void;
}

export async function tickAllQueues(
  env: QueueRouteEnv,
  ports: TickPorts,
): Promise<{ ticked: number; driven: number }> {
  const rows = await (env.DB as unknown as D1Like)
    .prepare("SELECT github_repository_id AS repositoryId, base_ref AS baseRef FROM queue_projects WHERE enabled = 1")
    .bind()
    .all<{ repositoryId: string; baseRef: string }>();

  let ticked = 0;
  let driven = 0;
  for (const row of rows.results) {
    try {
      const snapshot = await withQueueState(
        env.DB as unknown as D1Like,
        row.repositoryId,
        row.baseRef,
        (store) => {
          const commands = commandsFor(store);
          commands.runAlarm();
          return buildSnapshot(store);
        },
      );
      ticked += 1;
      ports.onQueueTicked(row.repositoryId);

      // Only a held lane needs driving. Dispatching for an idle queue would
      // spend a CI run to be told there is nothing to do.
      const holder = snapshot.entries.find((e) => e.state === "Offered" || e.state === "Active");
      if (holder !== undefined) {
        await ports.driveTurn(row.repositoryId, holder.pullRequestNumber);
        driven += 1;
      }
    } catch {
      // One queue's problem is not the others'. The next tick retries it.
      ticked += 1;
    }
  }
  return { ticked, driven };
}
