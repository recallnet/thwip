import { describe, expect, it } from "vitest";
import { settleOrphanedWrite, ORPHANED_WRITE_GRACE_MS } from "./orphaned-writes.js";

const WRITE = {
  operationId: "merge_att_1",
  attemptId: "att_1",
  attemptRevision: 1,
  expectedBaseSha: "b".repeat(40),
  expectedHeadSha: "h".repeat(40),
  expectedTreeOid: "t".repeat(40),
  pullRequestNumber: 115,
  writeStartedAt: "2026-08-02T07:55:15Z",
};

describe("settleOrphanedWrite", () => {
  it("records the merge when git says the base contains the head", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(WRITE, {
      readMergeState: async () => ({ merged: true, mergeCommitSha: "m".repeat(40) }),
      baseContainsHead: async () => true,
      recordMerge: async (sha) => ({ status: "recorded", mergeSha: sha }),
      resolve: async (id, o) => {
        resolved.push([id, o]);
      },
    });
    expect(outcome).toMatchObject({ settled: "merged", mergeSha: "m".repeat(40) });
    expect(resolved).toEqual([["merge_att_1", "MERGED"]]);
  });

  it("resolves not-merged only when every read agrees", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(WRITE, {
      readMergeState: async () => ({ merged: false, mergeCommitSha: null }),
      baseContainsHead: async () => false,
      recordMerge: async () => ({ status: "recorded", mergeSha: "" }),
      resolve: async (id, o) => {
        resolved.push([id, o]);
      },
    });
    expect(outcome).toMatchObject({ settled: "not-merged" });
    expect(resolved).toEqual([["merge_att_1", "CONFIRMED_NOT_MERGED"]]);
  });

  /**
   * The whole failure this exists for began with one unreadable answer turned
   * into a durable conclusion. An unknown write stays unresolved and comes back
   * on the next tick, forever if that is what it takes.
   */
  it("leaves an unreadable write unresolved rather than concluding anything", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(WRITE, {
      readMergeState: async () => null,
      baseContainsHead: async () => null,
      recordMerge: async () => ({ status: "recorded", mergeSha: "" }),
      resolve: async (id, o) => {
        resolved.push([id, o]);
      },
    });
    expect(outcome).toMatchObject({ settled: "unknown" });
    expect(resolved).toEqual([]);
  });

  /**
   * A merge that landed and cannot be recorded must not be marked settled. The
   * row is the only remaining evidence that anything needs doing.
   */
  it("leaves the write unresolved when the merge landed and the record could not be built", async () => {
    const resolved: Array<[string, string]> = [];
    const outcome = await settleOrphanedWrite(WRITE, {
      readMergeState: async () => ({ merged: true, mergeCommitSha: "m".repeat(40) }),
      baseContainsHead: async () => true,
      recordMerge: async () => ({ status: "refused", code: "CHAIN_MOVED", detail: "the chain moved" }),
      resolve: async (id, o) => {
        resolved.push([id, o]);
      },
    });
    expect(outcome).toMatchObject({ settled: "unknown" });
    expect(resolved).toEqual([]);
  });

  /**
   * The pull request read can lag its own write, so git ancestry settles it.
   * That is the exact read that produced four false negatives.
   */
  it("trusts git ancestry over a pull request that has not caught up", async () => {
    const outcome = await settleOrphanedWrite(WRITE, {
      readMergeState: async () => ({ merged: false, mergeCommitSha: null }),
      baseContainsHead: async () => true,
      recordMerge: async (sha) => ({ status: "recorded", mergeSha: sha }),
      resolve: async () => {},
    });
    expect(outcome).toMatchObject({ settled: "merged" });
  });

  it("waits long enough that a live workflow reports for itself", () => {
    expect(ORPHANED_WRITE_GRACE_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });
});
