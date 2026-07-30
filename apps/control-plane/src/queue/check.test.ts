import { describe, expect, it } from "vitest";
import { buildCheck, mayGate, nextAction, type ActivationState, type QueueCheckState } from "./check.js";
import { THWIP_MERGE_CONTEXT } from "./rulesets.js";
import { BLOCKING_REASONS } from "@thwip/queue-domain";

const HEAD = "2".repeat(40);

function state(over: Partial<QueueCheckState> = {}): QueueCheckState {
  return {
    activationState: "enforced",
    entryState: "Ready",
    primaryReason: null,
    schedulerEligible: true,
    projectedPosition: 2,
    totalReady: 5,
    attemptId: null,
    paused: false,
    pauseReason: null,
    cooldownUntil: null,
    ...over,
  };
}

describe("mayGate", () => {
  it("only lets canary and enforced block a merge", () => {
    expect(mayGate("configured")).toBe(false);
    expect(mayGate("observe")).toBe(false);
    expect(mayGate("canary")).toBe(true);
    expect(mayGate("enforced")).toBe(true);
  });
});

describe("observe mode cannot block", () => {
  const blocking: QueueCheckState[] = [
    state({ primaryReason: "REVIEW_REQUIRED", entryState: "Blocked" }),
    state({ primaryReason: "MERGE_CONFLICT", entryState: "Blocked" }),
    state({ paused: true, pauseReason: "incident" }),
    state({ entryState: "Cancelled" }),
  ];

  it("never concludes failure while observing", () => {
    for (const s of blocking) {
      for (const activationState of ["configured", "observe"] as ActivationState[]) {
        expect(buildCheck({ ...s, activationState }, HEAD).conclusion).not.toBe("failure");
      }
    }
  });

  it("does conclude failure once enforced", () => {
    for (const s of blocking) {
      expect(buildCheck({ ...s, activationState: "enforced" }, HEAD).conclusion).toBe("failure");
    }
  });

  it("reports the same reasoning either way, so observe is informative", () => {
    const s = state({ primaryReason: "REVIEW_REQUIRED", entryState: "Blocked" });
    const observed = buildCheck({ ...s, activationState: "observe" }, HEAD);
    const enforced = buildCheck({ ...s, activationState: "enforced" }, HEAD);
    expect(observed.title).toBe(enforced.title);
    expect(observed.summary).toBe(enforced.summary);
  });
});

describe("buildCheck", () => {
  it("always publishes under the required context name", () => {
    expect(buildCheck(state(), HEAD).name).toBe(THWIP_MERGE_CONTEXT);
  });

  it("is neutral and reassuring while merely queued", () => {
    const check = buildCheck(state(), HEAD);
    expect(check.conclusion).toBe("neutral");
    expect(check.title).toBe("Queued");
    expect(check.summary).toMatch(/Projected order: 2 of 5/);
    expect(check.summary).toMatch(/Nothing is required from you/);
  });

  it("never promises an exact permanent position", () => {
    const check = buildCheck(state(), HEAD);
    expect(check.summary).toMatch(/changes as reviews and checks change/);
  });

  it("says the place is kept when a machine is offline", () => {
    const check = buildCheck(
      state({ schedulerEligible: false, primaryReason: "AGENT_OFFLINE", entryState: "Ready" }),
      HEAD,
    );
    expect(check.summary).toMatch(/holding its place in line/);
  });

  it("succeeds only when the queue actually merged it", () => {
    expect(buildCheck(state({ entryState: "Merged" }), HEAD).conclusion).toBe("success");
    for (const entryState of ["Ready", "Blocked", "Offered", "Active", "Deferred", "Reconciling"]) {
      expect(buildCheck(state({ entryState }), HEAD).conclusion).not.toBe("success");
    }
  });

  it("stays neutral through every in-flight state, so a slow integration never reads as failure", () => {
    for (const entryState of ["Offered", "Active", "ReconnectGrace", "Verifying", "MergeGuard", "Merging"]) {
      const check = buildCheck(state({ entryState, attemptId: "att-1" }), HEAD);
      expect(check.conclusion).toBe("neutral");
      expect(check.externalId).toBe("attempt:att-1");
    }
  });

  it("explains reconciliation without implying another write", () => {
    const check = buildCheck(state({ entryState: "Reconciling", attemptId: "att-1" }), HEAD);
    expect(check.summary).toMatch(/nothing will be written again/i);
  });

  it("explains an external transition as needing a rebaseline", () => {
    const check = buildCheck(state({ paused: true, pauseReason: "EXTERNAL_TRANSITION" }), HEAD);
    expect(check.summary).toMatch(/rebaseline/);
  });

  it("names a cooldown when one applies", () => {
    const check = buildCheck(
      state({
        entryState: "Deferred",
        primaryReason: "COOLDOWN_ACTIVE",
        cooldownUntil: "2026-07-29T12:16:00Z",
      }),
      HEAD,
    );
    expect(check.summary).toMatch(/2026-07-29T12:16:00Z/);
  });

  it("lists secondary reasons without repeating the primary one", () => {
    const check = buildCheck(
      state({
        entryState: "Blocked",
        primaryReason: "REVIEW_REQUIRED",
        secondaryReasons: ["REVIEW_REQUIRED", "REQUIRED_CHECK_PENDING"],
      }),
      HEAD,
    );
    expect(check.summary).toMatch(/Also waiting on: REQUIRED_CHECK_PENDING\./);
    expect(check.summary.match(/REVIEW_REQUIRED/g)).toBeNull();
  });

  it("uses the entry external id before an attempt exists", () => {
    expect(buildCheck(state(), HEAD).externalId).toBe(`entry:${HEAD}`);
  });

  it("always tells the developer their place is kept when blocked", () => {
    const check = buildCheck(state({ entryState: "Blocked", primaryReason: "MERGE_CONFLICT" }), HEAD);
    expect(check.summary).toMatch(/place in line is kept/);
  });
});

describe("nextAction", () => {
  it("has plain-language guidance for every blocking reason the domain defines", () => {
    for (const reason of BLOCKING_REASONS) {
      const action = nextAction(reason);
      expect(action, `missing next action for ${reason}`).not.toBeNull();
      // A bare reason code echoed back is not guidance.
      expect(action, `${reason} has no guidance`).not.toBe(`Blocked: ${reason}.`);
    }
  });

  it("returns null when nothing is blocking", () => {
    expect(nextAction(null)).toBeNull();
  });

  it("reports an unknown reason verbatim rather than inventing advice", () => {
    expect(nextAction("SOMETHING_NEW")).toBe("Blocked: SOMETHING_NEW.");
  });
});
