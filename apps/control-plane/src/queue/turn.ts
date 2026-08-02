import type { AssignmentExecution } from "@thwip/queue-protocol";

/**
 * The integration turn, as a state machine over durable steps (plan.md §40).
 *
 * The Workflow runtime supplies durability and retries; what needs to be
 * testable is the decision at each step, especially the one that must never be
 * retried. So the sequencing lives here as a pure planner and the Workflow class
 * is a thin driver over it.
 *
 * Every external signal reaches the Durable Object first, which authenticates
 * and deduplicates it and appends an outbox item. Only the outbox sender calls
 * sendEvent, so this planner never waits on a handshake that says "the workflow
 * is listening now".
 */

export const TURN_STEPS = [
  "confirm-attempt",
  "resolve-candidate",
  "issue-assignment",
  "await-execution",
  "dispatch-verifier",
  "await-verifier-result",
  "commit-verified",
  "final-guard",
  "persist-merge-intent",
  "merge-write",
  "await-merge-observation",
  "resolve-result",
  "commit-transition",
  "publish",
] as const;

export type TurnStep = (typeof TURN_STEPS)[number];

export function turnInstanceId(attemptId: string): string {
  return `queue-turn-v1-${attemptId}`;
}

/** Internal workflow event names are versioned and contain no dots (§40.2). */
export const TURN_EVENTS = {
  receipt: "queue-receipt-v1",
  runFailed: "queue-run-failed-v1",
  attemptRevoked: "queue-attempt-revoked-v1",
  verifierResult: "queue-verifier-result-v1",
  mergeObserved: "queue-merge-observed-v1",
} as const;

export type TurnEventName = (typeof TURN_EVENTS)[keyof typeof TURN_EVENTS];

const EVENT_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function isValidEventName(name: string): boolean {
  return EVENT_NAME_RE.test(name);
}

/**
 * What the turn should do after `issue-assignment`, from the assignment's own
 * execution union (§40 step 4). Fast reuse and remote need no device event, so a
 * turn that waited for one would hang until its deadline for no reason.
 */
export type ExecutionPlan =
  | { readonly kind: "await-device"; readonly events: readonly TurnEventName[]; readonly thenRerun: boolean }
  | { readonly kind: "construct-reuse" }
  | { readonly kind: "dispatch-remote" };

export function planExecution(execution: AssignmentExecution): ExecutionPlan {
  switch (execution.mode) {
    case "run":
      return {
        kind: "await-device",
        events: [TURN_EVENTS.receipt, TURN_EVENTS.runFailed, TURN_EVENTS.attemptRevoked],
        // Audited asks the verifier for an independent rerun after the local
        // receipt arrives; fresh does not.
        thenRerun: execution.profile === "audited",
      };
    case "reuse":
      return { kind: "construct-reuse" };
    case "remote":
      return { kind: "dispatch-remote" };
  }
}

/* ------------------------------------------------------------------ */

/**
 * The merge write decision (plan.md §40.1).
 *
 * A crash can happen after GitHub accepts the request and before the Workflow
 * commits its step, so the durable operation row — not the Workflow's own step
 * state — decides whether a mutation may be sent. This function is the whole
 * rule, in one place, so it can be tested exhaustively.
 */
export type MergeWriteDecision =
  | { readonly action: "send" }
  | { readonly action: "reconcile"; readonly reason: string }
  | { readonly action: "already-resolved"; readonly outcome: string };

export function decideMergeWrite(input: {
  /** Null when no operation row exists yet. */
  readonly persisted: { readonly attemptId: string; readonly outcome: string | null } | null;
  readonly attemptId: string;
  /** True when this Workflow execution is a retry or re-entry of the step. */
  readonly isReentry: boolean;
}): MergeWriteDecision {
  if (input.persisted === null) {
    // No record of a write. Only a first execution may send one; a re-entry
    // that finds no row means the row was never committed, and re-sending would
    // risk a second mutation with no guard behind it.
    return input.isReentry
      ? { action: "reconcile", reason: "re-entry found no persisted merge operation" }
      : { action: "send" };
  }
  if (input.persisted.attemptId !== input.attemptId) {
    return { action: "reconcile", reason: "persisted merge operation belongs to another attempt" };
  }
  if (input.persisted.outcome !== null) {
    return { action: "already-resolved", outcome: input.persisted.outcome };
  }
  // The row exists and is unresolved: a mutation may already have reached
  // GitHub. Read and reconcile; never send another.
  return { action: "reconcile", reason: "merge write may already have started" };
}

