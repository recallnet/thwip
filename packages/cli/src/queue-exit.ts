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
 * The tables below are keyed by `ReasonCode`, a closed union assembled from the
 * queue's vocabulary, the proof protocol's vocabulary, the codes the control
 * plane writes on the wire, and the codes the CLI raises itself. `Record` over
 * that union means a code without a class or without a sentence fails the build,
 * which is how a hand-maintained table stopped drifting. A code that reaches the
 * CLI from a newer service is named in the output rather than filed under
 * something the CLI invented for it.
 */

import { ATTEMPT_OUTCOMES, BLOCKING_REASONS } from "@thwip/queue-domain";
import { REASON_CODES } from "@thwip/protocol";

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
] as const;

/** Codes the CLI raises about the local machine, before anything is sent. */
export const LOCAL_REASONS = [
  "LOGIN_REQUIRED",
  "DEVICE_NOT_ENROLLED",
  "UNCOMMITTED_CHANGES",
  "SUITE_FAILED",
  "MERGE_OUTCOME_UNKNOWN",
  "QUEUE_NOT_CONFIGURED",
  "SERVICE_UNAVAILABLE",
  "NETWORK_UNAVAILABLE",
  "RATE_LIMITED",
] as const;

/**
 * Every code the CLI can be handed. Closed on purpose: the classification and
 * the sentence are both `Record`s over this union, so adding a code to the
 * vocabulary without saying what it means will not compile.
 */
export type ReasonCode =
  | (typeof BLOCKING_REASONS)[number]
  | (typeof ATTEMPT_OUTCOMES)[number]
  | (typeof REASON_CODES)[number]
  | (typeof SERVICE_REASONS)[number]
  | (typeof LOCAL_REASONS)[number];

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
  LOCAL_RECEIPT_MISSING: EXIT.evidenceRejected,
  LOCAL_RECEIPT_REJECTED: EXIT.evidenceRejected,
  RECEIPT_REJECTED: EXIT.evidenceRejected,
  VERIFICATION_FAILED: EXIT.evidenceRejected,
  SIGNATURE_INVALID: EXIT.evidenceRejected,
  SIGNER_KEY_REVOKED: EXIT.evidenceRejected,
  SIGNER_KEY_UNKNOWN: EXIT.evidenceRejected,
  SIGNER_MISMATCH: EXIT.evidenceRejected,
  POLICY_NOT_ACTIVE: EXIT.evidenceRejected,
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
  AUDIT_REQUIRED: EXIT.humanRequired,

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
  PERMISSION_REVOKED: EXIT.sourceChanged,
  CANDIDATE_TREE_MISMATCH: EXIT.sourceChanged,
  CANDIDATE_POLICY_MISMATCH: EXIT.sourceChanged,

  /* Transient. */
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
  MERGE_EVIDENCE_INCOMPLETE: EXIT.invariant,
  MERGE_INTENT_INVALID: EXIT.invariant,
  CANDIDATE_DIGEST_MISMATCH: EXIT.invariant,
  AUDIT_DISAGREED: EXIT.invariant,
  BUNDLE_SIGNATURE_INVALID: EXIT.invariant,
};

/**
 * What to do about each reason, in one sentence a person can act on.
 *
 * The control plane writes the same sentences for the GitHub check
 * (apps/control-plane/src/queue/check.ts `NEXT_ACTION`) and they stopped at the
 * check. The shared ones are worded identically on purpose: a developer who
 * reads the check and then runs `thwip ship` must not be told two things.
 */
