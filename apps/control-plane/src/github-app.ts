import { SignJWT, importPKCS8 } from "jose";
import type { Env } from "./env.js";
import { GithubApiError } from "./github-error.js";

const API = "https://api.github.com";

async function appJwt(env: Env): Promise<string> {
  const key = await importPKCS8(env.GITHUB_APP_PRIVATE_KEY, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(env.GITHUB_APP_ID)
    .sign(key);
}

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "thwip-control-plane",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new GithubApiError(path, res.status, await res.text());
  return res.json() as Promise<T>;
}

/** Confirm the actor still holds GitHub's organization-admin role now. */
export async function isCurrentOrganizationOwner(
  env: Env,
  input: { installationId: string | null; organizationLogin: string; actorGithubUserId: string },
): Promise<boolean> {
  if (input.installationId === null) return false;
  const token = await installationToken(env, input.installationId);
  const user = await gh<{ id: number; login: string }>(token, `/user/${encodeURIComponent(input.actorGithubUserId)}`);
  if (String(user.id) !== input.actorGithubUserId) return false;
  const membership = await gh<{ state: string; role: string; user?: { id?: number } }>(
    token,
    `/orgs/${encodeURIComponent(input.organizationLogin)}/memberships/${encodeURIComponent(user.login)}`,
  );
  return membership.state === "active" && membership.role === "admin" && String(membership.user?.id) === input.actorGithubUserId;
}

export interface InstalledRepository {
  readonly id: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly ownerId: string;
}

interface ProjectProjectionRepository {
  readonly id: number;
  readonly full_name: string;
  readonly default_branch: string;
}

/** The one sync write whose tombstone guard prevents silent recreation. */
export function installedProjectProjectionStatement(
  db: Pick<D1Database, "prepare">,
  organizationId: string,
  repository: ProjectProjectionRepository,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch)
     SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM removed_projects
         WHERE organization_id = ? AND github_repository_id = ?
      )
     ON CONFLICT(github_repository_id) DO UPDATE SET github_name = excluded.github_name, default_branch = excluded.default_branch`,
  ).bind(
    `prj_gh_${repository.id}`,
    organizationId,
    String(repository.id),
    repository.full_name,
    repository.default_branch,
    organizationId,
    String(repository.id),
  );
}

/** Resolve one repository through this installation, proving the App can see it. */
export async function installedRepository(
  env: Env,
  installationId: string,
  fullName: string,
): Promise<InstalledRepository> {
  const token = await installationToken(env, installationId);
  const repository = await gh<{
    id: number;
    full_name: string;
    default_branch: string;
    owner: { id: number };
  }>(
    token,
    `/repos/${fullName
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}`,
  );
  return {
    id: String(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    ownerId: String(repository.owner.id),
  };
}

async function ghPaged<T>(token: string, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh<T[]>(token, `${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/**
 * GitHub owns the binding between a public key and an identity. This reads a
 * user's registered *signing* keys; the fingerprint of each is what a proof
 * names, so no separate thwip key directory exists.
 */
export async function githubSigningKeys(
  token: string | undefined,
  login: string,
): Promise<Array<{ githubKeyId: number; title: string; publicKey: string }>> {
  const res = await fetch(`${API}/users/${encodeURIComponent(login)}/ssh_signing_keys?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "thwip-control-plane",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`signing keys for ${login} -> ${res.status}`);
  const keys = (await res.json()) as Array<{ id: number; key: string; title: string }>;
  return keys.map((k) => ({ githubKeyId: k.id, title: k.title, publicKey: k.key.trim() }));
}

export async function installationToken(env: Env, installationId: string): Promise<string> {
  const jwt = await appJwt(env);
  const res = await gh<{ token: string }>(jwt, `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
  });
  return res.token;
}

export async function listInstallations(env: Env): Promise<
  Array<{
    id: number;
    account: { id: number; login: string; type: string };
    repository_selection: string;
    permissions?: Record<string, string>;
    /**
     * What this installation actually delivers. Absent on older responses, and
     * a caller must not read that absence as "subscribed to nothing".
     */
    events?: string[];
  }>
