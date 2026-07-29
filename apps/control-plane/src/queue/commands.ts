import type { AttemptOutcome, BlockingReason, ExecutionMode } from "@thwip/queue-domain";
import { isSyntheticExecutionMode } from "@thwip/queue-domain";
import type { AppendResult, BranchQueueStore, Deadline } from "./store.js";

/**
 * The commands a branch queue accepts (plan.md §39).
 *
 * Each command turns an outside request into one domain event plus the
 * deadlines and outbox items that event implies. Keeping that mapping here — and
 * not in the reducer — means the reducer stays a pure function of the log while
 * the timing and external effects stay in one auditable place.
 *
 * Time and identifiers are injected. A command must produce the same event for
 * the same inputs, or replaying an alarm would not be idempotent.
 */

export interface QueueClock {
  now(): string;
}

export interface QueueIds {
  attemptId(): string;
  operationId(): string;
  nonce(): string;
  claimToken(): string;
}

/** Windows from §9.1 and §9.2, with the ranges the spec allows. */
export interface QueueTimings {
  readonly offerSeconds: number;
  readonly executionSeconds: number;
  readonly heartbeatSeconds: number;
  readonly graceSeconds: number;
  readonly noClaimCooldownSeconds: number;
  readonly mergeConfirmSeconds: number;
}

export const DEFAULT_TIMINGS: QueueTimings = {
  offerSeconds: 90,
  executionSeconds: 20 * 60,
  heartbeatSeconds: 20,
  graceSeconds: 60,
  noClaimCooldownSeconds: 5 * 60,
  mergeConfirmSeconds: 60,
};

export const TIMING_LIMITS = {
  offerSeconds: { min: 15, max: 5 * 60 },
  executionSeconds: { min: 5 * 60, max: 45 * 60 },
} as const;

export function validateTimings(timings: QueueTimings): { ok: true } | { ok: false; detail: string } {
  if (
    timings.offerSeconds < TIMING_LIMITS.offerSeconds.min ||
    timings.offerSeconds > TIMING_LIMITS.offerSeconds.max
  ) {
    return { ok: false, detail: "offer window must be between 15 seconds and 5 minutes" };
  }
  if (
    timings.executionSeconds < TIMING_LIMITS.executionSeconds.min ||
    timings.executionSeconds > TIMING_LIMITS.executionSeconds.max
  ) {
    return { ok: false, detail: "execution window must be between 5 and 45 minutes" };
  }
  return { ok: true };
}

function plusSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

export type CommandResult = AppendResult | { readonly status: "noop"; readonly detail: string };

export class QueueCommands {
  constructor(
    private readonly store: BranchQueueStore,
    private readonly clock: QueueClock,
    private readonly ids: QueueIds,
    private readonly timings: QueueTimings = DEFAULT_TIMINGS,
  ) {}

  /** A durable request, accepted before reviews finish (plan.md §7.1). */
  requestQueue(input: {
    idempotencyKey: string;
    entryId: string;
    pullRequestNumber: number;
    sponsorPrincipalId: string;
    sponsorGithubUserId: string;
    headSha: string;
  }): CommandResult {
    return this.store.append({
      idempotencyKey: input.idempotencyKey,
      at: this.clock.now(),
      type: "QueueRequested",
      entryId: input.entryId,
      pullRequestNumber: input.pullRequestNumber,
      sponsorPrincipalId: input.sponsorPrincipalId,
      sponsorGithubUserId: input.sponsorGithubUserId,
      headSha: input.headSha,
    });
  }

