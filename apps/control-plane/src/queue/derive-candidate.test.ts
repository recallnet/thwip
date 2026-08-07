import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOrDeriveCandidate } from "./derive-candidate.js";
import { githubHttp, type RepoRef } from "./github-port.js";

const REPO: RepoRef = {
  owner: "recallnet",
  repo: "thwip",
  repositoryId: "1315419165",
  baseRef: "refs/heads/main",
};

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const MERGE_BASE = "3".repeat(40);
const STALE_CANDIDATE = "4".repeat(40);
const DERIVED = "5".repeat(40);

const BASE_TREE = "a".repeat(40);
const HEAD_TREE = "b".repeat(40);
const ANCESTOR_TREE = "c".repeat(40);
const MERGED_TREE = "d".repeat(40);

const A = "0".repeat(40);
const B1 = "e".repeat(40);
const B2 = "f".repeat(40);
const B3 = "7".repeat(40);

interface Leaf {
  readonly path: string;
  readonly mode?: string;
  readonly type?: "blob" | "commit";
  readonly sha: string;
}

/** A fetch stand-in in the github-port.test.ts style: a routing table that records every call. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push({ path, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const handler = routes[path];
    if (handler === undefined) return new Response("not stubbed", { status: 404 });
    return handler(init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const PULL_PATH = "/repos/recallnet/thwip/pulls/42";
const BASE_REF_PATH = "/repos/recallnet/thwip/git/ref/heads/main";
const COMPARE_PATH = `/repos/recallnet/thwip/compare/${BASE}...${HEAD}`;
const BASE_COMPARE_PATH = `/repos/recallnet/thwip/compare/${MERGE_BASE}...${BASE}`;
const HEAD_COMPARE_PATH = `/repos/recallnet/thwip/compare/${MERGE_BASE}...${HEAD}`;
const DERIVED_COMPARE_PATH = `/repos/recallnet/thwip/compare/${BASE}...${DERIVED}`;
const TREES_PATH = "/repos/recallnet/thwip/git/trees";
const COMMITS_PATH = "/repos/recallnet/thwip/git/commits";

function commit(sha: string, tree: string, parents: string[]) {
  return { sha, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })) };
}

function treeResponse(treeSha: string, entries: readonly Leaf[], truncated = false) {
  return {
    sha: treeSha,
    truncated,
    tree: entries.map((e) => ({ path: e.path, mode: e.mode ?? "100644", type: e.type ?? "blob", sha: e.sha })),
  };
}

function filesRoute(files: Array<{ filename: string; previous_filename?: string; status?: string }>) {
  return json({ files });
}

/** The merge this code would produce, or `null` when its entry-level rule would
 * bail. Stubs (the tree readback and a touched-path default) use this; a bail
 * case never reaches those routes. */
function constituentChoices(input: { ancestor: readonly Leaf[]; base: readonly Leaf[]; head: readonly Leaf[] }): Leaf[] {
  const byPath = (xs: readonly Leaf[]) => new Map(xs.map((e) => [e.path, e]));
  const a = byPath(input.ancestor);
  const b = byPath(input.base);
  const h = byPath(input.head);
  const eq = (x?: Leaf, y?: Leaf) => x === y || (x !== undefined && y !== undefined && (x.sha === y.sha) && (x.mode ?? "100644") === (y.mode ?? "100644") && (x.type ?? "blob") === (y.type ?? "blob"));
  const result: Leaf[] = [];
  for (const path of new Set([...a.keys(), ...b.keys(), ...h.keys()])) {
    const av = a.get(path);
    const bv = b.get(path);
    const hv = h.get(path);
    if (eq(bv, hv)) { if (bv) result.push(bv); }
    else if (eq(av, bv)) { if (hv) result.push(hv); }
    else if (eq(av, hv)) { if (bv) result.push(bv); }
    else return []; // a bail; routes that need this are never read
  }
  return result.sort((x, y) => (x.path < y.path ? -1 : 1));
}

