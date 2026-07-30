/**
 * Exit codes and machine output for the queue commands (plan.md §30.5, §30.7).
 *
 * The contract is deliberately two-layer. The JSON `reasonCode` is authoritative
 * for automation, and the exit code is a broad handling class — so an agent can
 * branch on "retry is safe" without enumerating every reason, and a human can
 * read one line and know what to do.
 *
 * Mapping a reason to the wrong class is a real hazard: an agent that treats a
 * changed head as retryable will spin, and one that treats a rate limit as fatal
 * will give up on work that would have succeeded. So the mapping is a table with
 * a test that every reason the system can emit appears in it.
 */

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
const CLASS: Record<string, ExitCode> = {
  /* Nothing is wrong; the work finished. */
  PASS: EXIT.ok,

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

  /* The work itself failed. */
  SUITE_FAILED: EXIT.suiteFailed,
  SUITE_NOT_PASSED: EXIT.suiteFailed,
  CI_FAILED: EXIT.suiteFailed,

  /* We cannot tell what happened, so the caller must not assume. */
  MERGE_OUTCOME_UNKNOWN: EXIT.ambiguous,
  PROVIDER_FAILURE: EXIT.ambiguous,

  /* Evidence was refused. */
  LOCAL_RECEIPT_MISSING: EXIT.evidenceRejected,
  LOCAL_RECEIPT_REJECTED: EXIT.evidenceRejected,
  RECEIPT_REJECTED: EXIT.evidenceRejected,
  VERIFICATION_FAILED: EXIT.evidenceRejected,
  SIGNATURE_INVALID: EXIT.evidenceRejected,
  SIGNER_KEY_REVOKED: EXIT.evidenceRejected,
  SIGNER_KEY_UNKNOWN: EXIT.evidenceRejected,
  POLICY_NOT_ACTIVE: EXIT.evidenceRejected,
  PIPELINE_DIGEST_MISMATCH: EXIT.evidenceRejected,
  PROOF_EXPIRED: EXIT.evidenceRejected,
  LEASE_REQUIRED: EXIT.evidenceRejected,

  /* A person has to do something. Retrying will not help. */
  REVIEW_REQUIRED: EXIT.humanRequired,
  CODEOWNER_REVIEW_REQUIRED: EXIT.humanRequired,
  APPROVAL_AFTER_PUSH_REQUIRED: EXIT.humanRequired,
  CONVERSATION_UNRESOLVED: EXIT.humanRequired,
  REQUIRED_CHECK_PENDING: EXIT.humanRequired,
  REQUIRED_CHECK_FAILED: EXIT.humanRequired,
  PR_DRAFT: EXIT.humanRequired,
  PR_CLOSED: EXIT.humanRequired,
  QUEUE_PAUSED: EXIT.humanRequired,

  /* The branch needs work before it can integrate. */
  MERGE_CONFLICT: EXIT.repairRequired,
  NEEDS_REPAIR: EXIT.repairRequired,

  /* The turn was lost but the place in line was not. Retry is safe. */
  EXPIRED_UNCLAIMED: EXIT.turnLost,
  EXPIRED_EXECUTION: EXIT.turnLost,
  SUPERSEDED: EXIT.turnLost,
  COOLDOWN_ACTIVE: EXIT.turnLost,
  AGENT_OFFLINE: EXIT.turnLost,
  NO_COMPATIBLE_RUNNER: EXIT.turnLost,

  /* The thing we were integrating is no longer what is there. */
  HEAD_MOVED: EXIT.sourceChanged,
  BASE_MOVED: EXIT.sourceChanged,
  POLICY_CHANGED: EXIT.sourceChanged,
  REVIEWS_CHANGED: EXIT.sourceChanged,
  SUBJECT_TREE_MISMATCH: EXIT.sourceChanged,
  PERMISSION_REVOKED: EXIT.sourceChanged,

  /* Transient. */
  SERVICE_UNAVAILABLE: EXIT.unavailable,
  NETWORK_UNAVAILABLE: EXIT.unavailable,
  RATE_LIMITED: EXIT.rateLimited,

  /* Something disagreed that should not have. A human must look. */
  INVARIANT_FAILURE: EXIT.invariant,
  CONFIRMED_NOT_MERGED: EXIT.invariant,
  APP_UNINSTALLED: EXIT.setupInvalid,
  ADMIN_CANCELLED: EXIT.humanRequired,
  INTERNAL_FAILURE: EXIT.invariant,
};

/**
 * An unknown reason is never treated as success. It maps to the invariant class,
 * because a reason the CLI does not recognize means the service knows something
 * this build does not.
 */
export function exitCodeFor(reasonCode: string): ExitCode {
  return CLASS[reasonCode] ?? EXIT.invariant;
}

export function isRetryable(reasonCode: string): boolean {
  const code = exitCodeFor(reasonCode);
  return code === EXIT.turnLost || code === EXIT.unavailable || code === EXIT.rateLimited;
}

/** Every reason the mapping knows, for the exhaustiveness test. */
export function knownReasonCodes(): string[] {
  return Object.keys(CLASS);
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
 * A one-line human summary. Deliberately not the JSON: a person reading a
 * terminal wants the next action, and an agent parsing output wants the code.
 */
export function humanSummary(input: { event: string; reasonCode?: string; detail?: string }): string {
  const suffix = input.detail === undefined ? "" : ` ${input.detail}`;
  if (input.reasonCode === undefined || input.reasonCode === "PASS") return `${input.event}${suffix}`;
  return `${input.event}: ${input.reasonCode}${suffix}`;
}
