/**
 * What to do about each reason code, in one sentence, written once.
 *
 * Three surfaces tell a developer why their pull request stopped: the GitHub
 * check, the CLI, and the dashboard. Each kept its own copy of these sentences,
 * copied across by hand, and the copies drifted. One event was reported as "the
 * source changed" in the terminal and "push a fix" on the dashboard, which sent
 * a developer to edit code that was fine. The table below is the only copy.
 *
 * `Record<ReasonCode, string>` closes it: a code added to the queue's
 * vocabulary, to the proof protocol, or to the wire without a sentence here
 * fails to compile, on every surface at once.
 *
 * A surface may still need its own wording where its context genuinely differs,
 * so `SURFACE_NEXT_ACTION` holds those and nothing else. Each one carries the
 * reason it exists, and the test beside this file fails when an undeclared one
 * appears.
 */

import type { ReasonCode } from "./reason-codes.js";

/** Where a sentence is read. */
export const SURFACES = ["check", "terminal", "dashboard"] as const;

export type Surface = (typeof SURFACES)[number];

export const NEXT_ACTION: Record<ReasonCode, string> = {
  PASS: "Nothing to do.",

  /* Before anything is sent. */
  UNCOMMITTED_CHANGES: "Commit or stash your changes. A proof binds the committed tree.",
  LOGIN_REQUIRED: "Run thwip login. It needs your browser, so run it in your own terminal.",
  DEVICE_NOT_ENROLLED: "Run thwip enroll on this machine to register its signing key.",

  /* Permission. */
  OWNER_UNAUTHORIZED: "You no longer have the repository permission this queue requires.",
  SIGNER_PERMISSION_INSUFFICIENT:
    "The signer lacks the repository permission the policy requires, or the policy does not let an author sign their own pull request.",
  SPONSOR_REQUIRED: "A bot pull request needs a human sponsor before it can queue.",
  PERMISSION_REVOKED: "Your repository permission changed while this was integrating.",

  /* Configuration. */
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
  PROOF_SCHEMA_UNSUPPORTED:
    "This proof uses a format the checker does not know. Sign it with the thwip version this project runs.",
  SIGNER_KEY_ALGORITHM_FORBIDDEN:
    "The policy does not allow this key's algorithm. Sign with a key type the policy allows.",
  SUITE_MISSING:
    "The proof carries no result for a required suite. Add the suite to your pipeline and run thwip run again.",
  BUNDLE_EXPIRED: "The trust bundle expired, so no proof can be checked against it. Run thwip login to refresh it.",

  /* The turn handed this machine work it refused to do. */
  ASSIGNMENT_UNVERIFIED:
    "The turn thwip handed this machine is not signed by a key thwip publishes, so nothing was run. Run thwip ship again, and if it happens twice send this output to whoever runs the queue.",
  ASSIGNMENT_EXPIRED:
    "The turn's execution window closed before the suites finished. Run thwip ship again and the queue will hand you another.",
  ASSIGNMENT_MISMATCH:
    "The receipt this machine signed answers a turn the queue is no longer running. Run thwip ship again to take a current one.",
  DEVICE_MISMATCH:
    "Another machine holds this turn. Run thwip ship on the machine that claimed it, or wait for the queue to offer the turn here.",
  CANDIDATE_UNAVAILABLE:
    "This machine cannot fetch the merged commit the queue built, so there is nothing to run the suites against. Check that you can reach origin, then run thwip ship again.",

  /* The local machine stopped before it could name anything better. */
  PUSH_REJECTED:
    "The remote branch holds a commit this machine does not have, so nothing was pushed. Fetch and rebase onto it, then run thwip ship again.",
  LOCAL_FAILURE:
    "Thwip stopped on a failure it has no reason code for. The line above is what failed; if it repeats, send it to whoever runs the queue.",

  /* The work itself failed. */
  SUITE_FAILED: "A required suite failed on your machine. Fix it and run thwip ship again.",
  SUITE_NOT_PASSED: "A required suite did not pass. Fix it and run thwip run again.",
  CI_FAILED: "The integration run failed. Fix it and push; your place in line is kept.",
  CANDIDATE_SUITE_NOT_PASSED:
    "A required suite failed against the merged candidate, so this change fails when combined with the base. Open the verifier run, fix it, and push.",
  CANDIDATE_SUITES_INCOMPLETE:
    "The verifier run did not report every required suite. Open the run to see which one is missing.",

  /* Nobody can tell what happened, so nobody may assume. */
  MERGE_OUTCOME_UNKNOWN:
    "The queue cannot tell whether the merge landed. It is reconciling and will not write again. Check the pull request before doing anything.",
  PROVIDER_FAILURE: "GitHub failed mid-operation. The queue is reconciling what happened.",
  VERIFICATION_PENDING:
    "The evidence for this commit has not settled, so there is no verdict to read yet. Check again shortly.",

  /* Evidence was refused. */
  LOCAL_RECEIPT_MISSING: "Run thwip run on this commit and push, so the head carries a proof.",
  LOCAL_RECEIPT_REJECTED: "The proof on this commit was not accepted. thwip verify explains why.",
  RECEIPT_REJECTED: "The proof for this attempt was refused. Run thwip verify to see which check refused it.",
  VERIFICATION_FAILED: "Verification of this attempt failed. Run thwip verify to see why.",
  SIGNATURE_INVALID:
    "The signature does not match the proof it covers, so the proof changed after it was signed. Run thwip run again to sign a fresh one.",
  SIGNER_KEY_REVOKED: "The key that signed this proof is revoked. Enroll a current key and run thwip run again.",
  SIGNER_KEY_UNKNOWN:
    "This repository does not accept the key that signed the proof. Run thwip enroll on the machine that signed it, and where the policy asks for it, publish that key on the signer's GitHub account.",
  SIGNER_MISMATCH:
    "The proof names one signer and carries another's signature. Run thwip run again on the machine that owns the key.",
  POLICY_NOT_ACTIVE: "This proof was signed under a policy that is no longer active. Run thwip run again.",
  PIPELINE_DIGEST_MISMATCH:
    "The pipeline changed after this proof was signed. Pull the current thwip.yaml, then run thwip run again.",
  PROOF_EXPIRED: "This proof is older than the policy allows. Run thwip run again.",
  PROOF_MISSING: "This commit carries no proof. Run thwip run and push again.",
  PROOF_DUPLICATE: "The commit message carries more than one proof. Amend it to carry exactly one, then push again.",
  PROOF_MALFORMED: "The proof on this commit does not parse. Run thwip run again to write a fresh one.",
  PROOF_TOO_LARGE:
    "The proof exceeds the size the protocol allows. Reduce what your pipeline records and run thwip run again.",
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

  /* A person has to do something. Retrying will not help. */
  REVIEW_REQUIRED: "Ask for a review. The queue holds your place while you wait.",
  CODEOWNER_REVIEW_REQUIRED: "A code owner for the files you touched still needs to approve.",
  APPROVAL_AFTER_PUSH_REQUIRED: "You pushed after the last approval, so it needs approving again.",
  CONVERSATION_UNRESOLVED: "Resolve the open review conversations.",
  REQUIRED_CHECK_PENDING: "A required check is still running.",
  REQUIRED_CHECK_FAILED: "A required check failed. Fix it and push again; your place is kept.",
  VERIFICATION_REJECTED:
    "The verifier refused this candidate. Run thwip verify to see why; your place is kept.",
  PR_DRAFT: "Mark the pull request ready for review.",
  PR_CLOSED: "The pull request is closed.",
  QUEUE_PAUSED: "The queue is paused. An administrator can resume it.",
  REBASELINE_REQUIRED:
    "The branch moved outside the queue. An administrator has to rebaseline before merging resumes.",
  MERGE_REJECTED: "GitHub refused the merge. Read the branch protection rules on the base branch.",
  ADMIN_CANCELLED: "An administrator cancelled this attempt. Ask them why before queueing again.",

  /* The branch needs work before it can integrate. */
  MERGE_CONFLICT: "Rebase or merge the base branch to clear the conflict.",
  NEEDS_REPAIR: "The integration failed. Push a fix; your place in line is kept.",

  /* The turn was lost but the place in line was not. */
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

  /* What was being integrated is no longer what is there. */
  HEAD_MOVED: "You pushed during your turn, so the queue needs a proof for the new head. Run thwip ship again.",
  BASE_MOVED: "The base moved, so this proof no longer covers what would be merged. Run thwip ship again.",
  POLICY_CHANGED: "The project policy changed. The queue will re-evaluate on the new policy.",
  REVIEWS_CHANGED:
    "The reviews on this pull request changed while it was integrating. It goes back through the gate.",
  SUBJECT_TREE_MISMATCH: "This proof covers a different tree than the commit it sits on. Run thwip run again.",
  SUBJECT_ANCESTRY_MISMATCH:
    "A rebase, squash, or amend moved this commit off the history the proof records. Run thwip run again.",
  SUBJECT_BASE_MISMATCH:
    "This proof names a different base than the pull request targets. Pull the base branch, then run thwip run again.",
  CANDIDATE_TREE_MISMATCH: "The verdict covers an older candidate. The queue is rebuilding it and running it again.",
  CANDIDATE_POLICY_MISMATCH:
    "The policy changed after the verifier ran, so its verdict no longer applies. The queue will run it again on the new policy.",

  /* Transient. */
  SERVICE_UNAVAILABLE: "The queue service is unreachable. Try again shortly.",
  NETWORK_UNAVAILABLE: "This machine cannot reach the queue. Check your network and try again.",
  BUNDLE_UNAVAILABLE: "The trust bundle is unreachable, so no proof can be checked. Try again shortly.",
  RATE_LIMITED: "GitHub is rate limiting this repository. Wait for the limit to reset.",

  /* Something disagreed that should not have. */
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
  BUNDLE_SIGNATURE_INVALID:
    "The trust bundle's signature does not check out, so nothing can be trusted from it. Send this output to whoever runs the queue.",
};

