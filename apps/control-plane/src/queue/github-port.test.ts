import { describe, expect, it } from "vitest";
import {
  classify,
  dispatchVerifier,
  githubHttp,
  landMergeOnPinnedBase,
  mergePullRequest,
  observeMergeResult,
  readFinalGuardFacts,
  resolveCandidate,
  type RepoRef,
} from "./github-port.js";
import { mergeCommitMessage, mergeCommitText, mergeCommitTitle } from "./merge-commit.js";

const REPO: RepoRef = {
  owner: "recallnet",
  repo: "thwip",
  repositoryId: "1315419165",
  baseRef: "refs/heads/main",
};

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const CANDIDATE = "3".repeat(40);
const TREE = "4".repeat(40);

/** A fetch stand-in driven by a routing table, recording every call. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response> | never>) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const handler = routes[path];
    if (handler === undefined) return new Response("not stubbed", { status: 404 });
    return handler();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function pull(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    state: "open",
    draft: false,
    mergeable: true,
    merge_commit_sha: CANDIDATE,
    base: { ref: "main", sha: BASE, repo: { id: 1315419165 } },
    head: { sha: HEAD, repo: { id: 1315419165 } },
    ...over,
  };
}

function commit(sha: string, tree: string, parents: string[]) {
  return { sha, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })) };
}

describe("githubHttp.raw", () => {
  it("never throws on an error status", async () => {
    const { impl } = fakeFetch({ "/x": () => json({ message: "nope" }, 500) });
    const result = await githubHttp("t", impl).raw("/x");
    expect(result).toMatchObject({ status: 500, body: { message: "nope" } });
  });

  it("turns a transport failure into a typed result rather than an exception", async () => {
    const impl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const result = await githubHttp("t", impl).raw("/x");
    expect(result).toEqual({ status: 0, transportError: "ECONNRESET" });
  });

  it("survives a non-JSON body", async () => {
    const { impl } = fakeFetch({ "/x": () => new Response("<html>gateway</html>", { status: 502 }) });
    const result = await githubHttp("t", impl).raw("/x");
    expect(result.status).toBe(502);
    expect(String(result.body?.["message"])).toContain("gateway");
  });

  it("handles an empty body", async () => {
    const { impl } = fakeFetch({ "/x": () => new Response(null, { status: 204 }) });
    expect(await githubHttp("t", impl).raw("/x")).toEqual({ status: 204 });
  });
});

describe("githubHttp.json", () => {
  it("throws on a non-2xx read, which is what we want for reads", async () => {
    const { impl } = fakeFetch({ "/x": () => json({ message: "gone" }, 404) });
    await expect(githubHttp("t", impl).json("/x")).rejects.toThrow(/404/);
  });
});

describe("resolveCandidate", () => {
  it("pins the candidate from the pull request and its merge commit", async () => {
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => json(pull()),
      [`/repos/recallnet/thwip/git/commits/${CANDIDATE}`]: () => json(commit(CANDIDATE, TREE, [BASE, HEAD])),
    });
    const result = await resolveCandidate(githubHttp("t", impl), REPO, 42);
    expect(result).toMatchObject({ status: "pinned" });
    if (result.status === "pinned") {
      expect(result.subject.candidateTreeOid).toBe(TREE);
      expect(result.subject.candidateParentOids).toEqual([BASE, HEAD]);
    }
  });

  it("polls while mergeability is unknown, then gives up rather than hanging", async () => {
    let calls = 0;
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => {
        calls += 1;
        return json(pull({ mergeable: null, merge_commit_sha: null }));
      },
    });
    const result = await resolveCandidate(githubHttp("t", impl), REPO, 42, {
      attempts: 3,
      sleep: async () => {},
    });
    expect(calls).toBe(3);
    expect(result).toEqual({ status: "pending", reason: "MERGEABILITY_UNKNOWN" });
  });

  it("stops polling as soon as GitHub answers", async () => {
    let calls = 0;
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => {
        calls += 1;
        return json(calls === 1 ? pull({ mergeable: null, merge_commit_sha: null }) : pull());
      },
      [`/repos/recallnet/thwip/git/commits/${CANDIDATE}`]: () => json(commit(CANDIDATE, TREE, [BASE, HEAD])),
    });
    const result = await resolveCandidate(githubHttp("t", impl), REPO, 42, {
      attempts: 5,
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: "pinned" });
  });

  it("stops polling a closed pull request immediately", async () => {
    let calls = 0;
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => {
        calls += 1;
        return json(pull({ state: "closed", mergeable: null, merge_commit_sha: null }));
      },
    });
    const result = await resolveCandidate(githubHttp("t", impl), REPO, 42, {
      attempts: 5,
      sleep: async () => {},
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ status: "blocked", reason: "PR_CLOSED" });
  });

  it("blocks a candidate whose parents do not match the live base and head", async () => {
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => json(pull()),
      [`/repos/recallnet/thwip/git/commits/${CANDIDATE}`]: () =>
        json(commit(CANDIDATE, TREE, ["9".repeat(40), HEAD])),
    });
    expect(await resolveCandidate(githubHttp("t", impl), REPO, 42)).toEqual({
      status: "blocked",
      reason: "CANDIDATE_PARENTS_UNEXPECTED",
    });
  });

  it("recognises a fork head repository", async () => {
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => json(pull({ head: { sha: HEAD, repo: { id: 999 } } })),
      [`/repos/recallnet/thwip/git/commits/${CANDIDATE}`]: () => json(commit(CANDIDATE, TREE, [BASE, HEAD])),
    });
    const result = await resolveCandidate(githubHttp("t", impl), REPO, 42);
    expect(result.status === "pinned" && result.subject.headRepositoryId).toBe("999");
  });
});

describe("mergePullRequest", () => {
  it("sends the expected head sha so GitHub itself guards against a moved branch", async () => {
    const { impl, calls } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42/merge": () => json({ merged: true, sha: "m".repeat(40) }),
    });
    await mergePullRequest(githubHttp("t", impl), REPO, {
      pullRequestNumber: 42,
      expectedHeadSha: HEAD,
      mergeMethod: "squash",
      commitTitle: mergeCommitTitle(42),
      commitMessage: mergeCommitMessage("merge_att_1"),
    });
    const call = calls.find((c) => c.path.endsWith("/merge"))!;
    expect(call.method).toBe("PUT");
    expect(call.body).toMatchObject({ sha: HEAD, merge_method: "squash" });
  });

  it("returns 409 rather than throwing when the head moved", async () => {
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42/merge": () => json({ message: "Head branch was modified" }, 409),
    });
    const result = await mergePullRequest(githubHttp("t", impl), REPO, {
      pullRequestNumber: 42,
      expectedHeadSha: HEAD,
      mergeMethod: "squash",
      commitTitle: mergeCommitTitle(42),
      commitMessage: mergeCommitMessage("merge_att_1"),
    });
    expect(result.status).toBe(409);
    expect(classify(result)).toEqual({ kind: "supersede", outcome: "HEAD_MOVED" });
  });

  it("returns a transport error rather than throwing, so no retry policy sees it", async () => {
    const impl = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const result = await mergePullRequest(githubHttp("t", impl), REPO, {
      pullRequestNumber: 42,
      expectedHeadSha: HEAD,
      mergeMethod: "squash",
      commitTitle: mergeCommitTitle(42),
      commitMessage: mergeCommitMessage("merge_att_1"),
    });
    expect(result.transportError).toBe("socket hang up");
    expect(classify(result)).toMatchObject({ kind: "reconcile" });
  });
});

/**
 * The merge that binds the base it was verified against.
 *
 * GitHub's merge-pull-request API takes an expected head and no expected base,
 * so it merges onto whatever the branch is at that instant. Pull requests 114,
 * 117 and 119 were signed against one base, merged onto another, and produced
 * trees nobody had run. The queue refused to sign records for them, which is the
 * gate working and the merge still landing.
 *
 * Writing the commit ourselves and moving the ref without `force` binds both
 * ends: the commit's first parent is the base the candidate was verified
 * against, and GitHub refuses the ref update unless the branch is still there.
 */
