import { describe, expect, it } from "vitest";
import { carriesQueueAttribution } from "./external-push.js";
import { mergeCommitMessage, mergeCommitText } from "./merge-commit.js";

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
 * two files depended on each other. Both are gone; `mergeCommitText` is the one
 * complete message the App writer sends to GitHub.
 */

/**
 * One predicate, used by the side that writes the commit and the side that
 * reads it, so the two cannot drift into disagreeing about what attribution
 * looks like.
 */
describe("the attribution both sides read", () => {
  it("accepts what the App writer is told to write", () => {
    expect(carriesQueueAttribution(mergeCommitMessage("merge_att_1"))).toBe(true);
  });

  it("rejects a message somebody typed", () => {
    expect(carriesQueueAttribution("Merge pull request #42\n\nlooks official enough")).toBe(false);
  });

  it("attributes the merge to the operation the queue signed", () => {
    expect(carriesQueueAttribution(mergeCommitText(42, "merge_att_1"))).toBe(true);
  });

  it("writes the text the intent bound, and no other", () => {
    expect(`Merge pull request #42 (Thwip Queue)\n\n${mergeCommitMessage("merge_att_1")}`).toBe(
      mergeCommitText(42, "merge_att_1"),
    );
  });
});
