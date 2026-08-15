import { describe, expect, it, vi } from "vitest";
import { requestTurn } from "./queue-operations.js";
import type { QueueCommands } from "./commands.js";
import type { QueueStateStore } from "@thwip/queue-domain";

/**
 * A merged pull request does not go back in line.
 *
 * `requestTurn` reset the ordinal and placed the entry again whenever it found
 * a finished one, on the reasoning that a finished entry being asked for again
 * means the pull request was reopened. That holds for a pull request somebody
 * closed. It never holds for a merged one, because GitHub does not let anybody
 * reopen a merge.
 *
 * So any later `pull_request` delivery about a merged pull request, including a
 * redelivery of one from before the merge, resurrected its entry into
 * `Requested` with a fresh ordinal and no eligibility. Nothing ever offered it
 * a turn, so nothing ever cancelled it, and it could remain in the line while
 * status comments named it ahead of the pull request actually holding the lane.
 */

function storeWith(entry: { state: string; fairnessOrdinal: bigint } | null): QueueStateStore {
  const entries = new Map(entry === null ? [] : [["entry_1", entry]]);
  return { state: () => ({ entries }) } as unknown as QueueStateStore;
}

const INPUT = {
  idempotencyKey: "key",
  entryId: "entry_1",
  pullRequestNumber: 201,
  sponsorPrincipalId: "prn_1",
  sponsorGithubUserId: "1",
  headSha: "a".repeat(40),
};

function commands(): { commands: QueueCommands; requestQueue: ReturnType<typeof vi.fn> } {
  const requestQueue = vi.fn(() => ({ ok: true }));
  return { commands: { requestQueue } as unknown as QueueCommands, requestQueue };
}

describe("requestTurn", () => {
  it("does not place a merged entry again", () => {
    const { commands: c, requestQueue } = commands();
    requestTurn(c, storeWith({ state: "Merged", fairnessOrdinal: 7n }), INPUT);
    expect(requestQueue.mock.calls[0]?.[0]).not.toHaveProperty("resetOrdinal");
  });

  it("places a closed entry again, because a closed pull request can reopen", () => {
    const { commands: c, requestQueue } = commands();
    requestTurn(c, storeWith({ state: "Cancelled", fairnessOrdinal: 7n }), INPUT);
    expect(requestQueue.mock.calls[0]?.[0]).toMatchObject({ resetOrdinal: true });
  });

  it("places an entry that was never seen", () => {
    const { commands: c, requestQueue } = commands();
    requestTurn(c, storeWith(null), INPUT);
    expect(requestQueue.mock.calls[0]?.[0]).not.toHaveProperty("resetOrdinal");
  });
});
