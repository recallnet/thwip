import { describe, expect, it } from "vitest";
import { EXIT } from "./queue-exit.js";
import {
  describeDecision,
  nextShipStep,
  planInterrupt,
  reactToReason,
  type ShipState,
} from "./ship.js";

function state(over: Partial<ShipState> = {}): ShipState {
  return {
    authenticated: true,
    workingTreeClean: true,
    headProof: "accepted",
    pushedHeadMatchesLocal: true,
    pullRequestNumber: 42,
    queueEntryExists: true,
    turn: "none",
    options: { wait: true, queue: true, jsonEvents: false },
    ...over,
  };
}

describe("nextShipStep", () => {
  it("refuses to sign a dirty tree", () => {
    // A proof over an uncommitted tree attests to something no reviewer can see.
    const decision = nextShipStep(state({ workingTreeClean: false }));
    expect(decision).toMatchObject({ kind: "stop", reasonCode: "UNCOMMITTED_CHANGES" });
  });

  it("sends the developer to login rather than trying to authenticate for them", () => {
    const decision = nextShipStep(state({ authenticated: false }));
    expect(decision).toMatchObject({ kind: "stop", exitCode: EXIT.authRequired });
    if (decision.kind === "stop") expect(decision.why).toMatch(/your own terminal/);
  });

  it("runs the suites when the head has no proof", () => {
    expect(nextShipStep(state({ headProof: "missing" }))).toMatchObject({ kind: "step", step: "run-suites" });
  });

  it("runs the suites again when the proof is for a different tree", () => {
    const decision = nextShipStep(state({ headProof: "stale" }));
    expect(decision).toMatchObject({ kind: "step", step: "run-suites" });
    if (decision.kind === "step") expect(decision.why).toMatch(/does not match this tree/);
  });

  it("walks the path in order", () => {
    expect(nextShipStep(state({ pushedHeadMatchesLocal: false }))).toMatchObject({ step: "push" });
    expect(nextShipStep(state({ pullRequestNumber: null }))).toMatchObject({ step: "open-or-update-pr" });
    expect(nextShipStep(state({ queueEntryExists: false }))).toMatchObject({ step: "join-queue" });
    expect(nextShipStep(state({ turn: "none" }))).toMatchObject({ step: "await-turn" });
    expect(nextShipStep(state({ turn: "offered" }))).toMatchObject({ step: "execute-turn" });
    expect(nextShipStep(state({ turn: "running" }))).toMatchObject({ step: "execute-turn" });
    expect(nextShipStep(state({ turn: "verified" }))).toMatchObject({ step: "await-merge" });
  });

  it("is deterministic, so an interrupted run resumes where it was", () => {
    const s = state({ turn: "offered" });
    expect(nextShipStep(s)).toEqual(nextShipStep(s));
  });

  describe("terminal outcomes", () => {
    it("stops at a pushed proof with --no-queue", () => {
      expect(
        nextShipStep(state({ options: { wait: true, queue: false, jsonEvents: false } })),
      ).toEqual({ kind: "done", outcome: "PR_UPDATED", exitCode: EXIT.ok });
    });

    it("stops after requesting a turn without --wait", () => {
      expect(
        nextShipStep(state({ options: { wait: false, queue: true, jsonEvents: false } })),
      ).toEqual({ kind: "done", outcome: "QUEUE_REQUESTED", exitCode: EXIT.ok });
    });

    it("only reports a merge when the merge actually confirmed", () => {
      expect(nextShipStep(state({ turn: "merged" }))).toEqual({
        kind: "done",
        outcome: "MERGE_CONFIRMED",
        exitCode: EXIT.ok,
      });
      for (const turn of ["none", "offered", "claimed", "running", "verified", "merging"] as const) {
        const decision = nextShipStep(state({ turn }));
        expect(decision.kind === "done" && decision.outcome).not.toBe("MERGE_CONFIRMED");
      }
    });

    it("does not skip the queue just because a proof exists", () => {
      const decision = nextShipStep(state({ queueEntryExists: false }));
      expect(decision).toMatchObject({ step: "join-queue" });
    });
  });
});

