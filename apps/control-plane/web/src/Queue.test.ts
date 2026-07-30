import { describe, expect, it } from "vitest";
import { BLOCKING_REASONS } from "@thwip/queue-domain";
import { QUEUE_NEXT_ACTIONS, queueNextAction } from "./Queue.js";

/**
 * The queue view's guidance has to cover everything the queue can report, and it
 * has to agree with what the check publishes. A dashboard that shows a bare reason
 * code has told a developer nothing they can act on.
 */

describe("queue guidance", () => {
  it("covers every blocking reason the domain defines", () => {
    for (const reason of BLOCKING_REASONS) {
      expect(Object.keys(QUEUE_NEXT_ACTIONS), `no guidance for ${reason}`).toContain(reason);
    }
  });

  it("never shows a bare reason code for a known reason", () => {
    for (const reason of BLOCKING_REASONS) {
      expect(queueNextAction(reason), reason).not.toBe(reason);
    }
  });

  it("falls back to the raw reason for something it has not seen", () => {
    expect(queueNextAction("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("returns nothing when nothing is blocking", () => {
    expect(queueNextAction(null)).toBeNull();
  });

  it("says the place is kept wherever that is the reassuring truth", () => {
    for (const reason of ["REVIEW_REQUIRED", "REQUIRED_CHECK_FAILED", "NEEDS_REPAIR"]) {
      expect(QUEUE_NEXT_ACTIONS[reason], reason).toMatch(/place/);
    }
  });
});
