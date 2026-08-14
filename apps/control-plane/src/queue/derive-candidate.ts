import type { CandidateResult } from "./candidate.js";
import { resolveCandidate, type GitHubHttp, type RepoRef } from "./github-port.js";

/**
 * Deriving the integrated candidate when GitHub's synthetic merge ref is stale.
 *
 * Since 2026-02 GitHub generates a pull request's test merge commit only on a
 * head push, a merge-base change, or when the current one is twelve hours old.
 * A queue merge moves the base without changing the merge base, so the ref the
 * queue pins from sits on the old base indefinitely: `mergeable` recomputes to
 * true and `merge_commit_sha` never catches up. Pull request 256 hit it in
 * August and was freed by a no-op re-push; pull request 274 sat in the
 * `CANDIDATE_STALE` cooldown for twenty hours of continuous polling and was
 * freed the same way. Retrying the read does not rebuild the ref, so the queue
 * computes the candidate itself.
 *
 * Renames decide this. A rename with an edit, or a directory rename, changes
 * the blob identity that entry granularity would track, so git conflicts where
 * this would otherwise duplicate or resurrect a file. GitHub's compare reports
 * those as `renamed`, so this declines derivation whenever either side reports
 * one — before any write — and lets git's own rename detection be the
 * authority. What remains is an entry-level three-way merge: for each path,
 * when at most one side differs from the merge base the result is forced and
 * equals git's clean merge tree (verified live against `git merge-tree
 * --write-tree`). Both-sides-changed paths and file/directory collisions
 * decline too. In every case this either agrees with git or derives nothing,
 * and the entry keeps the bounded-stale retry it has today — derivation can
 * only unstick what it can prove, never invent a merge.
 *
 * The chosen merge base is used only when GitHub also returns the complete,
 * single-parent chain from it to the head. A head-side merge could hide a
 * second best merge base that entry-level merging cannot combine correctly,
 * so that history stays on the stale path too.
 *
 * `mergeable` is a pre-filter, not a safety net. A derived tree is trusted only
 * after the written tree is read back and compared entry-for-entry against the
 * merge this code computed, and `compare(base…derived)` confirms it changes no
 * path the head did not touch. A wrong delta, an ordering hazard, or any other
 * divergence is refused before the candidate is pinned.
 *
 * The candidate is written as an unreferenced commit object. No ref is created
 * or moved, so no `push` event fires, no workflow runs, and no ruleset is
 * consulted; GitHub serves stored objects by their full id, which is how the
 * verifier workflow and a `fresh` device fetch the candidate and check it
 * against the pinned tree. The only writes are object creates under the App's
 * existing `contents: write`, and the branch never moves.
 */

/** One leaf of a recursive tree listing: a blob or a gitlink. */
interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "commit";
  readonly sha: string;
}

function sameEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mode === b.mode && a.type === b.type && a.sha === b.sha;
}

/**
 * The three-way merge over whole entries, or null where entry granularity is
 * not enough — a path changed on both sides in different ways, or a result path
 * would be both a file and a directory. Renames are handled before this runs,
 * by declining on any rename GitHub's compare reports, so this merge never
 * meets one.
 *
 * When it answers, the answer equals git's clean merge of that range — no path
 * needed a content merge and no rename crossed — so there is one tree a clean
 * merge could produce.
 */
function mergeTreeEntries(
  ancestor: ReadonlyMap<string, TreeEntry>,
  base: ReadonlyMap<string, TreeEntry>,
  head: ReadonlyMap<string, TreeEntry>,
): Map<string, TreeEntry> | null {
  const paths = new Set<string>([...ancestor.keys(), ...base.keys(), ...head.keys()]);
  const merged = new Map<string, TreeEntry>();
  for (const path of paths) {
    const a = ancestor.get(path);
    const b = base.get(path);
    const h = head.get(path);
    if (sameEntry(b, h)) {
      if (b !== undefined) merged.set(path, b);
    } else if (sameEntry(a, b)) {
      if (h !== undefined) merged.set(path, h);
    } else if (sameEntry(a, h)) {
      if (b !== undefined) merged.set(path, b);
    } else {
      return null;
    }
  }
  // A leaf and a directory under it cannot coexist in one tree. Either input
  // alone is consistent, but one side's file can meet the other side's
  // directory in the merge.
  for (const path of merged.keys()) {
    let at = path.indexOf("/");
    while (at !== -1) {
      if (merged.has(path.slice(0, at))) return null;
      at = path.indexOf("/", at + 1);
    }
  }
  return merged;
}

