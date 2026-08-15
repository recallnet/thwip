import { describe, expect, it } from "vitest";
import { applyEvent, emptyState, type BranchQueueState } from "./reducer.js";
import { applyEvents } from "./test/apply-events.js";
import { checkInvariants } from "./invariants.js";
import type { QueueEvent } from "./events.js";

let seq = 0;
function ev<T extends Omit<QueueEvent, "sequence" | "idempotencyKey" | "at">>(
  body: T,
  key?: string,
): QueueEvent {
  seq += 1;
  return {
    sequence: seq,
    idempotencyKey: key ?? `k${seq}`,
    at: new Date(Date.UTC(2026, 6, 29, 12, 0, seq)).toISOString(),
    ...body,
  } as QueueEvent;
}

function base(): BranchQueueState {
  return emptyState("qk", "1315419165", "refs/heads/main");
}

/** A full happy path for one entry, ending merged and recorded. */
function happyPath(entryId = "e1", principal = "alice", attemptId = "a1"): QueueEvent[] {
  return [
    ev({
      type: "QueueRequested",
      entryId,
      pullRequestNumber: 7,
      sponsorPrincipalId: principal,
      sponsorGithubUserId: "264261678",
      headSha: "h".repeat(40),
    }),
    ev({
      type: "ReadinessEvaluated",
      entryId,
      ready: true,
      schedulerEligible: true,
      primaryReason: null,
      secondaryReasons: [],
    }),
    ev({
      type: "TurnOffered",
      entryId,
      attemptId,
      offerDeadline: "2026-07-29T12:01:30.000Z",
      decisionDigest: "sha256:dec",
    }),
    ev({ type: "OfferClaimed", attemptId, executionMode: "device", deviceId: "d1" }),
    ev({
      type: "CandidatePrepared",
      attemptId,
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
      candidateSha: "c".repeat(40),
      candidateTree: "t".repeat(40),
      policyDigest: "sha256:pol",
      runner: "dagger",
    }),
    ev({
      type: "AssignmentIssued",
      attemptId,
      assignmentDigest: "sha256:asg",
      executionDeadline: "2026-07-29T12:20:00.000Z",
    }),
    ev({ type: "HeartbeatReceived", attemptId }),
    ev({ type: "ReceiptSubmitted", attemptId, receiptDigest: "sha256:rcpt" }),
    ev({ type: "VerificationStarted", attemptId, nonce: "n1" }),
    ev({
      type: "VerificationCompleted",
      attemptId,
      nonce: "n1",
      accepted: true,
      resultDigest: "sha256:res",
    }),
    ev({ type: "MergeIntentCreated", attemptId, intentDigest: "sha256:intent" }),
    ev({ type: "MergeRequested", attemptId }),
    ev({
      type: "MergeConfirmed",
      attemptId,
      mergeSha: "m".repeat(40),
      mergeTree: "t".repeat(40),
      parentShas: ["b".repeat(40), "h".repeat(40)],
    }),
    ev({
      type: "TransitionRecorded",
      kind: "verified",
      transitionSequence: 1,
      priorDigest: null,
      digest: `sha256:${"a".repeat(64)}`,
      baseSha: "m".repeat(40),
      attemptId,
      witnessPrincipalIds: [principal],
    }),
  ];
}

