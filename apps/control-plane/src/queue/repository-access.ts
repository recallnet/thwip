import type { D1Like } from "./projection.js";

/**
 * What may this caller do on this repository?
 *
 * `authenticate` answers a different question. It says the caller holds a
 * session as some principal in some organization, and that is all it has ever
 * said. Thirteen queue routes read it as though it also said the caller may
 * see the repository in the path, which it does not, and two routes added on
 * 2026-07-31 inherited the same reading. One of them writes the queue document
 * and dispatches GitHub Actions on the repository named.
 *
 * The relation this used to walk was one comparison:
 *
 *   principals.organization_id  =  projects.organization_id
 *
 * That reading of a principal row is now wrong in both directions. GitHub lets
 * a repository be held by somebody who is in no organization at all, invited
 * one repository at a time with a permission attached, and installation sync
 * has always written those people a principal with `github_org_role = 'outside'`
 * in the organization that owns the repository. So the comparison refused
 * nobody it should have refused and granted an invitation to one repository the
 * run of every repository the organization has.
 *
 * Two facts answer it instead, and both are already synced:
 *
 *   principals            says whether the caller is a member of the owning
 *                         organization, in `github_org_role`
 *   repository_grants     says what GitHub gave this person on this repository
 *
 * A grant is read by GitHub user id rather than through the selected principal,
 * because a grant belongs to a person. Somebody who is a member of one
 * organization and a collaborator on another organization's repository would
 * otherwise have to name the right `?org=` before their own invitation counted.
 * Membership is still read through the principal the session selected, so
 * belonging to one organization stays worth nothing anywhere else.
 *
 * `projects` is the canonical row — `readActivePolicy` reads the organization
 * from it, and installation sync writes one per repository the App can see.
 * `queue_projects.organization_id` is a projection copy of the same value and
 * is deliberately not consulted: a repository with a queue row and no project
 * row is an inconsistency, and answering "allowed" from the copy would be
 * answering from the less trustworthy of two disagreeing sources. No project
 * row means no answer, which means refused.
 *
 * One caller now: the gate `routes.ts` registers over `/v1/queue/*`, which runs
 * before any handler and refuses a caller who cannot reach the repository at
 * the level the route needs. Calling it per route is what let thirteen routes
 * each forget, so a handler that calls it for itself is a handler that should
 * be reading the caller the gate already established. The chain route is the
 * exception, and it says why.
 */

/**
 * How far a caller reaches into one repository.
 *
 * Ordered, and compared as an order, so a route states the floor it needs
 * rather than enumerating the permissions that clear it.
 *
 * `write` is the floor for queueing a pull request because it is the floor
 * GitHub puts on pushing one, and because the walk to a merge already refuses a
 * sponsor who does not hold admin, maintain or write. One rule, checked in two
 * places, rather than two rules that can drift apart.
 */
export type RepositoryLevel = "none" | "read" | "write" | "admin";

const ORDER: Record<RepositoryLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };

export function atLeast(held: RepositoryLevel, needed: RepositoryLevel): boolean {
  return ORDER[held] >= ORDER[needed];
}

/**
 * What GitHub's permission on a repository is worth here.
 *
 * `maintain` sits between write and admin on GitHub and carries the push right,
 * so it queues. It does not pause a lane everybody else is waiting in; that is
 * left to the permission GitHub itself calls admin.
 *
 * Anything unrecognized is nothing. The column is free text synced from GitHub,
 * and a permission this deployment has never heard of is not a reason to guess
 * upward.
 */
const GRANT_LEVEL: Readonly<Record<string, RepositoryLevel>> = {
  admin: "admin",
  maintain: "write",
  write: "write",
  push: "write",
  triage: "read",
  read: "read",
  pull: "read",
};

/**
 * A principal row places a person inside an organization's world. Only these
 * roles place them there as a member; `outside` is the role installation sync
 * gives a collaborator, and a null is a row written before the projection
 * carried the column, which was a member when it was written.
 */
export function isOrganizationMember(githubOrgRole: string | null): boolean {
  return githubOrgRole !== "outside";
}

export interface RepositoryCaller {
  readonly principalId: string;
  readonly githubUserId: string;
  /** Whether the session's selected organization made this caller an administrator of it. */
  readonly isAdmin?: boolean;
  /**
   * The deployment's operator token, which authenticates without being a
   * principal in any organization. It has no row to compare, so neither
   * membership nor a grant is a question that can be asked of it.
   */
  readonly operator?: boolean;
}

/**
 * The refusal a caller gets for a repository they do not reach at all.
 *
 * One string, for both "you hold nothing here" and "nobody has onboarded this",
 * because two answers would let anyone walk the numeric repository id space and
 * read back which private repositories use the queue.
 */
export const REPOSITORY_FORBIDDEN = "not a member of the organization that owns this repository";

/**
 * The refusal for a caller who holds the repository and not the permission.
 *
 * Naming the shortfall is safe here and only here. GitHub already told this
 * person the repository exists when it gave them the grant, so the sentence
 * discloses nothing the invitation did not, and a triage collaborator sent the
 * membership refusal would go looking for an organization they are right not to
 * be in.
 */
export const REPOSITORY_READ_ONLY = "write access to this repository is required";

export async function repositoryAccess(
  db: D1Like,
  repositoryId: string,
  caller: RepositoryCaller,
): Promise<RepositoryLevel> {
  if (caller.operator === true) return "admin";
  const row = await db
    .prepare(
      `SELECT pr.github_org_role AS role,
              CASE WHEN pr.organization_id = p.organization_id THEN 1 ELSE 0 END AS owning,
              g.permission AS permission
         FROM projects p
         LEFT JOIN principals pr ON pr.id = ?
         LEFT JOIN repository_grants g
                ON g.project_id = p.id AND g.github_user_id = ? AND g.active = 1
        WHERE p.github_repository_id = ?
        LIMIT 1`,
    )
    .bind(caller.principalId, caller.githubUserId, repositoryId)
    .first<{ role: string | null; owning: number | null; permission: string | null }>();
  if (row === null) return "none";

  // Membership in the organization that owns the repository, which is what the
  // whole model was until repositories acquired people from outside it. A
  // member reaches every repository the organization has, and the session's
  // organization role is what makes them an administrator of it.
  if (row.owning === 1 && isOrganizationMember(row.role)) {
    return caller.isAdmin === true ? "admin" : "write";
  }

  return row.permission === null ? "none" : (GRANT_LEVEL[row.permission] ?? "none");
}
