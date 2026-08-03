import { describe, expect, it } from "vitest";
import { applyEvent, emptyState, QueueRuleViolation, type BranchQueueState } from "./reducer.js";
import { applyEvents } from "./test/apply-events.js";
import type { QueueEvent } from "./events.js";

/**
 * ADVERSARIAL RECONNAISSANCE. These tests are expected to FAIL against current
 * behaviour. Each one describes a sequence a real repository can produce and
 * asserts what the queue should do, not what it does today. A failure here is a
 * finding, not a regression.
 *
 * Read the report at .superpowers/sdd/stress-test-report.md for severity.
 */

let seq = 0;
function ev<T extends Omit<QueueEvent, "sequence" | "idempotencyKey" | "at">>(body: T, key?: string): QueueEvent {
  seq += 1;
  return {
    sequence: seq,
    idempotencyKey: key ?? `adv${seq}`,
    at: new Date(Date.UTC(2026, 7, 1, 12, 0, seq % 60)).toISOString(),
    ...body,
  } as QueueEvent;
}

function base(): BranchQueueState {
  return emptyState("qk", "1315419165", "refs/heads/main");
}

const H = "h".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const T = "t".repeat(40);
const M = "m".repeat(40);

/** Events up to and including the phase named. */
function upTo(
  stop:
    | "offered"
    | "claimed"
    | "prepared"
    | "assigned"
    | "running"
    | "receipt"
    | "verifying"
    | "verified"
    | "intent"
    | "requested"
    | "merged",
  entryId = "e1",
  attemptId = "a1",
): QueueEvent[] {
  const all: Array<[string, QueueEvent]> = [
    [
      "offered",
      ev({
        type: "QueueRequested",
        entryId,
        pullRequestNumber: 7,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "264261678",
        headSha: H,
      }),
    ],
    [
      "offered",
      ev({ type: "ReadinessEvaluated", entryId, ready: true, schedulerEligible: true, primaryReason: null, secondaryReasons: [] }),
    ],
    [
      "offered",
      ev({ type: "TurnOffered", entryId, attemptId, offerDeadline: "2026-08-01T12:30:00.000Z", decisionDigest: "sha256:dec" }),
    ],
    ["claimed", ev({ type: "OfferClaimed", attemptId, executionMode: "device", deviceId: "d1" })],
    [
      "prepared",
      ev({
        type: "CandidatePrepared",
        attemptId,
        baseSha: B,
        headSha: H,
        candidateSha: C,
        candidateTree: T,
        policyDigest: "sha256:pol",
        runner: "dagger",
      }),
    ],
    [
      "assigned",
      ev({ type: "AssignmentIssued", attemptId, assignmentDigest: "sha256:asg", executionDeadline: "2026-08-01T13:00:00.000Z" }),
    ],
    ["running", ev({ type: "HeartbeatReceived", attemptId })],
    ["receipt", ev({ type: "ReceiptSubmitted", attemptId, receiptDigest: "sha256:rcpt" })],
    ["verifying", ev({ type: "VerificationStarted", attemptId, nonce: "n1" })],
    ["verified", ev({ type: "VerificationCompleted", attemptId, nonce: "n1", accepted: true, resultDigest: "sha256:res" })],
    ["intent", ev({ type: "MergeIntentCreated", attemptId, intentDigest: "sha256:intent" })],
    ["requested", ev({ type: "MergeRequested", attemptId })],
    ["merged", ev({ type: "MergeConfirmed", attemptId, mergeSha: M, mergeTree: T, parentShas: [B, H] })],
  ];
  const order = [
    "offered",
    "claimed",
    "prepared",
    "assigned",
    "running",
    "receipt",
    "verifying",
    "verified",
    "intent",
    "requested",
    "merged",
  ];
  const limit = order.indexOf(stop);
  return all.filter(([phase]) => order.indexOf(phase) <= limit).map(([, event]) => event);
}

