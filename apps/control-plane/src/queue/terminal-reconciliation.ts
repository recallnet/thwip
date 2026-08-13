import { TERMINAL_ENTRY_STATES } from "@thwip/queue-domain";
import { recoverExactMergeRecord } from "./attestation.js";
import type { TerminalPullRequestReads } from "./deadlines.js";
import type { QueueSnapshot } from "./queue-operations.js";
import { loadQueueState, withQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";
import { recordMergeFromIntent, type RecordFromIntentDeps } from "./record-from-intent.js";
import { runOnQueue, type QueueRouteEnv } from "./routes.js";
import { projectAuthoritativeQueue } from "./queue-projection.js";
import { TERMINAL_RECONCILIATION_CANCEL_REASON } from "./terminal-comment-priority.js";

/**
 * Three GitHub reads per selected queue keeps this pass below the same bounded
 * maintenance budget as readiness reconciliation. A cursor in the authoritative
 * document makes the bound a page rather than a permanent preference for the
 * first three entries.
 */
export const TERMINAL_RECONCILIATION_PAGE_SIZE = 3;
/** Shorter than the five-minute cron, so a crashed claim cannot skip a tick. */
const TERMINAL_RECONCILIATION_LEASE_MS = 4 * 60 * 1_000;

interface PageEntry {
  readonly entryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  /** A live merge attempt owns recovery until its ordinary callback settles. */
  readonly currentAttemptId: string | null;
  /** Identifies this admission, including a close-and-reopen of the same PR. */
  readonly fairnessOrdinal: string;
}

type PullState = Awaited<ReturnType<TerminalPullRequestReads["pullRequestState"]>>;

interface Observation {
  readonly entry: PageEntry;
  readonly pull: PullState;
  readonly record: {
    readonly attemptId: string;
    readonly digest: string;
    readonly transitionSequence: number;
  } | null;
}

export interface TerminalReconciliationResult {
  readonly snapshot: QueueSnapshot;
  /** Entries whose authoritative state actually became terminal in this pass. */
  readonly reconciled: number;
  /** Pull requests read from GitHub, including open and unreadable ones. */
  readonly examined: number;
}

function nonterminal(state: string): boolean {
  return !(TERMINAL_ENTRY_STATES as readonly string[]).includes(state);
}

/** Select the page after the persisted ordinal, wrapping at the end. */
async function page(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<{
  entries: PageEntry[];
  nextCursor: string | null;
  position: {
    cursor: string | null;
    pass: number;
    lease: { pass: number; until: string } | null;
  };
}> {
  const { store } = await loadQueueState(db, repositoryId, baseRef);
  const entries = [...store.state().entries.values()]
    .filter((entry) => nonterminal(entry.state))
    .sort((left, right) => (left.fairnessOrdinal < right.fairnessOrdinal ? -1 : 1));
  const position = store.terminalReconciliationPosition();
  if (entries.length === 0) return { entries: [], nextCursor: null, position };

  const cursor = position.cursor;
  const after =
    cursor === null ? entries : entries.filter((entry) => entry.fairnessOrdinal > BigInt(cursor));
  const selected = (after.length === 0 ? entries : after).slice(0, TERMINAL_RECONCILIATION_PAGE_SIZE);
  return {
    entries: selected.map((entry) => ({
      entryId: entry.entryId,
      pullRequestNumber: entry.pullRequestNumber,
      headSha: entry.headSha,
      currentAttemptId: entry.currentAttemptId,
      fairnessOrdinal: entry.fairnessOrdinal.toString(),
    })),
    nextCursor: selected.at(-1)?.fairnessOrdinal.toString() ?? null,
    position,
  };
}

/**
 * Reconcile one bounded page of every kind of nonterminal entry against GitHub.
 *
 * Reads and signing stay outside the queue compare-and-swap. The final write
 * rechecks the entry's head and fairness ordinal, so a concurrent synchronize
 * or close-and-reopen wins instead of having an older read cancel the new
 * admission. The command transaction is the same one webhooks, heartbeats and
 * merge callbacks use.
 */
export async function reconcileTerminalEntries<TEnv extends QueueRouteEnv>(
  env: TEnv,
  input: { repositoryId: string; baseRef: string },
  reads: TerminalPullRequestReads,
  recordDeps: RecordFromIntentDeps<TEnv>,
): Promise<TerminalReconciliationResult> {
  const db = env.DB as unknown as D1Like;
  const selected = await page(db, input.repositoryId, input.baseRef);
  if (selected.entries.length === 0) {
    // The previous pass may have committed its last terminal mutation while
    // the best-effort projection write failed. Empty is therefore still work:
    // republish authority instead of returning before the stale dashboard gets
    // another chance to catch up.
    const snapshot = await projectAuthoritativeQueue(db, input.repositoryId, input.baseRef);
    return { snapshot, reconciled: 0, examined: 0 };
  }

  // Claim the page before making external reads or signing. The cursor alone
  // cannot be the claim: a one-entry walk wraps to the same ordinal. The pass
  // changes on every claim, and the queue compare-and-swap lets one overlapping
  // heartbeat win. A crashed claim is not a lease that can wedge the queue; the
  // walk comes back to this page after the other bounded pages (or next tick
  // when it is the only page).
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.parse(now) + TERMINAL_RECONCILIATION_LEASE_MS).toISOString();
  const claim = await withQueueState(db, input.repositoryId, input.baseRef, (store) => {
    const current = store.terminalReconciliationPosition();
    if (current.cursor !== selected.position.cursor || current.pass !== selected.position.pass) return false;
    if (current.lease !== null && current.lease.until > now) return false;
    return store.claimTerminalReconciliation(selected.nextCursor!, leaseUntil);
  });
  if (claim === false) {
    const snapshot = await projectAuthoritativeQueue(db, input.repositoryId, input.baseRef);
    return { snapshot, reconciled: 0, examined: 0 };
  }

  try {
    // Exact-record lookup reads the durable transition projection. Repair it
    // from queue_state authority before concluding that a merged PR needs any
    // new signed bytes.
    await projectAuthoritativeQueue(db, input.repositoryId, input.baseRef);
    const observations: Observation[] = [];
    for (const entry of selected.entries) {
      let pull: PullState = null;
      try {
        pull = await reads.pullRequestState(env, input.repositoryId, entry.pullRequestNumber);
      } catch (error) {
        console.error(
          `[queue heartbeat] could not read pull request ${entry.pullRequestNumber} of repository ` +
            `${input.repositoryId} for terminal reconciliation: ${String(error)}`,
        );
      }

      let record: Observation["record"] = null;
      if (pull?.merged === true && pull.mergeCommitSha !== null) {
        const existing = await recoverExactMergeRecord(db, {
          repositoryId: input.repositoryId,
          baseRef: input.baseRef,
          pullRequestNumber: entry.pullRequestNumber,
          mergeSha: pull.mergeCommitSha,
        });
        record = existing?.status === "linked" ? existing : null;

        // A missing record is recovered only through the signed intent path. It
        // validates the exact commit, authorization and GitHub PR association;
        // a merged flag by itself never becomes a signed queue claim. A live
        // attempt keeps ownership: its merge callback or outcome heartbeat may
        // be writing the first record now, and racing that signer is precisely
        // how a single merge gets two signed records.
        if (record === null && entry.currentAttemptId === null) {
          const repaired = await recordMergeFromIntent(env, recordDeps, {
            repositoryId: input.repositoryId,
            baseRef: input.baseRef,
            mergeSha: pull.mergeCommitSha,
            witnessPrincipalId: "queue",
            reason: `automatic terminal reconciliation for pull request ${entry.pullRequestNumber}`,
          });
          if (repaired.status === "refused") {
            console.error(
              `[queue heartbeat] pull request ${entry.pullRequestNumber} of repository ${input.repositoryId} ` +
                `is merged but its signed record could not be recovered: ${repaired.detail}`,
            );
          }
          const recovered = await recoverExactMergeRecord(db, {
            repositoryId: input.repositoryId,
            baseRef: input.baseRef,
            pullRequestNumber: entry.pullRequestNumber,
            mergeSha: pull.mergeCommitSha,
          });
          record = recovered?.status === "linked" ? recovered : null;
        }
      }
      observations.push({ entry, pull, record });
    }

    const out = await runOnQueue(env, input.repositoryId, input.baseRef, ({ store, commands }) => {
      let reconciled = 0;
      for (const observation of observations) {
        const current = store.state().entries.get(observation.entry.entryId);
        if (
          current === undefined ||
          !nonterminal(current.state) ||
          current.headSha !== observation.entry.headSha ||
          current.fairnessOrdinal.toString() !== observation.entry.fairnessOrdinal
        ) {
          continue;
        }

        if (observation.pull?.merged === true && observation.pull.mergeCommitSha !== null) {
          if (observation.record === null) continue;
          const result = commands.reconcileMerged({
            idempotencyKey: `reconcile:merged:${current.entryId}:${observation.record.digest}`,
            entryId: current.entryId,
            attemptId: observation.record.attemptId,
            mergeSha: observation.pull.mergeCommitSha,
            transitionDigest: observation.record.digest,
            transitionSequence: observation.record.transitionSequence,
          });
          if (result.status === "applied") reconciled += 1;
          continue;
        }

        if (observation.pull?.state === "closed" && observation.pull.merged === false) {
          const result = commands.cancel({
            idempotencyKey: `reconcile:closed:${current.entryId}:${observation.pull.headSha}`,
            entryId: current.entryId,
            actorPrincipalId: "github",
            reason: TERMINAL_RECONCILIATION_CANCEL_REASON,
          });
          if (result.status === "applied") reconciled += 1;
        }
      }
      return reconciled;
    });

    // `runOnQueue` projects best-effort because an API command must not fail
    // after authority commits. A heartbeat is the retry owner, so this second
    // publication is deliberately fallible: maintenance reports the failure
    // and the next pass, including an empty one, tries the same generation.
    const snapshot = await projectAuthoritativeQueue(db, input.repositoryId, input.baseRef);
    return { snapshot, reconciled: out.result, examined: observations.length };
  } finally {
    await withQueueState(db, input.repositoryId, input.baseRef, (store) => {
      store.releaseTerminalReconciliation(claim);
    });
  }
}
