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

/**
 * Which commit the run reports as the one that landed.
 *
 * A losing merge run is told 405 "Merge already in progress" and then asks
 * GitHub what became of the pull request. Git answered first: main already
 * contained the head. The run then read the sha off the pull request, which was
 * still open as far as that read was concerned, so it reported ff6ea882 — the
 * test merge GitHub computes for an open pull request, a commit on no branch —
 * and the queue signed chain record 54 saying main became it. Main became
 * 0b207610.
 *
 * So the sha comes off the branch whenever git is what settled it.
 */
describe("the commit the workflow reports as landed", () => {
  it("reads the merge off the base branch when git is what confirmed it", () => {
    // The commit on the base branch whose parents include the head, which is
    // the merge, rather than `.merge_commit_sha` from a pull request that has
    // not caught up with its own merge.
    expect(workflow).toContain("commits?sha=${BASE_REF#refs/heads/}");
    expect(workflow).toContain('select(any(.parents[]; .sha == \\"$HEAD_SHA\\"))');
  });

  it("takes the pull request's own sha only where the pull request says it merged", () => {
    // The arm git settles, from the compare read to the end of the loop. The
    // pull request's sha must not appear anywhere in it. Reading it there is the
    // whole of the bug: everything before this arm is guarded by `.merged`, and
    // the candidate pin earlier in the run wants the test merge on purpose,
    // because verifying the integration is what it is for.
    const arm = workflow.slice(
      workflow.indexOf('cmp=$(gh api "repos/$GITHUB_REPOSITORY/compare/'),
      workflow.indexOf('[ "$unreadable" = "1" ] && return 2'),
    );
    expect(arm).toContain('printf \'%s\' "$onbase"');
    expect(arm).not.toContain(".sha // empty");
  });

  it("leaves it to reconciliation when the branch cannot name the merge", () => {
    expect(workflow).toContain("could not confirm what became of");
  });
});