/**
 * The sentences that are deliberately not shared, and why.
 *
 * Everything absent from here is identical on all three surfaces. A surface
 * earns an entry when its reader is somewhere the others are not, which so far
 * means: standing at a prompt where the next command can be named, or reading a
 * panel that reports a state rather than asking for a move.
 */
export const SURFACE_NEXT_ACTION: Record<Surface, Partial<Record<ReasonCode, string>>> = {
  check: {},

  terminal: {
    // The reader is at a prompt with the command in their history, so name it.
    // The check and the dashboard cannot run it for them.
    NEEDS_REPAIR:
      "The integration failed. Push a fix, then run `thwip ship --wait` again; your place in line is kept.",
    // In a terminal the checker is this build of thwip, and the reader owns it.
    // On the other two surfaces the checker is the service, and the fix is to
    // sign with the version the project runs.
    PROOF_SCHEMA_UNSUPPORTED: "This proof uses a newer format than this thwip understands. Update thwip.",
  },

  dashboard: {
    // The verification panel reports what was proven about a commit. "Nothing to
    // do" answers a command that finished; it answers nothing on a page that is
    // showing a green result.
    PASS: "The proof on this commit matched the active policy on every step.",
  },
};

export function nextActionFor(code: ReasonCode, surface: Surface): string {
  return SURFACE_NEXT_ACTION[surface][code] ?? NEXT_ACTION[code];
}
