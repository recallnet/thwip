import { describe, expect, it } from "vitest";
import {
  actionForMergeStatus,
  candidateFetchPlan,
  candidateStillCurrent,
  pinCandidate,
  validateMergeResult,
  type CommitFacts,
  type PullRequestFacts,
} from "./candidate.js";
import type { GitSubject } from "@thwip/queue-protocol";

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

const subject: GitSubject = {
  objectFormat: "sha1",
  repositoryId: "1315419165",
  baseRef: "refs/heads/main",
  baseSha: BASE,
  headRepositoryId: "1315419165",
  headSha: HEAD,
  candidateSha: CANDIDATE,
  candidateTreeOid: TREE,
  candidateParentOids: [BASE, HEAD],
};

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
        reason: "CANDIDATE_PARENTS_UNEXPECTED",
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
      expect(pinCandidate({ pr: pr(), candidate: swapped, expectedBaseRef: "refs/heads/main" })).toMatchObject({
        status: "blocked",
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

describe("candidateStillCurrent", () => {
  it("accepts an unchanged candidate at an unchanged revision", () => {
    expect(candidateStillCurrent(subject, subject, { pinnedAt: 4, now: 4 })).toEqual({ current: true });
  });

  it("discards a result produced across a revision change", () => {
    expect(candidateStillCurrent(subject, subject, { pinnedAt: 4, now: 5 })).toMatchObject({ current: false });
  });

  it("discards a candidate whose facts moved", () => {
    expect(
      candidateStillCurrent(subject, { ...subject, headSha: "9".repeat(40) }, { pinnedAt: 4, now: 4 }),
    ).toMatchObject({ current: false });
  });
});

describe("validateMergeResult", () => {
  it("accepts a merge whose parents and tree are exactly the assigned ones", () => {
    expect(
      validateMergeResult({
        mergeMethod: "merge",
        assigned: subject,
        finalCommit: { sha: "m".repeat(40), treeOid: TREE, parentShas: [BASE, HEAD] },
        pullRequestMerged: true,
      }),
    ).toEqual({ ok: true });
  });

  it("accepts a squash with one parent and the assigned tree", () => {
    expect(
      validateMergeResult({
        mergeMethod: "squash",
        assigned: subject,
        finalCommit: { sha: "m".repeat(40), treeOid: TREE, parentShas: [BASE] },
        pullRequestMerged: true,
      }),
    ).toEqual({ ok: true });
  });

  it("raises an integrity incident when the final tree is not the verified tree", () => {
    const result = validateMergeResult({
      mergeMethod: "merge",
      assigned: subject,
      finalCommit: { sha: "m".repeat(40), treeOid: "9".repeat(40), parentShas: [BASE, HEAD] },
      pullRequestMerged: true,
    });
    expect(result).toMatchObject({ ok: false, integrityIncident: true });
  });

  it("raises an incident when the parents are not the assigned base and head", () => {
    expect(
      validateMergeResult({
        mergeMethod: "merge",
        assigned: subject,
        finalCommit: { sha: "m".repeat(40), treeOid: TREE, parentShas: [BASE, "9".repeat(40)] },
        pullRequestMerged: true,
      }),
    ).toMatchObject({ ok: false, integrityIncident: true });
  });

  it("raises an incident for the wrong parent count per merge method", () => {
    expect(
      validateMergeResult({
        mergeMethod: "merge",
        assigned: subject,
        finalCommit: { sha: "m".repeat(40), treeOid: TREE, parentShas: [BASE] },
        pullRequestMerged: true,
      }),
    ).toMatchObject({ ok: false, integrityIncident: true });
    expect(
      validateMergeResult({
        mergeMethod: "squash",
        assigned: subject,
        finalCommit: { sha: "m".repeat(40), treeOid: TREE, parentShas: [BASE, HEAD] },
        pullRequestMerged: true,
      }),
    ).toMatchObject({ ok: false, integrityIncident: true });
  });

  it("is not an incident when GitHub simply did not merge", () => {
    expect(
      validateMergeResult({
        mergeMethod: "merge",
        assigned: subject,
        finalCommit: { sha: BASE, treeOid: TREE, parentShas: [BASE, HEAD] },
        pullRequestMerged: false,
      }),
    ).toMatchObject({ ok: false, integrityIncident: false });
  });
});

describe("actionForMergeStatus", () => {
  it("maps every documented status to the one safe action", () => {
    expect(actionForMergeStatus(200)).toEqual({ kind: "confirm" });
    expect(actionForMergeStatus(409)).toEqual({ kind: "supersede", outcome: "HEAD_MOVED" });
    expect(actionForMergeStatus(405, "not mergeable")).toEqual({ kind: "block", reason: "not mergeable" });
    expect(actionForMergeStatus(403)).toMatchObject({ kind: "pause" });
    expect(actionForMergeStatus(422)).toMatchObject({ kind: "reconcile" });
  });

  it("never returns confirm for a status that did not clearly succeed", () => {
    for (const status of [301, 400, 401, 404, 408, 429, 500, 502, 503, 504, 418]) {
      expect(actionForMergeStatus(status).kind).not.toBe("confirm");
    }
  });

  it("reconciles rather than retrying on anything transient", () => {
    for (const status of [408, 429, 500, 503]) {
      expect(actionForMergeStatus(status)).toMatchObject({ kind: "reconcile" });
    }
  });
});

describe("candidateFetchPlan", () => {
  it("uses a temporary remote rather than trusting origin", () => {
    const plan = candidateFetchPlan({
      canonicalBaseRepositoryUrl: "https://github.com/recallnet/thwip.git",
      pullRequestNumber: 42,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
    });
    expect(plan.commands[0]).toContain("git remote add thwip-base");
    expect(plan.commands.join("\n")).not.toContain("origin");
    expect(plan.commands.join("\n")).toContain("refs/pull/42/merge");
    expect(plan.cleanup).toEqual(["git remote remove thwip-base"]);
  });

  it("verifies both the commit and its tree", () => {
    const plan = candidateFetchPlan({
      canonicalBaseRepositoryUrl: "https://github.com/recallnet/thwip.git",
      pullRequestNumber: 42,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
    });
    expect(plan.commands.some((c) => c.includes("rev-parse FETCH_HEAD") && c.includes(CANDIDATE))).toBe(true);
    expect(plan.commands.some((c) => c.includes("format=%T") && c.includes(TREE))).toBe(true);
  });
});
