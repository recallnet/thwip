import { GithubApiError } from "../github-error.js";
import { pinCandidate, type CommitFacts, type PullRequestFacts } from "./candidate.js";
import {
  changedPathsBetweenTrees,
  type CandidatePathChanges,
  type GitTreeEntry,
} from "./exclusive-paths.js";

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

/**
 * A small isolate-local cache for immutable Git trees. Candidate verification
 * is polled, so without this one waiting entry would download both unchanged
 * trees on every poll. Failed, incomplete, or oversized reads are never
 * cached. The path budget bounds retained strings even when GitHub returns a
 * very large complete tree.
 */
export class CandidatePathCache {
  private readonly entries = new Map<
    string,
    { readonly pending: Promise<CandidatePathChanges>; weight: number }
  >();
  private totalWeight = 0;

  constructor(
    private readonly maximumEntries = 32,
    private readonly maximumPathBytes = 1_048_576,
  ) {}

  private remove(key: string): void {
    const removed = this.entries.get(key);
    if (removed === undefined) return;
    this.entries.delete(key);
    this.totalWeight -= removed.weight;
  }

  private trim(): void {
    while (this.entries.size > this.maximumEntries || this.totalWeight > this.maximumPathBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.remove(oldest);
    }
  }

  async read(key: string, load: () => Promise<CandidatePathChanges>): Promise<CandidatePathChanges> {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.pending;
    }
    const pending = load();
    const record = { pending, weight: 0 };
    this.entries.set(key, record);
    this.trim();
    try {
      const result = await pending;
      if (this.entries.get(key) !== record) return result;
      if (result.status !== "exact") {
        this.remove(key);
        return result;
      }
      // Three bytes per UTF-16 code unit is a conservative UTF-8 bound. The
      // fixed allowance covers the array slot and string/object bookkeeping.
      record.weight = result.paths.reduce((total, path) => total + path.length * 3 + 64, 64);
      this.totalWeight += record.weight;
      this.trim();
      return result;
    } catch (error) {
      if (this.entries.get(key) === record) this.remove(key);
      throw error;
    }
  }
}

/**
 * Read complete recursive trees instead of the compare endpoint's bounded file
 * list. GitHub explicitly marks an oversized recursive tree as truncated; that
 * is unknown, not a partial answer, so the policy gate fails closed.
 */
export async function changedCandidatePaths(
  http: GitHubHttp,
  repo: Pick<RepoRef, "owner" | "repo">,
  input: { readonly baseTreeOid: string; readonly candidateTreeOid: string },
  cache?: CandidatePathCache,
): Promise<CandidatePathChanges> {
  const key = `${repo.owner}/${repo.repo}:${input.baseTreeOid}:${input.candidateTreeOid}`;
  const load = async (): Promise<CandidatePathChanges> => {
    const read = (treeOid: string) =>
      http.json<unknown>(
        `/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(treeOid)}?recursive=1`,
      );
    const [base, candidate] = await Promise.all([read(input.baseTreeOid), read(input.candidateTreeOid)]);
    const completeTree = (response: unknown): readonly GitTreeEntry[] | null => {
      if (
        typeof response !== "object" ||
        response === null ||
        Array.isArray(response) ||
        !("truncated" in response) ||
        response.truncated !== false ||
        !("tree" in response) ||
        !Array.isArray(response.tree)
      ) {
        return null;
      }
      return response.tree as GitTreeEntry[];
    };
    const baseTree = completeTree(base);
    const candidateTree = completeTree(candidate);
    if (baseTree === null || candidateTree === null) {
      return {
        status: "unreadable",
        detail: "GitHub did not confirm a complete recursive repository tree",
      };
    }
    return changedPathsBetweenTrees(baseTree, candidateTree);
  };
  return cache === undefined ? load() : cache.read(key, load);
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
 * Candidate resolution. GitHub computes mergeability
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

  // Where the branch actually points, read from the ref rather than taken from
  // the pull request.
  //
  // GitHub caches `base.sha` on the pull request and updates it late, and it
  // caches the test merge alongside it. When both lag the same push they agree
  // with each other, so the parent check below passed and the queue pinned a
  // base that was already gone. It signed an intent naming that base, the merge
  // write was refused 422, the attempt resolved, the lane offered the same turn
  // again, and the same stale pair came back. Pull request 206 sat in that loop
  // until somebody force-pushed it out.
  //
  // Reading the ref costs one call and makes the disagreement visible: the
  // candidate's first parent no longer matches, so the turn is refused as stale
  // and retried once GitHub has recomputed the merge.
  const baseSha = (
    await http.json<{ object: { sha: string } }>(
      `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${pull.base.ref}`,
    )
  ).object.sha;

  const facts: PullRequestFacts = {
    repositoryId: String(pull.base.repo.id),
    baseRef: `refs/heads/${pull.base.ref}`,
    baseSha,
    pullRequestNumber: pull.number,
    headRepositoryId: String(pull.head.repo?.id ?? pull.base.repo.id),
    headSha: pull.head.sha,
    state: pull.state === "open" ? "open" : "closed",
    draft: pull.draft === true,
    mergeable: pull.mergeable,
    mergeCommitSha: pull.merge_commit_sha,
    objectFormat: baseSha.length === 64 ? "sha256" : "sha1",
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
 * Candidate reads live here; the single merge implementation does not.
 *
 * The App-owned writer is `merge-write.ts`. It composes the verified tree on
 * the pinned base and updates the branch ref without force. Keeping that write
 * out of this general read boundary makes duplicate merge paths harder to add.
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
