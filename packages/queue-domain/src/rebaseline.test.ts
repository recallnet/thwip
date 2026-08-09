import { describe, expect, it } from "vitest";
import { applyEvent, emptyState, type BranchQueueState } from "./reducer.js";

/**
 * Accepting a base the queue did not sign for.
 *
 * A rebaseline is the one moment somebody tells the queue to trust a commit it
 * has no record of. It happens after the branch moved outside the queue, which
 * is the condition the whole thing exists to refuse, so the trust has to be
 * narrow: this administrator looked at this commit and accepts that one.
 *
 * The route used to take any hex string and apply it. An administrator who read
 * the panel, went to look at the commit, and came back to confirm while somebody
 * pushed again would move the base to a commit nobody had looked at.
 */

const REF = "refs/heads/main";
const OBSERVED = "e".repeat(40);
const MOVED_AGAIN = "f".repeat(40);

function paused(): BranchQueueState {
  const state = emptyState(`1:${REF}`, "1", REF);
  return applyEvent(state, {
    sequence: state.lastSequence + 1,
    at: "2026-08-09T12:00:00.000Z",
    idempotencyKey: "moved",
    type: "ExternalTransitionObserved",
    observedBaseSha: OBSERVED,
  } as never);
}

function rebaseline(state: BranchQueueState, baseSha: string, reason = "read the commit, it is ours"): BranchQueueState {
  return applyEvent(state, {
    sequence: state.lastSequence + 1,
    at: "2026-08-09T12:05:00.000Z",
    idempotencyKey: `rebaseline:${baseSha}:${reason}`,
    type: "Rebaselined",
    actorPrincipalId: "alice",
    baseSha,
    reason,
  } as never);
}

describe("accepting a moved base", () => {
  it("takes the commit the queue observed", () => {
    const after = rebaseline(paused(), OBSERVED);
    expect(after.rebaselineRequired).toBe(false);
    expect(after.baseSha).toBe(OBSERVED);
  });

  /**
   * The compare-and-set. The administrator confirms the commit the panel showed
   * them; if the branch moved again in between, the queue observed the new one
   * and the confirmation they are holding is about a commit that is no longer
   * the branch.
   */
  it("refuses a commit that is no longer the one it observed", () => {
    const state = paused();
    expect(() => rebaseline(state, MOVED_AGAIN)).toThrow(/has moved since/i);
  });

  /** Rebaseline is not resume. Somebody decides to start merging separately. */
  it("leaves the queue paused", () => {
    expect(rebaseline(paused(), OBSERVED).paused).toBe(true);
  });

  it("keeps the reason, because the audit trail is the point of asking for one", () => {
    const after = rebaseline(paused(), OBSERVED, "checked with the author, it was a hotfix");
    expect(after.transitions.at(-1)?.kind ?? "").toBeTypeOf("string");
    expect(after.rebaselineReason).toBe("checked with the author, it was a hotfix");
  });

  it("refuses a rebaseline nobody gave a reason for", () => {
    expect(() => rebaseline(paused(), OBSERVED, "   ")).toThrow(/reason/i);
  });
});