/** The touched paths a compare is expected to report for a side's changes. */
function sideChanged(ancestor: readonly Leaf[], sideLeaves: readonly Leaf[]): string[] {
  const a = new Map(ancestor.map((e) => [e.path, e]));
  return [...new Set([...sideLeaves, ...ancestor])]
    .map((e) => e.path)
    .filter((p) => {
      const av = a.get(p);
      const sv = sideLeaves.find((e) => e.path === p);
      return av === undefined || sv === undefined || av.sha !== sv.sha || (av.mode ?? "100644") !== (sv.mode ?? "100644");
    });
}

function scenario(input: {
  ancestor: readonly Leaf[];
  base: readonly Leaf[];
  head: readonly Leaf[];
  mergedTreeSha?: string;
  truncatedHeadTree?: boolean;
  pull?: Record<string, unknown>;
  /** Compare files for the head side; defaults to head-only changes with no renames. */
  headCompareFiles?: Array<{ filename: string; previous_filename?: string; status?: string }>;
  /** Compare files for the base side; defaults to base-only changes with no renames. */
  baseCompareFiles?: Array<{ filename: string; previous_filename?: string; status?: string }>;
  /** Touched paths compare(base…derived) reports; defaults to the head side's. */
  derivedCompareTouched?: string[];
  /** The written tree's leaves; defaults to the expected merge. */
  writtenTree?: readonly Leaf[];
}) {
  const mergedTreeSha = input.mergedTreeSha ?? MERGED_TREE;
  const writtenTree = input.writtenTree ?? constituentChoices(input);
  const headCompareFiles = input.headCompareFiles ?? sideChanged(input.ancestor, input.head).map((filename) => ({ filename }));
  const baseCompareFiles = input.baseCompareFiles ?? sideChanged(input.ancestor, input.base).map((filename) => ({ filename }));
  const derivedTouched = input.derivedCompareTouched ?? headCompareFiles.map((f) => f.filename);
  const routes: Record<string, (init?: RequestInit) => Response> = {
    [PULL_PATH]: () =>
      json({
        number: 42,
        state: "open",
        draft: false,
        mergeable: true,
        merge_commit_sha: STALE_CANDIDATE,
        base: { ref: "main", sha: BASE, repo: { id: 1315419165 } },
        head: { sha: HEAD, repo: { id: 1315419165 } },
        ...(input.pull ?? {}),
      }),
    [BASE_REF_PATH]: () => json({ object: { sha: BASE } }),
    [`${COMMITS_PATH}/${STALE_CANDIDATE}`]: () => json(commit(STALE_CANDIDATE, "9".repeat(40), ["0".repeat(40), HEAD])),
    [COMPARE_PATH]: () => json({ merge_base_commit: { sha: MERGE_BASE } }),
    [BASE_COMPARE_PATH]: () => filesRoute(baseCompareFiles),
    [HEAD_COMPARE_PATH]: () =>
      json({
        files: headCompareFiles,
        total_commits: 1,
        commits: [{ sha: HEAD, parents: [{ sha: MERGE_BASE }] }],
      }),
    [DERIVED_COMPARE_PATH]: () => filesRoute(derivedTouched.map((filename) => ({ filename }))),
    [`${COMMITS_PATH}/${BASE}`]: () => json(commit(BASE, BASE_TREE, [])),
    [`${COMMITS_PATH}/${HEAD}`]: () => json(commit(HEAD, HEAD_TREE, [])),
    [`${COMMITS_PATH}/${MERGE_BASE}`]: () => json(commit(MERGE_BASE, ANCESTOR_TREE, [])),
    [`${TREES_PATH}/${ANCESTOR_TREE}?recursive=1`]: () => json(treeResponse(ANCESTOR_TREE, input.ancestor)),
    [`${TREES_PATH}/${BASE_TREE}?recursive=1`]: () => json(treeResponse(BASE_TREE, input.base)),
    [`${TREES_PATH}/${HEAD_TREE}?recursive=1`]: () =>
      json(treeResponse(HEAD_TREE, input.head, input.truncatedHeadTree ?? false)),
    [TREES_PATH]: () => json({ sha: mergedTreeSha }),
    [`${TREES_PATH}/${mergedTreeSha}?recursive=1`]: () => json(treeResponse(mergedTreeSha, writtenTree)),
    [COMMITS_PATH]: () => json(commit(DERIVED, mergedTreeSha, [BASE, HEAD])),
  };
  return routes;
}

