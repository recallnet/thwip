import { describe, expect, it } from "vitest";
import { githubHttp, resolveCandidate, type RepoRef } from "./github-port.js";

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
