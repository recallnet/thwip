import { describe, expect, it } from "vitest";
import {
  performMergeWrite,
  refUpdateRequestBody,
  REF_UPDATE_ATTEMPTS,
  type MergeWriteGithub,
  type RefUpdate,
} from "./merge-write.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const LANDED = "d".repeat(40);

const intent = {
  baseRef: "refs/heads/main",
  pullRequestNumber: 7,
  baseSha: BASE,
  headSha: HEAD,
  treeOid: TREE,
  parentShas: [BASE, HEAD],
  message: "Merge pull request #7 (Thwip Queue)\n\nthwip-queue-operation: merge_att_1\n",
};

/** A GitHub that records what it was asked to do, so a test can read the request. */
class FakeGithub implements MergeWriteGithub {
  readonly commits: Array<{ message: string; tree: string; parents: readonly string[] }> = [];
  readonly refUpdates: Array<{ ref: string; update: RefUpdate }> = [];
  composed: string | null = LANDED;
  landed: { ok: true; sha: string } | { ok: false; status: number; message: string } = {
    ok: true,
    sha: LANDED,
  };
  pull: { merged: boolean; mergeCommitSha: string | null } | null = { merged: false, mergeCommitSha: null };
  contains: boolean | null = false;
  /** What the required-check read answers, one entry per call, last one repeating. */
  concluded: Array<boolean | null> = [true];
  /** Every call, in order, so a test can read what happened before the branch moved. */
  readonly calls: string[] = [];
  /** Ref-update answers, one per call, the last one repeating. */
  landings: Array<{ ok: true; sha: string } | { ok: false; status: number; message: string }> | null = null;

  async createCommit(input: { message: string; tree: string; parents: readonly string[] }) {
    this.calls.push("createCommit");
    this.commits.push(input);
    return this.composed === null
      ? { ok: false as const, status: 422, message: "no sha" }
      : { ok: true as const, sha: this.composed };
  }

  async updateRef(ref: string, update: RefUpdate) {
    this.calls.push("updateRef");
    this.refUpdates.push({ ref, update });
    if (this.landings === null) return this.landed;
    const at = Math.min(this.refUpdates.length - 1, this.landings.length - 1);
    return this.landings[at]!;
  }

  async readPull() {
    return this.pull;
  }

  async baseContainsHead() {
    return this.contains;
  }

  async requiredTurnCheckConcluded() {
    this.calls.push("requiredTurnCheckConcluded");
    const at = Math.min(this.calls.filter((c) => c === "requiredTurnCheckConcluded").length - 1, this.concluded.length - 1);
    return this.concluded[at]!;
  }
}

/** GitHub's wording when the branch requires a check that has not concluded. */
const IN_PROGRESS = { ok: false as const, status: 422, message: 'Required status check "thwip / turn" is in progress.' };

const noWait = { sleep: async () => {} };

