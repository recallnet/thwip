import { QueueCommands, type CommandResult, type DecisionRecorder, type QueueTimings } from "./commands.js";
import type { MergeEvidence } from "./local-run-gate.js";
import type { SnapshotQueueStore } from "./snapshot-store.js";
import type { QueueStateStore, TransitionRow } from "./store.js";
import type { BlockingReason, TransitionKind } from "@thwip/queue-domain";
import type { ReasonCode } from "@thwip/vocabulary";

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
export function commandsFor(
  store: QueueStateStore,
  timings?: QueueTimings,
  /**
   * Where a scheduling decision is written before the turn that binds it. A
   * deployment with an evidence bucket passes one that archives; without it the
   * digest is still taken over the real record.
   */
  recordDecision?: DecisionRecorder,
): QueueCommands {
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
    recordDecision,
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
  /**
   * What the active attempt pinned, which is what a merge for it must land.
   *
   * The reducer holds these immutable once the candidate is pinned, so this is
   * the same triple the signed intent binds. Whoever performs the write reads
   * the base from here rather than from its own view of the branch, because its
   * own view is what moved.
   */
  activeCandidate: {
    baseSha: string;
    headSha: string;
    candidateSha: string;
    candidateTree: string;
  } | null;
  /**
   * The queue decision the active turn was offered under, which is what an
   * assignment for that turn binds. Null when no attempt holds the lane.
   */
  activeDecisionDigest: string | null;
  chainHead: { sequence: number; digest: string } | null;
  /** The whole recorded chain, oldest first, so a reader can check the links. */
  transitions: readonly TransitionRow[];
  entries: Array<{
    entryId: string;
    pullRequestNumber: number;
    sponsorPrincipalId: string;
    state: string;
    primaryReason: BlockingReason | null;
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
  const active = state.activeAttemptId === null ? undefined : state.attempts.get(state.activeAttemptId);
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
    activeEntryId: active?.entryId ?? null,
    // All four or nothing: a partly pinned candidate names no merge, and half a
    // pin read as a whole one is how a merge lands on a base nobody chose.
    activeCandidate:
      active?.baseSha == null ||
      active.headSha == null ||
      active.candidateSha == null ||
      active.candidateTree == null
        ? null
        : {
            baseSha: active.baseSha,
            headSha: active.headSha,
            candidateSha: active.candidateSha,
            candidateTree: active.candidateTree,
          },
    activeDecisionDigest: active?.decisionDigest ?? null,
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
  /**
   * Every merge write the queue has started, oldest first, settled or not.
   *
   * A write outlives the attempt that started it, because the attempt is what a
   * stranded write cannot rely on. Reporting attempts alone left the four
   * unrecorded merges of 2 August visible only to a SQL statement run against
   * the live database.
   */
  mergeOperations: Array<{
    operationId: string;
    attemptId: string;
    attemptRevision: number;
    pullRequestNumber: number | null;
    expectedBaseSha: string;
    expectedHeadSha: string;
    expectedTreeOid: string;
    writeStartedAt: string;
    outcome: string | null;
    resolvedAt: string | null;
    /**
     * What the sweep concluded last time it looked at an open write, and how
     * many consecutive times it concluded the same thing.
     *
     * A write the sweep cannot settle waits between reads instead of costing
     * GitHub calls every five minutes, and waiting is where a write goes quiet
     * if nothing says so. This is where it says so.
     */
    refusalReason: string | null;
    refusalCount: number;
    refusedAt: string | null;
    retryAfter: string | null;
  }>;
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
    mergeOperations: store.mergeOperations().map((row) => ({
      operationId: row.operationId,
      attemptId: row.attemptId,
      attemptRevision: row.attemptRevision,
      pullRequestNumber: row.pullRequestNumber,
      expectedBaseSha: row.expectedBaseSha,
      expectedHeadSha: row.expectedHeadSha,
      expectedTreeOid: row.expectedTreeOid,
      writeStartedAt: row.writeStartedAt,
      outcome: row.outcome,
      resolvedAt: row.resolvedAt,
      refusalReason: row.refusalReason ?? null,
      refusalCount: row.refusalCount ?? 0,
      refusedAt: row.refusedAt ?? null,
      retryAfter: row.retryAfter ?? null,
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

/**
 * Ask for a turn for a pull request, whether or not it has had one before.
 *
 * The reducer discards a request for an entry that already exists, which is
 * what stops one pull request holding two places. A finished entry is the case
 * that rule gets wrong: closing and reopening a pull request leaves it
 * Cancelled, and every later request was answered "duplicate" against an entry
 * that could never run again, so the pull request became permanently
 * unqueueable and the only way out was opening a new one. A terminal entry is
 * rebuilt instead, at the back of the line, because a new turn is what is being
 * asked for.
 *
 * The key is varied by the ordinal being replaced, so the rebuild is not
 * deduplicated against the request that first placed the entry, while a
 * redelivery of either one still is.
 *
 * Every path that places an entry goes through here — the join route, the merge
 * gate, and the `pull_request` webhook — because a reopened pull request is
 * placed by whichever of them arrives first.
 */
export function requestTurn(
  commands: QueueCommands,
  store: QueueStateStore,
  input: {
    idempotencyKey: string;
    entryId: string;
    pullRequestNumber: number;
    sponsorPrincipalId: string;
    sponsorGithubUserId: string;
    headSha: string;
  },
): CommandResult {
  const existing = store.state().entries.get(input.entryId);
  const finished = existing !== undefined && (existing.state === "Merged" || existing.state === "Cancelled");
  return commands.requestQueue({
    ...input,
    ...(finished
      ? { idempotencyKey: `${input.idempotencyKey}:again:${existing.fairnessOrdinal}`, resetOrdinal: true }
      : {}),
  });
}

export interface AdmitInput {
  entryId: string;
  pullRequestNumber: number;
  sponsorPrincipalId: string;
  sponsorGithubUserId: string;
  headSha: string;
  ready: boolean;
  schedulerEligible: boolean;
  primaryReason: BlockingReason | null;
  readinessBucket: number;
  tickBucket: number;
  /**
   * Whether the server may take the offer for itself.
   *
   * False under a profile that dispatches the run to a device. The server
   * claiming on its own behalf is what makes a `fast` reuse work — the required
   * check is the only consumer, and an unclaimed offer would expire — but under
   * `fresh` the developer's machine is the consumer, and a server that claims
   * first takes the turn away from the runner it is waiting on, then merges on
   * the head's own proof. The one bypass that would have made `fresh` mean
   * nothing.
   */
  serverMayClaim: boolean;
}

/**
 * Everything the merge gate does to get a pull request holding the lane.
 *
 * Enqueue, evaluate readiness, tick the scheduler, claim the offer. The reducer
 * still decides each step and each is still its own event in the log.
 */
export async function admit(
  commands: QueueCommands,
  store: QueueStateStore,
  input: AdmitInput,
): Promise<QueueSnapshot> {
  requestTurn(commands, store, {
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

    // And end the turn that was running against the commit it just left.
    //
    // The entry followed the push and the attempt did not, because the reducer
    // holds a pinned candidate immutable and nothing ever told the queue the
    // pull request had moved. Under `fresh` that turn is already poisoned: the
    // assignment names a tree GitHub no longer integrates, the device asking
    // again is handed that same assignment back, and the receipt it returns is
    // an honest account of the wrong tree. The queue accepts it and then refuses
    // every merge for that attempt with `INTEGRATION_RECEIPT_TREE_MISMATCH`,
    // which no push and no operator can clear, until the execution deadline
    // reaps it. Pull request 2 on `recallnet/thwip-test` sat there.
    //
    // `HEAD_MOVED` defers, so the place in line is kept and the next turn is
    // taken against what is there now. An offer nobody has claimed pins nothing
    // and is left alone: whoever claims it reads the head that is there then. A
    // merge already sent to GitHub is left alone too, because nothing here knows
    // whether it landed and only confirmation may say.
    const running =
      existing.currentAttemptId === null ? undefined : store.state().attempts.get(existing.currentAttemptId);
    if (
      running !== undefined &&
      running.outcome === null &&
      !running.outcomeUnknown &&
      running.headSha !== null &&
      running.headSha !== input.headSha
    ) {
      commands.terminateAttempt({
        idempotencyKey: `authorize:head-moved:${running.attemptId}:${input.headSha}`,
        attemptId: running.attemptId,
        outcome: "HEAD_MOVED",
      });
    }
  }
  // Keyed on the decision as well as the minute.
  //
  // The minute alone deduplicated a burst of parallel jobs asking about one
  // head, which is what it is for, and it also deduplicated a *different*
  // answer arriving in the same minute. That was survivable while a workflow
  // polled this endpoint every twenty seconds for as long as it took. It is not
  // survivable without one: the `pull_request` delivery lands before the App
  // has verified the head, so the entry is blocked on a missing proof, and the
  // verdict that arrives ten seconds later was dropped as a repeat. Nothing
  // asked again, so the pull request stayed blocked on a proof that had passed.
  //
  // The decision in the key means a changed answer always applies, at once, and
  // a repeated one still collapses.
  const decision = `${input.ready}:${input.schedulerEligible}:${input.primaryReason ?? ""}`;
  commands.evaluateReadiness({
    idempotencyKey: `authorize:ready:${input.entryId}:${input.headSha}:${input.readinessBucket}:${decision}`,
    entryId: input.entryId,
    ready: input.ready,
    schedulerEligible: input.schedulerEligible,
    primaryReason: input.primaryReason,
  });
  await commands.tick({
    idempotencyKey: `authorize:tick:${input.entryId}:${input.headSha}:${input.tickBucket}`,
  });

  // Claim on the server's behalf. In this gate the required check is the
  // consumer, so an unclaimed offer would expire and the branch would be told to
  // wait forever (plan.md §8.2).
  const state = store.state();
  const attemptId = state.activeAttemptId;
  if (input.serverMayClaim && attemptId !== null && state.entries.get(input.entryId)?.state === "Offered") {
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
   * What the developer's machine did, read from storage by `localRunEvidenceFor`
   * and by nothing else.
   *
   * A caller cannot assemble one, so a merge under a profile that dispatches
   * work to a device cannot be walked without the stored receipt having been
   * read. Where the profile dispatches nothing, the evidence carries no local
   * run and the walk is the reuse walk it has always been.
   */
  evidence: MergeEvidence;
  /**
   * The receipt a reuse merge rests on: the digest of the proof on the head.
   * Ignored where a device ran the integration, because the receipt that
   * decides that merge is the one the device signed.
   */
  receiptDigest: string;
  /** Null where nothing ran to produce one. */
  verifierResultDigest: string | null;
  intentDigest: string;
  operationId: string;
}

/** Why the walk stopped short of a merge write. */
export type WalkRefusal =
  | "NO_SUCH_ATTEMPT"
  | "INTEGRATION_ASSIGNMENT_MISMATCH"
  | "INTEGRATION_RECEIPT_MISMATCH"
  | "INTEGRATION_RECEIPT_TREE_MISMATCH"
  | "INTEGRATION_RECEIPT_DEVICE_MISMATCH"
  | "CANDIDATE_NOT_PINNED"
  | "CANDIDATE_CHANGED"
  | "VERIFICATION_NOT_STARTED"
  | "MERGE_NOT_PERMITTED";

/**
 * The refusals the authorization answer hands back, rather than falling through
 * to whatever the snapshot says.
 *
 * These five say the queue document and the evidence for this merge disagree,
 * and an operator reading "waiting for turn" instead would have nothing to go
 * on. The other four leave a better answer to the snapshot: a pause, or a base
 * that moved.
 *
 * `satisfies` is the point of the annotation. Every code here goes out on the
 * wire, so every code here has to be one the closed union declares, and adding
 * one that is not fails the build. This used to be `refusal.startsWith
 * ("INTEGRATION_")`, which let any code with the right prefix onto the wire
 * whether a vocabulary knew it or not.
 */
export const ANSWERED_WALK_REFUSALS = [
  "INTEGRATION_ASSIGNMENT_MISMATCH",
  "INTEGRATION_RECEIPT_MISMATCH",
  "INTEGRATION_RECEIPT_TREE_MISMATCH",
  "INTEGRATION_RECEIPT_DEVICE_MISMATCH",
  "CANDIDATE_CHANGED",
] as const satisfies readonly Extract<WalkRefusal, ReasonCode>[];

export function isAnsweredWalkRefusal(refusal: WalkRefusal): refusal is (typeof ANSWERED_WALK_REFUSALS)[number] {
  return (ANSWERED_WALK_REFUSALS as readonly string[]).includes(refusal);
}

/**
 * Walk a held attempt to the point a merge may be written.
 *
 * Each step is still a separate event in the log and the reducer still refuses
 * any it considers out of order.
 *
 * The local-run half of this is a refusal, not a step. Under `fresh` and
 * `audited` the merge rests on a run that happened on somebody's machine, and
 * the only account of it is a receipt this queue accepted. So the receipt is
 * checked against the queue document itself — the tree the attempt pinned, the
 * device that claimed the offer, the assignment that device was issued — and a
 * disagreement stops the walk here, where a route cannot go around it.
 */
export function walkToMergeReady(
  commands: QueueCommands,
  store: QueueStateStore,
  input: WalkInput,
): { operationId: string | null; snapshot: QueueSnapshot; refusal?: WalkRefusal } {
  const ok = (r: { status: string }) => r.status === "applied" || r.status === "duplicate";
  const done = (operationId: string | null, refusal?: WalkRefusal) => ({
    operationId,
    snapshot: buildSnapshot(store),
    ...(refusal === undefined ? {} : { refusal }),
  });

  const attempt = store.state().attempts.get(input.attemptId);
  if (attempt === undefined) return done(null, "NO_SUCH_ATTEMPT");
  const localRun = input.evidence.localRun;

  if (localRun !== null) {
    // Everything about this receipt has to be about this attempt. The digests
    // were written by the claim and receipt routes into the queue document as
    // well as into storage, so a receipt that satisfied the gate but names an
    // assignment or a tree the queue never recorded is two accounts of one turn
    // disagreeing, and neither may be merged on.
    if (attempt.assignmentDigest !== localRun.assignmentDigest) {
      return done(null, "INTEGRATION_ASSIGNMENT_MISMATCH");
    }
    if (attempt.receiptDigest !== localRun.receiptDigest) {
      return done(null, "INTEGRATION_RECEIPT_MISMATCH");
    }
    if (attempt.candidateTree !== localRun.candidateTreeOid || input.candidateTree !== localRun.candidateTreeOid) {
      return done(null, "INTEGRATION_RECEIPT_TREE_MISMATCH");
    }
    // The offer was claimed by a device, and the receipt has to come from that
    // device. `acceptIntegrationReceipt` checks the receipt against the
    // assignment; this checks it against who the queue let take the turn.
    if (attempt.deviceId !== localRun.deviceKeyId) {
      return done(null, "INTEGRATION_RECEIPT_DEVICE_MISMATCH");
    }
  }

  // Pinned already where a device was dispatched: the candidate is what the
  // assignment was built over, and the reducer holds it immutable. Re-issuing
  // the command would be rejected and stop a merge that is in order.
  if (attempt.candidateSha === null) {
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
    if (!ok(prepared)) return done(null, "CANDIDATE_NOT_PINNED");
  } else if (attempt.candidateTree !== input.candidateTree || attempt.candidateSha !== input.candidateSha) {
    // The caller is about to merge something other than what this attempt was
    // run against.
    return done(null, "CANDIDATE_CHANGED");
  }

  // A device's receipt was submitted when it arrived. Only the reuse walk
  // submits one here, and only the reuse walk has one to submit.
  if (attempt.receiptDigest === null) {
    commands.submitReceipt({
      idempotencyKey: `authorize:receipt:${input.attemptId}`,
      attemptId: input.attemptId,
      receiptDigest: input.receiptDigest,
    });
  }
  const started = commands.startVerification({
    idempotencyKey: `authorize:verify:${input.attemptId}`,
    attemptId: input.attemptId,
  });
  const nonce = "nonce" in started ? (started as { nonce: string }).nonce : undefined;
  if (nonce === undefined) return done(null, "VERIFICATION_NOT_STARTED");

  commands.completeVerification({
    idempotencyKey: `authorize:verdict:${input.attemptId}`,
    attemptId: input.attemptId,
    nonce,
    accepted: true,
    resultDigest: input.verifierResultDigest,
  });
  const intent = commands.createMergeIntent({
    idempotencyKey: `authorize:intent:${input.attemptId}`,
    attemptId: input.attemptId,
    intentDigest: input.intentDigest,
  });
  // The reducer refuses the intent when the queue may not merge this attempt:
  // an operator paused, or the base moved outside the queue and the candidate
  // was integrated against something that no longer exists. Walking on would
  // insert a merge_operations row for a write that never begins, and the next
  // caller reads that row as already-started and is handed an operation id to
  // merge with.
  if (!ok(intent)) return done(null, "MERGE_NOT_PERMITTED");
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
export async function confirmOnly(
  commands: QueueCommands,
  store: QueueStateStore,
  input: Omit<ConfirmInput, "transitionDigest" | "witnessPrincipalIds" | "kind">,
): Promise<{
  confirmed: Awaited<ReturnType<QueueCommands["confirmMerge"]>>;
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
}> {
  const confirmed = await commands.confirmMerge({
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
    kind: TransitionKind;
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