describe("ADVERSARIAL: the queue and the pull request underneath it", () => {
  it("does not let a cancel erase a merge that already happened", () => {
    // An administrator ejects an entry a second after it merged, or a stale
    // close webhook is replayed. The merge is a fact; the chain already links it.
    const merged = applyEvents(base(), upTo("merged"));
    expect(merged.entries.get("e1")!.state).toBe("Merged");

    const after = applyEvent(
      merged,
      ev({ type: "EntryCancelled", entryId: "e1", actorPrincipalId: "admin", reason: "cleanup" }),
    );

    // A merged pull request must never be reported as withdrawn: the check
    // published for a Cancelled entry says "This entry was withdrawn or ejected."
    expect(after.entries.get("e1")!.state).toBe("Merged");
  });

  it("does not orphan the lane when a pull request is closed and reopened mid-turn", () => {
    // Close + reopen re-requests the entry with resetOrdinal while the turn is
    // still held. The entry is rebuilt with no current attempt; the attempt is
    // still live and still holds the lane.
    const held = applyEvents(base(), upTo("claimed"));
    const after = applyEvent(
      held,
      ev({
        type: "QueueRequested",
        entryId: "e1",
        pullRequestNumber: 7,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "264261678",
        headSha: H,
        resetOrdinal: true,
      }),
    );

    const lane = after.activeAttemptId;
    const owner = after.entries.get("e1")!.currentAttemptId;
    expect(
      lane === null || lane === owner,
      `lane held by ${lane} but its entry names ${owner}`,
    ).toBe(true);
  });

  it("refuses a second claim of an offer another device already claimed", () => {
    // Two runners for the same sponsor race the same offer. The loser is told
    // nothing: the event is swallowed and it proceeds believing it holds a turn.
    const offered = applyEvents(base(), upTo("offered"));
    const first = applyEvent(offered, ev({ type: "OfferClaimed", attemptId: "a1", executionMode: "device", deviceId: "d1" }));
    expect(first.attempts.get("a1")!.deviceId).toBe("d1");

    expect(() =>
      applyEvent(first, ev({ type: "OfferClaimed", attemptId: "a1", executionMode: "device", deviceId: "d2" })),
    ).toThrow(QueueRuleViolation);
  });

  it("refuses a verdict for an attempt that is already past verification", () => {
    // The verifier retries its callback after the merge write has begun. The
    // nonce still matches, so the reducer accepts a rejection and terminates an
    // attempt whose merge may already be landing on GitHub, freeing the lane.
    const requested = applyEvents(base(), upTo("requested"));
    expect(requested.activeAttemptId).toBe("a1");

    expect(() =>
      applyEvent(
        requested,
        ev({ type: "VerificationCompleted", attemptId: "a1", nonce: "n1", accepted: false, resultDigest: null }),
      ),
    ).toThrow(QueueRuleViolation);
  });

  it("does not let a duplicate verdict rewrite the result the merge intent was signed over", () => {
    const intent = applyEvents(base(), upTo("intent"));
    expect(intent.attempts.get("a1")!.verifierResultDigest).toBe("sha256:res");

    const after = applyEvent(
      intent,
      ev({ type: "VerificationCompleted", attemptId: "a1", nonce: "n1", accepted: true, resultDigest: "sha256:OTHER" }),
    );

    // The transition record cites verifierResultDigest. Letting a later message
    // replace it means the chain can name evidence the gate never saw.
    expect(after.attempts.get("a1")!.verifierResultDigest).toBe("sha256:res");
  });

  it("does not merge onto a base that moved outside the queue", () => {
    // The base branch is force-pushed while a turn is held. The queue pauses and
    // demands a rebaseline, yet nothing stops the held attempt from merging.
    const verified = applyEvents(base(), upTo("verified"));
    const moved = applyEvent(verified, ev({ type: "ExternalTransitionObserved", observedBaseSha: "e".repeat(40) }));
    expect(moved.paused).toBe(true);
    expect(moved.rebaselineRequired).toBe(true);

    expect(() =>
      applyEvents(moved, [
        ev({ type: "MergeIntentCreated", attemptId: "a1", intentDigest: "sha256:intent" }),
        ev({ type: "MergeRequested", attemptId: "a1" }),
        ev({ type: "MergeConfirmed", attemptId: "a1", mergeSha: M, mergeTree: T, parentShas: [B, H] }),
      ]),
    ).toThrow(QueueRuleViolation);
  });

  it("does not merge while an administrator has the queue paused", () => {
    // "Pause the queue" during an incident is the one lever an operator has. It
    // stops new turns being offered and nothing else.
    const verified = applyEvents(base(), upTo("verified"));
    const paused = applyEvent(verified, ev({ type: "QueuePaused", actorPrincipalId: "admin", reason: "incident" }));

    expect(() =>
      applyEvents(paused, [
        ev({ type: "MergeIntentCreated", attemptId: "a1", intentDigest: "sha256:intent" }),
        ev({ type: "MergeRequested", attemptId: "a1" }),
        ev({ type: "MergeConfirmed", attemptId: "a1", mergeSha: M, mergeTree: T, parentShas: [B, H] }),
      ]),
    ).toThrow(QueueRuleViolation);
  });
});

