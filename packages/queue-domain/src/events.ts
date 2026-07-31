import type {
  AttemptOutcome,
  AttemptPhase,
  BlockingReason,
  EntryState,
  ExecutionMode,
  TransitionKind,
} from "./reason-codes.js";

/**
 * The branch queue is an event log. The Durable Object owns the log; this
 * module defines what may be written to it, and `reducer.ts` is the only thing
 * that interprets it.
 *
 * Every event carries an idempotency key supplied by the caller and a
 * repository-local sequence assigned on append (plan.md §6.2 invariant 3), so
 * a duplicated webhook, a retried command, and a replayed alarm all converge
 * on the same state.
 */

export interface EventEnvelope {
  /** Repository-local, strictly increasing, assigned on append. */
  readonly sequence: number;
  /** Caller-supplied; a repeat of a seen key is ignored. */
  readonly idempotencyKey: string;
  readonly at: string;
}

export type QueueEvent = EventEnvelope &
  (
    | {
        readonly type: "QueueRequested";
        readonly entryId: string;
        readonly pullRequestNumber: number;
        readonly sponsorPrincipalId: string;
        readonly sponsorGithubUserId: string;
        readonly headSha: string;
        /** Set only when re-requesting after close/reopen (plan.md §8.4). */
        readonly resetOrdinal?: boolean;
      }
    | {
        readonly type: "ReadinessEvaluated";
        readonly entryId: string;
        readonly ready: boolean;
        readonly schedulerEligible: boolean;
        readonly primaryReason: BlockingReason | null;
        readonly secondaryReasons: readonly BlockingReason[];
      }
    | { readonly type: "EntryHeadChanged"; readonly entryId: string; readonly headSha: string }
    | {
        readonly type: "EntryOrdinalReset";
        readonly entryId: string;
        readonly actorPrincipalId: string;
        readonly reason: string;
      }
    | {
        readonly type: "SponsorTransferred";
        readonly entryId: string;
        readonly toPrincipalId: string;
        readonly toGithubUserId: string;
        readonly actorPrincipalId: string;
        readonly reason: string;
      }
    | {
        readonly type: "TurnOffered";
        readonly entryId: string;
        readonly attemptId: string;
        readonly offerDeadline: string;
        readonly decisionDigest: string;
        /** Present when an administrator expedited this turn (plan.md §8.4). */
        readonly expedite?: {
          readonly actorPrincipalId: string;
          readonly reason: string;
          readonly capturedPrincipalIds: readonly string[];
        };
      }
    | {
        readonly type: "OfferClaimed";
        readonly attemptId: string;
        readonly executionMode: ExecutionMode;
        /** Absent for synthetic service claims. */
        readonly deviceId?: string;
      }
    | { readonly type: "OfferExpired"; readonly attemptId: string; readonly cooldownUntil: string }
    | {
        readonly type: "CandidatePrepared";
        readonly attemptId: string;
        readonly baseSha: string;
        readonly headSha: string;
        readonly candidateSha: string;
        readonly candidateTree: string;
        readonly policyDigest: string;
        readonly runner: string;
      }
    | {
        readonly type: "AssignmentIssued";
        readonly attemptId: string;
        readonly assignmentDigest: string;
        readonly executionDeadline: string;
      }
    | { readonly type: "HeartbeatReceived"; readonly attemptId: string }
    | { readonly type: "HeartbeatLost"; readonly attemptId: string; readonly graceUntil: string }
    | { readonly type: "Reconnected"; readonly attemptId: string; readonly deviceId: string }
    | { readonly type: "ReceiptSubmitted"; readonly attemptId: string; readonly receiptDigest: string }
    | { readonly type: "VerificationStarted"; readonly attemptId: string; readonly nonce: string }
    | {
        readonly type: "VerificationCompleted";
        readonly attemptId: string;
        readonly nonce: string;
        readonly accepted: boolean;
        readonly resultDigest: string;
      }
    | { readonly type: "MergeIntentCreated"; readonly attemptId: string; readonly intentDigest: string }
    | { readonly type: "MergeRequested"; readonly attemptId: string }
    | { readonly type: "MergeOutcomeUnknown"; readonly attemptId: string }
    | {
        readonly type: "MergeConfirmed";
        readonly attemptId: string;
        readonly mergeSha: string;
        readonly mergeTree: string;
        readonly parentShas: readonly string[];
      }
    | {
        readonly type: "MergeConfirmedNotMerged";
        readonly attemptId: string;
        /** The turn is spent even though nothing merged; the place in line is not. */
        readonly cooldownUntil: string;
      }
    | {
        readonly type: "AttemptTerminated";
        readonly attemptId: string;
        readonly outcome: AttemptOutcome;
      }
    | {
        readonly type: "TransitionRecorded";
        readonly kind: TransitionKind;
        readonly transitionSequence: number;
        readonly priorDigest: string | null;
        readonly digest: string;
        readonly baseSha: string;
        readonly attemptId: string | null;
        readonly witnessPrincipalIds: readonly string[];
      }
    | { readonly type: "ExternalTransitionObserved"; readonly observedBaseSha: string }
    | { readonly type: "QueuePaused"; readonly actorPrincipalId: string; readonly reason: string }
    | { readonly type: "QueueResumed"; readonly actorPrincipalId: string }
    | { readonly type: "Rebaselined"; readonly actorPrincipalId: string; readonly baseSha: string }
    | {
        readonly type: "EntryCancelled";
        readonly entryId: string;
        readonly actorPrincipalId: string;
        readonly reason: string;
      }
  );

export type QueueEventType = QueueEvent["type"];

/** Phase each event drives an attempt to. Absent means the event is not a phase move. */
export const PHASE_FOR_EVENT: Partial<Record<QueueEventType, AttemptPhase>> = {
  TurnOffered: "OFFERED",
  OfferClaimed: "CLAIMED",
  CandidatePrepared: "PREPARING_CANDIDATE",
  AssignmentIssued: "ASSIGNED",
  HeartbeatReceived: "RUNNING",
  ReceiptSubmitted: "RECEIPT_SUBMITTED",
  VerificationStarted: "VERIFYING",
  MergeIntentCreated: "MERGE_INTENT_CREATED",
  MergeRequested: "MERGE_REQUESTED",
  MergeConfirmed: "MERGED",
};
