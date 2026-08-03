import { describe, expect, it } from "vitest";
import {
  deriveReadiness,
  foldCapability,
  nonThwipCheckState,
  reviewGates,
  type ReadinessFacts,
  type ReviewFacts,
} from "./readiness.js";
import { nextAction } from "./turn-check.js";

/**
 * A pull request nothing objects to, built here rather than imported.
 *
 * This used to be `NO_OBJECTION`, a shipping constant every call site spread.
 * Building it in the test is the point: a suite that writes a value production
 * never writes is what hid seventeen unwritten fields, and a helper that only
 * the suite can reach cannot be spread by a route.
 */
function facts(over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    pullRequestState: "open",
    draft: false,
    ownerAuthorized: true,
    authorIsBot: false,
    sponsorPrincipalId: "alice",
    headProof: "accepted",
    proofShortfall: null,
    reviewsSatisfied: true,
    codeOwnerReviewSatisfied: true,
    approvalAfterPushSatisfied: true,
    conversationsResolved: true,
    nonThwipChecks: "passing",
    mergeable: true,
    appPermissionsHealthy: true,
    rulesetEnforced: true,
    ...over,
  };
}

const CONNECTED = { compatibleRunnerConnected: true, serverExecutable: false };
const NO_MACHINE = { compatibleRunnerConnected: false, serverExecutable: false };

