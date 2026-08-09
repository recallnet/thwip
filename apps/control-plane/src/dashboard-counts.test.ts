import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../test/d1.js";
import { dashboardCounts } from "./dashboard-counts.js";
import type { D1Like } from "./queue/projection.js";

/**
 * What the organization page counts.
 *
 * Every dashboard route begins by resolving a Better Auth session, so none of
 * them has a test. The counting is what can be wrong, so the counting is what is
 * tested here.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;
let db: D1Like;

function fresh(): void {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  db = t.db as unknown as D1Like;
  for (const [id, login] of [
    ["org_1", "acme"],
    ["org_2", "other"],
  ]) {
    raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run(id, login, login);
  }
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function member(orgId: string, principalId: string, githubUserId: string, activated = true): void {
  raw
    .prepare(
      `INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at)
       VALUES (?, ?, ?, ?, ${activated ? "datetime('now')" : "NULL"})`,
    )
    .run(principalId, orgId, githubUserId, `user${githubUserId}`);
}

function signingKey(keyId: string, githubUserId: string, revoked = false): void {
  raw
    .prepare(
      `INSERT INTO device_keys (key_id, github_user_id, algorithm, public_key, fingerprint, device_label, revoked_at)
       VALUES (?, ?, 'ssh-ed25519', 'pk', ?, 'laptop', ${revoked ? "datetime('now')" : "NULL"})`,
    )
    .run(keyId, githubUserId, `SHA256:${keyId}`);
}

describe("what an organization is told about itself", () => {
  /**
   * The key tally had no organization in it at all: `COUNT(*) FROM device_keys
   * WHERE revoked_at IS NULL`, across the whole deployment. An organization with
   * one member was shown everybody else's keys as its own.
   */
  it("counts only the keys held by its own members", async () => {
    fresh();
    member("org_1", "alice", "1");
    member("org_2", "bob", "2");
    signingKey("k_alice", "1");
    signingKey("k_bob", "2");

    const counts = await dashboardCounts(db, { organizationId: "org_1", githubUserId: "1" });
    expect(counts.activeKeys).toBe(1);
  });

  it("does not count a key that has been denied", async () => {
    fresh();
    member("org_1", "alice", "1");
    signingKey("k_live", "1");
    signingKey("k_gone", "1", true);

    expect((await dashboardCounts(db, { organizationId: "org_1", githubUserId: "1" })).activeKeys).toBe(1);
  });

  it("counts a member of two organizations once in each", async () => {
    fresh();
    member("org_1", "alice", "1");
    member("org_2", "alice_elsewhere", "1");
    signingKey("k_alice", "1");

    expect((await dashboardCounts(db, { organizationId: "org_1", githubUserId: "1" })).activeKeys).toBe(1);
    expect((await dashboardCounts(db, { organizationId: "org_2", githubUserId: "1" })).activeKeys).toBe(1);
  });
});

/**
 * The prompt that told everybody, forever, to go and set their machine up. It
 * was shown to every member of every organization whether or not they had ever
 * signed anything, which is how a page teaches people to stop reading it.
 */
describe("whether this reader still has to set a machine up", () => {
  it("says so while they hold no key that could sign", async () => {
    fresh();
    member("org_1", "alice", "1");

    expect((await dashboardCounts(db, { organizationId: "org_1", githubUserId: "1" })).viewerHasSigningKey).toBe(false);
  });

  it("stops saying so once they have one", async () => {
    fresh();
    member("org_1", "alice", "1");
    signingKey("k_alice", "1");

    expect((await dashboardCounts(db, { organizationId: "org_1", githubUserId: "1" })).viewerHasSigningKey).toBe(true);
  });

  /** A colleague's key is not this reader's machine. */
  it("does not count somebody else's key as this reader's", async () => {
    fresh();
    member("org_1", "alice", "1");
    member("org_1", "carol", "3");
    signingKey("k_carol", "3");

    const counts = await dashboardCounts(db, { organizationId: "org_1", githubUserId: "1" });
    expect(counts.activeKeys).toBe(1);
    expect(counts.viewerHasSigningKey).toBe(false);
  });

  it("goes back to saying so if their only key is denied", async () => {
    fresh();
    member("org_1", "alice", "1");
    signingKey("k_alice", "1", true);

    expect((await dashboardCounts(db, { organizationId: "org_1", githubUserId: "1" })).viewerHasSigningKey).toBe(false);
  });
});
