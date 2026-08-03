import { describe, expect, it } from "vitest";
import {
  deriveReadiness,
  nonThwipCheckState,
  NO_OBJECTION,
  type ReadinessFacts,
} from "./readiness.js";
import { nextAction } from "./turn-check.js";

function facts(over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    projectEnabled: true,
    queuePaused: false,
    managedBaseRef: "refs/heads/main",
    pullRequestState: "open",
    draft: false,
    baseRef: "refs/heads/main",
    mergeable: true,
    ownerAuthorized: true,
    authorIsBot: false,
    sponsorPrincipalId: null,
    headProof: "accepted",
    activePolicyDigest: `sha256:${"a".repeat(64)}`,
    proofPolicyDigest: `sha256:${"a".repeat(64)}`,
    reviewsSatisfied: true,
    codeOwnerReviewSatisfied: true,
    approvalAfterPushSatisfied: true,
    conversationsResolved: true,
    nonThwipChecks: "passing",
    appPermissionsHealthy: true,
    rulesetEnforced: true,
    cancelled: false,
    needsRepair: false,
    cooldownUntil: null,
    now: "2026-07-29T12:00:00Z",
    compatibleRunnerConnected: true,
    serverExecutable: false,
    ...over,
  };
}

describe("deriveReadiness", () => {
  it("is ready and schedulable when everything holds", () => {
    expect(deriveReadiness(facts())).toEqual({
      ready: true,
      schedulerEligible: true,
      primaryReason: null,
      secondaryReasons: [],
    });
  });

  describe("capability is not readiness", () => {
    it("stays ready but unschedulable with no machine connected", () => {
      const readiness = deriveReadiness(facts({ compatibleRunnerConnected: false }));
      expect(readiness).toMatchObject({
        ready: true,
        schedulerEligible: false,
        primaryReason: "AGENT_OFFLINE",
      });
    });

    it("needs no machine at all when the server can execute the turn", () => {
      const readiness = deriveReadiness(
        facts({ compatibleRunnerConnected: false, serverExecutable: true }),
      );
      expect(readiness).toMatchObject({ ready: true, schedulerEligible: true, primaryReason: null });
    });

    it("reports the actionable problem first, not the missing machine", () => {
      const readiness = deriveReadiness(
        facts({ compatibleRunnerConnected: false, reviewsSatisfied: false }),
      );
      expect(readiness.primaryReason).toBe("REVIEW_REQUIRED");
      expect(readiness.secondaryReasons).toContain("AGENT_OFFLINE");
    });
  });

  describe("each fact blocks with the reason a developer can act on", () => {
    const cases: Array<[Partial<ReadinessFacts>, string]> = [
      [{ projectEnabled: false }, "PROJECT_DISABLED"],
      [{ queuePaused: true }, "QUEUE_PAUSED"],
      [{ pullRequestState: "closed" }, "PR_CLOSED"],
      [{ draft: true }, "PR_DRAFT"],
      [{ baseRef: "refs/heads/release" }, "BASE_NOT_MANAGED"],
      [{ ownerAuthorized: false }, "OWNER_UNAUTHORIZED"],
      [{ authorIsBot: true, sponsorPrincipalId: null }, "SPONSOR_REQUIRED"],
      [{ appPermissionsHealthy: false }, "APP_PERMISSION_DRIFT"],
      [{ rulesetEnforced: false }, "RULESET_DRIFT"],
      [{ headProof: "missing" }, "LOCAL_RECEIPT_MISSING"],
      [{ headProof: "rejected" }, "LOCAL_RECEIPT_REJECTED"],
      [{ reviewsSatisfied: false }, "REVIEW_REQUIRED"],
      [{ codeOwnerReviewSatisfied: false }, "CODEOWNER_REVIEW_REQUIRED"],
      [{ approvalAfterPushSatisfied: false }, "APPROVAL_AFTER_PUSH_REQUIRED"],
      [{ conversationsResolved: false }, "CONVERSATION_UNRESOLVED"],
      [{ nonThwipChecks: "failing" }, "REQUIRED_CHECK_FAILED"],
      [{ nonThwipChecks: "pending" }, "REQUIRED_CHECK_PENDING"],
      [{ mergeable: false }, "MERGE_CONFLICT"],
      [{ needsRepair: true }, "NEEDS_REPAIR"],
      [{ cooldownUntil: "2026-07-29T12:05:00Z" }, "COOLDOWN_ACTIVE"],
    ];

    for (const [change, reason] of cases) {
      it(`reports ${reason}`, () => {
        const readiness = deriveReadiness(facts(change));
        expect(readiness.ready).toBe(false);
        expect([readiness.primaryReason, ...readiness.secondaryReasons]).toContain(reason);
        // Every reason it can produce must be explainable to a human.
        expect(nextAction(reason)).not.toBe(`Blocked: ${reason}.`);
      });
    }
  });

  it("does not call a pending mergeability computation a conflict", () => {
    const readiness = deriveReadiness(facts({ mergeable: null }));
    expect(readiness.ready).toBe(true);
    expect(readiness.secondaryReasons).not.toContain("MERGE_CONFLICT");
  });

  it("blocks when the proof was judged against a superseded policy", () => {
    const readiness = deriveReadiness(
      facts({ proofPolicyDigest: `sha256:${"b".repeat(64)}` }),
    );
    expect(readiness.ready).toBe(false);
    expect([readiness.primaryReason, ...readiness.secondaryReasons]).toContain("POLICY_CHANGED");
  });

  it("does not compare policies when there is no accepted proof to compare", () => {
    const readiness = deriveReadiness(
      facts({ headProof: "missing", proofPolicyDigest: `sha256:${"b".repeat(64)}` }),
    );
    expect(readiness.primaryReason).toBe("LOCAL_RECEIPT_MISSING");
    expect(readiness.secondaryReasons).not.toContain("POLICY_CHANGED");
  });

  it("accepts a bot pull request that has a sponsor", () => {
    expect(deriveReadiness(facts({ authorIsBot: true, sponsorPrincipalId: "alice" }))).toMatchObject({
      ready: true,
    });
  });

  it("clears a cooldown that has elapsed", () => {
    expect(
      deriveReadiness(facts({ cooldownUntil: "2026-07-29T11:59:00Z" })),
    ).toMatchObject({ ready: true });
  });

  it("never repeats a reason", () => {
    // Cancelled and a closed pull request both produce PR_CLOSED.
    const readiness = deriveReadiness(facts({ cancelled: true, pullRequestState: "closed" }));
    const all = [readiness.primaryReason, ...readiness.secondaryReasons];
    expect(all.filter((r) => r === "PR_CLOSED")).toHaveLength(1);
  });

  it("orders repository problems before review problems", () => {
    const readiness = deriveReadiness(facts({ draft: true, reviewsSatisfied: false }));
    expect(readiness.primaryReason).toBe("PR_DRAFT");
  });

  describe("the facts nobody has read", () => {
    it("objects to nothing on their own", () => {
      expect(deriveReadiness(NO_OBJECTION)).toEqual({
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
        secondaryReasons: [],
      });
    });

    it("carry the reason for whichever fact a caller did read", () => {
      const readiness = deriveReadiness({ ...NO_OBJECTION, rulesetEnforced: false });
      expect(readiness).toMatchObject({ ready: false, primaryReason: "RULESET_DRIFT" });
    });
  });

  it("is a pure function of its facts", () => {
    const input = facts();
    const snapshot = JSON.stringify(input);
    deriveReadiness(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

/**
 * The fact that had no writer.
 *
 * `nonThwipChecks` was only ever the `NO_OBJECTION` default, so the two reason
 * codes below it could not be produced and a pull request with red CI read as
 * ready all the way to the merge gate.
 */
describe("nonThwipCheckState", () => {
  it("calls a failed required check failing", () => {
    expect(
      nonThwipCheckState({
        required: ["lint"],
        runs: [{ name: "lint", status: "completed", conclusion: "failure" }],
      }),
    ).toBe("failing");
  });

  it("calls a running required check pending", () => {
    expect(
      nonThwipCheckState({
        required: ["lint"],
        runs: [{ name: "lint", status: "in_progress", conclusion: null }],
      }),
    ).toBe("pending");
  });

  it("reports the failure ahead of the one still running", () => {
    expect(
      nonThwipCheckState({
        required: ["lint", "unit"],
        runs: [
          { name: "lint", status: "in_progress", conclusion: null },
          { name: "unit", status: "completed", conclusion: "failure" },
        ],
      }),
    ).toBe("failing");
  });

  it("counts neutral and skipped as satisfied, the way GitHub does", () => {
    expect(
      nonThwipCheckState({
        required: ["a", "b"],
        runs: [
          { name: "a", status: "completed", conclusion: "neutral" },
          { name: "b", status: "completed", conclusion: "skipped" },
        ],
      }),
    ).toBe("passing");
  });

  it("skips the checks the queue publishes itself", () => {
    // `thwip / turn` is required on the branch and published from the outcome
    // of this derivation. Counting it would wire readiness to itself: pending
    // turn check, unready entry, no offer, no turn check.
    expect(
      nonThwipCheckState({
        required: ["thwip", "thwip / turn", "thwip / candidate"],
        runs: [{ name: "thwip", status: "completed", conclusion: "failure" }],
      }),
    ).toBe("passing");
  });

  it("leaves a context nothing has published to the merge gate", () => {
    // Saying a check is still running would be a false statement about one
    // nothing has started. The gate refuses that case by name instead.
    expect(nonThwipCheckState({ required: ["lint"], runs: [] })).toBe("passing");
  });
});