describe("landMergeOnPinnedBase", () => {
  const commitsPath = "/repos/recallnet/thwip/git/commits";
  const refPath = "/repos/recallnet/thwip/git/refs/heads/main";
  const MERGE = "m".repeat(40);

  const pinned = {
    pullRequestNumber: 42,
    expectedBaseSha: BASE,
    expectedHeadSha: HEAD,
    candidateTreeOid: TREE,
    mergeMethod: "merge" as const,
    commitMessage: mergeCommitText(42, "merge_att_1"),
  };

  it("writes the verified tree onto the verified base and moves the ref without force", async () => {
    const { impl, calls } = fakeFetch({
      [commitsPath]: () => json({ sha: MERGE }),
      [refPath]: () => json({ object: { sha: MERGE } }),
    });

    const result = await landMergeOnPinnedBase(githubHttp("t", impl), REPO, pinned);

    expect(calls.find((c) => c.path === commitsPath)?.body).toEqual({
      message: mergeCommitText(42, "merge_att_1"),
      tree: TREE,
      parents: [BASE, HEAD],
    });
    const update = calls.find((c) => c.path === refPath)!;
    expect(update.method).toBe("PATCH");
    // Without force, GitHub accepts the update only where the branch is an
    // ancestor of the new commit, which for this commit means the branch is
    // still the pinned base.
    expect(update.body).toEqual({ sha: MERGE, force: false });
    expect(result).toEqual({
      kind: "landed",
      mergeSha: MERGE,
      mergeTree: TREE,
      parentShas: [BASE, HEAD],
    });
  });

  it("refuses to land when the base moved, rather than merging onto the new one", async () => {
    const { impl, calls } = fakeFetch({
      [commitsPath]: () => json({ sha: MERGE }),
      [refPath]: () => json({ message: "Update is not a fast forward" }, 422),
    });

    const result = await landMergeOnPinnedBase(githubHttp("t", impl), REPO, pinned);

    expect(result).toEqual({
      kind: "base-moved",
      reason: `the base branch is no longer ${BASE}, which is the base this candidate was verified against`,
    });
    // Nothing else was tried. A second base is not a second chance.
    expect(calls.filter((c) => c.path === refPath)).toHaveLength(1);
  });

  it("gives a squash one parent, because a squash never becomes a parent of anything", async () => {
    const { impl, calls } = fakeFetch({
      [commitsPath]: () => json({ sha: MERGE }),
      [refPath]: () => json({ object: { sha: MERGE } }),
    });
    await landMergeOnPinnedBase(githubHttp("t", impl), REPO, { ...pinned, mergeMethod: "squash" });
    expect(calls.find((c) => c.path === commitsPath)?.body).toMatchObject({ parents: [BASE] });
  });

  it("refuses before the request when the message would not name the operation", async () => {
    const { impl, calls } = fakeFetch({});
    await expect(
      landMergeOnPinnedBase(githubHttp("t", impl), REPO, { ...pinned, commitMessage: "Merge it" }),
    ).rejects.toThrow(/thwip-queue-operation/);
    expect(calls).toHaveLength(0);
  });

  it("reports a refused ruleset as refused, not as a moved base", async () => {
    const { impl } = fakeFetch({
      [commitsPath]: () => json({ sha: MERGE }),
      [refPath]: () => json({ message: 'Required status check "thwip" is expected.' }, 422),
    });
    const result = await landMergeOnPinnedBase(githubHttp("t", impl), REPO, pinned);
    expect(result).toMatchObject({ kind: "refused", status: 422 });
  });

  it("reports a transport failure as unknown, so nothing retries the write", async () => {
    const impl = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const result = await landMergeOnPinnedBase(githubHttp("t", impl), REPO, pinned);
    expect(result).toEqual({ kind: "unknown", reason: "transport: socket hang up" });
  });

  it("does not move the ref when the commit could not be written", async () => {
    const { impl, calls } = fakeFetch({
      [commitsPath]: () => json({ message: "no" }, 403),
      [refPath]: () => json({ object: { sha: MERGE } }),
    });
    const result = await landMergeOnPinnedBase(githubHttp("t", impl), REPO, pinned);
    expect(result).toMatchObject({ kind: "refused", status: 403 });
    expect(calls.filter((c) => c.path === refPath)).toHaveLength(0);
  });
});

