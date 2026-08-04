import { GithubApiError } from "../github-error.js";
import { pinCandidate, type CommitFacts, type PullRequestFacts } from "./candidate.js";

/**
 * The shared GitHub HTTP boundary for queue reads and bootstrap writes.
 *
 * Every non-2xx response keeps its path, status, and bounded body so callers can
 * distinguish a permission refusal from an outage without parsing prose.
 */

const API = "https://api.github.com";
const USER_AGENT = "thwip-control-plane";

export interface GitHubHttp {
  /** Throws on non-2xx. For reads, where failing loudly is correct. */
  json<T>(path: string, init?: RequestInit): Promise<T>;
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
      if (!res.ok) throw new GithubApiError(path, res.status, await res.text());
      return (await res.json()) as T;
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