describe("reactToReason", () => {
  it("keeps waiting when a turn is lost, because the place is not", () => {
    for (const reason of ["EXPIRED_UNCLAIMED", "EXPIRED_EXECUTION", "SUPERSEDED", "COOLDOWN_ACTIVE", "AGENT_OFFLINE"]) {
      expect(reactToReason(reason, { wait: true }), reason).toMatchObject({ kind: "keep-waiting" });
    }
  });

  it("stops on a lost turn when not waiting, so a script does not hang", () => {
    expect(reactToReason("EXPIRED_UNCLAIMED", { wait: false })).toMatchObject({
      kind: "stop",
      exitCode: EXIT.turnLost,
    });
  });

  it("never keeps waiting on something a person has to fix", () => {
    for (const reason of ["REVIEW_REQUIRED", "CONVERSATION_UNRESOLVED", "MERGE_CONFLICT", "PR_DRAFT"]) {
      expect(reactToReason(reason, { wait: true }), reason).toMatchObject({ kind: "stop" });
    }
  });

  it("never keeps waiting on a changed source", () => {
    for (const reason of ["HEAD_MOVED", "BASE_MOVED", "POLICY_CHANGED", "SUBJECT_TREE_MISMATCH"]) {
      expect(reactToReason(reason, { wait: true }), reason).toMatchObject({ kind: "stop" });
    }
  });

  it("never keeps waiting on an ambiguous merge", () => {
    const reaction = reactToReason("MERGE_OUTCOME_UNKNOWN", { wait: true });
    expect(reaction).toMatchObject({ kind: "stop", exitCode: EXIT.ambiguous });
    if (reaction.kind === "stop") expect(reaction.why).toMatch(/will not write again/);
  });

  it("never keeps waiting on an invariant failure", () => {
    expect(reactToReason("INVARIANT_FAILURE", { wait: true })).toMatchObject({
      kind: "stop",
      exitCode: EXIT.invariant,
    });
  });

  it("stops on a rate limit rather than hammering the provider", () => {
    expect(reactToReason("RATE_LIMITED", { wait: true })).toMatchObject({
      kind: "stop",
      exitCode: EXIT.rateLimited,
    });
  });

  it("explains a repair in terms of the command to run next", () => {
    const reaction = reactToReason("NEEDS_REPAIR", { wait: true });
    if (reaction.kind !== "stop") throw new Error("expected a stop");
    expect(reaction.why).toMatch(/thwip ship --wait/);
  });

  it("treats an unknown reason as needing a human, never as waitable", () => {
    expect(reactToReason("SOMETHING_NEW", { wait: true })).toMatchObject({
      kind: "stop",
      exitCode: EXIT.invariant,
    });
  });
});

describe("planInterrupt", () => {
  it("keeps the queue entry when nothing is in flight", () => {
    const plan = planInterrupt(state({ turn: "none" }));
    expect(plan).toMatchObject({ outcome: "WATCHING_DETACHED", exitCode: EXIT.interrupted, releaseTurn: false });
    expect(plan.message).toMatch(/still queued/);
  });

  it("releases a held lane so the branch is not blocked until a deadline", () => {
    for (const turn of ["claimed", "running", "verified"] as const) {
      const plan = planInterrupt(state({ turn }));
      expect(plan.releaseTurn, turn).toBe(true);
      expect(plan.message).toMatch(/place in line is kept/);
    }
  });

  it("never interrupts across a merge write", () => {
    // Walking away mid-write is what creates an ambiguous outcome.
    for (const turn of ["merging", "merged"] as const) {
      const plan = planInterrupt(state({ turn }));
      expect(plan.releaseTurn, turn).toBe(false);
      expect(plan.message).toMatch(/leaving it to finish/);
    }
  });

  it("always exits 130, whatever was happening", () => {
    for (const turn of ["none", "offered", "claimed", "running", "verified", "merging", "merged"] as const) {
      expect(planInterrupt(state({ turn })).exitCode).toBe(EXIT.interrupted);
    }
  });

  it("never reports an interrupt as a queue request being lost", () => {
    const plan = planInterrupt(state({ turn: "offered", queueEntryExists: true }));
    expect(plan.message).not.toMatch(/cancel|remove|lost/i);
  });
});

describe("describeDecision", () => {
  it("renders each decision shape as one line", () => {
    expect(describeDecision({ kind: "step", step: "push", why: "remote is behind" })).toBe(
      "push: remote is behind",
    );
    expect(describeDecision({ kind: "done", outcome: "MERGE_CONFIRMED", exitCode: EXIT.ok })).toBe(
      "MERGE_CONFIRMED",
    );
    expect(
      describeDecision({ kind: "stop", reasonCode: "REVIEW_REQUIRED", exitCode: EXIT.humanRequired, why: "ask" }),
    ).toBe("REVIEW_REQUIRED: ask");
  });
});
