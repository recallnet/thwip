import type { SignerGrant, VerificationBundleV1 } from "@thwip/protocol";
import { githubSigningKeys, installationToken } from "./github-app.js";
import { projectPolicyState } from "./policy-state.js";
import { sha256Fingerprint } from "./sshsig-verify.js";
import type { Env } from "./env.js";

export class VerificationBundleError extends Error {
  constructor(
    readonly status: 403 | 404 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface VerificationBundleInput {
  repositoryId: string;
  signerGithubUserId?: string;
  keyFingerprint?: string;
}

export type VerificationBundleResolution =
  | {
      kind: "bootstrap_pending";
      code: "POLICY_AWAITING_FIRST_MERGE";
      projectId: string;
      repositoryId: string;
      repository: string;
      defaultBranch: string;
    }
  | {
      kind: "active";
      projectId: string;
      repository: string;
      defaultBranch: string;
      configSource: string;
      bundle: VerificationBundleV1;
    };

interface ProjectRow {
  id: string;
  github_repository_id: string;
  github_name: string;
  default_branch: string;
  enabled: number;
  active_policy_digest: string | null;
  github_org_id: string;
  installation_id: string | null;
}

function permission(value: string, active: boolean): SignerGrant["permission"] {
  if (!active) return "none";
  if (["none", "read", "triage", "write", "maintain", "admin"].includes(value)) {
    return value as SignerGrant["permission"];
  }
  return "none";
}

async function installationAccessToken(env: Env, project: ProjectRow): Promise<string | undefined> {
  if (project.installation_id !== null) return installationToken(env, project.installation_id);
  return env.GITHUB_SYNC_TOKEN;
}

export async function resolveVerificationBundle(
  env: Env,
  input: VerificationBundleInput,
): Promise<VerificationBundleResolution> {
  const project = await env.DB.prepare(
    `SELECT p.id, p.github_repository_id, p.github_name, p.default_branch, p.enabled,
            p.active_policy_digest, o.github_org_id, o.installation_id
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE p.github_repository_id = ?`,
  )
    .bind(input.repositoryId)
    .first<ProjectRow>();
  if (project === null) {
    throw new VerificationBundleError(404, projectPolicyState(null).code, "project is not imported");
  }
  const policyState = projectPolicyState(project);
  if (policyState.kind === "disabled") {
    throw new VerificationBundleError(403, policyState.code, "project is disabled");
  }
  if (policyState.kind === "bootstrap_pending") {
    return {
      kind: "bootstrap_pending",
      code: policyState.code,
      projectId: project.id,
      repositoryId: project.github_repository_id,
      repository: project.github_name,
      defaultBranch: project.default_branch,
    };
  }

  const policyRow = await env.DB.prepare(
    "SELECT digest, version, canonical_json, status, config_source FROM policy_bundles WHERE digest = ?",
  )
    .bind(policyState.digest)
    .first<{ digest: string; version: number; canonical_json: string; status: string; config_source: string }>();
  if (policyRow === null || policyRow.status !== "active") {
    throw new VerificationBundleError(500, "ACTIVE_POLICY_UNAVAILABLE", "active policy record is unavailable");
  }

  const grace = await env.DB.prepare(
    "SELECT digest FROM policy_bundles WHERE project_id = ? AND status = 'retired' AND activated_at > datetime('now','-1 day')",
  )
    .bind(project.id)
    .all<{ digest: string }>();
  const grants = await env.DB.prepare(
    "SELECT github_user_id, github_login, permission, active, synced_at FROM repository_grants WHERE project_id = ?",
  )
    .bind(project.id)
    .all<{
      github_user_id: string;
      github_login: string;
      permission: string;
      active: number;
      synced_at: string;
    }>();

  let token: string | undefined;
  const accessToken = async (): Promise<string | undefined> => {
    token ??= await installationAccessToken(env, project);
    return token;
  };
  const refreshed: SignerGrant[] = [];
  for (const grant of grants.results) {
    const synced = grant.synced_at.endsWith("Z") ? grant.synced_at : `${grant.synced_at}Z`;
    const stale = Date.now() - Date.parse(synced) > 60_000;
    if (stale) {
      try {
        const currentToken = await accessToken();
        if (currentToken === undefined) {
          throw new Error("no installation token");
        }
        const response = await fetch(
          `https://api.github.com/repos/${project.github_name}/collaborators/${encodeURIComponent(grant.github_login)}/permission`,
          {
            headers: {
              authorization: `Bearer ${currentToken}`,
              accept: "application/vnd.github+json",
              "user-agent": "thwip-control-plane",
            },
          },
        );
        if (response.ok) {
          const body = (await response.json()) as { permission: string; role_name?: string };
          const current = body.role_name ?? body.permission;
          await env.DB.prepare(
            "UPDATE repository_grants SET permission = ?, active = 1, synced_at = ? WHERE project_id = ? AND github_user_id = ?",
          )
            .bind(current, new Date().toISOString(), project.id, grant.github_user_id)
            .run();
          refreshed.push({ githubUserId: grant.github_user_id, permission: permission(current, true), active: true });
          continue;
        }
        if (response.status === 404) {
          await env.DB.prepare(
            "UPDATE repository_grants SET active = 0, synced_at = ? WHERE project_id = ? AND github_user_id = ?",
          )
            .bind(new Date().toISOString(), project.id, grant.github_user_id)
            .run();
          refreshed.push({ githubUserId: grant.github_user_id, permission: "none", active: false });
          continue;
        }
        throw new Error(`GitHub returned ${response.status}`);
      } catch {
        throw new VerificationBundleError(503, "GRANT_REFRESH_FAILED", "grant refresh failed");
      }
    }
    refreshed.push({
      githubUserId: grant.github_user_id,
      permission: permission(grant.permission, grant.active === 1),
      active: grant.active === 1,
    });
  }

  const signerUserId = input.signerGithubUserId;
  const signerRow = signerUserId
    ? await env.DB.prepare(
        "SELECT github_login FROM repository_grants WHERE project_id = ? AND github_user_id = ?",
      )
        .bind(project.id, signerUserId)
        .first<{ github_login: string }>()
    : null;
  const githubKeys: VerificationBundleV1["keys"] = [];
  if (signerRow !== null && signerUserId !== undefined) {
    let listed: Awaited<ReturnType<typeof githubSigningKeys>>;
    try {
      listed = await githubSigningKeys(await accessToken(), signerRow.github_login);
    } catch {
      throw new VerificationBundleError(503, "SIGNING_KEYS_UNAVAILABLE", "cannot read signer signing keys from GitHub");
    }
    const denied = await env.DB.prepare(
      "SELECT fingerprint, revoked_at FROM device_keys WHERE github_user_id = ? AND revoked_at IS NOT NULL",
    )
      .bind(signerUserId)
      .all<{ fingerprint: string; revoked_at: string }>();
    const denyList = new Map(denied.results.map((row) => [row.fingerprint, row.revoked_at]));
    for (const key of listed) {
      const fingerprint = await sha256Fingerprint(key.publicKey);
      if (input.keyFingerprint !== undefined && input.keyFingerprint !== fingerprint) continue;
      githubKeys.push({
        keyId: fingerprint,
        githubUserId: signerUserId,
        algorithm: key.publicKey.split(/\s+/)[0] ?? "unknown",
        publicKey: key.publicKey,
        revokedAt: denyList.get(fingerprint) ?? null,
      });
      await env.DB.prepare(
        `INSERT INTO device_keys (key_id, github_user_id, algorithm, public_key, fingerprint, device_label, source)
         VALUES (?, ?, ?, ?, ?, ?, 'github') ON CONFLICT(key_id) DO NOTHING`,
      )
        .bind(
          fingerprint,
          signerUserId,
          key.publicKey.split(/\s+/)[0] ?? "unknown",
          key.publicKey,
          fingerprint,
          key.title,
        )
        .run()
        .catch(() => undefined);
    }
  }

  const now = new Date();
  const bundle: VerificationBundleV1 = {
    schemaVersion: "1",
    projectId: project.id,
    repositoryId: project.github_repository_id,
    ownerId: project.github_org_id,
    activePolicyDigest: policyRow.digest as VerificationBundleV1["activePolicyDigest"],
    gracePolicyDigests: grace.results.map((row) => row.digest as VerificationBundleV1["activePolicyDigest"]),
    policy: JSON.parse(policyRow.canonical_json) as VerificationBundleV1["policy"],
    keys: githubKeys,
    grants: refreshed,
    leaseIssuerJwks: [],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  return {
    kind: "active",
    projectId: project.id,
    repository: project.github_name,
    defaultBranch: project.default_branch,
    configSource: policyRow.config_source,
    bundle,
  };
}
