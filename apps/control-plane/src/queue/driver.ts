import type { GitSubject, Sha256 } from "@thwip/queue-protocol";
import { buildAssignment, buildMergeIntent, buildTransitionRecord, signAssignment, signMergeIntent, signTransitionRecord, type Signer } from "./evidence.js";
import { classifyMergeResponse, decideMergeWrite, finalGuard, type GuardObservation, type MergeAttemptOutcome } from "./turn.js";
import { validateMergeResult, type CommitFacts } from "./candidate.js";
import { buildCheck, mayGate, type ActivationState } from "./check.js";

/**
 * One integration turn, from a claimed offer to a recorded transition.
 *
 * The Workflow provides durability and the Durable Object provides serialization;
 * neither of them decides anything. This driver holds the ordering and the
 * decisions, with every side effect behind a port, so the whole path — including
 * the paths that only happen when things go wrong — can be executed in a test.
 *
 * It never throws for an expected outcome. A turn that cannot proceed returns a
 * typed result naming why, because an exception here would be caught by a retry
 * somewhere and a retry is exactly what the merge step must never do.
 */

export interface QueuePort {
  candidatePrepared(input: {
    idempotencyKey: string;
    attemptId: string;
    baseSha: string;
    headSha: string;
    candidateSha: string;
    candidateTree: string;
    policyDigest: string;
    runner: string;
  }): Promise<{ status: string }>;
  assign(input: { idempotencyKey: string; attemptId: string; assignmentDigest: string }): Promise<{ status: string }>;
  startVerification(input: { idempotencyKey: string; attemptId: string }): Promise<{ status: string; nonce?: string }>;
  createMergeIntent(input: { idempotencyKey: string; attemptId: string; intentDigest: string }): Promise<{ status: string }>;
  beginMergeWrite(input: { idempotencyKey: string; attemptId: string; operationId: string }): Promise<{ status: string; outcome?: string | null }>;
  confirmMerge(input: {
    idempotencyKey: string;
    attemptId: string;
    operationId: string;
    mergeSha: string;
    mergeTree: string;
    parentShas: readonly string[];
  }): Promise<{ status: string }>;
  confirmNotMerged(input: { idempotencyKey: string; attemptId: string; operationId: string }): Promise<{ status: string }>;
  mergeOutcomeUnknown(input: { idempotencyKey: string; attemptId: string }): Promise<{ status: string }>;
  recordTransition(input: {
    idempotencyKey: string;
    kind: "verified";
    transitionSequence: number;
    priorDigest: string | null;
    digest: string;
    baseSha: string;
    attemptId: string;
    witnessPrincipalIds: readonly string[];
  }): Promise<{ status: string }>;
  terminateAttempt(input: { idempotencyKey: string; attemptId: string; outcome: string }): Promise<{ status: string }>;
  pause(input: { idempotencyKey: string; actorPrincipalId: string; reason: string }): Promise<{ status: string }>;
  attemptRevision(): Promise<number>;
}

export interface ProviderPort {
  resolveCandidate(): Promise<
    | { status: "pinned"; subject: GitSubject }
    | { status: "pending"; reason: string }
    | { status: "blocked"; reason: string }
  >;
  dispatchVerifier(input: { attemptId: string; nonce: string; candidateSha: string }): Promise<void>;
  awaitVerifierResult(input: { attemptId: string; nonce: string }): Promise<
    { accepted: true; resultDigest: Sha256; integrationEvidenceDigest: Sha256; checkRunId: string; actionRunId: string } | { accepted: false; reason: string }
  >;
  readGuardFacts(): Promise<GuardObservation>;
  merge(input: {
    pullRequestNumber: number;
    expectedHeadSha: string;
    commitTitle: string;
    commitMessage: string;
  }): Promise<{ status: number; transportError?: string; body?: Record<string, unknown> }>;
  observeResult(): Promise<{ merged: boolean; commit: CommitFacts | null }>;
  publishCheck(input: { headSha: string; conclusion: string; title: string; summary: string; externalId: string }): Promise<void>;
}

export interface TurnContext {
  readonly attemptId: string;
  readonly entryId: string;
  readonly pullRequestNumber: number;
  readonly sponsorPrincipalId: string;
  readonly ownerId: string;
  readonly activationState: ActivationState;
  readonly mergeMethod: "merge" | "squash";
  readonly queueEpoch: number;
  readonly turnSequence: number;
  readonly transitionSequence: number;
  readonly previousTransitionDigest: Sha256 | null;
  readonly previousBase: { baseSha: string | null; treeOid: string | null };
  readonly queueDecisionDigest: Sha256;
  readonly workReceiptDigest: Sha256;
  readonly policy: Parameters<typeof buildAssignment>[0]["policy"];
  /** Present only when `execution.mode` is `remote`; a local run pins no GitHub workflow. */
  readonly verifier?: Parameters<typeof buildAssignment>[0]["verifier"];
  readonly execution: Parameters<typeof buildAssignment>[0]["execution"];
  readonly now: string;
  readonly executionSeconds: number;
  readonly nonceSeed: string;
}

