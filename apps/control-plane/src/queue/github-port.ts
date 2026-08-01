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
