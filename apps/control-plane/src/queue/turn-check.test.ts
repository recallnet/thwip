import { describe, expect, it } from "vitest";
import { BLOCKING_REASONS } from "@thwip/queue-domain";
import { nextActionFor } from "@thwip/vocabulary";
import type { QueueSnapshot } from "./queue-operations.js";
import {
  nextAction,
  turnCheckRun,
  turnCheckUpdates,
  turnStateOf,
  type TurnCheckUpdate,
  type TurnState,
} from "./turn-check.js";

/**
 * Whose turn it is, as a check GitHub can require.
 *
 * The reason this is separate from the proof check is that the two answers
 * change on different clocks. A proof is good or not for a tree and stays that
 * way; the turn moves every time the lane does. One check carrying both went red
 * for everyone who was waiting, and a red required check keeps refusing the merge
 * after the queue has said yes.
 */

function snapshot(over: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    generation: 1,
    attemptRevision: 0,
    queueEpoch: 0,
    paused: false,
    pauseReason: null,
    rebaselineRequired: false,
    baseSha: null,
    activeAttemptId: null,
    activeEntryId: null,
    chainHead: null,
    transitions: [],
    entries: [],
    ...over,
  };
}

let n = 0;
function entry(over: Partial<QueueSnapshot["entries"][number]> = {}) {
  n += 1;
  return {
    entryId: `entry_${n}`,
    pullRequestNumber: n,
    sponsorPrincipalId: "alice",
    state: "Ready",
    primaryReason: null,
    schedulerEligible: true,
    fairnessOrdinal: String(n),
    cooldownUntil: null,
    lastAttemptId: null,
    headSha: "a".repeat(40),
    ...over,
  };
}

describe("reading the turn out of a snapshot", () => {
  it("says the lane holder holds it", () => {
    for (const state of ["Offered", "Active", "Verifying", "MergeGuard", "Merging"]) {
      expect(turnStateOf(snapshot({ activeAttemptId: "att" }), state), state).toBe("holds");
    }
  });

  it("says everyone else is waiting", () => {
    for (const state of ["Ready", "Blocked", "Deferred"]) {
      expect(turnStateOf(snapshot({ activeAttemptId: "att" }), state), state).toBe("waiting");
    }
  });

  it("holds nobody's turn while no attempt is live", () => {
    expect(turnStateOf(snapshot({ activeAttemptId: null }), "Active")).toBe("waiting");
  });

  it("reports a halted queue as halted, even for the pull request that held the lane", () => {
    expect(turnStateOf(snapshot({ activeAttemptId: "att", paused: true }), "Active")).toBe("halted");
    expect(turnStateOf(snapshot({ activeAttemptId: "att", rebaselineRequired: true }), "Active")).toBe(
      "halted",
    );
  });
});

