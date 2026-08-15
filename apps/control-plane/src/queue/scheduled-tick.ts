// apps/control-plane/src/queue/scheduled-tick.ts
import { CompactSign } from "jose";
import { reconciliationAtDeadline, TERMINAL_ENTRY_STATES } from "@thwip/queue-domain";
import { commandsFor, buildSnapshot, type QueueSnapshot } from "./queue-operations.js";
import { queueDecisionRecorder, type R2Like } from "./evidence-store.js";
import { withQueueState } from "./queue-state.js";
import { requiresDeviceOnly, retireStaleRunners } from "./runners.js";
import { overdueReconciliation } from "@thwip/queue-domain";
import {
  GITHUB_READS,
  settleReconciliation,
  type ReconciliationReads,
  type TerminalPullRequestReads,
} from "./deadlines.js";
import type { D1Like } from "./projection.js";
import { recordFromIntentDepsFor, runOnQueue, type QueueRouteEnv } from "./routes.js";
import { readActivePolicy } from "../active-policy.js";
import { serviceKey } from "../service-signing.js";
import type { Env } from "../env.js";
import {
  MERGED_WITHOUT_RECORD_WINDOW_MS,
  ORPHANED_WRITE_GRACE_MS,
  ORPHANED_WRITE_SWEEP_LIMIT,
  retryAfter,
  settleOrphanedWrite,
} from "./orphaned-writes.js";
import { durableMergeRecordForPullRequestNumber, durableTransitionForAttemptId } from "./attestation.js";
import { recordMergeFromIntent, type RecordFromIntentDeps } from "./record-from-intent.js";
import { findingsForChain } from "./chain-self-check.js";
import type { CommentBudget } from "./status-comment-write.js";
import { reconcileTerminalEntries } from "./terminal-reconciliation.js";
import { acquireProjectWriteLease, repositoryAllowsExternalWrite } from "../project-lifecycle.js";

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
      return facts === null
        ? null
        : { treeOid: facts.treeOid, parentShas: [...facts.parentShas], message: facts.message };
    },
    baseContainsSha: GITHUB_READS.baseContainsSha,
    pullRequestMergeState: GITHUB_READS.pullRequestMergeState,
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
 * actually changed something, an App continuation only when a lane is held, and GitHub is
 * read only for a queue that has an overdue reconciliation waiting.
 */
export interface TickPorts {
  /**
   * How many queues may run the non-clock maintenance pass in one invocation.
   *
   * Clock advancement and lane driving always visit every enabled queue. The
   * maintenance pass reads merge history, refreshes comments/readiness and
   * verifies signed chains; doing that for the whole fleet before moving to the
   * next queue let one busy repository exhaust the Worker's CPU budget and
   * prevented later queues from receiving their heartbeat at all.
   *
   * Omit in focused callers and tests to maintain every queue. Production sets
   * this to one and rotates the selected queue every five-minute firing.
   */
  maintenanceQueuesPerTick?: number;
  driveQueue(repositoryId: string, baseRef: string): Promise<void>;
  onQueueTicked(repositoryId: string): void;
  onQueueFailed(repositoryId: string, error: unknown): void;
  /**
   * Re-read a head from GitHub and run the readiness derivation again, which is
   * `reconsiderHead` — the same walk the `pull_request` delivery makes and the
   * same one the App calls when it finishes verifying a proof. Answers how many
   * pull requests it walked.
   *
   * A port rather than a default, because the walk needs the installation token
   * and the whole `AuthorizeTurnDeps` object the Worker builds, and importing
   * that here would close a cycle. Required rather than optional for the reason
   * every other required field in this file is required: an optional port
   * nobody wires is a repair that silently never runs.
   */
  reconsiderHead(repositoryId: string, headSha: string): Promise<number>;
  /**
   * Bring the status comment on every pull request in one queue back in step
   * with the queue.
   *
   * Comments are written on transition, which is what keeps them cheap, and a
   * transition whose write GitHub refused leaves the page behind the queue with
   * nothing that owns coming back for it. That is the defect family this
   * repository keeps producing, arriving through a surface rather than through
   * the queue, and this sweep is what closes it.
   *
   * Costing nothing is the publisher's job, not this one's. Each comment
   * carries a fingerprint of what it says, so a queue where nothing moved is
   * one D1 read per entry and no GitHub call.
   *
   * Required rather than optional, for the reason every other port here is: an
   * optional port nobody wires is a repair that silently never runs.
   */
  publishStatusComments(
    repositoryId: string,
    baseRef: string,
    snapshot: QueueSnapshot,
    budget: CommentBudget,
  ): Promise<void>;
  /**
   * Say, on the pull requests thwip commented on, that it has stopped managing
   * this branch.
   *
   * Only reached for a branch the sweep below has already found no enabled
   * queue for, so it writes only where it has written before.
   */
  retireStatusComments(
    repositoryId: string,
    baseRef: string,
    pullRequestNumbers: readonly number[],
  ): Promise<void>;
}

