import type { D1Like } from "./projection.js";
import { nextBootstrapStep, type BootstrapProgress } from "./rulesets.js";
import { databaseSchemaCapabilities } from "../schema-state.js";

/**
 * The control-plane facts a diagnostic may safely report to somebody who can
 * already read the repository.
 *
 * Queue state by itself cannot answer whether a repository is ready. A Durable
 * Object starts with an empty document, so reading one successfully used to
 * make a disabled project and a queue that had never been enrolled look
 * healthy. These facts come from the current project incarnation and its exact
 * queue projection instead.
 */
export interface QueueDoctorReadiness {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly projectEnabled: boolean;
  readonly activePolicyDigest: string | null;
  readonly queueConfigured: boolean;
  readonly queueEnabled: boolean;
  readonly activationState: string | null;
  readonly setupComplete: boolean;
}

interface ReadinessRow {
  readonly project_id: string;
  readonly project_enabled: number;
  readonly active_policy_digest: string | null;
  readonly queue_id: string | null;
  readonly queue_enabled: number | null;
  readonly activation_state: string | null;
  readonly bootstrap_progress_json: string | null;
  readonly verifier_workflow_version: number | null;
  readonly verifier_protocol: number | null;
}

function setupComplete(row: ReadinessRow, v3Ready: boolean): boolean {
  if (row.queue_id === null || row.bootstrap_progress_json === null) return false;
  if (row.verifier_workflow_version !== 2) return false;
  if (v3Ready ? row.verifier_protocol !== 3 : row.verifier_protocol !== 2) return false;
  try {
    const parsed: unknown = JSON.parse(row.bootstrap_progress_json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return nextBootstrapStep(parsed as BootstrapProgress) === null;
  } catch {
    return false;
  }
}

/**
 * Read only the current Phase 1 incarnation. A queue row from an incarnation
 * removed before a re-add cannot satisfy the join, and a release in progress
 * answers nothing rather than leaking state across ownership.
 */
export async function readQueueDoctorReadiness(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<QueueDoctorReadiness | null> {
  const v3Ready = (await databaseSchemaCapabilities(db)).verifierProtocolV3;
  const row = await db
    .prepare(
      `SELECT p.id AS project_id,
              p.enabled AS project_enabled,
              b.digest AS active_policy_digest,
              q.id AS queue_id,
              q.enabled AS queue_enabled,
              q.activation_state,
              q.bootstrap_progress_json,
              q.verifier_workflow_version,
              ${v3Ready ? "q.verifier_protocol" : "CASE q.verifier_workflow_version WHEN 1 THEN 1 ELSE 2 END"} AS verifier_protocol
         FROM projects p
         JOIN organizations o
           ON o.id = p.organization_id
          AND o.status = 'active'
         LEFT JOIN policy_bundles b
                ON b.digest = p.active_policy_digest
               AND b.project_id = p.id
               AND b.status = 'active'
         LEFT JOIN queue_projects q
                ON q.project_id = p.id
               AND q.organization_id = p.organization_id
               AND q.github_repository_id = p.github_repository_id
               AND q.base_ref = ?
        WHERE p.github_repository_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM project_release_requests r
             WHERE r.github_repository_id = p.github_repository_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_release_jobs r
             WHERE r.organization_id = p.organization_id
               AND r.github_repository_id = p.github_repository_id
          )
        LIMIT 1`,
    )
    .bind(baseRef, repositoryId)
    .first<ReadinessRow>();
  if (row === null) return null;

  return {
    projectId: row.project_id,
    repositoryId,
    baseRef,
    projectEnabled: row.project_enabled === 1,
    activePolicyDigest: row.active_policy_digest,
    queueConfigured: row.queue_id !== null,
    queueEnabled: row.queue_enabled === 1,
    activationState: row.activation_state,
    setupComplete: setupComplete(row, v3Ready),
  };
}
