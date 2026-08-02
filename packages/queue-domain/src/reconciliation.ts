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
 * The alarm could not end it either. `EXPIRED_EXECUTION` is refused for an
 * attempt whose outcome is in doubt, correctly: a deadline says a run took too
 * long, and it has nothing to say about whether a merge landed. So the deadline
 * cannot be the answer, only the trigger. This names the attempt, and the
 * caller goes and reads GitHub before anything is written down.
 *
 * Pure, and keyed on the execution deadline the attempt already carries, so the
 * condition means the same thing to the reducer's tests, the control plane and
 * anyone reading a stored document.
 */
export interface OverdueReconciliation {
  readonly attemptId: string;
  readonly entryId: string;
  readonly pullRequestNumber: number;
  /** The commit whose presence on the base settles whether the merge landed. */
  readonly headSha: string | null;
  readonly executionDeadline: string;
}

export function overdueReconciliation(state: BranchQueueState, now: string): OverdueReconciliation | null {
  const attemptId = state.activeAttemptId;
  if (attemptId === null) return null;

  const attempt = state.attempts.get(attemptId);
  if (attempt === undefined) return null;
  if (attempt.outcome !== null) return null;
  if (!attempt.outcomeUnknown) return null;
  if (attempt.executionDeadline === null || attempt.executionDeadline > now) return null;

  const entry = state.entries.get(attempt.entryId);
  if (entry === undefined) return null;

  return {
    attemptId,
    entryId: entry.entryId,
    pullRequestNumber: entry.pullRequestNumber,
    headSha: attempt.headSha,
    executionDeadline: attempt.executionDeadline,
  };
}
