import { describe, expect, it } from "vitest";
import {
  settleOrphanedWrite,
  ORPHANED_WRITE_GRACE_MS,
  ORPHANED_WRITE_SWEEP_LIMIT,
  ORPHANED_WRITE_REFUSAL_BACKOFF_CAP_MS,
  retryAfter,
  type OrphanedWriteReads,
} from "./orphaned-writes.js";

const WRITE = {
  operationId: "merge_att_1",
  attemptId: "att_1",
  attemptRevision: 1,
  expectedBaseSha: "b".repeat(40),
  expectedHeadSha: "h".repeat(40),
  expectedTreeOid: "t".repeat(40),
  pullRequestNumber: 115 as number | null,
  writeStartedAt: "2026-08-02T07:55:15Z",
};

/** Nothing waits out the backoff in a test. */
const NO_SLEEP = async () => {};

function reads(overrides: Partial<OrphanedWriteReads>): OrphanedWriteReads {
  return {
    pullRequestNumbersForHead: async () => [],
    readMergeState: async () => null,
    baseContainsHead: async () => null,
    recordMerge: async (sha) => ({ status: "recorded", mergeSha: sha }),
    resolve: async () => {},
    sleep: NO_SLEEP,
    ...overrides,
  };
}

describe("settleOrphanedWrite", () => {
  it("records the merge when the pull request reports itself merged", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(
      WRITE,
      reads({
        readMergeState: async () => ({ merged: true, mergeCommitSha: "m".repeat(40) }),
        baseContainsHead: async () => true,
        resolve: async (id, o) => {
          resolved.push([id, o]);
        },
      }),
    );
    expect(outcome).toMatchObject({ settled: "merged", mergeSha: "m".repeat(40) });
    expect(resolved).toEqual([["merge_att_1", "MERGED"]]);
  });

  /**
   * A negative is a conclusion of last resort, and this row is the only surviving
   * evidence that a write was ever sent. One pull request read may not have
   * caught up with its own merge, so the negative goes through
   * `confirmMergeAbsence`: every read, from
   * both sources, across the backoff, or nothing.
   */
  it("takes the negative through the confirmation rule rather than one read pair", async () => {
    const resolved: Array<[string, string]> = [];
    let pullReads = 0;
    let containsReads = 0;
    const outcome = await settleOrphanedWrite(
      WRITE,
      reads({
        readMergeState: async () => {
          pullReads += 1;
          return { merged: false, mergeCommitSha: null };
        },
        baseContainsHead: async () => {
          containsReads += 1;
          return false;
        },
        resolve: async (id, o) => {
          resolved.push([id, o]);
        },
      }),
    );
    expect(outcome).toMatchObject({ settled: "not-merged" });
    expect(resolved).toEqual([["merge_att_1", "CONFIRMED_NOT_MERGED"]]);
    expect(pullReads).toBe(3);
    expect(containsReads).toBe(3);
  });

  /**
   * One stale answer among three clears nothing. On a squash queue the base
   * never contains the head sha at all, so a single disagreeing pull request
   * read would otherwise permanently clear a merge that landed.
   */
  it("writes no negative when one read of the three disagrees", async () => {
    const resolved: Array<[string, string]> = [];
    let call = 0;
    const outcome = await settleOrphanedWrite(
      WRITE,
      reads({
        readMergeState: async () => {
          call += 1;
          return call === 2 ? null : { merged: false, mergeCommitSha: null };
        },
        baseContainsHead: async () => false,
        resolve: async (id, o) => {
          resolved.push([id, o]);
        },
      }),
    );
    expect(outcome).toMatchObject({ settled: "unknown" });
    expect(resolved).toEqual([]);
  });

  /**
   * The whole failure this exists for began with one unreadable answer turned
   * into a durable conclusion. An unknown write stays unresolved and comes back
   * on the next tick, forever if that is what it takes.
   */
  it("leaves an unreadable write unresolved rather than concluding anything", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(
      WRITE,
      reads({
        readMergeState: async () => null,
        baseContainsHead: async () => null,
        resolve: async (id, o) => {
          resolved.push([id, o]);
        },
      }),
    );
    expect(outcome).toMatchObject({ settled: "unknown" });
    expect(resolved).toEqual([]);
  });

  /**
   * A merge that landed and cannot be recorded must not be marked settled. The
   * row is the only remaining evidence that anything needs doing.
   */
  it("leaves the write unresolved when the merge landed and the record could not be built", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(
      WRITE,
      reads({
        readMergeState: async () => ({ merged: true, mergeCommitSha: "m".repeat(40) }),
        baseContainsHead: async () => true,
        recordMerge: async () => ({ status: "refused", code: "CHAIN_MOVED", detail: "the chain moved" }),
        resolve: async (id, o) => {
          resolved.push([id, o]);
        },
      }),
    );
    expect(outcome).toMatchObject({ settled: "unknown" });
    expect(resolved).toEqual([]);
  });

  /**
   * Ancestry alone names no commit to record.
   *
   * The base containing the head says the merge landed. It does not say what
   * landed, and the head commit is not it: on a squash queue the squash tree
   * equals the head tree while the branch sits on base, so a head commit
   * parented on base clears every gate and the chain would say the base became
   * the pull request's own commit. The write stays open until the
   * pull request catches up with itself and names the merge.
   */
  it("names no commit from ancestry alone, and leaves the write for the next tick", async () => {
    const resolved: Array<[string, string]> = [];
    const recorded: string[] = [];
    const outcome = await settleOrphanedWrite(
      WRITE,
      reads({
        readMergeState: async () => ({ merged: false, mergeCommitSha: null }),
        baseContainsHead: async () => true,
        recordMerge: async (sha) => {
          recorded.push(sha);
          return { status: "recorded", mergeSha: sha };
        },
        resolve: async (id, o) => {
          resolved.push([id, o]);
        },
      }),
    );
    expect(outcome).toMatchObject({ settled: "unknown" });
    expect(recorded).toEqual([]);
    expect(resolved).toEqual([]);
  });

  /**
   * The four stranded rows carry no pull request number, so the number is read
   * back from the head commit the write pinned.
   */
  describe("a write whose row never carried a pull request number", () => {
    const LEGACY = { ...WRITE, pullRequestNumber: null };

    it("resolves the number from the head commit and settles the write with it", async () => {
      const asked: number[] = [];
      const resolved: Array<[string, string]> = [];
      const outcome = await settleOrphanedWrite(
        LEGACY,
        reads({
          pullRequestNumbersForHead: async () => [117],
          readMergeState: async (pullRequestNumber) => {
            asked.push(pullRequestNumber);
            return { merged: true, mergeCommitSha: "m".repeat(40) };
          },
          resolve: async (id, o) => {
            resolved.push([id, o]);
          },
        }),
      );
      expect(asked).toEqual([117]);
      expect(outcome).toMatchObject({ settled: "merged", mergeSha: "m".repeat(40) });
      expect(resolved).toEqual([["merge_att_1", "MERGED"]]);
    });

    it("leaves the write alone when the head commit belongs to no pull request", async () => {
      const resolved: Array<[string, string]> = [];
      const outcome = await settleOrphanedWrite(
        LEGACY,
        reads({
          pullRequestNumbersForHead: async () => [],
          resolve: async (id, o) => {
            resolved.push([id, o]);
          },
        }),
      );
      expect(outcome).toMatchObject({ settled: "unknown" });
      expect(resolved).toEqual([]);
    });

    it("leaves the write alone when the commit read failed", async () => {
      const outcome = await settleOrphanedWrite(
        LEGACY,
        reads({ pullRequestNumbersForHead: async () => null }),
      );
      expect(outcome).toMatchObject({ settled: "unknown" });
    });

    /** Two candidates is not an answer, and picking one would be a guess. */
    it("leaves the write alone when the head commit belongs to more than one pull request", async () => {
      const outcome = await settleOrphanedWrite(
        LEGACY,
        reads({ pullRequestNumbersForHead: async () => [117, 121] }),
      );
      expect(outcome).toMatchObject({ settled: "unknown" });
    });

    it("never reads the row's own number when it has one", async () => {
      let commitLookups = 0;
      await settleOrphanedWrite(
        WRITE,
        reads({
          pullRequestNumbersForHead: async () => {
            commitLookups += 1;
            return [999];
          },
          readMergeState: async () => ({ merged: true, mergeCommitSha: "m".repeat(40) }),
        }),
      );
      expect(commitLookups).toBe(0);
    });
  });

  it("waits long enough that a live workflow reports for itself", () => {
    expect(ORPHANED_WRITE_GRACE_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it("sweeps a bounded number of writes per queue per tick", () => {
    expect(ORPHANED_WRITE_SWEEP_LIMIT).toBe(5);
  });
});

/**
 * What the sweep does with a write it has already established it cannot settle.
 *
 * Four merge operations on this repository were examined on every five-minute
 * tick and refused every time for the same reason. Each ran the full
 * three-round absence backoff, about fourteen subrequests, and the sweep spent
 * its budget on them before it reached a write nobody had looked at. On 4
 * August that spent the invocation's subrequests and failed both queues.
 */
describe("how long a refused write waits before it is read again", () => {
  const AT = "2026-08-04T20:00:00.000Z";

  it("holds a write past the tick after the one that refused it", () => {
    // Ticks run every five minutes. The first refusal has to outlast one.
    const waited = Date.parse(retryAfter(1, AT)) - Date.parse(AT);
    expect(waited).toBeGreaterThan(5 * 60 * 1000);
  });

  it("waits longer each time the same answer comes back", () => {
    const first = Date.parse(retryAfter(1, AT)) - Date.parse(AT);
    const third = Date.parse(retryAfter(3, AT)) - Date.parse(AT);
    expect(third).toBeGreaterThan(first);
  });

  it("asks again within a day however often it has been refused", () => {
    // A write is never forgotten. A pull request GitHub could not answer for an
    // hour and a merge nobody can name read the same from here, and the only
    // way to tell them apart is to ask later.
    const waited = Date.parse(retryAfter(500, AT)) - Date.parse(AT);
    expect(waited).toBe(ORPHANED_WRITE_REFUSAL_BACKOFF_CAP_MS);
  });
});
