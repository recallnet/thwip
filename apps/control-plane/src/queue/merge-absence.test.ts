import { describe, expect, it } from "vitest";
import { confirmMergeAbsence, type AbsenceReads } from "./merge-absence.js";

/**
 * The rule that stopped the queue writing a chain missing its own merges.
 *
 * Pull request 105 merged at 16:41:38. The queue read GitHub at 16:41:39, was
 * told the pull request was not merged, and recorded CONFIRMED_NOT_MERGED. The
 * merge commit was on main the whole time. Every case here is that read, or the
 * reads that have to happen before a negative is allowed to stand.
 */

const MERGE = "a1fe3e7e32aed7eaeefe799174d5c4962331ac40";

function reads(over: Partial<AbsenceReads> = {}): AbsenceReads & { pulls: number; compares: number } {
  const counts = { pulls: 0, compares: 0 };
  return {
    get pulls() {
      return counts.pulls;
    },
    get compares() {
      return counts.compares;
    },
    readPull: async () => {
      counts.pulls += 1;
      return { merged: false, mergeCommitSha: null };
    },
    baseContainsHead: async () => {
      counts.compares += 1;
      return false;
    },
    ...over,
  };
}

const instant = { sleep: async () => {} };

describe("confirmMergeAbsence", () => {
  it("does not conclude a merge is absent from one stale read", async () => {
    let call = 0;
    const r = reads({
      readPull: async () => {
        call += 1;
        // GitHub's read caught up on the second ask, as it did for 105.
        return call === 1 ? { merged: false, mergeCommitSha: null } : { merged: true, mergeCommitSha: MERGE };
      },
      baseContainsHead: async () => false,
    });

    const verdict = await confirmMergeAbsence(r, instant);
    expect(verdict.kind).toBe("merged");
    expect(verdict.kind === "merged" && verdict.mergeSha).toBe(MERGE);
  });

  it("believes git over the pull request when the base already contains the head", async () => {
    const verdict = await confirmMergeAbsence(
      reads({ baseContainsHead: async () => true }),
      instant,
    );
    expect(verdict.kind).toBe("merged");
    expect(verdict.reason).toMatch(/base branch already contains/);
  });

  it("concludes not merged only when every read agrees", async () => {
    const r = reads();
    const verdict = await confirmMergeAbsence(r, { ...instant, attempts: 3 });
    expect(verdict.kind).toBe("not-merged");
    expect(r.pulls).toBe(3);
    expect(r.compares).toBe(3);
  });

  it("is unknown when the pull request cannot be read", async () => {
    const verdict = await confirmMergeAbsence(reads({ readPull: async () => null }), instant);
    expect(verdict.kind).toBe("unknown");
  });

  it("is unknown when git cannot answer, however sure the pull request sounds", async () => {
    const verdict = await confirmMergeAbsence(reads({ baseContainsHead: async () => null }), instant);
    expect(verdict.kind).toBe("unknown");
  });

  it("waits between reads so the backoff outlasts the lag", async () => {
    const slept: number[] = [];
    await confirmMergeAbsence(reads(), { sleep: async (ms) => void slept.push(ms), attempts: 3 });
    expect(slept).toEqual([1000, 2000]);
  });
});
