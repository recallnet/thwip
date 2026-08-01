import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_MERGE_METHOD, mergeCommitMessage, mergeCommitTitle } from "./merge-commit.js";

/**
 * The signed intent says what commit the merge will produce. That claim is only
 * worth making if the workflow actually writes that commit, and the workflow is
 * YAML that cannot import the strings. So this reads the workflow and fails if
 * the two ever drift apart.
 *
 * A drift would not break a merge. It would leave every record binding the
 * digest of a message nobody wrote, which is the quiet kind of wrong this whole
 * change exists to remove.
 */

const workflow = readFileSync(
  fileURLToPath(new URL("../../../../.github/workflows/thwip-merge.yml", import.meta.url)),
  "utf8",
);

describe("the commit the workflow is told to write", () => {
  it("has the title the queue signs", () => {
    // The workflow builds it with the pull request number interpolated by shell.
    expect(workflow).toContain('--arg title "Merge pull request #$PR (Thwip Queue)"');
    expect(mergeCommitTitle(82)).toBe("Merge pull request #82 (Thwip Queue)");
  });

  it("has the message the queue signs", () => {
    expect(workflow).toContain(
      "printf 'Integrated by Thwip Queue.\\n\\nthwip-queue-operation: %s\\n' \"$op\"",
    );
    expect(mergeCommitMessage("merge_att_1")).toBe(
      "Integrated by Thwip Queue.\n\nthwip-queue-operation: merge_att_1\n",
    );
  });

  /** The trailer is also how an external push is told from the queue's own. */
  it("carries the operation trailer the push detector looks for", async () => {
    const { QUEUE_MERGE_TRAILER } = await import("./external-push.js");
    expect(mergeCommitMessage("merge_att_1")).toContain(`${QUEUE_MERGE_TRAILER}:`);
  });

  /**
   * The method a signed record binds and the method the workflow asks GitHub
   * for used to be two separate strings, both spelled "merge" by hand — a
   * squash-configured repository's landed commit has one parent, a "merge"
   * record demands two, signing was refused, and the merge vanished from the
   * chain with no gap and no finding.
   *
   * The workflow now reads the method from the same authorize response the
   * queue signed the intent against, so there is one string, not two that
   * happen to agree. This pins the default it falls back to when that field
   * is absent, and that the literal "merge" the fallback resolves to is never
   * typed a second time.
   */
  it("reads the merge method from the queue's own answer, not a literal", () => {
    expect(workflow).toContain("jq -r '.mergeMethod // \"merge\"'");
    expect(workflow).toContain("merge_method:$method");
    expect(workflow).not.toContain('merge_method:"merge"');
  });

  it("falls back to the same default the queue does when nothing configures one", () => {
    expect(DEFAULT_MERGE_METHOD).toBe("merge");
  });
});
