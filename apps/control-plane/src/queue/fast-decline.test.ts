import { describe, expect, it } from "vitest";
import { declineFromProjection, type ProjectedQueue } from "./fast-decline.js";

/**
 * The projection lags the object, so these tests exist to pin one direction: this
 * path may decline and may never authorize. A stale decline costs a pull request
 * one more round. A stale authorization merges two pull requests at once.
 */

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

function queue(over: Partial<ProjectedQueue> = {}): ProjectedQueue {
  return {
    activeAttemptId: null,
    paused: false,
    entries: [],
    ...over,
  };
}

function entry(over: Partial<ProjectedQueue["entries"][number]> = {}) {
  return {
    entryId: "entry_1",
    state: "Ready",
    primaryReason: null,
    schedulerEligible: true,
    lastAttemptId: null,
    headSha: HEAD,
    ...over,
  };
}

const asking = { entryId: "entry_1", headSha: HEAD };

describe("declineFromProjection", () => {
  it("declines when another entry demonstrably holds the lane", () => {
    const projected = queue({
      activeAttemptId: "att_other",
      entries: [entry(), entry({ entryId: "entry_2", lastAttemptId: "att_other" })],
    });
    expect(declineFromProjection(projected, asking)).toMatchObject({
      decline: true,
      reason: "WAITING_FOR_TURN",
    });
  });

  it("declines while the queue is paused", () => {
    const projected = queue({ paused: true, entries: [entry()] });
    expect(declineFromProjection(projected, asking)).toMatchObject({
      decline: true,
      reason: "QUEUE_PAUSED",
    });
  });

  describe("it never authorizes, so every uncertain case escalates", () => {
    it("escalates when nothing has been projected", () => {
      expect(declineFromProjection(null, asking)).toEqual({ decline: false });
    });

    it("escalates when the entry is not recorded yet, since enqueueing is a write", () => {
      expect(declineFromProjection(queue({ entries: [] }), asking)).toEqual({ decline: false });
    });

    it("escalates when the projection knows a different commit", () => {
      const projected = queue({ entries: [entry({ headSha: OTHER })] });
      expect(declineFromProjection(projected, asking)).toEqual({ decline: false });
    });

    it("escalates when the entry has no recorded commit at all", () => {
      const projected = queue({ entries: [entry({ headSha: null })] });
      expect(declineFromProjection(projected, asking)).toEqual({ decline: false });
    });

    it("escalates when the lane is free, because scheduling belongs to the object", () => {
      const projected = queue({ activeAttemptId: null, entries: [entry()] });
      expect(declineFromProjection(projected, asking)).toEqual({ decline: false });
    });

    it("escalates when this entry appears to hold the lane", () => {
      const projected = queue({
        activeAttemptId: "att_mine",
        entries: [entry({ lastAttemptId: "att_mine" })],
      });
      expect(declineFromProjection(projected, asking)).toEqual({ decline: false });
    });

    it("escalates when the lane is held by an attempt the projection cannot place", () => {
      const projected = queue({ activeAttemptId: "att_unknown", entries: [entry()] });
      expect(declineFromProjection(projected, asking)).toEqual({ decline: false });
    });

    it("escalates for an entry the projection thinks is finished", () => {
      for (const state of ["Merged", "Cancelled"]) {
        const projected = queue({
          activeAttemptId: "att_other",
          entries: [entry({ state }), entry({ entryId: "entry_2", lastAttemptId: "att_other" })],
        });
        expect(declineFromProjection(projected, asking), state).toEqual({ decline: false });
      }
    });
  });

  it("cannot return an authorization under any input", () => {
    // Exhaustive over the shapes that decide the outcome. Nothing here may produce
    // a result that lets a caller merge.
    for (const activeAttemptId of [null, "att_mine", "att_other", "att_unknown"]) {
      for (const paused of [true, false]) {
        for (const state of ["Ready", "Blocked", "Active", "Merged", "Cancelled"]) {
          for (const headSha of [HEAD, OTHER, null]) {
            for (const lastAttemptId of [null, "att_mine"]) {
              const projected = queue({
                activeAttemptId,
                paused,
                entries: [
                  entry({ state, headSha, lastAttemptId }),
                  entry({ entryId: "entry_2", lastAttemptId: "att_other" }),
                ],
              });
              const result = declineFromProjection(projected, asking);
              expect(Object.keys(result)).not.toContain("authorized");
              if (result.decline) expect(["WAITING_FOR_TURN", "QUEUE_PAUSED"]).toContain(result.reason);
            }
          }
        }
      }
    }
  });
});
