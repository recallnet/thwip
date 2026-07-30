import { describe, expect, it } from "vitest";
import {
  classifyMergeResponse,
  decideMergeWrite,
  finalGuard,
  isValidEventName,
  planExecution,
  turnInstanceId,
  TURN_EVENTS,
  type GuardExpectation,
  type GuardObservation,
} from "./turn.js";

describe("turnInstanceId", () => {
  it("is one instance per attempt", () => {
    expect(turnInstanceId("att-1")).toBe("queue-turn-v1-att-1");
    expect(turnInstanceId("att-1")).toBe(turnInstanceId("att-1"));
    expect(turnInstanceId("att-2")).not.toBe(turnInstanceId("att-1"));
  });
});

describe("event names", () => {
  it("uses only characters waitForEvent accepts (§40.2)", () => {
    for (const name of Object.values(TURN_EVENTS)) expect(isValidEventName(name)).toBe(true);
  });

  it("rejects a product analytics name with dots", () => {
    expect(isValidEventName("queue.receipt.v1")).toBe(false);
  });
});

describe("planExecution", () => {
  it("waits for a device on fresh, and adds a rerun on audited", () => {
    const fresh = planExecution({ mode: "run", profile: "fresh", runnerPrincipalId: "p", deviceKeyId: "k" });
    expect(fresh).toMatchObject({ kind: "await-device", thenRerun: false });
    expect(fresh.kind === "await-device" && fresh.events).toContain(TURN_EVENTS.receipt);
    expect(fresh.kind === "await-device" && fresh.events).toContain(TURN_EVENTS.attemptRevoked);

    const audited = planExecution({ mode: "run", profile: "audited", runnerPrincipalId: "p", deviceKeyId: "k" });
    expect(audited).toMatchObject({ kind: "await-device", thenRerun: true });
  });

  it("never waits for a device on reuse or remote", () => {
    expect(
      planExecution({ mode: "reuse", originalReceiptDigest: `sha256:${"a".repeat(64)}`, originalSignerKeyId: "k" }),
    ).toEqual({ kind: "construct-reuse" });
    expect(
      planExecution({
        mode: "remote",
        provider: "github-actions",
        workflowRef: "o/r/w.yml@refs/heads/main",
        workflowSha: "a".repeat(40),
      }),
    ).toEqual({ kind: "dispatch-remote" });
  });
});

describe("decideMergeWrite", () => {
  it("sends on a first execution with no persisted operation", () => {
    expect(decideMergeWrite({ persisted: null, attemptId: "a1", isReentry: false })).toEqual({
      action: "send",
    });
  });

  it("never sends on a re-entry, even with no persisted operation", () => {
    // The row is written before the request. A re-entry that cannot find it has
    // no guard behind a second mutation, so it reconciles instead.
    expect(decideMergeWrite({ persisted: null, attemptId: "a1", isReentry: true })).toMatchObject({
      action: "reconcile",
    });
  });

  it("never sends a second write when an operation exists and is unresolved", () => {
    const decision = decideMergeWrite({
      persisted: { attemptId: "a1", outcome: null },
      attemptId: "a1",
      isReentry: false,
    });
    expect(decision).toMatchObject({ action: "reconcile" });
    if (decision.action === "reconcile") expect(decision.reason).toMatch(/may already have started/);
  });

  it("reports an already-resolved operation rather than acting again", () => {
    expect(
      decideMergeWrite({ persisted: { attemptId: "a1", outcome: "MERGED" }, attemptId: "a1", isReentry: true }),
    ).toEqual({ action: "already-resolved", outcome: "MERGED" });
    expect(
      decideMergeWrite({
        persisted: { attemptId: "a1", outcome: "CONFIRMED_NOT_MERGED" },
        attemptId: "a1",
        isReentry: false,
      }),
    ).toEqual({ action: "already-resolved", outcome: "CONFIRMED_NOT_MERGED" });
  });

  it("refuses an operation belonging to another attempt", () => {
    expect(
      decideMergeWrite({ persisted: { attemptId: "other", outcome: null }, attemptId: "a1", isReentry: false }),
    ).toMatchObject({ action: "reconcile" });
  });

  it("only ever returns send in exactly one situation", () => {
    const situations = [
      { persisted: null, isReentry: false },
      { persisted: null, isReentry: true },
      { persisted: { attemptId: "a1", outcome: null }, isReentry: false },
      { persisted: { attemptId: "a1", outcome: null }, isReentry: true },
      { persisted: { attemptId: "a1", outcome: "MERGED" }, isReentry: false },
      { persisted: { attemptId: "a1", outcome: "MERGED" }, isReentry: true },
      { persisted: { attemptId: "b2", outcome: null }, isReentry: false },
      { persisted: { attemptId: "b2", outcome: "MERGED" }, isReentry: true },
    ] as const;
    const sends = situations.filter(
      (s) => decideMergeWrite({ ...s, attemptId: "a1" }).action === "send",
    );
    expect(sends).toEqual([{ persisted: null, isReentry: false }]);
  });
});

