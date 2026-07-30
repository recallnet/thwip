import {
  ATTEMPT_OUTCOMES,
  BLOCKING_REASONS,
  TRANSITION_KINDS,
  isCapabilityReason,
  phaseRank,
  type AttemptOutcome,
  type AttemptPhase,
  type BlockingReason,
  type EntryState,
  type ExecutionMode,
  type TransitionKind,
} from "./reason-codes.js";
import { PHASE_FOR_EVENT, type QueueEvent } from "./events.js";

/**
 * The only interpreter of the branch queue event log.
 *
 * Everything here is pure and synchronous so the Durable Object, the tests, and
 * the TLA+ model can agree on what a log means. Where the specification says an
 * operation is forbidden, this reducer throws rather than quietly ignoring it:
 * a rejected command must be visible to its caller, and an impossible state
 * must never be reachable (plan.md §6.2 invariant 22).
 */

export class QueueRuleViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueRuleViolation";
  }
}

const fail = (message: string): never => {
  throw new QueueRuleViolation(message);
};

export interface Entry {
  readonly entryId: string;
  readonly pullRequestNumber: number;
  sponsorPrincipalId: string;
  sponsorGithubUserId: string;
  fairnessOrdinal: bigint;
  state: EntryState;
  primaryReason: BlockingReason | null;
  secondaryReasons: readonly BlockingReason[];
  schedulerEligible: boolean;
  cooldownUntil: string | null;
  headSha: string;
  currentAttemptId: string | null;
  lastAttemptId: string | null;
}

export interface Attempt {
  readonly attemptId: string;
  readonly entryId: string;
  readonly parentAttemptId: string | null;
  phase: AttemptPhase;
  outcome: AttemptOutcome | null;
  /** Set once by CandidatePrepared and immutable thereafter (§6.2 invariant 5). */
  baseSha: string | null;
  headSha: string | null;
  candidateSha: string | null;
  candidateTree: string | null;
  policyDigest: string | null;
  runner: string | null;
  readonly decisionDigest: string;
  assignmentDigest: string | null;
  receiptDigest: string | null;
  verificationNonce: string | null;
  intentDigest: string | null;
  offerDeadline: string;
  executionDeadline: string | null;
  graceUntil: string | null;
  executionMode: ExecutionMode | null;
  deviceId: string | null;
  /** True between MergeRequested and a confirmed outcome (§6.2 invariant 17). */
  outcomeUnknown: boolean;
  mergeSha: string | null;
  expedite: { actorPrincipalId: string; reason: string; capturedPrincipalIds: readonly string[] } | null;
}

export interface Transition {
  readonly kind: TransitionKind;
  readonly transitionSequence: number;
  readonly priorDigest: string | null;
  readonly digest: string;
  readonly baseSha: string;
  readonly attemptId: string | null;
  readonly witnessPrincipalIds: readonly string[];
}

export interface BranchQueueState {
  readonly queueKey: string;
  readonly repositoryId: string;
  readonly baseRef: string;
  lastSequence: number;
  turnSequence: bigint;
  ordinalSequence: bigint;
  paused: boolean;
  pauseReason: string | null;
  /** Set when the base moved outside the queue; cleared by a rebaseline (§6.2 invariant 21). */
  rebaselineRequired: boolean;
  baseSha: string | null;
  activeAttemptId: string | null;
  entries: Map<string, Entry>;
  attempts: Map<string, Attempt>;
  lastServedTurn: Map<string, bigint>;
  /** principal → principals owed an offer before that principal may expedite again (§8.4). */
  fairnessDebt: Map<string, readonly string[]>;
  appliedKeys: Set<string>;
  transitions: Transition[];
}

export function emptyState(queueKey: string, repositoryId: string, baseRef: string): BranchQueueState {
  return {
    queueKey,
    repositoryId,
    baseRef,
    lastSequence: 0,
    turnSequence: 0n,
    ordinalSequence: 0n,
    paused: false,
    pauseReason: null,
    rebaselineRequired: false,
    baseSha: null,
    activeAttemptId: null,
    entries: new Map(),
    attempts: new Map(),
    lastServedTurn: new Map(),
    fairnessDebt: new Map(),
    appliedKeys: new Set(),
    transitions: [],
  };
}

