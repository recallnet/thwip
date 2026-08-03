import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { setupPullRequestFiles } from "./bootstrap-workflows.js";
import { carriesQueueAttribution } from "./external-push.js";
import { mergeCommitMessage } from "./merge-commit.js";
import { mergeCommitText } from "../../test/merge-commit-text.js";

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
 * A second merge path once built its message by hand and left the trailer out.
 * It never shipped, because nothing called it, and nothing in the code said the
 * two files depended on each other. Both are gone; `mergeCommitMessage` is the
 * one message, and the workflow below is the one thing that writes a merge.
 */

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
 * The message the merge actually writes.
 *
 * The guard used to sit in front of a TypeScript merge nothing called, which is
 * a guard on a path that could not forget. The merge runs in Actions and builds
 * its message with printf, so this runs that printf and reads the trailer out of
 * what it produces. A workflow that stopped writing the trailer would land
 * merges the push webhook reads as somebody pushing around the queue, and the
 * queue would append a chain link for work it did itself.
 */
describe("the message the merge workflow writes", () => {
  const merge = setupPullRequestFiles({
    endpoint: "https://thwip.example.test",
    actionRef: "recallnet/thwip@v1",
  }).find((f) => f.path === ".github/workflows/thwip-merge.yml")!.content;

  /** The workflow's own lines, run as the workflow runs them. */
  function messageForOperation(pullRequestNumber: number, operationId: string): string {
    const from = merge.indexOf('title="Merge pull request');
    const to = merge.indexOf("\n", merge.indexOf("msg=$(printf"));
    const lines = merge.slice(from, to).replace(/^ +/gm, "");
    return execFileSync(
      "bash",
      ["-c", `PR=${pullRequestNumber}\nop=${operationId}\n${lines}\nprintf '%s' "$msg"`],
      { encoding: "utf8" },
    );
  }

  it("attributes the merge to the operation the queue signed", () => {
    expect(carriesQueueAttribution(messageForOperation(42, "merge_att_1"))).toBe(true);
  });

  it("writes the text the intent bound, and no other", () => {
    // Command substitution eats the trailing newline; the commit keeps the rest.
    expect(`${messageForOperation(42, "merge_att_1")}\n`).toBe(mergeCommitText(42, "merge_att_1"));
  });
});
