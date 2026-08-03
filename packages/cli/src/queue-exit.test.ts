import { describe, expect, it } from "vitest";
import { ATTEMPT_OUTCOMES, BLOCKING_REASONS } from "@thwip/queue-domain";
import { REASON_CODES } from "@thwip/protocol";
import { LOCAL_REASONS, SERVICE_REASONS } from "@thwip/vocabulary";
import { EXIT, exitCodeFor, humanSummary, isRetryable, line, nextActionFor, OUTCOMES } from "./queue-exit.js";

/**
 * The exit-code contract is what an agent branches on, so the dangerous failure
 * is a reason landing in the wrong class rather than in no class at all. These
 * tests check the mapping is exhaustive over every reason the system can actually
 * produce, and that the classes with real consequences are right.
 *
 * Exhaustiveness is asserted through `nextActionFor`, the function the CLI itself
 * calls on every reason it prints. When a code has no class, that function says so
 * in one sentence and quotes the code back. Matching on that sentence tests the
 * path a user hits rather than a list built for the test.
 */

/** What nextActionFor answers for a code the CLI has no class for. */
const UNRECOGNIZED = /does not know the reason code/;

/**
 * Every code any surface can hand the CLI, from the four vocabularies that
 * declare them. This is the same composition @thwip/vocabulary's ReasonCode
 * union is built from, read out of the exports rather than a list kept for tests.
 */
const ALL_REASONS: readonly string[] = [
  ...BLOCKING_REASONS,
  ...ATTEMPT_OUTCOMES,
  ...REASON_CODES,
  ...SERVICE_REASONS,
  ...LOCAL_REASONS,
];

function expectClassified(reason: string, what: string): void {
  expect(nextActionFor(reason), `unmapped ${what} ${reason}`).not.toMatch(UNRECOGNIZED);
}

describe("exhaustiveness", () => {
  it("classifies every blocking reason the queue can report", () => {
    for (const reason of BLOCKING_REASONS) expectClassified(reason, "blocking reason");
  });

  it("classifies every terminal attempt outcome", () => {
    for (const outcome of ATTEMPT_OUTCOMES) expectClassified(outcome, "attempt outcome");
  });

  it("classifies the proof verifier's reason codes it can surface", () => {
    const surfaced = REASON_CODES.filter((code) =>
      [
        "PASS",
        "SIGNATURE_INVALID",
        "SIGNER_KEY_REVOKED",
        "SIGNER_KEY_UNKNOWN",
        "POLICY_NOT_ACTIVE",
        "PIPELINE_DIGEST_MISMATCH",
        "SUITE_NOT_PASSED",
        "PROOF_EXPIRED",
        "LEASE_REQUIRED",
        "SUBJECT_TREE_MISMATCH",
      ].includes(code),
    );
    for (const code of surfaced) expectClassified(code, "verifier code");
  });

  it("classifies every code the control plane writes on the wire", () => {
    for (const reason of [...SERVICE_REASONS, ...LOCAL_REASONS]) expectClassified(reason, "wire reason");
  });

  it("has a sentence for every code the vocabulary declares", () => {
    // The classification and the sentence are Records over the same union, so
    // this cannot drift without the build failing. The test is here for a reader.
    for (const reason of ALL_REASONS) {
      const action = nextActionFor(reason);
      expect(action, `${reason} has no next action`).not.toMatch(UNRECOGNIZED);
      expect(action.length, `${reason} has no next action`).toBeGreaterThan(0);
      expect(action, `${reason} ends without a full stop`).toMatch(/[.]$/);
      expect(action, `${reason} was written with an em dash`).not.toContain("—");
    }
  });
});

