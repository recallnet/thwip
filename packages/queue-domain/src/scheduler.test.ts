import { describe, expect, it } from "vitest";
import { queueKey, selectNext, type EligibleEntry } from "./scheduler.js";

function entry(over: Partial<EligibleEntry> & { entryId: string }): EligibleEntry {
  return {
    sponsorPrincipalId: `p-${over.entryId}`,
    sponsorGithubUserId: 1n,
    fairnessOrdinal: 1n,
    pullRequestNumber: 1,
    cooldownUntil: null,
    ...over,
  };
}

const NOW = "2026-07-29T12:00:00.000Z";

describe("queueKey", () => {
  it("is branch scoped, so main and release never block each other", async () => {
    const main = await queueKey("1315419165", "refs/heads/main");
    const release = await queueKey("1315419165", "refs/heads/release");
    expect(main).not.toEqual(release);
    expect(main).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same repository and ref", async () => {
    expect(await queueKey("42", "refs/heads/main")).toEqual(await queueKey("42", "refs/heads/main"));
  });

  it("separates repositories that share a base ref name", async () => {
    expect(await queueKey("42", "refs/heads/main")).not.toEqual(await queueKey("43", "refs/heads/main"));
  });
});

describe("selectNext", () => {
  it("returns null when nothing is eligible", () => {
    expect(selectNext([], new Map(), NOW)).toBeNull();
  });

  it("prefers the principal whose turn is least recent", () => {
    const alice = entry({ entryId: "a1", sponsorPrincipalId: "alice", fairnessOrdinal: 1n });
    const bob = entry({ entryId: "b1", sponsorPrincipalId: "bob", fairnessOrdinal: 9n });
    const lastServed = new Map([
      ["alice", 7n],
      ["bob", 3n],
    ]);
    expect(selectNext([alice, bob], lastServed, NOW)?.entryId).toBe("b1");
  });

  it("treats a principal who has never been served as least recent", () => {
    const alice = entry({ entryId: "a1", sponsorPrincipalId: "alice", fairnessOrdinal: 1n });
    const carol = entry({ entryId: "c1", sponsorPrincipalId: "carol", fairnessOrdinal: 50n });
    expect(selectNext([alice, carol], new Map([["alice", 1n]]), NOW)?.entryId).toBe("c1");
  });

  it("considers only a principal's oldest entry, so extra PRs add no share", () => {
    const first = entry({ entryId: "a1", sponsorPrincipalId: "alice", fairnessOrdinal: 5n });
    const second = entry({ entryId: "a2", sponsorPrincipalId: "alice", fairnessOrdinal: 2n });
    const chosen = selectNext([first, second], new Map(), NOW);
    expect(chosen?.entryId).toBe("a2");
  });

  it("skips entries still in cooldown", () => {
    const cooling = entry({
      entryId: "a1",
      sponsorPrincipalId: "alice",
      cooldownUntil: "2026-07-29T12:05:00.000Z",
    });
    const ready = entry({ entryId: "b1", sponsorPrincipalId: "bob" });
    expect(selectNext([cooling, ready], new Map(), NOW)?.entryId).toBe("b1");
    expect(selectNext([cooling], new Map(), NOW)).toBeNull();
  });

  it("admits an entry whose cooldown has elapsed", () => {
    const cooled = entry({
      entryId: "a1",
      sponsorPrincipalId: "alice",
      cooldownUntil: "2026-07-29T11:59:00.000Z",
    });
    expect(selectNext([cooled], new Map(), NOW)?.entryId).toBe("a1");
  });

  it("breaks ties deterministically down to the entry id", () => {
    const shared = { sponsorPrincipalId: "alice", fairnessOrdinal: 1n, sponsorGithubUserId: 1n };
    const a = entry({ entryId: "aaa", pullRequestNumber: 4, ...shared });
    const b = entry({ entryId: "bbb", pullRequestNumber: 4, ...shared });
    // Same principal so only one is considered; the tie must resolve, not throw.
    const picked = selectNext([b, a], new Map(), NOW);
    expect(picked?.entryId).toBe("aaa");
    expect(selectNext([a, b], new Map(), NOW)?.entryId).toBe("aaa");
  });

  it("orders by fairness ordinal before github user id", () => {
    const later = entry({
      entryId: "z",
      sponsorPrincipalId: "zoe",
      sponsorGithubUserId: 1n,
      fairnessOrdinal: 9n,
    });
    const earlier = entry({
      entryId: "y",
      sponsorPrincipalId: "yan",
      sponsorGithubUserId: 999n,
      fairnessOrdinal: 2n,
    });
    expect(selectNext([later, earlier], new Map(), NOW)?.entryId).toBe("y");
  });

  it("gives Bob a turn before Alice gets a second one", () => {
    // Alice holds ten entries, Bob one. Serve five rounds.
    const lastServed = new Map<string, bigint>();
    let turn = 0n;
    const alices = Array.from({ length: 10 }, (_, i) =>
      entry({ entryId: `a${i}`, sponsorPrincipalId: "alice", fairnessOrdinal: BigInt(i + 1) }),
    );
    const bob = entry({ entryId: "b0", sponsorPrincipalId: "bob", fairnessOrdinal: 100n });
    const pool = [...alices, bob];
    const served: string[] = [];

    for (let round = 0; round < 4; round += 1) {
      const chosen = selectNext(pool, lastServed, NOW);
      expect(chosen).not.toBeNull();
      served.push(chosen!.sponsorPrincipalId);
      turn += 1n;
      lastServed.set(chosen!.sponsorPrincipalId, turn);
      // The served entry leaves the pool, as a merged or failed entry would.
      pool.splice(pool.findIndex((e) => e.entryId === chosen!.entryId), 1);
    }

    expect(served.slice(0, 2).sort()).toEqual(["alice", "bob"]);
    expect(served[2]).toBe("alice");
  });

  it("never lets one principal take two consecutive turns while another waits", () => {
    const lastServed = new Map<string, bigint>();
    let turn = 0n;
    const pool = [
      entry({ entryId: "a1", sponsorPrincipalId: "alice", fairnessOrdinal: 1n }),
      entry({ entryId: "a2", sponsorPrincipalId: "alice", fairnessOrdinal: 2n }),
      entry({ entryId: "b1", sponsorPrincipalId: "bob", fairnessOrdinal: 3n }),
      entry({ entryId: "b2", sponsorPrincipalId: "bob", fairnessOrdinal: 4n }),
    ];
    const served: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const chosen = selectNext(pool, lastServed, NOW)!;
      served.push(chosen.sponsorPrincipalId);
      turn += 1n;
      lastServed.set(chosen.sponsorPrincipalId, turn);
      pool.splice(pool.findIndex((e) => e.entryId === chosen.entryId), 1);
    }
    expect(served).toEqual(["alice", "bob", "alice", "bob"]);
  });

  it("is a pure function of its inputs", () => {
    const pool = [
      entry({ entryId: "a1", sponsorPrincipalId: "alice" }),
      entry({ entryId: "b1", sponsorPrincipalId: "bob" }),
    ];
    const snapshot = JSON.stringify(pool, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    selectNext(pool, new Map(), NOW);
    expect(JSON.stringify(pool, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toEqual(snapshot);
  });
});
