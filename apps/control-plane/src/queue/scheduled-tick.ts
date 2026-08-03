// apps/control-plane/src/queue/scheduled-tick.ts
import { CompactSign } from "jose";
import { TERMINAL_ENTRY_STATES } from "@thwip/queue-domain";
import { commandsFor, buildSnapshot } from "./queue-operations.js";
import { queueDecisionRecorder, type R2Like } from "./evidence-store.js";
import { withQueueState } from "./queue-state.js";
import { requiresDeviceOnly, retireStaleRunners } from "./runners.js";
import { overdueReconciliation } from "@thwip/queue-domain";
import { GITHUB_READS, settleReconciliation, type ReconciliationReads } from "./deadlines.js";
import type { D1Like } from "./projection.js";
import { recordFromIntentDepsFor, runOnQueue, type QueueRouteEnv } from "./routes.js";
import { readActivePolicy } from "../active-policy.js";
import { serviceKey } from "../service-signing.js";
import type { Env } from "../env.js";
import { ORPHANED_WRITE_GRACE_MS, ORPHANED_WRITE_SWEEP_LIMIT, settleOrphanedWrite } from "./orphaned-writes.js";
import { recordMergeFromIntent, type RecordFromIntentDeps } from "./record-from-intent.js";

/**
 * The real dependencies `recordMergeFromIntent` needs, built once from the same
 * factory `/repair` uses (`recordFromIntentDepsFor` in routes.ts) rather than a
 * second hand-rolled copy. Reads come from `GITHUB_READS`, the same GitHub
 * conversation `settleReconciliation` already has above; signing reuses the
 * queue's own service key; evidence and the queue transaction reuse
 * `storeEvidence` and `runOnQueue`, the same ones every mutating route goes
 * through.
 */
const RECORD_FROM_INTENT_DEPS: RecordFromIntentDeps<QueueRouteEnv> = recordFromIntentDepsFor(
  {
    async commitFacts(env, repositoryId, sha) {
      const facts = await GITHUB_READS.commitFacts(env, repositoryId, sha);
      return facts === null ? null : { treeOid: facts.treeOid, parentShas: [...facts.parentShas] };
    },
    baseContainsSha: GITHUB_READS.baseContainsSha,
    async activePolicy(env, repositoryId) {
      return readActivePolicy(env.DB as unknown as D1Like, repositoryId);
    },
    async signRecordBytes(env, bytes, typ) {
      const { key, kid } = await serviceKey(env as unknown as Env);
      return new CompactSign(bytes).setProtectedHeader({ alg: "ES256", kid, typ }).sign(key);
    },
  },
  runOnQueue,
);

/**
 * Move every queue's clock forward on a timer.
 *
 * Deadlines are advanced inside a queue transaction, so before this existed an
 * expired offer went unnoticed until unrelated traffic happened to arrive. On a
 * quiet repository that is indefinitely: the lane sits held by an offer nobody
 * can take, and the pull request behind it waits forever.
 *
 * Advancing the clock is only half of that. `runAlarm()` alone can clear a
 * cooldown or expire a stale offer, but it never asks the scheduler to hand the
 * freed lane to a Ready entry — that also has to be settled here, the same way
 * `runOnQueue` settles it after every command (routes.ts), or a queue that
 * comes off cooldown between two pieces of unrelated traffic sits frozen with
 * a free lane and work waiting.
 *
 * It also ends a reconciliation nothing else can end. An attempt whose merge
 * outcome is in doubt refuses every deadline-driven outcome the alarm knows, so
 * it sat holding the lane while this cron fired and fired; `deadlines.ts` reads
 * GitHub for it and settles it whichever way the reads come out.
 *
 * Deliberately cheap. One row read per queue, a write only when the clock
 * actually changed something, a dispatch only when a lane is held, and GitHub is
 * read only for a queue that has an overdue reconciliation waiting.
 */
export interface TickPorts {
  driveTurn(repositoryId: string, pullRequestNumber: number): Promise<void>;
  onQueueTicked(repositoryId: string): void;
  onQueueFailed(repositoryId: string, error: unknown): void;
}

