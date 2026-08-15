import { describe, expect, it } from "vitest";
import { cellOf, DOCUMENT_BUDGET_BYTES, SnapshotQueueStore, type SnapshotCell } from "./snapshot-store.js";
import type { SubmittedEvent } from "./store.js";

/**
 * What the document is allowed to carry forever, and what it is not.
 *
 * The whole document is parsed, folded and re-serialised on every command and
 * every tick, and a Worker on the free plan gets 10ms of CPU per invocation. So
 * anything in here that grows with the repository's history is a clock running
 * towards an outage.
 *
 * An unacknowledged outbox can grow until the tick exceeds the Worker's
 * resource budget. The document therefore needs explicit row and byte bounds.
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
  it("hands compacted terminal entries to projection with only proven repairs marked", () => {
    const s = store();
    for (let i = 1; i <= 22; i += 1) {
      request(s, `e${i}`, i);
      s.append(
        {
          idempotencyKey: `cancel-e${i}`,
          at: "2026-08-12T12:00:00.000Z",
          type: "EntryCancelled",
          entryId: `e${i}`,
          actorPrincipalId: "github",
          reason:
            i === 1
              ? "GitHub reports the pull request closed without merge"
              : "closed on GitHub",
        } as unknown as SubmittedEvent,
      );
    }

    const pending = s.pendingTerminalEntryProjections();
    expect(pending).toEqual([
      expect.objectContaining({
        entryId: "e1",
        pullRequestNumber: 1,
        state: "Cancelled",
        fairnessOrdinal: "1",
        terminalCommentPriority: true,
      }),
      expect.objectContaining({
        entryId: "e2",
        pullRequestNumber: 2,
        terminalCommentPriority: false,
      }),
    ]);
    s.acknowledgeTerminalEntryProjections(["not-the-row"]);
    expect(s.pendingTerminalEntryProjections()).toHaveLength(2);
    s.acknowledgeTerminalEntryProjections(pending.map((row) => row.projectionId));
    s.acknowledgeTerminalEntryProjections(pending.map((row) => row.projectionId));
    expect(s.pendingTerminalEntryProjections()).toEqual([]);
  });

  /**
   * The one that took the queue down.
   *
   * The backlog is written into the cell rather than produced through the
   * reducer, because one entry can only be offered a turn once. Items can
   * accumulate across many entries when nothing removes them, so the store is
   * opened over a document that already carries a backlog.
   */
  /** Put a backlog into whatever the cell already holds. */
  function growOutbox(cell: SnapshotCell, items: number): void {
    const doc = JSON.parse(cell.read() ?? "{}") as { outbox: unknown[]; nextOutboxId: number };
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
  }

  function trackedCell(initial: string | null = null): {
    cell: SnapshotCell;
    writes(): number;
    reset(): void;
  } {
    let held = initial;
    let count = 0;
    return {
      cell: {
        read: () => held,
        write: (json) => {
          held = json;
          count += 1;
        },
      },
      writes: () => count,
      reset: () => {
        count = 0;
      },
    };
  }

  function withOutboxBacklog(items: number): SnapshotQueueStore {
    const cell = cellOf();
    const seed = SnapshotQueueStore.open(cell, IDENTITY);
    request(seed, "e1", 1);
    growOutbox(cell, items);
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
   * The trap the first version of this bound walked into.
   *
   * Trimming only where an event applies means a queue that is already too
   * large and has gone quiet keeps its size forever, and being too large is
   * what makes a queue quiet: the tick stops fitting in an invocation, so no
   * event applies, so nothing trims.
   *
   * Opening the document must therefore be enough to pay down the backlog. No
   * accepted, duplicate, or rejected command is needed to make the repair.
   */
  it("pays the backlog down as soon as the document opens", () => {
    const tracked = trackedCell();
    const seeded = SnapshotQueueStore.open(tracked.cell, IDENTITY);
    request(seeded, "e1", 1);
    growOutbox(tracked.cell, 400);
    tracked.reset();

    const repaired = SnapshotQueueStore.open(tracked.cell, IDENTITY);
    expect(repaired.pendingOutbox().length).toBeLessThanOrEqual(200);
    expect(tracked.writes()).toBe(1);
  });

  it("keeps an already-bounded open read-only", () => {
    const tracked = trackedCell();
    const seeded = SnapshotQueueStore.open(tracked.cell, IDENTITY);
    request(seeded, "e1", 1);
    tracked.reset();

    SnapshotQueueStore.open(tracked.cell, IDENTITY);
    expect(tracked.writes()).toBe(0);
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

  /**
   * Every bound above counts rows, and the resource none of them spends is rows.
   *
   * The Worker spends CPU on bytes: parsing the document, folding it and
   * serialising it again. Several modest row caps can still exceed the combined
   * byte budget even when no individual cap is exceeded.
   *
   * So the document is bounded in the unit that runs out. Counting rows leaves
   * the budget to be re-divided by hand every time a field is added, and the
   * seventh field will be added by somebody who never reads this file.
   */
  describe("what one invocation can afford", () => {
    /**
     * A long completed history: entries came and went, and the final projection
     * accepted each compacted row. Pending projection handoffs are live work,
     * like unresolved merge writes, rather than completed history that a byte
     * bound may discard.
     */
    async function longHistory(entries: number): Promise<SnapshotQueueStore> {
      const s = store();
      for (let i = 0; i < entries; i += 1) {
        request(s, `e${i}`, i + 1);
        s.append(
          {
            idempotencyKey: `cancel-e${i}`,
            at: "2026-07-29T12:00:00.000Z",
            type: "EntryCancelled",
            entryId: `e${i}`,
            actorPrincipalId: "prn_1",
            reason: "withdrawn by the sponsor before it took a turn",
          } as unknown as SubmittedEvent,
          { outbox: [{ kind: "start-workflow", attemptId: `a${i}`, payload: { attemptId: `a${i}` } }] },
        );
        s.acknowledgeTerminalEntryProjections(
          s.pendingTerminalEntryProjections().map((row) => row.projectionId),
        );
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
      return s;
    }

    const bytes = (s: SnapshotQueueStore): number => s.documentBytes();

    it("holds the document inside the budget however long the history is", async () => {
      const s = await longHistory(600);
      expect(bytes(s)).toBeLessThanOrEqual(DOCUMENT_BUDGET_BYTES);
    });

    /**
     * The property that outlives every individual cap: past some history, the
     * document stops growing. A field added later without a bound breaks this
     * test, which is the only moment it is cheap to fix.
     */
    it("stops growing once the history is long", async () => {
      const shorter = bytes(await longHistory(200));
      const longer = bytes(await longHistory(800));
      expect(longer).toBeLessThanOrEqual(shorter * 1.05);
    });

    /**
     * Shedding is for diagnosis. An unsettled merge write is the one thing the
     * sweep comes back for, and a live entry is the queue itself.
     */
    it("sheds diagnosis rather than anything a decision reaches", async () => {
      const s = await longHistory(600);
      s.beginMergeOperation({
        operationId: "merge_unsettled",
        attemptId: "a-unsettled",
        attemptRevision: 0,
        expectedBaseSha: "b".repeat(40),
        expectedHeadSha: "c".repeat(40),
        expectedTreeOid: "d".repeat(40),
        pullRequestNumber: 9999,
        at: "2026-07-29T12:00:00.000Z",
      });
      request(s, "live", 10_000);

      expect(bytes(s)).toBeLessThanOrEqual(DOCUMENT_BUDGET_BYTES);
      expect(s.mergeOperations().some((row) => row.operationId === "merge_unsettled")).toBe(true);
      expect(s.state().entries.has("live")).toBe(true);
    });

    /**
     * `transitionsRecordedAt` is a sidecar of the chain, keyed by sequence, and
     * the chain is already compacted to a window. Keeping a timestamp for a link
     * nothing can name is a map that grows for the life of the repository.
     */
    it("forgets when a transition happened once the transition is gone", async () => {
      const s = await longHistory(200);
      const kept = new Set(s.transitionChain().map((t) => String(t.transitionSequence)));
      expect(s.recordedTransitionKeys().every((key) => kept.has(key))).toBe(true);
    });
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