describe("performMergeWrite", () => {
  it("composes the commit the queue pinned and nothing it computed itself", async () => {
    const github = new FakeGithub();
    await performMergeWrite(github, intent, noWait);
    expect(github.commits).toEqual([{ message: intent.message, tree: TREE, parents: [BASE, HEAD] }]);
  });

  /**
   * The whole guard. GitHub accepts a ref update without force only where the
   * branch is an ancestor of the new commit, and the only branch that is an
   * ancestor of this commit is the base it was composed on. A base that moved
   * makes GitHub answer 422 and the merge does not happen at all.
   *
   * The repository workflow test holds the workflow to this. This holds
   * the Worker to it in code.
   */
  it("moves the branch without force", async () => {
    const github = new FakeGithub();
    await performMergeWrite(github, intent, noWait);
    expect(github.refUpdates).toEqual([
      { ref: "refs/heads/main", update: { sha: LANDED, force: false } },
    ]);
  });

  it("reports the commit that landed", async () => {
    const github = new FakeGithub();
    expect(await performMergeWrite(github, intent, noWait)).toEqual({ kind: "merged", mergeSha: LANDED });
  });

  /**
   * A base that moved is not a refusal to retry. The candidate was verified
   * against a base that no longer exists, so the queue takes the turn back,
   * pins the new base and runs the suites again. What must never happen is this
   * reaching for the new base itself.
   */
  it("names a base that moved rather than merging onto the new one", async () => {
    const github = new FakeGithub();
    github.landed = { ok: false, status: 422, message: "Update is not a fast forward" };
    const outcome = await performMergeWrite(github, intent, noWait);
    expect(outcome).toMatchObject({ kind: "base-moved" });
    expect(github.refUpdates).toHaveLength(1);
  });

  /**
   * GitHub's reads lag its own writes: a pull request that merged at 16:41:38
   * answered `merged: false` at 16:41:39. A refusal from our own call says what
   * the call did, not what became of the pull request, so the outcome is
   * resolved through the same reconciliation reads.
   */
  it("asks what became of the pull request rather than believing its own refusal", async () => {
    const github = new FakeGithub();
    github.landed = { ok: false, status: 405, message: "Merge already in progress" };
    github.pull = { merged: true, mergeCommitSha: LANDED };
    expect(await performMergeWrite(github, intent, noWait)).toEqual({ kind: "merged", mergeSha: LANDED });
  });

  it("takes the merge from git ancestry when the pull request has not caught up", async () => {
    const github = new FakeGithub();
    github.landed = { ok: false, status: 405, message: "Merge already in progress" };
    github.contains = true;
    // No sha: while a pull request is open `merge_commit_sha` is the test merge
    // GitHub computes for it, which is on no branch.
    expect(await performMergeWrite(github, intent, noWait)).toEqual({ kind: "merged", mergeSha: null });
  });

  it("reports a refusal only when every read agrees the merge did not happen", async () => {
    const github = new FakeGithub();
    github.landed = { ok: false, status: 409, message: "Conflict" };
    const outcome = await performMergeWrite(github, intent, noWait);
    expect(outcome).toMatchObject({ kind: "not-merged" });
  });

  it("leaves an outcome it could not read to reconciliation", async () => {
    const github = new FakeGithub();
    github.landed = { ok: false, status: 500, message: "server error" };
    github.pull = null;
    expect(await performMergeWrite(github, intent, noWait)).toMatchObject({ kind: "unknown" });
  });

  it("writes nothing to the branch when the commit could not be composed", async () => {
    const github = new FakeGithub();
    github.composed = null;
    const outcome = await performMergeWrite(github, intent, noWait);
    expect(outcome).toMatchObject({ kind: "unknown" });
    expect(github.refUpdates).toEqual([]);
  });

  /**
   * A squash commit does not contain the pull request head, so the branch's own
   * required checks refuse the ref update and GitHub cannot tell the pull
   * request was merged. There is no primitive that binds it to a base.
   */
  it("refuses an intent whose first parent is not the base it was pinned to", async () => {
    const github = new FakeGithub();
    const outcome = await performMergeWrite(
      github,
      { ...intent, parentShas: [HEAD, BASE] },
      noWait,
    );
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(github.commits).toEqual([]);
    expect(github.refUpdates).toEqual([]);
  });

  it("refuses an intent that names no parents at all", async () => {
    const github = new FakeGithub();
    const outcome = await performMergeWrite(github, { ...intent, parentShas: [] }, noWait);
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(github.commits).toEqual([]);
  });

  /**
   * The Worker publishes `thwip / turn` green and moves the branch inside one
   * request. GitHub's rule evaluation reads its own check runs behind that
   * write, so the ref update was refused with 422 and the merge did not happen.
   * The App therefore waits for GitHub to observe the concluded check before
   * attempting the branch move.
   */
  it("waits for GitHub to read the required check as concluded before moving the branch", async () => {
    const github = new FakeGithub();
    github.concluded = [false, false, true];
    expect(await performMergeWrite(github, intent, noWait)).toEqual({ kind: "merged", mergeSha: LANDED });
    expect(github.calls).toEqual([
      "requiredTurnCheckConcluded",
      "requiredTurnCheckConcluded",
      "requiredTurnCheckConcluded",
      "createCommit",
      "updateRef",
    ]);
  });

  it("moves the branch anyway when the required check cannot be read", async () => {
    const github = new FakeGithub();
    github.concluded = [null];
    expect(await performMergeWrite(github, intent, noWait)).toEqual({ kind: "merged", mergeSha: LANDED });
    expect(github.refUpdates).toHaveLength(1);
  });

  it("retries the branch move while GitHub says the required check is still in progress", async () => {
    const github = new FakeGithub();
    github.landings = [IN_PROGRESS, IN_PROGRESS, { ok: true, sha: LANDED }];
    expect(await performMergeWrite(github, intent, noWait)).toEqual({ kind: "merged", mergeSha: LANDED });
    expect(github.refUpdates).toHaveLength(3);
    // One commit object, reused across the retries. Composing a second would
    // leave orphans on the repository for every retry.
    expect(github.commits).toHaveLength(1);
  });

  it("rechecks lifecycle cancellation immediately before the first branch move", async () => {
    const github = new FakeGithub();
    const outcome = await performMergeWrite(github, intent, {
      ...noWait,
      beforeRefUpdate: async () => false,
    });
    expect(outcome).toMatchObject({ kind: "not-merged" });
    expect(github.commits).toHaveLength(1);
    expect(github.refUpdates).toHaveLength(0);
  });

  it("checks lifecycle cancellation before creating any Git object", async () => {
    const github = new FakeGithub();
    const outcome = await performMergeWrite(github, intent, {
      ...noWait,
      beforeCreateCommit: async () => false,
    });
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(github.commits).toHaveLength(0);
    expect(github.refUpdates).toHaveLength(0);
  });

  it("rechecks lifecycle cancellation before every retrying branch move", async () => {
    const github = new FakeGithub();
    github.landings = [IN_PROGRESS, { ok: true, sha: LANDED }];
    let checks = 0;
    const outcome = await performMergeWrite(github, intent, {
      ...noWait,
      beforeRefUpdate: async () => {
        checks += 1;
        return checks === 1;
      },
    });
    expect(outcome).toMatchObject({ kind: "not-merged" });
    expect(checks).toBe(2);
    expect(github.refUpdates).toHaveLength(1);
  });

  /**
   * A required check that is genuinely unsatisfied must still refuse the merge.
   * Only the reason that says GitHub has not caught up is retried.
   */
  it("does not retry a 422 that names a different reason", async () => {
    const github = new FakeGithub();
    github.landed = { ok: false, status: 422, message: 'Required status check "build" is expected.' };
    expect(await performMergeWrite(github, intent, noWait)).toMatchObject({ kind: "not-merged" });
    expect(github.refUpdates).toHaveLength(1);
  });

  /**
   * Giving up concludes nothing. The retry ran out of patience with GitHub, and
   * what became of this attempt is a question for the sweep rather than a
   * refusal to write down.
   */
  it("leaves the operation unresolved when the in-progress refusal outlasts the retry", async () => {
    const github = new FakeGithub();
    github.landings = [IN_PROGRESS];
    // Every read agrees the merge did not happen, and it still does not conclude.
    github.pull = { merged: false, mergeCommitSha: null };
    github.contains = false;
    const outcome = await performMergeWrite(github, intent, noWait);
    expect(outcome).toMatchObject({ kind: "unknown" });
    expect(github.refUpdates).toHaveLength(REF_UPDATE_ATTEMPTS);
  });
});

/**
 * The type makes a forcing caller unwriteable. This is the same rule at the
 * boundary where the type has stopped meaning anything, because a merge whose
 * only guard is a default is a merge whose author did not decide.
 */
describe("the branch move", () => {
  it("sends force:false and says so", () => {
    expect(JSON.parse(refUpdateRequestBody({ sha: LANDED, force: false }))).toEqual({
      sha: LANDED,
      force: false,
    });
  });

  it("refuses to build a body that forces", () => {
    expect(() => refUpdateRequestBody({ sha: LANDED, force: true } as unknown as RefUpdate)).toThrow(
      /without force/,
    );
  });

  it("refuses to build a body that leaves force to a default", () => {
    expect(() => refUpdateRequestBody({ sha: LANDED } as unknown as RefUpdate)).toThrow(/without force/);
  });
});
