import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  classifyMergeResponse,
  decideMergeWrite,
  planExecution,
  TURN_EVENTS,
  type MergeAttemptOutcome,
} from "./turn.js";
import type { BranchQueue } from "./BranchQueue.js";

/**
 * NOT ON THE LIVE PATH. Nothing calls createInstance on this, so no instance has
 * ever run. It is bound in wrangler and typed in env, which makes it read as the
 * thing driving turns; it is not. Turns are driven by the queue dispatching
 * thwip-merge.yml and thwip-queue-verify.yml.
 *
 * It stays because it is the designed home for device execution, where a turn
 * waits on a developer's machine to run the suites, and that path is real work
 * still to do. Deleting it would throw away a tested design; leaving it unlabelled
 * was worse, because it looks like the running system.
 *
 * One durable turn per attempt (plan.md §40).
 *
 * Every decision this class makes is delegated to the pure planner in turn.ts,
 * and every state change is delegated to the Durable Object. The workflow itself
 * only orders the steps and survives restarts, which is the one thing neither of
 * the other two can do.
 *
 * The merge step is the exception to normal step semantics: it is guarded by a
 * durable operation row rather than by workflow state, because a crash can land
 * after GitHub accepts the request and before the step commits.
 */

export interface TurnParams {
  readonly attemptId: string;
  readonly entryId: string;
  readonly queueKey: string;
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly attemptRevision: number;
  readonly workflowProtocolVersion: "1";
}

export interface TurnEnv {
  readonly BRANCH_QUEUE: DurableObjectNamespace<BranchQueue>;
  /** Everything that touches GitHub lives behind this, so the turn stays testable. */
  readonly QUEUE_GITHUB: GitHubTurnPort;
}

/**
 * The provider operations a turn needs. Implemented for real by queue-github and
 * stubbed in tests, so no GitHub types leak into the sequencing.
 */
export interface GitHubTurnPort {
  resolveCandidate(input: {
    repositoryId: string;
    baseRef: string;
    pullRequestNumber: number;
  }): Promise<{
    baseSha: string;
    headSha: string;
    candidateSha: string;
    candidateTreeOid: string;
    parentShas: readonly string[];
  }>;
  dispatchVerifier(input: { attemptId: string; nonce: string; candidateSha: string }): Promise<void>;
  dispatchRemoteExecution(input: { attemptId: string; candidateSha: string }): Promise<void>;
  readFinalGuardFacts(input: { repositoryId: string; baseRef: string; pullRequestNumber: number }): Promise<{
    baseSha: string;
    headSha: string;
    candidateTreeOid: string;
    policyDigest: string;
    pullRequestOpen: boolean;
    reviewsSatisfied: boolean;
    signerStillAuthorized: boolean;
    rulesetEnforced: boolean;
    appPermissionsHealthy: boolean;
  }>;
  merge(input: {
    repositoryId: string;
    pullRequestNumber: number;
    expectedHeadSha: string;
    commitTitle: string;
    operationId: string;
  }): Promise<{ status: number; transportError?: string; body?: Record<string, unknown> }>;
  observeMergeResult(input: {
    repositoryId: string;
    pullRequestNumber: number;
    expectedTreeOid: string;
  }): Promise<MergeAttemptOutcome>;
}

