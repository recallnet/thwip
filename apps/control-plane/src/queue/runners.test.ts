import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import type { D1Like } from "./projection.js";
import { DEFAULT_TIMINGS } from "./commands.js";
import {
  GRACE_SECONDS,
  deviceKeyClaimedByAnother,
  enrolDeviceKey,
  HEARTBEAT_INTERVAL_SECONDS,
  SWEEP_INTERVAL_SECONDS,
  isPrincipalConnected,
  recordHeartbeat,
  retireStaleRunners,
} from "./runners.js";

/**
 * Runner liveness, the piece that lets `fresh` ever be offered a turn
 * (plan.md §5.0). A heartbeat row means "a runner said it was here", nothing
 * more. Eligibility only cares about the absent-to-present and
 * present-to-absent transitions, never every heartbeat in between.
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
const T0 = "2026-07-31T00:00:00.000Z";

describe("the interval and the grace window", () => {
  it("gives a runner room for a couple of missed beats before it is considered gone", () => {
    expect(GRACE_SECONDS).toBeGreaterThan(HEARTBEAT_INTERVAL_SECONDS);
  });
});

describe("the cooldown and the sweep", () => {
  // plan.md:1208 permits exactly one bounded lost turn to a dead runner, not
  // a repeating one. A dead runner's entry keeps its stale eligibility until
  // the next sweep, so an offer can still reach it inside that window; once
  // that offer expires unclaimed, the cooldown `commands.ts` sets on it has
  // to outlast the wait for the sweep that finally retires the runner, or
  // the queue can offer it again before it is gone. Asserting the inequality
  // directly — not restating today's `300 >= 300` as two literals — is what
  // makes moving one constant without the other fail here instead of only
  // in production, on a queue that keeps losing turns to a dead machine.
  it("holds a runner's unclaimed offer in cooldown at least until the sweep can retire it", () => {
    expect(DEFAULT_TIMINGS.noClaimCooldownSeconds).toBeGreaterThanOrEqual(SWEEP_INTERVAL_SECONDS);
  });
});

describe("recordHeartbeat", () => {
  it("reports the absent-to-present transition on the first heartbeat", async () => {
    const db = d1();
    const outcome = await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "d1", now: T0 });
    expect(outcome.wasOffline).toBe(true);
  });

  it("does not report a transition on a second heartbeat from the same device", async () => {
    const db = d1();
    await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "d1", now: T0 });
    const T1 = new Date(new Date(T0).getTime() + HEARTBEAT_INTERVAL_SECONDS * 1000).toISOString();
    const outcome = await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "d1", now: T1 });
    expect(outcome.wasOffline).toBe(false);
  });

  it("does not report a transition from a second device once the principal is already present", async () => {
    const db = d1();
    await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "d1", now: T0 });
    const outcome = await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "d2", now: T0 });
    expect(outcome.wasOffline).toBe(false);
  });

  it("reports a fresh arrival again once the grace window has fully elapsed", async () => {
    const db = d1();
    await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "d1", now: T0 });
    const later = new Date(new Date(T0).getTime() + (GRACE_SECONDS + 1) * 1000).toISOString();
    const outcome = await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "d1", now: later });
    expect(outcome.wasOffline).toBe(true);
  });

  it("keeps one principal's two machines as separate rows", async () => {
    const db = d1();
    await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "laptop", now: T0 });
    await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "desktop", now: T0 });
    const stale = await retireStaleRunners(
      db,
      REPO,
      new Date(new Date(T0).getTime() + (GRACE_SECONDS + 1) * 1000).toISOString(),
    );
    // Both rows go stale together here, so the offline report still names
    // alice exactly once, not twice.
    expect(stale).toEqual(["alice"]);
  });
});

describe("isPrincipalConnected", () => {
  it("is false before any heartbeat and true right after one", async () => {
    const db = d1();
    expect(await isPrincipalConnected(db, REPO, "alice", T0)).toBe(false);
    await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "d1", now: T0 });
    expect(await isPrincipalConnected(db, REPO, "alice", T0)).toBe(true);
  });
});

describe("retireStaleRunners", () => {
  it("leaves a runner still inside the grace window alone", async () => {
    const db = d1();
    await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "d1", now: T0 });
    const soon = new Date(new Date(T0).getTime() + 1000).toISOString();
    expect(await retireStaleRunners(db, REPO, soon)).toEqual([]);
    expect(await isPrincipalConnected(db, REPO, "alice", soon)).toBe(true);
  });

  it("retires a runner whose heartbeat fell out of the grace window and reports it offline", async () => {
    const db = d1();
    await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "d1", now: T0 });
    const later = new Date(new Date(T0).getTime() + (GRACE_SECONDS + 1) * 1000).toISOString();
    expect(await retireStaleRunners(db, REPO, later)).toEqual(["alice"]);
    expect(await isPrincipalConnected(db, REPO, "alice", later)).toBe(false);
  });

  it("does not report a principal offline while one of their devices is still live", async () => {
    const db = d1();
    await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "laptop", now: T0 });
    const later = new Date(new Date(T0).getTime() + (GRACE_SECONDS + 1) * 1000).toISOString();
    // The desktop heartbeats again right before the sweep; the laptop does not.
    await recordHeartbeat(db, { repositoryId: REPO, principalId: "alice", deviceKeyId: "desktop", now: later });
    expect(await retireStaleRunners(db, REPO, later)).toEqual([]);
    expect(await isPrincipalConnected(db, REPO, "alice", later)).toBe(true);
  });

  it("does not touch another repository's runners", async () => {
    const db = d1();
    await recordHeartbeat(db, { repositoryId: "other_repo", principalId: "alice", deviceKeyId: "d1", now: T0 });
    const later = new Date(new Date(T0).getTime() + (GRACE_SECONDS + 1) * 1000).toISOString();
    expect(await retireStaleRunners(db, REPO, later)).toEqual([]);
    expect(await isPrincipalConnected(db, "other_repo", "alice", later)).toBe(false);
  });
});

/**
 * What a device key is called, and why it can only be one thing.
 *
 * Every reader of `device_keys` looks a key up by `key_id` holding a
 * fingerprint: the receipt route resolves the key a device signed with, the
 * heartbeat route checks the key is not somebody else's or revoked, and the
 * verification bundle caches GitHub-published keys under it. Enrolment minted
 * its own `key_...` id instead, so a key enrolled through `POST /v1/devices`
 * answered none of those lookups — and because the fingerprint column is
 * unique, its row also kept the bundle from ever caching the same key under the
 * id the readers do use. The documented way to enrol a device produced a key
 * that could not sign anything this deployment would accept.
 */