/**
 * Blocking reasons GitHub is the source of, so a re-read of the pull request
 * can change the answer.
 *
 * A review nobody has given is not on this list. Re-reading the pull request
 * tells the queue nothing it does not already hold about that, and every read
 * on this sweep is spent against a daily quota this account has exhausted once.
 */
const READINESS_FROM_GITHUB = ["PR_DRAFT", "PR_CLOSED"] as const;

/**
 * How many blocked entries one queue may have re-read on one tick.
 *
 * The cron fires every five minutes for every enabled queue, so an unbounded
 * count here would multiply the fleet by its backlog. Three clears a normal
 * queue in one pass and a stuck one within a quarter of an hour.
 */
const READINESS_RECHECK_LIMIT = 3;

/**
 * How many status comments the whole sweep may write, across every queue.
 *
 * Four, because each costs up to two subrequests and the invocation's fifty are
 * shared with everything else the tick does.
 */
const COMMENT_WRITES_PER_TICK = 4;

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
  /** Full PR state for the bounded missed-webhook repair. */
  terminalReads: TerminalPullRequestReads = GITHUB_READS,
): Promise<{
  ticked: number;
  driven: number;
  failed: number;
  reconciled: number;
  settledWrites: number;
  readinessRechecked: number;
  chainFindings: number;
  retiredComments: number;
  terminalEntriesExamined: number;
  terminalEntriesReconciled: number;
}> {
  const db = env.DB as unknown as D1Like;
  const rows = await db
    .prepare(
      "SELECT github_repository_id AS repositoryId, base_ref AS baseRef, attested_from_sequence AS epochStartsAt, project_id AS projectId " +
        "FROM queue_projects WHERE enabled = 1 ORDER BY github_repository_id, base_ref",
    )
    .bind()
    .all<{ repositoryId: string; baseRef: string; epochStartsAt: number; projectId: string | null }>();

  const now = new Date().toISOString();
  // Retire stale runners once per repository, not once per queue: the table is
  // keyed on repository and principal, not on a base ref, and a repository can
  // queue more than one branch. Cached per repository, inside each row's own
  // try block, so a repository whose retirement read fails only fails that
  // repository's queues, the same as any other per-queue failure below.
  const offlinePrincipalsByRepo = new Map<string, readonly string[]>();
  const deviceOnlyByRepo = new Map<string, boolean>();

  // One budget for the whole sweep, not one per queue.
  //
  // A Worker invocation gets fifty subrequests and this sweep shares them with
  // every merge write it settles, every lane it drives and every installation
  // token it mints, across the whole fleet. A per-queue allowance multiplied by
  // the fleet can exhaust an invocation before either queue finishes.
  //
  // Small on purpose. A comment that has not changed costs nothing and is not
  // counted, so this only ever bounds a genuine backlog, and a backlog drains
  // over a handful of ticks rather than costing every one of them.
  const commentBudget: CommentBudget = { remaining: COMMENT_WRITES_PER_TICK };

  let ticked = 0;
  let driven = 0;
  let failed = 0;
  let reconciled = 0;
  let settledWrites = 0;
  let readinessRechecked = 0;
  let chainFindings = 0;
  let terminalEntriesExamined = 0;
  let terminalEntriesReconciled = 0;
  const sweptQueues: Array<{ row: (typeof rows.results)[number]; snapshot: QueueSnapshot }> = [];
  for (const row of rows.results) {
    const lifecycleLease =
      row.projectId === null ? null : await acquireProjectWriteLease(db, row.repositoryId, row.projectId);
    try {
      if (lifecycleLease === null) throw new Error(`repository ${row.repositoryId} project is unavailable`);
      await lifecycleLease.renew();
      let offlinePrincipals = offlinePrincipalsByRepo.get(row.repositoryId);
      if (offlinePrincipals === undefined) {
        offlinePrincipals = await retireStaleRunners(db, row.repositoryId, now, lifecycleLease.projectId);
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
            projectId: lifecycleLease.projectId,
            beforeWrite: async () => {
              await lifecycleLease.renew();
              return repositoryAllowsExternalWrite(db, row.repositoryId, lifecycleLease.projectId);
            },
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
        // Runner presence is an execution requirement only for `fresh` and
        // `audited`. `fast` and `remote` deliberately do not heartbeat: their
        // turns run on the server or protected workflow. Applying a stale
        // device row to those profiles marks every entry AGENT_OFFLINE with no
        // client capable of clearing it.
        if (deviceOnly && offlinePrincipals.length > 0) {
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
        const mergeConfirm = store
          .dueDeadlines(now)
          .find((deadline) => deadline.kind === "merge-confirm" && deadline.attemptId === store.state().activeAttemptId);
        const reconciliation =
          mergeConfirm === undefined
            ? overdueReconciliation(store.state(), now)
            : reconciliationAtDeadline(store.state(), now, {
                attemptId: mergeConfirm.attemptId,
                dueAt: mergeConfirm.dueAt,
                trigger: "merge-confirm",
              });
        return { snapshot: buildSnapshot(store), reconciliation };
      });
      ticked += 1;
      ports.onQueueTicked(row.repositoryId);

      // `runAlarm()` preserves a due merge-confirm row but does not answer it:
      // the deadline knows only that a read is due, never whether the write
      // landed. Older documents may have lost that row, so the execution
      // deadline remains a fallback. Reading GitHub is the only thing that can
      // end either case, and it happens outside the transaction above because it
      // takes seconds.
      let snapshot = swept.snapshot;
      if (swept.reconciliation !== null) {
        const settled = await settleReconciliation(
          env,
          row.repositoryId,
          row.baseRef,
          swept.reconciliation,
          reads,
          lifecycleLease,
        );
        snapshot = settled.snapshot;
        reconciled += 1;
        // Said out loud, on the channel this account watches. A person used to
        // do this by hand and knew they had done it; something doing it for them
        // silently is worse than the wedge it replaces.
        console.log(
          `[queue heartbeat] settled ${swept.reconciliation.trigger} reconciliation for repository ${row.repositoryId}: ` +
            `attempt ${settled.outcome.attemptId} ${settled.outcome.settled}`,
        );
      }

      // Only a held lane needs driving. The App re-reads placement and the
      // active profile before it advances, so an offered device-only turn stays
      // offered while a completed device run can proceed to the merge write.
      const running = snapshot.entries.find((e) => e.state === "Offered" || e.state === "Active");
      const ran = snapshot.entries.find((e) => e.state === "Verifying" || e.state === "MergeGuard");
      const holder = running ?? ran;

      // A lane driver can fail for the exact stale holder the terminal sweep
      // is able to remove. Preserve the authoritative snapshot for maintenance
      // before making that fallible call, or a missed close webhook plus a
      // persistent driver failure excludes this queue from reconciliation
      // forever. The outer catch still reports the driver failure and the
      // second pass still isolates this queue's maintenance from every other
      // queue in the fleet.
      sweptQueues.push({ row, snapshot });
      if (holder !== undefined) {
        await ports.driveQueue(row.repositoryId, row.baseRef);
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
    } finally {
      await lifecycleLease?.release();
    }
  }

  // Maintenance is intentionally a second pass. It is materially more
  // expensive than moving queue clocks: it can perform several GitHub reads,
  // rebuild merge history and verify every signed transition in a branch.
  // Running it inline used to mean the first busy repository could exhaust the
  // Worker's CPU budget before the heartbeat ever reached the second one.
  //
  // Production admits one queue per five-minute slot. The stable ordering and
  // time-derived start rotate fairly without another cursor table or migration;
  // tests and one-off callers omit the limit and retain the exhaustive pass.
  const configuredMaintenanceLimit = ports.maintenanceQueuesPerTick ?? sweptQueues.length;
  const maintenanceLimit = Math.max(0, Math.min(configuredMaintenanceLimit, sweptQueues.length));
  const slot = Math.floor(Date.parse(now) / (5 * 60 * 1_000));
  const start = sweptQueues.length === 0 ? 0 : slot % sweptQueues.length;
  const maintenanceQueues = Array.from(
    { length: maintenanceLimit },
    (_, index) => sweptQueues[(start + index) % sweptQueues.length]!,
  );

  for (const maintained of maintenanceQueues) {
    const { row } = maintained;
    let { snapshot } = maintained;
    const lifecycleLease =
      row.projectId === null ? null : await acquireProjectWriteLease(db, row.repositoryId, row.projectId);
    try {
      if (lifecycleLease === null) throw new Error(`repository ${row.repositoryId} project is unavailable`);
      await lifecycleLease.renew();
      // The webhook is the fast path, not the only path. Walk a persisted page
      // of every nonterminal entry and compare it with GitHub. A merged entry
      // is settled only after its existing signed record is found or the
      // existing signed-intent recovery creates the missing first record.
      // Closed-unmerged entries use the ordinary cancel command. Both mutations
      // therefore share the queue compare-and-swap with webhooks, heartbeats,
      // lane driving and merge callbacks.
      const terminals = await reconcileTerminalEntries(
        env,
        { repositoryId: row.repositoryId, baseRef: row.baseRef },
        terminalReads,
        recordDeps,
        lifecycleLease,
      );
      snapshot = terminals.snapshot;
      terminalEntriesExamined += terminals.examined;
      terminalEntriesReconciled += terminals.reconciled;
      if (terminals.reconciled > 0) {
        console.log(
          `[queue heartbeat] reconciled ${terminals.reconciled} terminal pull request(s) for repository ` +
            `${row.repositoryId} after examining ${terminals.examined}`,
        );
      }

      // Publish the authoritative repair before any later maintenance that can
      // fail. In particular, driving the newly offered lane and recovering an
      // orphaned write both call GitHub. If either exhausts the subrequest
      // budget, the pull request that just became terminal must not keep the
      // status from before the committed queue mutation. This remains safe to
      // retry on every pass because the publisher fingerprints its content.
      try {
        await ports.publishStatusComments(row.repositoryId, row.baseRef, snapshot, commentBudget);
      } catch (error) {
        console.error(
          `[queue heartbeat] could not refresh the status comments on ${row.repositoryId} ${row.baseRef}: ` +
            `${String(error)}`,
        );
      }

      if (terminals.reconciled > 0) {
        // Cancelling a lane holder offers the next turn in the reconciliation
        // transaction. Continue that turn now instead of waiting for another
        // five-minute clock.
        const holder = snapshot.entries.find(
          (entry) =>
            entry.entryId === snapshot.activeEntryId &&
            ["Offered", "Active", "Verifying", "MergeGuard"].includes(entry.state),
        );
        if (holder !== undefined) {
          await ports.driveQueue(row.repositoryId, row.baseRef);
          driven += 1;
        }
      }
      // A write whose response was lost is nobody's job until it is this one's.
      // `settleReconciliation` above needs a surviving attempt; these rows
      // outlive every attempt, so no attempt can be trusted to finish them.
      //
      // The terminal-entry page goes first because an old orphan that exhausts
      // the subrequest budget must not starve the simpler missed-webhook repair.
      // Both stay after the lane-critical fleet pass, so neither can stop the
      // clock or initial drive for another queue.
      settledWrites += await sweepOrphanedWrites(env, db, row, reads, recordDeps, lifecycleLease);

      // Readiness the webhook was supposed to refresh and did not.
      //
      // The projection write after every command is best-effort and its failure
      // is swallowed, so a delivery that could not land its write leaves the row
      // holding the reason it last held. Pull request 56 was marked ready for
      // review on GitHub while the queue kept `PR_DRAFT`, and the dashboard told
      // its author, in the present tense, to do the thing they had already done.
      // Nothing owned coming back for it.
      //
      // This does. It re-reads the head and runs the same derivation the
      // delivery runs, through `reconsiderHead`, so there is one answer to what
      // readiness means and this is not a second opinion about it.
      readinessRechecked += await recheckBlockedReadiness(snapshot, row.repositoryId, ports);

      // The queue reads its own chain here, once per queue per tick, the same
      // way `/v1/queue/:repositoryId/chain` reads it for an outside verifier
      // and the way `thwip verify-chain` checks it from off the network. This
      // catches merges that remain unrecorded: `verifyChain` reports
      // `BASE_DISCONTINUITY` for exactly that shape.
      //
      // Last, after everything that can add or repair a link this tick. A
      // finding is read and reported, never acted on: the sweep above is what
      // repairs a chain, and this is only the queue looking at what it wrote.
      //
      // The key set `findingsForChain` reads is read after `sweepOrphanedWrites`
      // rather than once for the whole tick, and that ordering is why this call
      // sits here. `sweepOrphanedWrites` can call `recordMergeFromIntent`, which
      // signs through `serviceKey()` and inserts a row into `service_keys` the
      // first time this isolate uses that kid, inside the same per-queue pass.
      // A key set taken before that insert would check the record the sweep just
      // signed against a key published after the record was made and report it
      // as `BAD_SIGNATURE`: a false alarm on the exact signal this feature
      // exists to make trustworthy, and one that clears itself on the next tick,
      // which makes it rarer and harder to diagnose rather than less bad.
      const chainCheck = await findingsForChain(db, {
        repositoryId: row.repositoryId,
        baseRef: row.baseRef,
        epochStartsAt: row.epochStartsAt,
      });
      chainFindings += chainCheck.length;
      for (const finding of chainCheck) {
        // Said out loud, on the same channel every other repair on this sweep
        // uses. A gap in the chain that only a log line ever mentions is a gap
        // nobody reads until somebody goes looking for it by hand, which is
        // how the last one went a full day.
        console.error(
          `[queue heartbeat] chain finding for repository ${row.repositoryId}: ` +
            `${finding.code} at ${finding.sequence ?? finding.digest.slice(0, 16)}: ${finding.detail}`,
        );
      }
    } catch (error) {
      // Maintenance failure must be visible, but it does not erase the fact
      // that the lane-critical pass already ticked this queue. Most
      // importantly, it cannot prevent another repository's clock from moving.
      failed += 1;
      ports.onQueueFailed(row.repositoryId, error);
    } finally {
      await lifecycleLease?.release();
    }
  }
  const retiredComments = await retireAbandonedComments(db, ports);
  return {
    ticked,
    driven,
    failed,
    reconciled,
    settledWrites,
    readinessRechecked,
    chainFindings,
    retiredComments,
    terminalEntriesExamined,
    terminalEntriesReconciled,
  };
}

/**
 * Close the comments on branches the queue has stopped managing, and say how
 * many were closed.
 *
 * Outside the loop above, because the loop reads `enabled = 1` and these rows
 * are precisely the ones no longer on that list. A project somebody disabled
 * would otherwise leave a comment frozen on the last state that was true,
 * telling its author they are third in a line nothing tracks any more. Turning
 * the queue off has to leave the page honest, which is a different thing from
 * leaving it alone.
 *
 * The row is dropped whichever way the write went. Keeping it would sweep the
 * same disabled project on every tick forever, and the comment it leaves behind
 * says thwip is not managing this branch, which stays true.
 */
async function retireAbandonedComments(db: D1Like, ports: TickPorts): Promise<number> {
  const abandoned = await db
    .prepare(
      "SELECT c.github_repository_id AS repositoryId, c.project_id AS projectId, c.base_ref AS baseRef, c.pull_request_number AS pullRequestNumber " +
        "FROM queue_status_comments c LEFT JOIN queue_projects q " +
        "ON q.github_repository_id = c.github_repository_id AND q.base_ref = c.base_ref AND q.project_id = c.project_id AND q.enabled = 1 " +
        "WHERE q.id IS NULL",
    )
    .bind()
    .all<{ repositoryId: string; projectId: string; baseRef: string; pullRequestNumber: number }>();
  if (abandoned.results.length === 0) return 0;

  const byBranch = new Map<string, { repositoryId: string; projectId: string; baseRef: string; numbers: number[] }>();
  for (const row of abandoned.results) {
    const key = `${row.projectId} ${row.baseRef}`;
    const branch = byBranch.get(key) ?? {
      repositoryId: row.repositoryId,
      projectId: row.projectId,
      baseRef: row.baseRef,
      numbers: [],
    };
    branch.numbers.push(row.pullRequestNumber);
    byBranch.set(key, branch);
  }

  let retired = 0;
  for (const branch of byBranch.values()) {
    const lifecycleLease = await acquireProjectWriteLease(db, branch.repositoryId, branch.projectId);
    if (lifecycleLease === null) continue;
    try {
      await lifecycleLease.renew();
      await ports.retireStatusComments(branch.repositoryId, branch.baseRef, branch.numbers);
    } catch (error) {
      console.error(
        `[queue heartbeat] could not retire the status comments on ${branch.repositoryId} ${branch.baseRef}: ` +
          `${String(error)}`,
      );
    }
    try {
      await db
        .prepare(
          `DELETE FROM queue_status_comments
            WHERE github_repository_id = ? AND base_ref = ? AND project_id = ?
              AND EXISTS (SELECT 1 FROM projects p WHERE p.id = queue_status_comments.project_id)`,
        )
        .bind(branch.repositoryId, branch.baseRef, branch.projectId)
        .run();
      retired += branch.numbers.length;
      console.log(
        `[queue heartbeat] retired ${branch.numbers.length} status comment(s) on ${branch.repositoryId} ` +
          `${branch.baseRef}, which the queue no longer manages`,
      );
    } finally {
      await lifecycleLease.release();
    }
  }
  return retired;
}

/**
 * Ask GitHub again about the entries this queue is holding back on something
 * GitHub said, and say how many were actually re-read.
 *
 * Bounded twice over: only the reasons a pull-request read can answer, and only
 * `READINESS_RECHECK_LIMIT` of them per queue per tick.
 */
async function recheckBlockedReadiness(
  snapshot: { entries: readonly { state: string; primaryReason: string | null; headSha: string | null }[] },
  repositoryId: string,
  ports: TickPorts,
): Promise<number> {
  const stale = snapshot.entries
    .filter((entry) => !TERMINAL_ENTRY_STATES.includes(entry.state as (typeof TERMINAL_ENTRY_STATES)[number]))
    .filter((entry) => READINESS_FROM_GITHUB.includes(entry.primaryReason as (typeof READINESS_FROM_GITHUB)[number]))
    .filter((entry): entry is typeof entry & { headSha: string } => entry.headSha !== null);

  // One read per head, not per entry: two entries on one commit ask GitHub the
  // same question and `reconsiderHead` already walks every pull request the
  // commit is the head of.
  const heads = [...new Set(stale.map((entry) => entry.headSha))].slice(0, READINESS_RECHECK_LIMIT);

  let rechecked = 0;
  for (const headSha of heads) {
    await ports.reconsiderHead(repositoryId, headSha);
    rechecked += 1;
    console.log(
      `[queue heartbeat] re-read readiness for repository ${repositoryId} at ${headSha.slice(0, 12)}`,
    );
  }
  return rechecked;
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
  lifecycleLease: NonNullable<Awaited<ReturnType<typeof acquireProjectWriteLease>>>,
): Promise<number> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - ORPHANED_WRITE_GRACE_MS).toISOString();
  const since = new Date(Date.now() - MERGED_WITHOUT_RECORD_WINDOW_MS).toISOString();
  // `now` holds back a write the sweep already refused and has not waited out,
  // before anything is read from GitHub about it. A tick with nothing new to
  // settle spends nothing.
  const { open, settledRecently } = await withQueueState(db, row.repositoryId, row.baseRef, async (store) => ({
    open: store.unresolvedMergeOperations(cutoff, now),
    settledRecently: store.mergedWritesResolvedAfter(since, now),
  }), { expectedProjectId: lifecycleLease.projectId, lease: lifecycleLease });

  // A write is finished when the chain has a record for it, not when the row
  // says MERGED. A delayed ancestry read can skip the record after the merge
  // lands, then the resolved row disappears from the unresolved sweep. Asked
  // of the record store rather than of the queue document,
  // because the document keeps only the most recent transitions and an
  // absence there is not an absence.
  const unrecorded: typeof open = [];
  for (const write of settledRecently) {
    const linked =
      write.pullRequestNumber !== null
        ? await durableMergeRecordForPullRequestNumber(db, {
            repositoryId: row.repositoryId,
            baseRef: row.baseRef,
            pullRequestNumber: write.pullRequestNumber,
            projectId: lifecycleLease.projectId,
          })
        : await durableTransitionForAttemptId(db, {
            repositoryId: row.repositoryId,
            baseRef: row.baseRef,
            attemptId: write.attemptId,
            projectId: lifecycleLease.projectId,
          });
    if (linked === null) {
      unrecorded.push(write);
    }
  }
  const orphaned = [...open, ...unrecorded];

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
          reason: `automatic repair of settled merge operation ${write.operationId}`,
          attemptId: write.attemptId,
          writeLease: lifecycleLease,
        }),
      resolve: (operationId, resolvedAs) =>
        withQueueState(
          db,
          row.repositoryId,
          row.baseRef,
          async (store) => store.resolveMergeOperation(operationId, resolvedAs, new Date().toISOString()),
          { expectedProjectId: lifecycleLease.projectId, lease: lifecycleLease },
        ),
      ...(reads.sleep === undefined ? {} : { sleep: reads.sleep }),
    });
    // Said out loud on the channel this account watches. Something repairing
    // the chain silently is worse than the gap it closes.
    //
    // A refusal is written to the row as well as logged. The log scrolls away
    // and the row does not: `/explain` reports the reason, the count and when
    // the sweep will look again, so a write nobody can settle is a thing a
    // person can find rather than a line somebody had to be watching for.
    if (outcome.settled === "unknown") {
      const refusal = await withQueueState(
        db,
        row.repositoryId,
        row.baseRef,
        async (store) =>
          store.refuseMergeOperation(write.operationId, outcome.reason, new Date().toISOString(), retryAfter),
        { expectedProjectId: lifecycleLease.projectId, lease: lifecycleLease },
      );
      console.log(
        `[queue heartbeat] orphaned merge write ${write.operationId} for repository ` +
          `${row.repositoryId} is still unsettled after ${refusal?.count ?? 1} attempt(s): ${outcome.reason}`,
      );
      continue;
    }
    settled += 1;
    console.log(
      `[queue heartbeat] settled orphaned merge write ${write.operationId} for repository ` +
        `${row.repositoryId}: ${outcome.settled}`,
    );
  }
  return settled;
}
