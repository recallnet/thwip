import { describe, expect, it } from "vitest";
import { emptyState, type BranchQueueState } from "./reducer.js";
import { applyEvents } from "./test/apply-events.js";
import { overdueReconciliation, reconciliationAtDeadline } from "./reconciliation.js";
import type { QueueEvent } from "./events.js";

/**
 * Attempt `att_2dc5e37e` for pull request 114 sat in `Reconciling` for more than
 * twenty minutes past an execution deadline of 2026-08-02T05:06:04Z. The cron
 * fired several times and resolved nothing, pull request 115 sat Ready behind
 * it, and an operator had to clear the lane by hand.
 *
 * Nothing in the domain named that condition, so nothing could act on it. This
 * is the name: a live attempt whose merge outcome is in doubt and whose
 * execution deadline has passed.
 */

const AT = "2026-08-02T04:40:00.000Z";
const DEADLINE = "2026-08-02T05:06:04.000Z";
const PAST_DEADLINE = "2026-08-02T05:26:04.000Z";

let sequence = 0;
function at(type: QueueEvent["type"], rest: Record<string, unknown>): QueueEvent {
  sequence += 1;
  return { idempotencyKey: `k${sequence}`, sequence, at: AT, type, ...rest } as QueueEvent;
}

/** A turn driven to the point where the merge write's outcome is in doubt. */
function reconciling(): BranchQueueState {
  sequence = 0;
  return applyEvents(emptyState("qk", "1315419165", "refs/heads/main"), [
    at("QueueRequested", {
      entryId: "e114",
      pullRequestNumber: 114,
      sponsorPrincipalId: "alice",
      sponsorGithubUserId: "1",
      headSha: "h".repeat(40),
    }),
    at("ReadinessEvaluated", {
      entryId: "e114",
      ready: true,
      schedulerEligible: true,
      primaryReason: null,
      secondaryReasons: [],
    }),
    at("TurnOffered", {
      entryId: "e114",
      attemptId: "att_2dc5e37e",
      offerDeadline: "2026-08-02T04:41:30.000Z",
      decisionDigest: `sha256:${"0".repeat(64)}`,
    }),
    at("OfferClaimed", { attemptId: "att_2dc5e37e", executionMode: "remote" }),
    at("CandidatePrepared", {
      attemptId: "att_2dc5e37e",
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40),
      candidateSha: "c".repeat(40),
      candidateTree: "t".repeat(40),
      policyDigest: `sha256:${"b".repeat(64)}`,
      runner: "dagger",
    }),
    at("AssignmentIssued", {
      attemptId: "att_2dc5e37e",
      assignmentDigest: `sha256:${"a".repeat(64)}`,
      executionDeadline: DEADLINE,
    }),
    at("ReceiptSubmitted", { attemptId: "att_2dc5e37e", receiptDigest: `sha256:${"r".repeat(64)}` }),
    at("VerificationStarted", { attemptId: "att_2dc5e37e", nonce: "n1" }),
    at("VerificationCompleted", {
      attemptId: "att_2dc5e37e",
      nonce: "n1",
      accepted: true,
      resultDigest: `sha256:${"d".repeat(64)}`,
    }),
    at("MergeIntentCreated", { attemptId: "att_2dc5e37e", intentDigest: `sha256:${"e".repeat(64)}` }),
    at("MergeRequested", { attemptId: "att_2dc5e37e" }),
    at("MergeOutcomeUnknown", { attemptId: "att_2dc5e37e" }),
  ]);
}

describe("an attempt reconciling past its execution deadline", () => {
  it("is named once the deadline has passed", () => {
    const state = reconciling();
    expect(state.entries.get("e114")?.state).toBe("Reconciling");

    const overdue = overdueReconciliation(state, PAST_DEADLINE);
    expect(overdue?.attemptId).toBe("att_2dc5e37e");
    expect(overdue?.entryId).toBe("e114");
    expect(overdue?.pullRequestNumber).toBe(114);
    expect(overdue?.headSha).toBe("h".repeat(40));
    expect(overdue?.reconciliationDeadline).toBe(DEADLINE);
    expect(overdue?.trigger).toBe("execution");
  });

  it("is left alone while the deadline is still ahead", () => {
    expect(overdueReconciliation(reconciling(), "2026-08-02T04:50:00.000Z")).toBeNull();
  });

  it("names the same attempt at its shorter merge-confirm deadline", () => {
    const due = reconciliationAtDeadline(reconciling(), "2026-08-02T04:42:00.000Z", {
      attemptId: "att_2dc5e37e",
      dueAt: "2026-08-02T04:41:00.000Z",
      trigger: "merge-confirm",
    });
    expect(due).toMatchObject({
      attemptId: "att_2dc5e37e",
      reconciliationDeadline: "2026-08-02T04:41:00.000Z",
      trigger: "merge-confirm",
    });
  });

  it("does not let another attempt's deadline settle the lane holder", () => {
    expect(
      reconciliationAtDeadline(reconciling(), "2026-08-02T04:42:00.000Z", {
        attemptId: "att_someone_else",
        dueAt: "2026-08-02T04:41:00.000Z",
        trigger: "merge-confirm",
      }),
    ).toBeNull();
  });

  it("says nothing about a turn whose merge outcome was never in doubt", () => {
    sequence = 0;
    const running = applyEvents(emptyState("qk", "1315419165", "refs/heads/main"), [
      at("QueueRequested", {
        entryId: "e114",
        pullRequestNumber: 114,
        sponsorPrincipalId: "alice",
        sponsorGithubUserId: "1",
        headSha: "h".repeat(40),
      }),
      at("ReadinessEvaluated", {
        entryId: "e114",
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
        secondaryReasons: [],
      }),
      at("TurnOffered", {
        entryId: "e114",
        attemptId: "att_1",
        offerDeadline: "2026-08-02T04:41:30.000Z",
        decisionDigest: `sha256:${"0".repeat(64)}`,
      }),
      at("OfferClaimed", { attemptId: "att_1", executionMode: "remote" }),
      at("CandidatePrepared", {
        attemptId: "att_1",
        baseSha: "b".repeat(40),
        headSha: "h".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTree: "t".repeat(40),
        policyDigest: `sha256:${"b".repeat(64)}`,
        runner: "dagger",
      }),
      at("AssignmentIssued", {
        attemptId: "att_1",
        assignmentDigest: `sha256:${"a".repeat(64)}`,
        executionDeadline: DEADLINE,
      }),
    ]);

    // An ordinary run that overran its deadline is EXPIRED_EXECUTION's business,
    // and the alarm already ends it. Only a doubtful merge outcome belongs here.
    expect(overdueReconciliation(running, PAST_DEADLINE)).toBeNull();
  });

  it("says nothing once the attempt has ended", () => {
    sequence = 20;
    const resolved = applyEvents(reconciling(), [
      at("AttemptTerminated", { attemptId: "att_2dc5e37e", outcome: "PROVIDER_FAILURE" }),
    ]);
    expect(overdueReconciliation(resolved, PAST_DEADLINE)).toBeNull();
  });
});
