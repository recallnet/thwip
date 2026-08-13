import { projectQueueObjectName, queueKey } from "@thwip/queue-domain";
import type { Env } from "./env.js";
import type { D1Like } from "./queue/projection.js";

export interface InstalledProjectRepository {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
}

interface ProjectLifecycleRow {
  readonly projectId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly name: string;
  readonly defaultBranch: string;
}

export interface ProjectReleaseDependencies {
  /** Test hook after the fail-closed release marker is durable. */
  readonly afterMarked?: (repositoryId: string) => Promise<void>;
  /** Test hook after the global drainer selects rows but before it releases one. */
  readonly afterDrainSelected?: () => Promise<void>;
  /** Test hook after cleanup ownership is acquired but before external storage. */
  readonly beforeEvidenceCleanup?: (repositoryId: string) => Promise<void>;
  /** Test hook after external storage is clean but before the final D1 batch. */
  readonly beforeD1Cleanup?: (repositoryId: string) => Promise<void>;
  /** Deterministic rollout and retry clock for tests. */
  readonly now?: () => Date;
  /** Exact GitHub installation snapshot that owns repository selection. */
  readonly authorityInstallationId?: string;
  readonly authoritySnapshotId?: string;
  /** Global repository epochs held by the installation publisher. */
  readonly authorityLeases?: ReadonlyMap<string, RepositoryAuthorityLease>;
  readonly authorityLeaseOwner?: string;
}