describe("classification consequences", () => {
  it("never maps a failure to success", () => {
    for (const reason of ALL_REASONS) {
      if (reason === "PASS") continue;
      expect(exitCodeFor(reason), `${reason} maps to success`).not.toBe(EXIT.ok);
    }
  });

  it("treats an unknown reason as an invariant problem, not as success", () => {
    expect(exitCodeFor("SOMETHING_THE_SERVICE_KNOWS")).toBe(EXIT.invariant);
    expect(exitCodeFor("")).toBe(EXIT.invariant);
  });

  it("marks only genuinely safe retries as retryable", () => {
    for (const reason of ["EXPIRED_UNCLAIMED", "EXPIRED_EXECUTION", "SUPERSEDED", "COOLDOWN_ACTIVE", "AGENT_OFFLINE", "SERVICE_UNAVAILABLE", "RATE_LIMITED"]) {
      expect(isRetryable(reason), `${reason} should be retryable`).toBe(true);
    }
  });

  it("never marks a changed source or a human requirement as retryable", () => {
    // An agent that retries these spins forever without making progress.
    for (const reason of ["HEAD_MOVED", "BASE_MOVED", "POLICY_CHANGED", "SUBJECT_TREE_MISMATCH", "REVIEW_REQUIRED", "MERGE_CONFLICT", "CONVERSATION_UNRESOLVED"]) {
      expect(isRetryable(reason), `${reason} must not be retryable`).toBe(false);
    }
  });

  it("never marks an ambiguous merge as retryable", () => {
    // This is the one that could double-merge if an agent got it wrong.
    expect(isRetryable("MERGE_OUTCOME_UNKNOWN")).toBe(false);
    expect(exitCodeFor("MERGE_OUTCOME_UNKNOWN")).toBe(EXIT.ambiguous);
  });

  it("never marks an invariant failure as retryable", () => {
    expect(isRetryable("INVARIANT_FAILURE")).toBe(false);
    expect(isRetryable("CONFIRMED_NOT_MERGED")).toBe(false);
  });

  it("separates a lost turn from a changed source, since only one keeps the place", () => {
    expect(exitCodeFor("EXPIRED_UNCLAIMED")).toBe(EXIT.turnLost);
    expect(exitCodeFor("HEAD_MOVED")).toBe(EXIT.sourceChanged);
    expect(EXIT.turnLost).not.toBe(EXIT.sourceChanged);
  });

  it("distinguishes configuration from permission", () => {
    expect(exitCodeFor("RULESET_DRIFT")).toBe(EXIT.setupInvalid);
    expect(exitCodeFor("OWNER_UNAUTHORIZED")).toBe(EXIT.permission);
  });
});

describe("NDJSON output", () => {
  it("emits one self-describing object per line", () => {
    const emitted = line("queue.offered", { at: "2026-07-29T12:00:00Z", data: { attemptId: "att-1" } });
    expect(emitted.includes("\n")).toBe(false);
    expect(JSON.parse(emitted)).toEqual({
      v: 1,
      at: "2026-07-29T12:00:00Z",
      event: "queue.offered",
      data: { attemptId: "att-1" },
    });
  });

  it("keeps a stable key order so two runs can be diffed", () => {
    const a = line("e", { at: "t", reasonCode: "PASS", outcome: "MERGE_CONFIRMED", detail: "d" });
    expect(a).toBe('{"v":1,"at":"t","event":"e","reasonCode":"PASS","outcome":"MERGE_CONFIRMED","detail":"d"}');
  });

  it("omits absent fields rather than emitting null", () => {
    expect(line("e", { at: "t" })).toBe('{"v":1,"at":"t","event":"e"}');
  });

  it("only uses declared outcomes", () => {
    for (const outcome of OUTCOMES) {
      expect(JSON.parse(line("e", { at: "t", outcome }))["outcome"]).toBe(outcome);
    }
  });

  it("survives a detail containing quotes and newlines", () => {
    const emitted = line("e", { at: "t", detail: 'he said "no"\nthen left' });
    expect(emitted.includes("\n")).toBe(false);
    expect(JSON.parse(emitted)["detail"]).toBe('he said "no"\nthen left');
  });
});

describe("humanSummary", () => {
  it("leads with the reason a person needs to act on, then says what to do", () => {
    expect(humanSummary({ event: "blocked", reasonCode: "REVIEW_REQUIRED" })).toBe(
      "blocked: REVIEW_REQUIRED. Ask for a review. The queue holds your place while you wait.",
    );
  });

  it("names a code it does not know instead of guessing at it", () => {
    const summary = humanSummary({ event: "blocked", reasonCode: "A_NEWER_SERVICE_KNOWS_THIS" });
    expect(summary).toContain("A_NEWER_SERVICE_KNOWS_THIS");
    expect(summary).toContain("Update thwip");
  });

  it("does not shout PASS at someone whose work succeeded", () => {
    expect(humanSummary({ event: "merged", reasonCode: "PASS", detail: "abc123" })).toBe("merged abc123");
  });

  it("works with no reason at all", () => {
    expect(humanSummary({ event: "watching" })).toBe("watching");
  });
});
