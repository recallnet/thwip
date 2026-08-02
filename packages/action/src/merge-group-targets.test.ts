import { describe, expect, it } from "vitest";
import { collectMergeGroupTargets, type MergeGroupReaders } from "./merge-group-targets.js";

const BASE = "0".repeat(40);
const sha = (n: string) => n.repeat(40);

/**
 * A merge group is a stack of merge commits: each hop's second parent is one
 * pull request's head. The author of that pull request is a fact only GitHub
 * holds, and a project that forbids the author from signing their own work
 * cannot be judged without it.
 */
function readers(overrides?: Partial<MergeGroupReaders>): MergeGroupReaders {
  const chain: Record<string, { sha: string; parents: Array<{ sha: string }> }> = {
    [sha("h")]: { sha: sha("h"), parents: [{ sha: sha("g") }, { sha: sha("2") }] },
    [sha("g")]: { sha: sha("g"), parents: [{ sha: BASE }, { sha: sha("1") }] },
  };
  return {
    commit: async (id) => {
      const found = chain[id];
      if (!found) throw new Error(`unknown commit ${id}`);
      return found;
    },
    pullsForCommit: async (id) => [{ head: { sha: id }, user: { id: id === sha("1") ? 11 : 22 } }],
    ...overrides,
  };
}

describe("merge group targets", () => {
  it("walks the group down to its base and names one entry per pull request", async () => {
    const targets = await collectMergeGroupTargets({ headSha: sha("h"), baseSha: BASE }, readers());
    expect(targets.map((t) => t.prHeadSha)).toEqual([sha("2"), sha("1")]);
  });

  it("resolves the author of every entry", async () => {
    const targets = await collectMergeGroupTargets({ headSha: sha("h"), baseSha: BASE }, readers());
    expect(targets.map((t) => t.prAuthorId)).toEqual(["22", "11"]);
  });

  it("leaves the author unset when GitHub ties the commit to no pull request", async () => {
    const targets = await collectMergeGroupTargets(
      { headSha: sha("h"), baseSha: BASE },
      readers({ pullsForCommit: async () => [] }),
    );
    expect(targets.every((t) => t.prAuthorId === undefined)).toBe(true);
  });

  it("leaves the author unset when the lookup fails, rather than guessing", async () => {
    const targets = await collectMergeGroupTargets(
      { headSha: sha("h"), baseSha: BASE },
      readers({
        pullsForCommit: async () => {
          throw new Error("GitHub API 502");
        },
      }),
    );
    expect(targets.every((t) => t.prAuthorId === undefined)).toBe(true);
  });

  it("leaves the author unset when two pull requests share the head commit", async () => {
    const targets = await collectMergeGroupTargets(
      { headSha: sha("h"), baseSha: BASE },
      readers({
        pullsForCommit: async (id) => [
          { head: { sha: id }, user: { id: 11 } },
          { head: { sha: id }, user: { id: 22 } },
        ],
      }),
    );
    expect(targets.every((t) => t.prAuthorId === undefined)).toBe(true);
  });

  it("ignores pull requests whose head is a different commit", async () => {
    const targets = await collectMergeGroupTargets(
      { headSha: sha("h"), baseSha: BASE },
      readers({ pullsForCommit: async () => [{ head: { sha: sha("z") }, user: { id: 99 } }] }),
    );
    expect(targets.every((t) => t.prAuthorId === undefined)).toBe(true);
  });
});
