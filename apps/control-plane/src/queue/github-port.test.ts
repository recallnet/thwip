import { describe, expect, it } from "vitest";
import {
  classify,
  dispatchVerifier,
  githubHttp,
  mergePullRequest,
  observeMergeResult,
  publishMergeCheck,
  readFinalGuardFacts,
  resolveCandidate,
  type RepoRef,
} from "./github-port.js";
import { THWIP_MERGE_CONTEXT } from "./rulesets.js";
import { mergeCommitMessage, mergeCommitTitle } from "./merge-commit.js";

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

describe("publishMergeCheck", () => {
  it("publishes under the required context name from the App", async () => {
    const { impl, calls } = fakeFetch({ "/repos/recallnet/thwip/check-runs": () => json({ id: 1 }, 201) });
    const result = await publishMergeCheck(githubHttp("t", impl), REPO, {
      headSha: HEAD,
      conclusion: "success",
      title: "Verified",
      summary: "s",
      externalId: "attempt:att-1",
    });
    expect(result.status).toBe(201);
    expect(calls[0]!.body).toMatchObject({
      name: THWIP_MERGE_CONTEXT,
      head_sha: HEAD,
      status: "completed",
      conclusion: "success",
      external_id: "attempt:att-1",
    });
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
