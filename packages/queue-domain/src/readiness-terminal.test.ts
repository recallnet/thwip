import { describe, expect, it } from "vitest";
import { emptyState, type BranchQueueState } from "./reducer.js";
import { applyEvents } from "./test/apply-events.js";
import type { QueueEvent } from "./events.js";

/**
 * A finished entry ignores a readiness evaluation.
 *
 * Commit e29c178 established that terminal means terminal and guarded the
 * transitions that change an entry's state. `ReadinessEvaluated` went around
 * it: `primaryReason`, `secondaryReasons` and `schedulerEligible` were all
 * written before the check for `Merged` or `Cancelled`, so the state was
 * protected and everything the projection reports about the entry was not.
 *
 * That is how a runner heartbeat came to set `schedulerEligible` true and
 * `primaryReason` null on a permanently `Cancelled` entry in production. It
 * could never run again, and the queue said it was ready to.
 */

let seq = 0;
function ev<T extends Omit<QueueEvent, "sequence" | "idempotencyKey" | "at">>(body: T): QueueEvent {
  seq += 1;
  return {
    sequence: seq,
    idempotencyKey: `rt${seq}`,
    at: new Date(Date.UTC(2026, 7, 2, 12, 0, seq % 60)).toISOString(),
    ...body,
  } as QueueEvent;
}

function queued(entryId = "e1"): QueueEvent[] {
  return [
    ev({
      type: "QueueRequested",
      entryId,
      pullRequestNumber: 7,
      sponsorPrincipalId: "alice",
      sponsorGithubUserId: "264261678",
      headSha: "h".repeat(40),
    }),
  ];
}

function stateAfter(events: QueueEvent[]): BranchQueueState {
  return applyEvents(emptyState("qk", "1315419165", "refs/heads/main"), events);
}

const READY_AGAIN = {
  type: "ReadinessEvaluated" as const,
  entryId: "e1",
  ready: true,
  schedulerEligible: true,
  primaryReason: null,
  secondaryReasons: [] as string[],
};

describe("a readiness evaluation for a finished entry", () => {
  it("does not make a cancelled entry look schedulable", () => {
    const state = stateAfter([
      ...queued(),
      ev({ type: "EntryCancelled", entryId: "e1", actorPrincipalId: "alice", reason: "withdrawn" }),
      ev(READY_AGAIN),
    ]);

    const entry = state.entries.get("e1")!;
    expect(entry.state).toBe("Cancelled");
    expect(entry.schedulerEligible, "a cancelled entry can never run").toBe(false);
  });

  /**
   * The reason is what a developer reads. Clearing it on a cancelled entry
   * removes the only record of why it is not moving.
   */
  it("does not clear the reason a cancelled entry carries", () => {
    const state = stateAfter([
      ...queued(),
      ev({
        type: "ReadinessEvaluated",
        entryId: "e1",
        ready: false,
        schedulerEligible: false,
        primaryReason: "AGENT_OFFLINE",
        secondaryReasons: [],
      }),
      ev({ type: "EntryCancelled", entryId: "e1", actorPrincipalId: "alice", reason: "withdrawn" }),
      ev(READY_AGAIN),
    ]);

    const entry = state.entries.get("e1")!;
    expect(entry.state).toBe("Cancelled");
    expect(entry.primaryReason).toBe("AGENT_OFFLINE");
  });

  /** An entry that has not finished still takes the evaluation, as before. */
  it("still applies to an entry that can run", () => {
    const state = stateAfter([
      ...queued(),
      ev({
        type: "ReadinessEvaluated",
        entryId: "e1",
        ready: false,
        schedulerEligible: false,
        primaryReason: "AGENT_OFFLINE",
        secondaryReasons: [],
      }),
    ]);

    const entry = state.entries.get("e1")!;
    expect(entry.primaryReason).toBe("AGENT_OFFLINE");
    expect(entry.schedulerEligible).toBe(false);
  });
});
