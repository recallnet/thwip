import type { QueueCommands } from "./commands.js";
import type { QueueStateStore, TransitionRow } from "./store.js";

/**
 * What the queue does, separated from where its state lives.
 *
 * These were methods on the Durable Object. They are pure functions of a store
 * and a command layer, and both places the state can live now call the same code:
 * the object, and the D1 document that took it out of the decision path. Leaving
 * them on the object would have meant a second copy of the merge walk, and two
 * copies of "may this pull request merge" is the one duplication this product
 * cannot afford.
 */

export interface QueueSnapshot {
  generation: number;
  attemptRevision: number;
  queueEpoch: number;
  paused: boolean;
  pauseReason: string | null;
  rebaselineRequired: boolean;
  baseSha: string | null;
  activeAttemptId: string | null;
  /** The entry whose attempt holds the lane, so a caller can act on the entry too. */
  activeEntryId: string | null;
  chainHead: { sequence: number; digest: string } | null;
  /** The whole recorded chain, oldest first, so a reader can check the links. */
  transitions: readonly TransitionRow[];
  entries: Array<{
    entryId: string;
    pullRequestNumber: number;
    sponsorPrincipalId: string;
    state: string;
    primaryReason: string | null;
    schedulerEligible: boolean;
    fairnessOrdinal: string;
    cooldownUntil: string | null;
    /** Lets a reader join a recorded transition back to the pull request it merged. */
    lastAttemptId: string | null;
    /** So a projection reader can tell it is answering about this commit. */
    headSha: string | null;
  }>;
}

export function buildSnapshot(store: QueueStateStore): QueueSnapshot {
  const state = store.state();
  const head = state.transitions.at(-1);
  return {
    generation: store.generation(),
    attemptRevision: store.attemptRevision(),
    queueEpoch: store.queueEpoch(),
    paused: state.paused,
    pauseReason: state.pauseReason,
    rebaselineRequired: state.rebaselineRequired,
    baseSha: state.baseSha,
    activeAttemptId: state.activeAttemptId,
    activeEntryId:
      state.activeAttemptId === null ? null : (state.attempts.get(state.activeAttemptId)?.entryId ?? null),
    chainHead: head === undefined ? null : { sequence: head.transitionSequence, digest: head.digest },
    transitions: store.transitionChain(),
    // Projected order only: an exact permanent position would be a lie, because
    // readiness changes after every GitHub event (plan.md §8.3).
    entries: [...state.entries.values()]
      .sort((a, b) => (a.fairnessOrdinal < b.fairnessOrdinal ? -1 : 1))
      .map((entry) => ({
        entryId: entry.entryId,
        pullRequestNumber: entry.pullRequestNumber,
        sponsorPrincipalId: entry.sponsorPrincipalId,
        state: entry.state,
        primaryReason: entry.primaryReason,
        schedulerEligible: entry.schedulerEligible,
        fairnessOrdinal: entry.fairnessOrdinal.toString(),
        cooldownUntil: entry.cooldownUntil,
        lastAttemptId: entry.lastAttemptId ?? entry.currentAttemptId,
        headSha: entry.headSha,
      })),
  };
}

export interface AdmitInput {
  entryId: string;
  pullRequestNumber: number;
  sponsorPrincipalId: string;
  sponsorGithubUserId: string;
  headSha: string;
  ready: boolean;
  schedulerEligible: boolean;
  primaryReason: string | null;
  readinessBucket: number;
  tickBucket: number;
  decisionDigest: string;
}

/**
 * Everything the merge gate does to get a pull request holding the lane.
 *
 * Enqueue, evaluate readiness, tick the scheduler, claim the offer. The reducer
 * still decides each step and each is still its own event in the log.
 */
export function admit(commands: QueueCommands, store: QueueStateStore, input: AdmitInput): QueueSnapshot {
  commands.requestQueue({
    idempotencyKey: `authorize:request:${input.entryId}`,
    entryId: input.entryId,
    pullRequestNumber: input.pullRequestNumber,
    sponsorPrincipalId: input.sponsorPrincipalId,
    sponsorGithubUserId: input.sponsorGithubUserId,
    headSha: input.headSha,
  });
  commands.evaluateReadiness({
    idempotencyKey: `authorize:ready:${input.entryId}:${input.headSha}:${input.readinessBucket}`,
    entryId: input.entryId,
    ready: input.ready,
    schedulerEligible: input.schedulerEligible,
    primaryReason: input.primaryReason as never,
  });
  commands.tick({
    idempotencyKey: `authorize:tick:${input.entryId}:${input.headSha}:${input.tickBucket}`,
    decisionDigest: input.decisionDigest,
  });

  // Claim on the server's behalf. In this gate the required check is the
  // consumer, so an unclaimed offer would expire and the branch would be told to
  // wait forever (plan.md §8.2).
  const state = store.state();
  const attemptId = state.activeAttemptId;
  if (attemptId !== null && state.entries.get(input.entryId)?.state === "Offered") {
    commands.claim({
      idempotencyKey: `authorize:claim:${attemptId}`,
      attemptId,
      executionMode: "fast-reuse",
    });
  }
  return buildSnapshot(store);
}

