import { describe, expect, it } from "vitest";
import { pinCandidate, type CommitFacts, type PullRequestFacts } from "./candidate.js";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const CANDIDATE = "3".repeat(40);
const TREE = "4".repeat(40);

function pr(over: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
    baseSha: BASE,
    pullRequestNumber: 42,
    headRepositoryId: "1315419165",
    headSha: HEAD,
    state: "open",
    draft: false,
    mergeable: true,
    mergeCommitSha: CANDIDATE,
    objectFormat: "sha1",
    ...over,
  };
}

function commit(over: Partial<CommitFacts> = {}): CommitFacts {
  return { sha: CANDIDATE, treeOid: TREE, parentShas: [BASE, HEAD], ...over };
}

describe("pinCandidate", () => {
  it("pins the objects, not the ref", () => {
    const result = pinCandidate({ pr: pr(), candidate: commit(), expectedBaseRef: "refs/heads/main" });
    expect(result).toMatchObject({ status: "pinned" });
    if (result.status === "pinned") {
      expect(result.subject.candidateSha).toBe(CANDIDATE);
      expect(result.subject.candidateTreeOid).toBe(TREE);
      expect(result.subject.candidateParentOids).toEqual([BASE, HEAD]);
    }
  });

  it("waits while GitHub is still computing mergeability", () => {
    expect(
      pinCandidate({ pr: pr({ mergeable: null }), candidate: null, expectedBaseRef: "refs/heads/main" }),
    ).toEqual({ status: "pending", reason: "MERGEABILITY_UNKNOWN" });
  });

  it("blocks a conflicted pull request", () => {
    expect(
      pinCandidate({ pr: pr({ mergeable: false }), candidate: null, expectedBaseRef: "refs/heads/main" }),
    ).toEqual({ status: "blocked", reason: "MERGE_CONFLICT" });
  });

  it("blocks a closed or draft pull request", () => {
    expect(pinCandidate({ pr: pr({ state: "closed" }), candidate: commit(), expectedBaseRef: "refs/heads/main" })).toEqual({
      status: "blocked",
      reason: "PR_CLOSED",
    });
    expect(pinCandidate({ pr: pr({ draft: true }), candidate: commit(), expectedBaseRef: "refs/heads/main" })).toEqual({
      status: "blocked",
      reason: "PR_DRAFT",
    });
  });

  it("blocks a pull request targeting another branch", () => {
    expect(
      pinCandidate({ pr: pr({ baseRef: "refs/heads/release" }), candidate: commit(), expectedBaseRef: "refs/heads/main" }),
    ).toEqual({ status: "blocked", reason: "BASE_NOT_MANAGED" });
  });

  describe("the parent checks are what make the candidate meaningful", () => {
    it("rejects a candidate simulated against a different base tip", () => {
      const stale = commit({ parentShas: ["9".repeat(40), HEAD] });
      expect(pinCandidate({ pr: pr(), candidate: stale, expectedBaseRef: "refs/heads/main" })).toEqual({
        status: "blocked",
        reason: "CANDIDATE_STALE",
      });
    });

    it("rejects a candidate that merged a different head", () => {
      const other = commit({ parentShas: [BASE, "9".repeat(40)] });
      expect(pinCandidate({ pr: pr(), candidate: other, expectedBaseRef: "refs/heads/main" })).toEqual({
        status: "blocked",
        reason: "CANDIDATE_PARENTS_UNEXPECTED",
      });
    });

    it("rejects parents in the wrong order", () => {
      const swapped = commit({ parentShas: [HEAD, BASE] });
      expect(pinCandidate({ pr: pr(), candidate: swapped, expectedBaseRef: "refs/heads/main" })).toEqual({
        status: "blocked",
        reason: "CANDIDATE_PARENTS_UNEXPECTED",
      });
    });

    it("rejects a candidate with the wrong number of parents", () => {
      expect(
        pinCandidate({ pr: pr(), candidate: commit({ parentShas: [BASE] }), expectedBaseRef: "refs/heads/main" }),
      ).toMatchObject({ status: "blocked", reason: "CANDIDATE_PARENTS_UNEXPECTED" });
    });

    it("rejects a candidate commit that is not the one GitHub named", () => {
      expect(
        pinCandidate({ pr: pr(), candidate: commit({ sha: "8".repeat(40) }), expectedBaseRef: "refs/heads/main" }),
      ).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    });

    it("blocks when GitHub names no candidate at all", () => {
      expect(
        pinCandidate({ pr: pr({ mergeCommitSha: null }), candidate: null, expectedBaseRef: "refs/heads/main" }),
      ).toEqual({ status: "blocked", reason: "CANDIDATE_MISSING" });
    });
  });
});
