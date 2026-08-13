import type { D1Like } from "./queue/projection.js";

export type RepositoryResolutionIdentity =
  | { readonly kind: "admin" }
  | { readonly kind: "user"; readonly githubUserId: string };

export interface RepositoryResolution {
  readonly ownerId: string;
  readonly repositoryId: string;
}

/** Resolve a GitHub identity only inside the repository owner's tenant. */
export async function principalForRepository(
  db: D1Like,
  repositoryId: string,
  githubUserId: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT pr.id FROM principals pr
      JOIN projects p ON p.organization_id = pr.organization_id
     WHERE p.github_repository_id = ? AND pr.github_user_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM project_release_requests r
          WHERE r.github_repository_id = p.github_repository_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM project_release_jobs r
          WHERE r.github_repository_id = p.github_repository_id
       )`,
  ).bind(repositoryId, githubUserId).first<{ id: string }>();
  return row?.id ?? null;
}

/** Resolve only a current repository the exact caller may already access. */
export async function resolveRepositoryFor(
  db: D1Like,
  identity: RepositoryResolutionIdentity,
  name: string,
): Promise<RepositoryResolution | null> {
  const userPredicate = identity.kind === "admin"
    ? ""
    : `AND EXISTS (
         SELECT 1 FROM repository_grants g
          WHERE g.project_id = p.id AND g.github_user_id = ? AND g.active = 1
       )`;
  const statement = db.prepare(
    `SELECT p.github_repository_id, o.github_org_id FROM projects p
     JOIN organizations o ON o.id = p.organization_id
     WHERE p.github_name = ? AND o.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
       AND NOT EXISTS (SELECT 1 FROM project_release_jobs r WHERE r.github_repository_id = p.github_repository_id)
       ${userPredicate}`,
  );
  const row = identity.kind === "admin"
    ? await statement.bind(name).first<{ github_repository_id: string; github_org_id: string }>()
    : await statement.bind(name, identity.githubUserId).first<{ github_repository_id: string; github_org_id: string }>();
  return row === null ? null : { ownerId: row.github_org_id, repositoryId: row.github_repository_id };
}
