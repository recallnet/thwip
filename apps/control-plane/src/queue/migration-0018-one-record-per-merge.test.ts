import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, testD1 } from "../../test/d1.js";

/**
 * Migration 0018 resolves a duplicate chain link before adding the index
 * that forbids one — and it does that by mutating rows a review found it
 * could get wrong in two ways: clearing both duplicates when the index names
 * a digest neither row has, and never matching a duplicate that lands at two
 * different sequences instead of sharing one. This runs exactly the
 * migration's own statements, against exactly the shapes review flagged,
 * so a regression in the demotion logic fails here rather than only being
 * caught by staring at the SQL.
 *
 * `testD1({ upTo })` stops before 0018 runs, so a test can insert
 * pre-migration rows without the unique index it adds refusing them, then
 * `applyMigration` runs 0018's own statements against that state.
 */

const MIGRATION = "0018_one_record_per_merge.sql";
const REPO = "1315419165";
const BASE_REF = "refs/heads/main";

let harness: ReturnType<typeof testD1> | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

function fresh() {
  harness = testD1({ upTo: MIGRATION });
  return harness;
}

function insertAttestation(
  raw: ReturnType<typeof testD1>["raw"],
  row: {
    digest: string;
    attemptId: string;
    transitionSequence: number | null;
    createdAt: string;
  },
): void {
  raw
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws, created_at)
       VALUES (?, 'candidate-verified-merge', ?, ?, ?, ?, '{}', 'jws', ?)`,
    )
    .run(row.digest, REPO, BASE_REF, row.transitionSequence, row.attemptId, row.createdAt);
}

function insertIndexed(
  raw: ReturnType<typeof testD1>["raw"],
  row: { id: string; digest: string; sequence: number; attemptId: string },
): void {
  raw
    .prepare(
      `INSERT INTO queue_transitions_index
         (id, github_repository_id, base_ref, queue_epoch, transition_sequence, kind, digest, base_sha, attempt_id)
       VALUES (?, ?, ?, 1, ?, 'candidate-verified-merge', ?, '${"5".repeat(40)}', ?)`,
    )
    .run(row.id, REPO, BASE_REF, row.sequence, row.digest, row.attemptId);
}

function positions(raw: ReturnType<typeof testD1>["raw"], digests: string[]): Array<number | null> {
  return digests.map((digest) => {
    const row = raw
      .prepare(`SELECT transition_sequence FROM queue_attestations WHERE digest = ?`)
      .get(digest) as { transition_sequence: number | null } | undefined;
    if (row === undefined) throw new Error(`no row for digest ${digest}`);
    return row.transition_sequence;
  });
}

describe("migration 0018: one record per merge", () => {
  it("demotes the un-indexed duplicate when both rows share a sequence", () => {
    const t = fresh();
    const attemptId = "att_shared-sequence";
    const winner = `sha256:${"5".repeat(64)}`;
    const loser = `sha256:${"d".repeat(64)}`;
    insertAttestation(t.raw, { digest: winner, attemptId, transitionSequence: 47, createdAt: "2026-01-01T00:00:00.000Z" });
    insertAttestation(t.raw, { digest: loser, attemptId, transitionSequence: 47, createdAt: "2026-01-01T00:00:01.000Z" });
    insertIndexed(t.raw, { id: "idx-1", digest: winner, sequence: 47, attemptId });

    applyMigration(t.raw, MIGRATION);

    expect(positions(t.raw, [winner, loser])).toEqual([47, null]);
  });

  it("demotes the un-indexed duplicate when the rows sit at different sequences", () => {
    const t = fresh();
    const attemptId = "att_different-sequences";
    const winner = `sha256:${"5".repeat(64)}`;
    const loser = `sha256:${"d".repeat(64)}`;
    // The plain sequential-retry shape: one attempt signed twice, once at 47
    // and again — after something else already advanced the chain — at 48.
    insertAttestation(t.raw, { digest: winner, attemptId, transitionSequence: 47, createdAt: "2026-01-01T00:00:00.000Z" });
    insertAttestation(t.raw, { digest: loser, attemptId, transitionSequence: 48, createdAt: "2026-01-01T00:00:01.000Z" });
    insertIndexed(t.raw, { id: "idx-1", digest: winner, sequence: 47, attemptId });

    // Must not throw: the migration has to resolve this attempt down to one
    // row before CREATE UNIQUE INDEX runs against it.
    applyMigration(t.raw, MIGRATION);

    expect(positions(t.raw, [winner, loser])).toEqual([47, null]);
    const count = t.raw
      .prepare(`SELECT COUNT(*) AS n FROM queue_attestations WHERE attempt_id = ? AND transition_sequence IS NOT NULL`)
      .get(attemptId) as { n: number };
    expect(count.n).toBe(1);
  });

  it("keeps exactly one row, chosen deterministically, when neither digest is indexed", () => {
    const t = fresh();
    const attemptId = "att_neither-indexed";
    const earlier = `sha256:${"1".repeat(64)}`;
    const later = `sha256:${"9".repeat(64)}`;
    insertAttestation(t.raw, { digest: later, attemptId, transitionSequence: 47, createdAt: "2026-01-01T00:00:05.000Z" });
    insertAttestation(t.raw, { digest: earlier, attemptId, transitionSequence: 47, createdAt: "2026-01-01T00:00:00.000Z" });
    // No queue_transitions_index row for either digest.

    applyMigration(t.raw, MIGRATION);

    // Earliest created_at wins; exactly one row survives with the position.
    expect(positions(t.raw, [earlier, later])).toEqual([47, null]);
  });

  it("leaves a single un-duplicated row untouched", () => {
    const t = fresh();
    const attemptId = "att_single-row";
    const digest = `sha256:${"5".repeat(64)}`;
    insertAttestation(t.raw, { digest, attemptId, transitionSequence: 48, createdAt: "2026-01-01T00:00:00.000Z" });
    insertIndexed(t.raw, { id: "idx-1", digest, sequence: 48, attemptId });

    applyMigration(t.raw, MIGRATION);

    expect(positions(t.raw, [digest])).toEqual([48]);
  });

  it("never touches merge intents, which carry a null transition_sequence", () => {
    const t = fresh();
    const attemptId = "att_with-intent";
    const winner = `sha256:${"5".repeat(64)}`;
    const loser = `sha256:${"d".repeat(64)}`;
    const intent = `sha256:${"7".repeat(64)}`;
    insertAttestation(t.raw, { digest: winner, attemptId, transitionSequence: 47, createdAt: "2026-01-01T00:00:00.000Z" });
    insertAttestation(t.raw, { digest: loser, attemptId, transitionSequence: 47, createdAt: "2026-01-01T00:00:01.000Z" });
    insertAttestation(t.raw, { digest: intent, attemptId, transitionSequence: null, createdAt: "2026-01-01T00:00:00.000Z" });
    insertIndexed(t.raw, { id: "idx-1", digest: winner, sequence: 47, attemptId });

    applyMigration(t.raw, MIGRATION);

    expect(positions(t.raw, [winner, loser, intent])).toEqual([47, null, null]);
    const intentRow = t.raw.prepare(`SELECT transition_sequence FROM queue_attestations WHERE digest = ?`).get(intent) as {
      transition_sequence: number | null;
    };
    // Was already null before the migration ran; still null, not cleared by it.
    expect(intentRow.transition_sequence).toBeNull();
  });

  it("matches production: att_04e73f0a keeps the indexed digest at sequence 47", () => {
    const t = fresh();
    const attemptId = "att_04e73f0a-0fe7-4116-8c83-f44767243f45";
    const indexed = "sha256:5bee3ada65b";
    const other = "sha256:db19bbb1943";
    const untouched = "sha256:untouched-at-48";
    insertAttestation(t.raw, { digest: indexed, attemptId, transitionSequence: 47, createdAt: "2026-01-01T00:00:00.000Z" });
    insertAttestation(t.raw, { digest: other, attemptId, transitionSequence: 47, createdAt: "2026-01-01T00:00:01.000Z" });
    insertAttestation(t.raw, {
      digest: untouched,
      attemptId: "att_other-attempt",
      transitionSequence: 48,
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    insertIndexed(t.raw, { id: "idx-47", digest: indexed, sequence: 47, attemptId });

    applyMigration(t.raw, MIGRATION);

    expect(positions(t.raw, [indexed, other, untouched])).toEqual([47, null, 48]);
  });
});
