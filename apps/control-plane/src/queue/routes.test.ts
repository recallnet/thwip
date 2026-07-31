import { describe, expect, it } from "vitest";
import { projectionMessageFrom } from "./routes.js";

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