export interface ProjectWriteLease {
  readonly projectId: string;
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface RepositoryAuthorityLease {
  readonly repositoryId: string;
  readonly installationId: string;
  readonly owner: string;
  readonly epoch: number;
  assert(): Promise<void>;
  release(): Promise<void>;
}

export interface PendingProjectReimports {
  readonly count: number;
  readonly readyAt: string | null;
}

/**
 * Report clean imports to the tenant GitHub currently selects.
 *
 * A repository transfer preserves GitHub's repository id, while the
 * quarantine records the tenant that owned the retired project. Current App
 * authority, not that historical tenant, therefore owns the pending notice.
 */
export async function pendingProjectReimports(
  db: D1Like,
  organizationId: string,
): Promise<PendingProjectReimports> {
  const row = await db.prepare(
    `SELECT count(*) AS count, max(quarantine.reimport_not_before) AS readyAt
       FROM project_reimport_quarantines quarantine
       JOIN github_repository_authority authority
         ON authority.github_repository_id = quarantine.github_repository_id
        AND authority.organization_id = ?
        AND authority.selected = 1
       JOIN organizations organization
         ON organization.id = authority.organization_id
        AND organization.installation_id = authority.installation_id
      WHERE NOT EXISTS (
        SELECT 1 FROM projects project
         WHERE project.github_repository_id = quarantine.github_repository_id
      )`,
  ).bind(organizationId).first<{ count: number; readyAt: string | null }>();
  return { count: row?.count ?? 0, readyAt: row?.readyAt ?? null };
}

const REPOSITORY_RECONCILE_LEASE_GC_PREDICATE = `
  lease.expires_at <= ?
  AND NOT EXISTS (
    SELECT 1 FROM projects project
     WHERE project.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM project_release_requests request
     WHERE request.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM project_release_jobs job
     WHERE job.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM project_reimport_quarantines quarantine
     WHERE quarantine.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_repository_authority authority
     WHERE authority.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_sync_snapshots snapshot
     WHERE snapshot.installation_id = lease.installation_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_sync_repositories repository
     WHERE repository.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_sync_grants grant_row
     WHERE grant_row.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_sync_team_repos team_repository
     WHERE team_repository.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM project_legacy_cleanup_scopes legacy
     WHERE legacy.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM project_release_queue_refs queue_ref
     WHERE queue_ref.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM project_release_evidence_scopes evidence_scope
     WHERE evidence_scope.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM project_r2_cleanup_intents intent
     WHERE intent.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM project_write_leases writer
     WHERE writer.github_repository_id = lease.github_repository_id
       AND writer.expires_at > ?
  )
  AND NOT EXISTS (
    SELECT 1 FROM installation_sync_leases installation_lease
     WHERE installation_lease.installation_id = 'github-installation-' || lease.installation_id
       AND installation_lease.expires_at > ?
  )
  AND NOT EXISTS (
    SELECT 1 FROM team_repos team_repository
     WHERE team_repository.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_status_comments status_comment
     WHERE status_comment.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_runners runner
     WHERE runner.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_assignments assignment
     WHERE assignment.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM candidate_dispatches dispatch
     WHERE dispatch.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM candidate_verdicts verdict
     WHERE verdict.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_attestations attestation
     WHERE attestation.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_transitions_index transition_row
     WHERE transition_row.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_entries_index entry_row
     WHERE entry_row.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_projection_marks projection_mark
     WHERE projection_mark.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_state state_row
     WHERE state_row.github_repository_id = lease.github_repository_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_projects queue_project
     WHERE queue_project.github_repository_id = lease.github_repository_id
  )`;

/** Serialize one repository's transfer/import authority across installations. */
export async function acquireRepositoryAuthorityLease(
  db: D1Like,
  repositoryId: string,
  installationId: string,
  owner: string = crypto.randomUUID(),
): Promise<RepositoryAuthorityLease | null> {
  const now = new Date();
  const acquired = await db.prepare(
      `INSERT INTO github_repository_reconcile_leases
         (github_repository_id, installation_id, owner_token, epoch, expires_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(github_repository_id) DO UPDATE SET
         installation_id = excluded.installation_id,
         owner_token = excluded.owner_token,
         epoch = github_repository_reconcile_leases.epoch + 1,
         expires_at = excluded.expires_at
       WHERE github_repository_reconcile_leases.expires_at <= ?`,
    ).bind(
      repositoryId,
      installationId,
      owner,
      new Date(now.getTime() + 30 * 60_000).toISOString(),
      now.toISOString(),
    ).run();
  if (((acquired as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) return null;
  const row = await db.prepare(
    `SELECT epoch FROM github_repository_reconcile_leases
      WHERE github_repository_id = ? AND installation_id = ? AND owner_token = ?`,
  ).bind(repositoryId, installationId, owner).first<{ epoch: number }>();
  if (row === null) return null;
  const renew = async () => {
    const result = await db.prepare(
      `UPDATE github_repository_reconcile_leases
          SET expires_at = ?
        WHERE github_repository_id = ? AND installation_id = ?
          AND owner_token = ? AND epoch = ?
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).bind(
      new Date(Date.now() + 30 * 60_000).toISOString(),
      repositoryId,
      installationId,
      owner,
      row.epoch,
    ).run();
    if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
      throw new Error(`repository ${repositoryId} authority epoch was lost`);
    }
  };
  return {
    repositoryId,
    installationId,
    owner,
    epoch: row.epoch,
    assert: renew,
    async release() {
      await db.prepare(
        `UPDATE github_repository_reconcile_leases
            SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE github_repository_id = ? AND installation_id = ?
            AND owner_token = ? AND epoch = ?`,
      ).bind(repositoryId, installationId, owner, row.epoch).run();
    },
  };
}

/** Hold one project incarnation across an asynchronous write. */
export async function acquireProjectWriteLease(
  db: D1Like,
  repositoryId: string,
  expectedProjectId?: string,
): Promise<ProjectWriteLease | null> {
  const owner = crypto.randomUUID();
  const leaseLifetimeMs = 15 * 60_000;
  const expiresAt = new Date(Date.now() + leaseLifetimeMs).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO project_write_leases (github_repository_id, project_id, owner_token, expires_at)
       SELECT p.github_repository_id, p.id, ?, ?
         FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE p.github_repository_id = ? AND o.status = 'active'
          AND (? IS NULL OR p.id = ?)
          AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
          AND NOT EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = p.github_repository_id)`,
    )
    .bind(owner, expiresAt, repositoryId, expectedProjectId ?? null, expectedProjectId ?? null)
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (changes === 0) return null;
  const row = await db
    .prepare(
      "SELECT project_id AS projectId FROM project_write_leases WHERE github_repository_id = ? AND owner_token = ?",
    )
    .bind(repositoryId, owner)
    .first<{ projectId: string }>();
  if (row === null) return null;
  let renewalFailure: Error | null = null;
  const renew = async () => {
    if (renewalFailure !== null) throw renewalFailure;
    const result = await db
      .prepare(
        `UPDATE project_write_leases SET expires_at = ?
          WHERE github_repository_id = ? AND project_id = ? AND owner_token = ?`,
      )
      .bind(new Date(Date.now() + leaseLifetimeMs).toISOString(), repositoryId, row.projectId, owner)
      .run();
    const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
    if (changes === 0) {
      renewalFailure = new Error(`project ${repositoryId} write lease was lost`);
      throw renewalFailure;
    }
  };
  const heartbeat = setInterval(() => {
    void renew().catch((error: unknown) => {
      renewalFailure = error instanceof Error ? error : new Error(String(error));
    });
  }, 60_000);
  return {
    projectId: row.projectId,
    renew,
    async release() {
      clearInterval(heartbeat);
      await db
        .prepare("DELETE FROM project_write_leases WHERE github_repository_id = ? AND owner_token = ?")
        .bind(repositoryId, owner)
        .run();
    },
  };
}

interface R2RemovalBucket {
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
  head(key: string): Promise<unknown | null>;
}

interface ReleaseCleanupLease {
  readonly owner: string;
  assert(): Promise<void>;
  release(): Promise<void>;
}

async function acquireReleaseCleanupLease(
  db: D1Like,
  repositoryId: string,
  projectId: string,
): Promise<ReleaseCleanupLease | null> {
  const owner = crypto.randomUUID();
  const lifetimeMs = 15 * 60_000;
  const renew = async () => {
    const now = new Date();
    const result = await db
      .prepare(
        `UPDATE project_release_jobs
            SET cleanup_owner_token = ?, cleanup_lease_expires_at = ?
          WHERE github_repository_id = ? AND project_id = ?
            AND (cleanup_owner_token IS NULL OR cleanup_owner_token = ? OR cleanup_lease_expires_at <= ?)`,
      )
      .bind(
        owner,
        new Date(now.getTime() + lifetimeMs).toISOString(),
        repositoryId,
        projectId,
        owner,
        now.toISOString(),
      )
      .run();
    if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
      throw new Error(`project ${repositoryId} cleanup is owned by another release worker`);
    }
  };
  try {
    await renew();
  } catch {
    return null;
  }
  let renewalFailure: Error | null = null;
  const heartbeat = setInterval(() => {
    void renew().catch((error: unknown) => {
      renewalFailure = error instanceof Error ? error : new Error(String(error));
    });
  }, 60_000);
  return {
    owner,
    async assert() {
      if (renewalFailure !== null) throw renewalFailure;
      await renew();
    },
    async release() {
      clearInterval(heartbeat);
      await db
        .prepare(
          `UPDATE project_release_jobs
              SET cleanup_owner_token = NULL, cleanup_lease_expires_at = NULL
            WHERE github_repository_id = ? AND cleanup_owner_token = ?`,
        )
        .bind(repositoryId, owner)
        .run();
    },
  };
}

export interface ProjectLifecycleRollout {
  readonly maintenanceMode: boolean;
  readonly workerActivatedAt: string | null;
  readonly remoteCapabilitiesRetiredAt: string | null;
  readonly remoteCapabilityEvidenceComplete: boolean;
  readonly destructiveSchemaReadyAt: string | null;
  readonly backfillReady: boolean;
  readonly cleanupReady: boolean;
}

const PROJECT_ID_BACKFILL_TABLES = [
  "queue_state", "queue_projects", "queue_status_comments", "queue_runners",
  "queue_assignments", "candidate_dispatches", "candidate_verdicts",
  "queue_attestations", "queue_transitions_index", "queue_entries_index",
  "queue_projection_marks",
] as const;
const PROJECT_ID_REBUILD_ROW_LIMIT = 25_000;

export interface ProjectLifecycleBackfillResult {
  readonly table: string | null;
  readonly updated: number;
  readonly ready: boolean;
}

/** Backfill at most one bounded row page; cron/queue retries make progress. */
export async function drainProjectLifecycleBackfill(
  db: D1Like,
  limit = 200,
): Promise<ProjectLifecycleBackfillResult> {
  const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
  const pending = await db.prepare(
    "SELECT table_name AS tableName FROM project_lifecycle_backfills WHERE completed_at IS NULL ORDER BY table_name LIMIT 1",
  ).bind().first<{ tableName: string }>();
  if (pending === null) return { table: null, updated: 0, ready: true };
  if (!PROJECT_ID_BACKFILL_TABLES.includes(pending.tableName as (typeof PROJECT_ID_BACKFILL_TABLES)[number])) {
    throw new Error(`unsupported lifecycle backfill table ${pending.tableName}`);
  }
  const table = pending.tableName;
  const updated = await db.prepare(
    `UPDATE ${table}
        SET project_id = (SELECT id FROM projects p WHERE p.github_repository_id = ${table}.github_repository_id)
      WHERE rowid IN (SELECT rowid FROM ${table} WHERE project_id IS NULL LIMIT ?)`,
  ).bind(bounded).run();
  const remaining = await db.prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id IS NULL`)
    .bind().first<{ count: number }>();
  if ((remaining?.count ?? 0) === 0) {
    const count = await db.prepare(`SELECT count(*) AS count FROM ${table}`).bind().first<{ count: number }>();
    if ((count?.count ?? 0) > PROJECT_ID_REBUILD_ROW_LIMIT) {
      throw new Error(
        `${table} has ${count?.count ?? 0} rows; migration 0031 is limited to ${PROJECT_ID_REBUILD_ROW_LIMIT} reviewed rows per table`,
      );
    }
    await db.prepare(
      `UPDATE project_lifecycle_backfills
          SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), verified_row_count = ?
        WHERE table_name = ? AND completed_at IS NULL`,
    ).bind(count?.count ?? 0, table).run();
  }
  const stillPending = await db.prepare(
    "SELECT 1 AS pending FROM project_lifecycle_backfills WHERE completed_at IS NULL LIMIT 1",
  ).bind().first<{ pending: number }>();
  return { table, updated: (updated as { meta?: { changes?: number } }).meta?.changes ?? 0, ready: stillPending === null };
}

function cutoverEvidenceComplete(raw: string | null, capabilitiesRetiredAt: string | null): boolean {
  if (raw === null || capabilitiesRetiredAt === null) return false;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const r2 = value["r2"] as Record<string, unknown> | undefined;
    const d1 = value["d1"] as Record<string, unknown> | undefined;
    const github = value["github"] as Record<string, unknown> | undefined;
    const text = (input: unknown) => typeof input === "string" && input.trim().length > 0;
    const instant = (input: unknown) => text(input) && Number.isFinite(Date.parse(input as string));
    const oldBucketDeletedAt = Date.parse(String(r2?.["oldBucketDeletedAt"]));
    const copyCompletedAt = Date.parse(String(r2?.["copyCompletedAt"]));
    const newBucketRoundTripAt = Date.parse(String(r2?.["newBucketRoundTripAt"]));
    const maintenanceEnabledAt = Date.parse(String(d1?.["maintenanceEnabledAt"]));
    const exportCompletedAt = Date.parse(String(d1?.["exportCompletedAt"]));
    const importCompletedAt = Date.parse(String(d1?.["importCompletedAt"]));
    const newDatabaseRoundTripAt = Date.parse(String(d1?.["newDatabaseRoundTripAt"]));
    const newBindingActivatedAt = Date.parse(String(d1?.["newBindingActivatedAt"]));
    const oldDatabaseDeletedAt = Date.parse(String(d1?.["oldDatabaseDeletedAt"]));
    const oldPrivateKeyDeletedAt = Date.parse(String(github?.["oldPrivateKeyDeletedAt"]));
    const newKeyAcceptedAt = Date.parse(String(github?.["newKeyAcceptedAt"]));
    const oldKeyRejectedAt = Date.parse(String(github?.["oldKeyRejectedAt"]));
    const oldInstallationTokensExpiredAt = Date.parse(String(github?.["oldInstallationTokensExpiredAt"]));
    const oldInstallationTokenRejectedAt = Date.parse(String(github?.["oldInstallationTokenRejectedAt"]));
    const retiredAt = Date.parse(capabilitiesRetiredAt);
    const observedNow = Date.now();
    const prerequisites = [copyCompletedAt, newBucketRoundTripAt, oldBucketDeletedAt,
      maintenanceEnabledAt, exportCompletedAt, importCompletedAt, newDatabaseRoundTripAt,
      newBindingActivatedAt, oldDatabaseDeletedAt, newKeyAcceptedAt, oldPrivateKeyDeletedAt,
      oldKeyRejectedAt, oldInstallationTokensExpiredAt, oldInstallationTokenRejectedAt];
    return r2 !== undefined && d1 !== undefined && github !== undefined &&
      text(r2["oldBucket"]) && text(r2["newBucket"]) && r2["oldBucket"] !== r2["newBucket"] &&
      instant(r2["copyCompletedAt"]) && instant(r2["newBucketRoundTripAt"]) && instant(r2["oldBucketDeletedAt"]) &&
      text(d1["oldDatabase"]) && text(d1["newDatabase"]) && d1["oldDatabase"] !== d1["newDatabase"] &&
      text(d1["oldDatabaseId"]) && text(d1["newDatabaseId"]) && d1["oldDatabaseId"] !== d1["newDatabaseId"] &&
      instant(d1["maintenanceEnabledAt"]) && instant(d1["exportCompletedAt"]) &&
      instant(d1["importCompletedAt"]) && instant(d1["newDatabaseRoundTripAt"]) &&
      instant(d1["newBindingActivatedAt"]) && instant(d1["oldDatabaseDeletedAt"]) &&
      text(d1["exportSha256"]) && /^[0-9a-f]{64}$/.test(String(d1["exportSha256"])) &&
      text(d1["schemaSha256"]) && /^[0-9a-f]{64}$/.test(String(d1["schemaSha256"])) &&
      text(d1["rowCountSha256"]) && /^[0-9a-f]{64}$/.test(String(d1["rowCountSha256"])) &&
      d1["quickCheck"] === "ok" && d1["foreignKeyViolations"] === 0 &&
      copyCompletedAt <= newBucketRoundTripAt && newBucketRoundTripAt <= oldBucketDeletedAt &&
      maintenanceEnabledAt <= exportCompletedAt && exportCompletedAt <= importCompletedAt &&
      importCompletedAt <= newDatabaseRoundTripAt &&
      importCompletedAt <= newBindingActivatedAt && newBindingActivatedAt <= oldDatabaseDeletedAt &&
      text(github["oldKeyFingerprint"]) && text(github["newKeyFingerprint"]) &&
      github["oldKeyFingerprint"] !== github["newKeyFingerprint"] &&
      instant(github["newKeyAcceptedAt"]) && instant(github["oldKeyRejectedAt"]) &&
      instant(github["oldPrivateKeyDeletedAt"]) && instant(github["oldInstallationTokensExpiredAt"]) &&
      instant(github["oldInstallationTokenRejectedAt"]) &&
      newKeyAcceptedAt <= oldPrivateKeyDeletedAt && oldPrivateKeyDeletedAt <= oldKeyRejectedAt &&
      oldInstallationTokensExpiredAt >= oldPrivateKeyDeletedAt + 60 * 60_000 &&
      oldInstallationTokenRejectedAt >= oldInstallationTokensExpiredAt &&
      oldKeyRejectedAt >= oldPrivateKeyDeletedAt &&
      Number.isFinite(retiredAt) && retiredAt <= observedNow &&
      prerequisites.every((timestamp) => Number.isFinite(timestamp) && timestamp <= retiredAt && timestamp <= observedNow) &&
      retiredAt >= oldInstallationTokenRejectedAt && retiredAt >= oldBucketDeletedAt &&
      retiredAt >= oldDatabaseDeletedAt &&
      text(value["approvedBy"]) && typeof value["changeUrl"] === "string" &&
      /^https:\/\//.test(value["changeUrl"]);
  } catch {
    return false;
  }
}

/**
 * Record when the lifecycle-aware Worker first served traffic.
 *
 * Migration 0030 deliberately leaves the previous Worker runnable. Its
 * already-started requests do not know about project leases and can remain
 * alive while their client is connected. The timestamp is deployment evidence
 * only. It never authorizes cleanup; retiring the old D1, R2, and GitHub
 * capabilities plus the final schema marker below does that.
 */
export async function activateProjectLifecycleWorker(db: D1Like, now = new Date()): Promise<void> {
  await db
    .prepare(
      `UPDATE project_lifecycle_rollout
          SET worker_activated_at = COALESCE(worker_activated_at, ?)
        WHERE id = 1`,
    )
    .bind(now.toISOString())
    .run();
}

async function lifecycleCleanupReady(db: D1Like): Promise<boolean> {
  return (await projectLifecycleRollout(db)).cleanupReady;
}

export async function projectLifecycleRollout(db: D1Like): Promise<ProjectLifecycleRollout> {
  const row = await db
    .prepare(
      `SELECT maintenance_mode AS maintenanceMode,
              worker_activated_at AS activatedAt,
              remote_capabilities_retired_at AS capabilitiesRetiredAt,
              remote_capability_evidence AS capabilityEvidence,
              destructive_schema_ready_at AS schemaReadyAt
         FROM project_lifecycle_rollout WHERE id = 1`,
    )
    .bind()
    .first<{
      maintenanceMode: number;
      activatedAt: string | null;
      capabilitiesRetiredAt: string | null;
      capabilityEvidence: string | null;
      schemaReadyAt: string | null;
    }>();
  const workerActivatedAt = row?.activatedAt ?? null;
  const maintenanceMode = row?.maintenanceMode === 1;
  const remoteCapabilitiesRetiredAt = row?.capabilitiesRetiredAt ?? null;
  const remoteCapabilityEvidence = row?.capabilityEvidence ?? null;
  const destructiveSchemaReadyAt = row?.schemaReadyAt ?? null;
  const pendingBackfill = await db.prepare(
    "SELECT 1 AS pending FROM project_lifecycle_backfills WHERE completed_at IS NULL LIMIT 1",
  ).bind().first<{ pending: number }>();
  const backfillReady = pendingBackfill === null;
  const remoteCapabilityEvidenceComplete = cutoverEvidenceComplete(
    remoteCapabilityEvidence,
    remoteCapabilitiesRetiredAt,
  );
  return {
    maintenanceMode,
    workerActivatedAt,
    remoteCapabilitiesRetiredAt,
    remoteCapabilityEvidenceComplete,
    destructiveSchemaReadyAt,
    backfillReady,
    cleanupReady:
      remoteCapabilitiesRetiredAt !== null &&
      remoteCapabilityEvidenceComplete &&
      destructiveSchemaReadyAt !== null && backfillReady,
  };
}

export async function projectLifecycleMaintenanceMode(db: D1Like): Promise<boolean> {
  const row = await db
    .prepare("SELECT maintenance_mode AS maintenanceMode FROM project_lifecycle_rollout WHERE id = 1")
    .bind()
    .first<{ maintenanceMode: number }>();
  return row?.maintenanceMode === 1;
}

async function projectRows(db: D1Like, organizationId: string): Promise<ProjectLifecycleRow[]> {
  const rows = await db
    .prepare(
      `SELECT p.id AS projectId, p.organization_id AS organizationId,
              p.github_repository_id AS repositoryId, p.github_name AS name,
              p.default_branch AS defaultBranch
         FROM projects p
        WHERE p.organization_id = ?
        ORDER BY p.github_repository_id`,
    )
    .bind(organizationId)
    .all<ProjectLifecycleRow>();
  return rows.results;
}

async function releaseRows(db: D1Like, organizationId: string): Promise<ProjectLifecycleRow[]> {
  const rows = await db
    .prepare(
      `SELECT project_id AS projectId, organization_id AS organizationId,
              github_repository_id AS repositoryId, github_name AS name,
              default_branch AS defaultBranch
         FROM project_release_requests
        WHERE organization_id = ?
        ORDER BY github_repository_id`,
    )
    .bind(organizationId)
    .all<ProjectLifecycleRow>();
  return rows.results;
}

async function markRelease(db: D1Like, project: ProjectLifecycleRow, clock = new Date()): Promise<ProjectLifecycleRow | null> {
  const now = clock.toISOString();
  // The request is durable before quiescence. It blocks new leases and lets a
  // branch writer check cancellation at the last safe moment. Existing holders
  // may finish recording an operation that already reached GitHub.
  await db
    .prepare(
      `INSERT INTO project_release_requests
         (github_repository_id, project_id, organization_id, github_name, default_branch)
       SELECT p.github_repository_id, p.id, p.organization_id, p.github_name, p.default_branch
         FROM projects p
        WHERE p.github_repository_id = ? AND p.id = ? AND p.organization_id = ?
       ON CONFLICT(github_repository_id) DO NOTHING`,
    )
    .bind(project.repositoryId, project.projectId, project.organizationId)
    .run();
  await db.prepare(
    `INSERT INTO project_reimport_quarantines
       (github_repository_id, prior_project_id, organization_id, reimport_not_before)
     SELECT p.github_repository_id, p.id, p.organization_id, ? FROM projects p
      WHERE p.github_repository_id = ? AND p.id = ? AND p.organization_id = ?
     ON CONFLICT(github_repository_id) DO NOTHING`,
  ).bind(
    new Date(clock.getTime() + 60 * 60_000).toISOString(),
    project.repositoryId,
    project.projectId,
    project.organizationId,
  ).run();
  // Retrying an already-durable migration/release row is allowed. An obsolete
  // snapshot is not: if its exact incarnation is gone and no matching request
  // remains, it must not recreate cleanup authority over a fresh re-selection.
  const requested = await db
    .prepare(
      `SELECT project_id AS projectId, organization_id AS organizationId,
              github_repository_id AS repositoryId, github_name AS name,
              default_branch AS defaultBranch
         FROM project_release_requests
        WHERE github_repository_id = ? AND project_id = ?`,
    )
    .bind(project.repositoryId, project.projectId)
    .first<ProjectLifecycleRow>();
  if (requested === null) return null;
  await db
    .prepare("DELETE FROM project_write_leases WHERE github_repository_id = ? AND expires_at <= ?")
    .bind(project.repositoryId, now)
    .run();
  await db
    .prepare(
      `INSERT INTO project_release_jobs
         (github_repository_id, project_id, organization_id, github_name, default_branch)
       SELECT r.github_repository_id, r.project_id, r.organization_id, r.github_name, r.default_branch
         FROM project_release_requests r
        WHERE r.github_repository_id = ? AND r.project_id = ?
          AND NOT EXISTS (
          SELECT 1 FROM project_write_leases WHERE github_repository_id = ? AND expires_at > ?
        )
       ON CONFLICT(github_repository_id) DO NOTHING`,
    )
    .bind(
      project.repositoryId,
      project.projectId,
      project.repositoryId,
      now,
    )
    .run();
  const marker = await db
    .prepare(
      `SELECT project_id AS projectId, organization_id AS organizationId,
              github_repository_id AS repositoryId, github_name AS name,
              default_branch AS defaultBranch
         FROM project_release_jobs
        WHERE github_repository_id = ? AND project_id = ?`,
    )
    .bind(project.repositoryId, project.projectId)
    .first<ProjectLifecycleRow>();
  if (marker === null) throw new Error(`project ${project.repositoryId} still has active writes; retry release`);
  await db
    .prepare(
      `INSERT OR IGNORE INTO project_release_evidence_scopes
         (github_repository_id, prefix)
       SELECT ?, ?
        WHERE EXISTS (
          SELECT 1 FROM project_release_jobs
           WHERE github_repository_id = ? AND evidence_scopes_seeded = 0
        )`,
    )
    .bind(marker.repositoryId, `project/${marker.projectId}/`, marker.repositoryId)
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO project_release_evidence_scopes
         (github_repository_id, prefix)
       SELECT ?, ?
        WHERE EXISTS (
          SELECT 1 FROM project_release_jobs
           WHERE github_repository_id = ? AND evidence_scopes_seeded = 0
        )`,
    )
    .bind(marker.repositoryId, `org/${marker.organizationId}/repo/${marker.repositoryId}/`, marker.repositoryId)
    .run();
  await db
    .prepare("UPDATE project_release_jobs SET evidence_scopes_seeded = 1 WHERE github_repository_id = ?")
    .bind(project.repositoryId)
    .run();
  return marker;
}

/**
 * Persist the fail-closed half of a repository-selection reconcile.
 *
 * GitHub repository selection is independent from organization membership and
 * collaborator APIs. Once the complete selected repository set proves that a
 * project is absent, a later failure while reading those ancillary APIs must
 * not leave the removed project writable. Cleanup remains retryable through
 * the global release drainer.
 */
export async function fenceDeselectedProjects(
  db: D1Like,
  organizationId: string,
  selectedRepositoryIds: readonly string[],
  now = new Date(),
): Promise<number> {
  const selectedJson = JSON.stringify(selectedRepositoryIds);
  const removed = await db.prepare(
    `SELECT count(*) AS count FROM projects project
      WHERE project.organization_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) selected
           WHERE CAST(selected.value AS TEXT) = project.github_repository_id
        )`,
  ).bind(organizationId, selectedJson).first<{ count: number }>();
  if ((removed?.count ?? 0) === 0) return 0;
  // D1 batch is one transaction. Every confirmed absence becomes unavailable
  // together in two set-based statements, before cleanup waits on any one
  // repository's active writer. This remains a two-statement batch for the
  // declared 500-repository installation maximum.
  const reimportNotBefore = new Date(now.getTime() + 60 * 60_000).toISOString();
  await db.batch([db.prepare(
    `INSERT INTO project_release_requests
       (github_repository_id, project_id, organization_id, github_name, default_branch)
     SELECT p.github_repository_id, p.id, p.organization_id, p.github_name, p.default_branch
       FROM projects p
      WHERE p.organization_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) selected
           WHERE CAST(selected.value AS TEXT) = p.github_repository_id
        )
     ON CONFLICT(github_repository_id) DO NOTHING`,
  ).bind(organizationId, selectedJson), db.prepare(
    `INSERT INTO project_reimport_quarantines
       (github_repository_id, prior_project_id, organization_id, reimport_not_before)
     SELECT p.github_repository_id, p.id, p.organization_id, ?
       FROM projects p
      WHERE p.organization_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) selected
           WHERE CAST(selected.value AS TEXT) = p.github_repository_id
        )
     ON CONFLICT(github_repository_id) DO NOTHING`,
  ).bind(reimportNotBefore, organizationId, selectedJson)]);
  return removed?.count ?? 0;
}

/** Never let a release marker for one incarnation take ownership of another. */
async function currentReleaseTarget(db: D1Like, project: ProjectLifecycleRow): Promise<ProjectLifecycleRow> {
  const current = await db
    .prepare(
      `SELECT id AS projectId, organization_id AS organizationId,
              github_repository_id AS repositoryId, github_name AS name,
              default_branch AS defaultBranch
         FROM projects WHERE github_repository_id = ?`,
    )
    .bind(project.repositoryId)
    .first<ProjectLifecycleRow>();
  if (current === null || current.projectId === project.projectId) return project;
  throw new Error(`project ${project.repositoryId} release no longer owns the current incarnation`);
}

async function seedQueueRefs(
  db: D1Like,
  projectId: string,
  repositoryId: string,
  defaultBranch: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO project_release_queue_refs (project_id, github_repository_id, base_ref)
       SELECT ?, ?, ?
       UNION SELECT project_id, github_repository_id, base_ref FROM queue_state
        WHERE github_repository_id = ? AND project_id = ?
       UNION SELECT project_id, github_repository_id, base_ref FROM queue_projects
        WHERE github_repository_id = ? AND project_id = ?
       UNION SELECT project_id, github_repository_id, base_ref FROM queue_projection_marks
        WHERE github_repository_id = ? AND project_id = ?
       UNION SELECT project_id, github_repository_id, base_ref FROM queue_status_comments
        WHERE github_repository_id = ? AND project_id = ?
       UNION SELECT project_id, github_repository_id, base_ref FROM queue_entries_index
        WHERE github_repository_id = ? AND project_id = ?
       UNION SELECT project_id, github_repository_id, base_ref FROM queue_transitions_index
        WHERE github_repository_id = ? AND project_id = ?
       UNION SELECT project_id, github_repository_id, base_ref FROM queue_attestations
        WHERE github_repository_id = ? AND project_id = ?
       UNION SELECT project_id, github_repository_id, base_ref FROM queue_assignments
        WHERE github_repository_id = ? AND project_id = ?
       UNION SELECT project_id, github_repository_id, base_ref FROM candidate_dispatches
        WHERE github_repository_id = ? AND project_id = ?
       UNION SELECT project_id, github_repository_id, base_ref FROM candidate_verdicts
        WHERE github_repository_id = ? AND project_id = ?`,
    )
    .bind(
      projectId,
      repositoryId,
      `refs/heads/${defaultBranch}`,
      repositoryId,
      projectId,
      repositoryId,
      projectId,
      repositoryId,
      projectId,
      repositoryId,
      projectId,
      repositoryId,
      projectId,
      repositoryId,
      projectId,
      repositoryId,
      projectId,
      repositoryId,
      projectId,
      repositoryId,
      projectId,
      repositoryId,
      projectId,
    )
    .run();
  await db
    .prepare("UPDATE project_release_jobs SET queue_refs_seeded = 1 WHERE github_repository_id = ? AND project_id = ?")
    .bind(repositoryId, projectId)
    .run();
}

async function queueRefsWereSeeded(db: D1Like, repositoryId: string, projectId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT queue_refs_seeded AS seeded FROM project_release_jobs WHERE github_repository_id = ? AND project_id = ?")
    .bind(repositoryId, projectId)
    .first<{ seeded: number }>();
  return row?.seeded === 1;
}

async function purgeEvidence(
  db: D1Like,
  bucket: R2RemovalBucket | undefined,
  repositoryId: string,
  cleanup: ReleaseCleanupLease,
): Promise<boolean> {
  await cleanup.assert();
  if (bucket === undefined) {
    await db.prepare("DELETE FROM project_release_evidence_scopes WHERE github_repository_id = ?").bind(repositoryId).run();
    return true;
  }
  for (let drained = 0; drained < 10; drained += 1) {
    const scope = await db
      .prepare(
        `SELECT prefix FROM project_release_evidence_scopes
          WHERE github_repository_id = ? ORDER BY prefix LIMIT 1`,
      )
      .bind(repositoryId)
      .first<{ prefix: string }>();
    if (scope === null) return true;
    const page = await bucket.list({ prefix: scope.prefix });
    await cleanup.assert();
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    if (page.truncated) return false;
    await cleanup.assert();
    await db
      .prepare("DELETE FROM project_release_evidence_scopes WHERE github_repository_id = ? AND prefix = ?")
      .bind(repositoryId, scope.prefix)
      .run();
  }
  const remaining = await db
    .prepare("SELECT 1 AS found FROM project_release_evidence_scopes WHERE github_repository_id = ? LIMIT 1")
    .bind(repositoryId)
    .first<{ found: number }>();
  return remaining === null;
}

interface R2CleanupIntentRow {
  readonly key: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly state: "writing" | "cleanup";
  readonly capabilityState: "active" | "retired";
}

export interface R2CleanupDrainResult {
  readonly attempted: number;
  readonly cleaned: number;
  readonly preserved: number;
  readonly failed: number;
}

/**
 * Resolve expired R2 writes without relying on a project or installation row.
 *
 * An expired clock lease never proves that an R2 put has stopped. A writing
 * intent remains a hard release fence until the bucket generation that issued
 * the put has been retired. Cleanup intents are safe because their writer has
 * already returned from put. Retired-generation intents are safe because the
 * old bucket no longer exists. Only those two classes may be acquired here.
 */
export async function drainR2CleanupIntents(
  env: Pick<Env, "DB" | "EVIDENCE">,
  options: { readonly projectId?: string; readonly limit?: number; readonly now?: Date } = {},
): Promise<R2CleanupDrainResult> {
  const db = env.DB as unknown as D1Like;
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 10)));
  const rows = await db.prepare(
    `SELECT i.object_key AS key, i.project_id AS projectId,
            i.github_repository_id AS repositoryId, i.state,
            generation.state AS capabilityState
       FROM project_r2_cleanup_intents i
       JOIN project_r2_capability_generations generation
         ON generation.generation = i.capability_generation
      WHERE i.lease_expires_at <= ? AND (? IS NULL OR i.project_id = ?)
        AND (i.state = 'cleanup' OR generation.state = 'retired')
      ORDER BY COALESCE(i.last_attempted_at, i.created_at), i.object_key
      LIMIT ?`,
  ).bind(now.toISOString(), options.projectId ?? null, options.projectId ?? null, limit).all<R2CleanupIntentRow>();
  let cleaned = 0;
  let preserved = 0;
  let failed = 0;
  for (const row of rows.results) {
    const owner = crypto.randomUUID();
    const acquired = await db.prepare(
      `UPDATE project_r2_cleanup_intents
          SET owner_token = ?, lease_expires_at = ?, last_attempted_at = ?
        WHERE object_key = ? AND project_id = ? AND lease_expires_at <= ?`,
    ).bind(
      owner,
      new Date(now.getTime() + 15 * 60_000).toISOString(),
      now.toISOString(),
      row.key,
      row.projectId,
      now.toISOString(),
    ).run();
    if (((acquired as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) continue;
    try {
      const current = await db.prepare(
        `SELECT 1 AS found FROM projects p JOIN organizations o ON o.id = p.organization_id
          WHERE p.id = ? AND p.github_repository_id = ? AND o.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM project_release_requests r
               WHERE r.github_repository_id = p.github_repository_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM project_release_jobs j
               WHERE j.github_repository_id = p.github_repository_id
            )`,
      ).bind(row.projectId, row.repositoryId).first<{ found: number }>();
      if (current !== null) {
        await db.prepare(
          `DELETE FROM project_r2_cleanup_intents
            WHERE object_key = ? AND project_id = ? AND owner_token = ?`,
        ).bind(row.key, row.projectId, owner).run();
        preserved += 1;
        continue;
      }
      const bucket = env.EVIDENCE as unknown as R2RemovalBucket | undefined;
      if (bucket === undefined) throw new Error(`R2 cleanup for ${row.key} has no bucket binding`);
      await bucket.delete(row.key);
      if (await bucket.head(row.key) !== null) throw new Error(`R2 cleanup did not remove ${row.key}`);
      await db.prepare(
        `DELETE FROM project_r2_cleanup_intents
          WHERE object_key = ? AND project_id = ? AND owner_token = ?`,
      ).bind(row.key, row.projectId, owner).run();
      cleaned += 1;
    } catch (error) {
      failed += 1;
      await db.prepare(
        `UPDATE project_r2_cleanup_intents
            SET state = 'cleanup', lease_expires_at = ?
          WHERE object_key = ? AND project_id = ? AND owner_token = ?`,
      ).bind(new Date(0).toISOString(), row.key, row.projectId, owner).run().catch(() => {});
      console.error(`[project release] R2 cleanup ${row.key} retry failed`, error);
    }
  }
  return { attempted: rows.results.length, cleaned, preserved, failed };
}

async function projectHasR2WriteIntents(db: D1Like, projectId: string): Promise<boolean> {
  return await db.prepare(
    "SELECT 1 AS found FROM project_r2_cleanup_intents WHERE project_id = ? LIMIT 1",
  ).bind(projectId).first<{ found: number }>() !== null;
}

async function purgeRetiredQueueObjects(
  namespace: Pick<DurableObjectNamespace, "get" | "idFromName">,
  projectId: string,
  repositoryId: string,
  refs: readonly string[],
) {
  for (const baseRef of refs) {
    const exactName = projectQueueObjectName(projectId, repositoryId, baseRef);
    const exact = namespace.get(namespace.idFromName(exactName)) as unknown as { purge(): Promise<void> };
    await exact.purge();
    // Older builds used only a repository/ref hash. Current code never creates
    // this name, but the removed project can still own a retired copy.
    const legacyName = await queueKey(repositoryId, baseRef);
    const legacy = namespace.get(namespace.idFromName(legacyName)) as unknown as { purge(): Promise<void> };
    await legacy.purge();
  }
}

async function purgeQueueRefPage(
  db: D1Like,
  namespace: Pick<DurableObjectNamespace, "get" | "idFromName">,
  projectId: string,
  repositoryId: string,
  cleanup: ReleaseCleanupLease,
): Promise<boolean> {
  const page = await db
    .prepare(
      `SELECT base_ref AS baseRef
         FROM project_release_queue_refs
        WHERE github_repository_id = ? AND project_id = ?
        ORDER BY base_ref
        LIMIT 10`,
    )
    .bind(repositoryId, projectId)
    .all<{ baseRef: string }>();
  for (const row of page.results) {
    await cleanup.assert();
    await purgeRetiredQueueObjects(namespace, projectId, repositoryId, [row.baseRef]);
    await cleanup.assert();
    await db
      .prepare("DELETE FROM project_release_queue_refs WHERE github_repository_id = ? AND project_id = ? AND base_ref = ?")
      .bind(repositoryId, projectId, row.baseRef)
      .run();
  }
  const remaining = await db
    .prepare("SELECT 1 AS found FROM project_release_queue_refs WHERE github_repository_id = ? AND project_id = ? LIMIT 1")
    .bind(repositoryId, projectId)
    .first<{ found: number }>();
  return remaining === null;
}

function cleanupStatements(
  db: D1Like,
  project: ProjectLifecycleRow,
  cleanupOwner: string,
): unknown[] {
  const byProject = ["repository_grants", "proof_verifications", "verification_observations", "policy_bundles"];
  const byRepository = [
    "team_repos",
    "queue_status_comments",
    "queue_runners",
    "queue_assignments",
    "candidate_dispatches",
    "candidate_verdicts",
    "queue_attestations",
    "queue_transitions_index",
    "queue_entries_index",
    "queue_projection_marks",
    "queue_state",
    "queue_projects",
  ];
  return [
    db.prepare(
      `DELETE FROM github_sync_grants
        WHERE github_repository_id = ? AND project_id = ?
          AND EXISTS (
            SELECT 1 FROM project_release_jobs
             WHERE github_repository_id = ? AND project_id = ? AND cleanup_owner_token = ?
          )`,
    ).bind(
      project.repositoryId,
      project.projectId,
      project.repositoryId,
      project.projectId,
      cleanupOwner,
    ),
    db.prepare(
      `DELETE FROM github_sync_team_repos
        WHERE github_repository_id = ? AND project_id = ?
          AND EXISTS (
            SELECT 1 FROM project_release_jobs
             WHERE github_repository_id = ? AND project_id = ? AND cleanup_owner_token = ?
          )`,
    ).bind(
      project.repositoryId,
      project.projectId,
      project.repositoryId,
      project.projectId,
      cleanupOwner,
    ),
    ...byProject.map((table) =>
      db.prepare(
        `DELETE FROM ${table} WHERE project_id = ? AND EXISTS (
           SELECT 1 FROM project_release_jobs
            WHERE github_repository_id = ? AND project_id = ? AND cleanup_owner_token = ?
         )`,
      ).bind(project.projectId, project.repositoryId, project.projectId, cleanupOwner),
    ),
    ...byRepository.map((table) =>
      db.prepare(
        `DELETE FROM ${table} WHERE github_repository_id = ? AND EXISTS (
           SELECT 1 FROM project_release_jobs
            WHERE github_repository_id = ? AND project_id = ? AND cleanup_owner_token = ?
         )`,
      ).bind(project.repositoryId, project.repositoryId, project.projectId, cleanupOwner),
    ),
    db.prepare(
      `DELETE FROM github_repository_authority
        WHERE github_repository_id = ? AND organization_id = ? AND selected = 0
          AND EXISTS (
            SELECT 1 FROM project_release_jobs
             WHERE github_repository_id = ? AND project_id = ? AND cleanup_owner_token = ?
          )`,
    ).bind(
      project.repositoryId,
      project.organizationId,
      project.repositoryId,
      project.projectId,
      cleanupOwner,
    ),
    db.prepare(
      `DELETE FROM project_write_leases WHERE github_repository_id = ? AND EXISTS (
         SELECT 1 FROM project_release_jobs
          WHERE github_repository_id = ? AND project_id = ? AND cleanup_owner_token = ?
       )`,
    ).bind(project.repositoryId, project.repositoryId, project.projectId, cleanupOwner),
    db.prepare(
      `DELETE FROM projects WHERE id = ? AND organization_id = ? AND EXISTS (
         SELECT 1 FROM project_release_jobs
          WHERE github_repository_id = ? AND project_id = ? AND cleanup_owner_token = ?
       )`,
    ).bind(project.projectId, project.organizationId, project.repositoryId, project.projectId, cleanupOwner),
    db
      .prepare(
        `DELETE FROM project_release_requests
          WHERE github_repository_id = ? AND project_id = ? AND EXISTS (
            SELECT 1 FROM project_release_jobs
             WHERE github_repository_id = ? AND project_id = ? AND cleanup_owner_token = ?
          )`,
      )
      .bind(project.repositoryId, project.projectId, project.repositoryId, project.projectId, cleanupOwner),
    db
      .prepare(
        `DELETE FROM project_release_jobs
          WHERE github_repository_id = ? AND project_id = ? AND cleanup_owner_token = ?`,
      )
      .bind(project.repositoryId, project.projectId, cleanupOwner),
  ];
}

/**
 * Finish one release that GitHub repository selection has already authorized.
 *
 * The transient job is the fail-closed gate. Every repository-keyed writer
 * refuses work while it exists. External cleanup is idempotent, and the job is
 * deleted only in the final D1 batch with every project-scoped row.
 */
export async function releaseProject(
  env: Pick<Env, "DB" | "BRANCH_QUEUE" | "EVIDENCE">,
  project: ProjectLifecycleRow,
  dependencies: ProjectReleaseDependencies = {},
): Promise<boolean> {
  const db = env.DB as unknown as D1Like;
  const authorityLease = dependencies.authorityLeases?.get(project.repositoryId);
  await authorityLease?.assert();
  const now = dependencies.now?.() ?? new Date();
  const marked = await markRelease(db, project, now);
  if (marked === null) return false;
  project = marked;
  await dependencies.afterMarked?.(project.repositoryId);

  if (!(await lifecycleCleanupReady(db))) {
    throw new Error(`project ${project.repositoryId} is waiting for the remote capability cutover and finishing schema`);
  }

  project = await currentReleaseTarget(db, project);

  const cleanup = await acquireReleaseCleanupLease(db, project.repositoryId, project.projectId);
  if (cleanup === null) throw new Error(`project ${project.repositoryId} cleanup is already running`);
  try {
    await cleanup.assert();
    await db
      .prepare("DELETE FROM project_write_leases WHERE github_repository_id = ? AND expires_at <= ?")
      .bind(project.repositoryId, now.toISOString())
      .run();
    const activeWriter = await db
      .prepare("SELECT 1 AS found FROM project_write_leases WHERE github_repository_id = ? LIMIT 1")
      .bind(project.repositoryId)
      .first<{ found: number }>();
    if (activeWriter !== null) throw new Error(`project ${project.repositoryId} still has active writes; retry release`);

    await dependencies.beforeEvidenceCleanup?.(project.repositoryId);
    await authorityLease?.assert();
    await cleanup.assert();
    const intentDrain = await drainR2CleanupIntents(env, { projectId: project.projectId, now });
    if (intentDrain.failed > 0 || await projectHasR2WriteIntents(db, project.projectId)) {
      throw new Error(`project ${project.repositoryId} still has active or retrying R2 writes; retry release`);
    }
    await cleanup.assert();
    const evidenceComplete = await purgeEvidence(
      db,
      env.EVIDENCE as unknown as R2RemovalBucket | undefined,
      project.repositoryId,
      cleanup,
    );
    if (!evidenceComplete) throw new Error(`project ${project.repositoryId} has more evidence to purge; retry release`);
    if (!(await queueRefsWereSeeded(db, project.repositoryId, project.projectId))) {
      await cleanup.assert();
      await seedQueueRefs(db, project.projectId, project.repositoryId, project.defaultBranch);
    }
    if (!(await purgeQueueRefPage(db, env.BRANCH_QUEUE, project.projectId, project.repositoryId, cleanup))) {
      throw new Error(`project ${project.repositoryId} has more queue objects to purge; retry release`);
    }
    await dependencies.beforeD1Cleanup?.(project.repositoryId);
    await authorityLease?.assert();
    await cleanup.assert();
    await db.batch(cleanupStatements(db, project, cleanup.owner));
    return true;
  } finally {
    await cleanup.release();
  }
}

/**
 * Reconcile existing projects against GitHub's complete installation list.
 * Incomplete releases are always finished first, including when GitHub has
 * already selected the repository again. Import therefore cannot mix a fresh
 * project with state left by its previous membership.
 */
export async function reconcileInstalledProjects(
  env: Pick<Env, "DB" | "BRANCH_QUEUE" | "EVIDENCE">,
  organizationId: string,
  selected: readonly InstalledProjectRepository[],
  dependencies: ProjectReleaseDependencies = {},
): Promise<{ readonly released: number; readonly imported: number }> {
  const db = env.DB as unknown as D1Like;
  const authorityInstallationId = dependencies.authorityInstallationId;
  const authoritySnapshotId = dependencies.authoritySnapshotId;
  const authorityLeaseOwner = dependencies.authorityLeaseOwner;
  if (
    (authorityInstallationId !== undefined || authoritySnapshotId !== undefined) &&
    (authorityInstallationId === undefined || authoritySnapshotId === undefined || authorityLeaseOwner === undefined)
  ) {
    throw new Error("GitHub lifecycle publication requires one installation snapshot and its global repository lease owner");
  }
  const assertAuthority = async (repositoryId: string, selected: boolean): Promise<void> => {
    if (authorityInstallationId === undefined || authoritySnapshotId === undefined) return;
    const held = dependencies.authorityLeases?.get(repositoryId);
    if (held === undefined || held.owner !== authorityLeaseOwner || held.installationId !== authorityInstallationId) {
      throw new Error(`repository ${repositoryId} does not have its publication authority epoch`);
    }
    await held.assert();
    const current = await db.prepare(
      `SELECT 1 AS current FROM github_repository_authority authority
       JOIN organizations organization ON organization.id = authority.organization_id
       JOIN github_sync_snapshots snapshot ON snapshot.id = authority.snapshot_id
       JOIN installation_sync_leases lease
         ON lease.installation_id = 'github-installation-' || authority.installation_id
        AND lease.owner_token = snapshot.owner_token
        AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      JOIN github_repository_reconcile_leases repository_lease
        ON repository_lease.github_repository_id = authority.github_repository_id
       AND repository_lease.installation_id = authority.installation_id
       AND repository_lease.owner_token = ?
       AND repository_lease.epoch = authority.lease_epoch
       AND repository_lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE authority.github_repository_id = ?
        AND authority.organization_id = ?
        AND authority.installation_id = ?
        AND authority.snapshot_id = ?
        AND authority.selected = ?
        AND organization.installation_id = authority.installation_id
        AND snapshot.publication_ready = 1`,
    ).bind(
      authorityLeaseOwner,
      repositoryId,
      organizationId,
      authorityInstallationId,
      authoritySnapshotId,
      selected ? 1 : 0,
    ).first<{ current: number }>();
    if (current === null) throw new Error(`repository ${repositoryId} authority changed before lifecycle reconciliation`);
  };
  const selectedIds = new Set(selected.map((repository) => repository.id));
  // Confirmed absences are fenced earlier by the stable selection pass. The
  // final reconciler repeats the operation only for ordinary direct callers.
  if (authorityInstallationId === undefined) await fenceDeselectedProjects(db, organizationId, [...selectedIds]);

  const pending = await releaseRows(db, organizationId);
  let released = 0;
  const cleanupReady = await lifecycleCleanupReady(db);
  if (authorityInstallationId !== undefined && authoritySnapshotId !== undefined) {
    const authorityGuard = `EXISTS (
      SELECT 1 FROM github_repository_authority authority
      JOIN github_sync_snapshots snapshot ON snapshot.id = authority.snapshot_id
      JOIN organizations organization ON organization.id = authority.organization_id
      JOIN installation_sync_leases lease
        ON lease.installation_id = 'github-installation-' || authority.installation_id
       AND lease.owner_token = snapshot.owner_token
       AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      JOIN github_repository_reconcile_leases repository_lease
        ON repository_lease.github_repository_id = authority.github_repository_id
       AND repository_lease.installation_id = authority.installation_id
       AND repository_lease.owner_token = ?
       AND repository_lease.epoch = authority.lease_epoch
       AND repository_lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE authority.github_repository_id = projects.github_repository_id
       AND authority.organization_id = ?
       AND authority.installation_id = ?
       AND authority.snapshot_id = ?
       AND authority.selected = 1
       AND snapshot.publication_ready = 1
       AND organization.installation_id = authority.installation_id
    )`;

    // A transfer is also a confirmed removal from the old tenant. Fence every
    // old incarnation in two set-based statements before doing any bounded
    // cleanup. This keeps a large selection under D1's per-invocation limit
    // and prevents one slow release from leaving the rest writable.
    await db.batch([
      db.prepare(
        `INSERT INTO project_release_requests
           (github_repository_id, project_id, organization_id, github_name, default_branch)
         SELECT projects.github_repository_id, projects.id, projects.organization_id,
                projects.github_name, projects.default_branch
           FROM projects
          WHERE projects.organization_id != ? AND ${authorityGuard}
         ON CONFLICT(github_repository_id) DO NOTHING`,
      ).bind(organizationId, authorityLeaseOwner, organizationId, authorityInstallationId, authoritySnapshotId),
      db.prepare(
        `INSERT INTO project_reimport_quarantines
           (github_repository_id, prior_project_id, organization_id, reimport_not_before)
         SELECT projects.github_repository_id, projects.id, projects.organization_id,
                strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')
           FROM projects
          WHERE projects.organization_id != ? AND ${authorityGuard}
         ON CONFLICT(github_repository_id) DO NOTHING`,
      ).bind(organizationId, authorityLeaseOwner, organizationId, authorityInstallationId, authoritySnapshotId),
    ]);

    // Remote cleanup is deliberately bounded. Every removal is already
    // durable and fail-closed, so the global release drainer can finish the
    // remaining requests without making this installation snapshot exceed D1
    // or provider limits.
    if (cleanupReady) {
      const nextRelease = await db.prepare(
        `SELECT request.project_id AS projectId, request.organization_id AS organizationId,
                request.github_repository_id AS repositoryId, request.github_name AS name,
                request.default_branch AS defaultBranch
           FROM project_release_requests request
          WHERE request.organization_id = ?
             OR EXISTS (
               SELECT 1 FROM github_repository_authority authority
                WHERE authority.github_repository_id = request.github_repository_id
                  AND authority.organization_id = ? AND authority.installation_id = ?
                  AND authority.snapshot_id = ? AND authority.selected = 1
             )
          ORDER BY CASE WHEN request.organization_id = ? THEN 0 ELSE 1 END,
                   request.github_repository_id
          LIMIT 1`,
      ).bind(
        organizationId,
        organizationId,
        authorityInstallationId,
        authoritySnapshotId,
        organizationId,
      ).first<ProjectLifecycleRow>();
      if (nextRelease !== null && await releaseProject(env, nextRelease, dependencies)) released += 1;
    }

    const now = dependencies.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const selectedGuard = `EXISTS (
      SELECT 1 FROM github_repository_authority authority
      JOIN github_sync_snapshots snapshot ON snapshot.id = authority.snapshot_id
      JOIN organizations organization ON organization.id = authority.organization_id
      JOIN installation_sync_leases lease
        ON lease.installation_id = 'github-installation-' || authority.installation_id
       AND lease.owner_token = snapshot.owner_token
       AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      JOIN github_repository_reconcile_leases repository_lease
        ON repository_lease.github_repository_id = authority.github_repository_id
       AND repository_lease.installation_id = authority.installation_id
       AND repository_lease.owner_token = ?
       AND repository_lease.epoch = authority.lease_epoch
       AND repository_lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE authority.github_repository_id = staged.github_repository_id
       AND authority.organization_id = ? AND authority.installation_id = ?
       AND authority.snapshot_id = ? AND authority.selected = 1
       AND snapshot.publication_ready = 1
       AND organization.installation_id = authority.installation_id
    )`;
    await db.prepare(
      `UPDATE projects
          SET github_name = (
                SELECT staged.github_name FROM github_sync_repositories staged
                 WHERE staged.snapshot_id = ? AND staged.authority_pass = 3
                   AND staged.github_repository_id = projects.github_repository_id
              ),
              default_branch = (
                SELECT staged.default_branch FROM github_sync_repositories staged
                 WHERE staged.snapshot_id = ? AND staged.authority_pass = 3
                   AND staged.github_repository_id = projects.github_repository_id
              )
        WHERE organization_id = ?
          AND EXISTS (
            SELECT 1 FROM github_sync_repositories staged
             WHERE staged.snapshot_id = ? AND staged.authority_pass = 3
               AND staged.github_repository_id = projects.github_repository_id
               AND ${selectedGuard}
          )`,
    ).bind(
      authoritySnapshotId,
      authoritySnapshotId,
      organizationId,
      authoritySnapshotId,
      authorityLeaseOwner,
      organizationId,
      authorityInstallationId,
      authoritySnapshotId,
    ).run();
    const insert = await db.prepare(
      `INSERT INTO projects
         (id, organization_id, github_repository_id, github_name, default_branch, enabled)
       SELECT 'prj_gh_' || staged.github_repository_id || '_' || lower(hex(randomblob(16))),
              ?, staged.github_repository_id, staged.github_name, staged.default_branch, 0
         FROM github_sync_repositories staged
        WHERE staged.snapshot_id = ? AND staged.authority_pass = 3
          AND ${selectedGuard}
          AND NOT EXISTS (SELECT 1 FROM projects existing WHERE existing.github_repository_id = staged.github_repository_id)
          AND NOT EXISTS (SELECT 1 FROM project_release_requests request WHERE request.github_repository_id = staged.github_repository_id)
          AND NOT EXISTS (
            SELECT 1 FROM project_reimport_quarantines quarantine
             WHERE quarantine.github_repository_id = staged.github_repository_id
               AND quarantine.reimport_not_before > ?
          )`,
    ).bind(
      organizationId,
      authoritySnapshotId,
      authorityLeaseOwner,
      organizationId,
      authorityInstallationId,
      authoritySnapshotId,
      nowIso,
    ).run();
    const imported = (insert as { meta?: { changes?: number } }).meta?.changes ?? 0;
    await db.prepare(
      `DELETE FROM project_reimport_quarantines
        WHERE reimport_not_before <= ?
          AND EXISTS (
            SELECT 1 FROM projects project
             WHERE project.github_repository_id = project_reimport_quarantines.github_repository_id
               AND project.organization_id = ?
          )`,
    ).bind(nowIso, organizationId).run();
    return { released, imported };
  }

  if (cleanupReady) {
    for (const project of pending) {
      await assertAuthority(project.repositoryId, false);
      if (await releaseProject(env, project, dependencies)) released += 1;
    }
  }

  // A GitHub transfer keeps the repository id. Release the old tenant before
  // importing the repository into the installation that GitHub now reports.
  for (const repository of selected) {
    await assertAuthority(repository.id, true);
    const repoLease = authorityInstallationId === undefined ? null :
      await acquireRepositoryAuthorityLease(db, repository.id, authorityInstallationId);
    if (authorityInstallationId !== undefined && repoLease === null) {
      throw new Error(`repository ${repository.id} authority reconciliation is busy`);
    }
    try {
      await repoLease?.assert();
      await assertAuthority(repository.id, true);
    const foreign = await db
      .prepare(
        `SELECT p.id AS projectId, p.organization_id AS organizationId,
                p.github_repository_id AS repositoryId, p.github_name AS name,
                p.default_branch AS defaultBranch
           FROM projects p
          WHERE p.github_repository_id = ? AND p.organization_id != ?`,
      )
      .bind(repository.id, organizationId)
      .first<ProjectLifecycleRow>();
      if (foreign !== null) {
        if (!cleanupReady) continue;
        await releaseProject(env, foreign, dependencies);
      }
    } finally {
      await repoLease?.release();
    }
  }

  let imported = 0;
  for (const repository of selected) {
    await assertAuthority(repository.id, true);
    const repoLease = authorityInstallationId === undefined ? null :
      await acquireRepositoryAuthorityLease(db, repository.id, authorityInstallationId);
    if (authorityInstallationId !== undefined && repoLease === null) {
      throw new Error(`repository ${repository.id} authority reconciliation is busy`);
    }
    try {
      await repoLease?.assert();
      await assertAuthority(repository.id, true);
      const now = dependencies.now?.() ?? new Date();
      const quarantine = await db.prepare(
        "SELECT reimport_not_before AS notBefore FROM project_reimport_quarantines WHERE github_repository_id = ?",
      ).bind(repository.id).first<{ notBefore: string }>();
      if (quarantine !== null && Date.parse(quarantine.notBefore) > now.getTime()) continue;
      const pendingRelease = await db.prepare(
        "SELECT 1 AS pending FROM project_release_requests WHERE github_repository_id = ? LIMIT 1",
      ).bind(repository.id).first<{ pending: number }>();
      if (pendingRelease !== null) continue;
    const existing = await db
      .prepare("SELECT id FROM projects WHERE github_repository_id = ? AND organization_id = ?")
      .bind(repository.id, organizationId)
      .first<{ id: string }>();
    const projectId = existing?.id ?? `prj_gh_${repository.id}_${crypto.randomUUID().replaceAll("-", "")}`;
    const result = await db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, github_repository_id, github_name, default_branch, enabled)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(github_repository_id) DO UPDATE SET
           github_name = excluded.github_name,
           default_branch = excluded.default_branch
         WHERE projects.organization_id = excluded.organization_id`,
      )
      .bind(projectId, organizationId, repository.id, repository.fullName, repository.defaultBranch)
      .run();
    const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
      if (existing === null && changes > 0) {
        imported += 1;
        await db.prepare(
          "DELETE FROM project_reimport_quarantines WHERE github_repository_id = ? AND reimport_not_before <= ?",
        ).bind(repository.id, now.toISOString()).run();
      }
    } finally {
      await repoLease?.release();
    }
  }

  return { released, imported };
}

