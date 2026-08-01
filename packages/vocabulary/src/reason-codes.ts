/**
 * Every code any surface can be handed, in one closed union.
 *
 * Four vocabularies feed it: the queue's blocking reasons and attempt outcomes
 * (@thwip/queue-domain), the proof protocol's verifier codes (@thwip/protocol),
 * the codes the control plane writes on the wire, and the codes the CLI raises
 * about the local machine before anything is sent. The last two are declared
 * here rather than in the CLI, because the sentence for `DISPATCH_FAILED` is
 * read on the dashboard as well as in a terminal.
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
  "CANDIDATE_DISPATCH_FAILED",
  "CANDIDATE_NOT_VERIFIED",
  "CANDIDATE_TREE_MISMATCH",
  "CANDIDATE_BASE_MOVED",
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

/** Every code the union covers, deduplicated, for exhaustiveness tests. */
export function reasonCodes(): ReasonCode[] {
  return [...new Set(ALL)] as ReasonCode[];
}

export function isReasonCode(value: string): value is ReasonCode {
  return ALL.includes(value);
}
