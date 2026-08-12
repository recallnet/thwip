import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import type { D1Like } from "./projection.js";
import { loadQueueState, QueueProjectRemovedError, withQueueState } from "./queue-state.js";
import type { SnapshotQueueStore } from "./snapshot-store.js";
import type { SubmittedEvent } from "./store.js";

/**
 * Durable Objects were serialising the queue by being single-threaded. D1 is
 * not, so the ordering has to be made explicit: read the document with its
 * generation, write it back only if the generation is still what it was.
 *
 * These are the races that used to be impossible and now have to be handled.
 */

const open: Array<{ close(): void }> = [];

function d1(): D1Like {
  const t = testD1();
  open.push(t);
  return t.db;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";

let n = 0;
function request(store: SnapshotQueueStore, entryId: string, pr: number, key?: string) {
  n += 1;
  return store.append({
    idempotencyKey: key ?? `k${n}`,
    at: new Date(Date.UTC(2026, 6, 31, 6, 0, n)).toISOString(),
    type: "QueueRequested",
    entryId,
    pullRequestNumber: pr,
    sponsorPrincipalId: "alice",
    sponsorGithubUserId: "1",
    headSha: "h".repeat(40),
  } as SubmittedEvent);
}

describe("the queue document in D1", () => {
  it("starts empty for a queue nobody has written", async () => {
    const loaded = await loadQueueState(d1(), REPO, REF);
    expect(loaded.store.state().entries.size).toBe(0);
    expect(loaded.store.generation()).toBe(0);
  });

  it("writes what the commands did, and reads it back", async () => {
    const db = d1();
    const first = await loadQueueState(db, REPO, REF);
    request(first.store, "e1", 59);
    expect(await first.save()).toBe("saved");

    const second = await loadQueueState(db, REPO, REF);
    expect(second.store.state().entries.get("e1")?.pullRequestNumber).toBe(59);
  });

  it("writes nothing when the commands changed nothing", async () => {
    const db = d1();
    const loaded = await loadQueueState(db, REPO, REF);
    expect(await loaded.save()).toBe("unchanged");
    const row = await db
      .prepare("SELECT COUNT(*) AS c FROM queue_state")
      .bind()
      .first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it("keeps repositories and branches apart", async () => {
    const db = d1();
    const mine = await loadQueueState(db, REPO, REF);
    request(mine.store, "e1", 59);
    await mine.save();

    expect((await loadQueueState(db, "999", REF)).store.state().entries.size).toBe(0);
    expect((await loadQueueState(db, REPO, "refs/heads/release")).store.state().entries.size).toBe(0);
  });

  it("does not create a queue after the repository removal marker lands", async () => {
    const test = testD1();
    open.push(test);
    test.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org', '1', 'owner')").run();
    test.raw.prepare(
      "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES ('org', ?, 'now', '7')",
    ).run(REPO);
    const loaded = await loadQueueState(test.db, REPO, REF);
    request(loaded.store, "e1", 59);
    expect(await loaded.save()).toBe("removed");
    expect(test.raw.prepare("SELECT COUNT(*) AS n FROM queue_state").get()).toEqual({ n: 0 });
  });

  it("does not update a queue after the repository removal marker lands", async () => {
    const test = testD1();
    open.push(test);
    test.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org', '1', 'owner')").run();
    const loaded = await loadQueueState(test.db, REPO, REF);
    request(loaded.store, "e1", 59);
    expect(await loaded.save()).toBe("saved");
    test.raw.prepare(
      "INSERT INTO removed_projects (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id) VALUES ('org', ?, 'now', '7')",
    ).run(REPO);
    const stale = await loadQueueState(test.db, REPO, REF);
    request(stale.store, "e2", 61);
    expect(await stale.save()).toBe("removed");
    await expect(withQueueState(test.db, REPO, REF, (store) => request(store, "e3", 62))).rejects.toBeInstanceOf(
      QueueProjectRemovedError,
    );
  });

  describe("two writers at once", () => {
    it("refuses the second write rather than overwriting the first", async () => {
      const db = d1();
      // Both read the same generation, which is what concurrent requests do.
      const a = await loadQueueState(db, REPO, REF);
      const b = await loadQueueState(db, REPO, REF);

      request(a.store, "e1", 59);
      request(b.store, "e2", 61);

      expect(await a.save()).toBe("saved");
      expect(await b.save()).toBe("conflict");

      // And the loser's work is absent rather than half-applied.
      const after = await loadQueueState(db, REPO, REF);
      expect([...after.store.state().entries.keys()]).toEqual(["e1"]);
    });

    it("retries the loser against the winner's state, so neither is lost", async () => {
      const db = d1();
      let ran = 0;
      const other = await loadQueueState(db, REPO, REF);

      const result = await withQueueState(db, REPO, REF, (store) => {
        ran += 1;
        // The first pass races: another writer commits between this load and its
        // save. The retry sees that writer's entry and adds to it.
        if (ran === 1) {
          request(other.store, "e1", 59, "other");
        }
        request(store, "e2", 61, "mine");
        return store.state().entries.size;
      }, {
        beforeSave: async () => {
          if (ran === 1) await other.save();
        },
      });

      expect(ran).toBe(2);
      expect(result).toBe(2);
      const after = await loadQueueState(db, REPO, REF);
      expect([...after.store.state().entries.keys()].sort()).toEqual(["e1", "e2"]);
    });

    it("gives up rather than spinning when it keeps losing", async () => {
      const db = d1();
      await expect(
        withQueueState(db, REPO, REF, (store) => request(store, "e2", 61, "mine"), {
          // Somebody else commits before every single attempt.
          beforeSave: async () => {
            const other = await loadQueueState(db, REPO, REF);
            request(other.store, `e${Math.random()}`, 1);
            await other.save();
          },
        }),
      ).rejects.toThrow(/could not commit/i);
    });
  });
});