describe("classifyMergeResponse", () => {
  it("treats a transport failure as unknown, not as a failure to retry", () => {
    expect(classifyMergeResponse({ status: 0, transportError: "ECONNRESET" })).toMatchObject({
      kind: "unknown",
    });
  });

  it("treats server errors and throttling as unknown", () => {
    for (const status of [500, 502, 503, 504, 408, 429]) {
      expect(classifyMergeResponse({ status })).toMatchObject({ kind: "unknown" });
    }
  });

  it("reports a merge only with a complete body", () => {
    expect(
      classifyMergeResponse({
        status: 200,
        body: { merged: true, sha: "m".repeat(40), treeOid: "t".repeat(40), parents: ["b".repeat(40)] },
      }),
    ).toMatchObject({ kind: "merged", mergeSha: "m".repeat(40) });

    expect(classifyMergeResponse({ status: 200, body: { merged: true } })).toMatchObject({
      kind: "unknown",
    });
    expect(classifyMergeResponse({ status: 200, body: { merged: false } })).toMatchObject({
      kind: "unknown",
    });
  });

  it("treats a definite refusal as rejected", () => {
    expect(classifyMergeResponse({ status: 409, body: { message: "head changed" } })).toEqual({
      kind: "rejected",
      reason: "head changed",
    });
    expect(classifyMergeResponse({ status: 405 })).toMatchObject({ kind: "rejected" });
    expect(classifyMergeResponse({ status: 422 })).toMatchObject({ kind: "rejected" });
  });

  it("treats anything unrecognized as unknown rather than assuming success", () => {
    expect(classifyMergeResponse({ status: 418 })).toMatchObject({ kind: "unknown" });
    expect(classifyMergeResponse({ status: 302 })).toMatchObject({ kind: "unknown" });
  });
});

describe("finalGuard", () => {
  const expected: GuardExpectation = {
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    candidateTreeOid: "t".repeat(40),
    policyDigest: `sha256:${"c".repeat(64)}`,
    attemptRevision: 7,
  };
  const clean: GuardObservation = {
    ...expected,
    pullRequestOpen: true,
    reviewsSatisfied: true,
    signerStillAuthorized: true,
    rulesetEnforced: true,
    appPermissionsHealthy: true,
    queuePaused: false,
  };

  it("passes only when every fact still matches", () => {
    expect(finalGuard(expected, clean)).toEqual({ ok: true });
  });

  it("names the exact reason for each way it can fail", () => {
    const cases: Array<[Partial<GuardObservation>, string]> = [
      [{ baseSha: "9".repeat(40) }, "BASE_MOVED"],
      [{ headSha: "9".repeat(40) }, "HEAD_MOVED"],
      [{ candidateTreeOid: "9".repeat(40) }, "SUBJECT_TREE_MISMATCH"],
      [{ policyDigest: `sha256:${"9".repeat(64)}` }, "POLICY_CHANGED"],
      [{ attemptRevision: 8 }, "ATTEMPT_REVISION_CHANGED"],
      [{ pullRequestOpen: false }, "PR_CLOSED"],
      [{ reviewsSatisfied: false }, "REVIEWS_CHANGED"],
      [{ signerStillAuthorized: false }, "PERMISSION_REVOKED"],
      [{ rulesetEnforced: false }, "RULESET_DRIFT"],
      [{ appPermissionsHealthy: false }, "APP_PERMISSION_DRIFT"],
      [{ queuePaused: true }, "QUEUE_PAUSED"],
    ];
    for (const [change, reason] of cases) {
      expect(finalGuard(expected, { ...clean, ...change })).toEqual({ ok: false, reason });
    }
  });

  it("fails when several facts changed, naming the first", () => {
    expect(
      finalGuard(expected, { ...clean, baseSha: "9".repeat(40), pullRequestOpen: false }),
    ).toEqual({ ok: false, reason: "BASE_MOVED" });
  });
});
