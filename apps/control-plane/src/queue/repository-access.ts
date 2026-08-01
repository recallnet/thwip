import type { D1Like } from "./projection.js";

/**
 * May this principal act on this repository?
 *
 * `authenticate` answers a different question. It says the caller holds a
 * session as some principal in some organization, and that is all it has ever
 * said. Thirteen queue routes read it as though it also said the caller may
 * see the repository in the path, which it does not, and two routes added on
 * 2026-07-31 inherited the same reading. One of them writes the queue document
 * and dispatches GitHub Actions on the repository named.
 *
 * The relation this walks is the whole of the model:
 *
 *   principals.organization_id  =  projects.organization_id
 *   projects.github_repository_id  =  the repository in the path
 *
 * A principal is an organization membership, not a person: `principals` is
 * unique on `(organization_id, github_user_id)`, so one GitHub user who
 * belongs to two installed organizations has two principal rows and a session
 * selects one of them (`?org=`). Comparing organization ids is therefore
 * comparing exactly what the caller's chosen principal grants, which is why
 * this takes a principal id and not a GitHub user id.
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
 * before any handler and refuses a caller who cannot be placed in the owning
 * organization. Calling it per route is what let thirteen routes each forget,
 * so a handler that calls it for itself is a handler that should be reading the
 * caller the gate already established. The chain route is the exception, and it
 * says why.
 *
 * `isAdmin` depends on this running first. `authenticate` reports the role the
 * session's selected organization gave the caller, so read before membership it
 * made an administrator of one organization an administrator of every other.
 */
export interface RepositoryCaller {
  readonly principalId: string;
  /**
   * The deployment's operator token, which authenticates without being a
   * principal in any organization. It has no row to compare, so membership is
   * not a question that can be asked of it.
   */
  readonly operator?: boolean;
}

/** The refusal every repository-scoped route returns, so none of them invent their own. */
export const REPOSITORY_FORBIDDEN = "not a member of the organization that owns this repository";

export async function mayActOnRepository(
  db: D1Like,
  repositoryId: string,
  caller: RepositoryCaller,
): Promise<boolean> {
  if (caller.operator === true) return true;
  const row = await db
    .prepare(
      `SELECT 1 AS allowed
         FROM principals pr
         JOIN projects p ON p.organization_id = pr.organization_id
        WHERE pr.id = ? AND p.github_repository_id = ?
        LIMIT 1`,
    )
    .bind(caller.principalId, repositoryId)
    .first<{ allowed: number }>();
  return row !== null;
}