describe("deriveReadiness", () => {
  it("is ready when everything holds", () => {
    expect(deriveReadiness(facts())).toEqual({
      ready: true,
      primaryReason: null,
      secondaryReasons: [],
    });
  });

  describe("each fact blocks with the reason a developer can act on", () => {
    const cases: Array<[Partial<ReadinessFacts>, string]> = [
      [{ pullRequestState: "closed" }, "PR_CLOSED"],
      [{ draft: true }, "PR_DRAFT"],
      [{ ownerAuthorized: false }, "OWNER_UNAUTHORIZED"],
      [{ authorIsBot: true, sponsorPrincipalId: null }, "SPONSOR_REQUIRED"],
      [{ appPermissionsHealthy: false }, "APP_PERMISSION_DRIFT"],
      [{ rulesetEnforced: false }, "RULESET_DRIFT"],
      [{ headProof: "missing" }, "LOCAL_RECEIPT_MISSING"],
      [{ headProof: "rejected" }, "LOCAL_RECEIPT_REJECTED"],
      [{ proofShortfall: "the head's proof did not pass integration" }, "POLICY_CHANGED"],
      [{ reviewsSatisfied: false }, "REVIEW_REQUIRED"],
      [{ codeOwnerReviewSatisfied: false }, "CODEOWNER_REVIEW_REQUIRED"],
      [{ approvalAfterPushSatisfied: false }, "APPROVAL_AFTER_PUSH_REQUIRED"],
      [{ conversationsResolved: false }, "CONVERSATION_UNRESOLVED"],
      [{ nonThwipChecks: "failing" }, "REQUIRED_CHECK_FAILED"],
      [{ nonThwipChecks: "pending" }, "REQUIRED_CHECK_PENDING"],
      [{ mergeable: false }, "MERGE_CONFLICT"],
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

    /**
     * Every reason above has a fact behind it, and every fact has a caller.
     *
     * The count is asserted because the list is the whole point of the change:
     * thirteen of these were unreachable while the callers spread a permissive
     * constant, so a reason quietly leaving the list is the regression.
     */
    it("can produce sixteen reasons, and no reason has been quietly lost", () => {
      expect(cases).toHaveLength(16);
    });
  });

  describe("a fact nobody read objects to nothing", () => {
    const unread: ReadinessFacts = {
      pullRequestState: "unread",
      draft: false,
      ownerAuthorized: "unread",
      authorIsBot: "unread",
      sponsorPrincipalId: null,
      headProof: "unread",
      proofShortfall: "unread",
      reviewsSatisfied: "unread",
      codeOwnerReviewSatisfied: "unread",
      approvalAfterPushSatisfied: "unread",
      conversationsResolved: "unread",
      nonThwipChecks: "unread",
      mergeable: "unread",
      appPermissionsHealthy: "unread",
      rulesetEnforced: "unread",
    };

    it("is ready when every fact is unread", () => {
      expect(deriveReadiness(unread)).toEqual({
        ready: true,
        primaryReason: null,
        secondaryReasons: [],
      });
    });

    it("still carries the reason for whichever fact a caller did read", () => {
      expect(deriveReadiness({ ...unread, rulesetEnforced: false })).toMatchObject({
        ready: false,
        primaryReason: "RULESET_DRIFT",
      });
    });

    it("does not read an unread proof as a proof that falls short", () => {
      expect(deriveReadiness({ ...unread, headProof: "accepted" }).ready).toBe(true);
    });
  });

  it("does not call a pending mergeability computation a conflict", () => {
    const readiness = deriveReadiness(facts({ mergeable: null }));
    expect(readiness.ready).toBe(true);
    expect(readiness.secondaryReasons).not.toContain("MERGE_CONFLICT");
  });

  it("does not compare requirements when there is no accepted proof to compare", () => {
    const readiness = deriveReadiness(
      facts({ headProof: "missing", proofShortfall: "the head's proof did not pass integration" }),
    );
    expect(readiness.primaryReason).toBe("LOCAL_RECEIPT_MISSING");
    expect(readiness.secondaryReasons).not.toContain("POLICY_CHANGED");
  });

  it("accepts a bot pull request that has a sponsor", () => {
    expect(deriveReadiness(facts({ authorIsBot: true, sponsorPrincipalId: "alice" }))).toMatchObject({
      ready: true,
    });
  });

  it("orders repository problems before review problems", () => {
    const readiness = deriveReadiness(facts({ draft: true, reviewsSatisfied: false }));
    expect(readiness.primaryReason).toBe("PR_DRAFT");
  });

  it("is a pure function of its facts", () => {
    const input = facts();
    const snapshot = JSON.stringify(input);
    deriveReadiness(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

/**
 * Capability lives here and nowhere else.
 *
 * `deriveReadiness` used to answer the same question a second time from two
 * fields inside `ReadinessFacts`, so there were two ways to decide whether a
 * machine was there. The fields are gone, so these are the only answers.
 */
describe("foldCapability", () => {
  it("stays ready but unschedulable with no machine connected", () => {
    expect(foldCapability({ ready: true, primaryReason: null }, NO_MACHINE)).toEqual({
      schedulerEligible: false,
      primaryReason: "AGENT_OFFLINE",
    });
  });

  it("needs no machine at all when the server can execute the turn", () => {
    expect(
      foldCapability(
        { ready: true, primaryReason: null },
        { compatibleRunnerConnected: false, serverExecutable: true },
      ),
    ).toEqual({ schedulerEligible: true, primaryReason: null });
  });

  it("reports the actionable problem rather than the missing machine", () => {
    expect(foldCapability({ ready: false, primaryReason: "REVIEW_REQUIRED" }, NO_MACHINE)).toEqual({
      schedulerEligible: false,
      primaryReason: "REVIEW_REQUIRED",
    });
  });

  it("schedules a ready entry with a machine", () => {
    expect(foldCapability({ ready: true, primaryReason: null }, CONNECTED)).toEqual({
      schedulerEligible: true,
      primaryReason: null,
    });
  });
});

/**
 * The four gates GitHub enforces and the control plane never read.
 *
 * With reviews required and unmet, the queue called the pull request ready,
 * gave it the lane ahead of everyone waiting, ran the pipeline, signed a merge
 * intent, and took a 422 for a merge GitHub was never going to permit.
 */
describe("reviewGates", () => {
  function review(over: Partial<ReviewFacts> = {}): ReviewFacts {
    return {
      requiredApprovingReviewCount: 1,
      requireCodeOwnerReview: true,
      requireLastPushApproval: true,
      requireThreadResolution: true,
      reviewDecision: "APPROVED",
      pendingCodeOwnerReview: false,
      approvals: 1,
      approvalsOnHead: 1,
      unresolvedThreads: 0,
      ...over,
    };
  }

  it("passes an approved pull request with nothing outstanding", () => {
    expect(reviewGates(review())).toEqual({
      reviewsSatisfied: true,
      codeOwnerReviewSatisfied: true,
      approvalAfterPushSatisfied: true,
      conversationsResolved: true,
    });
  });

  it("refuses a pull request GitHub says still needs a review", () => {
    expect(reviewGates(review({ reviewDecision: "REVIEW_REQUIRED", approvals: 0, approvalsOnHead: 0 }))).toMatchObject(
      { reviewsSatisfied: false },
    );
  });

  it("names the code owner when that is the rule going unmet", () => {
    const gates = reviewGates(
      review({ reviewDecision: "REVIEW_REQUIRED", pendingCodeOwnerReview: true, approvals: 0, approvalsOnHead: 0 }),
    );
    expect(gates.codeOwnerReviewSatisfied).toBe(false);
    expect(gates.reviewsSatisfied).toBe(true);
  });

  it("names the push when an approval exists but the branch moved past it", () => {
    const gates = reviewGates(
      review({ reviewDecision: "REVIEW_REQUIRED", approvals: 2, approvalsOnHead: 0 }),
    );
    expect(gates.approvalAfterPushSatisfied).toBe(false);
    expect(gates.reviewsSatisfied).toBe(true);
  });

  it("calls changes requested a review problem and not a rule problem", () => {
    // The reviewer spoke. Telling the author a code owner is missing would send
    // them to the wrong person.
    expect(reviewGates(review({ reviewDecision: "CHANGES_REQUESTED", pendingCodeOwnerReview: true }))).toMatchObject({
      reviewsSatisfied: false,
      codeOwnerReviewSatisfied: true,
      approvalAfterPushSatisfied: true,
    });
  });

  it("reports an open thread the branch requires resolved", () => {
    expect(reviewGates(review({ unresolvedThreads: 2 })).conversationsResolved).toBe(false);
  });

  it("ignores open threads on a branch that does not require resolution", () => {
    expect(
      reviewGates(review({ requireThreadResolution: false, unresolvedThreads: 2 })).conversationsResolved,
    ).toBe(true);
  });

  it("refuses nothing on a branch with no approval rule", () => {
    // The rules endpoint is what says which gates apply. Refusing on a decision
    // no rule here asked for would block a merge GitHub would have allowed.
    expect(
      reviewGates(
        review({
          requiredApprovingReviewCount: 0,
          requireCodeOwnerReview: false,
          reviewDecision: "REVIEW_REQUIRED",
          approvals: 0,
          approvalsOnHead: 0,
        }),
      ),
    ).toMatchObject({ reviewsSatisfied: true, codeOwnerReviewSatisfied: true, approvalAfterPushSatisfied: true });
  });

  it("asks for no review when GitHub has no decision to give", () => {
    expect(reviewGates(review({ reviewDecision: null, approvals: 0, approvalsOnHead: 0 }))).toMatchObject({
      reviewsSatisfied: true,
    });
  });
});

/**
 * The fact that had no writer.
 *
 * `nonThwipChecks` was only ever a permissive default, so the two reason codes
 * below it could not be produced and a pull request with red CI read as ready
 * all the way to the merge gate.
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

  it("skips the turn check, which is this derivation's own output", () => {
    // Counting it would wire readiness to itself: pending turn check, unready
    // entry, no offer, no turn check.
    expect(
      nonThwipCheckState({
        required: ["thwip / turn"],
        runs: [{ name: "thwip / turn", status: "completed", conclusion: "failure" }],
      }),
    ).toBe("passing");
  });

  it("counts a failed proof check, which the App publishes and this does not", () => {
    // `thwip` used to be skipped alongside the turn check, on the reasoning that
    // both start with the same word. It is the App's verdict on the head's
    // proof, so reading it is not circular, and skipping it meant the queue
    // offered the lane to a pull request whose proof the App had already
    // rejected. The merge gate refused it at the end, after the turn was spent.
    expect(
      nonThwipCheckState({
        required: ["thwip"],
        runs: [{ name: "thwip", status: "completed", conclusion: "failure" }],
      }),
    ).toBe("failing");
  });

  it("leaves a context nothing has published to the merge gate", () => {
    // Saying a check is still running would be a false statement about one
    // nothing has started. The gate refuses that case by name instead.
    expect(nonThwipCheckState({ required: ["lint"], runs: [] })).toBe("passing");
  });
});
