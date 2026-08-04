import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1, type TestD1 } from "../../test/d1.js";
import { COMMENT_MARKER, type CommentView } from "./status-comment.js";
import { writeStatusComment, type CommentApi, type CommentWriteOutcome } from "./status-comment-write.js";

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
function github(existing: Array<{ id: number; body: string }> = []) {
  const comments = existing.map((comment) => ({ ...comment, pullRequestNumber: 184 }));
  const calls: string[] = [];
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
    },
  };
  return { api, comments, calls };
}

const WHERE = { repositoryId: REPO, baseRef: REF };
const NOW = "2026-08-04T21:14:02.000Z";

describe("one comment per pull request", () => {
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
