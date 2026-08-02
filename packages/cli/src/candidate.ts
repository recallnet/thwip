import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";

/**
 * Putting the merged candidate on disk, so the suites run against what would
 * be merged rather than against what the developer happens to have checked out.
 *
 * Under `fresh` the assignment names a `candidateSha` and a `candidateTreeOid`:
 * the developer's head integrated with the base as the queue found it. Those
 * two are usually neither the head nor anything in the developer's checkout,
 * because the base moves while a pull request waits. Running the suites on the
 * head and reporting the result would make the profile a lie, so the candidate
 * is fetched by object id, checked against the tree the assignment signed, and
 * checked out into a worktree of its own.
 *
 * A separate worktree rather than a checkout in place, for two reasons that are
 * both about the developer: their working tree is theirs, and interrupting a
 * turn must not leave them on a detached head with their branch nowhere in
 * sight. The worktree is removed when the turn ends, whatever the outcome.
 */

export interface CandidateWorkspace {
  /** Where the suites run. */
  readonly dir: string;
  readonly candidateSha: string;
  readonly treeOid: string;
  dispose(): Promise<void>;
}

export interface CandidateRefusal {
  readonly ok: false;
  readonly reasonCode: "CANDIDATE_UNAVAILABLE" | "CANDIDATE_TREE_MISMATCH";
  readonly detail: string;
}

export interface CandidateRequest {
  readonly repoDir: string;
  readonly candidateSha: string;
  readonly candidateTreeOid: string;
  /** Where the candidate is fetched from. */
  readonly remote?: string;
}

export async function materializeCandidate(
  request: CandidateRequest,
): Promise<{ ok: true; workspace: CandidateWorkspace } | CandidateRefusal> {
  const { repoDir, candidateSha, candidateTreeOid } = request;
  const remote = request.remote ?? "origin";

  if (!(await hasCommit(repoDir, candidateSha))) {
    try {
      await git(["fetch", "--no-tags", remote, candidateSha], repoDir);
    } catch (error) {
      return {
        ok: false,
        reasonCode: "CANDIDATE_UNAVAILABLE",
        detail: `${remote} does not have the candidate commit ${candidateSha}: ${message(error)}`,
      };
    }
    if (!(await hasCommit(repoDir, candidateSha))) {
      return {
        ok: false,
        reasonCode: "CANDIDATE_UNAVAILABLE",
        detail: `${remote} answered without the candidate commit ${candidateSha}`,
      };
    }
  }

  // Checked before anything is checked out. The assignment names the tree, and
  // a commit whose tree is not that tree is not the candidate whatever else it
  // is, so this refuses rather than running against it.
  const tree = await git(["rev-parse", `${candidateSha}^{tree}`], repoDir);
  if (tree !== candidateTreeOid) {
    return {
      ok: false,
      reasonCode: "CANDIDATE_TREE_MISMATCH",
      detail: `the assignment names tree ${candidateTreeOid}, and commit ${candidateSha} carries tree ${tree}`,
    };
  }

  const parent = await mkdtemp(join(tmpdir(), "thwip-candidate-"));
  const dir = join(parent, "candidate");
  const clean = async () => {
    await git(["worktree", "remove", "--force", dir], repoDir).catch(() => "");
    await rm(parent, { recursive: true, force: true });
    await git(["worktree", "prune"], repoDir).catch(() => "");
  };

  try {
    await git(["worktree", "add", "--detach", dir, candidateSha], repoDir);
  } catch (error) {
    await clean();
    return {
      ok: false,
      reasonCode: "CANDIDATE_UNAVAILABLE",
      detail: `the candidate commit ${candidateSha} could not be checked out: ${message(error)}`,
    };
  }

  // Asked of the directory the suites are about to run in, not of the
  // repository that created it. This is the check that fails if this function
  // is ever changed to hand back somewhere else.
  const checkedOut = await git(["rev-parse", "HEAD"], dir);
  const checkedOutTree = await git(["rev-parse", "HEAD^{tree}"], dir);
  if (checkedOut !== candidateSha || checkedOutTree !== candidateTreeOid) {
    await clean();
    return {
      ok: false,
      reasonCode: "CANDIDATE_TREE_MISMATCH",
      detail: `the checkout stands at ${checkedOut} on tree ${checkedOutTree}, and the assignment names ${candidateSha} on tree ${candidateTreeOid}`,
    };
  }

  return {
    ok: true,
    workspace: { dir, candidateSha, treeOid: candidateTreeOid, dispose: clean },
  };
}

async function hasCommit(repoDir: string, sha: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], repoDir);
    return true;
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}