> {
  const jwt = await appJwt(env);
  return gh(jwt, `/app/installations`);
}

/**
 * Full idempotent projection sync for one installation: organization, member
 * roles, teams, team members/repos, installed repositories, and effective
 * collaborator permissions. Webhooks are hints; this is the authority.
 */
export async function syncInstallation(env: Env, installationId: string): Promise<Record<string, number>> {
  const jwt = await appJwt(env);
  const inst = await gh<{ account: { id: number; login: string; type: string }; repository_selection: string }>(
    jwt,
    `/app/installations/${installationId}`,
  );
  const token = await installationToken(env, installationId);
  const orgLogin = inst.account.login;
  const orgGithubId = String(inst.account.id);

  const orgRowId = `org_gh_${orgGithubId}`;
  await env.DB.prepare(
    `INSERT INTO organizations (id, github_org_id, github_login, installation_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(github_org_id) DO UPDATE SET github_login = excluded.github_login, installation_id = excluded.installation_id`,
  )
    .bind(orgRowId, orgGithubId, orgLogin, installationId)
    .run();
  const org = await env.DB.prepare("SELECT id FROM organizations WHERE github_org_id = ?")
    .bind(orgGithubId)
    .first<{ id: string }>();
  const orgId = org!.id;

  const counts: Record<string, number> = { members: 0, teams: 0, repos: 0, grants: 0 };
  const stmts: D1PreparedStatement[] = [];

  // Members with org role.
  for (const role of ["admin", "member"] as const) {
    const members = await ghPaged<{ id: number; login: string; avatar_url: string }>(
      token,
      `/orgs/${orgLogin}/members?role=${role}`,
    );
    for (const m of members) {
      counts["members"]!++;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO principals (id, organization_id, github_user_id, github_login, github_org_role, avatar_url)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(organization_id, github_user_id) DO UPDATE SET github_login = excluded.github_login, github_org_role = excluded.github_org_role, avatar_url = excluded.avatar_url`,
        ).bind(`prn_gh_${m.id}`, orgId, String(m.id), m.login, role === "admin" ? "owner" : "member", m.avatar_url),
      );
    }
  }

  // Outside collaborators: not org members, but invited per-repository.
  // They authorize proofs through repository grants like anyone else, so
  // they must be visible principals with an explicit 'outside' role.
  const outside = await ghPaged<{ id: number; login: string; avatar_url: string }>(
    token,
    `/orgs/${orgLogin}/outside_collaborators`,
  );
  for (const m of outside) {
    counts["members"]!++;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO principals (id, organization_id, github_user_id, github_login, github_org_role, avatar_url)
         VALUES (?, ?, ?, ?, 'outside', ?)
         ON CONFLICT(organization_id, github_user_id) DO UPDATE SET github_login = excluded.github_login, github_org_role = 'outside', avatar_url = excluded.avatar_url`,
      ).bind(`prn_gh_${m.id}`, orgId, String(m.id), m.login, m.avatar_url),
    );
  }

  // Teams, membership, and team repo permissions.
  const teams = await ghPaged<{ id: number; slug: string; name: string }>(token, `/orgs/${orgLogin}/teams`);
  for (const t of teams) {
    counts["teams"]!++;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO github_teams (organization_id, team_id, slug, name, synced_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(organization_id, team_id) DO UPDATE SET slug = excluded.slug, name = excluded.name, synced_at = excluded.synced_at`,
      ).bind(orgId, String(t.id), t.slug, t.name),
    );
    const tm = await ghPaged<{ id: number; login: string }>(token, `/orgs/${orgLogin}/teams/${t.slug}/members`);
    for (const m of tm) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO team_members (organization_id, team_id, github_user_id) VALUES (?, ?, ?)
           ON CONFLICT DO NOTHING`,
        ).bind(orgId, String(t.id), String(m.id)),
      );
    }
    const tr = await ghPaged<{ id: number; permissions: Record<string, boolean>; role_name?: string }>(
      token,
      `/orgs/${orgLogin}/teams/${t.slug}/repos`,
    );
    for (const r of tr) {
      const perm = r.role_name ?? (r.permissions?.["admin"] ? "admin" : r.permissions?.["push"] ? "write" : "read");
      stmts.push(
        env.DB.prepare(
          `INSERT INTO team_repos (organization_id, team_id, github_repository_id, permission)
           SELECT ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM removed_projects
               WHERE organization_id = ? AND github_repository_id = ?
            )
           ON CONFLICT(organization_id, team_id, github_repository_id) DO UPDATE SET permission = excluded.permission`,
        ).bind(orgId, String(t.id), String(r.id), perm, orgId, String(r.id)),
      );
    }
  }

  // Installed repositories -> projects (imported disabled unless already present).
  const repoList: ProjectProjectionRepository[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await gh<{ repositories: Array<{ id: number; full_name: string; default_branch: string }> }>(
      token,
      `/installation/repositories?per_page=100&page=${page}`,
    );
    repoList.push(...res.repositories);
    if (res.repositories.length < 100) break;
  }
  for (const r of repoList) {
    counts["repos"]!++;
    stmts.push(installedProjectProjectionStatement(env.DB, orgId, r));
  }

  if (stmts.length > 0) await env.DB.batch(stmts);

  // Effective collaborator permissions per repository (direct + team + org).
  const grantStmts: D1PreparedStatement[] = [];
  for (const r of repoList) {
    const project = await env.DB.prepare("SELECT id FROM projects WHERE github_repository_id = ?")
      .bind(String(r.id))
      .first<{ id: string }>();
    if (!project) continue;
    const collaborators = await ghPaged<{ id: number; login: string; role_name?: string; permissions: Record<string, boolean> }>(
      token,
      `/repos/${r.full_name}/collaborators?affiliation=all`,
    );
    const seen = new Set<string>();
    for (const c of collaborators) {
      const perm =
        c.role_name ?? (c.permissions?.["admin"] ? "admin" : c.permissions?.["maintain"] ? "maintain" : c.permissions?.["push"] ? "write" : c.permissions?.["triage"] ? "triage" : "read");
      seen.add(String(c.id));
      counts["grants"]!++;
      // Catch-all: any collaborator with a grant is at least an 'outside'
      // principal, so every grant row joins to a visible person.
      grantStmts.push(
        env.DB.prepare(
          `INSERT INTO principals (id, organization_id, github_user_id, github_login, github_org_role)
           VALUES (?, ?, ?, ?, 'outside')
           ON CONFLICT(organization_id, github_user_id) DO NOTHING`,
        ).bind(`prn_gh_${c.id}`, orgId, String(c.id), c.login),
      );
      grantStmts.push(
        env.DB.prepare(
          `INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active, synced_at)
           VALUES (?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(project_id, github_user_id) DO UPDATE SET github_login = excluded.github_login, permission = excluded.permission, active = 1, synced_at = excluded.synced_at`,
        ).bind(project.id, String(c.id), c.login, perm),
      );
    }
    // Deactivate grants for users no longer collaborators.
    const existing = await env.DB.prepare("SELECT github_user_id FROM repository_grants WHERE project_id = ?")
      .bind(project.id)
      .all<{ github_user_id: string }>();
    for (const e of existing.results) {
      if (!seen.has(e.github_user_id)) {
        grantStmts.push(
          env.DB.prepare(
            `UPDATE repository_grants SET active = 0, synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE project_id = ? AND github_user_id = ?`,
          ).bind(project.id, e.github_user_id),
        );
      }
    }
  }
  if (grantStmts.length > 0) await env.DB.batch(grantStmts);

  await env.DB.prepare("UPDATE organizations SET status = 'active' WHERE id = ?").bind(orgId).run();
  return counts;
}
