import { describe, expect, it } from "vitest";
import { adoptChain } from "./adopt-chain.js";
import { commandsFor } from "./queue-operations.js";
import { cellOf, SnapshotQueueStore } from "./snapshot-store.js";

/**
 * The chain is the product's claim. Carrying it into the new document has to
 * either produce a chain that still checks out link by link, or produce nothing.
 */

const IDENTITY = { queueKey: "qk", repositoryId: "1315419165", baseRef: "refs/heads/main" };

function store() {
  return SnapshotQueueStore.open(cellOf(), IDENTITY);
}

function link(sequence: number, priorDigest: string | null) {
  return {
    transition_sequence: sequence,
    kind: "verified",
    // Not padded with zeroes: the reducer reads a digest ending in twenty four
    // zero nibbles as a commit sha somebody stretched to digest width, which is
    // what it always has been.
    digest: `sha256:${String(sequence).repeat(4).padEnd(64, "e")}`,
    prior_digest: priorDigest,
    base_sha: String(sequence).padStart(40, "b"),
  };
}

/** A chain whose links actually join, as a healthy projection holds it. */
function chainOf(length: number) {
  const links = [];
  let prior: string | null = null;
  for (let i = 1; i <= length; i += 1) {
    const next = link(i, prior);
    links.push(next);
    prior = next.digest;
  }
  return links;
}

describe("adopting an existing chain", () => {
  it("carries every link, in order, with the links still joined", () => {
    const s = store();
    const chain = chainOf(21);
    expect(adoptChain(commandsFor(s), s, chain)).toEqual({ adopted: 21 });

    // The document holds a window of the chain rather than all of it — the whole
    // chain lives in the projection — so what matters here is that every link was
    // accepted, that the window's links still join, and that the head is the last
    // one adopted so the next merge continues from it.
    const transitions = s.state().transitions;
    expect(transitions.at(-1)!.transitionSequence).toBe(21);
    for (let i = 1; i < transitions.length; i += 1) {
      expect(transitions[i]!.priorDigest).toBe(transitions[i - 1]!.digest);
      expect(transitions[i]!.transitionSequence).toBe(transitions[i - 1]!.transitionSequence + 1);
    }
  });

  it("survives an eviction, because it was written and not only remembered", () => {
    const cell = cellOf();
    const s = SnapshotQueueStore.open(cell, IDENTITY);
    adoptChain(commandsFor(s), s, chainOf(3));
    s.evict();
    expect(s.state().transitions).toHaveLength(3);
  });

  it("refuses to adopt on top of a chain this queue already has", () => {
    const s = store();
    adoptChain(commandsFor(s), s, chainOf(2));
    expect(adoptChain(commandsFor(s), s, chainOf(2))).toEqual({
      adopted: 0,
      reason: "CHAIN_ALREADY_PRESENT",
    });
    expect(s.state().transitions).toHaveLength(2);
  });

  it("says so rather than inventing a chain when there is nothing to carry", () => {
    const s = store();
    expect(adoptChain(commandsFor(s), s, [])).toEqual({ adopted: 0, reason: "NOTHING_TO_ADOPT" });
  });

  it("stops at a break rather than adopting a chain with a hole in it", () => {
    const s = store();
    const broken = chainOf(5);
    // A link that does not name the digest before it. A chain that skips this is
    // a chain that proves nothing.
    broken[3] = { ...broken[3]!, prior_digest: `sha256:${"f".repeat(64)}` };

    expect(adoptChain(commandsFor(s), s, broken)).toEqual({
      adopted: 3,
      reason: "LINK_REFUSED_AT_4",
    });
    expect(s.state().transitions).toHaveLength(3);
  });

  it("stops at a gap in the sequence", () => {
    const s = store();
    const chain = chainOf(4);
    const gapped = [chain[0]!, chain[2]!, chain[3]!];
    expect(adoptChain(commandsFor(s), s, gapped)).toMatchObject({ adopted: 1 });
  });
});
