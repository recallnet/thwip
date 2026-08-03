import {
  ATTEMPT_OUTCOMES,
  BLOCKING_REASONS,
  TRANSITION_KINDS,
  TERMINAL_ENTRY_STATES,
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
  /**
   * What the verifier said, kept so the transition record can cite it.
   *
   * The verdict arrived and was thrown away, so the chain had nothing to bind to
   * and its links became the merge commit id with a `sha256:` prefix — a log
   * rather than an attestation.
   */
  verifierResultDigest: string | null;
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
 * Whether the queue may still commit to a merge write.
 *
 * The two conditions live here rather than at the callers because a merge write
 * is the one thing the queue does that nothing can take back, and every guard
 * this codebase has left to a caller has eventually been forgotten by one of
 * them. The route that authorizes a turn already refuses both, and the merge
 * callback reaches the log without passing through that route.
 *
 * A pause refuses the merge outright. It is the single lever an operator has
 * during an incident, the attempt holding the lane is usually the one they are
 * trying to stop, and the `Thwip / Merge` check already tells whoever reads it
 * that nothing merges through a paused queue. Refusing here is what makes that
 * sentence true.
 *
 * A pending rebaseline refuses it too: the candidate was integrated against a
 * base that no longer exists, so a `verified` transition for it would name a
 * base the queue never saw. The caller terminates the attempt BASE_MOVED and the
 * pull request takes a fresh turn once the queue is rebaselined.
 *
 * Confirmation is deliberately outside this gate. `MergeConfirmed` and
 * `MergeConfirmedNotMerged` report what GitHub already did, and refusing a fact
 * would leave the log denying a merge that exists and an unknown outcome that
 * nothing could ever resolve. The stop belongs on the write, not on the news.
 */
function requireMergeable(state: BranchQueueState, attempt: Attempt): void {
  if (state.rebaselineRequired) {
    fail(`BASE_MOVED: the base moved outside the queue; attempt ${attempt.attemptId} may not merge onto it`);
  }
  if (state.paused) {
    fail(
      `QUEUE_PAUSED: the queue is paused (${state.pauseReason ?? "no reason recorded"}); ` +
        `attempt ${attempt.attemptId} may not merge`,
    );
  }
}

/**
 * Merged and Cancelled are endings, not stages. A merged pull request has a
 * signed transition record naming it, so moving its entry anywhere else leaves
 * the queue contradicting the chain: the turn check goes back to reporting a
 * pull request that is in `main` as still waiting for a lane. The guard sits on the two
 * functions that write `state` so that no event handler has to remember it, and
 * an event that would move a finished entry is refused rather than applied.
 */
function requireOpen(entry: Entry, next: EntryState): void {
  if ((TERMINAL_ENTRY_STATES as readonly string[]).includes(entry.state)) {
    fail(`ENTRY_TERMINAL: entry ${entry.entryId} is ${entry.state}; it cannot become ${next}`);
  }
}

/**
 * Every state but Blocked. Blocking goes through `blockEntry` so the reason is a
 * parameter rather than something a caller may forget: a live queue once held a
 * merged pull request in Blocked with a null reason, which every reader rendered
 * as though nothing were wrong.
 */
function setEntryState(entry: Entry, next: Exclude<EntryState, "Blocked">): void {
  requireOpen(entry, next);
  entry.state = next;
}

function blockEntry(entry: Entry, reason: BlockingReason): void {
  requireOpen(entry, "Blocked");
  entry.state = "Blocked";
  entry.primaryReason = reason;
}

/**
 * Where an entry lands when its turn ends without a merge.
 *
 * `defer` keeps the place in line and waits for another turn. It is the answer
 * whenever the ending asks nothing of anybody: the offer lapsed, the deadline
 * passed, a newer attempt took over, or the source moved under the turn. The
 * queue takes a fresh turn against what is there now, and the developer reads a
 * pull request that is waiting rather than one that is broken.
 *
 * `block` names a reason, and the reason is what the dashboard, the GitHub check
 * and the terminal all say. Ten endings used to share `NEEDS_REPAIR`, so an
 * administrator cancelling a turn, GitHub refusing the merge and the queue
 * contradicting itself all read as "the integration failed, push a fix". They
 * are grouped here by what the person reading has to do next.
 *
 * A total map rather than a default, so adding an attempt outcome forces a
 * decision about what a reader is told.
 */
type Ending = { readonly kind: "defer" } | { readonly kind: "block"; readonly reason: BlockingReason };

const DEFER: Ending = { kind: "defer" };

function blocked(reason: BlockingReason): Ending {
  return { kind: "block", reason };
}

const ENDING_FOR_OUTCOME: Record<AttemptOutcome, Ending> = {
  // Nothing to do. The turn is spent and the place is not.
  EXPIRED_UNCLAIMED: DEFER,
  EXPIRED_EXECUTION: DEFER,
  SUPERSEDED: DEFER,
  // The source changed, so this turn's proof no longer covers what would merge.
  // The next turn builds a candidate from the new head or the new base.
  HEAD_MOVED: DEFER,
  BASE_MOVED: DEFER,
  // Something about the pull request has to change before it can merge.
  CI_FAILED: blocked("REQUIRED_CHECK_FAILED"),
  RECEIPT_REJECTED: blocked("LOCAL_RECEIPT_REJECTED"),
  VERIFICATION_FAILED: blocked("VERIFICATION_REJECTED"),
  MERGE_CONFLICT: blocked("MERGE_CONFLICT"),
  POLICY_CHANGED: blocked("POLICY_CHANGED"),
  REVIEWS_CHANGED: blocked("REVIEW_REQUIRED"),
  // A permission changed. `PERMISSION_REVOKED` is the sponsor's own access, which
  // `APP_PERMISSION_DRIFT` used to report as the App missing a scope, sending an
  // admin to reinstall an App that is installed correctly.
  PERMISSION_REVOKED: blocked("OWNER_UNAUTHORIZED"),
  APP_UNINSTALLED: blocked("APP_PERMISSION_DRIFT"),
  // GitHub would not complete the merge. The rules on the base branch, or the
  // pull request itself, are where the answer is.
  MERGE_REJECTED: blocked("MERGE_REJECTED"),
  CONFIRMED_NOT_MERGED: blocked("MERGE_REJECTED"),
  // The queue cannot say what happened to the merge. Nobody should push or
  // requeue until the pull request has been read.
  PROVIDER_FAILURE: blocked("MERGE_OUTCOME_UNKNOWN"),
  // A person stopped this turn, and only that person knows why.
  ADMIN_CANCELLED: blocked("ADMIN_CANCELLED"),
  // The queue broke. No push fixes this, so it goes to whoever runs the queue.
  INVARIANT_FAILURE: blocked("INTERNAL_FAILURE"),
  INTERNAL_FAILURE: blocked("INTERNAL_FAILURE"),
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
      // Closing and reopening a pull request re-requests it with a fresh
      // ordinal while its turn is still held. The rebuilt entry owns no attempt,
      // so the live one kept the lane and no entry could give it back: every
      // later offer failed on "lane is occupied by another attempt" until the
      // deadline sweep reaped it. The reset ends that turn instead.
      if (existing?.currentAttemptId != null) {
        const held = state.attempts.get(existing.currentAttemptId);
        if (held !== undefined && held.outcome === null) {
          // A merge write already sent to GitHub cannot be superseded: nothing
          // here knows whether it landed, and only confirmation may say.
          if (held.outcomeUnknown) fail("cannot re-request an entry while a merge outcome is unknown");
          terminate(state, held, "SUPERSEDED");
        }
      }
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

      // A finished entry takes nothing from a readiness evaluation, not even
      // the reason it carries. This used to guard the state alone, and write
      // the reason and eligibility first, so a heartbeat could report a
      // permanently Cancelled entry as ready to run and erase the reason it
      // was not running. Terminal means terminal, everywhere.
      if (entry.state === "Merged" || entry.state === "Cancelled") break;

      entry.primaryReason = primary;
      entry.secondaryReasons = [...event.secondaryReasons];
      // A capability reason suppresses scheduling without unsetting readiness,
      // so an offline laptop keeps its place (plan.md §7.1).
      entry.schedulerEligible = event.schedulerEligible;
      const capabilityOnly = primary !== null && isCapabilityReason(primary);
      if (entry.currentAttemptId === null) {
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
        verifierResultDigest: null,
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
      // Two runners for the same sponsor can race one offer. Swallowing the
      // loser's claim told it nothing, so it went on believing it held the turn
      // and everything it sent afterwards was ignored or credited to the winner.
      // The same claim arriving twice is a redelivery and stays a no-op.
      if (attempt.executionMode !== null) {
        const sameClaim =
          attempt.executionMode === event.executionMode && attempt.deviceId === (event.deviceId ?? null);
        if (sameClaim) return previous;
        fail(
          `OFFER_ALREADY_CLAIMED: attempt ${attempt.attemptId} was already claimed by ` +
            `${attempt.deviceId ?? attempt.executionMode}`,
        );
      }
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
      // An assignment is the queue telling a runner to run something. A reuse
      // attempt is never told anything — the server claims its own offer and the
      // evidence is the proof already on the head — so there is nothing to have
      // been assigned. Demanding one here forced the caller to invent a digest
      // and store it, which is how a value naming nothing reached a signed
      // record. Everywhere a runner really was dispatched, the gate still holds.
      if (attempt.executionMode !== "fast-reuse" && attempt.assignmentDigest === null) {
        fail("no assignment for this attempt");
      }
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
      // The nonce stays valid for the life of the attempt, so at-least-once
      // delivery hands the same verdict back long after it was acted on. Once
      // the attempt is verified, the merge gate has read the result and the
      // intent may already be signed over it, so a later verdict has nothing
      // left to decide.
      //
      // A repeat acceptance asks for nothing, so it is dropped: applying it
      // would rewrite verifierResultDigest, and the transition record cites that
      // field, so the chain could name evidence the gate never read. A late
      // rejection asks the queue to unwind a commitment it has already made —
      // terminating an attempt whose merge may be landing on GitHub, and handing
      // the lane to the next pull request while it lands — so it is refused
      // loudly rather than obeyed.
      if (phaseRank(attempt.phase) >= phaseRank("VERIFIED")) {
        if (event.accepted) return previous;
        fail(`VERDICT_TOO_LATE: attempt ${attempt.attemptId} is already ${attempt.phase}; the verdict cannot be revised`);
      }
      if (!event.accepted) {
        terminate(state, attempt, "VERIFICATION_FAILED");
        blockEntry(requireEntry(state, attempt.entryId), "VERIFICATION_REJECTED");
        break;
      }
      // Only a reuse attempt may be accepted without a result. Anywhere a
      // verifier really ran, its result is the whole basis of the acceptance,
      // and letting it be absent would leave nothing to distinguish a checked
      // candidate from an unchecked one.
      if (event.resultDigest === null && attempt.executionMode !== "fast-reuse") {
        fail("a verified attempt requires the verifier's result");
      }
      attempt.verifierResultDigest = event.resultDigest;
      advancePhase(attempt, "VERIFIED");
      setEntryState(requireEntry(state, attempt.entryId), "MergeGuard");
      break;
    }

    case "MergeIntentCreated": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.phase !== "VERIFIED") {
        fail(`attempt ${attempt.attemptId} is not verified; no merge intent may exist`);
      }
      requireMergeable(state, attempt);
      advancePhase(attempt, "MERGE_INTENT_CREATED");
      attempt.intentDigest = event.intentDigest;
      break;
    }

    case "MergeRequested": {
      const attempt = requireLive(requireAttempt(state, event.attemptId));
      if (attempt.outcomeUnknown) fail("merge outcome is unknown; a second write is forbidden");
      if (attempt.intentDigest === null) fail("no signed merge intent for this attempt");
      if (attempt.phase === "MERGE_REQUESTED") return previous;
      requireMergeable(state, attempt);
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
      const refused = requireEntry(state, attempt.entryId);
      // Deferred with a cooldown, not straight back to Ready.
      //
      // The turn is spent: something refused this merge, and whatever it was is
      // usually still true a second later. Returning the entry to Ready handed
      // the lane straight back to the pull request that had just failed to take
      // it, so the queue could refuse the same merge over and over while
      // everything behind it waited. The place in line is kept, as it is for an
      // offer nobody claimed (§6.2 invariant 12).
      refused.cooldownUntil = event.cooldownUntil;
      setEntryState(refused, "Deferred");
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
        // One fact, one answer. An offer nobody claimed used to land in
        // Deferred when `OfferExpired` noticed the deadline and in Blocked
        // NEEDS_REPAIR when the same deadline arrived as a termination, so what
        // the developer read depended on which sweep got there first.
        const ending = ENDING_FOR_OUTCOME[event.outcome as AttemptOutcome];
        if (ending.kind === "defer") {
          // The cooldown is what paces a re-offer. The scheduler now considers a
          // Deferred entry whether or not it carries one, so an entry deferred
          // for a reason that has not gone away would otherwise be offered the
          // lane, forfeit it, and be offered it again on the next sweep. With a
          // cooldown it waits the same interval an unclaimed offer waits, and
          // whatever is behind it gets the lane meanwhile.
          entry.cooldownUntil = event.cooldownUntil ?? null;
          setEntryState(entry, "Deferred");
        } else {
          blockEntry(entry, ending.reason);
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
      // The chain is not extended, because nothing signed anything.
      //
      // This used to push a link carrying `external:<sha>` where a record digest
      // belongs. Every signature the queue makes afterwards names the chain head
      // as `previousTransitionDigest` — the assignment a device is handed, and
      // the merge intent behind a merge — and both are checked against the
      // protocol, which only knows `sha256:` digests. So one commit pushed
      // straight to the base left the branch unable to issue another assignment
      // at all: the claim came back `ASSIGNMENT_INVALID`, rebaselined or not.
      //
      // Nothing is lost by leaving it out. The move is on the event log, in the
      // pause, in `rebaselineRequired` and in `baseSha`, and a link no reader can
      // fetch was never evidence of it.
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
      // An administrator ejecting an entry a second after it merged, or a close
      // webhook replayed against a merged pull request, is late rather than
      // wrong. There is nothing left to cancel, so the cancel does nothing. A
      // second cancel of a cancelled entry is the same story.
      if ((TERMINAL_ENTRY_STATES as readonly string[]).includes(entry.state)) return previous;
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
