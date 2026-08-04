/**
 * Every code the dashboard can put in front of a person, in English.
 *
 * The queue and the verifier both speak in closed enums, and both of those
 * vocabularies leaked into the screen: a row read `SUBJECT_BASE_MISMATCH` and
 * stopped there. A code is a key for a program, not a sentence for a reader, so
 * this file turns every one of them into words.
 *
 * The words for a reason code come from @thwip/vocabulary. The check and the
 * CLI read that table too, and this file used to keep its own shortened copy of
 * it, which drifted. What stays here is what only a page has: a short label for
 * a table cell, a tone, and the names of states no reason code covers.
 *
 * The rule the tests hold: no SCREAMING_SNAKE string ever reaches the page.
 * Unknown codes are humanised rather than printed raw, so a vocabulary that
 * grows before this file does still reads as words.
 */

import type { ReasonCode as ProtocolReasonCode } from "@thwip/protocol";
import { isReasonCode, nextActionFor } from "@thwip/vocabulary";

export type Tone = "ok" | "bad" | "wait";

export interface Outcome {
  /** Four or five words, for a table cell. */
  readonly label: string;
  /** What happened and what to do, for a tooltip or a second line. */
  readonly detail: string;
  readonly tone: Tone;
}

/**
 * The label and the tone are the dashboard's own: a terminal has no table cell
 * to fill and no colour to set. The sentence under them is not, and used to be.
 * It comes from @thwip/vocabulary, the table the GitHub check and the CLI read,
 * so a reader who sees a result here and then runs thwip is told one thing.
 *
 * Keyed by the protocol's own union, so a verifier code added without a label
 * fails to compile. `BOOTSTRAP_PENDING` is not one of those codes: the
 * projection reports it before anything has been verified, and only a page has
 * that state to show.
 */
const OUTCOME_STYLE: Record<ProtocolReasonCode | "BOOTSTRAP_PENDING", Omit<Outcome, "detail">> = {
  PASS: { label: "Verified", tone: "ok" },
  BOOTSTRAP_PENDING: { label: "Waiting for a first proof", tone: "wait" },

  PROOF_MISSING: { label: "No proof on the commit", tone: "bad" },
  PROOF_DUPLICATE: { label: "More than one proof", tone: "bad" },
  PROOF_TOO_LARGE: { label: "Proof larger than allowed", tone: "bad" },
  PROOF_MALFORMED: { label: "Proof could not be read", tone: "bad" },
  PROOF_SCHEMA_UNSUPPORTED: { label: "Proof written by a newer CLI", tone: "bad" },
  SIGNATURE_INVALID: { label: "Signature did not verify", tone: "bad" },
  SIGNER_KEY_UNKNOWN: { label: "Signing key not accepted here", tone: "bad" },
  SIGNER_KEY_REVOKED: { label: "Signing key was revoked", tone: "bad" },
  SIGNER_KEY_ALGORITHM_FORBIDDEN: { label: "Key algorithm not accepted", tone: "bad" },
  SIGNER_MISMATCH: { label: "Signer does not own the key", tone: "bad" },
  SIGNER_PERMISSION_INSUFFICIENT: { label: "Signer lacks the access required", tone: "bad" },
  SUBJECT_REPOSITORY_MISMATCH: { label: "Proof names another repository", tone: "bad" },
  SUBJECT_TREE_MISMATCH: { label: "Proof covers different code", tone: "bad" },
  SUBJECT_ANCESTRY_MISMATCH: { label: "Proof covers a different history", tone: "bad" },
  SUBJECT_BASE_MISMATCH: { label: "Proof was run against an older base", tone: "bad" },
  PIPELINE_DIGEST_MISMATCH: { label: "Pipeline does not match the policy", tone: "bad" },
  SUITE_MISSING: { label: "A required suite did not run", tone: "bad" },
  SUITE_DUPLICATE: { label: "A suite was reported twice", tone: "bad" },
  SUITE_NOT_PASSED: { label: "A required suite failed", tone: "bad" },
  PROOF_EXPIRED: { label: "Proof is older than allowed", tone: "bad" },
  LEASE_REQUIRED: { label: "This profile needs a lease", tone: "bad" },
  LEASE_INVALID: { label: "Lease did not check out", tone: "bad" },
  LEASE_EXPIRED: { label: "Lease expired mid-run", tone: "bad" },
  LEASE_CONTEXT_MISMATCH: { label: "Lease was issued for another run", tone: "bad" },
  BUNDLE_UNAVAILABLE: { label: "Trust bundle could not be read", tone: "bad" },
  BUNDLE_SIGNATURE_INVALID: { label: "Trust bundle did not verify", tone: "bad" },
  BUNDLE_EXPIRED: { label: "Trust bundle is out of date", tone: "bad" },
  VERIFICATION_PENDING: { label: "Waiting on the evidence", tone: "wait" },
};

/** The one state the dashboard shows that no reason code covers. */
const BOOTSTRAP_PENDING_DETAIL =
  "The App has not verified anything here yet. Run thwip run on a commit and push it.";

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
  const style = OUTCOME_STYLE[code as keyof typeof OUTCOME_STYLE];
  if (style === undefined) {
    return {
      label: humanise(code),
      detail: "The check reported something this dashboard has no guidance for yet. Run thwip verify to see the detail.",
      tone: code === "PASS" ? "ok" : "bad",
    };
  }
  const detail =
    code === "BOOTSTRAP_PENDING"
      ? BOOTSTRAP_PENDING_DETAIL
      : nextActionFor(code as ProtocolReasonCode, "dashboard");
  return { ...style, detail };
}

