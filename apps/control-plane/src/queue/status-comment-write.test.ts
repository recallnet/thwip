import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1, type TestD1 } from "../../test/d1.js";
import type { QueueSnapshot } from "./queue-operations.js";
import { projectQueueState, projectTerminalEntryHistory } from "./projection.js";
import { COMMENT_MARKER, type CommentView } from "./status-comment.js";
import {
  writeStatusComment,
  writeStatusCommentsForSnapshot,
  type CommentApi,
  type CommentWriteOutcome,
} from "./status-comment-write.js";

/**
 * The half of the feature that touches GitHub.
 *
 * Two comments on one pull request is the failure that makes a bot hated, and
 * the way it happens is not a race. It happens when the id in D1 goes missing
 * and nothing looks at the page before writing to it.
 */

const REPO = "1315419165";
const REF = "refs/heads/main";

const open: TestD1[] = [];
function db(): TestD1 {
  const t = testD1();
  open.push(t);
  t.raw.prepare("INSERT OR IGNORE INTO organizations (id, github_org_id, github_login) VALUES ('org', '1', 'owner')").run();
  t.raw.prepare(
    "INSERT OR IGNORE INTO projects (id, organization_id, github_repository_id, github_name) VALUES ('project', 'org', ?, 'owner/repo')",
  ).run(REPO);
  return t;
}
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  vi.restoreAllMocks();
});

function view(over: Partial<CommentView> = {}): CommentView {
  return {
    entryId: "e1",
    pullRequestNumber: 184,
    state: "waiting",
    position: 1,
    queued: 1,
    ahead: [],
    reason: null,
    cooldownUntil: null,
    haltReason: null,
    record: null,
    observing: false,
    ...over,
  };
}

/**
 * A GitHub that remembers what it was told, starting from whatever it is given.
 *
 * Comments are filed under the pull request they were written on, because
 * GitHub files them that way. A double that returned every comment to every
 * caller would let one pull request adopt another's, which is the exact bug the
 * marker exists to prevent, and it would report the marker as working.
 */
function github(existing: Array<{ id: number; body: string; pullRequestNumber?: number }> = []) {
  const comments = existing.map((comment) => ({
    ...comment,
    pullRequestNumber: comment.pullRequestNumber ?? 184,
  }));
  const calls: string[] = [];
  const updates: number[] = [];
  let next = 500;
  const api: CommentApi = {
    async list(pullRequestNumber) {
      calls.push("list");
      return comments.filter((comment) => comment.pullRequestNumber === pullRequestNumber);
    },
    async create(pullRequestNumber, body) {
      calls.push("create");
      const id = next++;
      comments.push({ id, body, pullRequestNumber });
      return id;
    },
    async update(commentId, body) {
      calls.push("update");
      const found = comments.find((c) => c.id === commentId);
      if (found === undefined) throw new Error(`no comment ${commentId}`);
      found.body = body;
      updates.push(found.pullRequestNumber);
    },
  };
  return { api, comments, calls, updates };
}

const WHERE = { repositoryId: REPO, baseRef: REF };
const NOW = "2026-08-04T21:14:02.000Z";

function emptySnapshot(over: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    generation: 2,
    attemptRevision: 0,
    queueEpoch: 0,
    turnSequence: 0,
    paused: false,
    pauseReason: null,
    rebaselineRequired: false,
    baseSha: null,
    activeAttemptId: null,
    activeEntryId: null,
    activeCandidate: null,
    activeDecisionDigest: null,
    chainHead: null,
    transitions: [],
    entries: [],
    ...over,
  };
}

describe("one comment per pull request", () => {
  it("does not touch GitHub after the repository removal marker lands", async () => {
    const t = db();
    t.raw.prepare(
      "INSERT INTO project_release_jobs (organization_id, github_repository_id, project_id, github_name, default_branch) VALUES ('org', ?, 'project', 'owner/repo', 'main')",
    ).run(REPO);
    const gh = github();

    expect(await writeStatusComment(t.db, gh.api, WHERE, view(), NOW)).toBe("unchanged");
    expect(gh.calls).toEqual([]);
  });

  it("writes one the first time and edits that one afterwards", async () => {
    const t = db();
    const gh = github();
    expect(await writeStatusComment(t.db, gh.api, WHERE, view(), NOW)).toBe("created");
    expect(await writeStatusComment(t.db, gh.api, WHERE, view({ state: "holds" }), NOW)).toBe("updated");
    expect(gh.comments).toHaveLength(1);
    expect(gh.calls.filter((c) => c === "create")).toHaveLength(1);
  });

  /**
   * The one that produces the second comment. A migration, a restore, or a row
   * written by a build since rolled back loses the id while the comment on the
   * page is still there.
   */
  it("adopts the comment already on the page when the stored id is lost", async () => {
    const t = db();
    const gh = github();
    await writeStatusComment(t.db, gh.api, WHERE, view(), NOW);
    t.raw.prepare("DELETE FROM queue_status_comments").run();

    expect(await writeStatusComment(t.db, gh.api, WHERE, view({ state: "holds" }), NOW)).toBe("updated");
    expect(gh.comments).toHaveLength(1);
  });

  it("passes over comments other people wrote", async () => {
    const t = db();
    const gh = github([{ id: 7, body: "looks good to me" }]);
    expect(await writeStatusComment(t.db, gh.api, WHERE, view(), NOW)).toBe("created");
    expect(gh.comments.find((c) => c.id === 7)?.body).toBe("looks good to me");
    expect(gh.comments.filter((c) => c.body.includes(COMMENT_MARKER))).toHaveLength(1);
  });
});

