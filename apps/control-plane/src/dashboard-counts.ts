import type { D1Like } from "./queue/projection.js";

/**
 * The numbers the organization page puts against its plan, and the one number
 * that is about the reader rather than the organization.
 *
 * Lifted out of the route because the route cannot be tested: every dashboard
 * handler begins by resolving a Better Auth session, so there is no dashboard
 * route with a test anywhere in this app. The counting is the part that can be
 * wrong, so the counting is the part that moved.
 */

export interface DashboardCounts {
  readonly projects: number;
  readonly enabledProjects: number;
  readonly members: number;
  readonly activatedUsers: number;
  readonly teams: number;
  /**
   * Signing keys held by members of this organization.
   *
   * `device_keys` has no organization of its own — a key belongs to a GitHub
   * user, and a user can be in several — so this joins through the principals
   * that this organization has. Counted without that join, the number was every
   * unrevoked key in the deployment, and an organization with one member was
   * shown a tally belonging to everybody else.
   */
  readonly activeKeys: number;
  /**
   * Whether the reader can sign anything at all yet.
   *
   * Not "is this machine set up", which no server can answer. A person with no
   * unrevoked key cannot produce a proof from any machine, and that is the
   * condition worth prompting on.
   */
  readonly viewerHasSigningKey: boolean;
}

export async function dashboardCounts(
  db: D1Like,
  who: { organizationId: string; githubUserId: string },
): Promise<DashboardCounts> {
  const [projects, enabled, members, activated, teams, keys, mine] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) n FROM projects p WHERE p.organization_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM removed_projects r
             WHERE r.organization_id = p.organization_id
               AND r.github_repository_id = p.github_repository_id
          )`,
      )
      .bind(who.organizationId)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) n FROM projects p WHERE p.organization_id = ? AND p.enabled = 1
          AND NOT EXISTS (
            SELECT 1 FROM removed_projects r
             WHERE r.organization_id = p.organization_id
               AND r.github_repository_id = p.github_repository_id
          )`,
      )
      .bind(who.organizationId)
      .first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) n FROM principals WHERE organization_id = ?").bind(who.organizationId).first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) n FROM principals WHERE organization_id = ? AND activated_at IS NOT NULL")
      .bind(who.organizationId)
      .first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) n FROM github_teams WHERE organization_id = ?").bind(who.organizationId).first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) n FROM device_keys k
          WHERE k.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM principals p
                         WHERE p.github_user_id = k.github_user_id AND p.organization_id = ?)`,
      )
      .bind(who.organizationId)
      .first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) n FROM device_keys WHERE github_user_id = ? AND revoked_at IS NULL")
      .bind(who.githubUserId)
      .first<{ n: number }>(),
  ]);
  return {
    projects: projects?.n ?? 0,
    enabledProjects: enabled?.n ?? 0,
    members: members?.n ?? 0,
    activatedUsers: activated?.n ?? 0,
    teams: teams?.n ?? 0,
    activeKeys: keys?.n ?? 0,
    viewerHasSigningKey: (mine?.n ?? 0) > 0,
  };
}