  /**
   * Readiness is derived continuously from GitHub and policy state, so this is
   * the most frequent command. It bumps the attempt revision because a change
   * in reviews or checks for the active pull request is exactly the kind of fact
   * a live attempt depends on (§39.2).
   */
  evaluateReadiness(input: {
    idempotencyKey: string;
    entryId: string;
    ready: boolean;
    schedulerEligible: boolean;
    primaryReason: BlockingReason | null;
    secondaryReasons?: readonly BlockingReason[];
  }): CommandResult {
    const state = this.store.state();
    const entry = state.entries.get(input.entryId);
    const affectsActiveAttempt = entry?.currentAttemptId !== null && entry?.currentAttemptId !== undefined;
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: this.clock.now(),
        type: "ReadinessEvaluated",
        entryId: input.entryId,
        ready: input.ready,
        schedulerEligible: input.schedulerEligible,
        primaryReason: input.primaryReason,
        secondaryReasons: input.secondaryReasons ?? [],
      },
      affectsActiveAttempt ? { bumpAttemptRevision: true } : {},
    );
  }

  /**
   * Run the scheduler and offer a turn if one is due. Returns noop rather than
   * an error when nothing is eligible, because that is the normal case.
   */
  tick(input: { idempotencyKey: string; decisionDigest: string }): CommandResult & { attemptId?: string } {
    const now = this.clock.now();
    const chosen = this.store.nextTurn(now);
    if (chosen === null) return { status: "noop", detail: "no eligible entry" };

    const attemptId = this.ids.attemptId();
    const offerDeadline = plusSeconds(now, this.timings.offerSeconds);
    const result = this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: now,
        type: "TurnOffered",
        entryId: chosen.entryId,
        attemptId,
        offerDeadline,
        decisionDigest: input.decisionDigest,
      },
      {
        setDeadlines: [{ kind: "offer", attemptId, dueAt: offerDeadline }],
        outbox: [
          {
            kind: "offer-created",
            attemptId,
            payload: { entryId: chosen.entryId, sponsorPrincipalId: chosen.sponsorPrincipalId, offerDeadline },
          },
        ],
      },
    );
    return result.status === "applied" ? { ...result, attemptId } : result;
  }

  /**
   * Claim an offer. Atomic by construction: the reducer refuses a second claim,
   * so racing devices cannot both win, and a synthetic service claim for a
   * fast-reuse or remote turn consumes the same single share (§8.2).
   */
  claim(input: {
    idempotencyKey: string;
    attemptId: string;
    executionMode: ExecutionMode;
    deviceId?: string;
  }): CommandResult {
    if (!isSyntheticExecutionMode(input.executionMode) && input.deviceId === undefined) {
      return { status: "rejected", detail: "a device claim requires a device id" };
    }
    const now = this.clock.now();
    const executionDeadline = plusSeconds(now, this.timings.executionSeconds);
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: now,
        type: "OfferClaimed",
        attemptId: input.attemptId,
        executionMode: input.executionMode,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      },
      {
        clearDeadlines: [{ kind: "offer", attemptId: input.attemptId }],
        setDeadlines: [{ kind: "execution", attemptId: input.attemptId, dueAt: executionDeadline }],
        outbox: [
          {
            kind: "start-workflow",
            attemptId: input.attemptId,
            payload: { attemptId: input.attemptId, executionMode: input.executionMode },
          },
        ],
        bumpAttemptRevision: true,
      },
    );
  }

  /** Pin the candidate. Immutable afterwards (§6.2 invariant 5). */
  candidatePrepared(input: {
    idempotencyKey: string;
    attemptId: string;
    baseSha: string;
    headSha: string;
    candidateSha: string;
    candidateTree: string;
    policyDigest: string;
    runner: string;
  }): CommandResult {
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: this.clock.now(),
        type: "CandidatePrepared",
        attemptId: input.attemptId,
        baseSha: input.baseSha,
        headSha: input.headSha,
        candidateSha: input.candidateSha,
        candidateTree: input.candidateTree,
        policyDigest: input.policyDigest,
        runner: input.runner,
      },
      { bumpAttemptRevision: true },
    );
  }

  assign(input: { idempotencyKey: string; attemptId: string; assignmentDigest: string }): CommandResult {
    const now = this.clock.now();
    const executionDeadline = plusSeconds(now, this.timings.executionSeconds);
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: now,
        type: "AssignmentIssued",
        attemptId: input.attemptId,
        assignmentDigest: input.assignmentDigest,
        executionDeadline,
      },
      {
        setDeadlines: [{ kind: "execution", attemptId: input.attemptId, dueAt: executionDeadline }],
        bumpAttemptRevision: true,
      },
    );
  }

  /**
   * A heartbeat both proves liveness and clears any grace period. Its
   * idempotency key includes the beat number, so a resent heartbeat is a
   * duplicate rather than a new event.
   */
  heartbeat(input: { idempotencyKey: string; attemptId: string }): CommandResult {
    return this.store.append(
      { idempotencyKey: input.idempotencyKey, at: this.clock.now(), type: "HeartbeatReceived", attemptId: input.attemptId },
      { clearDeadlines: [{ kind: "grace", attemptId: input.attemptId }] },
    );
  }

  /** Three missed beats: hold the lane, start the grace clock (§9.2). */
  heartbeatLost(input: { idempotencyKey: string; attemptId: string }): CommandResult {
    const now = this.clock.now();
    const graceUntil = plusSeconds(now, this.timings.graceSeconds);
    return this.store.append(
      { idempotencyKey: input.idempotencyKey, at: now, type: "HeartbeatLost", attemptId: input.attemptId, graceUntil },
      { setDeadlines: [{ kind: "grace", attemptId: input.attemptId, dueAt: graceUntil }] },
    );
  }

  reconnect(input: { idempotencyKey: string; attemptId: string; deviceId: string }): CommandResult {
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: this.clock.now(),
        type: "Reconnected",
        attemptId: input.attemptId,
        deviceId: input.deviceId,
      },
      { clearDeadlines: [{ kind: "grace", attemptId: input.attemptId }] },
    );
  }

  submitReceipt(input: { idempotencyKey: string; attemptId: string; receiptDigest: string }): CommandResult {
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: this.clock.now(),
        type: "ReceiptSubmitted",
        attemptId: input.attemptId,
        receiptDigest: input.receiptDigest,
      },
      {
        clearDeadlines: [{ kind: "grace", attemptId: input.attemptId }],
        outbox: [{ kind: "dispatch-verifier", attemptId: input.attemptId, payload: { attemptId: input.attemptId } }],
        bumpAttemptRevision: true,
      },
    );
  }

  startVerification(input: { idempotencyKey: string; attemptId: string; nonce?: string }): CommandResult & { nonce?: string } {
    const nonce = input.nonce ?? this.ids.nonce();
    const result = this.store.append({
      idempotencyKey: input.idempotencyKey,
      at: this.clock.now(),
      type: "VerificationStarted",
      attemptId: input.attemptId,
      nonce,
    });
    return result.status === "applied" ? { ...result, nonce } : result;
  }

  completeVerification(input: {
    idempotencyKey: string;
    attemptId: string;
    nonce: string;
    accepted: boolean;
    resultDigest: string;
  }): CommandResult {
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: this.clock.now(),
        type: "VerificationCompleted",
        attemptId: input.attemptId,
        nonce: input.nonce,
        accepted: input.accepted,
        resultDigest: input.resultDigest,
      },
      { bumpAttemptRevision: true },
    );
  }

  createMergeIntent(input: { idempotencyKey: string; attemptId: string; intentDigest: string }): CommandResult {
    return this.store.append({
      idempotencyKey: input.idempotencyKey,
      at: this.clock.now(),
      type: "MergeIntentCreated",
      attemptId: input.attemptId,
      intentDigest: input.intentDigest,
    });
  }

  /**
   * Persist the write intent, then declare it started. The merge_operations row
   * is written first and outlives the workflow, so a retry can prove a mutation
   * may already have been sent and must never send another (§40.1).
   */
  beginMergeWrite(input: {
    idempotencyKey: string;
    attemptId: string;
    operationId: string;
  }): (CommandResult & { operationId?: string }) | { status: "already-started"; outcome: string | null } {
    const state = this.store.state();
    const attempt = state.attempts.get(input.attemptId);
    if (attempt === undefined) return { status: "rejected", detail: `unknown attempt ${input.attemptId}` };
    if (attempt.baseSha === null || attempt.headSha === null || attempt.candidateTree === null) {
      return { status: "rejected", detail: "candidate is not pinned" };
    }
    const now = this.clock.now();
    const begun = this.store.beginMergeOperation({
      operationId: input.operationId,
      attemptId: input.attemptId,
      attemptRevision: this.store.attemptRevision(),
      expectedBaseSha: attempt.baseSha,
      expectedHeadSha: attempt.headSha,
      expectedTreeOid: attempt.candidateTree,
      at: now,
    });
    if (begun.status === "already-started") return begun;

    const result = this.store.append(
      { idempotencyKey: input.idempotencyKey, at: now, type: "MergeRequested", attemptId: input.attemptId },
      {
        setDeadlines: [
          { kind: "merge-confirm", attemptId: input.attemptId, dueAt: plusSeconds(now, this.timings.mergeConfirmSeconds) },
        ],
        outbox: [
          {
            kind: "merge-write",
            attemptId: input.attemptId,
            operationId: input.operationId,
            payload: { operationId: input.operationId },
          },
        ],
      },
    );
    return result.status === "applied" ? { ...result, operationId: input.operationId } : result;
  }

  /** A timeout or reset is a typed nonterminal state, never an exception (§40.1). */
  mergeOutcomeUnknown(input: { idempotencyKey: string; attemptId: string }): CommandResult {
    return this.store.append(
      { idempotencyKey: input.idempotencyKey, at: this.clock.now(), type: "MergeOutcomeUnknown", attemptId: input.attemptId },
      {
        setDeadlines: [
          {
            kind: "merge-confirm",
            attemptId: input.attemptId,
            dueAt: plusSeconds(this.clock.now(), this.timings.mergeConfirmSeconds),
          },
        ],
        outbox: [{ kind: "reconcile-merge", attemptId: input.attemptId, payload: { attemptId: input.attemptId } }],
      },
    );
  }

  confirmMerge(input: {
    idempotencyKey: string;
    attemptId: string;
    operationId: string;
    mergeSha: string;
    mergeTree: string;
    parentShas: readonly string[];
  }): CommandResult {
    const now = this.clock.now();
    const result = this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: now,
        type: "MergeConfirmed",
        attemptId: input.attemptId,
        mergeSha: input.mergeSha,
        mergeTree: input.mergeTree,
        parentShas: input.parentShas,
      },
      {
        clearDeadlines: [
          { kind: "merge-confirm", attemptId: input.attemptId },
          { kind: "execution", attemptId: input.attemptId },
        ],
        outbox: [{ kind: "publish-transition", attemptId: input.attemptId, payload: { mergeSha: input.mergeSha } }],
        bumpAttemptRevision: true,
      },
    );
    if (result.status === "applied") this.store.resolveMergeOperation(input.operationId, "MERGED", now);
    return result;
  }

  confirmNotMerged(input: { idempotencyKey: string; attemptId: string; operationId: string }): CommandResult {
    const now = this.clock.now();
    const result = this.store.append(
      { idempotencyKey: input.idempotencyKey, at: now, type: "MergeConfirmedNotMerged", attemptId: input.attemptId },
      {
        clearDeadlines: [
          { kind: "merge-confirm", attemptId: input.attemptId },
          { kind: "execution", attemptId: input.attemptId },
        ],
        bumpAttemptRevision: true,
      },
    );
    if (result.status === "applied") {
      this.store.resolveMergeOperation(input.operationId, "CONFIRMED_NOT_MERGED", now);
    }
    return result;
  }

  recordTransition(input: {
    idempotencyKey: string;
    kind: "genesis" | "verified" | "override" | "external";
    transitionSequence: number;
    priorDigest: string | null;
    digest: string;
    baseSha: string;
    attemptId: string | null;
    witnessPrincipalIds: readonly string[];
  }): CommandResult {
    return this.store.append({
      idempotencyKey: input.idempotencyKey,
      at: this.clock.now(),
      type: "TransitionRecorded",
      kind: input.kind,
      transitionSequence: input.transitionSequence,
      priorDigest: input.priorDigest,
      digest: input.digest,
      baseSha: input.baseSha,
      attemptId: input.attemptId,
      witnessPrincipalIds: input.witnessPrincipalIds,
    });
  }

  terminateAttempt(input: { idempotencyKey: string; attemptId: string; outcome: AttemptOutcome }): CommandResult {
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: this.clock.now(),
        type: "AttemptTerminated",
        attemptId: input.attemptId,
        outcome: input.outcome,
      },
      {
        clearDeadlines: [
          { kind: "offer", attemptId: input.attemptId },
          { kind: "execution", attemptId: input.attemptId },
          { kind: "grace", attemptId: input.attemptId },
        ],
        bumpAttemptRevision: true,
      },
    );
  }

  expireOffer(input: { idempotencyKey: string; attemptId: string }): CommandResult {
    const now = this.clock.now();
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: now,
        type: "OfferExpired",
        attemptId: input.attemptId,
        cooldownUntil: plusSeconds(now, this.timings.noClaimCooldownSeconds),
      },
      {
        clearDeadlines: [{ kind: "offer", attemptId: input.attemptId }],
        bumpAttemptRevision: true,
      },
    );
  }

  observedExternalTransition(input: { idempotencyKey: string; observedBaseSha: string }): CommandResult {
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: this.clock.now(),
        type: "ExternalTransitionObserved",
        observedBaseSha: input.observedBaseSha,
      },
      {
        outbox: [{ kind: "notify-external-transition", payload: { observedBaseSha: input.observedBaseSha } }],
        bumpAttemptRevision: true,
      },
    );
  }

  pause(input: { idempotencyKey: string; actorPrincipalId: string; reason: string }): CommandResult {
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: this.clock.now(),
        type: "QueuePaused",
        actorPrincipalId: input.actorPrincipalId,
        reason: input.reason,
      },
      { bumpAttemptRevision: true },
    );
  }

  resume(input: { idempotencyKey: string; actorPrincipalId: string }): CommandResult {
    return this.store.append(
      { idempotencyKey: input.idempotencyKey, at: this.clock.now(), type: "QueueResumed", actorPrincipalId: input.actorPrincipalId },
      { bumpAttemptRevision: true },
    );
  }

  rebaseline(input: { idempotencyKey: string; actorPrincipalId: string; baseSha: string }): CommandResult {
    return this.store.append({
      idempotencyKey: input.idempotencyKey,
      at: this.clock.now(),
      type: "Rebaselined",
      actorPrincipalId: input.actorPrincipalId,
      baseSha: input.baseSha,
    });
  }

  cancel(input: { idempotencyKey: string; entryId: string; actorPrincipalId: string; reason: string }): CommandResult {
    return this.store.append(
      {
        idempotencyKey: input.idempotencyKey,
        at: this.clock.now(),
        type: "EntryCancelled",
        entryId: input.entryId,
        actorPrincipalId: input.actorPrincipalId,
        reason: input.reason,
      },
      { bumpAttemptRevision: true },
    );
  }

  /**
   * One alarm, every due deadline (plan.md §39.3). Delivery is at-least-once, so
   * each action carries a deadline-derived idempotency key and a second delivery
   * finds nothing left to do.
   */
  runAlarm(): { handled: Deadline[]; results: CommandResult[]; nextAlarm: string | null } {
    const now = this.clock.now();
    const due = this.store.dueDeadlines(now);
    const results: CommandResult[] = [];

    for (const deadline of due) {
      const key = `alarm:${deadline.kind}:${deadline.attemptId}:${deadline.dueAt}`;
      switch (deadline.kind) {
        case "offer":
          results.push(this.expireOffer({ idempotencyKey: key, attemptId: deadline.attemptId }));
          break;
        case "grace":
          // Grace expiry supersedes the attempt and defers the entry without
          // touching its place in line (§9.2).
          results.push(
            this.terminateAttempt({ idempotencyKey: key, attemptId: deadline.attemptId, outcome: "SUPERSEDED" }),
          );
          break;
        case "execution":
          results.push(
            this.terminateAttempt({
              idempotencyKey: key,
              attemptId: deadline.attemptId,
              outcome: "EXPIRED_EXECUTION",
            }),
          );
          break;
        case "merge-confirm":
          // Never a blind retry: ask for reconciliation instead (§40.1).
          results.push(this.mergeOutcomeUnknown({ idempotencyKey: key, attemptId: deadline.attemptId }));
          break;
        case "readiness":
          results.push({ status: "noop", detail: "readiness refresh is scheduled outside the object" });
          this.store.clearDeadline("readiness", deadline.attemptId);
          break;
      }
    }

    return { handled: due, results, nextAlarm: this.store.earliestDeadline() };
  }
}
