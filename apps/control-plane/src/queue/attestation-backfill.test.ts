import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { backfillAttestations } from "./attestation-backfill.js";
import type { D1Like } from "./projection.js";

/**
 * Every record signed before the mirror existed lives only in D1. This copies
 * them out, and it has to be safe to run repeatedly because that is how it will
 * be run: from the daily cron, until it reports nothing left to do.
 */
const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function db(): D1Like {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  return t.db as unknown as D1Like;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function stored(digest: string, kind: string, attemptId = "att-1") {
  // Only a record occupies a chain position; a merge intent is cited by one
  // instead, so it carries no transition_sequence. The unique index added in
  // migration 0018 only constrains rows that do, so this mirrors real data
  // instead of tripping over a constraint no production row could violate.
  const transitionSequence = kind === "merge-intent" ? null : 1;
  raw
    .prepare(
      `INSERT INTO queue_attestations (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws)
       VALUES (?, ?, '1315419165', 'refs/heads/main', ?, ?, '{"a":1}', 'jws')`,
    )
    .run(digest, kind, transitionSequence, attemptId);
}

describe("backfilling the durable copy", () => {
  it("copies out every record it has not seen", async () => {
    const store = db();
    stored(`sha256:${"a".repeat(64)}`, "reused-proof-merge");
    stored(`sha256:${"b".repeat(64)}`, "merge-intent");

    const copied: string[] = [];
    const result = await backfillAttestations(store, {
      organizationIdFor: async () => "org_1",
      has: async () => false,
      put: async (input) => void copied.push(input.digest),
    });

    expect(result.copied).toBe(2);
    expect(copied).toHaveLength(2);
  });

  it("skips what the bucket already holds", async () => {
    const store = db();
    stored(`sha256:${"a".repeat(64)}`, "reused-proof-merge");
    const result = await backfillAttestations(store, {
      organizationIdFor: async () => "org_1",
      has: async () => true,
      put: async () => {
        throw new Error("should not have written");
      },
    });
    expect(result.copied).toBe(0);
    expect(result.alreadyThere).toBe(1);
  });

  it("says nothing is left when everything is already mirrored", async () => {
    const store = db();
    stored(`sha256:${"a".repeat(64)}`, "reused-proof-merge");
    stored(`sha256:${"b".repeat(64)}`, "merge-intent", "att-2");
    raw.prepare(`UPDATE queue_attestations SET mirrored_at = '2024-01-01T00:00:00.000Z'`).run();

    const result = await backfillAttestations(store, {
      organizationIdFor: async () => "org_1",
      has: async () => {
        throw new Error("should not have been asked about a mirrored row");
      },
      put: async () => {
        throw new Error("should not have written");
      },
    });
    expect(result).toMatchObject({ copied: 0, alreadyThere: 0, skipped: 0 });
  });

  it("drains a backlog larger than the page size across successive runs", async () => {
    const store = db();
    const digests = Array.from({ length: 5 }, (_, i) => `sha256:${String(i).repeat(64).slice(0, 64)}`);
    digests.forEach((digest, i) => stored(digest, "reused-proof-merge", `att-${i}`));

    const copied: string[] = [];
    const ports = {
      organizationIdFor: async () => "org_1",
      has: async () => false,
      put: async (input: { digest: string }) => void copied.push(input.digest),
    };

    // Each run is bounded to a page of 2, well under the 5-row backlog. A
    // watermark-free query would read the same oldest page every time and
    // never reach the rest; stamping mirrored_at on copy is what lets each
    // run pick up where the last left off.
    const first = await backfillAttestations(store, ports, 2);
    const second = await backfillAttestations(store, ports, 2);
    const third = await backfillAttestations(store, ports, 2);
    const fourth = await backfillAttestations(store, ports, 2);

    expect(first.copied).toBe(2);
    expect(second.copied).toBe(2);
    expect(third.copied).toBe(1);
    expect(fourth.copied).toBe(0);
    expect(copied.sort()).toEqual([...digests].sort());
  });
});