export class IntegrationTurnWorkflow extends WorkflowEntrypoint<TurnEnv, TurnParams> {
  override async run(event: WorkflowEvent<TurnParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    const queue = this.env.BRANCH_QUEUE.get(
      this.env.BRANCH_QUEUE.idFromName(params.queueKey),
    ) as unknown as BranchQueue;

    // 1. The attempt must still be the current one at the revision we started
    //    from; anything else means the world moved and this turn is void.
    const standing = await step.do("confirm-attempt", async () =>
      queue.classifyCallback(params.attemptId, params.attemptRevision),
    );
    if (standing !== "current") return;

    const snapshot = await step.do("read-entry", async () => queue.snapshot());
    const entry = snapshot.entries.find((e) => e.entryId === params.entryId);
    if (entry === undefined) return;

    // 2. Pin the candidate. Immutable from here on.
    const candidate = await step.do("resolve-candidate", async () =>
      this.env.QUEUE_GITHUB.resolveCandidate({
        repositoryId: params.repositoryId,
        baseRef: params.baseRef,
        pullRequestNumber: entry.pullRequestNumber,
      }),
    );
    await step.do("persist-candidate", async () =>
      queue.candidatePrepared({
        idempotencyKey: `candidate:${params.attemptId}`,
        attemptId: params.attemptId,
        baseSha: candidate.baseSha,
        headSha: candidate.headSha,
        candidateSha: candidate.candidateSha,
        candidateTree: candidate.candidateTreeOid,
        policyDigest: "sha256:pending",
        runner: "dagger",
      }),
    );

    // 3-4. Issue the assignment and branch on its execution union. Fast reuse
    //      and remote never wait for a device event.
    const assignment = await step.do("issue-assignment", async () =>
      queue.assign({
        idempotencyKey: `assign:${params.attemptId}`,
        attemptId: params.attemptId,
        assignmentDigest: "sha256:pending",
      }),
    );
    if (assignment.status === "rejected") return;

    const plan = planExecution({
      mode: "run",
      profile: "fresh",
      runnerPrincipalId: entry.sponsorPrincipalId,
      deviceKeyId: "pending",
    });

    if (plan.kind === "await-device") {
      const signal = await Promise.race([
        step.waitForEvent(TURN_EVENTS.receipt, { type: TURN_EVENTS.receipt }),
        step.waitForEvent(TURN_EVENTS.runFailed, { type: TURN_EVENTS.runFailed }),
        step.waitForEvent(TURN_EVENTS.attemptRevoked, { type: TURN_EVENTS.attemptRevoked }),
      ]);
      if (signal.type !== TURN_EVENTS.receipt) return;
    } else if (plan.kind === "dispatch-remote") {
      await step.do("dispatch-remote", async () =>
        this.env.QUEUE_GITHUB.dispatchRemoteExecution({
          attemptId: params.attemptId,
          candidateSha: candidate.candidateSha,
        }),
      );
    }

    // 5-6. The protected verifier, and its bound result.
    const verification = await step.do("start-verification", async () =>
      queue.startVerification({ idempotencyKey: `verify:${params.attemptId}`, attemptId: params.attemptId }),
    );
    const nonce = "nonce" in verification ? verification.nonce : undefined;
    if (nonce === undefined) return;

    await step.do("dispatch-verifier", async () =>
      this.env.QUEUE_GITHUB.dispatchVerifier({
        attemptId: params.attemptId,
        nonce,
        candidateSha: candidate.candidateSha,
      }),
    );
    const verdict = await step.waitForEvent<{ accepted: boolean; resultDigest: string }>(
      TURN_EVENTS.verifierResult,
      { type: TURN_EVENTS.verifierResult },
    );

    // 7. Commit the verdict through the Durable Object, which binds it to the
    //    nonce it issued.
    const committed = await step.do("commit-verified", async () =>
      queue.completeVerification({
        idempotencyKey: `verdict:${params.attemptId}`,
        attemptId: params.attemptId,
        nonce,
        accepted: verdict.payload.accepted,
        resultDigest: verdict.payload.resultDigest,
      }),
    );
    if (committed.status === "rejected" || !verdict.payload.accepted) return;

    // 8. Final guard: re-read everything security-critical.
    const facts = await step.do("final-guard", async () =>
      this.env.QUEUE_GITHUB.readFinalGuardFacts({
        repositoryId: params.repositoryId,
        baseRef: params.baseRef,
        pullRequestNumber: entry.pullRequestNumber,
      }),
    );
    if (facts.baseSha !== candidate.baseSha || facts.headSha !== candidate.headSha) return;

    // 9. Persist the intent, then declare the write started, before the request.
    const operationId = `merge:${params.attemptId}`;
    await step.do("persist-merge-intent", async () =>
      queue.mergeIntent({
        idempotencyKey: `intent:${params.attemptId}`,
        attemptId: params.attemptId,
        intentDigest: "sha256:pending",
      }),
    );
    const begun = await step.do("begin-merge-write", async () =>
      queue.beginMergeWrite({
        idempotencyKey: `merge-requested:${params.attemptId}`,
        attemptId: params.attemptId,
        operationId,
      }),
    );

    // 10. The one step that must never retry a mutation. The persisted operation
    //     decides, not this workflow's own step state (§40.1).
    const outcome = await this.performMergeWrite({
      queue,
      params,
      entry,
      candidate,
      operationId,
      alreadyStarted: begun.status === "already-started",
    });

    // 11-13. Resolve and record.
    if (outcome.kind === "merged") {
      await step.do("confirm-merge", async () =>
        queue.confirmMerge({
          idempotencyKey: `merged:${params.attemptId}`,
          attemptId: params.attemptId,
          operationId,
          mergeSha: outcome.mergeSha,
          mergeTree: outcome.mergeTree,
          parentShas: outcome.parentShas,
        }),
      );
      return;
    }
    if (outcome.kind === "rejected") {
      await step.do("confirm-not-merged", async () =>
        queue.confirmNotMerged({
          idempotencyKey: `not-merged:${params.attemptId}`,
          attemptId: params.attemptId,
          operationId,
        }),
      );
      return;
    }
    // Unknown: hand the lane to reconciliation. The Durable Object's alarm and
    // the reconcile outbox item own it from here; this turn never guesses.
    await step.do("mark-unknown", async () =>
      queue.mergeOutcomeUnknown({ idempotencyKey: `unknown:${params.attemptId}`, attemptId: params.attemptId }),
    );
  }

  /**
   * Deliberately not a retriable step.do around the mutation: the decision to
   * send is taken from the durable operation row, and a re-entry only ever
   * reads.
   */
  private async performMergeWrite(input: {
    queue: BranchQueue;
    params: TurnParams;
    entry: { pullRequestNumber: number };
    candidate: { headSha: string; candidateTreeOid: string };
    operationId: string;
    alreadyStarted: boolean;
  }): Promise<MergeAttemptOutcome> {
    const persisted = input.alreadyStarted
      ? { attemptId: input.params.attemptId, outcome: null }
      : null;
    const decision = decideMergeWrite({
      persisted,
      attemptId: input.params.attemptId,
      isReentry: input.alreadyStarted,
    });

    if (decision.action === "already-resolved") {
      return decision.outcome === "MERGED"
        ? await this.env.QUEUE_GITHUB.observeMergeResult({
            repositoryId: input.params.repositoryId,
            pullRequestNumber: input.entry.pullRequestNumber,
            expectedTreeOid: input.candidate.candidateTreeOid,
          })
        : { kind: "rejected", reason: decision.outcome };
    }

    if (decision.action === "reconcile") {
      return await this.env.QUEUE_GITHUB.observeMergeResult({
        repositoryId: input.params.repositoryId,
        pullRequestNumber: input.entry.pullRequestNumber,
        expectedTreeOid: input.candidate.candidateTreeOid,
      });
    }

    const response = await this.env.QUEUE_GITHUB.merge({
      repositoryId: input.params.repositoryId,
      pullRequestNumber: input.entry.pullRequestNumber,
      expectedHeadSha: input.candidate.headSha,
      commitTitle: `Merge pull request #${input.entry.pullRequestNumber}`,
      operationId: input.operationId,
    });
    return classifyMergeResponse(response as never);
  }
}