describe("what a queue where nothing moved costs", () => {
  it("spends no GitHub call at all when the answer has not changed", async () => {
    const t = db();
    const gh = github();
    await writeStatusComment(t.db, gh.api, WHERE, view(), NOW);
    gh.calls.length = 0;

    expect(await writeStatusComment(t.db, gh.api, WHERE, view(), "2026-08-04T22:00:00.000Z")).toBe("unchanged");
    expect(gh.calls).toEqual([]);
  });

  it("does read the page when the answer has changed, so it can find its own comment", async () => {
    const t = db();
    const gh = github();
    await writeStatusComment(t.db, gh.api, WHERE, view(), NOW);
    gh.calls.length = 0;

    await writeStatusComment(t.db, gh.api, WHERE, view({ state: "holds" }), NOW);
    expect(gh.calls).toContain("update");
  });
});

describe("a comment that cannot be written", () => {
  it("says so in the App's own logs and does not throw at the queue", async () => {
    const t = db();
    const gh = github();
    const failing: CommentApi = { ...gh.api, create: async () => Promise.reject(new Error("boom")) };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await writeStatusComment(t.db, failing, WHERE, view(), NOW)).toBe("failed");
    expect(logged.mock.calls.flat().join(" ")).toContain("184");
  });

  /**
   * A failed write that recorded its fingerprint anyway would leave the old
   * answer on the page and every later attempt would decide there was nothing
   * to say. That is the stale-comment-presented-as-current defect, arriving
   * through the cache rather than through the queue.
   */
  it("records nothing, so the next transition tries again", async () => {
    const t = db();
    const gh = github();
    let broken = true;
    const flaky: CommentApi = {
      ...gh.api,
      create: async (pullRequestNumber, body) => {
        if (broken) throw new Error("boom");
        return gh.api.create(pullRequestNumber, body);
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await writeStatusComment(t.db, flaky, WHERE, view(), NOW);
    broken = false;
    expect(await writeStatusComment(t.db, flaky, WHERE, view(), NOW)).toBe("created");
    expect(gh.comments).toHaveLength(1);
  });

  /**
   * An installation from before `issues: write` existed. The App must go on
   * merging and publish no comment, and it must say which of those happened.
   */
  it("degrades to publishing nothing when the App was never granted the permission", async () => {
    const t = db();
    const refusing: CommentApi = {
      list: async () => [],
      create: async () => Promise.reject(Object.assign(new Error("Resource not accessible"), { status: 403 })),
      update: async () => Promise.reject(Object.assign(new Error("Resource not accessible"), { status: 403 })),
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await writeStatusComment(t.db, refusing, WHERE, view(), NOW)).toBe("forbidden");
    expect(logged.mock.calls.flat().join(" ")).toContain("issues: write");
  });
});

describe("comments for entries compacted out of authority", () => {
  const blockedBody = `${COMMENT_MARKER}\n**thwip** · blocked · Review required\n`;

  async function seedTerminalBacklog(
    t: TestD1,
    entries: Array<{
      entryId: string;
      pullRequestNumber: number;
      fairnessOrdinal: string;
      generation: number;
      terminalCommentPriority?: boolean;
    }>,
    currentGeneration = 1_000,
  ) {
    await projectQueueState(t.db, {
      repositoryId: REPO,
      projectId: "project",
      baseRef: REF,
      queueEpoch: 0,
      generation: currentGeneration,
      activeAttemptId: null,
      paused: false,
      pauseReason: null,
      rebaselineRequired: false,
      baseSha: null,
      entries: [],
      transitions: [],
    });
    await projectTerminalEntryHistory(
      t.db,
      REPO,
      REF,
      entries.map((entry) => ({
        ...entry,
        sponsorPrincipalId: "alice",
        state: "Merged",
        primaryReason: null,
        schedulerEligible: false,
        cooldownUntil: null,
        lastAttemptId: null,
        headSha: entry.pullRequestNumber.toString(16).padStart(40, "0"),
        terminalCommentPriority: entry.terminalCommentPriority,
      })),
    );
    for (const entry of entries) {
      t.raw
        .prepare(
          "INSERT INTO queue_status_comments " +
            "(github_repository_id, project_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at) " +
            "VALUES (?, 'project', ?, ?, ?, 'legacy', '2026-08-04T12:00:00Z')",
        )
        .run(REPO, REF, entry.pullRequestNumber, 10_000 + entry.pullRequestNumber);
    }
    return github(
      entries.map((entry) => ({
        id: 10_000 + entry.pullRequestNumber,
        body: blockedBody,
        pullRequestNumber: entry.pullRequestNumber,
      })),
    );
  }

  async function seedTerminal(
    t: TestD1,
    state: "Merged" | "Cancelled",
  ): Promise<QueueSnapshot> {
    const transition = {
      transitionSequence: 42,
      kind: "verified-merge",
      digest: `sha256:${"c".repeat(64)}`,
      priorDigest: null,
      baseSha: "b".repeat(40),
      attemptId: "att-184",
      witnessCount: 1,
      observedAt: "2026-08-04T21:13:00.000Z",
    };
    await projectQueueState(t.db, {
      repositoryId: REPO,
      projectId: "project",
      baseRef: REF,
      queueEpoch: 0,
      generation: 2,
      activeAttemptId: null,
      paused: false,
      pauseReason: null,
      rebaselineRequired: false,
      baseSha: null,
      entries: [],
      transitions: state === "Merged" ? [transition] : [],
    });
    await projectTerminalEntryHistory(t.db, REPO, REF, [
      {
        generation: 1,
        entryId: "e1",
        pullRequestNumber: 184,
        sponsorPrincipalId: "alice",
        state,
        primaryReason: state === "Cancelled" ? "PR_CLOSED" : null,
        fairnessOrdinal: "1",
        schedulerEligible: false,
        cooldownUntil: null,
        lastAttemptId: state === "Merged" ? "att-184" : null,
        headSha: "a".repeat(40),
      },
    ]);
    return emptySnapshot({ transitions: state === "Merged" ? [transition] : [] });
  }

  async function addRetainedRepair(
    t: TestD1,
    gh: ReturnType<typeof github>,
    state: "Merged" | "Cancelled",
    generation = 1_000,
  ) {
    const retained = {
      entryId: "repair-retained",
      pullRequestNumber: 237,
      sponsorPrincipalId: "alice",
      state,
      primaryReason: null,
      schedulerEligible: false,
      fairnessOrdinal: "172",
      cooldownUntil: null,
      lastAttemptId: null,
      headSha: "a".repeat(40),
    };
    await projectTerminalEntryHistory(t.db, REPO, REF, [
      { ...retained, generation, terminalCommentPriority: true },
    ]);
    await projectQueueState(t.db, {
      repositoryId: REPO,
      baseRef: REF,
      queueEpoch: 0,
      generation,
      activeAttemptId: null,
      paused: false,
      pauseReason: null,
      rebaselineRequired: false,
      baseSha: null,
      entries: [retained],
      transitions: [],
    });
    t.raw
      .prepare(
        "INSERT INTO queue_status_comments " +
          "(github_repository_id, project_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at) " +
          "VALUES (?, 'project', ?, ?, ?, 'legacy', '2026-08-04T12:00:00Z')",
      )
      .run(REPO, REF, retained.pullRequestNumber, 10_000 + retained.pullRequestNumber);
    gh.comments.push({
      id: 10_000 + retained.pullRequestNumber,
      body: blockedBody,
      pullRequestNumber: retained.pullRequestNumber,
    });
    return retained;
  }

  it("retries a merged comment from durable history after GitHub fails and the next snapshot is empty", async () => {
    const t = db();
    const gh = github();
    await writeStatusComment(t.db, gh.api, WHERE, view({ state: "blocked", reason: "REVIEW_REQUIRED" }), NOW);
    const snapshot = await seedTerminal(t, "Merged");
    gh.calls.length = 0;
    let fail = true;
    const flaky: CommentApi = {
      ...gh.api,
      update: async (commentId, body) => {
        if (fail) throw new Error("GitHub unavailable");
        return gh.api.update(commentId, body);
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      await writeStatusCommentsForSnapshot(t.db, flaky, WHERE, snapshot, { observing: false, now: NOW }),
    ).toEqual(["failed"]);
    expect(gh.comments[0]!.body).toContain("blocked");
    fail = false;
    expect(
      await writeStatusCommentsForSnapshot(t.db, flaky, WHERE, emptySnapshot(), {
        observing: false,
        now: "2026-08-04T21:19:02.000Z",
      }),
    ).toEqual(["updated"]);
    expect(gh.comments[0]!.body).toContain("merged as record 42");

    gh.calls.length = 0;
    expect(
      await writeStatusCommentsForSnapshot(t.db, flaky, WHERE, emptySnapshot(), {
        observing: false,
        now: "2026-08-04T21:24:02.000Z",
      }),
    ).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("retires a closed-unmerged comment as cancelled and repeats without a GitHub call", async () => {
    const t = db();
    const gh = github();
    await writeStatusComment(t.db, gh.api, WHERE, view({ state: "blocked", reason: "REVIEW_REQUIRED" }), NOW);
    const snapshot = await seedTerminal(t, "Cancelled");
    gh.calls.length = 0;

    expect(
      await writeStatusCommentsForSnapshot(t.db, gh.api, WHERE, snapshot, { observing: false, now: NOW }),
    ).toEqual(["updated"]);
    expect(gh.comments[0]!.body).toContain("cancelled · this entry left the queue");
    gh.calls.length = 0;
    expect(
      await writeStatusCommentsForSnapshot(t.db, gh.api, WHERE, emptySnapshot(), { observing: false, now: NOW }),
    ).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("uses the live reopened admission when its D1 projection still shows the older ending", async () => {
    const t = db();
    const gh = github();
    await writeStatusComment(t.db, gh.api, WHERE, view({ state: "blocked", reason: "REVIEW_REQUIRED" }), NOW);
    await seedTerminal(t, "Cancelled");
    gh.calls.length = 0;
    const reopened = emptySnapshot({
      generation: 3,
      entries: [
        {
          entryId: "reopened",
          pullRequestNumber: 184,
          sponsorPrincipalId: "alice",
          state: "Ready",
          primaryReason: null,
          schedulerEligible: true,
          fairnessOrdinal: "2",
          cooldownUntil: null,
          lastAttemptId: null,
          headSha: "d".repeat(40),
        },
      ],
    });

    expect(
      await writeStatusCommentsForSnapshot(t.db, gh.api, WHERE, reopened, { observing: false, now: NOW }),
    ).toEqual(["updated"]);
    expect(gh.comments[0]!.body).toContain("position 1 of 1");
    expect(gh.comments[0]!.body).not.toContain("cancelled");
  });

  it("closes three recent repairs within a four-write pass over a production-sized backlog", async () => {
    const t = db();
    const ancient = Array.from({ length: 121 }, (_, index) => ({
      entryId: `ancient-${index + 1}`,
      pullRequestNumber: 1_000 + index,
      fairnessOrdinal: String(index + 1),
      generation: 1,
    }));
    const repaired = [
      {
        entryId: "entry-237",
        pullRequestNumber: 237,
        fairnessOrdinal: "172",
        generation: 998,
        terminalCommentPriority: true,
      },
      {
        entryId: "entry-238",
        pullRequestNumber: 238,
        fairnessOrdinal: "174",
        generation: 998,
        terminalCommentPriority: true,
      },
      {
        entryId: "entry-219",
        pullRequestNumber: 219,
        fairnessOrdinal: "184",
        generation: 998,
        terminalCommentPriority: true,
      },
    ];
    // This ordinary ending is newer than every repair. It reproduces the live
    // interleaving where PR #376 compacted during the repair pass and displaced
    // #219 when recency, rather than authority, supplied the priority.
    const ordinaryNewCompaction = {
      entryId: "ordinary-376",
      pullRequestNumber: 376,
      fairnessOrdinal: "200",
      generation: 999,
    };
    const gh = await seedTerminalBacklog(t, [...ancient, ...repaired, ordinaryNewCompaction]);
    const retained = Array.from({ length: 20 }, (_, index) => ({
      entryId: `retained-${index}`,
      pullRequestNumber: 3_000 + index,
      sponsorPrincipalId: "alice",
      state: "Merged",
      primaryReason: null,
      schedulerEligible: false,
      fairnessOrdinal: String(300 + index),
      cooldownUntil: null,
      lastAttemptId: null,
      headSha: (3_000 + index).toString(16).padStart(40, "0"),
    }));
    await projectQueueState(t.db, {
      repositoryId: REPO,
      projectId: "project",
      baseRef: REF,
      queueEpoch: 0,
      generation: 1_000,
      activeAttemptId: null,
      paused: false,
      pauseReason: null,
      rebaselineRequired: false,
      baseSha: null,
      entries: retained,
      transitions: [],
    });
    for (const entry of retained) {
      t.raw
        .prepare(
          "INSERT INTO queue_status_comments " +
            "(github_repository_id, project_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at) " +
            "VALUES (?, 'project', ?, ?, ?, 'legacy', '2026-08-04T12:00:00Z')",
        )
        .run(REPO, REF, entry.pullRequestNumber, 10_000 + entry.pullRequestNumber);
      gh.comments.push({
        id: 10_000 + entry.pullRequestNumber,
        body: blockedBody,
        pullRequestNumber: entry.pullRequestNumber,
      });
    }
    const budget = { remaining: 4 };

    await writeStatusCommentsForSnapshot(
      t.db,
      gh.api,
      WHERE,
      emptySnapshot({ generation: 1_000, entries: retained }),
      { observing: false, now: NOW },
      budget,
    );

    expect(gh.updates).toEqual([237, 238, 219, 1_000]);
    expect(budget.remaining).toBe(0);
    for (const pullRequestNumber of [237, 238, 219]) {
      expect(gh.comments.find((comment) => comment.pullRequestNumber === pullRequestNumber)?.body).toContain(
        "**thwip** · merged",
      );
    }
    expect(gh.updates).not.toContain(376);
    expect(
      t.raw
        .prepare("SELECT COUNT(*) AS count FROM queue_entries_index WHERE pull_request_number IN (219, 237, 238)")
        .get(),
    ).toEqual({ count: 0 });

    await writeStatusCommentsForSnapshot(
      t.db,
      gh.api,
      WHERE,
      emptySnapshot({ generation: 1_000, entries: retained }),
      { observing: false, now: "2026-08-04T21:19:02.000Z" },
      { remaining: 4 },
    );
    for (const pullRequestNumber of [237, 238, 219]) {
      expect(gh.updates.filter((updated) => updated === pullRequestNumber)).toHaveLength(1);
    }
  });

  it("retries a retained repair ahead of 121 old rows after failure and projection replay", async () => {
    const t = db();
    const ancient = Array.from({ length: 121 }, (_, index) => ({
      entryId: `ancient-${index + 1}`,
      pullRequestNumber: 1_000 + index,
      fairnessOrdinal: String(index + 1),
      generation: 1,
    }));
    const gh = await seedTerminalBacklog(t, ancient, 999);
    const retained = await addRetainedRepair(t, gh, "Merged");

    let failing = true;
    const flaky: CommentApi = {
      ...gh.api,
      update: async (commentId, body) => {
        const comment = gh.comments.find((candidate) => candidate.id === commentId);
        if (failing && comment?.pullRequestNumber === 237) throw new Error("GitHub unavailable");
        await gh.api.update(commentId, body);
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await writeStatusCommentsForSnapshot(
      t.db,
      flaky,
      WHERE,
      emptySnapshot({ generation: 1_000, entries: [retained] }),
      { observing: false, now: NOW },
      { remaining: 1 },
    );
    expect(gh.updates).toEqual([]);
    expect(
      t.raw
        .prepare("SELECT state, terminal_comment_priority FROM queue_entries_index WHERE entry_id = ?")
        .get(retained.entryId),
    ).toEqual({ state: "Merged", terminal_comment_priority: 1 });

    await projectQueueState(t.db, {
      repositoryId: REPO,
      baseRef: REF,
      queueEpoch: 0,
      generation: 1_001,
      activeAttemptId: null,
      paused: false,
      pauseReason: null,
      rebaselineRequired: false,
      baseSha: null,
      entries: [retained],
      transitions: [],
    });
    failing = false;
    await writeStatusCommentsForSnapshot(
      t.db,
      flaky,
      WHERE,
      emptySnapshot({ generation: 1_001, entries: [retained] }),
      { observing: false, now: NOW },
      { remaining: 1 },
    );

    expect(gh.updates).toEqual([237]);
    expect(
      t.raw
        .prepare("SELECT state, terminal_comment_priority FROM queue_entries_index WHERE entry_id = ?")
        .get(retained.entryId),
    ).toEqual({ state: "Merged", terminal_comment_priority: 0 });
  });

  it("drains more than one budget of repairs while giving one oldest row each pass", async () => {
    const t = db();
    const priority = Array.from({ length: 7 }, (_, index) => ({
      entryId: `repair-${index + 1}`,
      pullRequestNumber: 200 + index,
      fairnessOrdinal: String(100 + index),
      generation: 900 + index,
      terminalCommentPriority: true,
    }));
    const ordinary = Array.from({ length: 3 }, (_, index) => ({
      entryId: `ordinary-${index + 1}`,
      pullRequestNumber: 1_000 + index,
      fairnessOrdinal: String(index + 1),
      generation: 1,
    }));
    const gh = await seedTerminalBacklog(t, [...ordinary, ...priority]);

    for (let pass = 0; pass < 3; pass += 1) {
      await writeStatusCommentsForSnapshot(
        t.db,
        gh.api,
        WHERE,
        emptySnapshot({ generation: 1_000 }),
        { observing: false, now: NOW },
        { remaining: 4 },
      );
    }

    expect(gh.updates).toEqual([200, 201, 202, 1_000, 203, 204, 205, 1_001, 206, 1_002]);
    expect(t.raw.prepare("SELECT COUNT(*) AS count FROM queue_entries_index").get()).toEqual({ count: 0 });
  });

  it("advances the oldest history while three newer repairs arrive on every pass", async () => {
    const t = db();
    const ancient = Array.from({ length: 5 }, (_, index) => ({
      entryId: `ancient-${index + 1}`,
      pullRequestNumber: 1_000 + index,
      fairnessOrdinal: String(index + 1),
      generation: 1,
    }));
    const gh = await seedTerminalBacklog(t, ancient);

    for (let pass = 0; pass < ancient.length; pass += 1) {
      const recent = Array.from({ length: 3 }, (_, index) => ({
        entryId: `recent-${pass}-${index}`,
        pullRequestNumber: 2_000 + pass * 3 + index,
        fairnessOrdinal: String(200 + pass * 3 + index),
        generation: 900 + pass,
      }));
      await projectTerminalEntryHistory(t.db, REPO, REF, recent.map((entry) => ({
        ...entry,
        sponsorPrincipalId: "alice",
        state: "Merged",
        primaryReason: null,
        schedulerEligible: false,
        cooldownUntil: null,
        lastAttemptId: null,
        headSha: entry.pullRequestNumber.toString(16).padStart(40, "0"),
        terminalCommentPriority: true,
      })));
      for (const entry of recent) {
        t.raw
          .prepare(
            "INSERT INTO queue_status_comments " +
              "(github_repository_id, project_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at) " +
              "VALUES (?, 'project', ?, ?, ?, 'legacy', '2026-08-04T12:00:00Z')",
          )
          .run(REPO, REF, entry.pullRequestNumber, 10_000 + entry.pullRequestNumber);
        gh.comments.push({
          id: 10_000 + entry.pullRequestNumber,
          body: blockedBody,
          pullRequestNumber: entry.pullRequestNumber,
        });
      }

      await writeStatusCommentsForSnapshot(
        t.db,
        gh.api,
        WHERE,
        emptySnapshot({ generation: 1_000 }),
        { observing: false, now: NOW },
        { remaining: 4 },
      );
    }

    expect(gh.updates.filter((pullRequestNumber) => pullRequestNumber < 2_000)).toEqual([
      1_000,
      1_001,
      1_002,
      1_003,
      1_004,
    ]);
  });

  it("keeps a failed recent repair durable and retries it before later history", async () => {
    const t = db();
    const entries = [
      {
        entryId: "recent-fails",
        pullRequestNumber: 237,
        fairnessOrdinal: "172",
        generation: 999,
        terminalCommentPriority: true,
      },
      {
        entryId: "recent-2",
        pullRequestNumber: 238,
        fairnessOrdinal: "174",
        generation: 999,
        terminalCommentPriority: true,
      },
      {
        entryId: "recent-3",
        pullRequestNumber: 219,
        fairnessOrdinal: "184",
        generation: 999,
        terminalCommentPriority: true,
      },
      { entryId: "ancient", pullRequestNumber: 1_000, fairnessOrdinal: "1", generation: 1 },
    ];
    const gh = await seedTerminalBacklog(t, entries);
    let failing = true;
    const flaky: CommentApi = {
      ...gh.api,
      update: async (commentId, body) => {
        const comment = gh.comments.find((candidate) => candidate.id === commentId);
        if (failing && comment?.pullRequestNumber === 237) throw new Error("GitHub unavailable");
        await gh.api.update(commentId, body);
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await writeStatusCommentsForSnapshot(
      t.db,
      flaky,
      WHERE,
      emptySnapshot({ generation: 1_000 }),
      { observing: false, now: NOW },
      { remaining: 4 },
    );
    expect(
      t.raw
        .prepare("SELECT state, terminal_comment_priority FROM queue_entries_index WHERE pull_request_number = 237")
        .get(),
    ).toEqual({ state: "Merged", terminal_comment_priority: 1 });
    expect(gh.updates).toEqual([238, 219, 1_000]);

    failing = false;
    await writeStatusCommentsForSnapshot(
      t.db,
      flaky,
      WHERE,
      emptySnapshot({ generation: 1_000 }),
      { observing: false, now: NOW },
      { remaining: 4 },
    );
    expect(gh.updates).toContain(237);
    expect(
      t.raw.prepare("SELECT state FROM queue_entries_index WHERE pull_request_number = 237").get(),
    ).toBeUndefined();
  });

  it("acknowledges a permission refusal without starving later terminal history", async () => {
    const t = db();
    const repair = {
      entryId: "repair-forbidden",
      pullRequestNumber: 237,
      fairnessOrdinal: "172",
      generation: 999,
      terminalCommentPriority: true,
    };
    const ancient = {
      entryId: "ancient-after-forbidden",
      pullRequestNumber: 1_000,
      fairnessOrdinal: "1",
      generation: 1,
    };
    const gh = await seedTerminalBacklog(t, [ancient, repair]);
    const refusing: CommentApi = {
      ...gh.api,
      update: async (commentId, body) => {
        const comment = gh.comments.find((candidate) => candidate.id === commentId);
        if (comment?.pullRequestNumber === 237) {
          throw Object.assign(new Error("Resource not accessible"), { status: 403 });
        }
        await gh.api.update(commentId, body);
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      await writeStatusCommentsForSnapshot(
        t.db,
        refusing,
        WHERE,
        emptySnapshot({ generation: 1_000 }),
        { observing: false, now: NOW },
        { remaining: 4 },
      ),
    ).toEqual(["forbidden", "updated"]);
    expect(gh.updates).toEqual([1_000]);
    expect(
      t.raw
        .prepare("SELECT state, terminal_comment_priority FROM queue_entries_index WHERE pull_request_number = 237")
        .get(),
    ).toEqual({ state: "Merged", terminal_comment_priority: 2 });

    gh.calls.length = 0;
    expect(
      await writeStatusCommentsForSnapshot(
        t.db,
        gh.api,
        WHERE,
        emptySnapshot({ generation: 1_000 }),
        { observing: false, now: NOW },
        { remaining: 4 },
      ),
    ).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("does not retry a forbidden repaired ending still retained in authority", async () => {
    const t = db();
    const gh = github();
    const retained = await addRetainedRepair(t, gh, "Cancelled");
    const refusing: CommentApi = {
      ...gh.api,
      update: async () => Promise.reject(Object.assign(new Error("Resource not accessible"), { status: 403 })),
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const snapshot = emptySnapshot({ generation: 1_000, entries: [retained] });

    expect(
      await writeStatusCommentsForSnapshot(
        t.db,
        refusing,
        WHERE,
        snapshot,
        { observing: false, now: NOW },
        { remaining: 4 },
      ),
    ).toEqual(["forbidden"]);
    gh.calls.length = 0;
    expect(
      await writeStatusCommentsForSnapshot(
        t.db,
        gh.api,
        WHERE,
        snapshot,
        { observing: false, now: NOW },
        { remaining: 4 },
      ),
    ).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("publishes a reopened live admission before terminal backlog and never restores its old ending", async () => {
    const t = db();
    const oldAdmission = {
      entryId: "old-184",
      pullRequestNumber: 184,
      fairnessOrdinal: "1",
      generation: 999,
      terminalCommentPriority: true,
    };
    const legacy = Array.from({ length: 121 }, (_, index) => ({
      entryId: `legacy-${index}`,
      pullRequestNumber: 1_000 + index,
      fairnessOrdinal: String(index + 2),
      generation: 1,
    }));
    const gh = await seedTerminalBacklog(t, [oldAdmission, ...legacy]);
    const reopened = emptySnapshot({
      generation: 1_000,
      entries: [
        {
          entryId: "reopened-184",
          pullRequestNumber: 184,
          sponsorPrincipalId: "alice",
          state: "Ready",
          primaryReason: null,
          schedulerEligible: true,
          fairnessOrdinal: "200",
          cooldownUntil: null,
          lastAttemptId: null,
          headSha: "d".repeat(40),
        },
      ],
    });

    await writeStatusCommentsForSnapshot(
      t.db,
      gh.api,
      WHERE,
      reopened,
      { observing: false, now: NOW },
      { remaining: 4 },
    );

    expect(gh.updates[0]).toBe(184);
    expect(gh.comments.find((comment) => comment.pullRequestNumber === 184)?.body).toContain("position 1 of 1");
    expect(gh.comments.find((comment) => comment.pullRequestNumber === 184)?.body).not.toContain("merged");
  });
});

/**
 * What the App may open a conversation about.
 *
 * Found live on 4 August. The queue document keeps every entry it has ever
 * held, so the first tick after this shipped walked fourteen pull requests that
 * merged weeks ago and tried to write a comment on each. It spent the Worker's
 * whole subrequest budget and took the tick down with it, and had it succeeded
 * it would have mailed fourteen closed pull requests.
 *
 * A merged pull request is worth a line only where thwip was already talking.
 */
describe("which states may say the first word", () => {
  it("says nothing on a pull request that merged before thwip ever commented", async () => {
    const t = db();
    const gh = github();

    expect(await writeStatusComment(t.db, gh.api, WHERE, view({ state: "merged" }), NOW)).toBe("unchanged");
    expect(gh.calls).toEqual([]);
    expect(gh.comments).toEqual([]);
  });

  it("still collapses the comment it had been keeping, once that entry merges", async () => {
    const t = db();
    const gh = github();
    await writeStatusComment(t.db, gh.api, WHERE, view(), NOW);

    expect(
      await writeStatusComment(
        t.db,
        gh.api,
        WHERE,
        view({ state: "merged", record: { sequence: 42, digest: "c".repeat(64) } }),
        NOW,
      ),
    ).toBe("updated");
    expect(gh.comments[0]!.body).toContain("42");
  });

  it("opens no conversation to announce a branch it never managed out loud", async () => {
    const t = db();
    const gh = github();

    expect(await writeStatusComment(t.db, gh.api, WHERE, view({ state: "untracked" }), NOW)).toBe("unchanged");
    expect(gh.comments).toEqual([]);
  });

  it("says nothing on an entry that was cancelled without ever being commented on", async () => {
    const t = db();
    const gh = github();

    expect(await writeStatusComment(t.db, gh.api, WHERE, view({ state: "cancelled" }), NOW)).toBe("unchanged");
    expect(gh.comments).toEqual([]);
  });
});

/**
 * What one pass over a queue may spend.
 *
 * A Worker invocation gets fifty subrequests, and each comment costs up to two.
 * The queue document keeps every entry it has ever held, so a repository with
 * any history has more entries than one invocation can pay for. On 4 August the
 * sweep hit that ceiling and lost the whole tick to it.
 *
 * Unchanged comments are free and are not counted. The cap is on writes, so a
 * backlog drains over a few ticks instead of failing on every one.
 */
describe("the budget one sweep works to", () => {
  it("stops writing once it has spent its budget, and says how much it spent", async () => {
    const t = db();
    const gh = github();
    const budget = { remaining: 2 };

    const spent: CommentWriteOutcome[] = [];
    for (const pullRequestNumber of [1, 2, 3, 4]) {
      spent.push(await writeStatusComment(t.db, gh.api, WHERE, view({ pullRequestNumber }), NOW, budget));
    }

    expect(spent).toEqual(["created", "created", "over-budget", "over-budget"]);
    expect(gh.comments).toHaveLength(2);
  });

  it("spends nothing on a comment that already says the right thing", async () => {
    const t = db();
    const gh = github();
    await writeStatusComment(t.db, gh.api, WHERE, view(), NOW);
    const budget = { remaining: 1 };

    await writeStatusComment(t.db, gh.api, WHERE, view(), NOW, budget);
    expect(budget.remaining).toBe(1);
  });
});

describe("project incarnation fencing", () => {
  it("does not let a delayed status write replace the reselected project's row", async () => {
    const t = db();
    t.raw.prepare("DELETE FROM projects WHERE id = 'project'").run();
    t.raw
      .prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name) VALUES ('project_new', 'org', ?, 'owner/repo')",
      )
      .run(REPO);
    t.raw
      .prepare(
        `INSERT INTO queue_status_comments
           (github_repository_id, project_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at)
         VALUES (?, 'project_new', ?, 184, 88, 'fresh', ?)`,
      )
      .run(REPO, REF, NOW);
    const gh = github([{ id: 88, body: `${COMMENT_MARKER}\nfresh`, pullRequestNumber: 184 }]);

    expect(await writeStatusComment(t.db, gh.api, WHERE, view(), NOW, undefined, "project")).toBe("failed");
    expect(
      t.raw.prepare("SELECT project_id AS projectId, fingerprint FROM queue_status_comments WHERE comment_id = 88").get(),
    ).toEqual({ projectId: "project_new", fingerprint: "fresh" });
  });
});