/* ---------- time ---------- */

/**
 * "2h ago" beats an ISO instant for a reader scanning a list. Two copies of
 * this existed and disagreed about whether a stamp without a zone was UTC; the
 * control plane writes UTC, so it is.
 */
export function whenText(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return "not recorded";
  const at = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(at)) return "not recorded";
  const minutes = Math.floor((now - at) / 60_000);
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
 * A reason with no written guidance is still not allowed to arrive as a code.
 * It is said in words and the reader is pointed somewhere that can answer.
 */
export function blockedNextAction(reason: string | null): string | null {
  if (reason === null) return null;
  if (isReasonCode(reason)) return nextActionFor(reason, "dashboard");
  return `${humanise(reason)}. Ask an administrator; the place in line is kept.`;
}

/**
 * How old the answer behind a blocker is.
 *
 * The queue read serves a projection by default, and a projection is what
 * somebody wrote down the last time a command ran. When the write fails, or
 * coordination is refusing calls, the row keeps whatever it last held. Pull
 * request 56 was ready for review on GitHub and the dashboard kept saying
 * "Mark the pull request ready for review", in the present tense, off a row
 * that had not moved since before the change.
 *
 * So a projected blocker is dated, and past a threshold it stops being stated
 * at all. `?live=1` reads the authority and answers `source: "queue"`, which
 * needs no date because it was just read.
 *
 * The threshold is three of the five-minute reconciliation ticks. One missed
 * tick is normal; three means nothing is confirming this and the reader should
 * not be sent anywhere on it.
 */
const UNCONFIRMED_AFTER_MS = 15 * 60_000;

export interface BlockerFreshness {
  /** False once the reader should stop treating the blocker as current. */
  readonly confirmed: boolean;
  readonly text: string;
}

export function blockerFreshness(
  source: string | undefined,
  projectedAt: string | null | undefined,
  now: number = Date.now(),
): BlockerFreshness | null {
  if (source !== "projection") return null;
  if (projectedAt == null) {
    return { confirmed: false, text: "Nothing dates this, so we cannot confirm it against GitHub now." };
  }
  const at = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(projectedAt) ? projectedAt : `${projectedAt}Z`);
  if (!Number.isFinite(at)) {
    return { confirmed: false, text: "Nothing dates this, so we cannot confirm it against GitHub now." };
  }
  const age = now - at;
  if (age >= UNCONFIRMED_AFTER_MS) {
    return {
      confirmed: false,
      text: `Last projected ${whenText(projectedAt, now)}, so we cannot confirm this against GitHub now. It may already be clear.`,
    };
  }
  return { confirmed: true, text: `As of ${whenText(projectedAt, now)}.` };
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

/**
 * What a chain finding means, before any code reaches the reader.
 *
 * The verifier's detail sentence is precise and it is written for somebody who
 * already knows what a base sha is. This is the line above it, so an
 * administrator can tell at a glance whether the branch is missing a merge or
 * whether the store has a problem.
 */
export function findingTitle(code: string): string {
  switch (code) {
    case "BASE_DISCONTINUITY":
      return "A merge is missing from this branch's record";
    case "CHAIN_BEHIND_HEAD":
      return "The branch has moved past the last record";
    case "MISSING_PREFIX":
      return "The start of this chain was not served";
    case "MISSING_RECORD":
      return "A record that belongs in this chain is gone";
    case "BAD_SIGNATURE":
      return "A record's signature does not check out";
    case "DIGEST_MISMATCH":
      return "A record's digest does not name its own bytes";
    case "BROKEN_LINK":
      return "A record names the wrong record before it";
    case "SEQUENCE_GAP":
      return "A record's number is missing from this chain";
    case "FORKED_BASE":
      return "Two records claim the branch left the same commit";
    case "WRONG_SUBJECT":
      return "A record names a different repository or branch";
    case "NOTHING_CHECKED":
      return "This chain was read and no signature was verified";
    default:
      return humanise(code);
  }
}

/**
 * What the button says, or nothing where there is no button.
 *
 * A finding thwip cannot answer from evidence it holds gets no control at all.
 * Offering "Record them" beside a bad signature would offer a remedy that does
 * not exist, and a reader who pressed it and got a refusal would trust the next
 * thing this page says a little less.
 */
export function healActionLabel(plan: { healable: boolean; steps: readonly unknown[] }): string | null {
  if (!plan.healable || plan.steps.length === 0) return null;
  return plan.steps.length === 1 ? "Record it" : "Record them";
}

/**
 * What a refused read of the plans means for the panel.
 *
 * A reader who is not an administrator gets 403, and the panel is simply not
 * theirs: nothing goes on their screen. Anything else is thwip failing, and
 * hiding that shows an administrator a page identical to a clean chain at the
 * moment the check they rely on has stopped working.
 */
export function healPanelFailure(status: number | undefined): string | null {
  if (status === 403) return null;
  return "thwip could not check this branch's record. The check itself failed, so read it again before trusting the rest of this page.";
}