describe("ADVERSARIAL: what the developer is told when a turn ends badly", () => {
  function reasonAfter(outcome: string): string | null {
    const state = applyEvents(base(), upTo("running"));
    const after = applyEvent(state, ev({ type: "AttemptTerminated", attemptId: "a1", outcome } as never));
    return after.entries.get("e1")!.primaryReason;
  }

  it("distinguishes causes a developer would act on differently", () => {
    // Nine unrelated endings. A head that moved needs a fresh push. An operator
    // cancellation needs a conversation. A provider outage needs patience.
    const reasons = new Set(
      ["HEAD_MOVED", "BASE_MOVED", "ADMIN_CANCELLED", "PROVIDER_FAILURE", "MERGE_REJECTED", "INTERNAL_FAILURE"].map(
        reasonAfter,
      ),
    );
    expect([...reasons], "every ending collapses to one blocking reason").not.toEqual(["NEEDS_REPAIR"]);
  });

  it("does not tell someone to repair a branch when nothing about the branch is broken", () => {
    // The entry is blocked NEEDS_REPAIR, which the dashboard renders as
    // "The integration failed. Push a fix" and the CLI classes as exit 31.
    // Nothing failed: the head moved, which is exit 33 everywhere else.
    expect(reasonAfter("HEAD_MOVED")).not.toBe("NEEDS_REPAIR");
  });

  it("gives one answer for an offer nobody claimed, not two", () => {
    // Path one: the deadline sweep writes OfferExpired. The entry is Deferred,
    // the place in line kept, and the CLI retries.
    const viaExpiry = applyEvent(
      applyEvents(base(), upTo("offered")),
      ev({ type: "OfferExpired", attemptId: "a1", cooldownUntil: "2026-08-01T12:40:00.000Z" }),
    );
    expect(viaExpiry.entries.get("e1")!.state).toBe("Deferred");

    // Path two: the same fact arrives as a termination. The entry is Blocked and
    // the developer is told to repair a branch that is fine.
    const viaTermination = applyEvent(
      applyEvents(base(), upTo("offered")),
      ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "EXPIRED_UNCLAIMED" } as never),
    );
    expect(viaTermination.entries.get("e1")!.state).toBe("Deferred");
  });
});

describe("ADVERSARIAL: defences that already hold", () => {
  it("refuses a second confirmation of the same merge", () => {
    const merged = applyEvents(base(), upTo("merged"));
    expect(() =>
      applyEvent(merged, ev({ type: "MergeConfirmed", attemptId: "a1", mergeSha: M, mergeTree: T, parentShas: [B, H] })),
    ).toThrow(QueueRuleViolation);
  });

  it("refuses a merge confirmation for an attempt that was already terminated", () => {
    const running = applyEvents(base(), upTo("running"));
    const dead = applyEvent(running, ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "EXPIRED_EXECUTION" } as never));
    expect(() =>
      applyEvent(dead, ev({ type: "MergeConfirmed", attemptId: "a1", mergeSha: M, mergeTree: T, parentShas: [B, H] })),
    ).toThrow(QueueRuleViolation);
  });

  it("refuses a merge whose tree is not the candidate tree", () => {
    const requested = applyEvents(base(), upTo("requested"));
    expect(() =>
      applyEvent(
        requested,
        ev({ type: "MergeConfirmed", attemptId: "a1", mergeSha: M, mergeTree: "9".repeat(40), parentShas: [B, H] }),
      ),
    ).toThrow(QueueRuleViolation);
  });

  it("refuses a reconnect from a device that does not own the attempt", () => {
    const running = applyEvents(base(), upTo("running"));
    const lost = applyEvent(running, ev({ type: "HeartbeatLost", attemptId: "a1", graceUntil: "2026-08-01T12:45:00.000Z" }));
    expect(() => applyEvent(lost, ev({ type: "Reconnected", attemptId: "a1", deviceId: "d2" }))).toThrow(
      QueueRuleViolation,
    );
  });

  it("refuses a heartbeat for an attempt that was already retired", () => {
    const running = applyEvents(base(), upTo("running"));
    const dead = applyEvent(running, ev({ type: "AttemptTerminated", attemptId: "a1", outcome: "EXPIRED_EXECUTION" } as never));
    expect(() => applyEvent(dead, ev({ type: "HeartbeatReceived", attemptId: "a1" }))).toThrow(QueueRuleViolation);
  });

  it("refuses to offer a second lane while one is held", () => {
    const held = applyEvents(base(), upTo("claimed"));
    const withSecond = applyEvent(
      held,
      ev({
        type: "QueueRequested",
        entryId: "e2",
        pullRequestNumber: 9,
        sponsorPrincipalId: "bob",
        sponsorGithubUserId: "1",
        headSha: "a".repeat(40),
      }),
    );
    expect(() =>
      applyEvent(
        withSecond,
        ev({
          type: "TurnOffered",
          entryId: "e2",
          attemptId: "a2",
          offerDeadline: "2026-08-01T12:30:00.000Z",
          decisionDigest: "sha256:dec2",
        }),
      ),
    ).toThrow(QueueRuleViolation);
  });

  it("refuses to resume a queue whose base moved until it is rebaselined", () => {
    const moved = applyEvent(base(), ev({ type: "ExternalTransitionObserved", observedBaseSha: "e".repeat(40) }));
    expect(() => applyEvent(moved, ev({ type: "QueueResumed", actorPrincipalId: "admin" }))).toThrow(QueueRuleViolation);
  });
});