interface PullResponse {
  state: string;
  draft?: boolean;
  mergeable: boolean | null;
  base: { ref: string; repo: { id: number } };
  head: { sha?: string; repo: { id: number } | null };
}

interface CommitResponse {
  sha?: string;
  tree?: { sha?: string };
  parents?: Array<{ sha?: string }>;
}

interface TreeResponse {
  sha?: string;
  truncated?: boolean;
  tree?: Array<{ path?: string; mode?: string; type?: string; sha?: string }>;
}

interface CompareCommit {
  readonly sha?: string;
  readonly parents?: Array<{ readonly sha?: string }>;
}

interface CompareFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
}

interface CompareResponse {
  files?: CompareFile[];
  total_commits?: number;
  commits?: CompareCommit[];
}

/** Compare lists at most this many files, so a listing of its length cannot
 * prove anything either way — bail rather than take a partial answer. */
const COMPARE_FILES_CAP = 300;

interface CompareDelta {
  /** Paths the comparison changed (new path for renames, both names never).
   * Null when the listing was capped and so is not safe to reason from. */
  readonly touched: string[] | null;
  /** GitHub reported a rename. */
  readonly renamed: boolean;
}

/** What a comparison changed, or null-shaped when the listing was too long. */
function compareDelta(response: CompareResponse): CompareDelta {
  if (!Array.isArray(response.files)) return { touched: null, renamed: false };
  if (response.files.length >= COMPARE_FILES_CAP) return { touched: null, renamed: false };
  const touched: string[] = [];
  let renamed = false;
  for (const file of response.files) {
    if (typeof file?.filename !== "string") return { touched: null, renamed: false };
    touched.push(file.filename);
    if (file.status === "renamed" || file.status === "copied") renamed = true;
    if (typeof file.previous_filename === "string") touched.push(file.previous_filename);
  }
  return { touched, renamed };
}

/**
 * Prove that the selected merge base reaches the head through one complete,
 * unbranched chain. A criss-cross history has more than one best merge base;
 * GitHub's compare response names only one, and using that one as if it were
 * unique can produce a different tree than git's recursive merge-base logic.
 * Any merge commit on the head side is therefore a conservative refusal.
 */
function hasCompleteLinearHeadHistory(response: CompareResponse, mergeBaseSha: string, headSha: string): boolean {
  if (!Number.isSafeInteger(response.total_commits) || response.total_commits! < 0) return false;
  if (!Array.isArray(response.commits) || response.commits.length !== response.total_commits) return false;

  const commits = new Map<string, string>();
  for (const commit of response.commits) {
    const sha = gitOid(commit.sha);
    if (sha === null || commits.has(sha) || !Array.isArray(commit.parents) || commit.parents.length !== 1) {
      return false;
    }
    const parent = gitOid(commit.parents[0]?.sha);
    if (parent === null) return false;
    commits.set(sha, parent);
  }

  let at = headSha;
  let visited = 0;
  while (at !== mergeBaseSha) {
    const parent = commits.get(at);
    if (parent === undefined || visited >= commits.size) return false;
    at = parent;
    visited += 1;
  }
  return visited === commits.size;
}

function treeOidOf(commit: CommitResponse): string | null {
  return gitOid(commit.tree?.sha);
}

function leafEntries(response: TreeResponse, expectedTreeOid: string): Map<string, TreeEntry> | null {
  if (
    gitOid(response.sha) !== expectedTreeOid ||
    response.truncated !== false ||
    !Array.isArray(response.tree) ||
    response.tree.length > 50_000
  ) {
    return null;
  }
  const entries = new Map<string, TreeEntry>();
  const seenPaths = new Set<string>();
  for (const item of response.tree) {
    const path = item.path;
    const sha = gitOid(item.sha);
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      sha === null ||
      seenPaths.has(path) ||
      (item.type === "tree" && item.mode !== "040000") ||
      (item.type === "commit" && item.mode !== "160000") ||
      (item.type === "blob" && !["100644", "100755", "120000"].includes(item.mode ?? "")) ||
      (item.type !== "tree" && item.type !== "commit" && item.type !== "blob")
    ) {
      return null;
    }
    seenPaths.add(path);
    if (item.type !== "tree") {
      entries.set(path, { path, mode: item.mode!, type: item.type, sha });
    }
  }
  return entries;
}

function gitOid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value) ? value : null;
}