/** Finish every project release for an uninstalled GitHub App installation. */
export async function releaseInstallationProjects(
  env: Pick<Env, "DB" | "BRANCH_QUEUE" | "EVIDENCE">,
  organizationId: string,
  dependencies: ProjectReleaseDependencies = {},
  expectedInstallationId?: string,
): Promise<number> {
  if (expectedInstallationId !== undefined) {
    const db = env.DB as unknown as D1Like;
    const now = dependencies.now?.() ?? new Date();
    const reimportNotBefore = new Date(now.getTime() + 60 * 60_000).toISOString();
    // One D1 transaction linearizes the mutable organization pointer with the
    // fail-closed fence. If a reinstall already owns the organization, neither
    // statement selects a row. If uninstall wins, every old incarnation is
    // unavailable before a later reinstall can import anything.
    await db.batch([
      db.prepare(
        `INSERT INTO project_release_requests
           (github_repository_id, project_id, organization_id, github_name, default_branch)
         SELECT project.github_repository_id, project.id, project.organization_id,
                project.github_name, project.default_branch
           FROM projects project JOIN organizations organization
             ON organization.id = project.organization_id
          WHERE project.organization_id = ? AND organization.installation_id = ?
         ON CONFLICT(github_repository_id) DO NOTHING`,
      ).bind(organizationId, expectedInstallationId),
      db.prepare(
        `INSERT INTO project_reimport_quarantines
           (github_repository_id, prior_project_id, organization_id, reimport_not_before)
         SELECT project.github_repository_id, project.id, project.organization_id, ?
           FROM projects project JOIN organizations organization
             ON organization.id = project.organization_id
          WHERE project.organization_id = ? AND organization.installation_id = ?
         ON CONFLICT(github_repository_id) DO NOTHING`,
      ).bind(reimportNotBefore, organizationId, expectedInstallationId),
    ]);
    // Repeat the exact installation predicate after the atomic fence. A new
    // installation may take over here; durable requests still drain globally,
    // but this old invocation must not discover or act on its fresh projects.
    const fenced = await db.prepare(
      `SELECT request.project_id AS projectId, request.organization_id AS organizationId,
              request.github_repository_id AS repositoryId, request.github_name AS name,
              request.default_branch AS defaultBranch
         FROM project_release_requests request JOIN organizations organization
           ON organization.id = request.organization_id
        WHERE request.organization_id = ? AND organization.installation_id = ?
        ORDER BY request.github_repository_id`,
    ).bind(organizationId, expectedInstallationId).all<ProjectLifecycleRow>();
    if (!(await lifecycleCleanupReady(db))) return 0;
    let released = 0;
    for (const project of fenced.results) {
      if (await releaseProject(env, project, dependencies)) released += 1;
    }
    return released;
  }
  return (await reconcileInstalledProjects(env, organizationId, [], dependencies)).released;
}

