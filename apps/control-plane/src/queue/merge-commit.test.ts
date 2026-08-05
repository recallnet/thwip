import { describe, expect, it } from "vitest";
import {
  mergeCommitMessage,
  mergeCommitText,
  mergeCommitTitle,
  mergeOperationId,
  queueAttributionTrailer,
} from "./merge-commit.js";

describe("the App-owned merge commit", () => {
  it("binds the pull request in the title", () => {
    expect(mergeCommitTitle(82)).toBe("Merge pull request #82 (Thwip Queue)");
  });

  it("binds the queue operation in the message", () => {
    expect(mergeCommitMessage("merge_att_1")).toBe(
      "Integrated by Thwip Queue.\n\nthwip-queue-operation: merge_att_1\n",
    );
  });

  it("uses the same attribution trailer the push detector reads", async () => {
    const { QUEUE_MERGE_TRAILER } = await import("./external-push.js");
    expect(queueAttributionTrailer("merge_att_1")).toBe(`${QUEUE_MERGE_TRAILER}: merge_att_1`);
  });

  it("composes the exact message written through the GitHub commit API", () => {
    expect(mergeCommitText(82, "merge_att_1")).toBe(
      "Merge pull request #82 (Thwip Queue)\n\n" +
        "Integrated by Thwip Queue.\n\nthwip-queue-operation: merge_att_1\n",
    );
  });

  it("derives operation ids from attempts in one place", () => {
    expect(mergeOperationId("attempt_82")).toBe("merge_attempt_82");
  });
});
