import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_MERGE_METHOD, mergeCommitMessage, mergeCommitTitle } from "./merge-commit.js";
import { mergeCommitText } from "../../test/merge-commit-text.js";

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
    expect(workflow).toContain('title="Merge pull request #$PR (Thwip Queue)"');
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
    // The parent vector the method implies comes from the same answer, so the
    // shape the run writes and the shape the record demands are one value.
    expect(workflow).toContain('if [ "$method" != "merge" ]');
    expect(workflow).not.toContain('merge_method:"merge"');
  });

  it("falls back to the same default the queue does when nothing configures one", () => {
    expect(DEFAULT_MERGE_METHOD).toBe("merge");
  });

  it("writes the title into the same message, because a git commit has only one", () => {
    // GitHub's merge API takes a title and a body and joins them. Writing the
    // commit ourselves means writing the join, and the trailer has to survive it.
    expect(mergeCommitText(82, "merge_att_1")).toBe(
      `${mergeCommitTitle(82)}\n\n${mergeCommitMessage("merge_att_1")}`,
    );
    expect(mergeCommitText(82, "merge_att_1")).toContain("thwip-queue-operation: merge_att_1");
  });
});

/**
 * The base the merge lands on.
 *
 * Pull requests 114, 117 and 119 were each signed against one base and merged
 * onto another, because GitHub's merge-pull-request API takes an expected head
 * and no expected base. Each produced a tree nobody had verified, and each was
 * refused a chain record afterwards — the honest half of a merge that should
 * never have happened.
 *
 * So the workflow writes the merge commit itself, with the pinned base as the
 * first parent and the verified tree, and moves the branch ref without `force`.
 * GitHub accepts that update only where the branch is still an ancestor of the
 * new commit, which for this commit means the branch is still the pinned base.
 */
describe("the base the workflow merges onto", () => {
  it("takes the base and the tree from the queue's answer, not from its own reads", () => {
    expect(workflow).toContain("jq -r '.merge.baseSha // empty'");
    expect(workflow).toContain("jq -r '.merge.treeOid // empty'");
    expect(workflow).toContain(".merge.parentShas");
  });

  it("refuses to merge when the queue named no base to bind", () => {
    expect(workflow).toContain("the queue named no base for this merge");
  });

  it("writes the commit itself, on the pinned base", () => {
    expect(workflow).toContain("git/commits");
    expect(workflow).toContain('--argjson parents "$parents"');
  });

  it("moves the ref without force, which is what refuses a moved base", () => {
    expect(workflow).toContain("$GITHUB_REPOSITORY/git/refs/heads/${BASE_REF#refs/heads/}");
    expect(workflow).toContain("force:false");
  });

  it("names a moved base rather than retrying onto the new one", () => {
    expect(workflow).toContain("not a fast forward");
    expect(workflow).toContain("BASE_MOVED");
    // Nothing anywhere retries the land.
    expect(workflow).not.toContain("force:true");
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
