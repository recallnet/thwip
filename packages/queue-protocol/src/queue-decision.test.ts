import { describe, expect, it } from "vitest";
import { parseQueueDecision, SCHEDULER_ALGORITHM } from "./queue-decision.js";

function decision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    algorithm: SCHEDULER_ALGORITHM,
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
    queueEpoch: 0,
    turnSequence: 12,
    inputStateVersion: 340,
    selected: {
      entryId: "entry-alice-1",
      pullRequestNumber: 42,
      sponsorPrincipalId: "alice",
      fairnessOrdinal: "7",
    },
    eligiblePrincipalHeads: [
      {
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "264261678",
        lastServedTurn: "3",
        oldestReadyEntryId: "entry-alice-1",
        fairnessOrdinal: "7",
      },
      {
        sponsorPrincipalId: "bob",
        sponsorGithubUserId: "999",
        lastServedTurn: "11",
        oldestReadyEntryId: "entry-bob-1",
        fairnessOrdinal: "2",
      },
    ],
    priorDecisionDigest: `sha256:${"a".repeat(64)}`,
    decidedAt: "2026-07-29T12:00:00Z",
    ...over,
  };
}

describe("parseQueueDecision", () => {
  it("accepts a decision that explains itself", () => {
    expect(parseQueueDecision(decision())).toMatchObject({ ok: true });
  });

  it("accepts the first decision of an epoch with no prior digest", () => {
    expect(parseQueueDecision(decision({ priorDecisionDigest: null }))).toMatchObject({ ok: true });
  });

  it("refuses any algorithm but the one scheduler", () => {
    expect(parseQueueDecision(decision({ algorithm: "weighted-priority-v1" }))).toMatchObject({ ok: false });
  });

  it("rejects a decision whose selected principal is not among the heads", () => {
    const orphan = decision({
      selected: {
        entryId: "entry-carol-1",
        pullRequestNumber: 7,
        sponsorPrincipalId: "carol",
        fairnessOrdinal: "1",
      },
    });
    const result = parseQueueDecision(orphan);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.detail).toMatch(/absent from eligiblePrincipalHeads/);
  });

  it("rejects a decision that skipped a principal served less recently", () => {
    const unfair = decision({
      eligiblePrincipalHeads: [
        {
          sponsorPrincipalId: "alice",
          sponsorGithubUserId: "264261678",
          lastServedTurn: "9",
          oldestReadyEntryId: "entry-alice-1",
          fairnessOrdinal: "7",
        },
        {
          sponsorPrincipalId: "bob",
          sponsorGithubUserId: "999",
          lastServedTurn: "1",
          oldestReadyEntryId: "entry-bob-1",
          fairnessOrdinal: "2",
        },
      ],
    });
    const result = parseQueueDecision(unfair);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.detail).toMatch(/bob was served less recently/);
  });

  it("rejects a selected entry that is not that principal's oldest ready entry", () => {
    const wrong = decision({
      selected: {
        entryId: "entry-alice-9",
        pullRequestNumber: 42,
        sponsorPrincipalId: "alice",
        fairnessOrdinal: "7",
      },
    });
    expect(parseQueueDecision(wrong)).toMatchObject({ ok: false });
  });

  it("rejects a fairness ordinal that disagrees with the principal head", () => {
    const wrong = decision({
      selected: {
        entryId: "entry-alice-1",
        pullRequestNumber: 42,
        sponsorPrincipalId: "alice",
        fairnessOrdinal: "99",
      },
    });
    expect(parseQueueDecision(wrong)).toMatchObject({ ok: false });
  });

  it("rejects a principal listed twice, which would double their apparent share", () => {
    const dupe = decision({
      eligiblePrincipalHeads: [
        ...(decision()["eligiblePrincipalHeads"] as unknown[]),
        {
          sponsorPrincipalId: "alice",
          sponsorGithubUserId: "264261678",
          lastServedTurn: "3",
          oldestReadyEntryId: "entry-alice-1",
          fairnessOrdinal: "7",
        },
      ],
    });
    expect(parseQueueDecision(dupe)).toMatchObject({ ok: false });
  });

  it("keeps counters as decimal strings, never numbers", () => {
    const numeric = decision({
      selected: {
        entryId: "entry-alice-1",
        pullRequestNumber: 42,
        sponsorPrincipalId: "alice",
        fairnessOrdinal: 7,
      },
    });
    expect(parseQueueDecision(numeric)).toMatchObject({ ok: false });
  });

  it("rejects an unknown field", () => {
    expect(parseQueueDecision(decision({ weight: 5 }))).toMatchObject({ ok: false });
  });

  it("rejects a zero turn sequence", () => {
    expect(parseQueueDecision(decision({ turnSequence: 0 }))).toMatchObject({ ok: false });
  });
});
