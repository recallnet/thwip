import { describe, expect, it } from "vitest";
import { applyEvent, checkInvariants, emptyState, type BranchQueueState } from "./index.js";
import { compactState, DEFAULT_COMPACTION } from "./compact.js";

/**
 * The queue's state is read and written whole on every request, so anything in
 * it that grows with the repository's merge history is a cost that never stops
 * rising and eventually a document too large to move. Entries, attempts and the
 * transition chain all grew that way: nothing was ever removed.
 *
 * Compaction drops what no live decision can reach. What it must never do is
 * change a decision, so these tests are about what survives rather than what
 * goes.
 */

function seed(): BranchQueueState {
  return emptyState("qk", "1315419165", "refs/heads/main");
}

let n = 0;
function entry(state: BranchQueueState, id: string, entryState: string, attemptId: string | null = null) {
  n += 1;
  state.entries.set(id, {
    entryId: id,
    pullRequestNumber: n,
    sponsorPrincipalId: "alice",
    sponsorGithubUserId: "1",
    fairnessOrdinal: BigInt(n),
    state: entryState as never,
    primaryReason: null,
    secondaryReasons: [],
    schedulerEligible: true,
    cooldownUntil: null,
    headSha: "h".repeat(40),
    currentAttemptId: null,
    lastAttemptId: attemptId,
  });
  if (attemptId !== null) {
    state.attempts.set(attemptId, {
      attemptId,
      entryId: id,
      parentAttemptId: null,
      phase: "MERGED",
      outcome: null,
      baseSha: null,
      headSha: null,
      candidateSha: "c".repeat(40),
      // A merged attempt has a pinned candidate; the invariants say so, and a
      // fixture that skipped it would be testing a state the queue cannot reach.
      candidateTree: "t".repeat(40),
      policyDigest: `sha256:${"p".repeat(64)}`,
      runner: null,
      decisionDigest: `sha256:${"d".repeat(64)}`,
      assignmentDigest: null,
      receiptDigest: null,
      verificationNonce: null,
      intentDigest: null,
      offerDeadline: "2026-07-31T07:00:00.000Z",
      executionDeadline: null,
      graceUntil: null,
      executionMode: null,
      deviceId: null,
      outcomeUnknown: false,
      mergeSha: null,
      expedite: null,
    });
  }
}

function chain(state: BranchQueueState, length: number) {
  let prior: string | null = null;
  for (let i = 1; i <= length; i += 1) {
    const digest = `sha256:${String(i).padStart(64, "0")}`;
    state.transitions.push({
      kind: "verified",
      transitionSequence: i,
      priorDigest: prior,
      digest,
      baseSha: String(i).padStart(40, "b"),
      attemptId: null,
      witnessPrincipalIds: [],
    });
    prior = digest;
  }
}

describe("compacting the queue state", () => {
  it("keeps every entry that is still in the running", () => {
    const state = seed();
    for (const s of ["Ready", "Blocked", "Deferred", "Offered", "Active", "Verifying", "Merging"]) {
      entry(state, `live_${s}`, s);
    }
    const live = state.entries.size;
    compactState(state, { terminalEntries: 1, transitions: 1 });
    expect(state.entries.size).toBe(live);
  });

  it("keeps the most recent finished entries and drops the rest", () => {
    const state = seed();
    for (let i = 1; i <= 10; i += 1) entry(state, `done_${i}`, "Merged");
    compactState(state, { terminalEntries: 3, transitions: 1 });

    const kept = [...state.entries.keys()].sort();
    expect(kept).toHaveLength(3);
    // The newest by fairness ordinal, which is the order they joined.
    expect(kept).toEqual(["done_10", "done_8", "done_9"]);
  });

  it("keeps the attempts a surviving entry still points at", () => {
    const state = seed();
    entry(state, "live", "Ready", "att_live");
    entry(state, "older", "Merged", "att_older");
    entry(state, "newer", "Merged", "att_newer");
    // One finished entry survives whatever the limit says, and it is the newest,
    // so the older one goes and takes its attempt with it.
    compactState(state, { terminalEntries: 1, transitions: 1 });

    expect([...state.attempts.keys()].sort()).toEqual(["att_live", "att_newer"]);
  });

  it("keeps one finished entry even when asked for none, so it can be projected", () => {
    const state = seed();
    entry(state, "done", "Merged");
    compactState(state, { terminalEntries: 0, transitions: 1 });
    expect([...state.entries.keys()]).toEqual(["done"]);
  });

  it("never drops the attempt holding the lane", () => {
    const state = seed();
    entry(state, "holder", "Active", "att_active");
    state.activeAttemptId = "att_active";
    compactState(state, { terminalEntries: 1, transitions: 1 });
    expect(state.attempts.has("att_active")).toBe(true);
  });

  it("trims the chain to a window, keeping the newest links", () => {
    const state = seed();
    chain(state, 40);
    compactState(state, { terminalEntries: 1, transitions: 5 });

    expect(state.transitions).toHaveLength(5);
    expect(state.transitions.at(-1)!.transitionSequence).toBe(40);
    expect(state.transitions[0]!.transitionSequence).toBe(36);
  });

  /**
   * The reducer extends the chain from the last link it can see, so a window
   * that emptied would make the next transition claim sequence 1 and restart the
   * chain — the exact falsehood this queue exists to avoid.
   */
  it("always leaves the last link, so the chain can be extended", () => {
    const state = seed();
    chain(state, 12);
    compactState(state, { terminalEntries: 1, transitions: 0 });
    expect(state.transitions).toHaveLength(1);
    expect(state.transitions[0]!.transitionSequence).toBe(12);
  });

  it("leaves a chain shorter than the window alone", () => {
    const state = seed();
    chain(state, 3);
    compactState(state, { terminalEntries: 1, transitions: 10 });
    expect(state.transitions).toHaveLength(3);
  });

  it("still satisfies every invariant afterwards", () => {
    const state = seed();
    chain(state, 30);
    for (let i = 1; i <= 12; i += 1) entry(state, `done_${i}`, "Merged", `att_${i}`);
    entry(state, "live", "Ready");
    compactState(state, DEFAULT_COMPACTION);
    expect(checkInvariants(state)).toEqual([]);
  });

  it("changes nothing when run again", () => {
    const state = seed();
    chain(state, 30);
    for (let i = 1; i <= 12; i += 1) entry(state, `done_${i}`, "Merged", `att_${i}`);
    compactState(state, DEFAULT_COMPACTION);
    const once = JSON.stringify([...state.entries.keys()].sort()) + state.transitions.length;
    compactState(state, DEFAULT_COMPACTION);
    expect(JSON.stringify([...state.entries.keys()].sort()) + state.transitions.length).toBe(once);
  });

  it("lets the reducer carry on recording transitions across the window", () => {
    const state = seed();
    chain(state, 30);
    compactState(state, { terminalEntries: 1, transitions: 2 });

    const head = state.transitions.at(-1)!;
    const next = applyEvent(state, {
      sequence: 1,
      idempotencyKey: "k",
      at: "2026-07-31T07:00:00.000Z",
      type: "TransitionRecorded",
      kind: "verified",
      transitionSequence: head.transitionSequence + 1,
      priorDigest: head.digest,
      digest: `sha256:${"9".repeat(64)}`,
      baseSha: "c".repeat(40),
      attemptId: null,
      witnessPrincipalIds: [],
    } as never);

    expect(next.transitions.at(-1)!.transitionSequence).toBe(31);
    expect(checkInvariants(next)).toEqual([]);
  });
});
