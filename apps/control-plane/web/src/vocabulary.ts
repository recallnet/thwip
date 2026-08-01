/**
 * Every code the dashboard can put in front of a person, in English.
 *
 * The queue and the verifier both speak in closed enums, and both of those
 * vocabularies leaked into the screen: a row read `SUBJECT_BASE_MISMATCH` and
 * stopped there. A code is a key for a program, not a sentence for a reader, so
 * this file is the single place a code becomes one. Nothing here invents a
 * meaning; each sentence restates what the verifier or the reducer already
 * decided, and names the move that clears it.
 *
 * The rule the tests hold: no SCREAMING_SNAKE string ever reaches the page.
 * Unknown codes are humanised rather than printed raw, so a vocabulary that
 * grows before this file does still reads as words.
 */

export type Tone = "ok" | "bad" | "wait";

export interface Outcome {
  /** Four or five words, for a table cell. */
  readonly label: string;
  /** What happened and what to do, for a tooltip or a second line. */
  readonly detail: string;
  readonly tone: Tone;
}

const RUN_AGAIN = "Run thwip run on this commit and push again.";

const OUTCOMES: Record<string, Outcome> = {
  PASS: {
    label: "Verified",
    detail: "The proof on this commit matched the active policy on every step.",
    tone: "ok",
  },
  BOOTSTRAP_PENDING: {
    label: "Waiting for a first proof",
    detail: "The App has not verified anything here yet. Run thwip run on a commit and push it.",
    tone: "wait",
  },

  PROOF_MISSING: {
    label: "No proof on the commit",
    detail: `The head commit carries no thwip proof. ${RUN_AGAIN}`,
    tone: "bad",
  },
  PROOF_DUPLICATE: {
    label: "More than one proof",
    detail: "The commit carries more than one proof trailer. Amend it so it carries exactly one.",
    tone: "bad",
  },
  PROOF_TOO_LARGE: {
    label: "Proof larger than allowed",
    detail: `The trailer is bigger than the check accepts. ${RUN_AGAIN}`,
    tone: "bad",
  },
  PROOF_MALFORMED: {
    label: "Proof could not be read",
    detail: `The trailer did not parse as a signed envelope. ${RUN_AGAIN}`,
    tone: "bad",
  },
  PROOF_SCHEMA_UNSUPPORTED: {
    label: "Proof written by a newer CLI",
    detail: "This proof uses a schema version the check does not know. Sign it with the CLI version this project runs.",
    tone: "bad",
  },
  SIGNATURE_INVALID: {
    label: "Signature did not verify",
    detail: `The signature does not cover these bytes, so the proof changed after it was signed. ${RUN_AGAIN}`,
    tone: "bad",
  },
  SIGNER_KEY_UNKNOWN: {
    label: "Signing key not listed on GitHub",
    detail: "GitHub does not list this key as a signing key for the signer. Add it under your GitHub key settings.",
    tone: "bad",
  },
  SIGNER_KEY_REVOKED: {
    label: "Signing key was denied",
    detail: "This key is denied in the organization or gone from GitHub. Sign with a key that is still current.",
    tone: "bad",
  },
  SIGNER_KEY_ALGORITHM_FORBIDDEN: {
    label: "Key algorithm not accepted",
    detail: "The policy does not accept this key's algorithm. Sign with an ed25519 key.",
    tone: "bad",
  },
  SIGNER_MISMATCH: {
    label: "Signer does not own the key",
    detail: "The proof names a signer who does not hold the signing key. Sign from the account that owns it.",
    tone: "bad",
  },
  SIGNER_PERMISSION_INSUFFICIENT: {
    label: "Signer lacks access on GitHub",
    detail: "GitHub no longer grants the signer enough permission on this repository to speak for it.",
    tone: "bad",
  },
  SUBJECT_REPOSITORY_MISMATCH: {
    label: "Proof names another repository",
    detail: `The proof was signed for a different repository than GitHub reports. ${RUN_AGAIN}`,
    tone: "bad",
  },
  SUBJECT_TREE_MISMATCH: {
    label: "Proof covers different code",
    detail: `The signed tree is not the tree of this commit, so something changed after the run. ${RUN_AGAIN}`,
    tone: "bad",
  },
  SUBJECT_ANCESTRY_MISMATCH: {
    label: "Proof covers a different history",
    detail: `A rebase, squash, or amend moved this commit off the ancestry the proof records. ${RUN_AGAIN}`,
    tone: "bad",
  },
  SUBJECT_BASE_MISMATCH: {
    label: "Proof was run against an older base",
    detail:
      "The branch now sits on a different base than the proof records. Pull the base branch, then run thwip run and push.",
    tone: "bad",
  },
  POLICY_NOT_ACTIVE: {
    label: "Policy is not the active one",
    detail: `The proof names a policy that is not active for this repository. ${RUN_AGAIN}`,
    tone: "bad",
  },
  PIPELINE_DIGEST_MISMATCH: {
    label: "Pipeline does not match the policy",
    detail: `The pipeline that ran is not the one the active policy names. Pull the current thwip.yaml, then ${lower(RUN_AGAIN)}`,
    tone: "bad",
  },
  SUITE_MISSING: {
    label: "A required suite did not run",
    detail: "The policy requires a suite this proof does not report. Run the whole pipeline with thwip run.",
    tone: "bad",
  },
  SUITE_DUPLICATE: {
    label: "A suite was reported twice",
    detail: `The proof reports the same suite id more than once. ${RUN_AGAIN}`,
    tone: "bad",
  },
  SUITE_NOT_PASSED: {
    label: "A required suite failed",
    detail: "At least one required suite did not pass. Fix it, then run thwip run and push.",
    tone: "bad",
  },
  PROOF_EXPIRED: {
    label: "Proof is older than allowed",
    detail: `The run finished outside the policy's maximum proof age. ${RUN_AGAIN}`,
    tone: "bad",
  },
  LEASE_REQUIRED: {
    label: "This profile needs a lease",
    detail: "The policy's profile asks the run to claim a lease before it starts. Sign in, then run thwip run.",
    tone: "bad",
  },
  LEASE_INVALID: {
    label: "Lease did not check out",
    detail: `The lease the run carries is not one the control plane issued. ${RUN_AGAIN}`,
    tone: "bad",
  },
  LEASE_EXPIRED: {
    label: "Lease expired mid-run",
    detail: `The lease ran out before the run finished. ${RUN_AGAIN}`,
    tone: "bad",
  },
  LEASE_CONTEXT_MISMATCH: {
    label: "Lease was issued for another run",
    detail: `The lease names a different tree, signer, or policy than this run used. ${RUN_AGAIN}`,
    tone: "bad",
  },
  AUDIT_REQUIRED: {
    label: "An independent rerun is required",
    detail: "The policy asks for an independent rerun of this pipeline before the check may pass.",
    tone: "wait",
  },
  AUDIT_DISAGREED: {
    label: "The independent rerun disagreed",
    detail: "A rerun did not reproduce the signed result. Treat the claim as unproven and look at both runs.",
    tone: "bad",
  },
  BUNDLE_UNAVAILABLE: {
    label: "GitHub's evidence is missing",
    detail: "The check could not read the provenance GitHub signs for this run. Re-run the workflow.",
    tone: "bad",
  },
  BUNDLE_SIGNATURE_INVALID: {
    label: "GitHub's evidence did not verify",
    detail: "The provenance GitHub signed did not verify against GitHub's own key. Re-run the workflow.",
    tone: "bad",
  },
  BUNDLE_EXPIRED: {
    label: "GitHub's evidence is too old",
    detail: "The signed provenance is older than the policy allows. Re-run the workflow.",
    tone: "bad",
  },
};