export interface WalkInput {
  attemptId: string;
  baseSha: string;
  headSha: string;
  candidateSha: string;
  candidateTree: string;
  policyDigest: string;
  runner: string;
  assignmentDigest: string;
  receiptDigest: string;
  verifierResultDigest: string;
  intentDigest: string;
  operationId: string;
}

/**
 * Walk a held attempt to the point a merge may be written.
 *
 * Each step is still a separate event in the log and the reducer still refuses
 * any it considers out of order.
 */
export function walkToMergeReady(
  commands: QueueCommands,
  store: QueueStateStore,
  input: WalkInput,
): { operationId: string | null; snapshot: QueueSnapshot } {
  const ok = (r: { status: string }) => r.status === "applied" || r.status === "duplicate";
  const done = (operationId: string | null) => ({ operationId, snapshot: buildSnapshot(store) });

  const prepared = commands.candidatePrepared({
    idempotencyKey: `authorize:candidate:${input.attemptId}`,
    attemptId: input.attemptId,
    baseSha: input.baseSha,
    headSha: input.headSha,
    candidateSha: input.candidateSha,
    candidateTree: input.candidateTree,
    policyDigest: input.policyDigest,
    runner: input.runner as never,
  });
  if (!ok(prepared)) return done(null);

  commands.assign({
    idempotencyKey: `authorize:assign:${input.attemptId}`,
    attemptId: input.attemptId,
    assignmentDigest: input.assignmentDigest,
  });
  commands.submitReceipt({
    idempotencyKey: `authorize:receipt:${input.attemptId}`,
    attemptId: input.attemptId,
    receiptDigest: input.receiptDigest,
  });
  const started = commands.startVerification({
    idempotencyKey: `authorize:verify:${input.attemptId}`,
    attemptId: input.attemptId,
  });
  const nonce = "nonce" in started ? (started as { nonce: string }).nonce : undefined;
  if (nonce === undefined) return done(null);

  commands.completeVerification({
    idempotencyKey: `authorize:verdict:${input.attemptId}`,
    attemptId: input.attemptId,
    nonce,
    accepted: true,
    resultDigest: input.verifierResultDigest,
  });
  commands.createMergeIntent({
    idempotencyKey: `authorize:intent:${input.attemptId}`,
    attemptId: input.attemptId,
    intentDigest: input.intentDigest,
  });
  const begun = commands.beginMergeWrite({
    idempotencyKey: `authorize:write:${input.attemptId}`,
    attemptId: input.attemptId,
    operationId: input.operationId,
  });
  return done(begun.status === "applied" || begun.status === "already-started" ? input.operationId : null);
}

export interface ConfirmInput {
  attemptId: string;
  operationId: string;
  mergeSha: string;
  mergeTree: string;
  parentShas: readonly string[];
  transitionDigest: string;
  witnessPrincipalIds: readonly string[];
}

/**
 * Confirm the merge and record the transition it produced.
 *
 * The sequence and prior digest are derived here rather than passed in. A caller
 * computing them from a snapshot it fetched earlier is a caller racing the queue
 * over its own chain.
 */
export function confirmAndRecord(
  commands: QueueCommands,
  store: QueueStateStore,
  input: ConfirmInput,
): {
  confirmed: ReturnType<QueueCommands["confirmMerge"]>;
  transition: ReturnType<QueueCommands["recordTransition"]> | null;
  sequence: number | null;
  snapshot: QueueSnapshot;
} {
  const confirmed = commands.confirmMerge({
    idempotencyKey: `merged:${input.attemptId}`,
    attemptId: input.attemptId,
    operationId: input.operationId,
    mergeSha: input.mergeSha,
    mergeTree: input.mergeTree,
    parentShas: [...input.parentShas],
  });
  if (confirmed.status === "rejected") {
    return { confirmed, transition: null, sequence: null, snapshot: buildSnapshot(store) };
  }

  const head = store.state().transitions.at(-1);
  const sequence = (head?.transitionSequence ?? 0) + 1;
  const transition = commands.recordTransition({
    idempotencyKey: `transition:${input.attemptId}`,
    kind: "verified",
    transitionSequence: sequence,
    priorDigest: head?.digest ?? null,
    digest: input.transitionDigest,
    baseSha: input.mergeSha,
    attemptId: input.attemptId,
    witnessPrincipalIds: [...input.witnessPrincipalIds],
  });
  return { confirmed, transition, sequence, snapshot: buildSnapshot(store) };
}