function requireEntry(state: BranchQueueState, entryId: string): Entry {
  return state.entries.get(entryId) ?? fail(`unknown entry ${entryId}`);
}

function requireAttempt(state: BranchQueueState, attemptId: string): Attempt {
  return state.attempts.get(attemptId) ?? fail(`unknown attempt ${attemptId}`);
}

/**
 * An attempt that already ended can never be touched again (§6.2 invariant 6).
 * A merged attempt is terminal too: success is recorded in the phase rather
 * than in `outcome`, which names only non-merge endings.
 */
function requireLive(attempt: Attempt): Attempt {
  if (attempt.outcome !== null) fail(`attempt ${attempt.attemptId} is terminated (${attempt.outcome})`);
  if (attempt.phase === "MERGED") fail(`attempt ${attempt.attemptId} is terminated (MERGED)`);
  return attempt;
}

function advancePhase(attempt: Attempt, next: AttemptPhase): void {
  if (phaseRank(next) < phaseRank(attempt.phase)) {
    fail(`attempt ${attempt.attemptId} cannot move backward from ${attempt.phase} to ${next}`);
  }
  attempt.phase = next;
}

function terminate(state: BranchQueueState, attempt: Attempt, outcome: AttemptOutcome): void {
  attempt.outcome = outcome;
  attempt.outcomeUnknown = false;
  if (state.activeAttemptId === attempt.attemptId) state.activeAttemptId = null;
  const entry = state.entries.get(attempt.entryId);
  if (entry !== undefined && entry.currentAttemptId === attempt.attemptId) {
    entry.currentAttemptId = null;
    entry.lastAttemptId = attempt.attemptId;
  }
}

/**
 * Every state but Blocked. Blocking goes through `blockEntry` so the reason is a
 * parameter rather than something a caller may forget: a live queue once held a
 * merged pull request in Blocked with a null reason, which every reader rendered
 * as though nothing were wrong.
 */
function setEntryState(entry: Entry, next: Exclude<EntryState, "Blocked">): void {
  entry.state = next;
}

function blockEntry(entry: Entry, reason: BlockingReason): void {
  entry.state = "Blocked";
  entry.primaryReason = reason;
}

/**
 * Why an entry is blocked after its turn ended badly.
 *
 * A total map rather than a default, so adding an attempt outcome forces a
 * decision about what a reader should be told instead of silently becoming
 * "needs repair".
 */
const BLOCK_REASON_FOR_OUTCOME: Record<AttemptOutcome, BlockingReason> = {
  EXPIRED_UNCLAIMED: "NEEDS_REPAIR",
  EXPIRED_EXECUTION: "NEEDS_REPAIR",
  CI_FAILED: "REQUIRED_CHECK_FAILED",
  RECEIPT_REJECTED: "LOCAL_RECEIPT_REJECTED",
  VERIFICATION_FAILED: "VERIFICATION_REJECTED",
  HEAD_MOVED: "NEEDS_REPAIR",
  BASE_MOVED: "NEEDS_REPAIR",
  POLICY_CHANGED: "POLICY_CHANGED",
  REVIEWS_CHANGED: "REVIEW_REQUIRED",
  PERMISSION_REVOKED: "APP_PERMISSION_DRIFT",
  MERGE_CONFLICT: "MERGE_CONFLICT",
  MERGE_REJECTED: "NEEDS_REPAIR",
  CONFIRMED_NOT_MERGED: "NEEDS_REPAIR",
  PROVIDER_FAILURE: "NEEDS_REPAIR",
  INVARIANT_FAILURE: "NEEDS_REPAIR",
  APP_UNINSTALLED: "APP_PERMISSION_DRIFT",
  ADMIN_CANCELLED: "NEEDS_REPAIR",
  SUPERSEDED: "NEEDS_REPAIR",
  INTERNAL_FAILURE: "NEEDS_REPAIR",
};

function checkReason(reason: BlockingReason | null): BlockingReason | null {
  if (reason === null) return null;
  if (!(BLOCKING_REASONS as readonly string[]).includes(reason)) {
    fail(`unknown blocking reason ${reason}`);
  }
  return reason;
}