function lower(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

/**
 * Turn a code nobody has written a sentence for into words anyway.
 * `SUBJECT_BASE_MISMATCH` becomes "Subject base mismatch": still terse, but a
 * reader can say it out loud, and it will not be mistaken for a database key.
 */
export function humanise(code: string): string {
  const words = code.toLowerCase().replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function outcome(code: string): Outcome {
  const known = OUTCOMES[code];
  if (known) return known;
  return {
    label: humanise(code),
    detail: "The check reported something this dashboard has no guidance for yet. Run thwip verify to see the detail.",
    tone: code === "PASS" ? "ok" : "bad",
  };
}

/* ---------- time ---------- */

/**
 * "2h ago" beats an ISO instant for a reader scanning a list. Two copies of
 * this existed and disagreed about whether a stamp without a zone was UTC; the
 * control plane writes UTC, so it is.
 */
export function whenText(iso: string | null): string {
  if (iso === null) return "not recorded";
  const at = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(at)) return "not recorded";
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString();
}

/* ---------- queue entry states ---------- */

const ENTRY_STATE: Record<string, string> = {
  Requested: "Joining the line",
  Blocked: "Blocked",
  Ready: "Ready for a turn",
  Offered: "Offered a turn",
  Active: "Taking its turn",
  ReconnectGrace: "Waiting for the machine",
  Verifying: "Verifying the candidate",
  MergeGuard: "Last checks before merge",
  Merging: "Merging",
  Reconciling: "Confirming the merge",
  NeedsRepair: "Needs a fix",
  Deferred: "Stood down for now",
  Merged: "Merged",
  Cancelled: "Cancelled",
};

export function entryStateText(state: string): string {
  return ENTRY_STATE[state] ?? humanise(state);
}

export function entryStateTone(state: string, blocked: boolean): Tone {
  if (state === "Merged") return "ok";
  if (state === "Cancelled" || state === "NeedsRepair") return "bad";
  if (state === "Blocked") return blocked ? "bad" : "wait";
  return "wait";
}

/* ---------- queue blocking reasons ---------- */

/**
 * The same guidance the check publishes, so a developer reading the dashboard
 * and a developer reading a red check are told the same thing.
 */
export const BLOCKED_NEXT_ACTION: Record<string, string> = {
  REVIEW_REQUIRED: "Ask for a review. The queue holds this place while it waits.",
  CODEOWNER_REVIEW_REQUIRED: "A code owner for the changed files still needs to approve.",
  APPROVAL_AFTER_PUSH_REQUIRED: "Pushed after the last approval, so it needs approving again.",
  CONVERSATION_UNRESOLVED: "Resolve the open review conversations.",
  REQUIRED_CHECK_PENDING: "A required check is still running.",
  REQUIRED_CHECK_FAILED: "A required check failed. Fix and push; the place is kept.",
  VERIFICATION_REJECTED: "The verifier refused the candidate. thwip verify explains why; the place is kept.",
  MERGE_CONFLICT: "Rebase or merge the base branch to clear the conflict.",
  LOCAL_RECEIPT_MISSING: "Run thwip run on this commit and push.",
  LOCAL_RECEIPT_REJECTED: "The proof was not accepted. thwip verify explains why.",
  AGENT_OFFLINE: "No machine is connected to run the integration.",
  NO_COMPATIBLE_RUNNER: "No connected machine can run this project's pipeline.",
  PR_DRAFT: "Mark the pull request ready for review.",
  PR_CLOSED: "The pull request is closed.",
  OWNER_UNAUTHORIZED: "The owner no longer has the required repository permission.",
  SPONSOR_REQUIRED: "A bot pull request needs a human sponsor.",
  COOLDOWN_ACTIVE: "A turn was offered and not claimed; short cooldown before the next.",
  NEEDS_REPAIR: "Integration failed. Push a fix; the place in line is kept.",
  POLICY_CHANGED: "The policy changed; the queue will re-evaluate against the new one.",
  RULESET_DRIFT: "The repository ruleset no longer matches what the queue expects.",
  APP_PERMISSION_DRIFT: "The thwip App is missing a permission it needs.",
  PROJECT_DISABLED: "This project is not enabled for the queue.",
  QUEUE_PAUSED: "The queue is paused.",
  BASE_NOT_MANAGED: "This pull request targets a branch the queue does not manage.",
  // A turn can end for reasons that have nothing to do with the branch. These
  // four are word-for-word what `thwip ship` prints for the same code, because
  // the whole point of naming them apart from NEEDS_REPAIR is that a developer
  // is not told to fix a branch that is fine, and is not told two different
  // things by the terminal and the dashboard.
  MERGE_REJECTED: "GitHub refused the merge. Read the branch protection rules on the base branch.",
  MERGE_OUTCOME_UNKNOWN:
    "The queue cannot tell whether the merge landed. It is reconciling and will not write again. Check the pull request before doing anything.",
  ADMIN_CANCELLED: "An administrator cancelled this attempt. Ask them why before queueing again.",
  INTERNAL_FAILURE: "The queue failed internally. Send this output to whoever runs the queue.",
};

/**
 * A reason with no written guidance is still not allowed to arrive as a code.
 * It is said in words and the reader is pointed somewhere that can answer.
 */
export function blockedNextAction(reason: string | null): string | null {
  if (reason === null) return null;
  return BLOCKED_NEXT_ACTION[reason] ?? `${humanise(reason)}. Ask an administrator; the place in line is kept.`;
}

/* ---------- owners ---------- */

/**
 * `prn_gh_370259` is a row id. A person reading a queue wants a person.
 * The id already carries the GitHub user id, so a login from the organization
 * projection resolves it; without one, it is at least stated as a GitHub user
 * rather than as a key.
 */
export function ownerName(principalId: string, loginByGithubUserId: ReadonlyMap<string, string>): string {
  const githubUserId = /^prn_gh_(\d+)$/.exec(principalId)?.[1];
  if (githubUserId === undefined) return principalId;
  return loginByGithubUserId.get(githubUserId) ?? `GitHub user ${githubUserId}`;
}

export function ownerGithubUrl(
  principalId: string,
  loginByGithubUserId: ReadonlyMap<string, string>,
): string | null {
  const githubUserId = /^prn_gh_(\d+)$/.exec(principalId)?.[1];
  if (githubUserId === undefined) return null;
  const login = loginByGithubUserId.get(githubUserId);
  return login === undefined ? null : `https://github.com/${login}`;
}

/* ---------- project vocabulary ---------- */

export function proofCheckModeText(mode: string): string {
  if (mode === "enforced") return "App check enforcing";
  if (mode === "observe") return "App check observing";
  return `App check ${humanise(mode).toLowerCase()}`;
}

export function activationText(state: string): string {
  switch (state) {
    case "active":
      return "Active";
    case "awaiting_policy":
      return "Awaiting policy";
    case "disabled":
      return "Disabled";
    default:
      return humanise(state);
  }
}

export function configSourceText(source: string | null): string {
  switch (source) {
    case "repository-override":
      return "repository override over organization defaults";
    case "repository":
      return "committed thwip.yaml";
    case "global":
      return "organization defaults";
    default:
      return "add organization defaults, or activate from the canonical default branch";
  }
}

export function policyStatusText(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "superseded":
      return "Superseded";
    case "pending":
      return "Pending";
    default:
      return humanise(status);
  }
}

/** What a recorded move of the protected branch means, in a reader's words. */
export function transitionKindText(kind: string): string {
  switch (kind) {
    case "verified":
      return "Merged by the queue";
    // A merge accepted on the proof already carried by the head, where the
    // policy asked for nothing more. Named apart from a verified merge because
    // the two make different claims about what was checked.
    case "reused":
      return "Merged on the head's own proof";
    case "override":
      return "Merged with an override";
    case "external":
      return "Moved outside the queue";
    case "genesis":
      return "Queue opened here";
    default:
      return humanise(kind);
  }
}
