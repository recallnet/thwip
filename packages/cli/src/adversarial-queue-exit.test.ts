import { describe, expect, it } from "vitest";
import { EXIT, exitCodeFor, humanSummary, isRetryable, knownReasonCodes } from "./queue-exit.js";
import { reactToReason } from "./ship.js";

/**
 * ADVERSARIAL RECONNAISSANCE, experience layer. Expected to FAIL against current
 * behaviour. See .superpowers/sdd/stress-test-report.md.
 *
 * The queue's authorize endpoint answers with a `reason` string. The CLI turns
 * that string into an exit code and a sentence. Every reason below is one the
 * service really returns, taken from apps/control-plane/src/queue/routes.ts and
 * candidate-verdict.ts.
 */

/** Reasons apps/control-plane/src/queue/routes.ts can put on the wire. */
const SERVICE_REASONS = [
  "DEVICE_ONLY",
  "QUEUE_NOT_CONFIGURED",
  "NO_PINNED_VERIFIER",
  "DISPATCH_FAILED",
  "CANDIDATE_DISPATCH_FAILED",
  "MERGE_EVIDENCE_INCOMPLETE",
  "MERGE_INTENT_INVALID",
  "WORK_RECEIPT_UNREADABLE",
  // decideCandidate refusals, forwarded verbatim as `reason: decision.code`.
  "CANDIDATE_NOT_VERIFIED",
  "CANDIDATE_TREE_MISMATCH",
  "CANDIDATE_BASE_MOVED",
  "CANDIDATE_REJECTED",
  "CANDIDATE_DIGEST_MISMATCH",
  "CANDIDATE_POLICY_MISMATCH",
  "CANDIDATE_SUITE_NOT_PASSED",
  "CANDIDATE_SUITES_INCOMPLETE",
  "CANDIDATE_VERIFIER_NOT_PINNED",
];

describe("ADVERSARIAL: what the CLI makes of the answers the service gives", () => {
  it("classifies every reason the queue can return", () => {
    // An unmapped reason falls to exit 50, "an invariant disagreed; this needs a
    // human, not a retry". Most of these are ordinary, actionable answers.
    const known = new Set(knownReasonCodes());
    const unmapped = SERVICE_REASONS.filter((reason) => !known.has(reason));
    expect(unmapped, `the CLI has no class for: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("does not report a failed test suite as an invariant violation", () => {
    // A required suite failed against the integrated candidate. That is exit 20.
    expect(exitCodeFor("CANDIDATE_SUITE_NOT_PASSED")).toBe(EXIT.suiteFailed);
  });

  it("keeps waiting when the base moved under a candidate", () => {
    // The base branch advanced, so the candidate has to be rebuilt and re-run.
    // Nothing is wrong and nothing needs a human; `thwip ship --wait` should sit
    // there. Today it stops with exit 50.
    expect(isRetryable("CANDIDATE_BASE_MOVED")).toBe(true);
    expect(reactToReason("CANDIDATE_BASE_MOVED", { wait: true }).kind).toBe("keep-waiting");
  });

  it("does not tell someone to stop and call a human when the verifier simply refused", () => {
    const reaction = reactToReason("CANDIDATE_REJECTED", { wait: false });
    expect(reaction.kind).toBe("stop");
    expect(
      reaction.kind === "stop" && reaction.why,
      "the verifier refusing is reported as an invariant disagreement",
    ).not.toContain("invariant");
  });

  it("says what to do, not only what happened", () => {
    // The control plane has a plain-language next action for every blocking
    // reason (apps/control-plane/src/queue/check.ts NEXT_ACTION). Someone at a
    // terminal gets the bare code and nothing else.
    const summary = humanSummary({ event: "blocked", reasonCode: "REVIEW_REQUIRED" });
    expect(summary.length, `a person reading "${summary}" is not told what to do`).toBeGreaterThan(
      "blocked: REVIEW_REQUIRED".length,
    );
  });

  /**
   * This test used to assert `exitCodeFor("HEAD_MOVED")` equalled
   * `exitCodeFor("NEEDS_REPAIR")`, which stated the bug as the requirement:
   * satisfying it would have made a real merge conflict report as "the source
   * changed". The CLI's side was never the broken one.
   *
   * The defect was in the queue, which blocked a moved head as NEEDS_REPAIR so
   * the dashboard said "Push a fix" about a branch that was fine. That mapping
   * is fixed in queue-domain and asserted there, where both surfaces read it
   * from. What remains true here is the CLI's own half.
   */
  it("does not classify a head that moved as a branch that needs repair", () => {
    expect(exitCodeFor("HEAD_MOVED")).toBe(EXIT.sourceChanged);
    expect(exitCodeFor("HEAD_MOVED")).not.toBe(EXIT.repairRequired);
  });
});

describe("ADVERSARIAL: CLI classification that already holds", () => {
  it("never maps a refusal to success", () => {
    for (const reason of knownReasonCodes()) {
      if (reason === "PASS") continue;
      expect(exitCodeFor(reason)).not.toBe(EXIT.ok);
    }
  });

  it("treats an unrecognized reason as something a human must look at", () => {
    expect(exitCodeFor("A_REASON_FROM_A_NEWER_SERVICE")).toBe(EXIT.invariant);
  });

  it("does not retry a refusal that needs a person", () => {
    for (const reason of ["REVIEW_REQUIRED", "MERGE_CONFLICT", "HEAD_MOVED", "VERIFICATION_FAILED"]) {
      expect(isRetryable(reason), reason).toBe(false);
    }
  });
});
