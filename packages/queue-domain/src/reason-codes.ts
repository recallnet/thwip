/**
 * Stable vocabulary for the branch queue. Every list here is closed: an
 * unrecognized value fails closed rather than being treated as benign
 * (plan.md §6.2 invariant 22).
 */

/** Why an entry is not currently mergeable (plan.md §7.2). */
export const BLOCKING_REASONS = [
  "PROJECT_DISABLED",
  "QUEUE_PAUSED",
  "PR_CLOSED",
  "PR_DRAFT",
  "BASE_NOT_MANAGED",
  "OWNER_UNAUTHORIZED",
  "SPONSOR_REQUIRED",
  "LOCAL_RECEIPT_MISSING",
  "LOCAL_RECEIPT_REJECTED",
  "REVIEW_REQUIRED",
  "CODEOWNER_REVIEW_REQUIRED",
  "APPROVAL_AFTER_PUSH_REQUIRED",
  "CONVERSATION_UNRESOLVED",
  "REQUIRED_CHECK_PENDING",
  "REQUIRED_CHECK_FAILED",
  "VERIFICATION_REJECTED",
  "MERGE_CONFLICT",
  "AGENT_OFFLINE",
  "NO_COMPATIBLE_RUNNER",
  "APP_PERMISSION_DRIFT",
  "RULESET_DRIFT",
  "POLICY_CHANGED",
  "COOLDOWN_ACTIVE",
  "NEEDS_REPAIR",
] as const;

export type BlockingReason = (typeof BLOCKING_REASONS)[number];

/**
 * Reasons that suppress scheduling without making the entry unready. An
 * offline laptop must not freeze the branch, and must not lose its place
 * either (plan.md §7.1).
 */
export const CAPABILITY_REASONS = ["AGENT_OFFLINE", "NO_COMPATIBLE_RUNNER"] as const;

export type CapabilityReason = (typeof CAPABILITY_REASONS)[number];

export function isCapabilityReason(reason: BlockingReason): reason is CapabilityReason {
  return (CAPABILITY_REASONS as readonly string[]).includes(reason);
}

/** Entry lifecycle (plan.md §9.3). */
export const ENTRY_STATES = [
  "Requested",
  "Blocked",
  "Ready",
  "Offered",
  "Active",
  "ReconnectGrace",
  "Verifying",
  "MergeGuard",
  "Merging",
  "Reconciling",
  "NeedsRepair",
  "Deferred",
  "Merged",
  "Cancelled",
] as const;

export type EntryState = (typeof ENTRY_STATES)[number];

export const TERMINAL_ENTRY_STATES = ["Merged", "Cancelled"] as const;

/**
 * Attempt phases, in the only order they may advance (plan.md §9.4).
 * Attempts never move backward, so the index in this array is the guard.
 */
export const ATTEMPT_PHASES = [
  "OFFERED",
  "CLAIMED",
  "PREPARING_CANDIDATE",
  "ASSIGNED",
  "RUNNING",
  "RECEIPT_SUBMITTED",
  "VERIFYING",
  "VERIFIED",
  "MERGE_INTENT_CREATED",
  "MERGE_REQUESTED",
  "AWAITING_CONFIRMATION",
  "MERGED",
] as const;

export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

export function phaseRank(phase: AttemptPhase): number {
  return ATTEMPT_PHASES.indexOf(phase);
}

/** Terminal non-merge outcomes (plan.md §9.4). */
export const ATTEMPT_OUTCOMES = [
  "EXPIRED_UNCLAIMED",
  "EXPIRED_EXECUTION",
  "CI_FAILED",
  "RECEIPT_REJECTED",
  "VERIFICATION_FAILED",
  "HEAD_MOVED",
  "BASE_MOVED",
  "POLICY_CHANGED",
  "REVIEWS_CHANGED",
  "PERMISSION_REVOKED",
  "MERGE_CONFLICT",
  "MERGE_REJECTED",
  "CONFIRMED_NOT_MERGED",
  "PROVIDER_FAILURE",
  "INVARIANT_FAILURE",
  "APP_UNINSTALLED",
  "ADMIN_CANCELLED",
  "SUPERSEDED",
  "INTERNAL_FAILURE",
] as const;

export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/**
 * Reconciliation is a phase of an unfinished attempt, not an outcome. Only a
 * confirmed merge, a confirmed non-merge, or operator resolution may end it
 * (plan.md §9.4).
 */
export const RECONCILING_RESOLUTIONS = [
  "MERGED",
  "CONFIRMED_NOT_MERGED",
  "PROVIDER_FAILURE",
  "INVARIANT_FAILURE",
] as const;

export type ReconcilingResolution = (typeof RECONCILING_RESOLUTIONS)[number];

/** How a transition entered the canonical chain (plan.md §21.8, §24). */
/**
 * `reused` is a merge that rested on the proof already carried by the head. It
 * is distinct from `verified` because a verified transition claims something ran
 * against the integrated candidate, and under that profile nothing did. A reader
 * auditing the chain has no other way to tell the two apart.
 */
export const TRANSITION_KINDS = ["genesis", "verified", "reused", "override", "external"] as const;

export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/** Who executed the integration run for an attempt (plan.md §8.2, §10). */
export const EXECUTION_MODES = ["device", "fast-reuse", "remote"] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const SYNTHETIC_EXECUTION_MODES = ["fast-reuse", "remote"] as const;

export function isSyntheticExecutionMode(mode: ExecutionMode): boolean {
  return (SYNTHETIC_EXECUTION_MODES as readonly string[]).includes(mode);
}
