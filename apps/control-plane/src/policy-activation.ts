import {
  deriveEffectiveProjectConfig,
  parseThwipYaml,
  repositoryDirectoryPrefix,
  type RepositorySnapshot,
  type ThwipYaml,
} from "@thwip/policy";
import { canonicalJson } from "@thwip/protocol";
import { installationToken } from "./github-app.js";
import { GithubApiError } from "./github-error.js";
import type { Env } from "./env.js";
import { acquireProjectWriteLease } from "./project-lifecycle.js";
import type { D1Like } from "./queue/projection.js";

const API = "https://api.github.com";
const td = new TextDecoder();

interface GitTreeEntry {
  path?: string;
  type?: string;
  sha?: string;
}

async function githubJson<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "thwip-control-plane",
    },
  });
  if (!response.ok) throw new GithubApiError(path, response.status, await response.text());
  return response.json() as Promise<T>;
}

function repositoryPath(repository: string): string {
  return repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * A content-addressed view of one GitHub commit. Blob reads are by tree SHA,
 * never by a moving branch name.
 */
class GitHubRepositorySnapshot implements RepositorySnapshot {
  private readonly blobs = new Map<string, string>();
  private readonly content = new Map<string, Promise<Uint8Array>>();

  private constructor(
    private readonly token: string,
    private readonly repository: string,
    entries: GitTreeEntry[],
  ) {
    for (const entry of entries) {
      if (entry.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string") {
        this.blobs.set(entry.path, entry.sha);
      }
    }
  }

  static async load(token: string, repository: string, commitSha: string): Promise<GitHubRepositorySnapshot> {
    const repo = repositoryPath(repository);
    const commit = await githubJson<{ tree?: { sha?: string } }>(
      token,
      `/repos/${repo}/git/commits/${encodeURIComponent(commitSha)}`,
    );
    const treeSha = commit.tree?.sha;
    if (typeof treeSha !== "string") throw new Error(`GitHub commit ${commitSha} has no tree`);
    const tree = await githubJson<{ tree?: GitTreeEntry[]; truncated?: boolean }>(
      token,
      `/repos/${repo}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    );
    if (tree.truncated === true) {
      throw new Error(`GitHub tree ${treeSha} is too large to derive an exact thwip policy`);
    }
    return new GitHubRepositorySnapshot(token, repository, tree.tree ?? []);
  }

  async hasFile(path: string): Promise<boolean> {
    return this.blobs.has(path);
  }

  async listFiles(path: string): Promise<string[]> {
    const prefix = repositoryDirectoryPrefix(path);
    return [...this.blobs.keys()].filter((candidate) => candidate.startsWith(prefix));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const sha = this.blobs.get(path);
    if (sha === undefined) throw new Error(`'${path}' is not present in the canonical GitHub tree`);
    let pending = this.content.get(sha);
    if (pending === undefined) {
      pending = (async () => {
        const repo = repositoryPath(this.repository);
        const blob = await githubJson<{ content?: string; encoding?: string }>(
          this.token,
          `/repos/${repo}/git/blobs/${encodeURIComponent(sha)}`,
        );
        if (blob.encoding !== "base64" || typeof blob.content !== "string") {
          throw new Error(`GitHub blob ${sha} did not return base64 content`);
        }
        const binary = atob(blob.content.replace(/\s/g, ""));
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
      })();
      this.content.set(sha, pending);
    }
    return pending;
  }
}

export interface PolicyPush {
  /** Project incarnation at enqueue time. */
  projectId?: string | null;
  repositoryId?: string | null;
  ref?: string | null;
  after?: string | null;
}

export interface GithubPolicyWebhookPayload {
  action?: string;
  installation?: { id?: number };
  repository?: { id?: number };
  pull_request?: {
    merged?: boolean;
    merge_commit_sha?: string;
    base?: { ref?: string; repo?: { id?: number } };
  };
  ref?: string;
  after?: string;
}

/** Normalize both push and merged-PR delivery shapes into one exact-tree request. */
export function policyPushFromGithubWebhook(
  event: string,
  payload: GithubPolicyWebhookPayload,
): PolicyPush | null {
  if (event === "push") {
    return {
      repositoryId: payload.repository?.id != null ? String(payload.repository.id) : null,
      ref: payload.ref ?? null,
      after: payload.after ?? null,
    };
  }
  if (event === "pull_request" && payload.action === "closed" && payload.pull_request?.merged === true) {
    return {
      repositoryId:
        payload.pull_request.base?.repo?.id != null ? String(payload.pull_request.base.repo.id) : null,
      ref:
        payload.pull_request.base?.ref != null
          ? `refs/heads/${payload.pull_request.base.ref}`
          : null,
      after: payload.pull_request.merge_commit_sha ?? null,
    };
  }
  return null;
}

export type PolicyActivationResult =
  | { status: "ignored"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "unchanged"; digest: string; sourceSha: string }
  | { status: "activated"; digest: string; version: number; sourceSha: string };

interface ActivationProject {
  id: string;
  github_repository_id: string;
  github_name: string;
  default_branch: string;
  enabled: number;
  active_policy_digest: string | null;
  github_org_id: string;
  installation_id: string | null;
  proof_defaults_json: string | null;
}

export interface PolicyActivationDependencies {
  installationToken(env: Env, installationId: string, repositoryId?: string): Promise<string>;
  currentCommitSha(token: string, repository: string, branch: string): Promise<string>;
  loadSnapshot(token: string, repository: string, commitSha: string): Promise<RepositorySnapshot>;
}

const defaultDependencies: PolicyActivationDependencies = {
  installationToken: (env, installationId, repositoryId) =>
    installationToken(env, installationId, undefined, repositoryId),
  async currentCommitSha(token, repository, branch) {
    const commit = await githubJson<{ sha?: string }>(
      token,
      `/repos/${repositoryPath(repository)}/commits/${encodeURIComponent(branch)}`,
    );
    if (typeof commit.sha !== "string") throw new Error(`GitHub branch '${branch}' has no head commit`);
    return commit.sha;
  },
  loadSnapshot: GitHubRepositorySnapshot.load,
};

function validCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

/**
 * Activate policy only from the exact current default-branch tree. Candidate
 * pull-request content never reaches this path, so it cannot approve itself.
 */
export async function activatePolicyFromDefaultBranchPush(
  env: Env,
  push: PolicyPush,
  dependencies: PolicyActivationDependencies = defaultDependencies,
): Promise<PolicyActivationResult> {
  if (typeof push.repositoryId !== "string" || !/^[0-9]+$/.test(push.repositoryId)) {
    return { status: "ignored", reason: "push has no numeric repository id" };
  }
  if (typeof push.after !== "string" || !validCommitSha(push.after)) {
    return { status: "ignored", reason: "push has no live commit" };
  }
  const lease = await acquireProjectWriteLease(
    env.DB as unknown as D1Like,
    push.repositoryId,
    push.projectId ?? undefined,
  );
  if (lease === null) return { status: "ignored", reason: "project is no longer selected" };
  try {
  const project = await env.DB.prepare(
    `SELECT p.id, p.github_repository_id, p.github_name, p.default_branch, p.enabled, p.active_policy_digest,
            o.github_org_id, o.installation_id, o.proof_defaults_json
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE p.github_repository_id = ?
        AND (? IS NULL OR p.id = ?)
        AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
          AND NOT EXISTS (
          SELECT 1 FROM project_release_jobs r
           WHERE r.organization_id = p.organization_id
             AND r.github_repository_id = p.github_repository_id
        )`,
  )
    .bind(push.repositoryId, push.projectId ?? null, push.projectId ?? null)
    .first<ActivationProject>();
  if (project === null) return { status: "ignored", reason: "repository is not imported" };
  if (project.enabled !== 1) return { status: "ignored", reason: "project is disabled" };

  const defaultRef = `refs/heads/${project.default_branch}`;
  if (push.ref !== defaultRef) return { status: "ignored", reason: "push is not for the default branch" };
  if (project.installation_id === null) throw new Error(`project ${project.github_name} has no GitHub installation`);

  const token = await dependencies.installationToken(env, project.installation_id, project.github_repository_id);
  const currentSha = await dependencies.currentCommitSha(token, project.github_name, project.default_branch);
  if (currentSha !== push.after) {
    return { status: "ignored", reason: "a newer default-branch commit already exists" };
  }

  const snapshot = await dependencies.loadSnapshot(token, project.github_name, push.after);
  const repositoryYaml = (await snapshot.hasFile("thwip.yaml"))
    ? td.decode(await snapshot.readFile("thwip.yaml"))
    : null;
  let globalDefaults: ThwipYaml | null = null;
  if (project.proof_defaults_json !== null) {
    try {
      globalDefaults = parseThwipYaml(project.proof_defaults_json);
    } catch (error) {
      return {
        status: "failed",
        reason: `organization defaults are invalid: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (repositoryYaml === null && globalDefaults === null) {
    return { status: "ignored", reason: "default branch has no thwip.yaml and no organization defaults" };
  }
  const derived = await deriveEffectiveProjectConfig(
    globalDefaults,
    repositoryYaml,
    { ownerId: project.github_org_id, repositoryId: project.github_repository_id },
    snapshot,
  );
  const bundleJson = canonicalJson(derived.policy);
  const stillCurrentSha = await dependencies.currentCommitSha(token, project.github_name, project.default_branch);
  if (stillCurrentSha !== push.after) {
    return { status: "ignored", reason: "default branch advanced while policy was being derived" };
  }

  if (project.active_policy_digest === derived.policyDigest) {
    const active = await env.DB.prepare(
      "SELECT digest FROM policy_bundles WHERE digest = ? AND project_id = ? AND status = 'active' AND canonical_json = ?",
    )
      .bind(derived.policyDigest, project.id, bundleJson)
      .first<{ digest: string }>();
    if (active !== null) {
      return { status: "unchanged", digest: derived.policyDigest, sourceSha: push.after };
    }
  }

  const activatedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO policy_bundles
         (digest, project_id, version, canonical_json, status, activated_at, source_ref, source_sha, config_source)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
       ON CONFLICT(digest) DO UPDATE SET
         project_id = excluded.project_id,
         version = excluded.version,
         canonical_json = excluded.canonical_json,
         status = 'active',
         activated_at = CASE
           WHEN policy_bundles.status = 'active' THEN policy_bundles.activated_at
           ELSE excluded.activated_at
         END,
         source_ref = excluded.source_ref,
         source_sha = excluded.source_sha,
         config_source = excluded.config_source`,
    ).bind(
      derived.policyDigest,
      project.id,
      derived.policy.version,
      bundleJson,
      activatedAt,
      defaultRef,
      push.after,
      derived.configSource,
    ),
    env.DB.prepare(
      "UPDATE policy_bundles SET status = 'retired' WHERE project_id = ? AND digest != ? AND status = 'active'",
    ).bind(project.id, derived.policyDigest),
    env.DB.prepare(
      `UPDATE projects
          SET active_policy_digest = ?, security_profile = ?
        WHERE id = ? AND enabled = 1`,
    ).bind(derived.policyDigest, derived.policy.securityProfile, project.id),
  ]);

  // Re-judge every open head under the policy that just took effect.
  //
  // Key revocation, project disable and a proof-mode change all enqueue this;
  // activation did not, so a repository that added a required suite left every
  // open pull request holding a green check earned under the policy before it.
  // The merge gate refuses those now, and this is what clears them: the App
  // re-verifies each head and republishes the check, so a developer sees the
  // refusal on the pull request rather than at the merge.
  await env.SYNC_QUEUE.send({
    provider: "dashboard",
    delivery: `policy-activated_${derived.policyDigest.slice(-32)}`,
    event: "proof_reconcile",
    installationId: project.installation_id,
    policyPush: null,
    appProofTask: null,
    reconcileProofRepositoryId: project.github_repository_id,
    reconcileProofProjectId: project.id,
  });

  return {
    status: "activated",
    digest: derived.policyDigest,
    version: derived.policy.version,
    sourceSha: push.after,
  };
  } finally {
    await lease.release();
  }
}

/**
 * Repair missed webhooks and bootstrap installations created before push
 * events were subscribed. The same exact-head guard and idempotent activation
 * path are used as for a live push.
 */
export async function reconcileInstallationPolicies(
  env: Env,
  installationId: string,
  dependencies: PolicyActivationDependencies = defaultDependencies,
): Promise<PolicyActivationResult[]> {
  const projects = await env.DB.prepare(
    `SELECT p.id, p.github_repository_id, p.github_name, p.default_branch
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE o.installation_id = ? AND p.enabled = 1
        AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
        AND NOT EXISTS (
          SELECT 1 FROM project_release_jobs r
           WHERE r.organization_id = p.organization_id
             AND r.github_repository_id = p.github_repository_id
        )`,
  )
    .bind(installationId)
    .all<{ id: string; github_repository_id: string; github_name: string; default_branch: string }>();
  if (projects.results.length === 0) return [];
  const results: PolicyActivationResult[] = [];
  for (const project of projects.results) {
    try {
      const token = await dependencies.installationToken(env, installationId, project.github_repository_id);
      const sha = await dependencies.currentCommitSha(token, project.github_name, project.default_branch);
      results.push(
        await activatePolicyFromDefaultBranchPush(
          env,
          {
            projectId: project.id,
            repositoryId: project.github_repository_id,
            ref: `refs/heads/${project.default_branch}`,
            after: sha,
          },
          {
            ...dependencies,
            installationToken: async () => token,
          },
        ),
      );
    } catch (error) {
      results.push({ status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