/**
 * Classify what happened to a merge request. A transport failure is a typed
 * nonterminal outcome, never an exception thrown into a retry policy (§40.1).
 */
export type MergeAttemptOutcome =
  | { readonly kind: "merged"; readonly mergeSha: string; readonly mergeTree: string; readonly parentShas: readonly string[] }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

export function classifyMergeResponse(response: {
  readonly status: number;
  readonly transportError?: string;
  readonly body?: { readonly merged?: boolean; readonly sha?: string; readonly treeOid?: string; readonly parents?: readonly string[]; readonly message?: string };
}): MergeAttemptOutcome {
  if (response.transportError !== undefined) {
    return { kind: "unknown", reason: `transport: ${response.transportError}` };
  }
  if (response.status >= 500 || response.status === 408 || response.status === 429) {
    // The request may have been applied server-side; treat it as unknown.
    return { kind: "unknown", reason: `status ${response.status}` };
  }
  if (response.status === 200 || response.status === 201) {
    const body = response.body;
    if (body?.merged !== true || body.sha === undefined || body.treeOid === undefined) {
      return { kind: "unknown", reason: "success status with an incomplete body" };
    }
    return {
      kind: "merged",
      mergeSha: body.sha,
      mergeTree: body.treeOid,
      parentShas: body.parents ?? [],
    };
  }
  if (response.status === 409 || response.status === 405 || response.status === 422) {
    const message = response.body?.message ?? `status ${response.status}`;
    // The base moved between the intent being signed and the write. GitHub
    // refuses a ref update that is not a fast forward, which is the one way to
    // say "merge only onto the base this candidate was verified against". It is
    // named rather than folded into the other refusals, because what follows is
    // a new turn against a new base, not another try at this one.
    if (/not a fast forward/i.test(message)) {
      return { kind: "rejected", reason: `BASE_MOVED: ${message}` };
    }
    return { kind: "rejected", reason: message };
  }
  return { kind: "unknown", reason: `unhandled status ${response.status}` };
}

/**
 * The final guard immediately before the write (§18, §23.2). Everything
 * security-critical is re-read and compared to what the attempt pinned; "close
 * enough" is exactly the failure this prevents.
 */
export interface GuardExpectation {
  readonly baseSha: string;
  readonly headSha: string;
  readonly candidateTreeOid: string;
  readonly policyDigest: string;
  readonly attemptRevision: number;
}

export interface GuardObservation extends GuardExpectation {
  readonly pullRequestOpen: boolean;
  readonly reviewsSatisfied: boolean;
  readonly signerStillAuthorized: boolean;
  readonly rulesetEnforced: boolean;
  readonly appPermissionsHealthy: boolean;
  readonly queuePaused: boolean;
}

export type GuardVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function finalGuard(expected: GuardExpectation, observed: GuardObservation): GuardVerdict {
  if (observed.baseSha !== expected.baseSha) return { ok: false, reason: "BASE_MOVED" };
  if (observed.headSha !== expected.headSha) return { ok: false, reason: "HEAD_MOVED" };
  if (observed.candidateTreeOid !== expected.candidateTreeOid) return { ok: false, reason: "SUBJECT_TREE_MISMATCH" };
  if (observed.policyDigest !== expected.policyDigest) return { ok: false, reason: "POLICY_CHANGED" };
  if (observed.attemptRevision !== expected.attemptRevision) return { ok: false, reason: "ATTEMPT_REVISION_CHANGED" };
  if (!observed.pullRequestOpen) return { ok: false, reason: "PR_CLOSED" };
  if (!observed.reviewsSatisfied) return { ok: false, reason: "REVIEWS_CHANGED" };
  if (!observed.signerStillAuthorized) return { ok: false, reason: "PERMISSION_REVOKED" };
  if (!observed.rulesetEnforced) return { ok: false, reason: "RULESET_DRIFT" };
  if (!observed.appPermissionsHealthy) return { ok: false, reason: "APP_PERMISSION_DRIFT" };
  if (observed.queuePaused) return { ok: false, reason: "QUEUE_PAUSED" };
  return { ok: true };
}