describe("reducer", () => {
  it("records a request as Requested with a fresh fairness ordinal", () => {
    const state = applyEvents(base(), happyPath().slice(0, 1));
    const entry = state.entries.get("e1")!;
    expect(entry.state).toBe("Requested");
    expect(entry.fairnessOrdinal).toBe(1n);
    expect(state.ordinalSequence).toBe(1n);
  });

  it("walks the happy path to Merged with no invariant violations", () => {
    const state = applyEvents(base(), happyPath());
    expect(state.entries.get("e1")!.state).toBe("Merged");
    expect(state.attempts.get("a1")!.phase).toBe("MERGED");
    expect(state.activeAttemptId).toBeNull();
    expect(state.transitions).toHaveLength(1);
    expect(checkInvariants(state)).toEqual([]);
  });

  it("is idempotent: replaying the whole log changes nothing", () => {
    const events = happyPath();
    const once = applyEvents(base(), events);
    const twice = applyEvents(once, events);
    expect(serialize(twice)).toEqual(serialize(once));
  });

  it("ignores a duplicated idempotency key even with a new sequence", () => {
    const first = ev(
      {
        type: "QueueRequested",
        entryId: "e1",
        pullRequestNumber: 7,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "1",
        headSha: "h".repeat(40),
      },
      "same-key",
    );
    const replay = { ...first, sequence: first.sequence + 50 };
    const state = applyEvents(base(), [first, replay]);
    expect(state.entries.size).toBe(1);
    expect(state.ordinalSequence).toBe(1n);
  });

  it("ignores an out-of-order event whose sequence was already consumed", () => {
    const events = happyPath();
    const state = applyEvents(base(), events);
    const stale = { ...events[3]!, idempotencyKey: "fresh-key", sequence: 2 };
    expect(serialize(applyEvent(state, stale))).toEqual(serialize(state));
  });

  it("fails closed on an unknown event type", () => {
    const bogus = ev({ type: "SomethingNew" } as never);
    expect(() => applyEvent(base(), bogus)).toThrow(/unknown queue event/i);
  });

  it("fails closed on an unknown blocking reason", () => {
    const state = applyEvents(base(), happyPath().slice(0, 1));
    const bad = ev({
      type: "ReadinessEvaluated",
      entryId: "e1",
      ready: false,
      schedulerEligible: false,
      primaryReason: "NOT_A_REAL_REASON" as never,
      secondaryReasons: [],
    });
    expect(() => applyEvent(state, bad)).toThrow(/unknown blocking reason/i);
  });

  it("fails closed on an unknown attempt outcome", () => {
    const state = applyEvents(base(), happyPath().slice(0, 4));
    const bad = ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "NOPE" as never });
    expect(() => applyEvent(state, bad)).toThrow(/unknown attempt outcome/i);
  });

  describe("one active lane (§6.2 invariant 1)", () => {
    it("refuses a second offer while an attempt is live", () => {
      const state = applyEvents(base(), [
        ...happyPath().slice(0, 4),
        ev({
          type: "QueueRequested",
          entryId: "e2",
          pullRequestNumber: 8,
          sponsorPrincipalId: "bob",
          sponsorGithubUserId: "2",
          headSha: "j".repeat(40),
        }),
      ]);
      const second = ev({
        type: "TurnOffered",
        entryId: "e2",
        attemptId: "a2",
        offerDeadline: "2026-07-29T12:05:00.000Z",
        decisionDigest: "sha256:dec2",
      });
      expect(() => applyEvent(state, second)).toThrow(/lane is occupied/i);
    });

    it("frees the lane when the attempt terminates", () => {
      let state = applyEvents(base(), happyPath().slice(0, 4));
      expect(state.activeAttemptId).toBe("a1");
      state = applyEvent(
        state,
        ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "EXPIRED_EXECUTION" }),
      );
      expect(state.activeAttemptId).toBeNull();
      expect(checkInvariants(state)).toEqual([]);
    });
  });

  describe("fairness ordinal survives failure (§6.2 invariant 4, §8.4)", () => {
    it("keeps the ordinal when an offer expires unclaimed", () => {
      let state = applyEvents(base(), happyPath().slice(0, 3));
      const ordinal = state.entries.get("e1")!.fairnessOrdinal;
      state = applyEvent(
        state,
        ev({ type: "OfferExpired", attemptId: "a1", cooldownUntil: "2026-07-29T12:06:00.000Z" }),
      );
      const entry = state.entries.get("e1")!;
      expect(entry.fairnessOrdinal).toBe(ordinal);
      expect(entry.state).toBe("Deferred");
      expect(entry.cooldownUntil).toBe("2026-07-29T12:06:00.000Z");
      expect(state.attempts.get("a1")!.outcome).toBe("EXPIRED_UNCLAIMED");
    });

    it("returns a deferred entry to Ready once its cooldown elapses (§9.3)", () => {
      let state = applyEvents(base(), happyPath().slice(0, 3));
      const ordinal = state.entries.get("e1")!.fairnessOrdinal;
      state = applyEvent(
        state,
        ev({ type: "OfferExpired", attemptId: "a1", cooldownUntil: "2026-07-29T13:00:00.000Z" }),
      );
      expect(state.entries.get("e1")!.state).toBe("Deferred");

      // Still cooling down: readiness alone does not restore eligibility.
      state = applyEvent(state, {
        sequence: 900,
        idempotencyKey: "early",
        at: "2026-07-29T12:30:00.000Z",
        type: "ReadinessEvaluated",
        entryId: "e1",
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
        secondaryReasons: [],
      });
      expect(state.entries.get("e1")!.state).toBe("Deferred");

      state = applyEvent(state, {
        sequence: 901,
        idempotencyKey: "after-cooldown",
        at: "2026-07-29T13:00:01.000Z",
        type: "ReadinessEvaluated",
        entryId: "e1",
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
        secondaryReasons: [],
      });
      const entry = state.entries.get("e1")!;
      expect(entry.state).toBe("Ready");
      expect(entry.cooldownUntil).toBeNull();
      expect(entry.fairnessOrdinal).toBe(ordinal);
    });

    it("keeps the ordinal across an ordinary head repair", () => {
      let state = applyEvents(base(), happyPath().slice(0, 2));
      const ordinal = state.entries.get("e1")!.fairnessOrdinal;
      state = applyEvent(state, ev({ type: "EntryHeadChanged", entryId: "e1", headSha: "z".repeat(40) }));
      expect(state.entries.get("e1")!.fairnessOrdinal).toBe(ordinal);
    });

    it("issues a new ordinal on an audited reset", () => {
      let state = applyEvents(base(), [...happyPath().slice(0, 2)]);
      state = applyEvent(
        state,
        ev({
          type: "QueueRequested",
          entryId: "e2",
          pullRequestNumber: 8,
          sponsorPrincipalId: "bob",
          sponsorGithubUserId: "2",
          headSha: "j".repeat(40),
        }),
      );
      state = applyEvent(
        state,
        ev({
          type: "EntryOrdinalReset",
          entryId: "e1",
          actorPrincipalId: "admin",
          reason: "force-push replaced the branch",
        }),
      );
      expect(state.entries.get("e1")!.fairnessOrdinal).toBeGreaterThan(
        state.entries.get("e2")!.fairnessOrdinal,
      );
    });

    it("does not import the old sponsor's priority on transfer (§6.2 invariant 9)", () => {
      let state = applyEvents(base(), happyPath().slice(0, 2));
      const before = state.entries.get("e1")!.fairnessOrdinal;
      state = applyEvent(
        state,
        ev({
          type: "SponsorTransferred",
          entryId: "e1",
          toPrincipalId: "bob",
          toGithubUserId: "2",
          actorPrincipalId: "admin",
          reason: "alice left the team",
        }),
      );
      const entry = state.entries.get("e1")!;
      expect(entry.sponsorPrincipalId).toBe("bob");
      expect(entry.fairnessOrdinal).toBeGreaterThan(before);
    });
  });

  describe("turn accounting (§8.2)", () => {
    it("increments the turn sequence and stamps the principal on every offer", () => {
      const state = applyEvents(base(), happyPath().slice(0, 3));
      expect(state.turnSequence).toBe(1n);
      expect(state.lastServedTurn.get("alice")).toBe(1n);
    });

    it("charges an expedited turn to the principal like any other (§8.4)", () => {
      let state = applyEvents(base(), happyPath().slice(0, 2));
      state = applyEvent(
        state,
        ev({
          type: "TurnOffered",
          entryId: "e1",
          attemptId: "a1",
          offerDeadline: "2026-07-29T12:01:30.000Z",
          decisionDigest: "sha256:dec",
          expedite: { actorPrincipalId: "admin", reason: "release blocker", capturedPrincipalIds: ["bob"] },
        }),
      );
      expect(state.lastServedTurn.get("alice")).toBe(state.turnSequence);
      expect(state.fairnessDebt.get("alice")).toEqual(["bob"]);
    });
  });

  describe("attempt immutability (§6.2 invariant 5, 6)", () => {
    it("never mutates a terminated attempt when a retry begins", () => {
      let state = applyEvents(base(), happyPath().slice(0, 6));
      const frozen = structuredClone(state.attempts.get("a1")!);
      state = applyEvent(state, ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "CI_FAILED" }));
      state = applyEvent(
        state,
        ev({
          type: "TurnOffered",
          entryId: "e1",
          attemptId: "a2",
          offerDeadline: "2026-07-29T12:30:00.000Z",
          decisionDigest: "sha256:dec2",
          parentAttemptId: "a1",
        } as never),
      );
      const after = state.attempts.get("a1")!;
      expect(after.baseSha).toBe(frozen.baseSha);
      expect(after.candidateTree).toBe(frozen.candidateTree);
      expect(after.assignmentDigest).toBe(frozen.assignmentDigest);
      expect(after.phase).toBe(frozen.phase);
    });

    it("rejects a candidate rewrite on an existing attempt", () => {
      const state = applyEvents(base(), happyPath().slice(0, 5));
      const rewrite = ev({
        type: "CandidatePrepared",
        attemptId: "a1",
        baseSha: "9".repeat(40),
        headSha: "h".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTree: "t".repeat(40),
        policyDigest: "sha256:pol",
        runner: "dagger",
      });
      expect(() => applyEvent(state, rewrite)).toThrow(/immutable/i);
    });

    it("treats a redelivered claim as a no-op rather than a second share", () => {
      const state = applyEvents(base(), happyPath().slice(0, 8));
      const again = ev({ type: "OfferClaimed", attemptId: "a1", executionMode: "device", deviceId: "d1" });
      expect(applyEvent(state, again).attempts.get("a1")!.deviceId).toBe("d1");
    });

    it("refuses a claim from a second device rather than letting it believe it won", () => {
      const state = applyEvents(base(), happyPath().slice(0, 8));
      const other = ev({ type: "OfferClaimed", attemptId: "a1", executionMode: "device", deviceId: "d2" });
      expect(() => applyEvent(state, other)).toThrow(/OFFER_ALREADY_CLAIMED/);
    });

    it("ignores a heartbeat that lands after the receipt", () => {
      const state = applyEvents(base(), happyPath().slice(0, 9));
      const late = ev({ type: "HeartbeatReceived", attemptId: "a1" });
      expect(applyEvent(state, late).attempts.get("a1")!.phase).toBe("VERIFYING");
    });

    it("treats a merged attempt as terminal", () => {
      const state = applyEvents(base(), happyPath());
      expect(() => applyEvent(state, ev({ type: "MergeRequested", attemptId: "a1" }))).toThrow(
        /terminated \(MERGED\)/,
      );
    });
  });

  describe("merge guards", () => {
    it("refuses a merge intent before verification accepted (§6.2 invariant 13)", () => {
      const state = applyEvents(base(), happyPath().slice(0, 9));
      const early = ev({ type: "MergeIntentCreated", attemptId: "a1", intentDigest: "sha256:intent" });
      expect(() => applyEvent(state, early)).toThrow(/not verified/i);
    });

    it("refuses a merge intent when verification was rejected", () => {
      let state = applyEvents(base(), happyPath().slice(0, 9));
      state = applyEvent(
        state,
        ev({
          type: "VerificationCompleted",
          attemptId: "a1",
          nonce: "n1",
          accepted: false,
          resultDigest: "sha256:res",
        }),
      );
      expect(state.attempts.get("a1")!.outcome).toBe("VERIFICATION_FAILED");
      const early = ev({ type: "MergeIntentCreated", attemptId: "a1", intentDigest: "sha256:i" });
      expect(() => applyEvent(state, early)).toThrow(/terminated/i);
    });

    it("rejects a verifier result whose nonce does not match (§6.2 invariant 15)", () => {
      const state = applyEvents(base(), happyPath().slice(0, 9));
      const wrong = ev({
        type: "VerificationCompleted",
        attemptId: "a1",
        nonce: "not-n1",
        accepted: true,
        resultDigest: "sha256:res",
      });
      expect(() => applyEvent(state, wrong)).toThrow(/nonce/i);
    });

    it("never writes twice while the merge outcome is unknown (§6.2 invariant 17)", () => {
      let state = applyEvents(base(), happyPath().slice(0, 12));
      state = applyEvent(state, ev({ type: "MergeOutcomeUnknown", attemptId: "a1" }));
      expect(state.entries.get("e1")!.state).toBe("Reconciling");
      expect(() => applyEvent(state, ev({ type: "MergeRequested", attemptId: "a1" }))).toThrow(
        /outcome is unknown/i,
      );
      expect(checkInvariants(state)).toEqual([]);
    });

    it("resolves an unknown outcome to a confirmed non-merge", () => {
      let state = applyEvents(base(), happyPath().slice(0, 12));
      state = applyEvent(state, ev({ type: "MergeOutcomeUnknown", attemptId: "a1" }));
      state = applyEvent(
        state,
        ev({ type: "MergeConfirmedNotMerged", attemptId: "a1", cooldownUntil: "2026-07-29T12:30:00Z" }),
      );
      expect(state.attempts.get("a1")!.outcome).toBe("CONFIRMED_NOT_MERGED");
      // Deferred rather than Ready: whatever refused this merge is usually still
      // true a second later, so handing the lane straight back would let the queue
      // refuse the same merge over and over while everything behind it waited. The
      // place in line is kept.
      expect(state.entries.get("e1")!.state).toBe("Deferred");
      expect(state.entries.get("e1")!.cooldownUntil).toBe("2026-07-29T12:30:00Z");
      expect(state.activeAttemptId).toBeNull();
    });

    it("still records a merge that landed while the queue was paused", () => {
      // The pause refuses the writes the queue controls and never refuses the
      // news. Refusing a confirmation would leave the log denying a merge that
      // exists on GitHub, and an attempt in Merging that nothing could resolve.
      let state = applyEvents(base(), happyPath().slice(0, 12));
      state = applyEvent(state, ev({ type: "QueuePaused", actorPrincipalId: "admin", reason: "incident" }));
      state = applyEvent(
        state,
        ev({
          type: "MergeConfirmed",
          attemptId: "a1",
          mergeSha: "m".repeat(40),
          mergeTree: "t".repeat(40),
          parentShas: ["b".repeat(40), "h".repeat(40)],
        }),
      );
      expect(state.entries.get("e1")!.state).toBe("Merged");
      expect(state.activeAttemptId).toBeNull();
      expect(checkInvariants(state)).toEqual([]);
    });

    it("refuses to confirm a merge whose tree is not the candidate tree (§6.2 invariant 18)", () => {
      const state = applyEvents(base(), happyPath().slice(0, 12));
      const wrongTree = ev({
        type: "MergeConfirmed",
        attemptId: "a1",
        mergeSha: "m".repeat(40),
        mergeTree: "0".repeat(40),
        parentShas: ["b".repeat(40), "h".repeat(40)],
      });
      expect(() => applyEvent(state, wrongTree)).toThrow(/candidate tree/i);
    });

    it("refuses to confirm a merge whose first parent is not the base the attempt pinned", () => {
      // The base moved between the pin and the merge. GitHub merged the head onto the tip the
      // branch actually had, and the commit that landed hangs off a parent no
      // intent names. A record cites the exact parents, so confirming that
      // commit as this attempt's merge writes a state no chain can follow.
      const state = applyEvents(base(), happyPath().slice(0, 12));
      const movedBase = ev({
        type: "MergeConfirmed",
        attemptId: "a1",
        mergeSha: "m".repeat(40),
        mergeTree: "t".repeat(40),
        parentShas: ["d".repeat(40), "h".repeat(40)],
      });
      expect(() => applyEvent(state, movedBase)).toThrow(/first parent/i);
    });
  });

  describe("transition chain (§6.2 invariant 19, 20)", () => {
    it("rejects a non-consecutive transition sequence", () => {
      const state = applyEvents(base(), happyPath().slice(0, 13));
      const skipped = ev({
        type: "TransitionRecorded",
        kind: "verified",
        transitionSequence: 2,
        priorDigest: null,
        digest: `sha256:${"b".repeat(64)}`,
        baseSha: "m".repeat(40),
        attemptId: "a1",
        witnessPrincipalIds: ["alice"],
      });
      expect(() => applyEvent(state, skipped)).toThrow(/consecutive/i);
    });

    it("rejects a transition that does not link the prior digest", () => {
      let state = applyEvents(base(), happyPath());
      state = applyEvents(state, happyPath("e2", "bob", "a9").slice(0, 13));
      const unlinked = ev({
        type: "TransitionRecorded",
        kind: "verified",
        transitionSequence: 2,
        priorDigest: `sha256:${"e".repeat(64)}`,
        digest: `sha256:${"c".repeat(64)}`,
        baseSha: "n".repeat(40),
        attemptId: "a9",
        witnessPrincipalIds: ["bob"],
      });
      expect(() => applyEvent(state, unlinked)).toThrow(/prior digest/i);
    });

    it("rejects a digest that is not sha256 and sixty four hex digits", () => {
      // What an older queue wrote for a base it saw move. The protocol reads a
      // chain head as `sha256:`, so every assignment the branch signed after one
      // of these came back ASSIGNMENT_INVALID.
      const state = applyEvents(base(), happyPath().slice(0, 13));
      const notADigest = ev({
        type: "TransitionRecorded",
        kind: "external",
        transitionSequence: 2,
        priorDigest: `sha256:${"1".repeat(64)}`,
        digest: `external:${"d".repeat(40)}`,
        baseSha: "d".repeat(40),
        attemptId: null,
        witnessPrincipalIds: [],
      });
      expect(() => applyEvent(state, notADigest)).toThrow(/sixty four hex digits/i);
    });

    it("rejects a commit sha padded out to digest width", () => {
      // Record 121 on this repository's own chain. The reconcile route took the
      // commit an operator named, padded it with zeroes and called it a record
      // digest. Nothing hashes to it, so the chain route served no link there,
      // and the record after it named a predecessor no reader could fetch.
      const state = applyEvents(base(), happyPath().slice(0, 13));
      const padded = ev({
        type: "TransitionRecorded",
        kind: "external",
        transitionSequence: 2,
        priorDigest: `sha256:${"1".repeat(64)}`,
        digest: `sha256:7cf3967bd5751cea12d2f91368b57454b0d6e5ba${"0".repeat(24)}`,
        baseSha: "7cf3967bd5751cea12d2f91368b57454b0d6e5ba",
        attemptId: null,
        witnessPrincipalIds: [],
      });
      expect(() => applyEvent(state, padded)).toThrow(/commit sha padded/i);
    });

    it("refuses to chain a failed attempt", () => {
      let state = applyEvents(base(), happyPath().slice(0, 6));
      state = applyEvent(state, ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "CI_FAILED" }));
      const bad = ev({
        type: "TransitionRecorded",
        kind: "verified",
        transitionSequence: 1,
        priorDigest: null,
        digest: `sha256:${"b".repeat(64)}`,
        baseSha: "m".repeat(40),
        attemptId: "a1",
        witnessPrincipalIds: ["alice"],
      });
      expect(() => applyEvent(state, bad)).toThrow(/did not merge/i);
    });
  });

  describe("external movement (§6.2 invariant 21)", () => {
    it("pauses the queue and records the external base", () => {
      let state = applyEvents(base(), happyPath());
      const chain = state.transitions.length;
      state = applyEvent(state, ev({ type: "ExternalTransitionObserved", observedBaseSha: "x".repeat(40) }));
      expect(state.paused).toBe(true);
      expect(state.pauseReason).toBe("EXTERNAL_TRANSITION");
      expect(state.baseSha).toBe("x".repeat(40));
      // The chain is not extended: nothing signed this, and the queue names its
      // chain head in every assignment and merge intent it goes on to sign.
      expect(state.transitions).toHaveLength(chain);
      expect(checkInvariants(state)).toEqual([]);
    });

    it("refuses to offer a turn while paused", () => {
      let state = applyEvents(base(), happyPath("e1", "alice").slice(0, 2));
      state = applyEvent(state, ev({ type: "QueuePaused", actorPrincipalId: "admin", reason: "incident" }));
      const offer = ev({
        type: "TurnOffered",
        entryId: "e1",
        attemptId: "a1",
        offerDeadline: "2026-07-29T12:02:00.000Z",
        decisionDigest: "sha256:dec",
      });
      expect(() => applyEvent(state, offer)).toThrow(/paused/i);
    });

    it("requires a rebaseline before resuming after external movement", () => {
      let state = applyEvents(base(), happyPath());
      state = applyEvent(state, ev({ type: "ExternalTransitionObserved", observedBaseSha: "x".repeat(40) }));
      expect(() => applyEvent(state, ev({ type: "QueueResumed", actorPrincipalId: "admin" }))).toThrow(
        /rebaseline/i,
      );
      state = applyEvent(
        state,
        ev({
          type: "Rebaselined",
          actorPrincipalId: "admin",
          baseSha: "x".repeat(40),
          reason: "inspected the commit and accepted it",
        }),
      );
      state = applyEvent(state, ev({ type: "QueueResumed", actorPrincipalId: "admin" }));
      expect(state.paused).toBe(false);
    });
  });

  describe("liveness (§9.2)", () => {
    it("holds the lane through reconnect grace", () => {
      let state = applyEvents(base(), happyPath().slice(0, 7));
      state = applyEvent(
        state,
        ev({ type: "HeartbeatLost", attemptId: "a1", graceUntil: "2026-07-29T12:03:00.000Z" }),
      );
      expect(state.entries.get("e1")!.state).toBe("ReconnectGrace");
      expect(state.activeAttemptId).toBe("a1");
      state = applyEvent(state, ev({ type: "Reconnected", attemptId: "a1", deviceId: "d1" }));
      expect(state.entries.get("e1")!.state).toBe("Active");
    });

    it("refuses a reconnect from a different device", () => {
      let state = applyEvents(base(), happyPath().slice(0, 7));
      state = applyEvent(
        state,
        ev({ type: "HeartbeatLost", attemptId: "a1", graceUntil: "2026-07-29T12:03:00.000Z" }),
      );
      expect(() => applyEvent(state, ev({ type: "Reconnected", attemptId: "a1", deviceId: "other" }))).toThrow(
        /device/i,
      );
    });

    it("supersedes the attempt and defers the entry when grace expires", () => {
      let state = applyEvents(base(), happyPath().slice(0, 7));
      const ordinal = state.entries.get("e1")!.fairnessOrdinal;
      state = applyEvent(
        state,
        ev({ type: "HeartbeatLost", attemptId: "a1", graceUntil: "2026-07-29T12:03:00.000Z" }),
      );
      state = applyEvent(state, ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "SUPERSEDED" }));
      const entry = state.entries.get("e1")!;
      expect(entry.state).toBe("Deferred");
      expect(entry.fairnessOrdinal).toBe(ordinal);
      expect(state.activeAttemptId).toBeNull();
    });

    it("rejects a receipt for an attempt already superseded (§9.2)", () => {
      let state = applyEvents(base(), happyPath().slice(0, 7));
      state = applyEvent(state, ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "SUPERSEDED" }));
      expect(() =>
        applyEvent(state, ev({ type: "ReceiptSubmitted", attemptId: "a1", receiptDigest: "sha256:r" })),
      ).toThrow(/terminated/i);
    });
  });

  describe("synthetic claims (§8.2)", () => {
    it("lets the server claim its own offer for fast reuse", () => {
      let state = applyEvents(base(), happyPath().slice(0, 3));
      state = applyEvent(state, ev({ type: "OfferClaimed", attemptId: "a1", executionMode: "fast-reuse" }));
      const attempt = state.attempts.get("a1")!;
      expect(attempt.executionMode).toBe("fast-reuse");
      expect(attempt.deviceId).toBeNull();
      expect(state.entries.get("e1")!.state).toBe("Active");
    });

    /**
     * A reuse attempt is never assigned to anyone. The queue dispatches no
     * runner and issues no assignment, so demanding one before the receipt
     * forced the caller to invent a digest and put it in the state — which is
     * how `sha256:1111…` reached a record that reads as evidence.
     */
    it("takes a receipt for a reuse attempt that was never assigned", () => {
      let state = applyEvents(base(), happyPath().slice(0, 3));
      state = applyEvent(state, ev({ type: "OfferClaimed", attemptId: "a1", executionMode: "fast-reuse" }));
      state = applyEvent(
        state,
        ev({
          type: "CandidatePrepared",
          attemptId: "a1",
          baseSha: "b".repeat(40),
          headSha: "h".repeat(40),
          candidateSha: "c".repeat(40),
          candidateTree: "t".repeat(40),
          policyDigest: "sha256:pol",
          runner: "reuse",
        }),
      );
      state = applyEvent(state, ev({ type: "ReceiptSubmitted", attemptId: "a1", receiptDigest: "sha256:rcpt" }));
      const attempt = state.attempts.get("a1")!;
      expect(attempt.receiptDigest).toBe("sha256:rcpt");
      // Absent, rather than filled in with something that names nothing.
      expect(attempt.assignmentDigest).toBeNull();
    });

    /**
     * The gate still has to hold where an assignment is real. A device attempt
     * runs because the queue told it to, and a receipt arriving before that
     * instruction means the two are not about the same work.
     */
    it("still refuses a receipt for a device attempt with no assignment", () => {
      let state = applyEvents(base(), happyPath().slice(0, 4));
      expect(() =>
        applyEvent(state, ev({ type: "ReceiptSubmitted", attemptId: "a1", receiptDigest: "sha256:rcpt" })),
      ).toThrow(/assignment/i);
    });

    /**
     * Under reuse nothing ran, so there is no verifier result to name. The walk
     * used to pass `sha256:3333…` here and the attempt stored it as though a
     * verifier had spoken.
     */
    it("accepts a reuse attempt with no verifier result", () => {
      let state = applyEvents(base(), happyPath().slice(0, 3));
      state = applyEvent(state, ev({ type: "OfferClaimed", attemptId: "a1", executionMode: "fast-reuse" }));
      state = applyEvent(
        state,
        ev({
          type: "CandidatePrepared",
          attemptId: "a1",
          baseSha: "b".repeat(40),
          headSha: "h".repeat(40),
          candidateSha: "c".repeat(40),
          candidateTree: "t".repeat(40),
          policyDigest: "sha256:pol",
          runner: "reuse",
        }),
      );
      state = applyEvent(state, ev({ type: "ReceiptSubmitted", attemptId: "a1", receiptDigest: "sha256:rcpt" }));
      state = applyEvent(state, ev({ type: "VerificationStarted", attemptId: "a1", nonce: "n1" }));
      state = applyEvent(
        state,
        ev({ type: "VerificationCompleted", attemptId: "a1", nonce: "n1", accepted: true, resultDigest: null }),
      );
      const attempt = state.attempts.get("a1")!;
      expect(attempt.phase).toBe("VERIFIED");
      expect(attempt.verifierResultDigest).toBeNull();
    });

    /** The other half: where a verifier did run, its result is the acceptance. */
    it("refuses to accept a device attempt with no verifier result", () => {
      const state = applyEvents(base(), happyPath().slice(0, 9));
      expect(() =>
        applyEvent(
          state,
          ev({ type: "VerificationCompleted", attemptId: "a1", nonce: "n1", accepted: true, resultDigest: null }),
        ),
      ).toThrow(/result/i);
    });

    it("requires a device id for a device claim", () => {
      const state = applyEvents(base(), happyPath().slice(0, 3));
      expect(() => applyEvent(state, ev({ type: "OfferClaimed", attemptId: "a1", executionMode: "device" }))).toThrow(
        /device id/i,
      );
    });
  });

  it("keeps the attempt DAG acyclic and single-parented", () => {
    let state = applyEvents(base(), happyPath().slice(0, 6));
    state = applyEvent(state, ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "CI_FAILED" }));
    state = applyEvent(
      state,
      ev({
        type: "TurnOffered",
        entryId: "e1",
        attemptId: "a2",
        offerDeadline: "2026-07-29T12:30:00.000Z",
        decisionDigest: "sha256:dec2",
      }),
    );
    expect(state.attempts.get("a2")!.parentAttemptId).toBe("a1");
    expect(state.attempts.get("a1")!.parentAttemptId).toBeNull();
    expect(checkInvariants(state)).toEqual([]);
  });
});