function derive(routes: Record<string, (init?: RequestInit) => Response>) {
  const { impl, calls } = fakeFetch(routes);
  return resolveOrDeriveCandidate(githubHttp("token", impl), REPO, 42).then((r) => ({ result: r, calls }));
}

describe("deriving the candidate when the synthetic ref is stale", () => {
  it("pins the derived candidate against the base read at derivation time", async () => {
    const { result } = await derive(
      scenario({
        ancestor: [{ path: "shared.txt", sha: A }],
        base: [{ path: "shared.txt", sha: A }, { path: "base.txt", sha: B1 }],
        head: [{ path: "shared.txt", sha: B2 }, { path: "base.txt", sha: B1 }],
      }),
    );
    expect(result.status).toBe("pinned");
    if (result.status !== "pinned") return;
    expect(result.subject).toMatchObject({
      repositoryId: REPO.repositoryId,
      baseRef: "refs/heads/main",
      baseSha: BASE,
      headSha: HEAD,
      candidateSha: DERIVED,
      candidateTreeOid: MERGED_TREE,
      candidateParentOids: [BASE, HEAD],
    });
  });

  it("writes the head's change as a delta on the base tree, base parent first", async () => {
    const { calls } = await derive(
      scenario({
        ancestor: [{ path: "shared.txt", sha: A }],
        base: [{ path: "shared.txt", sha: A }, { path: "base.txt", sha: B1 }],
        head: [{ path: "shared.txt", sha: B2 }, { path: "base.txt", sha: B1 }],
      }),
    );
    expect(calls.find((c) => c.path === TREES_PATH && c.method === "POST")?.body).toEqual({
      base_tree: BASE_TREE,
      tree: [{ path: "shared.txt", mode: "100644", type: "blob", sha: B2 }],
    });
    const commitWrite = calls.find((c) => c.path === COMMITS_PATH && c.method === "POST")?.body as {
      message?: string;
      parents?: string[];
      author?: unknown;
      committer?: unknown;
    };
    expect(commitWrite.parents).toEqual([BASE, HEAD]);
    expect(commitWrite.message).not.toContain("thwip-queue-operation");
    const identity = { name: "Thwip Queue", email: "queue@thwip.ai", date: "2000-01-01T00:00:00Z" };
    expect(commitWrite.author).toEqual(identity);
    expect(commitWrite.committer).toEqual(identity);
  });

  it("encodes a deletion with its mode and type, because the endpoint refuses a bare sha null", async () => {
    const { calls } = await derive(
      scenario({
        ancestor: [{ path: "gone.txt", sha: A }],
        base: [{ path: "gone.txt", sha: A }],
        head: [],
      }),
    );
    expect(calls.find((c) => c.path === TREES_PATH && c.method === "POST")?.body).toEqual({
      base_tree: BASE_TREE,
      tree: [{ path: "gone.txt", mode: "100644", type: "blob", sha: null }],
    });
  });

  it("lands the base tree unchanged when the merge changes nothing", async () => {
    const { result, calls } = await derive(
      scenario({
        ancestor: [{ path: "shared.txt", sha: A }],
        base: [{ path: "shared.txt", sha: A }, { path: "base.txt", sha: B1 }],
        head: [{ path: "shared.txt", sha: A }, { path: "base.txt", sha: B1 }],
        mergedTreeSha: BASE_TREE,
      }),
    );
    expect(result.status).toBe("pinned");
    if (result.status !== "pinned") return;
    expect(result.subject.candidateTreeOid).toBe(BASE_TREE);
    expect(calls.some((c) => c.path === TREES_PATH && c.method === "POST")).toBe(false);
  });

  it("keeps the fork's repository id when the pull request comes from one", async () => {
    const { result } = await derive(
      scenario({
        ancestor: [{ path: "shared.txt", sha: A }],
        base: [{ path: "shared.txt", sha: A }],
        head: [{ path: "shared.txt", sha: B2 }],
        pull: { head: { sha: HEAD, repo: { id: 777 } } },
      }),
    );
    expect(result.status).toBe("pinned");
    if (result.status !== "pinned") return;
    expect(result.subject.headRepositoryId).toBe("777");
  });

  it("applies a mode change and keeps a same-sha add when base and head agree", async () => {
    const { result, calls } = await derive(
      scenario({
        ancestor: [{ path: "run.sh", sha: B3 }],
        base: [{ path: "run.sh", sha: B3 }],
        head: [{ path: "run.sh", sha: B3, mode: "100755" }],
      }),
    );
    expect(result.status).toBe("pinned");
    expect(calls.find((c) => c.path === TREES_PATH && c.method === "POST")?.body).toEqual({
      base_tree: BASE_TREE,
      tree: [{ path: "run.sh", mode: "100755", type: "blob", sha: B3 }],
    });
  });

  it("stays stale when both sides changed the same path differently", async () => {
    const { result, calls } = await derive(
      scenario({ ancestor: [{ path: "shared.txt", sha: A }], base: [{ path: "shared.txt", sha: B1 }], head: [{ path: "shared.txt", sha: B2 }] }),
    );
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stays stale when one side deleted what the other changed", async () => {
    const { result, calls } = await derive(
      scenario({ ancestor: [{ path: "shared.txt", sha: A }], base: [], head: [{ path: "shared.txt", sha: B2 }] }),
    );
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stays stale when a file would collide with a directory in the result", async () => {
    const { result, calls } = await derive(
      scenario({ ancestor: [], base: [{ path: "x/y.txt", sha: B1 }], head: [{ path: "x", sha: B2 }] }),
    );
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("declines a rename to two targets where git would conflict", async () => {
    // GitHub's compare reports a rename on each side (the data git's rename
    // detection sees). The derivation declines before the tree walks.
    const { result, calls } = await derive(
      scenario({
        ancestor: [{ path: "a.txt", sha: B1 }],
        base: [{ path: "b.txt", sha: B2 }],
        head: [{ path: "c.txt", sha: B3 }],
        baseCompareFiles: [{ filename: "b.txt", previous_filename: "a.txt", status: "renamed" }],
        headCompareFiles: [{ filename: "c.txt", previous_filename: "a.txt", status: "renamed" }],
      }),
    );
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("declines a rename against a delete where git would conflict", async () => {
    const { result, calls } = await derive(
      scenario({
        ancestor: [{ path: "a.txt", sha: B1 }],
        base: [],
        head: [{ path: "c.txt", sha: B2 }],
        baseCompareFiles: [{ filename: "a.txt", status: "removed" }],
        headCompareFiles: [{ filename: "c.txt", previous_filename: "a.txt", status: "renamed" }],
      }),
    );
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("declines a directory rename, even for the files under it git reports as renamed", async () => {
    // base renamed a directory; head added a file under the old path. GitHub
    // reports one `renamed` per file moved, so the derivation declines.
    const { result, calls } = await derive(
      scenario({
        ancestor: [{ path: "dir/x.txt", sha: B1 }, { path: "dir/y.txt", sha: B2 }],
        base: [{ path: "newdir/x.txt", sha: B1 }, { path: "newdir/y.txt", sha: B2 }],
        head: [{ path: "dir/x.txt", sha: B1 }, { path: "dir/y.txt", sha: B2 }, { path: "dir/new.txt", sha: B3 }],
        baseCompareFiles: [
          { filename: "newdir/x.txt", previous_filename: "dir/x.txt", status: "renamed" },
          { filename: "newdir/y.txt", previous_filename: "dir/y.txt", status: "renamed" },
        ],
      }),
    );
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stays stale when the head-side history contains a merge and the chosen merge base may not be unique", async () => {
    const routes = scenario({
      ancestor: [{ path: "shared.txt", sha: A }],
      base: [{ path: "shared.txt", sha: A }, { path: "base.txt", sha: B1 }],
      head: [{ path: "shared.txt", sha: B2 }, { path: "base.txt", sha: B1 }],
    });
    routes[HEAD_COMPARE_PATH] = () =>
      json({
        files: [{ filename: "shared.txt" }],
        total_commits: 1,
        commits: [{ sha: HEAD, parents: [{ sha: MERGE_BASE }, { sha: "6".repeat(40) }] }],
      });
    const { result, calls } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stays stale when GitHub does not return the complete head-side commit chain", async () => {
    const routes = scenario({
      ancestor: [{ path: "shared.txt", sha: A }],
      base: [{ path: "shared.txt", sha: A }, { path: "base.txt", sha: B1 }],
      head: [{ path: "shared.txt", sha: B2 }, { path: "base.txt", sha: B1 }],
    });
    routes[HEAD_COMPARE_PATH] = () =>
      json({
        files: [{ filename: "shared.txt" }],
        total_commits: 2,
        commits: [{ sha: HEAD, parents: [{ sha: MERGE_BASE }] }],
      });
    const { result, calls } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stays stale when a tree listing is truncated rather than merging what it has", async () => {
    const { result, calls } = await derive(
      scenario({ ancestor: [{ path: "shared.txt", sha: A }], base: [{ path: "shared.txt", sha: A }], head: [{ path: "shared.txt", sha: B2 }], truncatedHeadTree: true }),
    );
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stays stale when a complete tree listing contains a malformed or duplicate path", async () => {
    const routes = scenario({
      ancestor: [{ path: "shared.txt", sha: A }],
      base: [{ path: "shared.txt", sha: A }],
      head: [{ path: "shared.txt", sha: B2 }],
    });
    routes[`${TREES_PATH}/${HEAD_TREE}?recursive=1`] = () =>
      json({
        sha: HEAD_TREE,
        truncated: false,
        tree: [
          { path: "shared.txt", mode: "100644", type: "blob", sha: B2 },
          { path: "shared.txt", mode: "100644", type: "blob", sha: B3 },
        ],
      });
    const { result, calls } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stays stale when a tree endpoint answers with a different object id", async () => {
    const routes = scenario({
      ancestor: [{ path: "shared.txt", sha: A }],
      base: [{ path: "shared.txt", sha: A }],
      head: [{ path: "shared.txt", sha: B2 }],
    });
    routes[`${TREES_PATH}/${HEAD_TREE}?recursive=1`] = () =>
      json(treeResponse("8".repeat(40), [{ path: "shared.txt", sha: B2 }]));
    const { result, calls } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stays stale when the created commit is not what was asked for", async () => {
    const routes = scenario({ ancestor: [{ path: "shared.txt", sha: A }], base: [{ path: "shared.txt", sha: A }], head: [{ path: "shared.txt", sha: B2 }] });
    routes[COMMITS_PATH] = () => json(commit(DERIVED, MERGED_TREE, [HEAD, BASE])); // parents swapped
    const { result } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
  });

  it("stays stale when the written tree does not match the merge this code computed", async () => {
    // The second net C3 called out: the tree POST returns a sha, but the object
    // GitHub stored under it differs from the merge. The readback refuses it.
    const routes = scenario({
      ancestor: [{ path: "shared.txt", sha: A }],
      base: [{ path: "shared.txt", sha: A }, { path: "base.txt", sha: B1 }],
      head: [{ path: "shared.txt", sha: B2 }, { path: "base.txt", sha: B1 }],
      // The merge should contain {shared@B2, base@B1}; the storage got an
      // extra incorrect entry or a different sha — both refuse.
      writtenTree: [{ path: "shared.txt", sha: "z".repeat(40) }, { path: "base.txt", sha: B1 }],
    });
    const { result } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
  });

  it("stays stale when the derived tree changes a path the head never touched", async () => {
    const routes = scenario({ ancestor: [{ path: "shared.txt", sha: A }], base: [{ path: "shared.txt", sha: A }], head: [{ path: "shared.txt", sha: B2 }] });
    routes[DERIVED_COMPARE_PATH] = filesRoute([{ filename: "shared.txt" }, { filename: "base-only.txt" }]);
    const { result } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
  });

  it("stays stale when either compare listing is too long to prove the superset", async () => {
    const routes = scenario({ ancestor: [{ path: "shared.txt", sha: A }], base: [{ path: "shared.txt", sha: A }], head: [{ path: "shared.txt", sha: B2 }] });
    const capped = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.txt` }));
    routes[HEAD_COMPARE_PATH] = filesRoute(capped);
    const { result } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
  });

  it("stays stale when any read derivation needs is refused", async () => {
    // The base-ref read belongs to resolveCandidate; a refusal there propagates
    // as BASE_UNREADABLE, exactly as before derivation. Refuse something
    // derivation itself reads, after the stale verdict: the head-side compare.
    const routes = scenario({ ancestor: [{ path: "shared.txt", sha: A }], base: [{ path: "shared.txt", sha: A }], head: [{ path: "shared.txt", sha: B2 }] });
    routes[HEAD_COMPARE_PATH] = () => new Response("boom", { status: 502 });
    const { result } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
  });

  it("re-checks the pull request itself, because the first read is stale by definition here", async () => {
    // resolveCandidate also sees the close and refuses before derivation; run
    // the table through the stale path by closing only on the second read.
    const routes = scenario({ ancestor: [{ path: "shared.txt", sha: A }], base: [{ path: "shared.txt", sha: A }], head: [{ path: "shared.txt", sha: B2 }], pull: { state: "closed" } });
    let reads = 0;
    const secondRead = routes[PULL_PATH]!;
    routes[PULL_PATH] = () => {
      reads += 1;
      return reads === 1
        ? json({ number: 42, state: "open", draft: false, mergeable: true, merge_commit_sha: STALE_CANDIDATE, base: { ref: "main", sha: BASE, repo: { id: 1315419165 } }, head: { sha: HEAD, repo: { id: 1315419165 } } })
        : secondRead();
    };
    const { result, calls } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "CANDIDATE_STALE" });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("does not derive when the pin is fresh", async () => {
    const routes = scenario({ ancestor: [{ path: "shared.txt", sha: A }], base: [{ path: "shared.txt", sha: A }], head: [{ path: "shared.txt", sha: B2 }] });
    routes[`${COMMITS_PATH}/${STALE_CANDIDATE}`] = () => json(commit(STALE_CANDIDATE, "9".repeat(40), [BASE, HEAD]));
    routes[COMPARE_PATH] = () => { throw new Error("derivation must not start when the pin is fresh"); };
    const { result } = await derive(routes);
    expect(result.status).toBe("pinned");
    if (result.status !== "pinned") return;
    expect(result.subject.candidateSha).toBe(STALE_CANDIDATE);
  });

  it("does not derive for a conflicted pull request", async () => {
    const routes = scenario({ ancestor: [{ path: "shared.txt", sha: A }], base: [{ path: "shared.txt", sha: A }], head: [{ path: "shared.txt", sha: B2 }], pull: { mergeable: false } });
    const { result, calls } = await derive(routes);
    expect(result).toEqual({ status: "blocked", reason: "MERGE_CONFLICT" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

/**
 * A differential test against real `git merge-tree --write-tree`: every scenario
 * the entry-level merge accepts, git must also merge cleanly and produce the
 * identical tree. Skipped when `git` is not on PATH. This is the test the unit
 * stubs cannot be — it is what catches anything the algorithm and its tests agree
 * on but git does not.
 */
describe("against git itself (differential)", () => {
  const hasGit = (() => {
    try { execFileSync("git", ["--version"]); return true; } catch { return false; }
  })();

  it.skipIf(!hasGit)("matches git's clean merge for disjoint changes, deletions, and empty merges", () => {
    const cases: Array<{ name: string; ancestor: Record<string, string>; base: Record<string, string>; head: Record<string, string> }> = [
      { name: "head changes a file; base adds another", ancestor: { "shared.txt": "a\n" }, base: { "shared.txt": "a\n", "base.txt": "b\n" }, head: { "shared.txt": "c\n", "base.txt": "b\n" } },
      { name: "head deletes a file base keeps", ancestor: { "gone.txt": "a\n", "shared.txt": "b\n" }, base: { "gone.txt": "a\n", "shared.txt": "b\n" }, head: { "shared.txt": "b\n" } },
      { name: "both add disjoint files", ancestor: {}, base: { "base.txt": "b\n" }, head: { "head.txt": "h\n" } },
      { name: "both add the same file", ancestor: {}, base: { "same.txt": "same\n" }, head: { "same.txt": "same\n" } },
      { name: "empty merge (head == base == ancestor)", ancestor: { "x.txt": "a\n" }, base: { "x.txt": "a\n" }, head: { "x.txt": "a\n" } },
    ];
    for (const c of cases) {
      const dir = mkdtempSync(join(tmpdir(), "thwip-derive-diff-"));
      try {
        runGit(dir, "init", "-q", "-b", "ancbranch");
        runGit(dir, "config", "user.name", "t");
        runGit(dir, "config", "user.email", "t@t");
        commitSnapshot(dir, c.ancestor, "anc");
        runGit(dir, "checkout", "-q", "-b", "basebranch");
        commitSnapshot(dir, c.base, "base");
        runGit(dir, "checkout", "-q", "ancbranch");
        runGit(dir, "checkout", "-q", "-b", "headbranch");
        commitSnapshot(dir, c.head, "head");
        const gitTree = runGit(dir, "merge-tree", "--write-tree", "basebranch", "headbranch").trim().split("\n")[0];
        const codeTree = entryLevelTree(dir, c.ancestor, c.base, c.head);
        expect(codeTree, `${c.name}: entry-level merge must match git`).toBe(gitTree);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

function runGit(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** Lay a snapshot into the working tree, stage it, and commit on the current branch. */
function commitSnapshot(dir: string, files: Record<string, string>, message: string): void {
  checkoutTree(dir, files);
  runGit(dir, "add", "-A");
  runGit(dir, "commit", "-q", "-m", message, "--allow-empty");
}

/** Remove everything tracked and lay down a snapshot of files. */
function checkoutTree(dir: string, files: Record<string, string>): void {
  for (const p of runGit(dir, "ls-files", "-z").split("\0").filter(Boolean)) {
    rmSync(join(dir, p), { force: true });
  }
  // Remove now-empty directories git would not.
  for (const p of runGit(dir, "ls-files", "-z").split("\0").filter(Boolean)) {
    let cur = join(dir, dirname(p));
    while (cur !== dir) {
      try { rmdirs(cur); break; } catch { cur = dirname(cur); }
    }
  }
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    runGit(dir, "add", "--", path);
  }
}

function rmdirs(p: string): void { rmSync(p, { recursive: true }); }

/** Stage a snapshot and return the tree sha it names. */
function snapshotTree(dir: string, files: Record<string, string>): string {
  checkoutTree(dir, files);
  for (const p of runGit(dir, "ls-files", "-z").split("\0").filter(Boolean)) runGit(dir, "rm", "--cached", "-q", "--", p);
  for (const path of Object.keys(files)) runGit(dir, "add", "--", path);
  return runGit(dir, "write-tree").trim();
}

/**
 * Reproduces the entry-level merge in a real git index and answers its tree
 * sha. The content *is* the identity in the fixture, so equality on content is
 * the same equality the code uses on blob shas; when this would bail, the test
 * never reaches it.
 */
function entryLevelTree(dir: string, ancestor: Record<string, string>, base: Record<string, string>, head: Record<string, string>): string {
  const paths = new Set([...Object.keys(ancestor), ...Object.keys(base), ...Object.keys(head)]);
  const merged: Record<string, string> = {};
  for (const path of paths) {
    const a = ancestor[path];
    const b = base[path];
    const h = head[path];
    if (b === h) { if (b !== undefined) merged[path] = b; }
    else if (a === b) { if (h !== undefined) merged[path] = h; }
    else if (a === h) { if (b !== undefined) merged[path] = b; }
    else throw new Error(`${path}: entry-level merge would bail`);
  }
  return snapshotTree(dir, merged);
}
