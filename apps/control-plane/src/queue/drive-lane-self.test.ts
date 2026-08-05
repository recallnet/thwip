import { describe, expect, it, vi } from "vitest";
import { driveLane } from "./merge-lane.js";
import type { QueueSnapshot } from "./queue-operations.js";

/**
 * A run does not dispatch itself.
 *
 * `/authorize` drives the lane after it walks, because the walk can offer the
 * turn to a different pull request and nothing else would tell that one. The
 * caller of `/authorize` is the run already executing for its own turn, so
 * dispatching to it starts a second run for work in flight.
 *
 * `thwip-merge.yml` serialises on one concurrency group per queue, so the new
 * run cancels the one that asked. That one is the run that would have written
 * the merge. On 5 August 2026 this produced 100 dispatches in 35 minutes, one
 * every twenty seconds, each cancelling its predecessor, so no merge could
 * complete and the queue could not move past the pull request holding it. The
 * load is also what pushed the five minute tick past the Worker's CPU budget,
 * which is how Cloudflare came to stop dispatching the trigger.
 */

const HOLDER = {
  entryId: "entry_1",
  pullRequestNumber: 219,
  state: "Offered",
} as unknown as QueueSnapshot["entries"][number];

function snapshotWith(entries: Array<Partial<QueueSnapshot["entries"][number]>>): QueueSnapshot {
  return { entries } as unknown as QueueSnapshot;
}

function deps(driveTurn: ReturnType<typeof vi.fn>) {
  return {
    driveTurn,
    activePolicy: async () => ({ securityProfile: "fast" }),
    queueProject: async () => ({ mergeWriter: "workflow" }),
  } as never;
}

describe("driveLane", () => {
  it("does not dispatch back to the pull request that is asking", async () => {
    const driveTurn = vi.fn();
    const outcome = await driveLane(
      {} as never,
      deps(driveTurn),
      "1315419165",
      "refs/heads/main",
      snapshotWith([HOLDER]),
      { exceptPullRequestNumber: 219 },
    );
    expect(driveTurn).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(false);
  });

  /**
   * The reason the drive is there at all. The walk can hand the lane to a
   * different pull request, and that one has nothing running for it.
   */
  it("dispatches when the lane moved to a different pull request", async () => {
    const driveTurn = vi.fn();
    await driveLane(
      {} as never,
      deps(driveTurn),
      "1315419165",
      "refs/heads/main",
      snapshotWith([{ ...HOLDER, pullRequestNumber: 220 }]),
      { exceptPullRequestNumber: 219 },
    );
    expect(driveTurn).toHaveBeenCalledWith(expect.anything(), "1315419165", 220);
  });

  it("dispatches as before when no caller is named", async () => {
    const driveTurn = vi.fn();
    await driveLane({} as never, deps(driveTurn), "1315419165", "refs/heads/main", snapshotWith([HOLDER]));
    expect(driveTurn).toHaveBeenCalledWith(expect.anything(), "1315419165", 219);
  });
});
