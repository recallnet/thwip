import {
  actionForMergeStatus,
  pinCandidate,
  validateMergeResult,
  type CommitFacts,
  type PullRequestFacts,
} from "./candidate.js";
import { THWIP_MERGE_CONTEXT } from "./rulesets.js";
import type { MergeAttemptOutcome } from "./turn.js";
import { confirmMergeAbsence } from "./merge-absence.js";
import { carriesQueueAttribution, QUEUE_MERGE_TRAILER } from "./external-push.js";

/**
 * The real GitHub side of an integration turn.
 *
 * One rule shapes this whole file: a merge request must never raise. The rest of
 * the control plane uses a helper that throws on any non-2xx response, which is
 * right for reads and fatal for the one call that mutates a branch — an
 * exception there would be caught by a retry policy somewhere and could send a
 * second PUT (plan.md §40.1). So mutations go through `raw`, which reports a
 * status or a transport error and never throws.
 */

const API = "https://api.github.com";
const USER_AGENT = "thwip-control-plane";

export interface RawResponse {
  readonly status: number;
  readonly body?: Record<string, unknown>;
  readonly transportError?: string;
}

export interface GitHubHttp {
  /** Throws on non-2xx. For reads, where failing loudly is correct. */
  json<T>(path: string, init?: RequestInit): Promise<T>;
  /** Never throws. For mutations, where an exception could cause a second write. */
  raw(path: string, init?: RequestInit): Promise<RawResponse>;
}

