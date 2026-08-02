/**
 * Entries of a merge group, with the author of each.
 *
 * A merge group head is a stack of merge commits over the group base; each
 * hop's second parent is one pull request's head. On a `pull_request` event the
 * author arrives in the payload, and on `merge_group` it does not, so it is
 * read here. A project that forbids the author from signing their own work is
 * unjudgeable without it, and the verifier refuses rather than pass when it is
 * absent, so an unresolvable author closes the gate instead of opening it.
 */

export interface MergeGroupTarget {
  prHeadSha: string;
  prAuthorId?: string;
}

export interface MergeGroupReaders {
  commit(sha: string): Promise<{ sha: string; parents: Array<{ sha: string }> }>;
  pullsForCommit(sha: string): Promise<Array<{ head: { sha: string }; user: { id: number | string } }>>;
}

/** Merge groups are bounded in practice; this stops a cycle from spinning. */
const MAX_HOPS = 50;

export async function collectMergeGroupTargets(
  group: { headSha: string; baseSha: string },
  read: MergeGroupReaders,
): Promise<MergeGroupTarget[]> {
  const heads: string[] = [];
  let cursor = group.headSha;
  let hops = 0;
  while (cursor !== group.baseSha && hops < MAX_HOPS) {
    const commit = await read.commit(cursor);
    if (commit.parents.length >= 2) heads.push(commit.parents[1]!.sha);
    if (commit.parents.length === 0) break;
    cursor = commit.parents[0]!.sha;
    hops++;
  }
  return Promise.all(
    heads.map(async (prHeadSha) => {
      const prAuthorId = await authorOf(prHeadSha, read);
      return { prHeadSha, ...(prAuthorId !== undefined ? { prAuthorId } : {}) };
    }),
  );
}

/**
 * The author of the pull request whose head is this commit. Two pull requests
 * on the same head, no pull request at all, or a read GitHub will not answer
 * each leave it unknown; guessing one of several authors would decide a
 * control on a coin toss.
 */
async function authorOf(headSha: string, read: MergeGroupReaders): Promise<string | undefined> {
  let pulls: Array<{ head: { sha: string }; user: { id: number | string } }>;
  try {
    pulls = await read.pullsForCommit(headSha);
  } catch {
    return undefined;
  }
  const authors = new Set(pulls.filter((pull) => pull.head.sha === headSha).map((pull) => String(pull.user.id)));
  if (authors.size !== 1) return undefined;
  return [...authors][0];
}