/** Deep-clone the parts we mutate so callers never observe a partial apply. */
function cloneState(state: BranchQueueState): BranchQueueState {
  return {
    ...state,
    entries: new Map([...state.entries].map(([k, v]) => [k, { ...v }])),
    attempts: new Map([...state.attempts].map(([k, v]) => [k, { ...v }])),
    lastServedTurn: new Map(state.lastServedTurn),
    fairnessDebt: new Map(state.fairnessDebt),
    appliedKeys: new Set(state.appliedKeys),
    transitions: [...state.transitions],
  };
}

export function applyEvent(previous: BranchQueueState, event: QueueEvent): BranchQueueState {
  // Idempotency and ordering come first: a duplicate or already-consumed event
  // is a no-op, never an error (plan.md §6.2 invariant 3).
  if (previous.appliedKeys.has(event.idempotencyKey)) return previous;
  if (event.sequence <= previous.lastSequence) return previous;

  const state = cloneState(previous);
  state.lastSequence = event.sequence;
  state.appliedKeys.add(event.idempotencyKey);

  switch (event.type) {
    case "QueueRequested": {
      const existing = state.entries.get(event.entryId);
      if (existing !== undefined && event.resetOrdinal !== true) return previous;
      state.ordinalSequence += 1n;
      state.entries.set(event.entryId, {
        entryId: event.entryId,
        pullRequestNumber: event.pullRequestNumber,
        sponsorPrincipalId: event.sponsorPrincipalId,
        sponsorGithubUserId: event.sponsorGithubUserId,
        fairnessOrdinal: state.ordinalSequence,
        state: "Requested",
        primaryReason: null,
        secondaryReasons: [],
        schedulerEligible: false,
        cooldownUntil: null,
        headSha: event.headSha,
        currentAttemptId: null,
        lastAttemptId: existing?.lastAttemptId ?? null,
      });
      break;
    }

    case "ReadinessEvaluated": {
      const entry = requireEntry(state, event.entryId);
      const primary = checkReason(event.primaryReason);
      for (const secondary of event.secondaryReasons) checkReason(secondary);
      entry.primaryReason = primary;
      entry.secondaryReasons = [...event.secondaryReasons];
      // A capability reason suppresses scheduling without unsetting readiness,
      // so an offline laptop keeps its place (plan.md §7.1).
      entry.schedulerEligible = event.schedulerEligible;
      const capabilityOnly = primary !== null && isCapabilityReason(primary);
      if (entry.currentAttemptId === null && entry.state !== "Merged" && entry.state !== "Cancelled") {
        if (event.ready || capabilityOnly) {
          // A deferred entry returns to Ready once its cooldown has elapsed
          // (§9.3 "cooldown complete and capable"). Without this edge an entry
          // that forfeited one turn would never be offered another.
          if (entry.state === "Deferred") {
            if (entry.cooldownUntil === null || entry.cooldownUntil <= event.at) {
              entry.cooldownUntil = null;
              setEntryState(entry, "Ready");
            }
          } else if (entry.state !== "NeedsRepair") {
            setEntryState(entry, "Ready");
          }
        } else {
          // Not ready always comes with a reason from the readiness evaluation.
          // If it somehow did not, saying so beats saying nothing.
          blockEntry(entry, primary ?? "NEEDS_REPAIR");
        }
      }
      break;
    }

    case "EntryHeadChanged": {
      const entry = requireEntry(state, event.entryId);
      entry.headSha = event.headSha;
      break;
    }

    case "EntryOrdinalReset": {
      const entry = requireEntry(state, event.entryId);
      if (event.reason.trim() === "") fail("ordinal reset requires a reason");
      state.ordinalSequence += 1n;
      entry.fairnessOrdinal = state.ordinalSequence;
      break;
    }

    case "SponsorTransferred": {
      const entry = requireEntry(state, event.entryId);
      if (event.reason.trim() === "") fail("sponsor transfer requires a reason");
      entry.sponsorPrincipalId = event.toPrincipalId;
      entry.sponsorGithubUserId = event.toGithubUserId;
      // A fresh ordering point: the new sponsor does not inherit old priority.
      state.ordinalSequence += 1n;
      entry.fairnessOrdinal = state.ordinalSequence;
      break;
    }

    case "TurnOffered": {
      if (state.paused) fail("queue is paused; no turn may be offered");
      if (state.activeAttemptId !== null) fail("lane is occupied by another attempt");
      const entry = requireEntry(state, event.entryId);
      if (state.attempts.has(event.attemptId)) return previous;
      if (entry.state === "Merged" || entry.state === "Cancelled") {
        fail(`entry ${entry.entryId} is ${entry.state}`);
      }
      state.turnSequence += 1n;
      state.lastServedTurn.set(entry.sponsorPrincipalId, state.turnSequence);
      if (event.expedite !== undefined) {
        if (event.expedite.reason.trim() === "") fail("expedite requires a reason");
        state.fairnessDebt.set(entry.sponsorPrincipalId, [...event.expedite.capturedPrincipalIds]);
      }
      state.attempts.set(event.attemptId, {
        attemptId: event.attemptId,
        entryId: entry.entryId,
        parentAttemptId: entry.lastAttemptId,
        phase: "OFFERED",
        outcome: null,
        baseSha: null,
        headSha: null,
        candidateSha: null,
        candidateTree: null,
        policyDigest: null,
        runner: null,
        decisionDigest: event.decisionDigest,
        assignmentDigest: null,
        receiptDigest: null,
        verificationNonce: null,
        intentDigest: null,
        offerDeadline: event.offerDeadline,
        executionDeadline: null,
        graceUntil: null,
        executionMode: null,
        deviceId: null,
        outcomeUnknown: false,
        mergeSha: null,
        expedite: event.expedite === undefined ? null : { ...event.expedite },
      });
      entry.currentAttemptId = event.attemptId;
      entry.cooldownUntil = null;
      setEntryState(entry, "Offered");
      state.activeAttemptId = event.attemptId;
      break;
    }

    case "OfferClaimed": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.executionMode !== null) return previous;
      if (event.executionMode === "device" && event.deviceId === undefined) {
        fail("a device claim requires a device id");
      }
      advancePhase(attempt, "CLAIMED");
      attempt.executionMode = event.executionMode;
      attempt.deviceId = event.deviceId ?? null;
      setEntryState(requireEntry(state, attempt.entryId), "Active");
      break;
    }

    case "OfferExpired": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.phase !== "OFFERED") fail("only an unclaimed offer may expire unclaimed");
      terminate(state, attempt, "EXPIRED_UNCLAIMED");
      const entry = requireEntry(state, attempt.entryId);
      // The turn is spent, but the place in line is not (§6.2 invariant 12).
      entry.cooldownUntil = event.cooldownUntil;
      setEntryState(entry, "Deferred");
      break;
    }

    case "CandidatePrepared": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.candidateSha !== null) {
        fail(`attempt ${attempt.attemptId} candidate is immutable`);
      }
      advancePhase(attempt, "PREPARING_CANDIDATE");
      attempt.baseSha = event.baseSha;
      attempt.headSha = event.headSha;
      attempt.candidateSha = event.candidateSha;
      attempt.candidateTree = event.candidateTree;
      attempt.policyDigest = event.policyDigest;
      attempt.runner = event.runner;
      break;
    }

    case "AssignmentIssued": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.candidateSha === null) fail("cannot assign before the candidate is pinned");
      if (attempt.assignmentDigest !== null) fail(`attempt ${attempt.attemptId} assignment is immutable`);
      advancePhase(attempt, "ASSIGNED");
      attempt.assignmentDigest = event.assignmentDigest;
      attempt.executionDeadline = event.executionDeadline;
      break;
    }

    case "HeartbeatReceived": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.assignmentDigest === null) fail("cannot run before assignment");
      // A heartbeat that lands after the receipt is a normal race, not an
      // error, and it must not rewind the attempt.
      if (phaseRank(attempt.phase) > phaseRank("RUNNING")) return previous;
      advancePhase(attempt, "RUNNING");
      attempt.graceUntil = null;
      setEntryState(requireEntry(state, attempt.entryId), "Active");
      break;
    }

    case "HeartbeatLost": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.phase !== "RUNNING") fail("only a running attempt can lose heartbeats");
      // The lane stays held: no other attempt may start during grace (§9.2).
      attempt.graceUntil = event.graceUntil;
      setEntryState(requireEntry(state, attempt.entryId), "ReconnectGrace");
      break;
    }

    case "Reconnected": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.graceUntil === null) fail("attempt is not in reconnect grace");
      if (attempt.deviceId !== event.deviceId) {
        fail(`device ${event.deviceId} may not resume an attempt bound to ${attempt.deviceId}`);
      }
      attempt.graceUntil = null;
      setEntryState(requireEntry(state, attempt.entryId), "Active");
      break;
    }

    case "ReceiptSubmitted": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.assignmentDigest === null) fail("no assignment for this attempt");
      advancePhase(attempt, "RECEIPT_SUBMITTED");
      attempt.receiptDigest = event.receiptDigest;
      setEntryState(requireEntry(state, attempt.entryId), "Verifying");
      break;
    }

    case "VerificationStarted": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.receiptDigest === null) fail("no receipt to verify");
      advancePhase(attempt, "VERIFYING");
      attempt.verificationNonce = event.nonce;
      break;
    }

    case "VerificationCompleted": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      // One verdict, for one exact attempt and nonce (§6.2 invariant 15).
      if (attempt.verificationNonce === null) fail("verification was never started");
      if (attempt.verificationNonce !== event.nonce) {
        fail(`verifier nonce mismatch for attempt ${attempt.attemptId}`);
      }
      if (!event.accepted) {
        terminate(state, attempt, "VERIFICATION_FAILED");
        blockEntry(requireEntry(state, attempt.entryId), "VERIFICATION_REJECTED");
        break;
      }
      advancePhase(attempt, "VERIFIED");
      setEntryState(requireEntry(state, attempt.entryId), "MergeGuard");
      break;
    }

    case "MergeIntentCreated": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.phase !== "VERIFIED") {
        fail(`attempt ${attempt.attemptId} is not verified; no merge intent may exist`);
      }
      advancePhase(attempt, "MERGE_INTENT_CREATED");
      attempt.intentDigest = event.intentDigest;
      break;
    }

    case "MergeRequested": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.outcomeUnknown) fail("merge outcome is unknown; a second write is forbidden");
      if (attempt.intentDigest === null) fail("no signed merge intent for this attempt");
      if (attempt.phase === "MERGE_REQUESTED") return previous;
      advancePhase(attempt, "MERGE_REQUESTED");
      setEntryState(requireEntry(state, attempt.entryId), "Merging");
      break;
    }

    case "MergeOutcomeUnknown": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.phase !== "MERGE_REQUESTED") fail("no merge was requested");
      advancePhase(attempt, "AWAITING_CONFIRMATION");
      attempt.outcomeUnknown = true;
      setEntryState(requireEntry(state, attempt.entryId), "Reconciling");
      break;
    }

    case "MergeConfirmed": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.phase !== "MERGE_REQUESTED" && attempt.phase !== "AWAITING_CONFIRMATION") {
        fail("no merge was requested");
      }
      // A certificate is only issued for the exact candidate (§6.2 invariant 18).
      if (attempt.candidateTree === null || event.mergeTree !== attempt.candidateTree) {
        fail(`merged tree does not match the candidate tree for attempt ${attempt.attemptId}`);
      }
      attempt.outcomeUnknown = false;
      attempt.mergeSha = event.mergeSha;
      advancePhase(attempt, "MERGED");
      state.baseSha = event.mergeSha;
      state.activeAttemptId = null;
      const entry = requireEntry(state, attempt.entryId);
      entry.currentAttemptId = null;
      entry.lastAttemptId = attempt.attemptId;
      setEntryState(entry, "Merged");
      break;
    }

    case "MergeConfirmedNotMerged": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (!attempt.outcomeUnknown) fail("outcome was not in doubt");
      terminate(state, attempt, "CONFIRMED_NOT_MERGED");
      setEntryState(requireEntry(state, attempt.entryId), "Ready");
      break;
    }

    case "AttemptTerminated": {
      if (!(ATTEMPT_OUTCOMES as readonly string[]).includes(event.outcome)) {
        fail(`unknown attempt outcome ${event.outcome}`);
      }
      const attempt = requireAttempt(state, event.attemptId);
      if (attempt.outcome !== null) return previous;
      if (attempt.outcomeUnknown && event.outcome !== "PROVIDER_FAILURE" && event.outcome !== "INVARIANT_FAILURE") {
        fail("an unknown merge outcome may only be resolved by confirmation or operator ruling");
      }
      const entry = state.entries.get(attempt.entryId);
      terminate(state, attempt, event.outcome);
      if (entry !== undefined && entry.state !== "Merged" && entry.state !== "Cancelled") {
        if (event.outcome === "SUPERSEDED" || event.outcome === "EXPIRED_EXECUTION") {
          setEntryState(entry, "Deferred");
        } else {
          blockEntry(entry, BLOCK_REASON_FOR_OUTCOME[event.outcome as AttemptOutcome]);
        }
      }
      break;
    }

    case "TransitionRecorded": {
      if (!(TRANSITION_KINDS as readonly string[]).includes(event.kind)) {
        fail(`unknown transition kind ${event.kind}`);
      }
      const last = state.transitions.at(-1) ?? null;
      const expected = (last?.transitionSequence ?? 0) + 1;
      if (event.transitionSequence !== expected) {
        fail(`transition sequence must be consecutive: expected ${expected}`);
      }
      if ((last?.digest ?? null) !== event.priorDigest) {
        fail("transition must link the prior digest");
      }
      if (event.attemptId !== null) {
        const attempt = requireAttempt(state, event.attemptId);
        // Failed attempts never enter the chain (§6.2 invariant 20).
        if (attempt.phase !== "MERGED") fail(`attempt ${event.attemptId} did not merge`);
      }
      state.transitions.push({
        kind: event.kind,
        transitionSequence: event.transitionSequence,
        priorDigest: event.priorDigest,
        digest: event.digest,
        baseSha: event.baseSha,
        attemptId: event.attemptId,
        witnessPrincipalIds: [...event.witnessPrincipalIds],
      });
      break;
    }

    case "ExternalTransitionObserved": {
      // Unexpected base movement pauses the queue (§6.2 invariant 21).
      state.paused = true;
      state.pauseReason = "EXTERNAL_TRANSITION";
      state.rebaselineRequired = true;
      state.baseSha = event.observedBaseSha;
      const last = state.transitions.at(-1) ?? null;
      state.transitions.push({
        kind: "external",
        transitionSequence: (last?.transitionSequence ?? 0) + 1,
        priorDigest: last?.digest ?? null,
        digest: `external:${event.observedBaseSha}`,
        baseSha: event.observedBaseSha,
        attemptId: null,
        witnessPrincipalIds: [],
      });
      break;
    }

    case "QueuePaused": {
      state.paused = true;
      state.pauseReason = event.reason;
      break;
    }

    case "QueueResumed": {
      if (state.rebaselineRequired) fail("a rebaseline is required before the queue may resume");
      state.paused = false;
      state.pauseReason = null;
      break;
    }

    case "Rebaselined": {
      state.rebaselineRequired = false;
      state.baseSha = event.baseSha;
      break;
    }

    case "EntryCancelled": {
      const entry = requireEntry(state, event.entryId);
      if (entry.currentAttemptId !== null) {
        const attempt = state.attempts.get(entry.currentAttemptId);
        if (attempt !== undefined && attempt.outcome === null) {
          if (attempt.outcomeUnknown) fail("cannot cancel while a merge outcome is unknown");
          terminate(state, attempt, "ADMIN_CANCELLED");
        }
      }
      setEntryState(entry, "Cancelled");
      break;
    }

    default: {
      const unknown = event as { type?: unknown };
      fail(`unknown queue event ${String(unknown.type)}`);
    }
  }

  return state;
}

export function applyEvents(state: BranchQueueState, events: readonly QueueEvent[]): BranchQueueState {
  return events.reduce(applyEvent, state);
}