describe("enrolDeviceKey", () => {
  const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0000000000000000000000000000000000000000 laptop";

  it("names an enrolled key by its fingerprint, which is what every reader looks it up by", async () => {
    const db = d1();
    const enrolled = await enrolDeviceKey(db, { githubUserId: "1", publicKey: PUBLIC_KEY, label: "laptop" });
    expect(enrolled).not.toBeNull();
    expect(enrolled!.keyId).toBe(enrolled!.fingerprint);

    const row = await db
      .prepare("SELECT github_user_id AS githubUserId FROM device_keys WHERE key_id = ?")
      .bind(enrolled!.fingerprint)
      .first<{ githubUserId: string }>();
    expect(row?.githubUserId).toBe("1");
  });

  it("lets the heartbeat route recognize the key it just enrolled", async () => {
    const db = d1();
    const enrolled = await enrolDeviceKey(db, { githubUserId: "1", publicKey: PUBLIC_KEY, label: "laptop" });
    expect(await deviceKeyClaimedByAnother(db, enrolled!.keyId, "1")).toBe(false);
    expect(await deviceKeyClaimedByAnother(db, enrolled!.keyId, "2")).toBe(true);
  });

  it("refuses a key already enrolled, rather than issuing a second id for it", async () => {
    const db = d1();
    await enrolDeviceKey(db, { githubUserId: "1", publicKey: PUBLIC_KEY, label: "laptop" });
    expect(await enrolDeviceKey(db, { githubUserId: "1", publicKey: PUBLIC_KEY, label: "again" })).toBeNull();
  });
});
