import { sameGitSubject, type GitSubject } from "@thwip/queue-protocol";

/**
 * Candidate preparation and result validation (plan.md §16).
 *
 * GitHub's `refs/pull/N/merge` is mutable and read-only, so the value is not the
 * ref but the objects it pointed at: the candidate commit, its parents, and its
 * tree. Everything downstream binds those, and this module is where they are
 * pinned and later re-checked.
 *
 * The provider calls live behind a port. What is here is the reasoning, so it can
 * be tested without GitHub.
 */

export interface PullRequestFacts {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly pullRequestNumber: number;
  readonly headRepositoryId: string;
  readonly headSha: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  /** Null while GitHub is still computing it (§16.1 step 2). */
  readonly mergeable: boolean | null;
  readonly mergeCommitSha: string | null;
  readonly objectFormat: "sha1" | "sha256";
}

export interface CommitFacts {
  readonly sha: string;
  readonly treeOid: string;
  readonly parentShas: readonly string[];
}

export type CandidateResult =
  | { readonly status: "pinned"; readonly subject: GitSubject }
  | { readonly status: "pending"; readonly reason: "MERGEABILITY_UNKNOWN" }
  | { readonly status: "blocked"; readonly reason: CandidateBlockReason };

export type CandidateBlockReason =
  | "PR_CLOSED"
  | "PR_DRAFT"
  | "BASE_NOT_MANAGED"
  | "MERGE_CONFLICT"
  | "CANDIDATE_MISSING"
  | "CANDIDATE_PARENTS_UNEXPECTED"
  | "CANDIDATE_STALE";

/**
 * Turn live pull request facts and the candidate commit into a pinned subject,
 * or say precisely why not.
 *
 * The parent checks are the load-bearing part: a candidate whose first parent is
 * not the current base was simulated against a different branch tip, and a
 * candidate whose second parent is not the current head tests different code.
 */
export function pinCandidate(input: {
  readonly pr: PullRequestFacts;
  readonly candidate: CommitFacts | null;
  readonly expectedBaseRef: string;
}): CandidateResult {
  const { pr } = input;
  if (pr.state !== "open") return { status: "blocked", reason: "PR_CLOSED" };
  if (pr.draft) return { status: "blocked", reason: "PR_DRAFT" };
  if (pr.baseRef !== input.expectedBaseRef) return { status: "blocked", reason: "BASE_NOT_MANAGED" };
  if (pr.mergeable === null) return { status: "pending", reason: "MERGEABILITY_UNKNOWN" };
  if (!pr.mergeable) return { status: "blocked", reason: "MERGE_CONFLICT" };
  if (pr.mergeCommitSha === null || input.candidate === null) {
    return { status: "blocked", reason: "CANDIDATE_MISSING" };
  }
  if (input.candidate.sha !== pr.mergeCommitSha) return { status: "blocked", reason: "CANDIDATE_STALE" };

  const parents = input.candidate.parentShas;
  if (parents.length !== 2) return { status: "blocked", reason: "CANDIDATE_PARENTS_UNEXPECTED" };
  if (parents[0] !== pr.baseSha || parents[1] !== pr.headSha) {
    return { status: "blocked", reason: "CANDIDATE_PARENTS_UNEXPECTED" };
  }

  return {
    status: "pinned",
    subject: {
      objectFormat: pr.objectFormat,
      repositoryId: pr.repositoryId,
      baseRef: pr.baseRef as `refs/heads/${string}`,
      baseSha: pr.baseSha,
      headRepositoryId: pr.headRepositoryId,
      headSha: pr.headSha,
      candidateSha: input.candidate.sha,
      candidateTreeOid: input.candidate.treeOid,
      candidateParentOids: [parents[0], parents[1]],
    },
  };
}

/**
 * The candidate must still describe the same integration when the attempt is
 * about to act on it (§16.1 step 6). A result produced before a relevant state
 * change is discarded rather than used.
 */
export function candidateStillCurrent(
  pinned: GitSubject,
  observed: GitSubject,
  revisions: { readonly pinnedAt: number; readonly now: number },
): { current: true } | { current: false; reason: string } {
  if (revisions.now !== revisions.pinnedAt) {
    return { current: false, reason: "attempt revision changed while the candidate was being resolved" };
  }
  if (!sameGitSubject(pinned, observed)) return { current: false, reason: "candidate no longer matches" };
  return { current: true };
}