describe("deciding what to publish", () => {
  it("publishes for everyone the first time, because nothing has been said yet", () => {
    const after = snapshot({ activeAttemptId: "att", entries: [entry({ state: "Active" }), entry()] });
    expect(turnCheckUpdates(null, after)).toHaveLength(2);
  });

  it("says nothing when nothing moved", () => {
    const entries = [entry({ state: "Active" }), entry()];
    const before = snapshot({ activeAttemptId: "att", entries });
    const after = snapshot({ activeAttemptId: "att", entries });
    expect(turnCheckUpdates(before, after)).toEqual([]);
  });

  it("publishes for both sides when the lane moves, and nobody else", () => {
    const a = entry({ entryId: "a", state: "Active" });
    const b = entry({ entryId: "b", state: "Ready" });
    const c = entry({ entryId: "c", state: "Ready" });
    const before = snapshot({ activeAttemptId: "att1", entries: [a, b, c] });
    const after = snapshot({
      activeAttemptId: "att2",
      entries: [{ ...a, state: "Merged" }, { ...b, state: "Active" }, c],
    });

    const updates = turnCheckUpdates(before, after);
    // `a` finished, so it needs nothing; `b` took the lane; `c` did not move.
    expect(updates.map((u) => u.entryId)).toEqual(["b"]);
    expect(updates[0]!.state).toBe("holds");
  });

  it("publishes again when a pull request pushes a new commit", () => {
    const before = snapshot({ entries: [entry({ entryId: "a", headSha: "a".repeat(40) })] });
    const after = snapshot({ entries: [entry({ entryId: "a", headSha: "b".repeat(40) })] });
    const updates = turnCheckUpdates(before, after);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.headSha).toBe("b".repeat(40));
  });

  it("says nothing about a pull request that has finished", () => {
    const before = snapshot({ activeAttemptId: "att", entries: [entry({ entryId: "a", state: "Active" })] });
    const after = snapshot({ entries: [entry({ entryId: "a", state: "Merged" })] });
    expect(turnCheckUpdates(before, after)).toEqual([]);
  });

  it("tells everyone when the queue halts", () => {
    const entries = [entry({ entryId: "a", state: "Active" }), entry({ entryId: "b" })];
    const before = snapshot({ activeAttemptId: "att", entries });
    const after = snapshot({ activeAttemptId: "att", paused: true, entries });

    const updates = turnCheckUpdates(before, after);
    expect(updates.map((u) => u.state)).toEqual(["halted", "halted"]);
  });

  it("skips an entry with no commit to publish against", () => {
    const after = snapshot({ entries: [entry({ headSha: null })] });
    expect(turnCheckUpdates(null, after)).toEqual([]);
  });

  it("counts how many are waiting, so the check can say something useful", () => {
    const after = snapshot({
      activeAttemptId: "att",
      entries: [entry({ state: "Active" }), entry(), entry(), entry()],
    });
    const updates = turnCheckUpdates(null, after);
    expect(updates.every((u) => u.waiting === 3)).toBe(true);
  });
});

/**
 * What the check actually says is the part that decides whether a merge is
 * blocked, so it is worth pinning separately from what triggers a publish.
 */
