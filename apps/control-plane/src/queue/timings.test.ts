import { describe, expect, it } from "vitest";
import { DEFAULT_TIMINGS } from "./commands.js";
import { SWEEP_INTERVAL_SECONDS } from "./runners.js";

/**
 * A deadline means nothing except against the clock that enforces it.
 *
 * Nothing in this Worker watches a queue continuously. Every window below is
 * ended by the sweep, which runs every five minutes, so a window shorter than
 * the sweep is not a short window: it is a window the queue gets exactly one
 * look at.
 *
 * `offerSeconds` was 90. The sweep offers a turn and drives it in the same
 * invocation; if that drive does not reach a merge — a slow GitHub read, a
 * candidate not yet resolved, a rate limit — the next sweep arrives 300 seconds
 * later, finds the offer 210 seconds past its deadline, and expires it before
 * anything drives it again. One transient failure would therefore cost the
 * whole turn and leave progress dependent on a webhook.
 *
 * So the rule is a relation rather than a number: any window the sweep ends is
 * written in sweeps, and at least two of them. One sweep to see the state, one
 * to act on it, so a single missed firing does not lose a turn.
 *
 * `DEFAULT_TIMINGS.noClaimCooldownSeconds` has been written this way since
 * somebody was bitten by it, and the comment there says why. This is the rest of
 * the family.
 */

/**
 * The windows the sweep ends by destroying work: an offer expires, an attempt is
 * superseded or terminated, a merge outcome becomes unknown and blocks its
 * entry. Each maps to a `case` in `runAlarm`.
 */
const ENFORCED_BY_THE_SWEEP = ["offerSeconds", "graceSeconds", "executionSeconds"] as const;

/**
 * Windows that are not deadlines and are exempt on purpose.
 *
 * A cooldown says "not before", so a sweep arriving after it has elapsed is
 * simply the next chance to act, and nothing is lost by being late.
 * `heartbeatSeconds` is held by the connected device against its own clock, not
 * by this Worker, so the sweep interval does not bound it.
 *
 * `mergeConfirmSeconds` is the same shape as the cooldown: it triggers a read
 * rather than ending anything, so a sweep that arrives after it elapsed simply
 * asks GitHub then.
 */
const NOT_SWEEP_DEADLINES = ["noClaimCooldownSeconds", "heartbeatSeconds", "mergeConfirmSeconds"] as const;

describe("windows the sweep has to be able to enforce", () => {
  it.each(ENFORCED_BY_THE_SWEEP)("gives the sweep at least two looks at %s", (name) => {
    expect(DEFAULT_TIMINGS[name]).toBeGreaterThanOrEqual(2 * SWEEP_INTERVAL_SECONDS);
  });

  it.each(ENFORCED_BY_THE_SWEEP)("states %s in whole sweeps rather than in seconds", (name) => {
    expect(DEFAULT_TIMINGS[name] % SWEEP_INTERVAL_SECONDS).toBe(0);
  });

  /**
   * The guard that outlives these four names. A seventh window added in bare
   * seconds fails here, which is the only moment somebody is in a position to
   * ask which clock is meant to end it.
   */
  it("accounts for every window, so a new one cannot arrive unclassified", () => {
    const classified = new Set<string>([...ENFORCED_BY_THE_SWEEP, ...NOT_SWEEP_DEADLINES]);
    const unclassified = Object.keys(DEFAULT_TIMINGS).filter((name) => !classified.has(name));
    expect(unclassified, "add it to one of the two lists in this file, and say which clock ends it").toEqual([]);
  });

  it("keeps a cooldown at one sweep, because a cooldown is not a deadline", () => {
    expect(DEFAULT_TIMINGS.noClaimCooldownSeconds).toBe(SWEEP_INTERVAL_SECONDS);
  });

  /**
   * A merge whose outcome is unknown re-arms its confirmation window each time
   * the sweep looks. Two of those have to fit inside the execution window, or
   * an attempt that is still legitimately asking GitHub what happened is
   * terminated for overrunning instead.
   */
  it("leaves room to reconcile a merge inside the execution window", () => {
    expect(DEFAULT_TIMINGS.executionSeconds).toBeGreaterThan(2 * DEFAULT_TIMINGS.mergeConfirmSeconds);
  });
});
