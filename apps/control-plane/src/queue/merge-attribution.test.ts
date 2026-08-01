import { describe, expect, it } from "vitest";
import type { GitSubject, Sha256 } from "@thwip/queue-protocol";
import { mergeCommitMessage as driverMergeCommitMessage } from "./driver.js";
import { carriesQueueAttribution, externalPushFromWebhook } from "./external-push.js";
import { mergeCommitMessage } from "./merge-commit.js";
import { githubHttp, mergePullRequest } from "./github-port.js";

/**
 * A merge the queue wrote must be readable as the queue's own work.
 *
 * The push webhook has one way to tell a queue merge from somebody pushing to
 * the protected branch: the trailer naming the operation the commit performed.
 * A merge path that omits it gets classified as an external push, and the queue
 * appends a chain link saying an outsider moved the branch when in fact the
 * queue moved it. A gap in the chain understates history. A link like that one
 * states something that never happened, which is the failure worth spending a
 * test on.
 *
 * The driver built its message by hand and left the trailer out. It never
 * shipped because `runTurn` has no production caller, and nothing in the code
 * said the two files depended on each other.
 */

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const CANDIDATE = "3".repeat(40);
const TREE = "4".repeat(40);

const git: GitSubject = {
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

const ASSIGNMENT = `sha256:${"a".repeat(64)}` as Sha256;

function pushOf(message: string) {
  return {
    ref: "refs/heads/main",
    after: "f".repeat(40),
    deleted: false,
    repository: { id: 1315419165, default_branch: "main" },
    head_commit: { id: "f".repeat(40), message },
  };
}

describe("a merge the driver writes", () => {
  it("is read back as the queue's own merge, not an external push", () => {
    const message = driverMergeCommitMessage(
      { attemptId: "att_1", transitionSequence: 9, pullRequestNumber: 42 },
      git,
      ASSIGNMENT,
    );
    expect(externalPushFromWebhook("push", pushOf(message))).toBeNull();
  });

  it("names the same operation the driver declares to the queue", () => {
    const message = driverMergeCommitMessage(
      { attemptId: "att_1", transitionSequence: 9, pullRequestNumber: 42 },
      git,
      ASSIGNMENT,
    );
    // The driver's operation id for an attempt, as `runTurn` builds it.
    expect(message).toContain("thwip-queue-operation: merge_att_1");
  });

  it("still carries the evidence trailers a reader of the branch follows", () => {
    const message = driverMergeCommitMessage(
      { attemptId: "att_1", transitionSequence: 9, pullRequestNumber: 42 },
      git,
      ASSIGNMENT,
    );
    expect(message).toContain(`thwip-queue-attempt: att_1`);
    expect(message).toContain(`thwip-queue-transition: 9`);
    expect(message).toContain(`thwip-queue-assignment: ${ASSIGNMENT}`);
    expect(message).toContain(`thwip-queue-tree: ${TREE}`);
  });
});

/**
 * One predicate, used by the side that writes the commit and the side that
 * reads it, so the two cannot drift into disagreeing about what attribution
 * looks like.
 */
describe("the attribution both sides read", () => {
  it("accepts what the merge workflow is told to write", () => {
    expect(carriesQueueAttribution(mergeCommitMessage("merge_att_1"))).toBe(true);
  });

  it("rejects a message somebody typed", () => {
    expect(carriesQueueAttribution("Merge pull request #42\n\nlooks official enough")).toBe(false);
  });
});

/**
 * The guard that makes a forgetful future path fail loudly.
 *
 * `mergePullRequest` is the only place the control plane asks GitHub to write a
 * merge commit. Refusing an unattributed message there means a new merge path
 * that forgets the trailer cannot reach GitHub at all, rather than landing a
 * merge the push webhook then misreports.
 */
describe("asking GitHub to write a merge commit", () => {
  function recordingFetch() {
    const calls: string[] = [];
    const impl = (async (input: string) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ merged: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const repo = {
    owner: "recallnet",
    repo: "thwip",
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
  };

  it("refuses a message that does not attribute the merge to the queue", async () => {
    const { impl, calls } = recordingFetch();
    await expect(
      mergePullRequest(githubHttp("t", impl), repo, {
        pullRequestNumber: 42,
        expectedHeadSha: HEAD,
        mergeMethod: "merge",
        commitTitle: "Merge pull request #42 (Thwip Queue)",
        commitMessage: "body",
      }),
    ).rejects.toThrow(/thwip-queue-operation/);
    expect(calls).toEqual([]);
  });

  it("sends an attributed message through", async () => {
    const { impl, calls } = recordingFetch();
    await mergePullRequest(githubHttp("t", impl), repo, {
      pullRequestNumber: 42,
      expectedHeadSha: HEAD,
      mergeMethod: "merge",
      commitTitle: "Merge pull request #42 (Thwip Queue)",
      commitMessage: mergeCommitMessage("merge_att_1"),
    });
    expect(calls).toHaveLength(1);
  });
});
