import { isOrganizationMember } from "./queue/repository-access.js";

/**
 * Which principal a session acts as, and what that principal is worth.
 *
 * A principal row is one person's place inside one organization's world.
 * `principals` is unique on `(organization_id, github_user_id)`, so somebody
 * present in two installed organizations has two rows and the session picks
 * one. What the row stopped saying is that the person is a member: installation
 * sync writes a row for every outside collaborator too, with `github_org_role`
 * set to `outside`, and treating that as membership handed one repository's
 * invitation everything the organization owns.
 *
 * So the row is the identity and the role is the scope. A member's row reaches
 * the organization. A collaborator's row reaches only the repositories
 * `repository_grants` names, which is why a session holding one has no
 * organization selected at all: every organization-wide read in the dashboard
 * already refuses a viewer without one, so a collaborator is refused those by
 * the code that was already there rather than by a new check in each of them.
 */

export interface PrincipalRow {
  readonly principalId: string;
  readonly organizationId: string;
  readonly githubOrgId: string;
  readonly githubLogin: string;
  readonly githubOrgRole: string | null;
  readonly activated: boolean;
}

export { isOrganizationMember as isMembership };

/**
 * `?org=` names an organization by numeric id or by login. A name that matches
 * nothing selects a membership rather than whatever happened to be first, so a
 * stale link cannot quietly drop somebody into their collaborator scope and
 * empty their dashboard.
 */
export function selectPrincipal(rows: readonly PrincipalRow[], requested: string | null): PrincipalRow | null {
  if (requested !== null) {
    const named = rows.find((r) => r.githubOrgId === requested || r.githubLogin === requested);
    if (named !== undefined) return named;
  }
  return rows.find((r) => isOrganizationMember(r.githubOrgRole)) ?? rows[0] ?? null;
}
