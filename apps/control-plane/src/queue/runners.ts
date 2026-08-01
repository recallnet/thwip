import type { D1Like } from "./projection.js";

/**
 * Runner liveness: is a connected machine here to take a `fresh` turn (plan.md §5.0).
 *
 * There is no fallback to GitHub Actions under `fresh` or `audited`. A device
 * heartbeats into a row here; `readiness.ts` reads that presence as
 * `compatibleRunnerConnected`. Absence keeps an entry's fairness ordinal and
 * simply withholds an offer, per the specification (plan.md §452) — it must
 * never freeze the branch behind a closed laptop.
 *
 * The interval and the grace window live in one place on purpose. A grace
 * window shorter than the heartbeat interval would retire a healthy runner
 * every cycle, so the relationship between the two is asserted directly
 * against these constants rather than restated as literals in a test.
 */

/** How often a watching runner is expected to say it is still here. */
export const HEARTBEAT_INTERVAL_SECONDS = 15;

/**
 * How long a runner is still considered present after its last heartbeat.
 * Wider than the interval so a couple of missed beats — a slow network, a
 * laptop waking up — do not read as offline.
 *
 * This is not the bound that actually protects a queue from a dead runner.
 * That bound is the one below: a dead runner's entry keeps its now-stale
 * eligibility until the next sweep, so the queue can still offer it a turn
 * inside that window. When it does, the offer expires unclaimed and
 * `commands.ts`'s `noClaimCooldownSeconds` puts the entry in cooldown — and
 * that cooldown has to last at least until the next sweep retires the
 * runner, or a second offer can reach the same dead machine before it is
 * ever retired, and a third, unboundedly. plan.md:1208 permits exactly one
 * bounded lost turn, not a repeating one. Today `noClaimCooldownSeconds`
 * (300s, `commands.ts`) equals `SWEEP_INTERVAL_SECONDS` (300s, below) only
 * because both were written as `5 * 60` independently; `runners.test.ts`
 * asserts `noClaimCooldownSeconds >= SWEEP_INTERVAL_SECONDS` directly, so
 * moving either one without the other fails a test instead of silently
 * reopening the gap.
 */
export const GRACE_SECONDS = 45;

/**
 * How often the scheduled tick — index.ts's every-five-minutes cron trigger —
 * sweeps stale runners out of `queue_runners`. Cloudflare's cron trigger is a
 * string, not an importable value, so this is not that string's source of
 * truth — it is what the string has to keep meaning for the cooldown bound
 * documented above to hold.
 */
export const SWEEP_INTERVAL_SECONDS = 5 * 60;

export interface HeartbeatInput {
  readonly repositoryId: string;
  readonly principalId: string;
  readonly deviceKeyId: string;
  readonly now: string;
}

export interface HeartbeatOutcome {
  /**
   * True when this principal had no live heartbeat for this repository before
   * this call landed — the absent-to-present transition that is the only time
   * eligibility is worth touching. A runner heartbeating every fifteen seconds
   * must not cause a queue-document write every fifteen seconds.
   */
  readonly wasOffline: boolean;
}

function cutoff(now: string): string {
  return new Date(new Date(now).getTime() - GRACE_SECONDS * 1000).toISOString();
}

/**
 * Security profiles that run only on a connected developer's own machine, with
 * no fallback to GitHub Actions (plan.md §5.0).
 *
 * A held lane under either one must never cause a `repository_dispatch`.
 * There is nothing for Actions to do — the runner claims the offer itself,
 * over the heartbeat response — and dispatching anyway spends a whole Actions
 * run to be told so. This is the one place that set lives, so the two callers
 * that decide whether to drive a lane through Actions (`routes.ts`'s
 * `driveLane` and `scheduled-tick.ts`'s tick loop) cannot drift apart on it.
 */
const DEVICE_ONLY_SECURITY_PROFILES: ReadonlySet<string> = new Set(["fresh", "audited"]);

/**
 * Whether a repository's active security profile requires a device and has no
 * Actions fallback. `null` — no active policy — answers false: without a
 * profile there is nothing to withhold on, so the caller does whatever it
 * would have done before this existed.
 */
export function requiresDeviceOnly(securityProfile: string | null): boolean {
  return securityProfile !== null && DEVICE_ONLY_SECURITY_PROFILES.has(securityProfile);
}

/**
 * The two shapes a device id can have in this deployment.
 *
 * `thwip queue work` sends the fingerprint of the signing key it also signs
 * proofs with, and `verification-bundle.ts` caches GitHub-published keys with
 * `key_id = fingerprint`, so `SHA256:` plus 43 base64 characters is the shape
 * a real runner carries. `key_` plus 32 hex is the legacy enrollment id that
 * `/v1/devices/enroll` mints (`randomId("key")`), still valid for a machine
 * enrolled before keys came from GitHub.
 *
 * This is a bound on damage, not an authorization check. A device id becomes
 * part of `queue_runners`'s primary key, so every distinct string the route
 * accepts is a row somebody can create; refusing anything that could not have
 * been issued keeps that to a namespace with a plausible owner instead of the
 * whole of string.
 */
