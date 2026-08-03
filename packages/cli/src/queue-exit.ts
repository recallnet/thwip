/**
 * Exit codes and machine output for the queue commands (plan.md §30.5, §30.7).
 *
 * The contract is deliberately two-layer. The JSON `reasonCode` is authoritative
 * for automation, and the exit code is a broad handling class, so an agent can
 * branch on "retry is safe" without enumerating every reason, and a person can
 * read one line and know what to do.
 *
 * Mapping a reason to the wrong class is a real hazard: an agent that treats a
 * changed head as retryable will spin, and one that treats a rate limit as fatal
 * will give up on work that would have succeeded.
 *
 * The classification below is keyed by `ReasonCode`, a closed union assembled
 * from the queue's vocabulary, the proof protocol's vocabulary, the codes the
 * control plane writes on the wire, and the codes the CLI raises itself.
 * `Record` over that union means a code without a class fails the build, which
 * is how a hand-maintained table stopped drifting. A code that reaches the CLI
 * from a newer service is named in the output rather than filed under something
 * the CLI invented for it.
 *
 * The sentence a person reads lives in @thwip/vocabulary, which the GitHub check
 * and the dashboard read too. The exit class is the CLI's alone: nothing else
 * has an exit code.
 */

import { isReasonCode, nextActionFor as sharedNextAction } from "@thwip/vocabulary";
import type { ReasonCode } from "@thwip/vocabulary";

export type { ReasonCode };