export interface ProjectReleaseDrainResult {
  readonly attempted: number;
  readonly released: number;
  readonly failed: number;
}

interface LegacyCleanupRow {
  readonly repositoryId: string;
  readonly organizationId: string;
}

/**
 * Remove repository authority lease identities only after their repository has
 * no remaining lifecycle owner. The candidate read is bounded, and the DELETE
 * repeats every predicate so a project, snapshot, quarantine, or live writer
 * that appears between the two statements wins the race.
 */
export async function drainRepositoryAuthorityLeases(
  db: D1Like,
  limit = 100,
  now = new Date(),
): Promise<number> {
  if (!(await lifecycleCleanupReady(db))) return 0;
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const timestamp = now.toISOString();
  const candidates = await db.prepare(
    `SELECT lease.github_repository_id AS repositoryId
       FROM github_repository_reconcile_leases lease
      WHERE ${REPOSITORY_RECONCILE_LEASE_GC_PREDICATE}
      ORDER BY lease.expires_at, lease.github_repository_id
      LIMIT ?`,
  ).bind(timestamp, timestamp, timestamp, boundedLimit).all<{ repositoryId: string }>();
  if (candidates.results.length === 0) return 0;
  const repositoryIds = JSON.stringify(candidates.results.map((row) => row.repositoryId));
  const deleted = await db.prepare(
    `DELETE FROM github_repository_reconcile_leases AS lease
      WHERE lease.github_repository_id IN (
        SELECT CAST(value AS TEXT) FROM json_each(?)
      )
        AND ${REPOSITORY_RECONCILE_LEASE_GC_PREDICATE}`,
  ).bind(repositoryIds, timestamp, timestamp, timestamp).run();
  return (deleted as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

async function cleanupLegacyScope(
  env: Pick<Env, "DB" | "EVIDENCE">,
  scope: LegacyCleanupRow,
): Promise<boolean> {
  const db = env.DB as unknown as D1Like;
  const owner = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const acquired = await db.prepare(
    `UPDATE project_legacy_cleanup_scopes
        SET cleanup_owner_token = ?, cleanup_lease_expires_at = ?, last_attempted_at = ?
      WHERE github_repository_id = ? AND organization_id = ?
        AND (cleanup_owner_token IS NULL OR cleanup_lease_expires_at <= ?)`,
  ).bind(owner, expiresAt, now.toISOString(), scope.repositoryId, scope.organizationId, now.toISOString()).run();
  if (((acquired as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) return false;

  const assertOwner = async () => {
    const result = await db.prepare(
      `UPDATE project_legacy_cleanup_scopes SET cleanup_lease_expires_at = ?
        WHERE github_repository_id = ? AND organization_id = ? AND cleanup_owner_token = ?`,
    ).bind(
      new Date(Date.now() + 15 * 60_000).toISOString(),
      scope.repositoryId,
      scope.organizationId,
      owner,
    ).run();
    if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
      throw new Error(`legacy cleanup ${scope.organizationId}/${scope.repositoryId} lost ownership`);
    }
  };

  try {
    await assertOwner();
    const bucket = env.EVIDENCE as unknown as R2RemovalBucket | undefined;
    if (bucket !== undefined) {
      const prefix = `org/${scope.organizationId}/repo/${scope.repositoryId}/`;
      const page = await bucket.list({ prefix });
      await assertOwner();
      if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
      if (page.truncated) return false;
    }
    await assertOwner();
    await db.batch([
      db.prepare(
        `DELETE FROM team_repos
          WHERE organization_id = ? AND github_repository_id = ?
            AND EXISTS (
              SELECT 1 FROM project_legacy_cleanup_scopes
               WHERE organization_id = ? AND github_repository_id = ? AND cleanup_owner_token = ?
            )`,
      ).bind(scope.organizationId, scope.repositoryId, scope.organizationId, scope.repositoryId, owner),
      db.prepare(
        `DELETE FROM project_legacy_cleanup_scopes
          WHERE organization_id = ? AND github_repository_id = ? AND cleanup_owner_token = ?`,
      ).bind(scope.organizationId, scope.repositoryId, owner),
    ]);
    return true;
  } finally {
    await db.prepare(
      `UPDATE project_legacy_cleanup_scopes
          SET cleanup_owner_token = NULL, cleanup_lease_expires_at = NULL
        WHERE organization_id = ? AND github_repository_id = ? AND cleanup_owner_token = ?`,
    ).bind(scope.organizationId, scope.repositoryId, owner).run();
  }
}

/**
 * Retry transient releases without relying on a current GitHub installation.
 *
 * Migration-created jobs can belong to a suspended or disconnected tenant.
 * The daily installation walk cannot discover those rows, so this bounded,
 * installation-independent pass is what guarantees they eventually drain.
 * One failed R2 page or tenant never prevents later jobs from making progress.
 */
export async function drainProjectReleases(
  env: Pick<Env, "DB" | "BRANCH_QUEUE" | "EVIDENCE">,
  limit = 10,
  dependencies: ProjectReleaseDependencies = {},
): Promise<ProjectReleaseDrainResult> {
  const db = env.DB as unknown as D1Like;
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const cleanupReady = await lifecycleCleanupReady(db);
  const now = dependencies.now?.() ?? new Date();
  if (cleanupReady) {
    // This also drains orphan intents whose project and release rows were
    // already removed. They must not depend on a current GitHub installation.
    await drainR2CleanupIntents(env, { limit: boundedLimit, now });
    // A repository that was never selected again has no import to consume its
    // capability quarantine. A current selection must retain the row until an
    // authoritative installation sync creates the fresh project. Remove only
    // expired, project-free, unselected rows after the capability cutover.
    const expiredUnselectedQuarantine = `
      quarantine.reimport_not_before <= ?
      AND NOT EXISTS (
        SELECT 1 FROM projects project
         WHERE project.github_repository_id = quarantine.github_repository_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM project_release_requests request
         WHERE request.github_repository_id = quarantine.github_repository_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM project_release_jobs job
         WHERE job.github_repository_id = quarantine.github_repository_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM github_repository_authority selected_authority
         JOIN organizations organization
           ON organization.id = selected_authority.organization_id
          AND organization.installation_id = selected_authority.installation_id
        WHERE selected_authority.github_repository_id = quarantine.github_repository_id
          AND selected_authority.selected = 1
      )`;
    // An installation can select and then deselect a repository while the
    // clean-import quarantine is active. Once the token boundary has passed,
    // clear that absent authority before collecting the quarantine so neither
    // it nor its reconcile lease becomes a permanent repository identity.
    await db.batch([
      db.prepare(
        `DELETE FROM github_repository_authority AS authority
          WHERE authority.selected = 0
            AND EXISTS (
              SELECT 1 FROM project_reimport_quarantines quarantine
               WHERE quarantine.github_repository_id = authority.github_repository_id
                 AND ${expiredUnselectedQuarantine}
            )`,
      ).bind(now.toISOString()),
      db.prepare(
        `DELETE FROM project_reimport_quarantines AS quarantine
          WHERE ${expiredUnselectedQuarantine}`,
      ).bind(now.toISOString()),
    ]);
  }
  const rows = await db
    .prepare(
      `SELECT kind, project_id AS projectId, organization_id AS organizationId,
              github_repository_id AS repositoryId, github_name AS name,
              default_branch AS defaultBranch
         FROM (
           SELECT 'project' AS kind, project_id, organization_id,
                  github_repository_id, github_name, default_branch,
                  COALESCE(last_attempted_at, requested_at) AS due_at
             FROM project_release_requests
           UNION ALL
           SELECT 'legacy' AS kind, NULL AS project_id, organization_id,
                  github_repository_id, NULL AS github_name, NULL AS default_branch,
                  COALESCE(last_attempted_at, started_at) AS due_at
             FROM project_legacy_cleanup_scopes
         )
        ORDER BY due_at, kind, organization_id, github_repository_id
        LIMIT ?`,
    )
    .bind(boundedLimit)
    .all<ProjectLifecycleRow & { kind: "project" | "legacy" }>();
  await dependencies.afterDrainSelected?.();
  let released = 0;
  let failed = 0;
  for (const row of rows.results) {
    const attemptedAt = new Date().toISOString();
    if (row.kind === "project") {
      await db
        .prepare("UPDATE project_release_requests SET last_attempted_at = ? WHERE github_repository_id = ?")
        .bind(attemptedAt, row.repositoryId)
        .run();
      try {
        if (await releaseProject(env, row, dependencies)) released += 1;
      } catch (error) {
        failed += 1;
        console.error(`[project release] ${row.repositoryId} retry failed`, error);
      }
      continue;
    }
    const scope: LegacyCleanupRow = { repositoryId: row.repositoryId, organizationId: row.organizationId };
    await db.prepare(
      `UPDATE project_legacy_cleanup_scopes SET last_attempted_at = ?
        WHERE github_repository_id = ? AND organization_id = ?`,
    ).bind(attemptedAt, scope.repositoryId, scope.organizationId).run();
    try {
      if (!(await lifecycleCleanupReady(db))) {
        throw new Error(`legacy cleanup ${scope.organizationId}/${scope.repositoryId} is waiting for the remote capability cutover and finishing schema`);
      }
      if (await cleanupLegacyScope(env, scope)) released += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.error(`[project release] legacy ${scope.organizationId}/${scope.repositoryId} retry failed`, error);
    }
  }
  if (cleanupReady) await drainRepositoryAuthorityLeases(db, boundedLimit, now);
  return { attempted: rows.results.length, released, failed };
}

/** True while a repository is being released or after its project is gone. */
export async function repositoryIsUnavailable(db: D1Like, repositoryId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found
         WHERE EXISTS (
           SELECT 1 FROM project_release_requests WHERE github_repository_id = ?
         ) OR EXISTS (
           SELECT 1 FROM project_release_jobs WHERE github_repository_id = ?
         ) OR NOT EXISTS (
           SELECT 1
             FROM projects p JOIN organizations o ON o.id = p.organization_id
            WHERE p.github_repository_id = ? AND o.status = 'active'
         )`,
    )
    .bind(repositoryId, repositoryId, repositoryId)
    .first<{ found: number }>();
  return row !== null;
}

export async function repositoryAcceptsProject(
  db: D1Like,
  repositoryId: string,
  projectId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found
         FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE p.id = ? AND p.github_repository_id = ? AND o.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
          AND NOT EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = p.github_repository_id)`,
    )
    .bind(projectId, repositoryId)
    .first<{ found: number }>();
  return row !== null;
}

/** Whether a leased operation may still begin a GitHub branch mutation. */
export async function repositoryAllowsExternalWrite(
  db: D1Like,
  repositoryId: string,
  projectId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE p.id = ? AND p.github_repository_id = ? AND o.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
          AND NOT EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = p.github_repository_id)`,
    )
    .bind(projectId, repositoryId)
    .first<{ found: number }>();
  return row !== null;
}
