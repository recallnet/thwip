// apps/control-plane/src/queue/scheduled-tick.ts
import { commandsFor, buildSnapshot } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import { requiresDeviceOnly, retireStaleRunners } from "./runners.js";
import type { D1Like } from "./projection.js";
import type { QueueRouteEnv } from "./routes.js";
import { readActivePolicy } from "../active-policy.js";

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
  onQueueFailed(repositoryId: string, error: unknown): void;
}

export async function tickAllQueues(
  env: QueueRouteEnv,
  ports: TickPorts,
): Promise<{ ticked: number; driven: number; failed: number }> {
  const db = env.DB as unknown as D1Like;
  const rows = await db
    .prepare("SELECT github_repository_id AS repositoryId, base_ref AS baseRef FROM queue_projects WHERE enabled = 1")
    .bind()
    .all<{ repositoryId: string; baseRef: string }>();

  const now = new Date().toISOString();
  // Retire stale runners once per repository, not once per queue: the table is
  // keyed on repository and principal, not on a base ref, and a repository can
  // queue more than one branch. Cached per repository, inside each row's own
  // try block, so a repository whose retirement read fails only fails that
  // repository's queues, the same as any other per-queue failure below.
  const offlinePrincipalsByRepo = new Map<string, readonly string[]>();
  // Same shape, same reason: the security profile is a repository setting, so
  // it is looked up once per repository per tick, not once per queue row.
  const deviceOnlyByRepo = new Map<string, boolean>();

  let ticked = 0;
  let driven = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      let offlinePrincipals = offlinePrincipalsByRepo.get(row.repositoryId);
      if (offlinePrincipals === undefined) {
        offlinePrincipals = await retireStaleRunners(db, row.repositoryId, now);
        offlinePrincipalsByRepo.set(row.repositoryId, offlinePrincipals);
      }
      let deviceOnly = deviceOnlyByRepo.get(row.repositoryId);
      if (deviceOnly === undefined) {
        const policy = await readActivePolicy(db, row.repositoryId);
        deviceOnly = requiresDeviceOnly(policy?.securityProfile ?? null);
        deviceOnlyByRepo.set(row.repositoryId, deviceOnly);
      }
      const snapshot = await withQueueState(db, row.repositoryId, row.baseRef, (store) => {
        const commands = commandsFor(store);
        commands.runAlarm();

        // A runner that stopped heartbeating loses eligibility, never its
        // fairness ordinal: it must not block a Ready entry behind it, and it
        // must not lose its place when the runner comes back.
        if (offlinePrincipals.length > 0) {
          for (const entry of buildSnapshot(store).entries) {
            if (offlinePrincipals.includes(entry.sponsorPrincipalId) && entry.schedulerEligible) {
              commands.evaluateReadiness({
                idempotencyKey: `runner-offline:${entry.entryId}:${now}`,
                entryId: entry.entryId,
                ready: true,
                schedulerEligible: false,
                primaryReason: "AGENT_OFFLINE",
              });
            }
          }
        }
        return buildSnapshot(store);
      });
      ticked += 1;
      ports.onQueueTicked(row.repositoryId);

      // Only a held lane needs driving. Dispatching for an idle queue would
      // spend a CI run to be told there is nothing to do — and under `fresh`
      // or `audited` there is no Actions fallback at all, so a held lane
      // there is not this tick's to drive; the connected device claims it
      // itself, over the heartbeat response (plan.md §5.0).
      const holder = snapshot.entries.find((e) => e.state === "Offered" || e.state === "Active");
      if (holder !== undefined && !deviceOnly) {
        await ports.driveTurn(row.repositoryId, holder.pullRequestNumber);
        driven += 1;
      }
    } catch (error) {
      // A heartbeat that reports the same number whether it worked or failed
      // is not a signal. Keep this out of `ticked` so a fleet-wide outage
      // shows up as a fleet-wide `failed` count instead of a normal-looking
      // one, and hand the error to the caller since this port has no other
      // way to report it.
      failed += 1;
      ports.onQueueFailed(row.repositoryId, error);
    }
  }
  return { ticked, driven, failed };
}
