import {
  actionForMergeStatus,
  pinCandidate,
  validateMergeResult,
  type CommitFacts,
  type PullRequestFacts,
} from "./candidate.js";
import { confirmMergeAbsence } from "./merge-absence.js";

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

/**
 * What happened to a merge request. A transport failure is a typed nonterminal
 * outcome, never an exception thrown into a retry policy (plan.md §40.1).
 *
 * This lived in `turn.ts` next to a second classifier that read the same
 * statuses and returned a different shape. Neither had a caller, and the pair
 * would have drifted the way the receipt signing bytes and the reason-code
 * sentences did. The one that classifies a response this file actually sends is
 * the one that stayed.
 */
export type MergeAttemptOutcome =
  | {
      readonly kind: "merged";
      readonly mergeSha: string;
      readonly mergeTree: string;
      readonly parentShas: readonly string[];
    }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

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
 * The merge is not here, and this is the note that says where it is.
 *
 * Two functions in this file wrote merges and nothing called either. One asked
 * GitHub's merge-pull-request API, which takes an expected head and no expected
 * base and so merges onto whatever the branch is at that instant; that is the
 * call that landed four unverified trees on this repository. The other composed
 * the merge on the pinned base and landed it with a ref update that does not
 * force, which is the fix, and it was a second unreachable spelling of a merge
 * that already existed in YAML.
 *
 * The merge runs in Actions, because the merge token lives there and the run has
 * to happen after the required check concludes. So there is one of it:
 * `bootstrap-workflows.ts` holds the shell, `.github/workflows/thwip-merge.yml`
 * is what that renders, and `scripts/workflow-lint.mjs` fails a workflow that
 * merges without binding the base. A third spelling here is how the first two
 * came to disagree about the attribution trailer.
 */

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