export const EXIT = {
  ok: 0,
  usage: 2,
  authRequired: 10,
  permission: 11,
  setupInvalid: 12,
  suiteFailed: 20,
  ambiguous: 21,
  evidenceRejected: 22,
  humanRequired: 30,
  repairRequired: 31,
  turnLost: 32,
  sourceChanged: 33,
  unavailable: 40,
  rateLimited: 41,
  invariant: 50,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Terminal outcomes that mean success (plan.md §30.7 code 0). */
export const OUTCOMES = [
  "PR_UPDATED",
  "LOCAL_RECEIPT_ACCEPTED",
  "QUEUE_REQUESTED",
  "WATCHING_DETACHED",
  "MERGE_CONFIRMED",
] as const;

export type Outcome = (typeof OUTCOMES)[number];

/**
 * Reason code to handling class. Grouped by what the caller should *do*, which is
 * the only thing an exit code can usefully say.
 */
const CLASS: Record<ReasonCode, ExitCode> = {
  /* Nothing is wrong; the work finished. */
  PASS: EXIT.ok,

  /* Usage: the command cannot start from this state. */
  UNCOMMITTED_CHANGES: EXIT.usage,

  /* The caller has to authenticate or be granted access. */
  LOGIN_REQUIRED: EXIT.authRequired,
  DEVICE_NOT_ENROLLED: EXIT.authRequired,
  OWNER_UNAUTHORIZED: EXIT.permission,
  SIGNER_PERMISSION_INSUFFICIENT: EXIT.permission,
  SPONSOR_REQUIRED: EXIT.permission,

  /* Configuration, not code. */
  PROJECT_DISABLED: EXIT.setupInvalid,
  BASE_NOT_MANAGED: EXIT.setupInvalid,
  RULESET_DRIFT: EXIT.setupInvalid,
  APP_PERMISSION_DRIFT: EXIT.setupInvalid,
  QUEUE_NOT_CONFIGURED: EXIT.setupInvalid,
  NO_PINNED_VERIFIER: EXIT.setupInvalid,
  CANDIDATE_VERIFIER_NOT_PINNED: EXIT.setupInvalid,
  DISPATCH_FAILED: EXIT.setupInvalid,
  CANDIDATE_DISPATCH_FAILED: EXIT.setupInvalid,
  PROOF_SCHEMA_UNSUPPORTED: EXIT.setupInvalid,
  SIGNER_KEY_ALGORITHM_FORBIDDEN: EXIT.setupInvalid,
  SUITE_MISSING: EXIT.setupInvalid,
  BUNDLE_EXPIRED: EXIT.setupInvalid,

  /* The work itself failed. */
  SUITE_FAILED: EXIT.suiteFailed,
  SUITE_NOT_PASSED: EXIT.suiteFailed,
  CI_FAILED: EXIT.suiteFailed,
  CANDIDATE_SUITE_NOT_PASSED: EXIT.suiteFailed,
  CANDIDATE_SUITES_INCOMPLETE: EXIT.suiteFailed,

  /* We cannot tell what happened, so the caller must not assume. */
  MERGE_OUTCOME_UNKNOWN: EXIT.ambiguous,
  PROVIDER_FAILURE: EXIT.ambiguous,

  /* Evidence was refused. */
  // The assignment or the receipt was refused, which is evidence being
  // rejected rather than a suite failing: the run may well have passed, and
  // nothing about it counted.
  ASSIGNMENT_UNVERIFIED: EXIT.evidenceRejected,
  ASSIGNMENT_MISMATCH: EXIT.evidenceRejected,
  DEVICE_MISMATCH: EXIT.evidenceRejected,
  LOCAL_RECEIPT_MISSING: EXIT.evidenceRejected,
  LOCAL_RECEIPT_REJECTED: EXIT.evidenceRejected,
  RECEIPT_REJECTED: EXIT.evidenceRejected,
  VERIFICATION_FAILED: EXIT.evidenceRejected,
  SIGNATURE_INVALID: EXIT.evidenceRejected,
  SIGNER_KEY_REVOKED: EXIT.evidenceRejected,
  SIGNER_KEY_UNKNOWN: EXIT.evidenceRejected,
  SIGNER_MISMATCH: EXIT.evidenceRejected,
  PIPELINE_DIGEST_MISMATCH: EXIT.evidenceRejected,
  PROOF_EXPIRED: EXIT.evidenceRejected,
  PROOF_MISSING: EXIT.evidenceRejected,
  PROOF_DUPLICATE: EXIT.evidenceRejected,
  PROOF_MALFORMED: EXIT.evidenceRejected,
  PROOF_TOO_LARGE: EXIT.evidenceRejected,
  SUBJECT_REPOSITORY_MISMATCH: EXIT.evidenceRejected,
  SUITE_DUPLICATE: EXIT.evidenceRejected,
  LEASE_REQUIRED: EXIT.evidenceRejected,
  LEASE_INVALID: EXIT.evidenceRejected,
  LEASE_EXPIRED: EXIT.evidenceRejected,
  LEASE_CONTEXT_MISMATCH: EXIT.evidenceRejected,
  WORK_RECEIPT_UNREADABLE: EXIT.evidenceRejected,
  CANDIDATE_REJECTED: EXIT.evidenceRejected,
  CANDIDATE_SUITE_DUPLICATE: EXIT.evidenceRejected,

  /* A person has to do something. Retrying will not help. */
  REVIEW_REQUIRED: EXIT.humanRequired,
  CODEOWNER_REVIEW_REQUIRED: EXIT.humanRequired,
  APPROVAL_AFTER_PUSH_REQUIRED: EXIT.humanRequired,
  CONVERSATION_UNRESOLVED: EXIT.humanRequired,
  REQUIRED_CHECK_PENDING: EXIT.humanRequired,
  REQUIRED_CHECK_FAILED: EXIT.humanRequired,
  VERIFICATION_REJECTED: EXIT.humanRequired,
  PR_DRAFT: EXIT.humanRequired,
  PR_CLOSED: EXIT.humanRequired,
  QUEUE_PAUSED: EXIT.humanRequired,
  REBASELINE_REQUIRED: EXIT.humanRequired,
  MERGE_REJECTED: EXIT.humanRequired,

  /* The branch needs work before it can integrate. */
  MERGE_CONFLICT: EXIT.repairRequired,
  NEEDS_REPAIR: EXIT.repairRequired,

  /* The turn was lost but the place in line was not. Retry is safe. */
  // The window closed with the place in line intact, which is what every other
  // lost turn means. Waiting for the next offer is the whole answer.
  ASSIGNMENT_EXPIRED: EXIT.turnLost,
  EXPIRED_UNCLAIMED: EXIT.turnLost,
  EXPIRED_EXECUTION: EXIT.turnLost,
  SUPERSEDED: EXIT.turnLost,
  COOLDOWN_ACTIVE: EXIT.turnLost,
  AGENT_OFFLINE: EXIT.turnLost,
  NO_COMPATIBLE_RUNNER: EXIT.turnLost,
  WAITING_FOR_TURN: EXIT.turnLost,
  HOLDS_TURN: EXIT.turnLost,
  LANE_IDLE: EXIT.turnLost,
  DEVICE_ONLY: EXIT.turnLost,
  CANDIDATE_NOT_VERIFIED: EXIT.turnLost,
  // The base advanced, so the queue rebuilds the candidate and runs it again.
  // Waiting is the whole answer here, which is why this is a lost turn and
  // BASE_MOVED, which invalidates the developer's own proof, is not.
  CANDIDATE_BASE_MOVED: EXIT.turnLost,

  /* The thing we were integrating is no longer what is there. */
  HEAD_MOVED: EXIT.sourceChanged,
  BASE_MOVED: EXIT.sourceChanged,
  POLICY_CHANGED: EXIT.sourceChanged,
  REVIEWS_CHANGED: EXIT.sourceChanged,
  SUBJECT_TREE_MISMATCH: EXIT.sourceChanged,
  SUBJECT_ANCESTRY_MISMATCH: EXIT.sourceChanged,
  SUBJECT_BASE_MISMATCH: EXIT.sourceChanged,
  // The remote branch holds work this machine never had. Nothing local is
  // wrong, and no retry fixes it: the developer has to pull that commit in.
  PUSH_REJECTED: EXIT.sourceChanged,
  PERMISSION_REVOKED: EXIT.sourceChanged,
  CANDIDATE_TREE_MISMATCH: EXIT.sourceChanged,
  CANDIDATE_POLICY_MISMATCH: EXIT.sourceChanged,

  /* Transient. */
  // Pending evidence is not a failure. The caller waits and asks again, which is
  // what the unavailable class already means to an agent reading exit codes.
  VERIFICATION_PENDING: EXIT.unavailable,
  // A candidate this machine cannot fetch is a reachability problem, and the
  // same commit is very likely there on the next attempt.
  CANDIDATE_UNAVAILABLE: EXIT.unavailable,
  SERVICE_UNAVAILABLE: EXIT.unavailable,
  NETWORK_UNAVAILABLE: EXIT.unavailable,
  BUNDLE_UNAVAILABLE: EXIT.unavailable,
  RATE_LIMITED: EXIT.rateLimited,

  /* Something disagreed that should not have. A human must look. */
  INVARIANT_FAILURE: EXIT.invariant,
  CONFIRMED_NOT_MERGED: EXIT.invariant,
  APP_UNINSTALLED: EXIT.setupInvalid,
  ADMIN_CANCELLED: EXIT.humanRequired,
  INTERNAL_FAILURE: EXIT.invariant,
  // Something threw before anything could classify it. The invariant class is
  // right for the same reason it is right for INTERNAL_FAILURE: a person has to
  // read it, and no caller should retry on it.
  LOCAL_FAILURE: EXIT.invariant,
  MERGE_EVIDENCE_INCOMPLETE: EXIT.invariant,
  MERGE_INTENT_INVALID: EXIT.invariant,
  CANDIDATE_DIGEST_MISMATCH: EXIT.invariant,
  BUNDLE_SIGNATURE_INVALID: EXIT.invariant,
};

function isKnown(reasonCode: string): reasonCode is ReasonCode {
  return Object.hasOwn(CLASS, reasonCode);
}

/**
 * An unknown reason is never treated as success. It maps to the invariant class,
 * because a reason the CLI does not recognize means the service knows something
 * this build does not.
 */
export function exitCodeFor(reasonCode: string): ExitCode {
  return isKnown(reasonCode) ? CLASS[reasonCode] : EXIT.invariant;
}

/**
 * What the developer should do. An unrecognized code says so in as many words and
 * quotes the code, because the alternative is the CLI inventing a meaning for
 * something a newer service said.
 */
export function nextActionFor(reasonCode: string): string {
  if (isReasonCode(reasonCode)) return sharedNextAction(reasonCode, "terminal");
  return `This thwip does not know the reason code ${reasonCode}. Update thwip; the queue is running a newer version.`;
}

export function isRetryable(reasonCode: string): boolean {
  const code = exitCodeFor(reasonCode);
  return code === EXIT.turnLost || code === EXIT.unavailable || code === EXIT.rateLimited;
}

/* ------------------------------------------------------------------ */

/**
 * NDJSON events (plan.md §30.5). One object per line, each self-describing, so a
 * consumer can be interrupted at any point and still have understood everything
 * it read. No field is ever removed from an event type without a version bump.
 */
export interface QueueEventLine {
  readonly v: 1;
  readonly at: string;
  readonly event: string;
  readonly reasonCode?: string;
  readonly outcome?: Outcome;
  readonly detail?: string;
  readonly data?: Record<string, unknown>;
}

export function line(event: string, rest: Omit<QueueEventLine, "v" | "at" | "event"> & { at: string }): string {
  const payload: QueueEventLine = { v: 1, event, ...rest };
  // Key order is stable so a diff of two runs is readable.
  const ordered: Record<string, unknown> = { v: payload.v, at: payload.at, event: payload.event };
  if (payload.reasonCode !== undefined) ordered["reasonCode"] = payload.reasonCode;
  if (payload.outcome !== undefined) ordered["outcome"] = payload.outcome;
  if (payload.detail !== undefined) ordered["detail"] = payload.detail;
  if (payload.data !== undefined) ordered["data"] = payload.data;
  return JSON.stringify(ordered);
}

/**
 * A one-line human summary: the code for an agent, then the sentence for the
 * person. Both are on the line because both readers are looking at it, and the
 * code alone told nobody what to do.
 */
export function humanSummary(input: { event: string; reasonCode?: string; detail?: string }): string {
  const suffix = input.detail === undefined ? "" : ` ${input.detail}`;
  if (input.reasonCode === undefined || input.reasonCode === "PASS") return `${input.event}${suffix}`;
  return `${input.event}: ${input.reasonCode}${suffix}. ${nextActionFor(input.reasonCode)}`;
}
