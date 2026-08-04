import { describe, expect, it } from "vitest";
import type { QueueSnapshot } from "./queue-operations.js";
import {
  COMMENT_MARKER,
  commentFingerprint,
  commentViews,
  statusCommentBody,
  type CommentView,
} from "./status-comment.js";

/**
 * What a person reads on their own pull request.
 *
 * `thwip / turn` renders the same for a draft that is correctly blocked, an
 * entry a few seconds from the end of a cooldown, and an entry that is stuck.
 * All three were live on this repository at once on 4 August and the second was
 * read as the third. The queue holds the difference and published none of it.
 */

function entry(over: Partial<QueueSnapshot["entries"][number]> = {}): QueueSnapshot["entries"][number] {
  return {
    entryId: "e1",
    pullRequestNumber: 100,
    sponsorPrincipalId: "p1",
    state: "Ready",
    primaryReason: null,
    schedulerEligible: true,
    fairnessOrdinal: "1",
    cooldownUntil: null,
    lastAttemptId: null,
    headSha: "a".repeat(40),
    ...over,
  };
}

function snapshot(over: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    generation: 1,
    attemptRevision: 0,
    queueEpoch: 0,
    turnSequence: 0,
    paused: false,
    pauseReason: null,
    rebaselineRequired: false,
    baseSha: "b".repeat(40),
    activeAttemptId: null,
    activeEntryId: null,
    activeCandidate: null,
    activeDecisionDigest: null,
    chainHead: null,
    transitions: [],
    entries: [entry()],
    ...over,
  } as QueueSnapshot;
}

const NOW = "2026-08-04T21:14:02.000Z";

function only(snap: QueueSnapshot, options?: Parameters<typeof commentViews>[1]): CommentView {
  const views = commentViews(snap, options ?? { observing: false, now: NOW });
  expect(views).toHaveLength(1);
  return views[0]!;
}