export async function tickAllQueues(
  env: QueueRouteEnv,
  ports: TickPorts,
  /**
   * How the sweep reads GitHub to settle a merge outcome nobody could confirm.
   * Defaulted rather than injected from the Worker's entry point: a queue that
   * only recovers once somebody remembers to pass a port stays wedged.
   */
  reads: ReconciliationReads = GITHUB_READS,
  /**
   * How the sweep settles a write the workflow walked away from. Defaulted for
   * the same reason `reads` is: nothing about recovering an orphaned write
   * should depend on somebody remembering to wire it up.
   */
  recordDeps: RecordFromIntentDeps<QueueRouteEnv> = RECORD_FROM_INTENT_DEPS,
): Promise<{ ticked: number; driven: number; failed: number; reconciled: number; settledWrites: number }> {
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
  let reconciled = 0;
  let settledWrites = 0;
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
      const swept = await withQueueState(db, row.repositoryId, row.baseRef, async (store) => {
        const commands = commandsFor(
          store,
          undefined,
          queueDecisionRecorder({
            db,
            bucket: env.EVIDENCE as unknown as R2Like | undefined,
            repositoryId: row.repositoryId,
          }),
        );
        await commands.runAlarm();

        // A runner that stopped heartbeating loses eligibility, never its
        // fairness ordinal: it must not block a Ready entry behind it, and it
        // must not lose its place when the runner comes back.
        //
        // A finished entry is skipped. Cancelling leaves eligibility as it was,
        // so this sweep would otherwise write a blocking reason onto an entry
        // that can never run again — the same going-around-the-reducer the
        // heartbeat route did from the other direction.
        if (offlinePrincipals.length > 0) {
          for (const entry of buildSnapshot(store).entries) {
            if (TERMINAL_ENTRY_STATES.includes(entry.state as (typeof TERMINAL_ENTRY_STATES)[number])) continue;
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

        // If the lane is free after the above, offer it before answering —
        // the same settling `runOnQueue` does after every command (routes.ts).
        // Without this, `runAlarm()` advances an expired cooldown or offer but
        // never asks the scheduler to hand the lane to whatever is Ready now,
        // so a queue that comes off cooldown between two pieces of unrelated
        // traffic sits frozen with a free lane and work waiting — exactly what
        // the heartbeat exists to prevent. Cheap to do unconditionally: the
        // scheduler refuses while the lane is busy or the queue is paused, and
        // a tick that offers nothing writes no event.
        if (store.state().activeAttemptId === null) {
          await commands.tick({ idempotencyKey: `settle:${store.generation()}` });
        }
        // Named inside the transaction the tick already runs, so discovering the
        // usual nothing costs no extra read. GitHub is only consulted for a
        // queue that really has an attempt stuck reconciling.
        return { snapshot: buildSnapshot(store), overdue: overdueReconciliation(store.state(), now) };
      });
      ticked += 1;
      ports.onQueueTicked(row.repositoryId);

      // `runAlarm()` has no answer for a merge outcome in doubt. Its only
      // outcome for an overrun turn is `EXPIRED_EXECUTION`, and the reducer
      // refuses that while the outcome is unknown, so every sweep rejected its
      // own command, cleared the deadline row and left the lane exactly where it
      // found it. That is how one indeterminate merge held a whole queue for
      // twenty minutes while this cron fired four times. Reading GitHub is the
      // only thing that can end it, and it happens outside the transaction above
      // because it takes seconds.
      let snapshot = swept.snapshot;
      if (swept.overdue !== null) {
        const settled = await settleReconciliation(env, row.repositoryId, row.baseRef, swept.overdue, reads);
        snapshot = settled.snapshot;
        reconciled += 1;
        // Said out loud, on the channel this account watches. A person used to
        // do this by hand and knew they had done it; something doing it for them
        // silently is worse than the wedge it replaces.
        console.log(
          `[queue heartbeat] settled overdue reconciliation for repository ${row.repositoryId}: ` +
            `attempt ${settled.outcome.attemptId} ${settled.outcome.settled}`,
        );
      }

      // Only a held lane needs driving. Dispatching for an idle queue would
      // spend a CI run to be told there is nothing to do — and under `fresh`
      // or `audited` there is no Actions fallback for the run, so a lane still
      // being run on a device is not this tick's to drive; the connected device
      // claims it itself, over the heartbeat response (plan.md §5.0).
      //
      // Past the run, it is. `Verifying` and `MergeGuard` mean the device's
      // receipt is in and the merge write is still Actions' job, and the only
      // thing that ever asked for it was one fire-and-forget dispatch from the
      // receipt route. A dispatch GitHub dropped, or a run that answered before
      // some other fact settled, left the attempt in `RECEIPT_SUBMITTED` with
      // the lane held until its execution deadline and nothing willing to ask
      // again. This is the asking again. It is the same split `driveLane` makes
      // in routes.ts, and it costs a run only while an attempt really is
      // waiting to be merged.
      const running = snapshot.entries.find((e) => e.state === "Offered" || e.state === "Active");
      const ran = snapshot.entries.find((e) => e.state === "Verifying" || e.state === "MergeGuard");
      const holder = deviceOnly ? (running === undefined ? ran : undefined) : (running ?? ran);
      if (holder !== undefined) {
        await ports.driveTurn(row.repositoryId, holder.pullRequestNumber);
        driven += 1;
      }

      // A write the workflow walked away from is nobody's job until it is this
      // one's. `settleReconciliation` above needs a surviving attempt; these
      // rows outlive every attempt, which is why four merges sat unrecorded.
      //
      // Last, after the lane has been driven. Settling a write reads GitHub
      // several times and writes the chain, and both can throw: `withQueueState`
      // gives up after five lost compare-and-swaps and `recordMergeFromIntent`
      // raises whatever the signer or the evidence store raises. Standing ahead
      // of the drive, one queue with a write it could not settle would stop that
      // queue's turns from ever being driven, which is a worse failure than the
      // one the sweep repairs.
      settledWrites += await sweepOrphanedWrites(env, db, row, reads, recordDeps);
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
  return { ticked, driven, failed, reconciled, settledWrites };
}

/**
 * Settle the merge writes on one queue that nobody ever closed, and say how many
 * actually settled.
 *
 * Counting the ones examined instead would report a repair on every tick for a
 * row that keeps coming back unknown, which is the opposite of what the number
 * is read for.
 */
async function sweepOrphanedWrites(
  env: QueueRouteEnv,
  db: D1Like,
  row: { repositoryId: string; baseRef: string },
  reads: ReconciliationReads,
  recordDeps: RecordFromIntentDeps<QueueRouteEnv>,
): Promise<number> {
  const cutoff = new Date(Date.now() - ORPHANED_WRITE_GRACE_MS).toISOString();
  const orphaned = await withQueueState(db, row.repositoryId, row.baseRef, async (store) =>
    store.unresolvedMergeOperations(cutoff),
  );

  let settled = 0;
  // Oldest first, so a backlog clears the longest-stranded merge first and the
  // cap never starves one row.
  for (const write of orphaned.slice(0, ORPHANED_WRITE_SWEEP_LIMIT)) {
    const outcome = await settleOrphanedWrite(write, {
      pullRequestNumbersForHead: () =>
        reads.pullRequestNumbersForCommit(env, row.repositoryId, write.expectedHeadSha),
      readMergeState: (pullRequestNumber) =>
        reads.pullRequestMergeState(env, row.repositoryId, pullRequestNumber),
      baseContainsHead: () => reads.baseContainsSha(env, row.repositoryId, row.baseRef, write.expectedHeadSha),
      recordMerge: (mergeSha) =>
        recordMergeFromIntent(env, recordDeps, {
          repositoryId: row.repositoryId,
          baseRef: row.baseRef,
          mergeSha,
          // Display only. It names who is speaking for this record in the
          // evidence a reader sees, and nothing authenticates against it: the
          // record's authority comes from the merge intent the queue already
          // signed and from the commit read back out of git, neither of which
          // this string touches. No principal row is claimed for it, because the
          // sweep is the Worker's own clock rather than any person or device.
          witnessPrincipalId: "queue",
          attemptId: write.attemptId,
        }),
      resolve: (operationId, resolvedAs) =>
        withQueueState(db, row.repositoryId, row.baseRef, async (store) =>
          store.resolveMergeOperation(operationId, resolvedAs, new Date().toISOString()),
        ),
      ...(reads.sleep === undefined ? {} : { sleep: reads.sleep }),
    });
    if (outcome.settled !== "unknown") settled += 1;
    // Said out loud on the channel this account watches. Something repairing
    // the chain silently is worse than the gap it closes.
    console.log(
      `[queue heartbeat] settled orphaned merge write ${write.operationId} for repository ` +
        `${row.repositoryId}: ${outcome.settled}`,
    );
  }
  return settled;
}