export type TurnResult =
  | { readonly outcome: "merged"; readonly mergeSha: string; readonly transitionDigest: Sha256 }
  | { readonly outcome: "not-merged"; readonly reason: string }
  | { readonly outcome: "reconciling"; readonly reason: string }
  | { readonly outcome: "abandoned"; readonly reason: string }
  | { readonly outcome: "incident"; readonly reason: string };

export async function runTurn(
  ctx: TurnContext,
  queue: QueuePort,
  provider: ProviderPort,
  signer: Signer,
): Promise<TurnResult> {
  /* 1. Pin the candidate. */
  const candidate = await provider.resolveCandidate();
  if (candidate.status !== "pinned") {
    await queue.terminateAttempt({
      idempotencyKey: `abandon:${ctx.attemptId}`,
      attemptId: ctx.attemptId,
      outcome: candidate.status === "pending" ? "INTERNAL_FAILURE" : "MERGE_CONFLICT",
    });
    return { outcome: "abandoned", reason: candidate.reason };
  }
  const git = candidate.subject;

  /* 2. Build and sign the assignment. Digests are computed, never passed in. */
  const assignmentDoc = await buildAssignment({
    assignmentId: `asg_${ctx.attemptId}`,
    attemptId: ctx.attemptId,
    ownerId: ctx.ownerId,
    git,
    queue: {
      queueEpoch: ctx.queueEpoch,
      turnSequence: ctx.turnSequence,
      entryId: ctx.entryId,
      pullRequestNumber: ctx.pullRequestNumber,
      sponsorPrincipalId: ctx.sponsorPrincipalId,
      queueDecisionDigest: ctx.queueDecisionDigest,
    },
    policy: ctx.policy,
    execution: ctx.execution,
    evidence: {
      workReceiptDigest: ctx.workReceiptDigest,
      previousTransitionDigest: ctx.previousTransitionDigest,
    },
    ...(ctx.verifier !== undefined ? { verifier: ctx.verifier } : {}),
    issuedAt: ctx.now,
    executionSeconds: ctx.executionSeconds,
    nonce: ctx.nonceSeed,
  });
  const assignment = await signAssignment(assignmentDoc, signer);
  if ("error" in assignment) {
    await queue.terminateAttempt({
      idempotencyKey: `bad-assignment:${ctx.attemptId}`,
      attemptId: ctx.attemptId,
      outcome: "INTERNAL_FAILURE",
    });
    return { outcome: "abandoned", reason: `assignment invalid: ${assignment.error}` };
  }

  await queue.candidatePrepared({
    idempotencyKey: `candidate:${ctx.attemptId}`,
    attemptId: ctx.attemptId,
    baseSha: git.baseSha,
    headSha: git.headSha,
    candidateSha: git.candidateSha,
    candidateTree: git.candidateTreeOid,
    policyDigest: assignment.record.policy.digest,
    runner: "dagger",
  });
  await queue.assign({
    idempotencyKey: `assign:${ctx.attemptId}`,
    attemptId: ctx.attemptId,
    assignmentDigest: assignment.digest,
  });

  /* 3. The protected verifier. The nonce comes from the queue, not from here. */
  const started = await queue.startVerification({
    idempotencyKey: `verify:${ctx.attemptId}`,
    attemptId: ctx.attemptId,
  });
  const nonce = started.nonce;
  if (nonce === undefined) return { outcome: "abandoned", reason: "verification could not be started" };

  await provider.dispatchVerifier({ attemptId: ctx.attemptId, nonce, candidateSha: git.candidateSha });
  const verdict = await provider.awaitVerifierResult({ attemptId: ctx.attemptId, nonce });
  if (!verdict.accepted) {
    await queue.terminateAttempt({
      idempotencyKey: `rejected:${ctx.attemptId}`,
      attemptId: ctx.attemptId,
      outcome: "VERIFICATION_FAILED",
    });
    return { outcome: "not-merged", reason: verdict.reason };
  }

  /* 4. Final guard, immediately before the write. */
  const revision = await queue.attemptRevision();
  const observed = await provider.readGuardFacts();
  const guard = finalGuard(
    {
      baseSha: git.baseSha,
      headSha: git.headSha,
      candidateTreeOid: git.candidateTreeOid,
      policyDigest: assignment.record.policy.digest,
      attemptRevision: revision,
    },
    observed,
  );
  if (!guard.ok) {
    await queue.terminateAttempt({
      idempotencyKey: `guard:${ctx.attemptId}`,
      attemptId: ctx.attemptId,
      outcome: guardOutcome(guard.reason),
    });
    return { outcome: "not-merged", reason: guard.reason };
  }

  /* 5. Sign the intent, then declare the write started — before the request. */
  const commitMessage = mergeCommitMessage(ctx, git, assignment.digest);
  const intentDoc = await buildMergeIntent({
    operationId: `merge_${ctx.attemptId}`,
    attemptId: ctx.attemptId,
    git,
    queueEpoch: ctx.queueEpoch,
    turnSequence: ctx.turnSequence,
    transitionSequence: ctx.transitionSequence,
    pullRequestNumber: ctx.pullRequestNumber,
    mergeMethod: ctx.mergeMethod,
    policyDigest: assignment.record.policy.digest,
    previousTransitionDigest: ctx.previousTransitionDigest,
    commitTitle: `Merge pull request #${ctx.pullRequestNumber}`,
    commitMessage,
    createdAt: ctx.now,
    evidence: {
      kind: "verified",
      workReceiptDigest: ctx.workReceiptDigest,
      assignmentDigest: assignment.digest,
      integrationEvidenceDigest: verdict.integrationEvidenceDigest,
      verifierResultDigest: verdict.resultDigest,
      candidateCheckRunId: verdict.checkRunId,
    },
  });
  const intent = await signMergeIntent(intentDoc, signer);
  if ("error" in intent) {
    await queue.terminateAttempt({
      idempotencyKey: `bad-intent:${ctx.attemptId}`,
      attemptId: ctx.attemptId,
      outcome: "INTERNAL_FAILURE",
    });
    return { outcome: "abandoned", reason: `merge intent invalid: ${intent.error}` };
  }
  await queue.createMergeIntent({
    idempotencyKey: `intent:${ctx.attemptId}`,
    attemptId: ctx.attemptId,
    intentDigest: intent.digest,
  });

  /* 6. Only canary and enforced may actually write. Observe stops here having
        published what it would have done, which is what makes adoption safe. */
  if (!mayGate(ctx.activationState)) {
    await provider.publishCheck({
      ...buildCheck(
        {
          activationState: ctx.activationState,
          entryState: "MergeGuard",
          primaryReason: null,
          schedulerEligible: true,
          projectedPosition: 1,
          totalReady: 1,
          attemptId: ctx.attemptId,
          paused: false,
          pauseReason: null,
          cooldownUntil: null,
        },
        git.headSha,
      ),
      conclusion: "neutral",
      headSha: git.headSha,
    });
    return { outcome: "abandoned", reason: `observing: would have merged ${git.candidateSha}` };
  }

  const operationId = `merge_${ctx.attemptId}`;
  const begun = await queue.beginMergeWrite({
    idempotencyKey: `merge-requested:${ctx.attemptId}`,
    attemptId: ctx.attemptId,
    operationId,
  });

  /* 7. The write, or a read instead of one. */
  const decision = decideMergeWrite({
    persisted: begun.status === "already-started" ? { attemptId: ctx.attemptId, outcome: begun.outcome ?? null } : null,
    attemptId: ctx.attemptId,
    isReentry: begun.status === "already-started",
  });

  let outcome: MergeAttemptOutcome;
  if (decision.action === "send") {
    const response = await provider.merge({
      pullRequestNumber: ctx.pullRequestNumber,
      expectedHeadSha: git.headSha,
      commitTitle: `Merge pull request #${ctx.pullRequestNumber}`,
      commitMessage,
    });
    outcome = classifyMergeResponse(response as never);
  } else {
    const observedResult = await provider.observeResult();
    outcome = !observedResult.merged
      ? { kind: "rejected", reason: "GitHub reports the pull request as not merged" }
      : observedResult.commit === null
        ? { kind: "unknown", reason: "merged with no commit reported" }
        : {
            kind: "merged",
            mergeSha: observedResult.commit.sha,
            mergeTree: observedResult.commit.treeOid,
            parentShas: observedResult.commit.parentShas,
          };
  }

  /* 8. Resolve. */
  if (outcome.kind === "unknown") {
    await queue.mergeOutcomeUnknown({ idempotencyKey: `unknown:${ctx.attemptId}`, attemptId: ctx.attemptId });
    return { outcome: "reconciling", reason: outcome.reason };
  }
  if (outcome.kind === "rejected") {
    await queue.confirmNotMerged({
      idempotencyKey: `not-merged:${ctx.attemptId}`,
      attemptId: ctx.attemptId,
      operationId,
    });
    return { outcome: "not-merged", reason: outcome.reason };
  }

  /* 9. The landed commit must be the verified one, or it is an incident. */
  const validation = validateMergeResult({
    mergeMethod: ctx.mergeMethod,
    assigned: git,
    finalCommit: { sha: outcome.mergeSha, treeOid: outcome.mergeTree, parentShas: outcome.parentShas },
    pullRequestMerged: true,
  });
  if (!validation.ok) {
    if (validation.integrityIncident) {
      await queue.pause({
        idempotencyKey: `incident:${ctx.attemptId}`,
        actorPrincipalId: "thwip-service",
        reason: `integrity: ${validation.reason}`,
      });
      return { outcome: "incident", reason: validation.reason };
    }
    await queue.mergeOutcomeUnknown({ idempotencyKey: `unknown:${ctx.attemptId}`, attemptId: ctx.attemptId });
    return { outcome: "reconciling", reason: validation.reason };
  }

  await queue.confirmMerge({
    idempotencyKey: `merged:${ctx.attemptId}`,
    attemptId: ctx.attemptId,
    operationId,
    mergeSha: outcome.mergeSha,
    mergeTree: outcome.mergeTree,
    parentShas: outcome.parentShas,
  });

  /* 10. Record the transition and publish the green check. */
  const transitionDoc = await buildTransitionRecord({
    git,
    queueEpoch: ctx.queueEpoch,
    transitionSequence: ctx.transitionSequence,
    previousTransitionDigest: ctx.previousTransitionDigest,
    before: ctx.previousBase,
    final: { sha: outcome.mergeSha, treeOid: outcome.mergeTree, parentShas: outcome.parentShas },
    observedAt: ctx.now,
    mergeMethod: ctx.mergeMethod,
    attemptId: ctx.attemptId,
    pullRequestNumber: ctx.pullRequestNumber,
    mergeIntentDigest: intent.digest,
    workReceiptDigest: ctx.workReceiptDigest,
    assignmentDigest: assignment.digest,
    integrationEvidenceDigest: verdict.integrationEvidenceDigest,
    verifierResultDigest: verdict.resultDigest,
    checkRunId: verdict.checkRunId,
    actionRunId: verdict.actionRunId,
  });
  const transition = await signTransitionRecord(transitionDoc, signer);
  if ("error" in transition) {
    // The merge happened. Failing to record it is an incident, not a rollback:
    // nothing may ever revert a merge (plan.md §40.1 step 6).
    await queue.pause({
      idempotencyKey: `unrecorded:${ctx.attemptId}`,
      actorPrincipalId: "thwip-service",
      reason: `merged but the transition record was invalid: ${transition.error}`,
    });
    return { outcome: "incident", reason: `merged but unrecorded: ${transition.error}` };
  }

  await queue.recordTransition({
    idempotencyKey: `transition:${ctx.attemptId}`,
    kind: "verified",
    transitionSequence: ctx.transitionSequence,
    priorDigest: ctx.previousTransitionDigest,
    digest: transition.digest,
    baseSha: outcome.mergeSha,
    attemptId: ctx.attemptId,
    witnessPrincipalIds: [ctx.sponsorPrincipalId],
  });

  await provider.publishCheck({
    ...buildCheck(
      {
        activationState: ctx.activationState,
        entryState: "Merged",
        primaryReason: null,
        schedulerEligible: true,
        projectedPosition: null,
        totalReady: 0,
        attemptId: ctx.attemptId,
        paused: false,
        pauseReason: null,
        cooldownUntil: null,
      },
      git.headSha,
    ),
    headSha: git.headSha,
  });

  return { outcome: "merged", mergeSha: outcome.mergeSha, transitionDigest: transition.digest };
}