describe("what the check says", () => {
  const update = (state: TurnState, waiting = 0): TurnCheckUpdate => ({
    entryId: "e",
    pullRequestNumber: 1,
    headSha: "a".repeat(40),
    state,
    waiting,
  });

  it("completes green only for the pull request that holds the turn", () => {
    expect(turnCheckRun(update("holds"))).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("leaves a waiting pull request in progress rather than failing it", () => {
    const run = turnCheckRun(update("waiting", 3));
    expect(run).toMatchObject({ status: "in_progress", conclusion: null });
    // A failed required check keeps refusing the merge after the queue has said
    // yes, which is the whole reason this is not a failure.
    expect(run.conclusion).not.toBe("failure");
  });

  it("counts the ones ahead, not itself", () => {
    expect(turnCheckRun(update("waiting", 3)).title).toContain("behind 2 other pull requests");
    expect(turnCheckRun(update("waiting", 2)).title).toContain("behind 1 other pull request");
    expect(turnCheckRun(update("waiting", 1)).title).toContain("behind 0 other pull requests");
    // Never negative, however the count arrives.
    expect(turnCheckRun(update("waiting", 0)).title).toContain("behind 0");
  });

  it("says a halted queue is halted, without failing anybody for it", () => {
    expect(turnCheckRun(update("halted"))).toMatchObject({ status: "in_progress", conclusion: null });
  });

  /**
   * The one failure. Waiting resolves itself; an author with no activated
   * principal does not, so a check that sat in progress forever would say
   * nothing about what to do.
   */
  it("fails a pull request the queue cannot place, and says what unblocks it", () => {
    const run = turnCheckRun(update("unplaceable"));
    expect(run).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(run.summary).toMatch(/activat/i);
  });

  it("never leaves a completed run without a conclusion, or an in-progress one with one", () => {
    for (const state of ["holds", "waiting", "halted", "unplaceable"] as const) {
      const run = turnCheckRun(update(state));
      expect(run.status === "completed" ? run.conclusion !== null : run.conclusion === null, state).toBe(true);
    }
  });
});

/**
 * Why a pull request is waiting, on the check a developer already opens.
 *
 * The queue knew the reason all along and said none of it here. A developer
 * whose review had not landed and one whose branch conflicted read the same
 * sentence, "waiting for a turn", and neither was told the thing they could act
 * on. The sentences were written, and lived on `Thwip / Merge`, a check no
 * source ever published and no branch ever required.
 *
 * They belong on this check because this is the one that exists.
 */
describe("what is holding a waiting pull request up", () => {
  const waiting = (primaryReason: string | null, waitingCount = 3): TurnCheckUpdate => ({
    entryId: "e",
    pullRequestNumber: 1,
    headSha: "a".repeat(40),
    state: "waiting",
    waiting: waitingCount,
    primaryReason,
  });

  it("names the reason in the title instead of calling everything a turn", () => {
    expect(turnCheckRun(waiting("REVIEW_REQUIRED")).title).toBe("Waiting for review");
    expect(turnCheckRun(waiting("MERGE_CONFLICT")).title).toBe("Conflict with the base branch");
    expect(turnCheckRun(waiting("LOCAL_RECEIPT_MISSING")).title).toBe("No accepted proof on this commit");
    expect(turnCheckRun(waiting("AGENT_OFFLINE")).title).toBe("Waiting for a machine");
  });

  it("prints the same sentence the CLI and the dashboard print", () => {
    for (const reason of ["REVIEW_REQUIRED", "MERGE_CONFLICT", "PR_DRAFT"] as const) {
      expect(turnCheckRun(waiting(reason)).summary).toContain(nextActionFor(reason, "check"));
    }
  });

  it("goes on reporting a blocked pull request as still running, never as failed", () => {
    for (const reason of BLOCKING_REASONS) {
      const run = turnCheckRun(waiting(reason));
      // A failed required check keeps refusing after the queue has authorized.
      // Being blocked is a reason to say more, never a reason to go red.
      expect(run, reason).toMatchObject({ status: "in_progress", conclusion: null });
    }
  });

  it("has a sentence for every reason the queue can produce", () => {
    for (const reason of BLOCKING_REASONS) {
      expect(turnCheckRun(waiting(reason)).summary, reason).not.toContain(`Blocked: ${reason}.`);
    }
  });

  it("quotes a reason it has no sentence for rather than inventing one", () => {
    expect(turnCheckRun(waiting("SOMETHING_A_NEWER_SERVICE_KNOWS")).summary).toContain(
      "Blocked: SOMETHING_A_NEWER_SERVICE_KNOWS.",
    );
  });

  it("keeps the plain wait for a pull request nothing is blocking", () => {
    const run = turnCheckRun(waiting(null));
    expect(run.title).toContain("behind 2 other pull requests");
    expect(run.summary).toContain("nothing is wrong with it");
  });

  it("promises an order that moves, because readiness is re-derived on every event", () => {
    expect(turnCheckRun(waiting("REVIEW_REQUIRED")).summary).toMatch(/changes as reviews and checks change/);
  });

  it("says the place in line is kept while the reason stands", () => {
    expect(turnCheckRun(waiting("MERGE_CONFLICT")).summary).toMatch(/place in line/i);
  });
});

/**
 * A halted queue has two causes and one of them needs a person.
 *
 * "An administrator paused it, or the branch moved outside the queue" made the
 * reader guess. A rebaseline is not something waiting fixes.
 */
describe("why the queue is halted", () => {
  const halted = (haltReason: TurnCheckUpdate["haltReason"]): TurnCheckUpdate => ({
    entryId: "e",
    pullRequestNumber: 1,
    headSha: "a".repeat(40),
    state: "halted",
    waiting: 0,
    haltReason,
  });

  it("names a branch that moved outside the queue, and what clears it", () => {
    const run = turnCheckRun(halted("EXTERNAL_TRANSITION"));
    expect(run.summary).toContain("moved outside the queue");
    expect(run.summary).toMatch(/rebaseline/i);
    expect(run.summary).not.toContain("An administrator paused it, or");
  });

  it("names an administrator's pause as an administrator's pause", () => {
    const run = turnCheckRun(halted("PAUSED"));
    expect(run.summary).toMatch(/administrator/i);
    expect(run.summary).not.toContain("moved outside the queue");
  });

  it("reads the cause off the snapshot rather than making the developer guess", () => {
    const entries = [entry({ entryId: "a", state: "Active" })];
    const before = snapshot({ activeAttemptId: "att", entries });
    expect(
      turnCheckUpdates(before, snapshot({ activeAttemptId: "att", rebaselineRequired: true, entries }))[0]!
        .haltReason,
    ).toBe("EXTERNAL_TRANSITION");
    expect(
      turnCheckUpdates(
        before,
        snapshot({ activeAttemptId: "att", paused: true, pauseReason: "EXTERNAL_TRANSITION", entries }),
      )[0]!.haltReason,
    ).toBe("EXTERNAL_TRANSITION");
    expect(
      turnCheckUpdates(
        before,
        snapshot({ activeAttemptId: "att", paused: true, pauseReason: "maintenance", entries }),
      )[0]!.haltReason,
    ).toBe("PAUSED");
  });
});

/**
 * The publisher only says what changed, and the reason is now part of what it
 * says. A pull request whose review lands and whose branch then conflicts has
 * not changed turn, so the old comparison would have left the first sentence on
 * the commit and gone quiet. That is the same shape as the bug that left most
 * pull requests with no turn check at all: a state-writing path with nothing
 * publishing for it.
 */
describe("republishing when the reason changes", () => {
  it("publishes again when a waiting pull request is blocked by something else", () => {
    const before = snapshot({
      entries: [entry({ entryId: "a", state: "Blocked", primaryReason: "REVIEW_REQUIRED" })],
    });
    const after = snapshot({
      entries: [entry({ entryId: "a", state: "Blocked", primaryReason: "MERGE_CONFLICT" })],
    });
    const updates = turnCheckUpdates(before, after);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.primaryReason).toBe("MERGE_CONFLICT");
  });

  it("publishes again when the last thing blocking a pull request clears", () => {
    const before = snapshot({
      entries: [entry({ entryId: "a", state: "Blocked", primaryReason: "REVIEW_REQUIRED" })],
    });
    const after = snapshot({ entries: [entry({ entryId: "a", state: "Ready", primaryReason: null })] });
    expect(turnCheckUpdates(before, after)[0]!.primaryReason).toBeNull();
  });

  it("still says nothing when neither the turn nor the reason moved", () => {
    const entries = [entry({ entryId: "a", state: "Blocked", primaryReason: "REVIEW_REQUIRED" })];
    expect(turnCheckUpdates(snapshot({ entries }), snapshot({ entries }))).toEqual([]);
  });

  it("carries the reason it read out of the snapshot", () => {
    const after = snapshot({
      entries: [entry({ entryId: "a", state: "Blocked", primaryReason: "PR_DRAFT" })],
    });
    expect(turnCheckUpdates(null, after)[0]!.primaryReason).toBe("PR_DRAFT");
  });
});

/**
 * The drift guard that used to sit on `Thwip / Merge`. It is the reason the
 * wording survived deletion intact: the sentence is looked up from
 * `@thwip/vocabulary`, never copied, so a reason added without one fails here.
 */
describe("the sentence the check publishes", () => {
  it("explains every blocking reason the queue can report", () => {
    for (const reason of BLOCKING_REASONS) {
      expect(nextAction(reason), reason).not.toBe(`Blocked: ${reason}.`);
    }
  });

  it("says nothing when nothing is blocking", () => {
    expect(nextAction(null)).toBeNull();
  });

  it("names an unrecognized code instead of guessing at guidance for it", () => {
    expect(nextAction("SOMETHING_NEW")).toBe("Blocked: SOMETHING_NEW.");
  });
});