describe("observeMergeResult", () => {
  const assigned = { baseSha: BASE, headSha: HEAD, candidateTreeOid: TREE };

  it("confirms a merge whose tree is the verified tree", async () => {
    const mergeSha = "m".repeat(40);
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => json(pull({ merged: true, merge_commit_sha: mergeSha })),
      [`/repos/recallnet/thwip/git/commits/${mergeSha}`]: () => json(commit(mergeSha, TREE, [BASE, HEAD])),
    });
    expect(
      await observeMergeResult(githubHttp("t", impl), REPO, {
        pullRequestNumber: 42,
        assigned,
        mergeMethod: "merge",
      }),
    ).toMatchObject({ kind: "merged", mergeTree: TREE });
  });

  it("reports a non-merge every read agrees on as rejected, which ends the attempt cleanly", async () => {
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => json(pull({ merged: false })),
      [`/repos/recallnet/thwip/compare/main...${HEAD}`]: () => json({ status: "ahead" }),
    });
    expect(
      await observeMergeResult(githubHttp("t", impl), REPO, {
        pullRequestNumber: 42,
        assigned,
        mergeMethod: "merge",
        sleep: async () => {},
      }),
    ).toMatchObject({ kind: "rejected" });
  });

  /**
   * The read that lost pull request 105 from the chain. GitHub answered
   * `merged: false` for a pull request it had merged a second and a half
   * earlier, and one read was enough to end the attempt as CONFIRMED_NOT_MERGED.
   */
  it("does not report a non-merge from a read that has not caught up", async () => {
    const mergeSha = "m".repeat(40);
    let reads = 0;
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => {
        reads += 1;
        return json(reads === 1 ? pull({ merged: false }) : pull({ merged: true, merge_commit_sha: mergeSha }));
      },
      [`/repos/recallnet/thwip/compare/main...${HEAD}`]: () => json({ status: "ahead" }),
      [`/repos/recallnet/thwip/git/commits/${mergeSha}`]: () => json(commit(mergeSha, TREE, [BASE, HEAD])),
    });
    expect(
      await observeMergeResult(githubHttp("t", impl), REPO, {
        pullRequestNumber: 42,
        assigned,
        mergeMethod: "merge",
        sleep: async () => {},
      }),
    ).toMatchObject({ kind: "merged", mergeSha });
  });

  it("does not report a non-merge when the base already contains the head", async () => {
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => json(pull({ merged: false })),
      [`/repos/recallnet/thwip/compare/main...${HEAD}`]: () => json({ status: "behind" }),
    });
    expect(
      await observeMergeResult(githubHttp("t", impl), REPO, {
        pullRequestNumber: 42,
        assigned,
        mergeMethod: "merge",
        sleep: async () => {},
      }),
    ).toMatchObject({ kind: "unknown" });
  });

  it("does not report a non-merge when git cannot be asked", async () => {
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => json(pull({ merged: false })),
    });
    expect(
      await observeMergeResult(githubHttp("t", impl), REPO, {
        pullRequestNumber: 42,
        assigned,
        mergeMethod: "merge",
        sleep: async () => {},
      }),
    ).toMatchObject({ kind: "unknown" });
  });

  it("refuses to call a merge successful when the landed tree differs", async () => {
    const mergeSha = "m".repeat(40);
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => json(pull({ merged: true, merge_commit_sha: mergeSha })),
      [`/repos/recallnet/thwip/git/commits/${mergeSha}`]: () =>
        json(commit(mergeSha, "9".repeat(40), [BASE, HEAD])),
    });
    const outcome = await observeMergeResult(githubHttp("t", impl), REPO, {
      pullRequestNumber: 42,
      assigned,
      mergeMethod: "merge",
    });
    expect(outcome).toMatchObject({ kind: "unknown" });
    if (outcome.kind === "unknown") expect(outcome.reason).toMatch(/not the verified tree/);
  });

  it("treats a merged pull request with no merge commit as unknown", async () => {
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => json(pull({ merged: true, merge_commit_sha: null })),
    });
    expect(
      await observeMergeResult(githubHttp("t", impl), REPO, {
        pullRequestNumber: 42,
        assigned,
        mergeMethod: "merge",
      }),
    ).toMatchObject({ kind: "unknown" });
  });

  it("validates a squash by its single parent", async () => {
    const mergeSha = "m".repeat(40);
    const { impl } = fakeFetch({
      "/repos/recallnet/thwip/pulls/42": () => json(pull({ merged: true, merge_commit_sha: mergeSha })),
      [`/repos/recallnet/thwip/git/commits/${mergeSha}`]: () => json(commit(mergeSha, TREE, [BASE])),
    });
    expect(
      await observeMergeResult(githubHttp("t", impl), REPO, {
        pullRequestNumber: 42,
        assigned,
        mergeMethod: "squash",
      }),
    ).toMatchObject({ kind: "merged" });
  });
});

describe("dispatchVerifier", () => {
  it("dispatches with the attempt and nonce, and nothing else", async () => {
    const { impl, calls } = fakeFetch({ "/repos/recallnet/thwip/dispatches": () => new Response(null, { status: 204 }) });
    await dispatchVerifier(githubHttp("t", impl), REPO, {
      attemptId: "att-1",
      nonce: "n1",
      candidateSha: CANDIDATE,
    });
    expect(calls[0]!.body).toEqual({
      event_type: "thwip-queue-verify",
      client_payload: { attemptId: "att-1", nonce: "n1", candidateSha: CANDIDATE },
    });
  });
});

describe("readFinalGuardFacts", () => {
  it("re-reads the live base and head", async () => {
    const { impl } = fakeFetch({ "/repos/recallnet/thwip/pulls/42": () => json(pull()) });
    expect(await readFinalGuardFacts(githubHttp("t", impl), REPO, 42)).toEqual({
      baseSha: BASE,
      headSha: HEAD,
      pullRequestOpen: true,
      draft: false,
      mergeableState: true,
    });
  });
});
