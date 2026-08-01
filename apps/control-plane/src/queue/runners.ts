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
 */
export const GRACE_SECONDS = 45;

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
