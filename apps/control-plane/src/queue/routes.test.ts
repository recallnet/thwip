import { describe, expect, it } from "vitest";
import { pageLiveQueue, parseQueuePages, projectionMessageFrom } from "./routes.js";

/**
 * The projection is what a dashboard, an export, and an audit read. If it says a
 * transition was verified when the queue recorded it as external, a reader is
 * misled with no way to notice, so the mapping is checked field by field against
 * a snapshot carrying a chain that is deliberately not all verified.
 */
describe("projectionMessageFrom", () => {
  const snapshot = {
    generation: 72,
    attemptRevision: 4,
    queueEpoch: 2,
    paused: false,
    pauseReason: null,
    rebaselineRequired: false,
    baseSha: "c".repeat(40),
    activeAttemptId: "att_live",
    chainHead: { sequence: 3, digest: "sha256:three" },
    transitions: [
      {
        transitionSequence: 1,
        kind: "verified",
        priorDigest: null,
        digest: "sha256:one",
        baseSha: "a".repeat(40),
        attemptId: "att_one",
        witnessPrincipalIds: ["p1", "p2"],
        recordedAt: "2026-07-29T00:00:00Z",
      },
      {
        transitionSequence: 2,
        kind: "external",
        priorDigest: "sha256:one",
        digest: "sha256:two",
        baseSha: "b".repeat(40),
        attemptId: null,
        witnessPrincipalIds: [],
        recordedAt: null,
      },
      {
        transitionSequence: 3,
        kind: "override",
        priorDigest: "sha256:two",
        digest: "sha256:three",
        baseSha: "c".repeat(40),
        attemptId: "att_three",
        witnessPrincipalIds: ["p1"],
        recordedAt: "2026-07-30T00:00:00Z",
      },
    ],
    entries: [
      {
        entryId: "entry_1",
        pullRequestNumber: 35,
        sponsorPrincipalId: "p1",
        state: "Merged",
        primaryReason: null,
        schedulerEligible: false,
        fairnessOrdinal: "7",
        cooldownUntil: null,
      },
    ],
  };

  it("projects every recorded transition, not only the head", () => {
    const message = projectionMessageFrom("1315419165", "refs/heads/main", snapshot);
    expect(message.transitions.map((t) => t.transitionSequence)).toEqual([1, 2, 3]);
  });

  it("reports each transition's real kind", () => {
    const message = projectionMessageFrom("1315419165", "refs/heads/main", snapshot);
    expect(message.transitions.map((t) => t.kind)).toEqual(["verified", "external", "override"]);
  });

  it("carries the prior digest so the chain can be checked from the projection", () => {
    const message = projectionMessageFrom("1315419165", "refs/heads/main", snapshot);
    for (const transition of message.transitions) {
      const prior = message.transitions.find((t) => t.transitionSequence === transition.transitionSequence - 1);
      expect(transition.priorDigest).toBe(prior?.digest ?? null);
    }
  });

  it("attributes each transition to the attempt that produced it, not the live one", () => {
    const message = projectionMessageFrom("1315419165", "refs/heads/main", snapshot);
    expect(message.transitions.map((t) => t.attemptId)).toEqual(["att_one", null, "att_three"]);
    expect(message.transitions.some((t) => t.attemptId === snapshot.activeAttemptId)).toBe(false);
  });

  it("records each transition's own base, not the current one", () => {
    const message = projectionMessageFrom("1315419165", "refs/heads/main", snapshot);
    expect(message.transitions.map((t) => t.baseSha)).toEqual([
      "a".repeat(40),
      "b".repeat(40),
      "c".repeat(40),
    ]);
  });

  it("counts witnesses instead of reporting none", () => {
    const message = projectionMessageFrom("1315419165", "refs/heads/main", snapshot);
    expect(message.transitions.map((t) => t.witnessCount)).toEqual([2, 0, 1]);
  });

  it("passes an unknown observation time through as null rather than inventing one", () => {
    const message = projectionMessageFrom("1315419165", "refs/heads/main", snapshot);
    expect(message.transitions.map((t) => t.observedAt)).toEqual([
      "2026-07-29T00:00:00Z",
      null,
      "2026-07-30T00:00:00Z",
    ]);
  });

  it("carries the object's generation and epoch so a stale message is droppable", () => {
    const message = projectionMessageFrom("1315419165", "refs/heads/main", snapshot);
    expect(message).toMatchObject({ generation: 72, queueEpoch: 2 });
  });
});

describe("project Queue pages", () => {
  it("uses two independent fixed-size page selectors", () => {
    expect(parseQueuePages(undefined, undefined)).toBeUndefined();
    expect(parseQueuePages("2", "4")).toEqual({ entriesPage: 2, transitionsPage: 4, pageSize: 20 });
    expect(parseQueuePages(undefined, "3")).toEqual({ entriesPage: 1, transitionsPage: 3, pageSize: 20 });
    expect(parseQueuePages("0", "1")).toEqual({
      error: "entriesPage and transitionsPage must be positive page numbers",
    });
    expect(parseQueuePages("1.5", "1")).toEqual({
      error: "entriesPage and transitionsPage must be positive page numbers",
    });
  });

  it("pages an authoritative live snapshot without changing its chain head", () => {
    const entries = Array.from({ length: 23 }, (_, index) => ({
      entryId: `entry-${index + 1}`,
      pullRequestNumber: index + 1,
      sponsorPrincipalId: "p1",
      state: index === 0 ? "Merged" : "Ready",
      primaryReason: null,
      schedulerEligible: true,
      fairnessOrdinal: String(index + 1),
      cooldownUntil: null,
      lastAttemptId: `att-${index + 1}`,
      headSha: "a".repeat(40),
    }));
    const transitions = Array.from({ length: 42 }, (_, index) => ({
      transitionSequence: index + 1,
      kind: "verified",
      digest: `sha256:${String(index + 1).padStart(64, "0")}`,
      priorDigest: index === 0 ? null : `sha256:${String(index).padStart(64, "0")}`,
      baseSha: "b".repeat(40),
      attemptId: `att-${index + 1}`,
      witnessPrincipalIds: [],
      recordedAt: null,
    }));
    const page = pageLiveQueue(
      {
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
        chainHead: { sequence: 42, digest: transitions[41]!.digest },
        entries,
        transitions,
      },
      { entriesPage: 2, transitionsPage: 2, pageSize: 20 },
    );

    expect((page["entries"] as unknown[])).toHaveLength(2);
    expect((page["transitions"] as Array<{ transitionSequence: number }>).map((row) => row.transitionSequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => 22 - index),
    );
    expect(page["chainHead"]).toEqual({ sequence: 42, digest: transitions[41]!.digest });
    expect(page["pagination"]).toEqual({
      entries: { page: 2, pageSize: 20, total: 22, totalPages: 2 },
      transitions: { page: 2, pageSize: 20, total: 42, totalPages: 3 },
    });
  });
});
