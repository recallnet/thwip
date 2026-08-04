import type { GitSubject } from "@thwip/queue-protocol";

/**
 * Candidate preparation (plan.md §16).
 *
 * GitHub's `refs/pull/N/merge` is mutable and read-only, so the value is not the
 * ref but the objects it pointed at: the candidate commit, its parents, and its
 * tree. Everything downstream binds those, and this module is where they are
 * pinned.
 *
 * What the landed commit is re-checked against lives in the transition record's
 * own parse (`@thwip/queue-protocol`, `checkMergeConsistency`), which runs on
 * every record the queue signs and on every record a reader verifies.
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

/** Every state candidate resolution can be in when it hands out no candidate. */
export type CandidateStateReason = CandidateBlockReason | "MERGEABILITY_UNKNOWN";

/**
 * What the control plane hands its routes: the four objects a turn binds, or
 * the state that stopped them being read.
 *
 * The reason travels because the routes act on these differently. A conflict
 * ends the turn and frees the lane; mergeability GitHub has not finished
 * computing keeps both. Collapsing them to null made every one of the eight
 * read, to the operator, as GitHub being unreachable.
 */
export type IntegratedCandidate =
  | {
      readonly status: "pinned";
      readonly baseSha: string;
      readonly headSha: string;
      readonly candidateSha: string;
      readonly candidateTreeOid: string;
    }
  | { readonly status: "pending" | "blocked"; readonly reason: CandidateStateReason };

/** The four objects a turn binds, or the state that stopped them being read. */
export function integratedCandidateFrom(result: CandidateResult): IntegratedCandidate {
  if (result.status !== "pinned") return { status: result.status, reason: result.reason };
  return {
    status: "pinned",
    baseSha: result.subject.baseSha,
    headSha: result.subject.headSha,
    candidateSha: result.subject.candidateSha,
    candidateTreeOid: result.subject.candidateTreeOid,
  };
}

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