describe("which of the six a reader is looking at", () => {
  it("names a draft as a draft rather than as waiting", () => {
    const view = only(
      snapshot({ entries: [entry({ state: "Blocked", schedulerEligible: false, primaryReason: "PR_DRAFT" })] }),
    );
    expect(view.state).toBe("draft");
    const body = statusCommentBody(view, NOW);
    expect(body).toContain("draft");
    expect(body).toContain("Mark the pull request ready for review.");
  });

  it("dates the cooldown it is serving, so nobody reads it as stuck", () => {
    const view = only(
      snapshot({
        entries: [entry({ state: "Ready", schedulerEligible: false, cooldownUntil: "2026-08-04T21:14:17.000Z" })],
      }),
    );
    expect(view.state).toBe("cooldown");
    expect(view.cooldownUntil).toBe("2026-08-04T21:14:17.000Z");
    expect(statusCommentBody(view, NOW)).toContain("21:14:17");
  });

  it("counts a cooldown that has run out as waiting, not as cooling", () => {
    const view = only(
      snapshot({
        entries: [entry({ state: "Ready", cooldownUntil: "2026-08-04T21:13:00.000Z" })],
      }),
    );
    expect(view.state).toBe("waiting");
  });

  it("says where in line it is and who is ahead of it", () => {
    const views = commentViews(
      snapshot({
        entries: [
          entry({ entryId: "a", pullRequestNumber: 181, fairnessOrdinal: "1" }),
          entry({ entryId: "b", pullRequestNumber: 185, fairnessOrdinal: "2" }),
          entry({ entryId: "c", pullRequestNumber: 190, fairnessOrdinal: "3" }),
        ],
      }),
      { observing: false, now: NOW },
    );
    const last = views[2]!;
    expect(last.position).toBe(3);
    expect(last.queued).toBe(3);
    expect(last.ahead).toEqual([181, 185]);
    const body = statusCommentBody(last, NOW);
    expect(body).toContain("position 3 of 3");
    expect(body).toContain("#181");
    expect(body).toContain("#185");
  });

  it("says the lane is being run rather than that it is waiting", () => {
    const view = only(
      snapshot({
        activeAttemptId: "att1",
        activeEntryId: "e1",
        entries: [entry({ state: "Active" })],
      }),
    );
    expect(view.state).toBe("holds");
    expect(statusCommentBody(view, NOW)).toContain("This pull request holds the lane and is being integrated.");
  });

  it("separates writing the merge from running the suites", () => {
    const view = only(
      snapshot({ activeAttemptId: "att1", activeEntryId: "e1", entries: [entry({ state: "Merging" })] }),
    );
    expect(view.state).toBe("merging");
  });

  it("gives a blocked entry the queue's own sentence for its reason", () => {
    const view = only(
      snapshot({
        entries: [entry({ state: "Blocked", schedulerEligible: false, primaryReason: "REVIEW_REQUIRED" })],
      }),
    );
    expect(view.state).toBe("blocked");
    const body = statusCommentBody(view, NOW);
    // The heading names the problem, in the same words the check names it. A
    // reader scanning the notification list should not have to open anything.
    expect(body).toContain("blocked · Waiting for review");
    expect(body).toContain("Ask for a review.");
  });

  it("collapses to the chain record on merge", () => {
    const view = only(
      snapshot({
        chainHead: { sequence: 42, digest: `sha256:${"c".repeat(64)}` },
        transitions: [
          { transitionSequence: 42, kind: "merge", priorDigest: null, digest: `sha256:${"c".repeat(64)}`, baseSha: "b".repeat(40), attemptId: "att1", witnessPrincipalIds: [], recordedAt: null },
        ],
        entries: [entry({ state: "Merged", lastAttemptId: "att1" })],
      }),
    );
    expect(view.state).toBe("merged");
    const body = statusCommentBody(view, NOW);
    expect(body).toContain("42");
    // Sixteen characters of the digest, not sixteen characters of the word
    // "sha256". Live on pull request 180 this read `sha256:39966989f`, which
    // names the algorithm and four bytes of the record.
    expect(body).toContain("cccccccccccccccc");
    expect(body).not.toContain("sha256");
    // One line and the marker. A merged pull request has nowhere left to go and
    // a paragraph about it is somebody's unread notification.
    expect(body.split("\n").filter((line) => line.trim().length > 0 && !line.includes(COMMENT_MARKER))).toHaveLength(1);
  });

  /**
   * Live on 4 August: pull requests 194, 197 and 198 all merged, and all three
   * comments named record 142. The chain head is the head of the whole chain,
   * so every merged entry claimed whichever merge happened last. Three
   * different merges, one digest, and it looks right.
   */
  it("names the record this entry merged as, not whatever merged last", () => {
    const views = commentViews(
      snapshot({
        chainHead: { sequence: 43, digest: `sha256:${"d".repeat(64)}` },
        transitions: [
          { transitionSequence: 42, kind: "merge", priorDigest: null, digest: `sha256:${"c".repeat(64)}`, baseSha: "b".repeat(40), attemptId: "att_a", witnessPrincipalIds: [], recordedAt: null },
          { transitionSequence: 43, kind: "merge", priorDigest: null, digest: `sha256:${"d".repeat(64)}`, baseSha: "b".repeat(40), attemptId: "att_b", witnessPrincipalIds: [], recordedAt: null },
        ],
        entries: [
          entry({ entryId: "a", pullRequestNumber: 194, state: "Merged", lastAttemptId: "att_a" }),
          entry({ entryId: "b", pullRequestNumber: 197, state: "Merged", lastAttemptId: "att_b" }),
        ],
      }),
      { observing: false, now: NOW },
    );
    expect(views[0]!.record).toEqual({ sequence: 42, digest: `sha256:${"c".repeat(64)}` });
    expect(views[1]!.record).toEqual({ sequence: 43, digest: `sha256:${"d".repeat(64)}` });
  });

  /**
   * The chain keeps only the recent transitions, so an old merge has no link to
   * point at. Naming the head instead would be a wrong answer that looks right,
   * which is worse than saying merged and stopping.
   */
  it("says merged and nothing more when it cannot find the entry's own record", () => {
    const view = only(
      snapshot({
        chainHead: { sequence: 43, digest: `sha256:${"d".repeat(64)}` },
        transitions: [],
        entries: [entry({ state: "Merged", lastAttemptId: "att_gone" })],
      }),
    );
    expect(view.record).toBeNull();
    expect(statusCommentBody(view, NOW)).not.toContain("record");
  });

  it("says a cancelled entry is out of the queue", () => {
    const view = only(snapshot({ entries: [entry({ state: "Cancelled" })] }));
    expect(view.state).toBe("cancelled");
    expect(statusCommentBody(view, NOW)).toContain("cancelled");
  });

  it("says the queue is not offering turns when it is halted", () => {
    const view = only(snapshot({ paused: true, pauseReason: "PAUSED", entries: [entry()] }));
    expect(view.state).toBe("halted");
    expect(statusCommentBody(view, NOW)).toContain("An administrator can resume it.");
  });

  it("says what the queue would do for a repository that is only observing", () => {
    const view = only(snapshot(), { observing: true, now: NOW });
    expect(view.observing).toBe(true);
    expect(statusCommentBody(view, NOW)).toContain("observing");
  });
});

describe("what stops the comment going stale without saying so", () => {
  it("carries when it was last written", () => {
    expect(statusCommentBody(only(snapshot()), NOW)).toContain("21:14:02 UTC");
  });

  it("carries a marker so the App can find its own comment when the id is lost", () => {
    expect(statusCommentBody(only(snapshot()), NOW)).toContain(COMMENT_MARKER);
  });

  it("fingerprints what it says and not when it said it", () => {
    const view = only(snapshot());
    expect(commentFingerprint(view)).toBe(commentFingerprint(view));
    const moved = only(snapshot({ entries: [entry({ state: "Active" })], activeAttemptId: "a", activeEntryId: "e1" }));
    expect(commentFingerprint(moved)).not.toBe(commentFingerprint(view));
  });

  it("changes its fingerprint when the queue in front of it changes", () => {
    const alone = only(snapshot());
    const behind = commentViews(
      snapshot({
        entries: [entry({ entryId: "z", pullRequestNumber: 9, fairnessOrdinal: "0" }), entry()],
      }),
      { observing: false, now: NOW },
    )[1]!;
    expect(commentFingerprint(behind)).not.toBe(commentFingerprint(alone));
  });
});

describe("who gets a comment at all", () => {
  it("says the branch is no longer managed when the queue stops tracking it", () => {
    const body = statusCommentBody(
      {
        entryId: "e1",
        pullRequestNumber: 100,
        state: "untracked",
        position: null,
        queued: 0,
        ahead: [],
        reason: null,
        cooldownUntil: null,
        haltReason: null,
        record: null,
        observing: false,
      },
      NOW,
    );
    expect(body).toContain("no longer");
  });
});
