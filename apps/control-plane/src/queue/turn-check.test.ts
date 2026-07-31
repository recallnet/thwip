import { describe, expect, it } from "vitest";
import type { QueueSnapshot } from "./queue-operations.js";
import { turnCheckUpdates, turnStateOf } from "./turn-check.js";

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