function guardOutcome(reason: string): string {
  switch (reason) {
    case "BASE_MOVED":
      return "BASE_MOVED";
    case "HEAD_MOVED":
      return "HEAD_MOVED";
    case "POLICY_CHANGED":
      return "POLICY_CHANGED";
    case "REVIEWS_CHANGED":
      return "REVIEWS_CHANGED";
    case "PERMISSION_REVOKED":
      return "PERMISSION_REVOKED";
    default:
      return "INVARIANT_FAILURE";
  }
}

/**
 * The generated merge commit message, ending in the reserved trailer block
 * (plan.md §22). The digests let anyone reading the branch history find the
 * evidence for a merge without asking the control plane.
 */
export function mergeCommitMessage(
  ctx: Pick<TurnContext, "attemptId" | "transitionSequence" | "pullRequestNumber">,
  git: GitSubject,
  assignmentDigest: Sha256,
): string {
  return [
    `Integrated by Thwip Queue as candidate ${git.candidateSha}.`,
    "",
    `thwip-queue-attempt: ${ctx.attemptId}`,
    `thwip-queue-transition: ${ctx.transitionSequence}`,
    `thwip-queue-assignment: ${assignmentDigest}`,
    `thwip-queue-tree: ${git.candidateTreeOid}`,
  ].join("\n");
}
