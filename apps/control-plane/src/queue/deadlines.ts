import type { OverdueReconciliation } from "@thwip/queue-domain";
import { installationToken } from "../github-app.js";
import type { Env } from "../env.js";
import { confirmMergeAbsence } from "./merge-absence.js";
import { mergeOperationId } from "./merge-commit.js";
import type { DecisionRecorder } from "./commands.js";
import { queueDecisionRecorder, type R2Like } from "./evidence-store.js";
import { buildSnapshot, commandsFor, type QueueSnapshot } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";
import type { QueueRouteEnv } from "./routes.js";

/**
 * Ending a reconciliation the queue can no longer wait on.
 *
 * `Reconciling` is where an attempt goes when the queue cannot tell whether its
 * merge landed. It reads and never writes again, and that patience is correct:
 * four merges left the chain because a single stale read was turned into a
 * durable negative. What was missing is an end to it. Attempt `att_2dc5e37e`
 * held the lane for more than twenty minutes past its execution deadline, the
 * five-minute cron resolved nothing on every pass, `POST /tick` was a no-op
 * because the wedged attempt held the lane, and pull request 115 waited behind
 * it until an operator ran `POST /reconcile` by hand.
 *
 * The alarm cannot end it. Its answer for an overrun turn is
 * `EXPIRED_EXECUTION`, and the reducer refuses that outcome while a merge
 * outcome is in doubt, correctly: a deadline says a run took too long and knows
 * nothing about whether a merge landed. So the deadline is the trigger and
 * `confirmMergeAbsence` is the answer. Three reads, corroborated against git
 * ancestry, and only then a command.
 *
 * All three verdicts free the lane.
 *
 * `merged` confirms the merge from the commit itself. The reducer refuses any
 * tree that is not the candidate it authorized, so a wrong commit cannot certify
 * anything, and the entry becomes Merged because it is.
 *
 * `not-merged` is the day's actual truth: the pull request was open and
 * unmerged. The entry is Deferred with a cooldown and keeps its place, exactly
 * as a merge GitHub refuses does.
 *
 * `unknown` is the one worth arguing about. The queue still cannot say what
 * became of the write, and it must not guess. Guessing is the failure the whole
 * confirmation rule exists to prevent. It ends the attempt `PROVIDER_FAILURE`,
 * which blocks the entry `MERGE_OUTCOME_UNKNOWN` and hands the lane back. That
 * is not a second write: the write in doubt belongs to this attempt and this
 * pull request, the attempt is over, and the scheduler offers turns to Ready
 * entries and to Deferred ones serving a cooldown, so a Blocked entry is not
 * handed another turn by any sweep. The merge operation row still records that a
 * write was sent, so a re-entry reads instead of sending. Everything behind it in the
 * queue is unrelated work that was never in doubt, and each of those turns pins
 * its own candidate against the base it reads at the time and re-checks it in
 * the final guard immediately before its own write. Holding the entire queue for
 * one indeterminate merge buys nothing and costs everybody.
 *
 * What an operator sees: the entry stops in Blocked with MERGE_OUTCOME_UNKNOWN,
 * its check says the merge result could not be determined, and the queue keeps
 * moving. If the merge did land, `POST /v1/queue/:repositoryId/records` writes
 * the chain link from the signed intent and a commit sha, which is the repair
 * built for exactly this and needs nothing from the attempt.
 */

/** What the sweep may read to settle a merge it cannot see the end of. */
export interface ReconciliationReads {
  /** What the pull request says about itself, or null when it could not be read. */
  pullRequestMergeState(
    env: QueueRouteEnv,
    repositoryId: string,
    pullRequestNumber: number,
  ): Promise<{ merged: boolean; mergeCommitSha: string | null } | null>;
  /** Whether the base branch already contains a commit, from git ancestry. */
  baseContainsSha(
    env: QueueRouteEnv,
    repositoryId: string,
    baseRef: string,
    sha: string,
  ): Promise<boolean | null>;
  /**
   * The pull requests GitHub associates with a commit, or null when the read
   * failed. An empty array is an answer: the commit belongs to no pull request.
   *
   * A merge write written before `merge_operations` carried a pull request
   * number has nothing on the row that names one, and the attempt that used to
   * is long gone. The head commit is what survives, so it is what gets asked
   * about.
   */
  pullRequestNumbersForCommit(
    env: QueueRouteEnv,
    repositoryId: string,
    sha: string,
  ): Promise<readonly number[] | null>;
  /** The tree, parents and message of a commit, so confirmation cites the exact object. */
  commitFacts(
    env: QueueRouteEnv,
    repositoryId: string,
    sha: string,
  ): Promise<{ treeOid: string; parentShas: readonly string[]; message: string } | null>;
  /** The backoff between reads. Overridden in tests so they do not wait it out. */
  sleep?(ms: number): Promise<void>;
}