/**
 * Result validation after the merge (§16.3). If the tree differs, the mutation
 * already happened and must not be papered over: the caller raises an integrity
 * incident and pauses the queue.
 */
export type ResultValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly integrityIncident: boolean };

export function validateMergeResult(input: {
  readonly mergeMethod: "merge" | "squash";
  readonly assigned: GitSubject;
  readonly finalCommit: CommitFacts;
  readonly pullRequestMerged: boolean;
}): ResultValidation {
  if (!input.pullRequestMerged) {
    return { ok: false, reason: "GitHub does not report the pull request as merged", integrityIncident: false };
  }

  if (input.finalCommit.treeOid !== input.assigned.candidateTreeOid) {
    // The branch moved to a tree nobody integrated. This is the one case that is
    // an incident rather than a retry.
    return {
      ok: false,
      reason: `final tree ${input.finalCommit.treeOid} is not the verified tree ${input.assigned.candidateTreeOid}`,
      integrityIncident: true,
    };
  }

  const parents = input.finalCommit.parentShas;
  if (input.mergeMethod === "merge") {
    if (parents.length !== 2) {
      return { ok: false, reason: "a merge result must have two parents", integrityIncident: true };
    }
    if (parents[0] !== input.assigned.baseSha || parents[1] !== input.assigned.headSha) {
      return {
        ok: false,
        reason: "merge parents are not the assigned base and head",
        integrityIncident: true,
      };
    }
    return { ok: true };
  }

  if (parents.length !== 1) {
    return { ok: false, reason: "a squash result must have one parent", integrityIncident: true };
  }
  if (parents[0] !== input.assigned.baseSha) {
    return { ok: false, reason: "squash parent is not the assigned base", integrityIncident: true };
  }
  return { ok: true };
}

/**
 * How to react to GitHub's merge response (§18.3). Every mapping here decides
 * one thing: whether another write may ever be sent. Only "rejected" and
 * "blocked" permit a later attempt, and neither retries this one.
 */
export type MergeResponseAction =
  | { readonly kind: "confirm" }
  | { readonly kind: "supersede"; readonly outcome: "HEAD_MOVED" }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "pause"; readonly reason: string }
  | { readonly kind: "reconcile"; readonly reason: string };

export function actionForMergeStatus(status: number, message?: string): MergeResponseAction {
  switch (status) {
    case 200:
    case 201:
      // Tentative only: the caller still confirms live state and tree.
      return { kind: "confirm" };
    case 409:
      return { kind: "supersede", outcome: "HEAD_MOVED" };
    case 405:
      return { kind: "block", reason: message ?? "not currently mergeable" };
    case 403:
      // Permission or rules failure: drift, not a transient error.
      return { kind: "pause", reason: message ?? "permission or ruleset failure" };
    case 422:
      return { kind: "reconcile", reason: message ?? "invalid or secondary-limit state" };
    default:
      if (status >= 500 || status === 408 || status === 429) {
        return { kind: "reconcile", reason: `status ${status}` };
      }
      return { kind: "reconcile", reason: `unhandled status ${status}` };
  }
}

/**
 * The independent fetch the CLI performs (§16.1). `origin` is not trusted to be
 * the base repository, because in a fork checkout it usually names the fork, so
 * the commands use a temporary remote from the server-resolved URL and verify
 * the objects rather than the ref.
 */
export function candidateFetchPlan(input: {
  readonly canonicalBaseRepositoryUrl: string;
  readonly pullRequestNumber: number;
  readonly candidateSha: string;
  readonly candidateTreeOid: string;
  readonly remoteName?: string;
}): { readonly commands: readonly string[]; readonly cleanup: readonly string[] } {
  const remote = input.remoteName ?? "thwip-base";
  return {
    commands: [
      `git remote add ${remote} ${input.canonicalBaseRepositoryUrl}`,
      `git fetch --no-tags ${remote} refs/pull/${input.pullRequestNumber}/merge`,
      `test "$(git rev-parse FETCH_HEAD)" = "${input.candidateSha}"`,
      `test "$(git show -s --format=%T FETCH_HEAD)" = "${input.candidateTreeOid}"`,
    ],
    cleanup: [`git remote remove ${remote}`],
  };
}