const DEVICE_KEY_ID = /^(SHA256:[A-Za-z0-9+/]{43}|key_[0-9a-f]{32})$/;

export function wellFormedDeviceKeyId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_KEY_ID.test(value);
}

/**
 * Whether this device id is one the control plane has already seen bound to
 * somebody other than the caller, or one that has been revoked.
 *
 * `device_keys` is a cache of keys seen in proofs plus a revocation deny list
 * (migration 0004), not a directory: GitHub owns the key-to-identity binding,
 * and a row appears only once a verification bundle has read that key or the
 * legacy enrollment endpoint minted it. Absence therefore cannot mean "not
 * yours" — a developer whose first action is `thwip queue work` has no row at
 * all, and refusing them would break the feature rather than protect it. What
 * absence can never excuse is a contradiction, so a row that names a different
 * GitHub user, or a revocation, refuses.
 */
export async function deviceKeyClaimedByAnother(
  db: D1Like,
  deviceKeyId: string,
  githubUserId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT github_user_id AS githubUserId, revoked_at AS revokedAt FROM device_keys WHERE key_id = ?")
    .bind(deviceKeyId)
    .first<{ githubUserId: string; revokedAt: string | null }>();
  if (row === null) return false;
  return row.revokedAt !== null || row.githubUserId !== githubUserId;
}

/**
 * Record that a device is here, and report whether its principal was absent a
 * moment ago. One bounded write per connected runner per interval — the shape
 * the free tier can absorb where a per-connection Durable Object could not.
 */
export async function recordHeartbeat(db: D1Like, input: HeartbeatInput): Promise<HeartbeatOutcome> {
  const live = cutoff(input.now);
  const existing = await db
    .prepare(
      `SELECT 1 FROM queue_runners
        WHERE github_repository_id = ? AND principal_id = ? AND last_heartbeat_at >= ?
        LIMIT 1`,
    )
    .bind(input.repositoryId, input.principalId, live)
    .first<{ 1: number }>();
  const wasOffline = existing === null;

  await db
    .prepare(
      `INSERT INTO queue_runners (github_repository_id, principal_id, device_key_id, last_heartbeat_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (github_repository_id, principal_id, device_key_id)
       DO UPDATE SET last_heartbeat_at = excluded.last_heartbeat_at`,
    )
    .bind(input.repositoryId, input.principalId, input.deviceKeyId, input.now)
    .run();

  return { wasOffline };
}

/**
 * Whether this principal currently has a live heartbeat for this repository,
 * from any device. Read-only: never call this expecting it to clear or set
 * eligibility, it just answers "is somebody there right now".
 */
export async function isPrincipalConnected(
  db: D1Like,
  repositoryId: string,
  principalId: string,
  now: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM queue_runners
        WHERE github_repository_id = ? AND principal_id = ? AND last_heartbeat_at >= ?
        LIMIT 1`,
    )
    .bind(repositoryId, principalId, cutoff(now))
    .first<{ 1: number }>();
  return row !== null;
}

/**
 * Capability facts for `readiness.ts`'s `foldCapability`, from the repository's
 * security profile and, only when that profile needs one, whether this
 * principal has a device connected right now.
 *
 * `serverExecutable` is `!requiresDeviceOnly`, and when it is true presence is
 * irrelevant — the read against `queue_runners` is skipped entirely, not just
 * discarded, so a `fast` or `remote` repository never pays for a runner table
 * it has no rows in.
 */
export async function capabilityFor(
  db: D1Like,
  repositoryId: string,
  principalId: string,
  now: string,
  securityProfile: string | null,
): Promise<{ readonly serverExecutable: boolean; readonly compatibleRunnerConnected: boolean }> {
  const serverExecutable = !requiresDeviceOnly(securityProfile);
  if (serverExecutable) return { serverExecutable, compatibleRunnerConnected: false };
  const compatibleRunnerConnected = await isPrincipalConnected(db, repositoryId, principalId, now);
  return { serverExecutable, compatibleRunnerConnected };
}

/**
 * Delete every runner row for this repository whose heartbeat has fallen out
 * of the grace window, and report which principals that leaves with no live
 * device left at all — the present-to-absent transition the scheduler cares
 * about. A principal with one stale device and one live one is not offline.
 */
export async function retireStaleRunners(db: D1Like, repositoryId: string, now: string): Promise<string[]> {
  const before = cutoff(now);
  const stale = await db
    .prepare(
      `SELECT DISTINCT principal_id AS principalId FROM queue_runners
        WHERE github_repository_id = ? AND last_heartbeat_at < ?`,
    )
    .bind(repositoryId, before)
    .all<{ principalId: string }>();
  if (stale.results.length === 0) return [];

  await db
    .prepare(`DELETE FROM queue_runners WHERE github_repository_id = ? AND last_heartbeat_at < ?`)
    .bind(repositoryId, before)
    .run();

  const offline: string[] = [];
  for (const { principalId } of stale.results) {
    const remaining = await db
      .prepare(`SELECT 1 FROM queue_runners WHERE github_repository_id = ? AND principal_id = ? LIMIT 1`)
      .bind(repositoryId, principalId)
      .first<{ 1: number }>();
    if (remaining === null) offline.push(principalId);
  }
  return offline;
}