/** Structural comparison that copes with bigint and Map. */
function serialize(state: BranchQueueState): string {
  return JSON.stringify(state, (_key, value) => {
    if (typeof value === "bigint") return `${value}n`;
    if (value instanceof Map) return [...value.entries()].sort();
    if (value instanceof Set) return [...value].sort();
    return value;
  });
}

/**
 * A blocked entry that cannot say why is worse than a wrong answer: every reader
 * — the dashboard, `thwip queue explain`, the D1 projection — renders a null
 * reason as though nothing were wrong. A live queue held a merged pull request in
 * Blocked with a null reason and `schedulerEligible: true`, so the scheduler
 * could have offered a lane to a pull request that no longer existed.
 */
describe("a blocked entry always names its reason", () => {
  function throughOffer(attemptId = "a1"): QueueEvent[] {
    return [
      ev({
        type: "QueueRequested",
        entryId: "e1",
        pullRequestNumber: 34,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "264261678",
        headSha: "h".repeat(40),
      }),
      ev({
        type: "ReadinessEvaluated",
        entryId: "e1",
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
        secondaryReasons: [],
      }),
      ev({
        type: "TurnOffered",
        entryId: "e1",
        attemptId,
        offerDeadline: "2026-07-29T12:01:30.000Z",
        decisionDigest: "sha256:dec",
      }),
      ev({ type: "OfferClaimed", attemptId, executionMode: "device", deviceId: "d1" }),
    ];
  }

  it("names a reason when an attempt is terminated", () => {
    const state = applyEvents(base(), [
      ...throughOffer(),
      ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "ADMIN_CANCELLED" }),
    ]);
    const entry = state.entries.get("e1");
    expect(entry?.state).toBe("Blocked");
    expect(entry?.primaryReason).not.toBeNull();
  });

  it("names the outcome's own reason where one exists", () => {
    for (const [outcome, reason] of [
      ["CI_FAILED", "REQUIRED_CHECK_FAILED"],
      ["MERGE_CONFLICT", "MERGE_CONFLICT"],
      ["RECEIPT_REJECTED", "LOCAL_RECEIPT_REJECTED"],
      ["POLICY_CHANGED", "POLICY_CHANGED"],
      ["APP_UNINSTALLED", "APP_PERMISSION_DRIFT"],
    ] as const) {
      const state = applyEvents(base(), [
        ...throughOffer(),
        ev({ type: "AttemptTerminated", attemptId: "a1", outcome }),
      ]);
      expect(state.entries.get("e1")?.primaryReason).toBe(reason);
      seq += 0;
    }
  });

  it("names a reason when the verifier refuses the candidate", () => {
    const state = applyEvents(base(), [
      ...throughOffer("a2"),
      ev({
        type: "CandidatePrepared",
        attemptId: "a2",
        baseSha: "b".repeat(40),
        headSha: "h".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTree: "t".repeat(40),
        policyDigest: "sha256:pol",
        runner: "dagger",
      }),
      ev({
        type: "AssignmentIssued",
        attemptId: "a2",
        assignmentDigest: "sha256:asg",
        executionDeadline: "2026-07-29T12:20:00.000Z",
      }),
      ev({ type: "ReceiptSubmitted", attemptId: "a2", receiptDigest: "sha256:rcpt" }),
      ev({ type: "VerificationStarted", attemptId: "a2", nonce: "n1" }),
      ev({
        type: "VerificationCompleted",
        attemptId: "a2",
        nonce: "n1",
        accepted: false,
        verifierResultDigest: "sha256:res",
        reasonCodes: ["SUITE_NOT_PASSED"],
      }),
    ]);
    const entry = state.entries.get("e1");
    expect(entry?.state).toBe("Blocked");
    expect(entry?.primaryReason).not.toBeNull();
  });

  it("is an invariant violation, not merely untidy", () => {
    const state = applyEvents(base(), [
      ...throughOffer(),
      ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "ADMIN_CANCELLED" }),
    ]);
    expect(checkInvariants(state)).toEqual([]);

    // Reach in and take the reason away: no sequence of events may produce this.
    const blinded = { ...state, entries: new Map(state.entries) };
    blinded.entries.set("e1", { ...blinded.entries.get("e1")!, primaryReason: null });
    expect(checkInvariants(blinded)).toEqual([
      { invariant: "BlockedEntryNamesReason", detail: "entry e1 is blocked with no reason" },
    ]);
  });
});
