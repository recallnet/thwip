import { describe, expect, it } from "vitest";
import { emptyState, type Attempt, type BranchQueueState, type Entry, type Transition } from "./reducer.js";
import { decodeState, encodeState } from "./serialize.js";

/**
 * The state has to survive a trip through D1, which stores text. Maps, Sets and
 * bigints do not survive JSON on their own, and each one that silently degrades
 * is a rule the reducer can no longer enforce: a lost `appliedKeys` replays a
 * command, a `turnSequence` that comes back as a Number loses fairness ordering
 * once it passes 2^53.
 */

function entry(over: Partial<Entry> = {}): Entry {
  return {
    entryId: "entry_1",
    pullRequestNumber: 59,
    sponsorPrincipalId: "principal_a",
    sponsorGithubUserId: "264261678",
    fairnessOrdinal: 9_007_199_254_740_995n,
    state: "Ready",
    primaryReason: null,
    secondaryReasons: [],
    schedulerEligible: true,
    cooldownUntil: null,
    headSha: "2".repeat(40),
    currentAttemptId: null,
    lastAttemptId: null,
    ...over,
  };
}

function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    attemptId: "att_1",
    entryId: "entry_1",
    parentAttemptId: null,
    phase: "OFFERED",
    outcome: null,
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    candidateSha: null,
    candidateTree: null,
    policyDigest: null,
    runner: null,
    decisionDigest: `sha256:${"c".repeat(64)}`,
    assignmentDigest: null,
    receiptDigest: null,
    verificationNonce: null,
    intentDigest: null,
    offerDeadline: "2026-07-31T06:00:00.000Z",
    executionDeadline: null,
    graceUntil: null,
    executionMode: null,
    deviceId: null,
    outcomeUnknown: false,
    mergeSha: null,
    expedite: null,
    ...over,
  };
}

const transition: Transition = {
  kind: "TurnOffered",
  transitionSequence: 21,
  priorDigest: `sha256:${"d".repeat(64)}`,
  digest: `sha256:${"e".repeat(64)}`,
  baseSha: "1".repeat(40),
  attemptId: "att_1",
  witnessPrincipalIds: ["principal_a", "principal_b"],
};

/** Every field off its default, so nothing passes by looking like an empty value. */
function rich(): BranchQueueState {
  const state = emptyState("1315419165:refs/heads/main", "1315419165", "refs/heads/main");
  state.lastSequence = 412;
  state.turnSequence = 9_007_199_254_740_993n;
  state.ordinalSequence = 18_446_744_073_709_551_615n;
  state.paused = true;
  state.pauseReason = "operator";
  state.rebaselineRequired = true;
  state.baseSha = "1".repeat(40);
  state.activeAttemptId = "att_1";
  state.entries.set("entry_1", entry());
  state.entries.set("entry_2", entry({ entryId: "entry_2", pullRequestNumber: 61, fairnessOrdinal: 2n }));
  state.attempts.set("att_1", attempt());
  state.lastServedTurn.set("principal_a", 9_007_199_254_740_994n);
  state.fairnessDebt.set("principal_a", ["principal_b", "principal_c"]);
  state.appliedKeys.add("authorize:entry_1:2026-07-31");
  state.appliedKeys.add("alarm:offer:att_1:2026-07-31T05:00:00.000Z");
  state.transitions.push(transition);
  return state;
}

describe("encoding the queue state for storage", () => {
  it("comes back as the same state", () => {
    const before = rich();
    const after = decodeState(JSON.parse(JSON.stringify(encodeState(before))));
    expect(after).toEqual(before);
  });

  it("keeps bigints exact past the range a Number can hold", () => {
    const after = decodeState(JSON.parse(JSON.stringify(encodeState(rich()))));
    expect(after.turnSequence).toBe(9_007_199_254_740_993n);
    expect(after.ordinalSequence).toBe(18_446_744_073_709_551_615n);
    expect(after.entries.get("entry_1")?.fairnessOrdinal).toBe(9_007_199_254_740_995n);
    expect(after.lastServedTurn.get("principal_a")).toBe(9_007_199_254_740_994n);
  });

  it("keeps the collection types, so the reducer still sees Maps and a Set", () => {
    const after = decodeState(JSON.parse(JSON.stringify(encodeState(rich()))));
    expect(after.entries).toBeInstanceOf(Map);
    expect(after.attempts).toBeInstanceOf(Map);
    expect(after.lastServedTurn).toBeInstanceOf(Map);
    expect(after.fairnessDebt).toBeInstanceOf(Map);
    expect(after.appliedKeys).toBeInstanceOf(Set);
    expect(after.appliedKeys.has("authorize:entry_1:2026-07-31")).toBe(true);
  });

  it("round-trips an empty queue", () => {
    const before = emptyState("k", "1", "refs/heads/main");
    expect(decodeState(JSON.parse(JSON.stringify(encodeState(before))))).toEqual(before);
  });

  /**
   * A field added to the state and not to the encoder would be dropped on every
   * write, and the loss would only show up as a rule that stopped holding.
   */
  it("carries every field the state declares", () => {
    const state = rich();
    const encoded = encodeState(state) as Record<string, unknown>;
    expect(Object.keys(encoded).sort()).toEqual(Object.keys(state).sort());
  });

  it("produces something JSON can actually store", () => {
    // JSON.stringify throws on a bigint, so this fails the moment one survives
    // encoding anywhere in the tree, nested fields included.
    expect(() => JSON.stringify(encodeState(rich()))).not.toThrow();
  });
});
