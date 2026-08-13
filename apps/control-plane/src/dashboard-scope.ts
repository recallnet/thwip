import { latestVerification } from "./latest-verification.js";
import type { D1Like } from "./queue/projection.js";
import { nextBootstrapStep, type BootstrapProgress } from "./queue/rulesets.js";

/**
 * The repositories the dashboard lists for one viewer.
 *
 * It listed the selected organization's projects and nothing else. Somebody
 * invited to a single repository, who belongs to no organization and so has no
 * organization selected, signed in to an empty page with nothing on it to
 * explain why, while the repository they administer sat in `projects` the whole
 * time with their grant next to it.
 *
 * Two reaches, unioned. The organization the viewer is a member of, and every
 * repository `repository_grants` gives them. The grant half is keyed by GitHub
 * user id because a grant belongs to a person rather than to a membership, so a
 * member of one organization invited to another organization's repository sees
 * that repository without having to switch organizations to find it.
 *
 * `access` says which reach produced the row, so the dashboard can label a
 * repository somebody holds without belonging to its owner rather than
 * presenting it as one of theirs.
 */

export interface ProjectReach {
  /**
   * The organization the session selected, and only when the viewer is a member
   * of it. Null for a viewer acting as an outside collaborator, which is what
   * keeps the organization half of the union from matching anything.
   */
  readonly organizationId: string | null;
  readonly githubUserId: string;
}

export interface ProjectRow {
  readonly id: string;
  readonly github_repository_id: string;
  readonly github_name: string;
  readonly organization_login: string;
  readonly access: "member" | "collaborator";
  readonly permission: string | null;
  readonly queue_setup_complete: boolean;
  readonly [column: string]: unknown;
}

/**
 * Whether the durable queue bootstrap record completed every required step.
 *
 * Project enablement and policy activation are different jobs, so neither is a
 * safe proxy for queue setup. Invalid or absent progress stays incomplete and
 * keeps the setup controls visible.
 */
function queueSetupComplete(progressJson: string | null): boolean {
  if (progressJson === null) return false;
  try {
    const progress: unknown = JSON.parse(progressJson);
    if (progress === null || typeof progress !== "object" || Array.isArray(progress)) return false;
    return nextBootstrapStep(progress as BootstrapProgress) === null;
  } catch {
    return false;
  }
}

export async function projectsInReach(db: D1Like, reach: ProjectReach): Promise<ProjectRow[]> {
  const rows = await db
    .prepare(
      `SELECT p.id, p.github_repository_id, p.github_name, p.default_branch, p.enabled, p.active_policy_digest,
              p.proof_check_mode,
              o.github_login AS organization_login,
              CASE
                WHEN p.enabled = 0 THEN 'disabled'
                WHEN p.active_policy_digest IS NULL THEN 'awaiting_policy'
                ELSE 'active'
              END AS activation_state,
              b.version AS policy_version,
              json_extract(b.canonical_json, '$.securityProfile') AS policy_profile,
              b.config_source AS config_source,
              (SELECT COUNT(*) FROM repository_grants g WHERE g.project_id = p.id AND g.active = 1) AS collaborators,
              CASE WHEN p.organization_id = ? THEN 'member' ELSE 'collaborator' END AS access,
              mine.permission AS permission,
              ${latestVerification("outcome")} AS last_outcome,
              ${latestVerification("at")} AS last_observed_at,
              q.bootstrap_progress_json AS queue_bootstrap_progress
       FROM projects p
       JOIN organizations o ON o.id = p.organization_id
       LEFT JOIN policy_bundles b ON b.digest = p.active_policy_digest
       LEFT JOIN queue_projects q
              ON q.github_repository_id = p.github_repository_id
             AND q.base_ref = 'refs/heads/' || p.default_branch
       LEFT JOIN repository_grants mine
              ON mine.project_id = p.id AND mine.github_user_id = ? AND mine.active = 1
      WHERE (p.organization_id = ? OR mine.permission IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM project_release_requests r
           WHERE r.github_repository_id = p.github_repository_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM project_release_jobs r
           WHERE r.organization_id = p.organization_id
             AND r.github_repository_id = p.github_repository_id
        )
      ORDER BY p.github_name`,
    )
    // Bound in the order the three placeholders appear, which is the order
    // SQLite reads them in. An organization id is never the empty string, so a
    // viewer with no organization selected matches on the grant half alone.
    .bind(reach.organizationId ?? "", reach.githubUserId, reach.organizationId ?? "")
    .all<ProjectRow & { queue_bootstrap_progress: string | null }>();
  return rows.results.map(({ queue_bootstrap_progress: progress, ...project }) => ({
    ...project,
    queue_setup_complete: queueSetupComplete(progress),
  }));
}