export function githubHttp(token: string, fetchImpl: typeof fetch = fetch): GitHubHttp {
  const headers = (extra?: HeadersInit): HeadersInit => ({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
    ...(extra ?? {}),
  });

  return {
    async json<T>(path: string, init?: RequestInit): Promise<T> {
      const res = await fetchImpl(`${API}${path}`, { ...init, headers: headers(init?.headers) });
      if (!res.ok) throw new Error(`GitHub ${path} -> ${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    },

    async raw(path: string, init?: RequestInit): Promise<RawResponse> {
      try {
        const res = await fetchImpl(`${API}${path}`, { ...init, headers: headers(init?.headers) });
        const text = await res.text();
        let body: Record<string, unknown> | undefined;
        if (text.length > 0) {
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            body = { message: text.slice(0, 512) };
          }
        }
        return body === undefined ? { status: res.status } : { status: res.status, body };
      } catch (error) {
        // A network failure is not a failure to merge: the request may have been
        // delivered. It becomes a typed unknown outcome, never an exception.
        return { status: 0, transportError: error instanceof Error ? error.message : "unknown transport error" };
      }
    },
  };
}

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
  readonly repositoryId: string;
  readonly baseRef: string;
}

interface PullResponse {
  number: number;
  state: string;
  draft?: boolean;
  mergeable: boolean | null;
  merged?: boolean;
  merge_commit_sha: string | null;
  base: { ref: string; sha: string; repo: { id: number; node_id?: string } };
  head: { sha: string; repo: { id: number } | null };
}

interface CommitResponse {
  sha: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
}

/**
 * Candidate resolution (plan.md §16.1). GitHub computes mergeability
 * asynchronously, so a null answer is polled for a short bound and then given up
 * on rather than waited out — an entry that is not ready yet keeps its place and
 * will be offered another turn.
 */
export async function resolveCandidate(
  http: GitHubHttp,
  repo: RepoRef,
  pullRequestNumber: number,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ReturnType<typeof pinCandidate>> {
  const attempts = options.attempts ?? 4;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let pull: PullResponse | null = null;
  for (let i = 0; i < attempts; i += 1) {
    pull = await http.json<PullResponse>(`/repos/${repo.owner}/${repo.repo}/pulls/${pullRequestNumber}`);
    if (pull.mergeable !== null || pull.state !== "open") break;
    if (i < attempts - 1) await sleep(500 * (i + 1));
  }
  if (pull === null) return { status: "blocked", reason: "CANDIDATE_MISSING" };

  const facts: PullRequestFacts = {
    repositoryId: String(pull.base.repo.id),
    baseRef: `refs/heads/${pull.base.ref}`,
    baseSha: pull.base.sha,
    pullRequestNumber: pull.number,
    headRepositoryId: String(pull.head.repo?.id ?? pull.base.repo.id),
    headSha: pull.head.sha,
    state: pull.state === "open" ? "open" : "closed",
    draft: pull.draft === true,
    mergeable: pull.mergeable,
    mergeCommitSha: pull.merge_commit_sha,
    objectFormat: pull.base.sha.length === 64 ? "sha256" : "sha1",
  };

  let candidate: CommitFacts | null = null;
  if (facts.mergeCommitSha !== null) {
    const commit = await http.json<CommitResponse>(
      `/repos/${repo.owner}/${repo.repo}/git/commits/${facts.mergeCommitSha}`,
    );
    candidate = {
      sha: commit.sha,
      treeOid: commit.tree.sha,
      parentShas: commit.parents.map((p) => p.sha),
    };
  }

  return pinCandidate({ pr: facts, candidate, expectedBaseRef: repo.baseRef });
}

/**
 * The merge (plan.md §18.3). Returns the raw response so the caller can classify
 * it; this function deliberately makes no decision about retrying.
 *
 * This is the only place the control plane asks GitHub to write a merge commit,
 * so it is where the attribution is enforced. A message that does not name the
 * operation lands a merge the push webhook cannot tell from an outsider's push,
 * and the queue then appends an `external` chain link for its own work — a
 * record of something that never happened. Refusing before the request means a
 * merge path that forgets the trailer fails a test instead of forging a link.
 */
export async function mergePullRequest(
  http: GitHubHttp,
  repo: RepoRef,
  input: {
    readonly pullRequestNumber: number;
    readonly expectedHeadSha: string;
    readonly mergeMethod: "merge" | "squash";
    readonly commitTitle: string;
    readonly commitMessage: string;
  },
): Promise<RawResponse> {
  if (!carriesQueueAttribution(input.commitMessage)) {
    throw new Error(
      `refusing to merge pull request #${input.pullRequestNumber}: the commit message carries no ${QUEUE_MERGE_TRAILER} trailer, so the merge would be read back as an external push`,
    );
  }
  return http.raw(`/repos/${repo.owner}/${repo.repo}/pulls/${input.pullRequestNumber}/merge`, {
    method: "PUT",
    body: JSON.stringify({
      // The head sha is the server-side guard: GitHub answers 409 if the branch
      // moved, which is cheaper and more reliable than our own re-read.
      sha: input.expectedHeadSha,
      merge_method: input.mergeMethod,
      commit_title: input.commitTitle,
      commit_message: input.commitMessage,
    }),
    headers: { "content-type": "application/json" },
  });
}

/**
 * The result of landing a merge on the base the candidate was verified against.
 *
 * `base-moved` is its own outcome and not a rejection to be retried. A merge
 * whose base moved has nothing to try again: the candidate was verified against
 * a base that no longer exists, so the queue takes a new turn, pins a new base,
 * and runs the suites again.
 */
export type LandOutcome =
  | { readonly kind: "landed"; readonly mergeSha: string; readonly mergeTree: string; readonly parentShas: readonly string[] }
  | { readonly kind: "base-moved"; readonly reason: string }
  | { readonly kind: "refused"; readonly status: number; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/** GitHub's wording when a ref update would not fast-forward the branch. */
const NOT_FAST_FORWARD = /not a fast forward/i;

/**
 * The merge, bound to the base it was verified against.
 *
 * The merge-pull-request API takes an expected head and no expected base, so it
 * merges onto whatever the branch is at that instant. Pull requests 114, 117 and
 * 119 were each signed against one base and merged onto another; each produced a
 * tree no suite had ever run, and GitHub reported all three as successes.
 *
 * There is no expected-base parameter to reach for. There is a ref update, and a
 * ref update without `force` succeeds only where the branch is an ancestor of
 * the new commit. This writes a commit whose first parent is the pinned base and
 * whose tree is the verified tree, then moves the branch to it: if the branch is
 * still the pinned base the update is a fast-forward and lands; if the base
 * moved the branch is not an ancestor of anything with that parent, GitHub
 * answers 422 "Update is not a fast forward", and nothing lands.
 *
 * The tree comes from the candidate, never from a merge GitHub recomputes, so
 * what lands is byte for byte the tree the verifier ran.
 */
export async function landMergeOnPinnedBase(
  http: GitHubHttp,
  repo: RepoRef,
  input: {
    readonly pullRequestNumber: number;
    /** The base the intent pinned. The merge lands on this base or on none. */
    readonly expectedBaseSha: string;
    readonly expectedHeadSha: string;
    /** The tree the verifier ran, which is the tree this commit will have. */
    readonly candidateTreeOid: string;
    readonly mergeMethod: "merge" | "squash";
    readonly commitMessage: string;
  },
): Promise<LandOutcome> {
  if (!carriesQueueAttribution(input.commitMessage)) {
    throw new Error(
      `refusing to merge pull request #${input.pullRequestNumber}: the commit message carries no ${QUEUE_MERGE_TRAILER} trailer, so the merge would be read back as an external push`,
    );
  }

  // A squash has one parent, because it never becomes a parent of anything.
  const parents =
    input.mergeMethod === "squash"
      ? [input.expectedBaseSha]
      : [input.expectedBaseSha, input.expectedHeadSha];

  const written = await http.raw(`/repos/${repo.owner}/${repo.repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: input.commitMessage, tree: input.candidateTreeOid, parents }),
    headers: { "content-type": "application/json" },
  });
  if (written.transportError !== undefined) {
    // Writing a commit object changes no branch, so an ambiguous one is harmless
    // and the ref was never touched.
    return { kind: "unknown", reason: `transport: ${written.transportError}` };
  }
  const mergeSha = written.body?.["sha"];
  if (written.status !== 200 && written.status !== 201) {
    return {
      kind: "refused",
      status: written.status,
      reason: (written.body?.["message"] as string | undefined) ?? `status ${written.status}`,
    };
  }
  if (typeof mergeSha !== "string") {
    return { kind: "unknown", reason: "GitHub wrote the merge commit and named no sha" };
  }

  const branch = repo.baseRef.replace(/^refs\/heads\//, "");
  const moved = await http.raw(`/repos/${repo.owner}/${repo.repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    // force stays false. It is the whole guard: it is what makes GitHub refuse
    // a base that moved instead of merging onto it.
    body: JSON.stringify({ sha: mergeSha, force: false }),
    headers: { "content-type": "application/json" },
  });
  if (moved.transportError !== undefined) {
    return { kind: "unknown", reason: `transport: ${moved.transportError}` };
  }
  if (moved.status === 200 || moved.status === 201) {
    return { kind: "landed", mergeSha, mergeTree: input.candidateTreeOid, parentShas: parents };
  }
  const message = (moved.body?.["message"] as string | undefined) ?? `status ${moved.status}`;
  if (moved.status === 422 && NOT_FAST_FORWARD.test(message)) {
    return {
      kind: "base-moved",
      reason: `the base branch is no longer ${input.expectedBaseSha}, which is the base this candidate was verified against`,
    };
  }
  if (moved.status >= 500 || moved.status === 408 || moved.status === 429) {
    return { kind: "unknown", reason: `status ${moved.status}` };
  }
  return { kind: "refused", status: moved.status, reason: message };
}

/**
 * Whether the base branch already contains a commit.
 *
 * Git ancestry, not the pull request's own merged flag: the flag lagged its own
 * write by seconds and the ancestry did not. Null when the comparison cannot be
 * read, which is not the same as "no".
 */
export async function baseContainsCommit(
  http: GitHubHttp,
  repo: RepoRef,
  sha: string,
): Promise<boolean | null> {
  const branch = repo.baseRef.replace(/^refs\/heads\//, "");
  const compared = await http
    .json<{ status?: string }>(`/repos/${repo.owner}/${repo.repo}/compare/${branch}...${sha}`)
    .catch(() => null);
  if (compared?.status === undefined) return null;
  return compared.status === "behind" || compared.status === "identical";
}

/**
 * Read what actually happened, for reconciliation after an unknown outcome. This
 * is the only way out of an ambiguous merge: never another write, always a read
 * (plan.md §40.1 step 3).
 */
export async function observeMergeResult(
  http: GitHubHttp,
  repo: RepoRef,
  input: {
    readonly pullRequestNumber: number;
    readonly assigned: {
      readonly baseSha: string;
      readonly headSha: string;
      readonly candidateTreeOid: string;
    };
    readonly mergeMethod: "merge" | "squash";
    /** The backoff between confirmation reads. Overridden in tests. */
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<MergeAttemptOutcome> {
  const readPull = async () => {
    const pull = await http
      .json<PullResponse>(`/repos/${repo.owner}/${repo.repo}/pulls/${input.pullRequestNumber}`)
      .catch(() => null);
    return pull === null ? null : { merged: pull.merged === true, mergeCommitSha: pull.merge_commit_sha };
  };

  // A negative needs more than one read of a pull request that is eventually
  // consistent with its own merge, so this asks repeatedly and asks git too.
  const absence = await confirmMergeAbsence(
    {
      readPull,
      baseContainsHead: () => baseContainsCommit(http, repo, input.assigned.headSha),
    },
    input.sleep === undefined ? {} : { sleep: input.sleep },
  );
  if (absence.kind === "not-merged") {
    // The attempt ends; a later turn may try again with a new assignment, nonce,
    // and operation.
    return { kind: "rejected", reason: absence.reason };
  }
  if (absence.kind === "unknown") return { kind: "unknown", reason: absence.reason };

  const pull = await http.json<PullResponse>(
    `/repos/${repo.owner}/${repo.repo}/pulls/${input.pullRequestNumber}`,
  );
  if (pull.merged !== true) return { kind: "unknown", reason: absence.reason };

  const mergeSha = pull.merge_commit_sha;
  if (mergeSha === null) return { kind: "unknown", reason: "merged with no merge commit reported" };

  const commit = await http.json<CommitResponse>(`/repos/${repo.owner}/${repo.repo}/git/commits/${mergeSha}`);
  const validation = validateMergeResult({
    mergeMethod: input.mergeMethod,
    assigned: {
      objectFormat: input.assigned.baseSha.length === 64 ? "sha256" : "sha1",
      repositoryId: repo.repositoryId,
      baseRef: repo.baseRef as `refs/heads/${string}`,
      baseSha: input.assigned.baseSha,
      headRepositoryId: repo.repositoryId,
      headSha: input.assigned.headSha,
      candidateSha: mergeSha,
      candidateTreeOid: input.assigned.candidateTreeOid,
      candidateParentOids: [input.assigned.baseSha, input.assigned.headSha],
    },
    finalCommit: { sha: commit.sha, treeOid: commit.tree.sha, parentShas: commit.parents.map((p) => p.sha) },
    pullRequestMerged: true,
  });

  if (!validation.ok) {
    // A merged branch whose tree is not the verified tree is an incident, not an
    // outcome to record as success.
    return { kind: "unknown", reason: validation.reason };
  }

  return {
    kind: "merged",
    mergeSha: commit.sha,
    mergeTree: commit.tree.sha,
    parentShas: commit.parents.map((p) => p.sha),
  };
}

/**
 * The check the branch requires. Published by the App so its source can be
 * pinned, which is what stops any workflow from satisfying the gate (§17.2).
 */
export async function publishMergeCheck(
  http: GitHubHttp,
  repo: RepoRef,
  input: {
    readonly headSha: string;
    readonly conclusion: "success" | "failure" | "neutral";
    readonly title: string;
    readonly summary: string;
    readonly externalId: string;
  },
): Promise<RawResponse> {
  return http.raw(`/repos/${repo.owner}/${repo.repo}/check-runs`, {
    method: "POST",
    body: JSON.stringify({
      name: THWIP_MERGE_CONTEXT,
      head_sha: input.headSha,
      status: "completed",
      conclusion: input.conclusion,
      external_id: input.externalId,
      output: { title: input.title, summary: input.summary },
    }),
    headers: { "content-type": "application/json" },
  });
}

/** Dispatch the pinned verifier workflow (plan.md §17.1). */
export async function dispatchVerifier(
  http: GitHubHttp,
  repo: RepoRef,
  input: { readonly attemptId: string; readonly nonce: string; readonly candidateSha: string },
): Promise<RawResponse> {
  return http.raw(`/repos/${repo.owner}/${repo.repo}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      event_type: "thwip-queue-verify",
      client_payload: {
        attemptId: input.attemptId,
        nonce: input.nonce,
        candidateSha: input.candidateSha,
      },
    }),
    headers: { "content-type": "application/json" },
  });
}

/** One check run on a head, as far as a required-status-check rule cares. */
export interface CheckRunFact {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** What the branch requires and what the head says about it. */
export interface RequiredCheckState {
  /** Contexts a `required_status_checks` rule names for this branch. */
  readonly required: readonly string[];
  /** The latest run per name on the head. */
  readonly runs: readonly CheckRunFact[];
}

/** Conclusions GitHub counts as satisfying a required status check. */
const SATISFYING = new Set(["success", "neutral", "skipped"]);

/**
 * Required checks this head will certainly be refused on.
 *
 * The queue used to find this out from GitHub's rejection. It would offer a turn,
 * authorize the merge, and the PUT came back 405 because a required check was
 * missing — and the attempt then held the lane while everything behind it
 * stopped. Both facts are readable before the ask: the branch rules name the
 * contexts, and the head carries the runs.
 *
 * Only the certain cases. A context with no run at all cannot pass, and one that
 * concluded badly goes on refusing until something re-runs it. A run still in
 * progress is left alone: it may yet pass, and refusing on it would turn every
 * ordinary race into a refusal.
 */
export function unsatisfiedRequiredChecks(
  state: RequiredCheckState,
): Array<{ context: string; state: "absent" | "failed" }> {
  const unsatisfied: Array<{ context: string; state: "absent" | "failed" }> = [];
  for (const context of state.required) {
    const matching = state.runs.filter((run) => run.name === context);
    if (matching.length === 0) {
      unsatisfied.push({ context, state: "absent" });
      continue;
    }
    if (matching.some((run) => run.status === "completed" && SATISFYING.has(run.conclusion ?? ""))) continue;
    if (matching.some((run) => run.status !== "completed")) continue;
    unsatisfied.push({ context, state: "failed" });
  }
  return unsatisfied;
}

/** Facts the final guard re-reads immediately before the write (plan.md §18.3). */
export async function readFinalGuardFacts(
  http: GitHubHttp,
  repo: RepoRef,
  pullRequestNumber: number,
): Promise<{
  baseSha: string;
  headSha: string;
  pullRequestOpen: boolean;
  draft: boolean;
  mergeableState: boolean | null;
}> {
  const pull = await http.json<PullResponse>(
    `/repos/${repo.owner}/${repo.repo}/pulls/${pullRequestNumber}`,
  );
  return {
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    pullRequestOpen: pull.state === "open",
    draft: pull.draft === true,
    mergeableState: pull.mergeable,
  };
}

/** Convenience for callers that want the classified action in one step. */
export function classify(response: RawResponse) {
  if (response.transportError !== undefined) {
    return { kind: "reconcile" as const, reason: `transport: ${response.transportError}` };
  }
  return actionForMergeStatus(response.status, response.body?.["message"] as string | undefined);
}