export type ReconciliationOutcome =
  | { readonly settled: "merged"; readonly attemptId: string; readonly mergeSha: string }
  | { readonly settled: "not-merged"; readonly attemptId: string; readonly reason: string }
  | { readonly settled: "unknown"; readonly attemptId: string; readonly reason: string };

export interface SettledReconciliation {
  readonly outcome: ReconciliationOutcome;
  /** The queue as it stands afterwards, so a caller can drive the lane it freed. */
  readonly snapshot: QueueSnapshot;
}

async function repositoryOf(
  env: QueueRouteEnv,
  repositoryId: string,
): Promise<{ name: string; installationId: string } | null> {
  const project = await env.DB.prepare(
    "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
  )
    .bind(repositoryId)
    .first<{ github_name: string; installation_id: string | null }>();
  if (project === null || project.installation_id === null) return null;
  return { name: project.github_name, installationId: project.installation_id };
}

async function githubJson<T>(env: QueueRouteEnv, repositoryId: string, path: string): Promise<T | null> {
  const repository = await repositoryOf(env, repositoryId);
  if (repository === null) return null;
  // `installationToken` takes the Worker environment; the queue routes carry the
  // same object under a narrower type.
  const token = await installationToken(env as unknown as Env, repository.installationId);
  const response = await fetch(`https://api.github.com/repos/${repository.name}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "thwip-control-plane",
    },
  });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

/**
 * The real reads, so the sweep needs nothing wired into it from the Worker's
 * entry point. A fix that only works once somebody remembers to pass a port is
 * not deployed.
 */
export const GITHUB_READS: ReconciliationReads = {
  async pullRequestMergeState(env, repositoryId, pullRequestNumber) {
    const pull = await githubJson<{ merged?: boolean; merge_commit_sha?: string | null }>(
      env,
      repositoryId,
      `/pulls/${pullRequestNumber}`,
    );
    if (pull === null) return null;
    return {
      merged: pull.merged === true,
      mergeCommitSha: typeof pull.merge_commit_sha === "string" ? pull.merge_commit_sha : null,
    };
  },

  async baseContainsSha(env, repositoryId, baseRef, sha) {
    const branch = baseRef.replace(/^refs\/heads\//, "");
    const compared = await githubJson<{ status?: string }>(
      env,
      repositoryId,
      `/compare/${encodeURIComponent(branch)}...${encodeURIComponent(sha)}`,
    );
    if (compared?.status === undefined) return null;
    return compared.status === "behind" || compared.status === "identical";
  },

  async pullRequestNumbersForCommit(env, repositoryId, sha) {
    // `GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls` answers with an
    // array of pull requests, each carrying its `number`. A refusal comes back
    // as null from `githubJson`, and null has to stay apart from the empty
    // array: one means the read did not happen, the other means the commit
    // really belongs to no pull request.
    const pulls = await githubJson<Array<{ number?: number }>>(env, repositoryId, `/commits/${sha}/pulls`);
    if (!Array.isArray(pulls)) return null;
    return pulls.map((pull) => pull.number).filter((n): n is number => typeof n === "number");
  },

  async commitFacts(env, repositoryId, sha) {
    const commit = await githubJson<{ tree?: { sha?: string }; parents?: Array<{ sha?: string }>; message?: string }>(
      env,
      repositoryId,
      `/git/commits/${sha}`,
    );
    const treeOid = commit?.tree?.sha;
    if (typeof treeOid !== "string" || typeof commit?.message !== "string") return null;
    return {
      treeOid,
      parentShas: (commit?.parents ?? []).map((parent) => parent.sha).filter((s): s is string => typeof s === "string"),
      message: commit.message,
    };
  },
};

/**
 * Settle a reconciliation `overdueReconciliation` has already named.
 *
 * The caller passes the attempt in rather than this reading for it, because the
 * caller is a five-minute sweep over every enabled queue on an account that
 * deliberately stays inside a free tier: it has the state loaded already, and a
 * second read per queue per tick to discover the usual nothing is a cost with no
 * return. GitHub is read only for a queue that actually has one of these.
 *
 * Reads first and writes once, so the whole GitHub conversation happens outside
 * the queue transaction.
 */
export async function settleReconciliation(
  env: QueueRouteEnv,
  repositoryId: string,
  baseRef: string,
  overdue: OverdueReconciliation,
  reads: ReconciliationReads = GITHUB_READS,
): Promise<SettledReconciliation> {
  const db = env.DB as unknown as D1Like;
  // Built once for the whole settlement: every path below can free the lane, and
  // every freed lane is offered, which writes a decision record.
  const recordDecision = queueDecisionRecorder({
    db,
    bucket: env.EVIDENCE as unknown as R2Like | undefined,
    repositoryId,
  });
  const { attemptId, pullRequestNumber, headSha } = overdue;
  const verdict =
    headSha === null
      ? // Nothing was ever pinned, so there is no commit whose presence on the
        // base could answer the question. Reading anyway would only produce a
        // negative nobody could stand behind.
        ({ kind: "unknown", reason: "the attempt pinned no head commit to look for" } as const)
      : await confirmMergeAbsence(
          {
            readPull: () => reads.pullRequestMergeState(env, repositoryId, pullRequestNumber),
            baseContainsHead: () => reads.baseContainsSha(env, repositoryId, baseRef, headSha),
          },
          reads.sleep === undefined ? {} : { sleep: reads.sleep },
        );

  if (verdict.kind === "merged") {
    // The facts come from the commit, never from the verdict: while a pull
    // request is open `merge_commit_sha` holds the test merge GitHub computes
    // for it, and that value once put a commit main never was into the chain.
    const mergeSha = verdict.mergeSha;
    const facts = mergeSha === null ? null : await reads.commitFacts(env, repositoryId, mergeSha);
    if (mergeSha !== null && facts !== null) {
      const applied = await withQueueState(db, repositoryId, baseRef, async (store) => {
        const commands = commandsFor(store, undefined, recordDecision);
        const confirmed = await commands.confirmMerge({
          idempotencyKey: `overdue-merged:${attemptId}`,
          attemptId,
          operationId: mergeOperationId(attemptId),
          mergeSha,
          mergeTree: facts.treeOid,
          parentShas: facts.parentShas,
        });
        await settle(store, commands);
        return { status: confirmed.status, snapshot: buildSnapshot(store) };
      });
      if (applied.status !== "rejected") {
        return { outcome: { settled: "merged", attemptId, mergeSha }, snapshot: applied.snapshot };
      }
    }
    // A merge that cannot be named, or a commit that is not the candidate the
    // queue authorized. Neither is a merge this may write down, and neither is a
    // reason to keep holding the lane.
    return giveUp(db, recordDecision, repositoryId, baseRef, attemptId, "the merge could not be read back from its commit");
  }

  if (verdict.kind === "unknown") {
    return giveUp(db, recordDecision, repositoryId, baseRef, attemptId, verdict.reason);
  }

  const resolved = await withQueueState(db, repositoryId, baseRef, async (store) => {
    const commands = commandsFor(store, undefined, recordDecision);
    const confirmed = await commands.confirmNotMerged({
      idempotencyKey: `overdue-not-merged:${attemptId}`,
      attemptId,
      operationId: mergeOperationId(attemptId),
    });
    await settle(store, commands);
    return { status: confirmed.status, snapshot: buildSnapshot(store) };
  });
  return resolved.status === "rejected"
    ? giveUp(db, recordDecision, repositoryId, baseRef, attemptId, "the refusal could not be recorded")
    : { outcome: { settled: "not-merged", attemptId, reason: verdict.reason }, snapshot: resolved.snapshot };
}

/**
 * End an attempt the queue cannot speak for.
 *
 * `PROVIDER_FAILURE` is the one outcome the reducer accepts while a merge
 * outcome is in doubt, and it blocks the entry MERGE_OUTCOME_UNKNOWN rather than
 * deferring it, so this pull request is out of the running until somebody reads
 * it. The lane goes back to everybody else.
 */
async function giveUp(
  db: D1Like,
  recordDecision: DecisionRecorder,
  repositoryId: string,
  baseRef: string,
  attemptId: string,
  reason: string,
): Promise<SettledReconciliation> {
  const snapshot = await withQueueState(db, repositoryId, baseRef, async (store) => {
    const commands = commandsFor(store, undefined, recordDecision);
    commands.terminateAttempt({
      idempotencyKey: `overdue-unknown:${attemptId}`,
      attemptId,
      outcome: "PROVIDER_FAILURE",
    });
    await settle(store, commands);
    return buildSnapshot(store);
  });
  return { outcome: { settled: "unknown", attemptId, reason }, snapshot };
}

/**
 * Offer the lane if the command just freed it, the same settling `runOnQueue`
 * does after every command. Freeing a lane and offering it are separate steps,
 * and every place that has forgotten the second one has left the queue idle with
 * work waiting.
 */
async function settle(
  store: Parameters<typeof buildSnapshot>[0],
  commands: ReturnType<typeof commandsFor>,
): Promise<void> {
  if (store.state().activeAttemptId !== null) return;
  await commands.tick({ idempotencyKey: `settle:${store.generation()}` });
}
