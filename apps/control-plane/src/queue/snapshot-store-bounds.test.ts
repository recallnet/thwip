import { describe, expect, it } from "vitest";
import { cellOf, SnapshotQueueStore } from "./snapshot-store.js";
import type { SubmittedEvent } from "./store.js";

/**
 * What the document is allowed to carry forever, and what it is not.
 *
 * The whole document is parsed, folded and re-serialised on every command and
 * every tick, and a Worker on the free plan gets 10ms of CPU per invocation. So
 * anything in here that grows with the repository's history is a clock running
 * towards an outage.
 *
 * On 5 August 2026 it reached one. `queue_state.document` for this repository
 * was 613KB, of which the outbox was 281KB across 1053 items, every one of them
 * unacknowledged and the oldest dating from 31 July. `acknowledgeOutbox` had no
 * caller outside the tests, so nothing had ever drained one. The five minute
 * trigger began failing with `exceededResources`, Cloudflare stopped
 * dispatching it, and the queue sat still for eleven hours.
 *
 * `events` and `dedupe` already had windows. These are the two arrays that did
 * not.
 */

const IDENTITY = { queueKey: "qk", repositoryId: "1315419165", baseRef: "refs/heads/main" };

function store(): SnapshotQueueStore {
  return SnapshotQueueStore.open(cellOf(), IDENTITY);
}

function request(s: SnapshotQueueStore, entryId: string, ordinal: number): void {
  s.append(
    {
      idempotencyKey: `req-${entryId}`,
      at: "2026-07-29T12:00:00.000Z",
      type: "QueueRequested",
      entryId,
      pullRequestNumber: ordinal,
      sponsorPrincipalId: "prn_1",
      sponsorGithubUserId: "1",
      headSha: "a".repeat(40),
    } as unknown as SubmittedEvent,
    {},
  );
}

describe("what the document keeps", () => {
  /**
   * The one that took the queue down.
   *
   * The backlog is written into the cell rather than produced through the
   * reducer, because one entry can only be offered a turn once: driving 1053
   * real offers through a live queue is not what happened, and not what has to
   * happen for the array to grow. What happened is that items accumulated over
   * six days across many entries and nothing ever removed one. So a store is
   * opened over a document that already carries a backlog, which is exactly the
   * position every queue was in on 5 August.
   */
  function withOutboxBacklog(items: number): SnapshotQueueStore {
    const cell = cellOf();
    const seed = SnapshotQueueStore.open(cell, IDENTITY);
    request(seed, "e1", 1);
    const doc = JSON.parse(cell.read() ?? "{}") as {
      outbox: unknown[];
      nextOutboxId: number;
    };
    for (let i = 0; i < items; i += 1) {
      doc.outbox.push({
        outboxId: doc.nextOutboxId + i,
        kind: "start-workflow",
        attemptId: `a${i}`,
        operationId: null,
        attemptRevision: 0,
        payload: { attemptId: `a${i}` },
        attempts: 0,
        acknowledged: false,
      });
    }
    doc.nextOutboxId += items;
    cell.write(JSON.stringify(doc));
    return SnapshotQueueStore.open(cell, IDENTITY);
  }

  /** The next command through the door is what pays the bound down. */
  function offerATurn(s: SnapshotQueueStore): void {
    s.append(
      {
        idempotencyKey: "offer-e1",
        at: "2026-07-29T12:00:00.000Z",
        type: "TurnOffered",
        entryId: "e1",
        attemptId: "a-live",
        offerDeadline: "2026-07-29T12:11:30.000Z",
        decisionDigest: "sha256:dec",
      } as unknown as SubmittedEvent,
      { outbox: [{ kind: "start-workflow", attemptId: "a-live", payload: { attemptId: "a-live" } }] },
    );
  }

  it("keeps a bounded tail of outbox items, however many have accumulated", () => {
    const s = withOutboxBacklog(400);
    offerATurn(s);
    expect(s.pendingOutbox().length).toBeLessThanOrEqual(200);
  });

  /**
   * The newest are the ones worth keeping. An operator reading `/explain` asks
   * what the queue is trying to do now, and a window that dropped the newest
   * would answer with the oldest thing it ever tried.
   */
  it("keeps the newest outbox items rather than the oldest", () => {
    const s = withOutboxBacklog(400);
    offerATurn(s);
    const kept = s.pendingOutbox();
    expect(kept.at(-1)?.attemptId).toBe("a-live");
    expect(kept.some((item) => item.attemptId === "a0")).toBe(false);
  });

  /**
   * A merge write whose outcome nobody could confirm is the one thing the sweep
   * comes back for, and it can sit unsettled across many later merges. Dropping
   * it because it is old would leave a merge unrecorded with nothing left that
   * knows to look, which is the failure the sweep was written for.
   */
  it("never drops a merge write that has not settled", async () => {
    const s = store();
    for (let i = 0; i < 400; i += 1) {
      s.beginMergeOperation({
        operationId: `merge_${i}`,
        attemptId: `a${i}`,
        attemptRevision: 0,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: "c".repeat(40),
        expectedTreeOid: "d".repeat(40),
        pullRequestNumber: i,
        at: "2026-07-29T12:00:00.000Z",
      });
      // Every one but the first settles, so the first is old and unsettled.
      if (i > 0) await s.resolveMergeOperation(`merge_${i}`, "merged", "2026-07-29T12:00:01.000Z");
    }
    expect(s.mergeOperations().some((row) => row.operationId === "merge_0")).toBe(true);
  });

  it("keeps a bounded tail of settled merge writes", async () => {
    const s = store();
    for (let i = 0; i < 400; i += 1) {
      s.beginMergeOperation({
        operationId: `merge_${i}`,
        attemptId: `a${i}`,
        attemptRevision: 0,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: "c".repeat(40),
        expectedTreeOid: "d".repeat(40),
        pullRequestNumber: i,
        at: "2026-07-29T12:00:00.000Z",
      });
      await s.resolveMergeOperation(`merge_${i}`, "merged", "2026-07-29T12:00:01.000Z");
    }
    expect(s.mergeOperations().filter((row) => row.outcome !== null).length).toBeLessThanOrEqual(200);
  });
});
