import { QueueCommands, type QueueTimings } from "./commands.js";
import type { SnapshotQueueStore } from "./snapshot-store.js";
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

/**
 * The command layer over a store, built the same way wherever it runs.
 *
 * The clock and the identifier source are injected because the tests drive whole
 * turns deterministically, and a queue whose fairness depends on wall-clock time
 * cannot be tested any other way.
 */
export function commandsFor(store: QueueStateStore, timings?: QueueTimings): QueueCommands {
  return new QueueCommands(
    store,
    { now: () => new Date().toISOString() },
    {
      attemptId: () => `att_${crypto.randomUUID()}`,
      operationId: () => `op_${crypto.randomUUID()}`,
      nonce: () => crypto.randomUUID(),
      claimToken: () => crypto.randomUUID(),
    },
    timings,
  );
}

export interface QueueSnapshot {
  generation: number;
  attemptRevision: number;
  queueEpoch: number;
  /** The turn this attempt was offered under, which a signed intent binds. */
  turnSequence: number;
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
    turnSequence: Number(state.turnSequence),
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

export interface QueueDiagnosis {
  snapshot: QueueSnapshot;
  deadlines: Array<{ kind: string; attemptId: string; dueAt: string }>;
  outbox: Array<{ kind: string; attemptId?: string; attempts: number }>;
  attempts: Array<{ attemptId: string; phase: string; outcome: string | null; outcomeUnknown: boolean }>;
  events: Array<{ sequence: number; at: string; type: string; detail: string }>;
}

/**
 * Everything needed to answer "what is going on and why" in one call.
 *
 * Built because diagnosing this queue meant a state fetch, a log grep, and a
 * guess about cooldowns and idempotency keys.
 */
export function diagnose(store: SnapshotQueueStore, limit = 25): QueueDiagnosis {
  const state = store.state();
  return {
    snapshot: buildSnapshot(store),
    // Everything, not only what is due: a deadline in the future is often the
    // answer to "why is nothing happening".
    deadlines: [...store.dueDeadlines("9999-12-31T23:59:59Z")],
    outbox: store.pendingOutbox().map((o) => ({
      kind: o.kind,
      ...(o.attemptId === undefined ? {} : { attemptId: o.attemptId }),
      attempts: o.attempts,
    })),
    attempts: [...state.attempts.values()].map((a) => ({
      attemptId: a.attemptId,
      phase: a.phase,
      outcome: a.outcome,
      outcomeUnknown: a.outcomeUnknown,
    })),
    events: store.recentEvents(limit).map((row) => {
      const body = row.body as Record<string, unknown>;
      const parts = ["entryId", "attemptId", "outcome", "primaryReason", "reason"]
        .map((k) => (body[k] === undefined || body[k] === null ? null : `${k}=${String(body[k])}`))
        .filter((v): v is string => v !== null);
      return { sequence: row.sequence, at: row.at, type: row.type, detail: parts.join(" ") };
    }),
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

  // Record the commit if it has moved.
  //
  // Joining the queue is keyed by the entry, so a pull request that is already in
  // it stays at whatever commit it joined with — for as long as it is open. That
  // was survivable while nothing read the entry's commit, and is not now: the
  // turn check is published against it, so a stale one puts the check on an old
  // commit and leaves the current head with none. A required check that never
  // arrives blocks the merge forever.
  const existing = store.state().entries.get(input.entryId);
  if (existing !== undefined && existing.headSha !== input.headSha) {
    commands.entryHeadChanged({
      idempotencyKey: `authorize:head:${input.entryId}:${input.headSha}`,
      entryId: input.entryId,
      headSha: input.headSha,
    });
  }
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
  /**
   * Null where nothing was dispatched. An assignment is the queue telling a
   * runner to run something, and a reuse merge tells no one anything, so there
   * is none to issue rather than one to invent.
   */
  assignmentDigest: string | null;
  receiptDigest: string;
  /** Null where nothing ran to produce one. */
  verifierResultDigest: string | null;
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

  if (input.assignmentDigest !== null) {
    commands.assign({
      idempotencyKey: `authorize:assign:${input.attemptId}`,
      attemptId: input.attemptId,
      assignmentDigest: input.assignmentDigest,
    });
  }
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
  /**
   * What kind of merge this was. A reuse rested on the head's own proof and a
   * verified merge ran the integrated candidate; recording both as `verified`
   * would leave a reader unable to tell which claim the chain is making.
   */
  kind?: "verified" | "reused";
}

/**
 * Confirm the merge, without yet recording the transition.
 *
 * Split from recording because the chain link is now the digest of a signed
 * record, and that record cannot be built until the merge is confirmed: it binds
 * the tree that actually landed and the position the link will occupy. Signing
 * is asynchronous and a queue transaction is not, so the two cannot share one.
 *
 * A confirmed merge with no transition yet is a state the queue already knows how
 * to see: the chain is short by one, and recording is retried. That is better
 * than the alternative it replaces, which was a link that named a commit and
 * attested to nothing.
 */
export function confirmOnly(
  commands: QueueCommands,
  store: QueueStateStore,
  input: Omit<ConfirmInput, "transitionDigest" | "witnessPrincipalIds" | "kind">,
): {
  confirmed: ReturnType<QueueCommands["confirmMerge"]>;
  /** What the queue authorized, for the record that is about to be built. */
  attempt: {
    baseSha: string | null;
    headSha: string | null;
    receiptDigest: string | null;
    intentDigest: string | null;
    /** Present where a verifier ran, which decides what the record may claim. */
    verifierResultDigest: string | null;
    entryId: string;
  } | null;
  chainHead: { sequence: number; digest: string } | null;
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
  const state = store.state();
  const found = state.attempts.get(input.attemptId);
  const head = state.transitions.at(-1);
  return {
    confirmed,
    attempt:
      found === undefined
        ? null
        : {
            baseSha: found.baseSha,
            headSha: found.headSha,
            receiptDigest: found.receiptDigest,
            intentDigest: found.intentDigest,
            verifierResultDigest: found.verifierResultDigest,
            entryId: found.entryId,
          },
    chainHead: head === undefined ? null : { sequence: head.transitionSequence, digest: head.digest },
    snapshot: buildSnapshot(store),
  };
}

/** Record a transition whose record has already been built and signed. */
export function recordOnly(
  commands: QueueCommands,
  store: QueueStateStore,
  input: {
    attemptId: string;
    kind: "verified" | "reused";
    digest: string;
    baseSha: string;
    witnessPrincipalIds: readonly string[];
  },
): { transition: ReturnType<QueueCommands["recordTransition"]>; sequence: number; snapshot: QueueSnapshot } {
  const head = store.state().transitions.at(-1);
  const sequence = (head?.transitionSequence ?? 0) + 1;
  const transition = commands.recordTransition({
    idempotencyKey: `transition:${input.attemptId}`,
    kind: input.kind,
    transitionSequence: sequence,
    priorDigest: head?.digest ?? null,
    digest: input.digest,
    baseSha: input.baseSha,
    attemptId: input.attemptId,
    witnessPrincipalIds: [...input.witnessPrincipalIds],
  });
  return { transition, sequence, snapshot: buildSnapshot(store) };
}