const STALE: CandidateResult = { status: "blocked", reason: "CANDIDATE_STALE" };

/**
 * Candidate resolution with recovery. The synthetic ref answers first, exactly
 * as before; only its stale verdict — GitHub will not rebuild on any schedule
 * the queue controls — falls through to derivation. Every other outcome,
 * including a derivation that found nothing it could prove, is returned
 * untouched.
 */
export async function resolveOrDeriveCandidate(
  http: GitHubHttp,
  repo: RepoRef,
  pullRequestNumber: number,
): Promise<CandidateResult> {
  const resolved = await resolveCandidate(http, repo, pullRequestNumber);
  if (resolved.status === "blocked" && resolved.reason === "CANDIDATE_STALE") {
    return deriveCandidate(http, repo, pullRequestNumber);
  }
  return resolved;
}

/**
 * The candidate for a pull request whose synthetic merge ref is stale, pinned
 * against the base read at derivation time. Any surprise — an unreadable
 * object, a merge this granularity cannot perform, a creation response that is
 * not what was asked for — returns the stale verdict the caller already knows
 * how to retry, so a failed derivation is indistinguishable from never having
 * tried.
 */
async function deriveCandidate(
  http: GitHubHttp,
  repo: RepoRef,
  pullRequestNumber: number,
): Promise<CandidateResult> {
  const basePath = `/repos/${repo.owner}/${repo.repo}`;
  try {
    const pull = await http.json<PullResponse>(`${basePath}/pulls/${pullRequestNumber}`);
    const headSha = gitOid(pull.head?.sha);
    if (
      pull.state !== "open" ||
      pull.draft === true ||
      pull.mergeable !== true ||
      pull.base.ref !== repo.baseRef.replace(/^refs\/heads\//, "") ||
      String(pull.base.repo.id) !== repo.repositoryId ||
      headSha === null
    ) {
      return STALE;
    }
    const headRepositoryId = String(pull.head.repo?.id ?? pull.base.repo.id);

    // The base, read from the ref at derivation time rather than reused from
    // the read that found the stale candidate: what is pinned is what the
    // branch points at now, and the merge write's fast-forward guard owns any
    // move after that.
    const baseSha = gitOid(
      (
        await http.json<{ object?: { sha?: string } }>(
          `${basePath}/git/ref/${repo.baseRef.replace(/^refs\//, "")}`,
        )
      ).object?.sha,
    );
    if (baseSha === null) return STALE;

    const comparison = await http.json<{ merge_base_commit?: { sha?: string } }>(
      `${basePath}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
    );
    const mergeBaseSha = gitOid(comparison.merge_base_commit?.sha);
    if (mergeBaseSha === null) return STALE;

    // Git's rename detection is the only honest source for rename crossings.
    // A rename with an edit changes the blob sha, so identity-based detection
    // misses it and entry-level would duplicate or resurrect the file where git
    // conflicts. GitHub's compare reports `renamed` (and directory renames as
    // one per file moved). Decline whenever either side reports one, before
    // any write: the cases git resolves with rename detection are exactly the
    // ones this engine cannot.
    const baseDelta = compareDelta(
      await http.json<CompareResponse>(`${basePath}/compare/${encodeURIComponent(mergeBaseSha)}...${encodeURIComponent(baseSha)}`),
    );
    const headComparison = await http.json<CompareResponse>(
      `${basePath}/compare/${encodeURIComponent(mergeBaseSha)}...${encodeURIComponent(headSha)}`,
    );
    const headDelta = compareDelta(headComparison);
    if (baseDelta.touched === null || headDelta.touched === null) return STALE;
    if (baseDelta.renamed || headDelta.renamed) return STALE;
    if (!hasCompleteLinearHeadHistory(headComparison, mergeBaseSha, headSha)) return STALE;

    const commitShas = [baseSha, headSha, mergeBaseSha];
    const commits = await Promise.all(
      commitShas.map((sha) => http.json<CommitResponse>(`${basePath}/git/commits/${sha}`)),
    );
    if (commits.some((commit, index) => gitOid(commit.sha) !== commitShas[index])) return STALE;
    const trees = await Promise.all(
      commits.map((commit) => {
        const sha = treeOidOf(commit);
        if (sha === null) return Promise.resolve(null);
        return http
          .json<TreeResponse>(`${basePath}/git/trees/${encodeURIComponent(sha)}?recursive=1`)
          .then((response) => leafEntries(response, sha));
      }),
    );
    const [baseEntries, headEntries, ancestorEntries] = trees;
    const baseTreeSha = treeOidOf(commits[0]!);
    if (baseEntries == null || headEntries == null || ancestorEntries == null || baseTreeSha === null) {
      return STALE;
    }

    const merged = mergeTreeEntries(ancestorEntries, baseEntries, headEntries);
    if (merged === null) return STALE;

    // The delta against the base tree; an empty merge lands the base's tree.
    const delta: Array<Record<string, unknown>> = [];
    for (const [path, entry] of merged) {
      if (!sameEntry(entry, baseEntries.get(path))) {
        delta.push({ path, mode: entry.mode, type: entry.type, sha: entry.sha });
      }
    }
    for (const [path, entry] of baseEntries) {
      // A deletion still names its mode and type: the create-tree endpoint
      // refuses an entry without them.
      if (!merged.has(path)) delta.push({ path, mode: entry.mode, type: entry.type, sha: null });
    }
    const candidateTreeOid =
      delta.length === 0
        ? baseTreeSha
        : gitOid(
            (
              await http.json<{ sha?: string }>(`${basePath}/git/trees`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ base_tree: baseTreeSha, tree: delta }),
              })
            ).sha,
          );
    if (candidateTreeOid === null) return STALE;

    // The tree endpoint's returned sha is taken on no trust: what GitHub stored
    // for that id is read back and compared entry-for-entry against the merge
    // this code computed. A wrong delta, an ordering hazard, or any divergence
    // the entry-level merge produced silently lands here as a refusal rather
    // than a candidate.
    if (delta.length !== 0) {
      const written = leafEntries(
        await http.json<TreeResponse>(`${basePath}/git/trees/${encodeURIComponent(candidateTreeOid)}?recursive=1`),
        candidateTreeOid,
      );
      if (written === null || written.size !== merged.size) return STALE;
      for (const [path, entry] of merged) {
        const got = written.get(path);
        if (got === undefined || !sameEntry(got, entry)) return STALE;
      }
    }

    const message =
      `thwip: derived merge candidate for #${pullRequestNumber}\n\n` +
      `GitHub's test merge ref for this pull request is pinned to a base the\n` +
      `branch has moved past. This object is the entry-level merge of ${headSha}\n` +
      `onto ${baseSha}, computed by the queue. No ref points here.\n`;
    // The creation response carries the stored object: a commit's id is its
    // content hash, so a response whose tree and parents are not what was
    // asked for is a different object than the one named, and no candidate.
    const identity = { name: "Thwip Queue", email: "queue@thwip.ai", date: "2000-01-01T00:00:00Z" };
    const created = await http.json<CommitResponse>(`${basePath}/git/commits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // All object inputs, including identity and time, are fixed. Repeating a
      // derivation for the same base and head therefore asks GitHub for the
      // same content-addressed commit instead of minting one orphan per poll.
      body: JSON.stringify({
        message,
        tree: candidateTreeOid,
        parents: [baseSha, headSha],
        author: identity,
        committer: identity,
      }),
    });
    const createdParents = (created.parents ?? []).map((parent) => parent.sha);
    const candidateSha = gitOid(created.sha);
    if (
      candidateSha === null ||
      treeOidOf(created) !== candidateTreeOid ||
      createdParents.length !== 2 ||
      createdParents[0] !== baseSha ||
      createdParents[1] !== headSha
    ) {
      return STALE;
    }

    // The second net: a derived tree must differ from the base only where the
    // pull request differs from the merge base. An algorithm or API slip that
    // changes a base-only path is refused rather than pinned. The commit was
    // written to make this check possible and reaches no ref, so a refusal
    // leaves nothing referenced.
    const derivedDelta = compareDelta(
      await http.json<CompareResponse>(`${basePath}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(candidateSha)}`),
    );
    if (derivedDelta.touched === null) return STALE;
    if (derivedDelta.touched.some((path) => !headDelta.touched!.includes(path))) return STALE;

    return {
      status: "pinned",
      subject: {
        objectFormat: baseSha.length === 64 ? "sha256" : "sha1",
        repositoryId: repo.repositoryId,
        baseRef: repo.baseRef as `refs/heads/${string}`,
        baseSha,
        headRepositoryId,
        headSha,
        candidateSha,
        candidateTreeOid,
        candidateParentOids: [baseSha, headSha],
      },
    };
  } catch {
    return STALE;
  }
}
