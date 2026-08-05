import type { BranchQueueState } from "./reducer.js";

/**
 * A merge the queue can no longer wait on (plan.md §40.1).
 *
 * `Reconciling` is where an attempt goes when the queue cannot tell whether its
 * merge landed, and it is deliberately patient: it reads and never writes again.
 * Patience with no end is how attempt `att_2dc5e37e` held the lane for more than
 * twenty minutes past a 05:06:04 execution deadline while pull request 115 sat
 * Ready behind it, and an operator had to clear it by hand.
 *
 * A deadline cannot decide whether a merge landed; it can only trigger the
 * corroborated GitHub reads that can. The short merge-confirm deadline is the
 * normal trigger. The execution deadline remains the final fallback for older
 * documents or a confirmation clock lost before this rule existed.
 *
 * Pure, so the condition means the same thing to the reducer's tests, the
 * control plane and anyone reading a stored document.
 */
export interface OverdueReconciliation {
  readonly attemptId: string;
  readonly entryId: string;
  readonly pullRequestNumber: number;
  /** The commit whose presence on the base settles whether the merge landed. */
  readonly headSha: string | null;
  /** The deadline that made this reconciliation eligible. */
  readonly reconciliationDeadline: string;
  readonly trigger: "merge-confirm" | "execution";
}

export interface ReconciliationDeadline {
  readonly attemptId: string;
  readonly dueAt: string;
  readonly trigger: "merge-confirm" | "execution";
}

/** Name a doubtful merge once the clock that governs its next read is due. */
export function reconciliationAtDeadline(
  state: BranchQueueState,
  now: string,
  deadline: ReconciliationDeadline,
): OverdueReconciliation | null {
  if (deadline.dueAt > now || state.activeAttemptId !== deadline.attemptId) return null;

  const attempt = state.attempts.get(deadline.attemptId);
  if (attempt === undefined) return null;
  if (attempt.outcome !== null) return null;
  if (!attempt.outcomeUnknown) return null;

  const entry = state.entries.get(attempt.entryId);
  if (entry === undefined) return null;

  return {
    attemptId: deadline.attemptId,
    entryId: entry.entryId,
    pullRequestNumber: entry.pullRequestNumber,
    headSha: attempt.headSha,
    reconciliationDeadline: deadline.dueAt,
    trigger: deadline.trigger,
  };
}

/** Final fallback for a reconciliation whose shorter confirmation clock was lost. */
export function overdueReconciliation(state: BranchQueueState, now: string): OverdueReconciliation | null {
  const attemptId = state.activeAttemptId;
  if (attemptId === null) return null;
  const attempt = state.attempts.get(attemptId);
  if (attempt?.executionDeadline === null || attempt?.executionDeadline === undefined) return null;
  return reconciliationAtDeadline(state, now, {
    attemptId,
    dueAt: attempt.executionDeadline,
    trigger: "execution",
  });
}
