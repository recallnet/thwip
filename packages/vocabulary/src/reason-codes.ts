/**
 * Every code any surface can be handed, in one closed union.
 *
 * Four vocabularies feed it: the queue's blocking reasons and attempt outcomes
 * (@thwip/queue-domain), the proof protocol's verifier codes (@thwip/protocol),
 * the codes the control plane writes on the wire, and the codes the CLI raises
 * about the local machine before anything is sent. The last two are declared
 * here rather than in the CLI, because the sentence for `DISPATCH_FAILED` is
 * read on the dashboard as well as in a terminal.
 *
 * Five lists, and six codes sit in two of them at once. MERGE_CONFLICT,
 * POLICY_CHANGED, MERGE_REJECTED, ADMIN_CANCELLED and INTERNAL_FAILURE are both
 * a blocking reason and an attempt outcome; MERGE_OUTCOME_UNKNOWN is both a
 * blocking reason and something the CLI raises about the local machine. Each
 * one names an event a developer meets from two directions, and the two lists
 * exist because the queue's state machine and the CLI's exit classes are
 * answering different questions about it.
 *
 * Sharing a code is safe here, and this is why. `NEXT_ACTION` is one `Record`
 * over the union of all five lists, so a code that appeared twice with two
 * sentences would be a duplicate key and would not compile. A code carries one
 * sentence however many lists declare it. The duplication costs a reader an
 * extra lookup to find which list a code came from, and it has never produced
 * two accounts of one event.
 */

import { ATTEMPT_OUTCOMES, BLOCKING_REASONS } from "@thwip/queue-domain";
import { REASON_CODES } from "@thwip/protocol";

/**
 * Codes the control plane puts on the wire as `reason`
 * (apps/control-plane/src/queue/routes.ts and queue/candidate-verdict.ts). They
 * are not part of the queue's blocking vocabulary, so nothing else declares them.
 */
export const SERVICE_REASONS = [
  "WAITING_FOR_TURN",
  "HOLDS_TURN",
  "LANE_IDLE",
  "DEVICE_ONLY",
  "DISPATCH_FAILED",
  "REBASELINE_REQUIRED",
  "NO_PINNED_VERIFIER",
  "WORK_RECEIPT_UNREADABLE",
  "MERGE_EVIDENCE_INCOMPLETE",
  "MERGE_INTENT_INVALID",
  // What the base branch's own rules require of the head, read before the queue
  // commits to a merge (apps/control-plane/src/queue/authorize-turn.ts).
  "REQUIRED_CHECK_MISSING",
  // How a merge is refused under `fresh` and `audited` when the device's run is
  // absent or is about another tree (apps/control-plane/src/queue/
  // local-run-gate.ts).
  "INTEGRATION_ASSIGNMENT_MISSING",
  "INTEGRATION_RECEIPT_MISSING",
  "INTEGRATION_RECEIPT_TREE_MISMATCH",
  // How the walk to a merge write refuses when the queue document and the
  // evidence disagree about the same turn (apps/control-plane/src/queue/
  // queue-operations.ts).
  "INTEGRATION_ASSIGNMENT_MISMATCH",
  "INTEGRATION_RECEIPT_MISMATCH",
  "INTEGRATION_RECEIPT_DEVICE_MISMATCH",
  "CANDIDATE_CHANGED",
  "CANDIDATE_DISPATCH_FAILED",
  "CANDIDATE_NOT_VERIFIED",
  "CANDIDATE_TREE_MISMATCH",
  "CANDIDATE_BASE_MOVED",
  "BASE_UNREADABLE",
  // The states candidate resolution can be in when it hands out no candidate
  // and the pull request itself is the reason (apps/control-plane/src/queue/
  // candidate.ts). The four the queue already blocks on — PR_CLOSED, PR_DRAFT,
  // BASE_NOT_MANAGED, MERGE_CONFLICT — are blocking reasons and are declared
  // there.
  "MERGEABILITY_UNKNOWN",
  "CANDIDATE_MISSING",
  "CANDIDATE_STALE",
  "CANDIDATE_PARENTS_UNEXPECTED",
  "CANDIDATE_REJECTED",
  "CANDIDATE_DIGEST_MISMATCH",
  "CANDIDATE_POLICY_MISMATCH",
  "CANDIDATE_SUITE_NOT_PASSED",
  "CANDIDATE_SUITES_INCOMPLETE",
  "CANDIDATE_SUITE_DUPLICATE",
  "CANDIDATE_VERIFIER_NOT_PINNED",
  // How the claim and receipt routes refuse a device under `fresh`
  // (apps/control-plane/src/queue/routes.ts).
  "ASSIGNMENT_MISMATCH",
  "DEVICE_MISMATCH",
] as const;

/** Codes the CLI raises about the local machine, before anything is sent. */
export const LOCAL_REASONS = [
  "LOGIN_REQUIRED",
  "DEVICE_NOT_ENROLLED",
  "UNCOMMITTED_CHANGES",
  "SUITE_FAILED",
  // What this machine refuses on its own, before it runs anything a turn
  // handed it (packages/cli/src/assignment.ts, candidate.ts).
  "ASSIGNMENT_UNVERIFIED",
  "ASSIGNMENT_EXPIRED",
  "CANDIDATE_UNAVAILABLE",
  // Attaching a proof rewrites the commit, so a branch that is already on the
  // remote diverges from it. Ship replaces the tip it rewrote itself; this is
  // the case where the remote holds a commit ship never had.
  "PUSH_REJECTED",
  // Ship pushed and then had no open pull request to queue. It used to carry on
  // to the queue anyway, so a run that opened nothing still printed
  // QUEUE_REQUESTED.
  "PR_NOT_OPENED",
  // Whatever threw before anything classified it. It exists so the process has
  // a code and a sentence to exit through instead of a stack trace.
  "LOCAL_FAILURE",
  "MERGE_OUTCOME_UNKNOWN",
  "QUEUE_NOT_CONFIGURED",
  "SERVICE_UNAVAILABLE",
  "NETWORK_UNAVAILABLE",
  "RATE_LIMITED",
] as const;

export type ReasonCode =
  | (typeof BLOCKING_REASONS)[number]
  | (typeof ATTEMPT_OUTCOMES)[number]
  | (typeof REASON_CODES)[number]
  | (typeof SERVICE_REASONS)[number]
  | (typeof LOCAL_REASONS)[number];

const ALL: readonly string[] = [
  ...BLOCKING_REASONS,
  ...ATTEMPT_OUTCOMES,
  ...REASON_CODES,
  ...SERVICE_REASONS,
  ...LOCAL_REASONS,
];

export function isReasonCode(value: string): value is ReasonCode {
  return ALL.includes(value);
}
