import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../test/d1.js";
import { queueSummaries } from "./queue-summaries.js";
import type { D1Like } from "./queue/projection.js";

/**
 * One line of queue per repository, for the page that lists them all.
 *
 * The dashboard's project list is where somebody arrives asking which of their
 * repositories needs them, and it could not answer: the queue was a separate
 * tab that stacked a full panel per repository, in arbitrary order, with no way
 * to see across them. Reading each queue's Durable Object to fill that list
 * would be one object request per repository per page view, which is the
 * spending the thirty-second refresh in `Queue.tsx` already exists to avoid.
 *
 * The projection is what this is for. `0005_queue_projection.sql` says so in the
 * migration itself: D1 serves "reads that span organizations — a dashboard
 * listing every queue". One query, no object reads, and it may lag, which is
 * the correct trade for a summary that links to the live view.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;
let db: D1Like;

function database(): void {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  db = t.db;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function seedOrg(): void {
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run("org_1", "10", "acme");
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run("org_2", "20", "other");
  for (const [id, org, repositoryId, name] of [
    ["p_1", "org_1", "111", "acme/one"],
    ["p_2", "org_1", "222", "acme/two"],
    ["p_3", "org_2", "333", "other/three"],
  ] as const) {
    raw
      .prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
      )
      .run(id, org, repositoryId, name);
  }
}

/** What the projection has caught up to for a queue. */
function projectedAt(repositoryId: string, generation: number): void {
  raw
    .prepare(
      `INSERT INTO queue_projection_marks (github_repository_id, base_ref, generation)
       VALUES (?, 'refs/heads/main', ?)
       ON CONFLICT (github_repository_id, base_ref) DO UPDATE SET generation = excluded.generation`,
    )
    .run(repositoryId, generation);
}

let entryOrdinal = 0;
function entry(
  repositoryId: string,
  pullRequestNumber: number,
  state: string,
  primaryReason: string | null,
  generation = 1,
): void {
  entryOrdinal += 1;
  raw
    .prepare(
      `INSERT INTO queue_entries_index
         (id, github_repository_id, base_ref, entry_id, pull_request_number, sponsor_principal_id,
          state, primary_reason, fairness_ordinal, generation)
       VALUES (?, ?, 'refs/heads/main', ?, ?, 'prn_1', ?, ?, ?, ?)`,
    )
    .run(
      `qei_${repositoryId}_${pullRequestNumber}`,
      repositoryId,
      `ent_${pullRequestNumber}`,
      pullRequestNumber,
      state,
      primaryReason,
      String(entryOrdinal).padStart(4, "0"),
      generation,
    );
}

describe("one line of queue per repository", () => {
  it("counts what is waiting and names the entry at the head", async () => {
    database();
    seedOrg();
    entry("111", 273, "Ready", null);
    entry("111", 271, "Blocked", "REQUIRED_CHECK_FAILED");

    const [summary] = await queueSummaries(db, "org_1");

    expect(summary).toEqual({
      githubRepositoryId: "111",
      waiting: 2,
      head: { pullRequestNumber: 273, state: "Ready", primaryReason: null },
    });
  });

  /**
   * The projection never deletes. Every entry the repository has ever had keeps
   * its row with whatever state it settled in, so counting rows would report a
   * repository that merged forty pull requests as forty waiting forever.
   */
  it("ignores entries that have already settled", async () => {
    database();
    seedOrg();
    entry("111", 100, "Merged", null);
    entry("111", 101, "Cancelled", "WITHDRAWN");
    entry("111", 273, "Ready", null);

    const [summary] = await queueSummaries(db, "org_1");

    expect(summary?.waiting).toBe(1);
    expect(summary?.head?.pullRequestNumber).toBe(273);
  });

  it("says nothing is at the head when every entry has settled", async () => {
    database();
    seedOrg();
    entry("111", 100, "Merged", null);

    expect(await queueSummaries(db, "org_1")).toEqual([]);
  });

  /** The head is the queue's own order, which is the ordinal the lane reads. */
  it("takes the head from the fairness order rather than the pull request number", async () => {
    database();
    seedOrg();
    entry("111", 300, "Ready", null);
    entry("111", 12, "Requested", null);

    expect((await queueSummaries(db, "org_1"))[0]?.head?.pullRequestNumber).toBe(300);
  });

  it("keeps repositories apart and answers for several at once", async () => {
    database();
    seedOrg();
    entry("111", 273, "Ready", null);
    entry("222", 88, "Active", null);

    const summaries = await queueSummaries(db, "org_1");

    expect(summaries.map((s) => [s.githubRepositoryId, s.waiting])).toEqual([
      ["111", 1],
      ["222", 1],
    ]);
  });

  /**
   * The org parameter is the whole authorisation on this read. A summary that
   * leaked across organizations would name another company's pull requests.
   */
  it("never reaches a repository belonging to another organization", async () => {
    database();
    seedOrg();
    entry("333", 5, "Ready", null);

    expect(await queueSummaries(db, "org_1")).toEqual([]);
  });
});

/**
 * A row for an entry the queue no longer has.
 *
 * The projection only ever upserts, which is right: a message carries one
 * queue's snapshot, and a projection that deleted whatever a lagging message
 * did not mention would erase live entries. But the authority compacts settled
 * entries out of its document, so an entry that leaves the live set stops
 * appearing in every later message and its row keeps whatever state it was last
 * seen in, for good.
 *
 * `entry_1315419165_184` sat in `Merging` from 5 August 2026. Pull request 184
 * had merged that afternoon; the queue stopped before it recorded the outcome,
 * and by the time it came back the entry had been compacted away. Four days
 * later this function still reported it as the head of the queue, because it is
 * not a state in `TERMINAL_ENTRY_STATES` and it holds the lowest ordinal. The
 * dashboard told everybody that a pull request merged the previous week was
 * integrating now.
 *
 * A row cannot be settled on a guess. Nothing knows whether 184 merged or was
 * abandoned, and writing `Merged` to make the page tidy is the invention this
 * whole product exists to refuse. What is knowable is that the entry is not in
 * the authority's live set, because the projection has since written a later
 * generation without it.
 */
describe("a row the queue no longer has an entry for", () => {
  it("does not report an entry left behind by compaction as the head", async () => {
    database();
    seedOrg();
    // Written when the queue still held it, and never touched again.
    entry("111", 184, "Merging", null, 3);
    entry("111", 273, "Ready", null, 9);
    projectedAt("111", 9);

    const [summary] = await queueSummaries(db, "org_1");

    expect(summary?.head?.pullRequestNumber).toBe(273);
  });

  it("does not count it as waiting either", async () => {
    database();
    seedOrg();
    entry("111", 184, "Merging", null, 3);
    entry("111", 273, "Ready", null, 9);
    projectedAt("111", 9);

    expect((await queueSummaries(db, "org_1"))[0]?.waiting).toBe(1);
  });

  /**
   * Every row of a queue nobody has projected since the column existed carries
   * generation 0, and refusing all of them would empty the dashboard on the
   * deploy that adds it. An unprojected queue is trusted whole, and the first
   * message after it corrects the set.
   */
  it("trusts every row of a queue the new mark has never been written for", async () => {
    database();
    seedOrg();
    entry("111", 273, "Ready", null, 0);
    entry("111", 271, "Blocked", "REQUIRED_CHECK_FAILED", 0);

    expect((await queueSummaries(db, "org_1"))[0]?.waiting).toBe(2);
  });
});
