import { describe, expect, it } from "vitest";
import { externalPushFromWebhook, pushedQueueBranch, QUEUE_MERGE_TRAILER } from "./external-push.js";

/**
 * A push to the protected branch that the queue did not cause.
 *
 * The queue's whole claim is that it knows what is on the branch it guards. If
 * somebody merges around it — an administrator, a script, a human clicking the
 * button — every turn it has offered is now against a base that no longer exists,
 * and it must stop and be rebaselined rather than carry on certifying merges onto
 * a tree it never saw.
 *
 * The reducer has said so since the beginning and nothing ever told it. The event
 * existed, the invariant existed, the command existed, and no caller did, so the
 * queue would have gone on merging onto a branch that had moved underneath it.
 *
 * Telling the queue's own merges apart from everybody else's is the whole
 * difficulty: pausing on its own merge would stop the queue every time it worked.
 * The merge commit it writes carries a trailer naming the operation, which does
 * not depend on which webhook arrives first.
 */

const REPO = { id: 1315419165, default_branch: "main" };

function push(over: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    after: "a".repeat(40),
    deleted: false,
    repository: REPO,
    head_commit: { id: "a".repeat(40), message: "somebody merged this by hand" },
    ...over,
  };
}

describe("spotting a push the queue did not make", () => {
  it("reports a hand merge onto the protected branch", () => {
    expect(externalPushFromWebhook("push", push())).toEqual({
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      observedBaseSha: "a".repeat(40),
    });
  });

  /**
   * The queue merges by pushing too. Treating that as external would pause the
   * queue every time it succeeded, which is worse than never noticing at all.
   */
  it("ignores the queue's own merge, which names the operation it performed", () => {
    const own = push({
      head_commit: {
        id: "a".repeat(40),
        message: `Merge pull request #82 (Thwip Queue)\n\nIntegrated by Thwip Queue.\n\n${QUEUE_MERGE_TRAILER}: merge_att_123\n`,
      },
    });
    expect(externalPushFromWebhook("push", own)).toBeNull();
  });

  it("ignores a push to any other branch", () => {
    expect(externalPushFromWebhook("push", push({ ref: "refs/heads/feature" }))).toBeNull();
  });

  it("ignores a tag", () => {
    expect(externalPushFromWebhook("push", push({ ref: "refs/tags/v1.2.3" }))).toBeNull();
  });

  it("ignores the branch being deleted", () => {
    expect(externalPushFromWebhook("push", push({ deleted: true }))).toBeNull();
  });

  it("ignores anything that is not a push", () => {
    for (const event of ["pull_request", "check_run", "installation", "ping"]) {
      expect(externalPushFromWebhook(event, push()), event).toBeNull();
    }
  });

  it("ignores a push it cannot place", () => {
    expect(externalPushFromWebhook("push", push({ repository: { id: 1, default_branch: "" } }))).toBeNull();
    // No sha anywhere to name what the branch now points at.
    expect(externalPushFromWebhook("push", push({ after: "", head_commit: null }))).toBeNull();
    expect(externalPushFromWebhook("push", { ref: "refs/heads/main" })).toBeNull();
  });

  /**
   * A branch whose default is not `main`. The ref has to be compared against what
   * the repository says its default branch is, not against a guess.
   */
  it("follows the repository's own default branch", () => {
    const repo = { id: 42, default_branch: "trunk" };
    expect(externalPushFromWebhook("push", push({ ref: "refs/heads/trunk", repository: repo }))).toMatchObject({
      repositoryId: "42",
      baseRef: "refs/heads/trunk",
    });
    expect(externalPushFromWebhook("push", push({ ref: "refs/heads/main", repository: repo }))).toBeNull();
  });

  it("falls back to the push's own head when there is no head commit to read", () => {
    // A push event can arrive without head_commit; the sha is still known, and a
    // push with no message to read is one we cannot attribute to the queue.
    const withoutCommit = push({ head_commit: null, after: "b".repeat(40) });
    expect(externalPushFromWebhook("push", withoutCommit)).toMatchObject({
      observedBaseSha: "b".repeat(40),
    });
  });
});

/**
 * Waking the queue asks a different question from pausing it.
 *
 * `externalPushFromWebhook` refuses the queue's own merges, because pausing on
 * one would stop the queue every time it worked. Waking on one is the point: the
 * merge that just landed is what frees the lane for whoever is next.
 */
describe("a push to the branch a queue guards", () => {
  it("names the branch whoever moved it, including the queue itself", () => {
    const ours = push({ head_commit: { id: "a".repeat(40), message: `merge\n\n${QUEUE_MERGE_TRAILER}: merge_1` } });
    expect(externalPushFromWebhook("push", ours)).toBeNull();
    expect(pushedQueueBranch("push", ours)).toEqual({
      repositoryId: String(REPO.id),
      baseRef: "refs/heads/main",
    });
  });

  it("says nothing about a push to another branch, a delete, or another event", () => {
    expect(pushedQueueBranch("push", push({ ref: "refs/heads/feature" }))).toBeNull();
    expect(pushedQueueBranch("push", push({ deleted: true }))).toBeNull();
    expect(pushedQueueBranch("pull_request", push())).toBeNull();
  });

  it("needs no sha, because the branch is the only thing it names", () => {
    expect(pushedQueueBranch("push", push({ head_commit: null, after: "" }))).toEqual({
      repositoryId: String(REPO.id),
      baseRef: "refs/heads/main",
    });
  });
});