const ACTION: Record<ReasonCode, string> = {
  PASS: "Nothing to do.",

  UNCOMMITTED_CHANGES: "Commit or stash your changes. A proof binds the committed tree.",
  LOGIN_REQUIRED: "Run thwip login. It needs your browser, so run it in your own terminal.",
  DEVICE_NOT_ENROLLED: "Run thwip enroll on this machine to register its signing key.",
  OWNER_UNAUTHORIZED: "You no longer have the repository permission this queue requires.",
  SIGNER_PERMISSION_INSUFFICIENT:
    "The key that signed this proof belongs to someone without write access to the repository.",
  SPONSOR_REQUIRED: "A bot pull request needs a human sponsor before it can queue.",

  PROJECT_DISABLED: "This project is not enabled for the queue.",
  BASE_NOT_MANAGED:
    "This pull request targets a branch the queue does not manage. Retarget it, or ask an admin to enable the queue for that branch.",
  RULESET_DRIFT: "The repository ruleset no longer matches what the queue expects. An admin needs to look.",
  APP_PERMISSION_DRIFT: "The Thwip App is missing a permission it needs. An admin needs to reinstall it.",
  APP_UNINSTALLED: "The Thwip App was removed from this repository. An admin needs to install it again.",
  QUEUE_NOT_CONFIGURED: "This repository has no queue configured. Run thwip init, or ask an admin to enable it.",
  NO_PINNED_VERIFIER:
    "This project's security profile requires a run against the integrated candidate, and the policy pins no verifier workflow. An admin needs to pin one and name the required suites.",
  CANDIDATE_VERIFIER_NOT_PINNED:
    "The verdict came from a workflow the policy does not pin, so it proves nothing. An admin needs to pin the verifier workflow.",
  DISPATCH_FAILED: "GitHub refused to start the integration workflow. Fix what it refused, then queue again.",
  CANDIDATE_DISPATCH_FAILED:
    "GitHub refused to start the verifier workflow, so no verdict is coming. Fix what it refused, then queue again.",
  PROOF_SCHEMA_UNSUPPORTED: "This proof uses a newer format than this thwip understands. Update thwip.",
  SIGNER_KEY_ALGORITHM_FORBIDDEN:
    "The policy does not allow this key's algorithm. Sign with a key type the policy allows.",
  SUITE_MISSING: "The proof carries no result for a required suite. Add the suite to your pipeline and run thwip run again.",
  BUNDLE_EXPIRED: "The trust bundle on this machine expired. Run thwip login to refresh it.",

  SUITE_FAILED: "A required suite failed on your machine. Fix it and run thwip ship again.",
  SUITE_NOT_PASSED: "A required suite did not pass. Fix it and run thwip run again.",
  CI_FAILED: "The integration run failed. Fix it and push; your place in line is kept.",
  CANDIDATE_SUITE_NOT_PASSED:
    "A required suite failed against the merged candidate, so this change fails when combined with the base. Open the verifier run, fix it, and push.",
  CANDIDATE_SUITES_INCOMPLETE:
    "The verifier run did not report every required suite. Open the run to see which one is missing.",

  MERGE_OUTCOME_UNKNOWN:
    "The queue cannot tell whether the merge landed. It is reconciling and will not write again. Check the pull request before doing anything.",
  PROVIDER_FAILURE: "GitHub failed mid-operation. The queue is reconciling what happened.",

  LOCAL_RECEIPT_MISSING: "Run thwip run on this commit and push, so the head carries a proof.",
  LOCAL_RECEIPT_REJECTED: "The proof on this commit was not accepted. thwip verify explains why.",
  RECEIPT_REJECTED: "The proof for this attempt was refused. Run thwip verify to see which check refused it.",
  VERIFICATION_FAILED: "Verification of this attempt failed. Run thwip verify to see why.",
  SIGNATURE_INVALID: "The signature does not match the proof it covers. Run thwip run again to sign a fresh proof.",
  SIGNER_KEY_REVOKED: "The key that signed this proof is revoked. Enroll a current key and run thwip run again.",
  SIGNER_KEY_UNKNOWN: "The key that signed this proof is not enrolled. Run thwip enroll on the machine that signed it.",
  SIGNER_MISMATCH: "The proof names one signer and carries another's signature. Run thwip run again on the machine that owns the key.",
  POLICY_NOT_ACTIVE: "This proof was signed under a policy that is no longer active. Run thwip run again.",
  PIPELINE_DIGEST_MISMATCH: "The pipeline changed after this proof was signed. Run thwip run again.",
  PROOF_EXPIRED: "This proof is older than the policy allows. Run thwip run again.",
  PROOF_MISSING: "This commit carries no proof. Run thwip run and push again.",
  PROOF_DUPLICATE: "The commit message carries two proofs. Amend it to carry one, then push again.",
  PROOF_MALFORMED: "The proof on this commit does not parse. Run thwip run again to write a fresh one.",
  PROOF_TOO_LARGE: "The proof exceeds the size the protocol allows. Reduce what your pipeline records and run thwip run again.",
  SUBJECT_REPOSITORY_MISMATCH: "This proof was signed for another repository. Run thwip run here.",
  SUITE_DUPLICATE: "A suite reported twice in one proof. Run thwip run again with each suite named once.",
  LEASE_REQUIRED: "The policy requires a lease for this run. Run thwip run again so one is taken.",
  LEASE_INVALID: "The lease on this proof does not check out. Run thwip run again.",
  LEASE_EXPIRED: "The lease expired before the run finished. Run thwip run again.",
  LEASE_CONTEXT_MISMATCH: "The lease was issued for other work. Run thwip run again.",
  WORK_RECEIPT_UNREADABLE:
    "The head commit carries no readable proof, so the merge record has nothing to cite. Run thwip run and push again.",
  CANDIDATE_REJECTED: "The verifier refused this candidate. Open the verifier run to see what it refused.",
  CANDIDATE_SUITE_DUPLICATE:
    "The verifier reported the same suite twice, so its verdict was refused. An admin needs to fix the verifier workflow.",

  REVIEW_REQUIRED: "Ask for a review. The queue holds your place while you wait.",
  CODEOWNER_REVIEW_REQUIRED: "A code owner for the files you touched still needs to approve.",
  APPROVAL_AFTER_PUSH_REQUIRED: "You pushed after the last approval, so it needs approving again.",
  CONVERSATION_UNRESOLVED: "Resolve the open review conversations.",
  REQUIRED_CHECK_PENDING: "A required check is still running.",
  REQUIRED_CHECK_FAILED: "A required check failed. Fix it and push again; your place is kept.",
  VERIFICATION_REJECTED: "The verifier refused this candidate. Run thwip verify to see why; your place is kept.",
  PR_DRAFT: "Mark the pull request ready for review.",
  PR_CLOSED: "The pull request is closed.",
  QUEUE_PAUSED: "The queue is paused. An administrator can resume it.",
  REBASELINE_REQUIRED: "The branch moved outside the queue. An administrator has to rebaseline before merging resumes.",
  MERGE_REJECTED: "GitHub refused the merge. Read the branch protection rules on the base branch.",
  ADMIN_CANCELLED: "An administrator cancelled this attempt. Ask them why before queueing again.",
  AUDIT_REQUIRED: "This change was drawn for audit. It waits for the auditing run to finish.",

  MERGE_CONFLICT: "Rebase or merge the base branch to clear the conflict.",
  NEEDS_REPAIR:
    "The integration failed. Push a fix, then run `thwip ship --wait` again; your place in line is kept.",

  EXPIRED_UNCLAIMED: "The offer expired before this machine claimed it. The queue will offer another turn.",
  EXPIRED_EXECUTION: "The turn ran past its deadline and was released. The queue will offer another turn.",
  SUPERSEDED: "A newer attempt replaced this one. The queue is working on the newer one.",
  COOLDOWN_ACTIVE: "A turn was offered and not claimed, so there is a short cooldown before the next one.",
  AGENT_OFFLINE:
    "No machine of yours is connected to run the integration. Start thwip ship, or leave it queued and it will be offered again.",
  NO_COMPATIBLE_RUNNER: "No connected machine can run this project's pipeline.",
  WAITING_FOR_TURN: "You are queued and waiting for a turn. Nothing is required from you.",
  HOLDS_TURN: "This pull request holds the lane and is being integrated.",
  LANE_IDLE: "No turn is in flight for this branch, so there is nothing to nudge.",
  DEVICE_ONLY:
    "This project runs integrations on your own machine. Keep `thwip ship --wait` running and the queue will hand it the turn.",
  CANDIDATE_NOT_VERIFIED: "The verifier has not answered for this candidate yet. The queue is waiting for it.",
  CANDIDATE_BASE_MOVED: "The base moved, so the queue is rebuilding the candidate and running it again.",

  HEAD_MOVED: "You pushed during your turn, so the queue needs a proof for the new head. Run thwip ship again.",
  BASE_MOVED: "The base moved, so this proof no longer covers what would be merged. Run thwip ship again.",
  POLICY_CHANGED: "The project policy changed. The queue will re-evaluate on the new policy.",
  REVIEWS_CHANGED: "The reviews on this pull request changed while it was integrating. It goes back through the gate.",
  SUBJECT_TREE_MISMATCH: "This proof covers a different tree than the commit it sits on. Run thwip run again.",
  SUBJECT_ANCESTRY_MISMATCH: "The branch was rebased after this proof was signed. Run thwip run again.",
  SUBJECT_BASE_MISMATCH: "This proof names a different base than the pull request targets. Run thwip run again.",
  PERMISSION_REVOKED: "Your repository permission changed while this was integrating.",
  CANDIDATE_TREE_MISMATCH: "The verdict covers an older candidate. The queue is rebuilding it and running it again.",
  CANDIDATE_POLICY_MISMATCH:
    "The policy changed after the verifier ran, so its verdict no longer applies. The queue will run it again on the new policy.",

  SERVICE_UNAVAILABLE: "The queue service is unreachable. Try again shortly.",
  NETWORK_UNAVAILABLE: "This machine cannot reach the queue. Check your network and try again.",
  BUNDLE_UNAVAILABLE: "The trust bundle is unreachable, so no proof can be checked. Try again shortly.",
  RATE_LIMITED: "GitHub is rate limiting this repository. Wait for the limit to reset.",

  INVARIANT_FAILURE: "The queue found a contradiction and stopped. Send this output to whoever runs the queue.",
  CONFIRMED_NOT_MERGED:
    "The queue asked GitHub to merge and GitHub says nothing merged. Check the pull request before queueing again.",
  INTERNAL_FAILURE: "The queue failed internally. Send this output to whoever runs the queue.",
  MERGE_EVIDENCE_INCOMPLETE:
    "The queue refused to sign a merge record it cannot fully evidence. Send this output to whoever runs the queue.",
  MERGE_INTENT_INVALID:
    "The queue refused its own merge intent, so nothing was merged. Send this output to whoever runs the queue.",
  CANDIDATE_DIGEST_MISMATCH:
    "The stored verdict does not match its digest, so it was changed after the verifier wrote it. Send this output to whoever runs the queue.",
  AUDIT_DISAGREED:
    "An audit re-ran this work and got a different result. Send this output to whoever runs the queue.",
  BUNDLE_SIGNATURE_INVALID:
    "The trust bundle's signature does not check out, so nothing can be trusted from it. Send this output to whoever runs the queue.",
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
  if (isKnown(reasonCode)) return ACTION[reasonCode];
  return `This thwip does not know the reason code ${reasonCode}. Update thwip; the queue is running a newer version.`;
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
 * A one-line human summary: the code for an agent, then the sentence for the
 * person. Both are on the line because both readers are looking at it, and the
 * code alone told nobody what to do.
 */
export function humanSummary(input: { event: string; reasonCode?: string; detail?: string }): string {
  const suffix = input.detail === undefined ? "" : ` ${input.detail}`;
  if (input.reasonCode === undefined || input.reasonCode === "PASS") return `${input.event}${suffix}`;
  return `${input.event}: ${input.reasonCode}${suffix}. ${nextActionFor(input.reasonCode)}`;
}
