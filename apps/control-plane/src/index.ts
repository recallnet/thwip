import { Hono } from "hono";
import { CompactSign, createRemoteJWKSet, jwtVerify } from "jose";
import { sha256Fingerprint, verifySshSigEd25519 } from "./sshsig-verify.js";
import { isWorkerOwnedPath } from "./worker-routes.js";
import { latestVerification } from "./latest-verification.js";
import { createAuth } from "./auth.js";
import { githubSigningKeys, installationToken, listInstallations, syncInstallation } from "./github-app.js";
import { APP_MANIFEST_EVENTS, webhookEventDrift } from "./github-events.js";
import { syncInstallations } from "./admin-sync.js";
import {
  activatePolicyFromDefaultBranchPush,
  policyPushFromGithubWebhook,
  reconcileInstallationPolicies,
  type GithubPolicyWebhookPayload,
  type PolicyPush,
} from "./policy-activation.js";
import { projectPolicyState } from "./policy-state.js";
import { mintRunLease } from "./run-lease.js";
import { serviceKey, signPayload } from "./service-signing.js";
import { verificationKeys } from "./service-keys.js";
import { readActivePolicy } from "./active-policy.js";
import { capabilityFor, requiresDeviceOnly } from "./queue/runners.js";
import { foldCapability } from "./queue/readiness.js";
import type { D1Like } from "./queue/projection.js";
import type { BlockingReason } from "@thwip/queue-domain";
import { resolveVerificationBundle, VerificationBundleError } from "./verification-bundle.js";
import { queueRoutes, runOnQueue, type QueueRouteEnv } from "./queue/routes.js";
import { DEFAULT_MERGE_METHOD } from "./queue/merge-commit.js";
import { githubHttp, resolveCandidate } from "./queue/github-port.js";
import { tickAllQueues } from "./queue/scheduled-tick.js";
import { CANDIDATE_CHECK, PROOF_CHECK, TURN_CHECK, turnCheckRun, type TurnCheckUpdate } from "./queue/turn-check.js";
import { externalPushFromWebhook } from "./queue/external-push.js";
import { queueExternalMove } from "./queue/external-move.js";
import { backfillAttestations } from "./queue/attestation-backfill.js";
import { hasEvidence, putEvidence, type R2Like } from "./queue/evidence-store.js";
import { parseThwipYaml, type ThwipYaml } from "@thwip/policy";
import {
  appProofTaskFromWebhook,
  processAppProof,
  reconcileInstallationProofChecks,
  reconcileProjectProofChecks,
  requestForRerequest,
  type AppProofTask,
} from "./app-proof-verification.js";
import type { Env } from "./env.js";

export type { Env } from "./env.js";

const te = new TextEncoder();

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const githubJwks = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

const PLAN_LIMITS: Record<string, { projects: number; users: number }> = {
  free: { projects: 3, users: 5 },
  pro: { projects: 15, users: 25 },
};

function requireAdmin(env: Env, req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  return env.THWIP_ADMIN_TOKEN.length > 0 && auth === `Bearer ${env.THWIP_ADMIN_TOKEN}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

async function reconcileProofsForGithubUser(env: Env, githubUserId: string): Promise<void> {
  const projects = await env.DB.prepare(
    `SELECT DISTINCT p.github_repository_id, o.installation_id
       FROM repository_grants g
       JOIN projects p ON p.id = g.project_id
       JOIN organizations o ON o.id = p.organization_id
      WHERE g.github_user_id = ? AND p.enabled = 1 AND o.installation_id IS NOT NULL`,
  )
    .bind(githubUserId)
    .all<{ github_repository_id: string; installation_id: string }>();
  await Promise.all(
    projects.results.map((project) =>
      env.SYNC_QUEUE.send({
        provider: "dashboard",
        delivery: randomId("key-revoked"),
        event: "proof_reconcile",
        installationId: project.installation_id,
        policyPush: null,
        appProofTask: null,
        reconcileProofRepositoryId: project.github_repository_id,
      }),
    ),
  );
}

async function hmacSha256Hex(secret: string, data: ArrayBuffer | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface ViewerOrg {
  organizationId: string;
  githubOrgId: string;
  githubLogin: string;
  principalId: string;
  githubOrgRole: string | null;
  activated: boolean;
}

interface Viewer {
  baUserId: string;
  githubUserId: string;
  orgs: ViewerOrg[];
  /** the org selected for this request (?org=<github org id>, else first) */
  principalId: string | null;
  organizationId: string | null;
  githubOrgRole: string | null;
  activated: boolean;
}

/**
 * Resolve the signed-in viewer to the GitHub projection. GitHub, not
 * Better Auth, is the authorization source: roles and permissions come from
 * the synced org projections keyed by the numeric GitHub user id. A viewer
 * can belong to several installed organizations; `?org=` selects one.
 */
async function resolveViewer(env: Env, req: Request): Promise<Viewer | null> {
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return null;
  // One round trip: GitHub account id and all org projections together.
  const rows = await env.DB.prepare(
    `SELECT a.accountId, p.id, p.organization_id, p.github_org_role, p.activated_at, o.github_org_id, o.github_login
     FROM account a
     LEFT JOIN principals p ON p.github_user_id = a.accountId
     LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE a.userId = ? AND a.providerId = 'github'
     ORDER BY o.github_login`,
  )
    .bind(session.user.id)
    .all<{
      accountId: string;
      id: string | null;
      organization_id: string | null;
      github_org_role: string | null;
      activated_at: string | null;
      github_org_id: string | null;
      github_login: string | null;
    }>();
  if (rows.results.length === 0) return null;
  const account = { accountId: rows.results[0]!.accountId };
  const orgs: ViewerOrg[] = rows.results
    .filter((r) => r.id !== null && r.organization_id !== null)
    .map((r) => ({
      organizationId: r.organization_id!,
      githubOrgId: r.github_org_id!,
      githubLogin: r.github_login!,
      principalId: r.id!,
      githubOrgRole: r.github_org_role,
      activated: r.activated_at != null,
    }));
  const requested = new URL(req.url).searchParams.get("org");
  const selected = orgs.find((o) => o.githubOrgId === requested || o.githubLogin === requested) ?? orgs[0] ?? null;
  return {
    baUserId: session.user.id,
    githubUserId: account.accountId,
    orgs,
    principalId: selected?.principalId ?? null,
    organizationId: selected?.organizationId ?? null,
    githubOrgRole: selected?.githubOrgRole ?? null,
    activated: selected?.activated ?? false,
  };
}

async function orgPlan(env: Env, organizationId: string): Promise<string> {
  const org = await env.DB.prepare(
    "SELECT plan, better_auth_org_id FROM organizations WHERE id = ?",
  )
    .bind(organizationId)
    .first<{ plan: string; better_auth_org_id: string | null }>();
  if (!org) return "free";
  if (org.better_auth_org_id) {
    const sub = await env.DB.prepare(
      `SELECT status FROM subscription WHERE referenceId = ? AND status IN ('active','trialing') LIMIT 1`,
    )
      .bind(org.better_auth_org_id)
      .first<{ status: string }>();
    if (sub) return "pro";
  }
  return org.plan === "pro" ? "pro" : "free";
}

const app = new Hono<{ Bindings: Env }>();

// --- Better Auth (sessions, GitHub login, device flow, Stripe billing) -----

/**
 * GitHub sends the post-installation redirect to the App's OAuth callback,
 * but that flow was started by GitHub rather than by us, so Better Auth has
 * no stored state and renders state_not_found. An installation_id in the
 * query is the reliable signal; treat those as install completions: sync the
 * new installation and land the operator on their projects.
 */
app.get("/api/auth/callback/github", async (c, next) => {
  const url = new URL(c.req.url);
  const installationId = url.searchParams.get("installation_id");
  if (!installationId) return next();
  try {
    await syncInstallation(c.env, installationId);
    await reconcileInstallationPolicies(c.env, installationId);
    await reconcileInstallationProofChecks(c.env, installationId);
  } catch {
    /* the scheduled reconciliation will pick it up */
  }
  return c.redirect("/dashboard/projects", 302);
});

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

app.get("/health", async (c) => {
  const payload = { service: "thwip", env: c.env.THWIP_ENV, buildSha: c.env.BUILD_SHA, now: nowIso() };
  const jws = await signPayload(c.env, payload, "thwip-health+jws");
  return c.json({ ...payload, jws });
});

/**
 * The keys that verify thwip's signed records.
 *
 * Public and unauthenticated on purpose. A merge record is only evidence if
 * somebody who does not run this service can check it, and that means the
 * verifying key has to be fetchable by anyone holding the record.
 */
app.get("/.well-known/thwip-keys", async (c) => {
  // A cold isolate has not signed anything yet, so `service_keys` may not
  // carry the active key even though it is about to be used. Publishing must
  // not depend on a signature having happened first: a verifier that asks
  // here before the key exists sees an empty set and rejects a chain that is
  // actually fine.
  await serviceKey(c.env);
  const keys = await verificationKeys(c.env.DB as unknown as D1Like);
  return c.json({ keys }, 200, { "cache-control": "public, max-age=300" });
});

// --- Viewer/session bootstrap ---------------------------------------------

app.get("/v1/me", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer) return c.json({ error: "unauthenticated" }, 401);

  // First sign-in linking: attach the Better Auth user to the shadow
  // principal and consume a seat, transactionally against the plan limit.
  if (viewer.principalId && !viewer.activated && viewer.organizationId) {
    const plan = await orgPlan(c.env, viewer.organizationId);
    const limit = PLAN_LIMITS[plan]!.users;
    const result = await c.env.DB.prepare(
      `UPDATE principals SET better_auth_user_id = ?, activated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND activated_at IS NULL
       AND (SELECT COUNT(*) FROM principals WHERE organization_id = ?1 AND activated_at IS NOT NULL) < ?4`
        .replace("?1", "?3"),
    )
      .bind(viewer.baUserId, viewer.principalId, viewer.organizationId, limit)
      .run();
    viewer.activated = (result.meta.changes ?? 0) > 0;
  }

  let org: Record<string, unknown> | null = null;
  if (viewer.organizationId) {
    const row = await c.env.DB.prepare(
      "SELECT id, github_org_id, github_login, installation_id, better_auth_org_id, status FROM organizations WHERE id = ?",
    )
      .bind(viewer.organizationId)
      .first();
    if (row) org = { ...row, plan: await orgPlan(c.env, viewer.organizationId) };
  }
  const principal = viewer.principalId
    ? await c.env.DB.prepare("SELECT github_login, avatar_url, github_org_role, activated_at FROM principals WHERE id = ?")
        .bind(viewer.principalId)
        .first()
    : null;
  return c.json({
    viewer: { ...viewer },
    principal,
    organization: org,
    organizations: viewer.orgs,
    // Lets the dashboard deep-link to "install thwip on another organization"
    // without hardcoding the App slug in the client bundle.
    appSlug: c.env.GITHUB_APP_SLUG,
  });
});

// Owner-run: create/link the Better Auth organization used as the Stripe
// billing reference. GitHub org owners only.
app.post("/v1/organizations/link-billing", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  if (viewer.githubOrgRole !== "owner") return c.json({ error: "github org owner required" }, 403);
  const org = await c.env.DB.prepare(
    "SELECT github_login, better_auth_org_id FROM organizations WHERE id = ?",
  )
    .bind(viewer.organizationId)
    .first<{ github_login: string; better_auth_org_id: string | null }>();
  if (!org) return c.json({ error: "no organization" }, 404);
  if (org.better_auth_org_id) return c.json({ betterAuthOrgId: org.better_auth_org_id });
  const auth = createAuth(c.env);
  const created = await auth.api.createOrganization({
    headers: c.req.raw.headers,
    body: { name: org.github_login, slug: `gh-${org.github_login}`.toLowerCase() },
  });
  if (!created) return c.json({ error: "organization creation failed" }, 500);
  await c.env.DB.prepare("UPDATE organizations SET better_auth_org_id = ? WHERE id = ?")
    .bind(created.id, viewer.organizationId)
    .run();
  return c.json({ betterAuthOrgId: created.id });
});

// --- Dashboard: projects ---------------------------------------------------

app.get("/v1/dashboard/summary", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const orgId = viewer.organizationId;
  const plan = await orgPlan(c.env, orgId);
  const [projects, enabled, members, activated, teams, keys] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) n FROM projects WHERE organization_id = ?").bind(orgId).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) n FROM projects WHERE organization_id = ? AND enabled = 1").bind(orgId).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) n FROM principals WHERE organization_id = ?").bind(orgId).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) n FROM principals WHERE organization_id = ? AND activated_at IS NOT NULL").bind(orgId).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) n FROM github_teams WHERE organization_id = ?").bind(orgId).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) n FROM device_keys WHERE revoked_at IS NULL").first<{ n: number }>(),
  ]);
  return c.json({
    plan,
    limits: PLAN_LIMITS[plan],
    projects: projects?.n ?? 0,
    enabledProjects: enabled?.n ?? 0,
    members: members?.n ?? 0,
    activatedUsers: activated?.n ?? 0,
    teams: teams?.n ?? 0,
    activeKeys: keys?.n ?? 0,
  });
});

app.get("/v1/dashboard/proof-defaults", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const row = await c.env.DB.prepare(
    "SELECT proof_defaults_json FROM organizations WHERE id = ?",
  )
    .bind(viewer.organizationId)
    .first<{ proof_defaults_json: string | null }>();
  if (row === null) return c.json({ error: "organization not found" }, 404);
  return c.json({
    defaults: row.proof_defaults_json === null ? null : (JSON.parse(row.proof_defaults_json) as unknown),
  });
});

app.put("/v1/dashboard/proof-defaults", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  if (viewer.githubOrgRole !== "owner") return c.json({ error: "github organization owner required" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { defaults?: unknown };
  if (body.defaults === undefined) return c.json({ error: "defaults is required" }, 400);
  let defaults: ThwipYaml | null;
  try {
    defaults = body.defaults === null ? null : parseThwipYaml(JSON.stringify(body.defaults));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error), code: "INVALID_DEFAULTS" }, 400);
  }
  await c.env.DB.prepare("UPDATE organizations SET proof_defaults_json = ? WHERE id = ?")
    .bind(defaults === null ? null : JSON.stringify(defaults), viewer.organizationId)
    .run();
  const organization = await c.env.DB.prepare(
    "SELECT installation_id FROM organizations WHERE id = ?",
  )
    .bind(viewer.organizationId)
    .first<{ installation_id: string | null }>();
  if (organization?.installation_id) {
    await c.env.SYNC_QUEUE.send({
      provider: "dashboard",
      delivery: randomId("defaults"),
      event: "policy_reconcile",
      installationId: organization.installation_id,
      policyPush: null,
      appProofTask: null,
      reconcileProofRepositoryId: null,
    });
  }
  return c.json({ defaults });
});

app.get("/v1/dashboard/projects", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.github_repository_id, p.github_name, p.default_branch, p.enabled, p.active_policy_digest,
            p.proof_check_mode,
            CASE
              WHEN p.enabled = 0 THEN 'disabled'
              WHEN p.active_policy_digest IS NULL THEN 'awaiting_policy'
              ELSE 'active'
            END AS activation_state,
            b.version AS policy_version,
            json_extract(b.canonical_json, '$.securityProfile') AS policy_profile,
            b.config_source AS config_source,
            (SELECT COUNT(*) FROM repository_grants g WHERE g.project_id = p.id AND g.active = 1) AS collaborators,
            ${latestVerification("outcome")} AS last_outcome,
            ${latestVerification("at")} AS last_observed_at
     FROM projects p LEFT JOIN policy_bundles b ON b.digest = p.active_policy_digest
     WHERE p.organization_id = ? ORDER BY p.github_name`,
  )
    .bind(viewer.organizationId)
    .all();
  return c.json({ projects: rows.results });
});

app.post("/v1/dashboard/projects/:id/enable", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const projectId = c.req.param("id");
  // Repo admins (from the GitHub projection) or org owners may enable.
  const grant = await c.env.DB.prepare(
    "SELECT permission FROM repository_grants WHERE project_id = ? AND github_user_id = ? AND active = 1",
  )
    .bind(projectId, viewer.githubUserId)
    .first<{ permission: string }>();
  if (viewer.githubOrgRole !== "owner" && grant?.permission !== "admin") {
    return c.json({ error: "repository admin (per GitHub) required" }, 403);
  }
  const plan = await orgPlan(c.env, viewer.organizationId);
  const limit = PLAN_LIMITS[plan]!.projects;
  const result = await c.env.DB.prepare(
    `UPDATE projects SET enabled = 1 WHERE id = ? AND organization_id = ?
     AND (SELECT COUNT(*) FROM projects WHERE organization_id = ?2 AND enabled = 1) < ?3`,
  )
    .bind(projectId, viewer.organizationId, limit)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    return c.json({ error: `plan '${plan}' allows ${limit} enabled projects`, code: "BILLING_LIMIT" }, 402);
  }
  const organization = await c.env.DB.prepare(
    "SELECT installation_id FROM organizations WHERE id = ?",
  )
    .bind(viewer.organizationId)
    .first<{ installation_id: string | null }>();
  if (organization?.installation_id) {
    await c.env.SYNC_QUEUE.send({
      provider: "dashboard",
      delivery: randomId("enable"),
      event: "policy_reconcile",
      installationId: organization.installation_id,
      policyPush: null,
    }).catch(() => undefined);
  }
  return c.json({ enabled: true });
});

app.post("/v1/dashboard/projects/:id/disable", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const projectId = c.req.param("id");
  const grant = await c.env.DB.prepare(
    "SELECT permission FROM repository_grants WHERE project_id = ? AND github_user_id = ? AND active = 1",
  )
    .bind(projectId, viewer.githubUserId)
    .first<{ permission: string }>();
  if (viewer.githubOrgRole !== "owner" && grant?.permission !== "admin") {
    return c.json({ error: "repository admin (per GitHub) required" }, 403);
  }
  const project = await c.env.DB.prepare(
    `SELECT p.github_repository_id, o.installation_id
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE p.id = ? AND p.organization_id = ?`,
  )
    .bind(projectId, viewer.organizationId)
    .first<{ github_repository_id: string; installation_id: string | null }>();
  await c.env.DB.prepare("UPDATE projects SET enabled = 0 WHERE id = ? AND organization_id = ?")
    .bind(projectId, viewer.organizationId)
    .run();
  if (project?.installation_id) {
    await c.env.SYNC_QUEUE.send({
      provider: "dashboard",
      delivery: randomId("disable"),
      event: "proof_reconcile",
      installationId: project.installation_id,
      policyPush: null,
      appProofTask: null,
      reconcileProofRepositoryId: project.github_repository_id,
    });
  }
  return c.json({ enabled: false });
});

app.post("/v1/dashboard/projects/:id/profile", async (c) => {
  return c.json(
    {
      error:
        "the security profile comes from organization defaults and any active thwip.yaml override; change that effective configuration instead",
      code: "MANAGED_IN_EFFECTIVE_CONFIG",
    },
    409,
  );
});

app.post("/v1/dashboard/projects/:id/proof-mode", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const projectId = c.req.param("id");
  const grant = await c.env.DB.prepare(
    "SELECT permission FROM repository_grants WHERE project_id = ? AND github_user_id = ? AND active = 1",
  )
    .bind(projectId, viewer.githubUserId)
    .first<{ permission: string }>();
  if (viewer.githubOrgRole !== "owner" && grant?.permission !== "admin") {
    return c.json({ error: "repository admin (per GitHub) required" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string };
  if (body.mode !== "observe" && body.mode !== "enforced") {
    return c.json({ error: "mode must be observe or enforced" }, 400);
  }
  const project = await c.env.DB.prepare(
    `SELECT p.github_repository_id, p.enabled, o.installation_id
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE p.id = ? AND p.organization_id = ?`,
  )
    .bind(projectId, viewer.organizationId)
    .first<{ github_repository_id: string; enabled: number; installation_id: string | null }>();
  if (project === null) return c.json({ error: "project not found" }, 404);
  if (project.enabled !== 1) return c.json({ error: "enable the project before changing proof mode" }, 409);
  if (body.mode === "enforced") {
    const observed = await c.env.DB.prepare(
      `SELECT id FROM proof_verifications
        WHERE project_id = ? AND mode = 'observe' AND outcome = 'PASS' AND status = 'completed'
          AND policy_digest = (SELECT active_policy_digest FROM projects WHERE id = ?)
          AND julianday(completed_at) > julianday('now', '-7 days')
        ORDER BY completed_at DESC LIMIT 1`,
    )
      .bind(projectId, projectId)
      .first<{ id: string }>();
    if (observed === null) {
      return c.json(
        {
          error: "a recent passing observe-mode App check under the active policy is required before enforcement",
          code: "OBSERVE_PASS_REQUIRED",
        },
        409,
      );
    }
  }
  await c.env.DB.prepare("UPDATE projects SET proof_check_mode = ? WHERE id = ? AND organization_id = ?")
    .bind(body.mode, projectId, viewer.organizationId)
    .run();
  if (project.installation_id !== null) {
    await c.env.SYNC_QUEUE.send({
      provider: "dashboard",
      delivery: randomId("proof-mode"),
      event: "proof_reconcile",
      installationId: project.installation_id,
      policyPush: null,
      appProofTask: null,
      reconcileProofRepositoryId: project.github_repository_id,
    });
  }
  return c.json({ mode: body.mode });
});

// --- Dashboard: people, teams, devices ------------------------------------

app.get("/v1/dashboard/people", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const orgId = viewer.organizationId;
  const members = await c.env.DB.prepare(
    `SELECT github_user_id, github_login, avatar_url, github_org_role, activated_at
     FROM principals WHERE organization_id = ? ORDER BY github_login`,
  )
    .bind(orgId)
    .all();
  const teams = await c.env.DB.prepare(
    `SELECT t.team_id, t.slug, t.name,
            (SELECT COUNT(*) FROM team_members m WHERE m.organization_id = t.organization_id AND m.team_id = t.team_id) AS members,
            (SELECT COUNT(*) FROM team_repos r WHERE r.organization_id = t.organization_id AND r.team_id = t.team_id) AS repos
     FROM github_teams t WHERE t.organization_id = ? ORDER BY t.slug`,
  )
    .bind(orgId)
    .all();
  const teamMembers = await c.env.DB.prepare(
    `SELECT tm.team_id, tm.github_user_id, p.github_login
     FROM team_members tm LEFT JOIN principals p ON p.organization_id = tm.organization_id AND p.github_user_id = tm.github_user_id
     WHERE tm.organization_id = ?`,
  )
    .bind(orgId)
    .all();
  return c.json({
    members: members.results,
    teams: teams.results,
    teamMembers: teamMembers.results,
  });
});

// Per-project access, so the org-wide grant list never grows as
// projects × members.
app.get("/v1/dashboard/projects/:id/access", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const projectId = c.req.param("id");
  const project = await c.env.DB.prepare(
    "SELECT id, github_name FROM projects WHERE id = ? AND organization_id = ?",
  )
    .bind(projectId, viewer.organizationId)
    .first<{ id: string; github_name: string }>();
  if (!project) return c.json({ error: "unknown project" }, 404);
  const grants = await c.env.DB.prepare(
    `SELECT g.github_user_id, g.github_login, g.permission, g.active, g.synced_at,
            p.github_org_role
     FROM repository_grants g
     LEFT JOIN principals p ON p.organization_id = ? AND p.github_user_id = g.github_user_id
     WHERE g.project_id = ?
     ORDER BY g.active DESC, g.permission, g.github_login`,
  )
    .bind(viewer.organizationId, projectId)
    .all();
  const teams = await c.env.DB.prepare(
    `SELECT t.slug, t.name, r.permission
     FROM team_repos r JOIN github_teams t ON t.organization_id = r.organization_id AND t.team_id = r.team_id
     WHERE r.organization_id = ? AND r.github_repository_id = (SELECT github_repository_id FROM projects WHERE id = ?)
     ORDER BY t.slug`,
  )
    .bind(viewer.organizationId, projectId)
    .all();
  return c.json({ project, grants: grants.results, teams: teams.results });
});

/**
 * A viewer's own keys only. Keys are personal: nobody needs to browse a
 * colleague's, and GitHub is the authority for what is currently valid, so
 * this returns both what GitHub lists now and what thwip has seen sign.
 */
app.get("/v1/dashboard/profile", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer) return c.json({ error: "unauthenticated" }, 401);

  const principal = viewer.principalId
    ? await c.env.DB.prepare(
        "SELECT github_login, avatar_url, github_org_role, activated_at FROM principals WHERE id = ?",
      )
        .bind(viewer.principalId)
        .first<{ github_login: string; avatar_url: string | null; github_org_role: string | null; activated_at: string | null }>()
    : null;

  const seen = await c.env.DB.prepare(
    `SELECT key_id, algorithm, fingerprint, device_label, created_at, revoked_at, source
     FROM device_keys WHERE github_user_id = ? ORDER BY source, created_at DESC`,
  )
    .bind(viewer.githubUserId)
    .all();

  let registered: Array<{ fingerprint: string; title: string; githubKeyId: number }> = [];
  let githubError: string | null = null;
  if (principal?.github_login) {
    try {
      const listed = await githubSigningKeys(c.env.GITHUB_SYNC_TOKEN, principal.github_login);
      registered = await Promise.all(
        listed.map(async (k) => ({
          fingerprint: await sha256Fingerprint(k.publicKey),
          title: k.title,
          githubKeyId: k.githubKeyId,
        })),
      );
    } catch (e) {
      githubError = e instanceof Error ? e.message : "cannot read signing keys from GitHub";
    }
  }

  const grants = await c.env.DB.prepare(
    `SELECT p.github_name, g.permission, g.active
     FROM repository_grants g JOIN projects p ON p.id = g.project_id
     WHERE g.github_user_id = ? AND p.organization_id = ? ORDER BY p.github_name`,
  )
    .bind(viewer.githubUserId, viewer.organizationId)
    .all();

  return c.json({
    principal,
    githubUserId: viewer.githubUserId,
    organizations: viewer.orgs,
    registered,
    githubError,
    seen: seen.results,
    access: grants.results,
  });
});

app.post("/v1/dashboard/devices/:keyId/revoke", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const keyId = c.req.param("keyId");
  const key = await c.env.DB.prepare("SELECT github_user_id FROM device_keys WHERE key_id = ?")
    .bind(keyId)
    .first<{ github_user_id: string }>();
  if (!key) return c.json({ error: "unknown key" }, 404);
  // Keys are personal: you may deny your own. Removing a key from GitHub is
  // the general revocation; this is the organization-local kill switch.
  if (key.github_user_id !== viewer.githubUserId) {
    return c.json({ error: "you can only deny your own keys" }, 403);
  }
  const revoked = await c.env.DB.prepare(
    `UPDATE device_keys SET revoked_at = ?, revoked_reason = ?
      WHERE key_id = ? AND revoked_at IS NULL
      RETURNING github_user_id`,
  )
    .bind(nowIso(), `revoked by ${viewer.githubUserId}`, keyId)
    .first<{ github_user_id: string }>();
  if (revoked !== null) await reconcileProofsForGithubUser(c.env, revoked.github_user_id);
  return c.json({ revoked: revoked !== null });
});

// --- Dashboard: policy, billing, operations --------------------------------

app.get("/v1/dashboard/policies", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const rows = await c.env.DB.prepare(
    `SELECT b.digest, b.project_id, p.github_name, b.version, b.status, b.created_at, b.activated_at, b.canonical_json
     FROM policy_bundles b JOIN projects p ON p.id = b.project_id
     WHERE p.organization_id = ? ORDER BY p.github_name, b.version DESC`,
  )
    .bind(viewer.organizationId)
    .all();
  return c.json({ policies: rows.results });
});

app.get("/v1/dashboard/billing", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const org = await c.env.DB.prepare(
    "SELECT better_auth_org_id FROM organizations WHERE id = ?",
  )
    .bind(viewer.organizationId)
    .first<{ better_auth_org_id: string | null }>();
  const plan = await orgPlan(c.env, viewer.organizationId);
  let subscription: unknown = null;
  if (org?.better_auth_org_id) {
    subscription = await c.env.DB.prepare(
      "SELECT plan, status, periodEnd, cancelAtPeriodEnd, billingInterval FROM subscription WHERE referenceId = ? ORDER BY periodEnd DESC LIMIT 1",
    )
      .bind(org.better_auth_org_id)
      .first();
  }
  return c.json({
    plan,
    limits: PLAN_LIMITS[plan],
    betterAuthOrgId: org?.better_auth_org_id ?? null,
    subscription,
    prices: { monthly: "$5", annual: "$50" },
    isOwner: viewer.githubOrgRole === "owner",
  });
});

app.get("/v1/dashboard/operations", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const deliveries = await c.env.DB.prepare(
    "SELECT provider, delivery_id, event, received_at FROM webhook_deliveries ORDER BY received_at DESC LIMIT 25",
  ).all();
  const observations = await c.env.DB.prepare(
    `SELECT github_name, head_sha, outcome, observed_at
       FROM (
         SELECT p.github_name, v.subject_sha AS head_sha, v.outcome, v.completed_at AS observed_at
           FROM proof_verifications v JOIN projects p ON p.id = v.project_id
          WHERE p.organization_id = ? AND v.status = 'completed'
         UNION ALL
         SELECT p.github_name, o.head_sha, o.outcome, o.observed_at
           FROM verification_observations o JOIN projects p ON p.id = o.project_id
          WHERE p.organization_id = ?
       )
      ORDER BY observed_at DESC LIMIT 25`,
  )
    .bind(viewer.organizationId, viewer.organizationId)
    .all();
  return c.json({ deliveries: deliveries.results, observations: observations.results });
});

app.post("/v1/dashboard/sync", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  if (viewer.githubOrgRole !== "owner") return c.json({ error: "github org owner required" }, 403);
  const org = await c.env.DB.prepare("SELECT installation_id FROM organizations WHERE id = ?")
    .bind(viewer.organizationId)
    .first<{ installation_id: string | null }>();
  if (!org?.installation_id) return c.json({ error: "no installation linked" }, 400);
  const counts = await syncInstallation(c.env, org.installation_id);
  const policies = await reconcileInstallationPolicies(c.env, org.installation_id);
  const proofChecks = await reconcileInstallationProofChecks(c.env, org.installation_id);
  return c.json({ synced: counts, policies, proofChecks });
});

// --- Device enrollment -----------------------------------------------------

async function enrollmentIdentity(c: { env: Env; req: { raw: Request } }): Promise<
  { kind: "admin" } | { kind: "user"; githubUserId: string } | null
> {
  if (requireAdmin(c.env, c.req.raw)) return { kind: "admin" };
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (viewer?.githubUserId) return { kind: "user", githubUserId: viewer.githubUserId };
  return null;
}

app.post("/v1/devices/challenges", async (c) => {
  const identity = await enrollmentIdentity(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const challenge = randomId("chal");
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await c.env.DB.prepare("INSERT INTO enroll_challenges (challenge, expires_at) VALUES (?, ?)")
    .bind(challenge, expires)
    .run();
  return c.json({ challenge, expiresAt: expires });
});

app.post("/v1/devices", async (c) => {
  const identity = await enrollmentIdentity(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json()) as {
    publicKey?: string;
    label?: string;
    githubUserId?: string;
    challenge?: string;
    proofOfPossession?: string;
  };
  if (!body.publicKey || !body.challenge || !body.proofOfPossession) {
    return c.json({ error: "missing fields" }, 400);
  }
  // A session-authenticated user may only enroll keys for their own GitHub
  // identity; the operator admin token may specify one.
  const githubUserId = identity.kind === "user" ? identity.githubUserId : body.githubUserId;
  if (!githubUserId || !/^[0-9]+$/.test(githubUserId)) return c.json({ error: "githubUserId invalid" }, 400);

  const row = await c.env.DB.prepare(
    "UPDATE enroll_challenges SET consumed_at = ? WHERE challenge = ? AND consumed_at IS NULL AND expires_at > ? RETURNING challenge",
  )
    .bind(nowIso(), body.challenge, nowIso())
    .first();
  if (!row) return c.json({ error: "challenge invalid or consumed" }, 400);

  const popOk = await verifySshSigEd25519({
    publicKey: body.publicKey,
    namespace: "thwip-enroll-v1",
    message: te.encode(body.challenge),
    signatureBase64: body.proofOfPossession,
  });
  if (!popOk) return c.json({ error: "proof of possession failed" }, 400);

  const keyId = randomId("key");
  const fingerprint = await sha256Fingerprint(body.publicKey);
  const algorithm = body.publicKey.trim().split(/\s+/)[0]!;
  try {
    await c.env.DB.prepare(
      "INSERT INTO device_keys (key_id, github_user_id, algorithm, public_key, fingerprint, device_label) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(keyId, githubUserId, algorithm, body.publicKey.trim(), fingerprint, body.label ?? "device")
      .run();
  } catch {
    return c.json({ error: "key already enrolled" }, 409);
  }
  return c.json({ keyId, fingerprint, githubUserId });
});

app.post("/v1/devices/:keyId/revoke", async (c) => {
  if (!requireAdmin(c.env, c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const { reason } = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const revoked = await c.env.DB.prepare(
    `UPDATE device_keys SET revoked_at = ?, revoked_reason = ?
      WHERE key_id = ? AND revoked_at IS NULL
      RETURNING github_user_id`,
  )
    .bind(nowIso(), reason ?? "revoked", c.req.param("keyId"))
    .first<{ github_user_id: string }>();
  if (revoked !== null) await reconcileProofsForGithubUser(c.env, revoked.github_user_id);
  return c.json({ revoked: revoked !== null });
});

// --- Admin bootstrap / sync ------------------------------------------------

app.post("/admin/seed", async (c) => {
  if (!requireAdmin(c.env, c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json()) as {
    organization: { githubOrgId: string; githubLogin: string };
    project: { githubRepositoryId: string; githubName: string; defaultBranch: string; securityProfile: string };
    policy: { canonicalJson: string; digest: string; version: number };
    grants: Array<{ githubUserId: string; githubLogin: string; permission: string }>;
  };
  const orgId = randomId("org");
  const projectId = randomId("prj");
  const stmts = [
    c.env.DB.prepare(
      "INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?) ON CONFLICT(github_org_id) DO UPDATE SET github_login = excluded.github_login",
    ).bind(orgId, body.organization.githubOrgId, body.organization.githubLogin),
    c.env.DB.prepare(
      `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled, active_policy_digest, security_profile)
       SELECT ?, o.id, ?, ?, ?, 1, ?, ? FROM organizations o WHERE o.github_org_id = ?
       ON CONFLICT(github_repository_id) DO UPDATE SET github_name = excluded.github_name, default_branch = excluded.default_branch, enabled = 1, active_policy_digest = excluded.active_policy_digest, security_profile = excluded.security_profile`,
    ).bind(
      projectId,
      body.project.githubRepositoryId,
      body.project.githubName,
      body.project.defaultBranch,
      body.policy.digest,
      body.project.securityProfile,
      body.organization.githubOrgId,
    ),
    c.env.DB.prepare(
      `INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status, activated_at)
       SELECT ?, p.id, ?, ?, 'active', ? FROM projects p WHERE p.github_repository_id = ?
       ON CONFLICT(digest) DO UPDATE SET status = 'active', activated_at = excluded.activated_at`,
    ).bind(body.policy.digest, body.policy.version, body.policy.canonicalJson, nowIso(), body.project.githubRepositoryId),
    c.env.DB.prepare(
      `UPDATE policy_bundles SET status = 'retired' WHERE project_id = (SELECT id FROM projects WHERE github_repository_id = ?) AND digest != ? AND status = 'active'`,
    ).bind(body.project.githubRepositoryId, body.policy.digest),
  ];
  for (const g of body.grants) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active, synced_at)
         SELECT p.id, ?, ?, ?, 1, ? FROM projects p WHERE p.github_repository_id = ?
         ON CONFLICT(project_id, github_user_id) DO UPDATE SET permission = excluded.permission, active = 1, synced_at = excluded.synced_at`,
      ).bind(g.githubUserId, g.githubLogin, g.permission, nowIso(), body.project.githubRepositoryId),
    );
  }
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

app.post("/admin/sync", async (c) => {
  if (!requireAdmin(c.env, c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const installations = await listInstallations(c.env);
  // The proof-check pass reads open pull requests, which needs a permission an
  // installation may not hold. It used to throw out of here, so a reconcile
  // that had already finished came back as a 500 and an operator retried work
  // that was done. See admin-sync.ts.
  const report = await syncInstallations(installations, {
    syncInstallation: (installationId) => syncInstallation(c.env, installationId),
    reconcilePolicies: (installationId) => reconcileInstallationPolicies(c.env, installationId),
    reconcileProofChecks: (installationId) => reconcileInstallationProofChecks(c.env, installationId),
  });
  return c.json(report);
});

/**
 * Queue doctor (plan.md §30.4). Reports what the App is actually granted and what
 * the branch actually requires, because setup must never assume that creating a
 * ruleset produced effective enforcement, nor that the App can publish the check
 * the branch will require.
 */
/**
 * The same diagnostic, reachable by a repository administrator with their normal
 * session. A person who can change the ruleset needs to be able to see whether the
 * App can actually publish the check it would require; making that operator-only
 * would mean the people doing the setup cannot check their own work.
 */
/**
 * Who counts as an administrator for queue operations.
 *
 * GitHub's projections use `owner` for the people who created or own the
 * organization and `admin` for org administrators, and both can change rulesets.
 * Checking only for `admin` locked out owners — the people most likely to be
 * running setup in the first place.
 */
function isOrgAdmin(role: string | null): boolean {
  return role === "admin" || role === "owner";
}

async function queueDoctor(env: Env, repo: string): Promise<Response> {
  const installations = await listInstallations(env);
  const owner = repo.split("/")[0];
  const installation = installations.find((i) => i.account.login.toLowerCase() === owner?.toLowerCase());
  if (installation === undefined) return Response.json({ error: `no installation for ${owner}` }, { status: 404 });

  const token = await installationToken(env, String(installation.id));
  const gh = async <T>(path: string): Promise<T | { error: string; status: number }> => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "thwip-control-plane",
      },
    });
    if (!res.ok) return { error: await res.text(), status: res.status };
    return (await res.json()) as T;
  };

  const rulesets = await gh<Array<{ id: number; name: string; enforcement: string }>>(
    `/repos/${repo}/rulesets`,
  );
  const required: Record<string, string> = {
    checks: "write",
    contents: "write",
    pull_requests: "write",
    statuses: "write",
  };
  const granted = installation.permissions ?? {};
  const missing = Object.entries(required).filter(([scope, level]) => granted[scope] !== level);

  // What the App is subscribed to, against what the router handles. This
  // installation delivered `check_suite` and nothing else for months, so every
  // other handler was dead code in production while the manifest, the tests and
  // the review all said otherwise. The doctor is where an operator already
  // looks when the queue is not moving, and it is the only surface that can see
  // the live subscription at all.
  const events = webhookEventDrift(installation.events);

  return Response.json({
    repo,
    installationId: String(installation.id),
    grantedPermissions: granted,
    requiredPermissions: required,
    missingPermissions: Object.fromEntries(missing),
    canPublishMergeCheck: missing.every(([scope]) => scope !== "checks"),
    canMerge: missing.every(([scope]) => scope !== "contents" && scope !== "pull_requests"),
    subscribedEvents: events.subscribed,
    handledEvents: events.handled,
    deadHandlers: events.deadHandlers,
    unreadSubscriptions: events.unreadSubscriptions,
    subscriptionKnown: events.known,
    receivesEveryHandledEvent: events.healthy,
    rulesets,
  });
}

app.get("/admin/queue/doctor", async (c) => {
  if (!requireAdmin(c.env, c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const repo = c.req.query("repo") ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return c.json({ error: "repo must be owner/name" }, 400);
  return queueDoctor(c.env, repo);
});

app.get("/v1/queue/:repositoryId/doctor", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (viewer === null) return c.json({ error: "unauthorized" }, 401);
  if (!isOrgAdmin(viewer.githubOrgRole)) return c.json({ error: "repository admin required" }, 403);
  const repositoryId = c.req.param("repositoryId");
  if (!/^[0-9]{1,32}$/.test(repositoryId)) return c.json({ error: "invalid repository id" }, 400);
  const row = await c.env.DB.prepare("SELECT github_name FROM projects WHERE github_repository_id = ?")
    .bind(repositoryId)
    .first<{ github_name: string }>();
  if (row === null) return c.json({ error: "unknown repository" }, 404);
  return queueDoctor(c.env, row.github_name);
});

// Resolve a repository's GitHub numeric ids from its full name. The
// projection already holds every installed repository, so no GitHub call.
app.get("/v1/resolve-repo", async (c) => {
  const identity = await enrollmentIdentity(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const name = c.req.query("name") ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return c.json({ error: "name must be owner/repo" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT p.github_repository_id, o.github_org_id FROM projects p
     JOIN organizations o ON o.id = p.organization_id WHERE p.github_name = ?`,
  )
    .bind(name)
    .first<{ github_repository_id: string; github_org_id: string }>();
  if (!row) return c.json({ error: "repository not installed for thwip" }, 404);
  return c.json({ ownerId: row.github_org_id, repositoryId: row.github_repository_id });
});

app.get("/v1/project-config/defaults", async (c) => {
  const identity = await enrollmentIdentity(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const repositoryId = c.req.query("repositoryId") ?? "";
  if (!/^[0-9]+$/.test(repositoryId)) return c.json({ error: "repositoryId invalid" }, 400);
  const project = await c.env.DB.prepare(
    `SELECT p.id, p.active_policy_digest, o.proof_defaults_json,
            b.config_source
       FROM projects p
       JOIN organizations o ON o.id = p.organization_id
       LEFT JOIN policy_bundles b ON b.digest = p.active_policy_digest
      WHERE p.github_repository_id = ?`,
  )
    .bind(repositoryId)
    .first<{
      id: string;
      active_policy_digest: string | null;
      proof_defaults_json: string | null;
      config_source: string | null;
    }>();
  if (project === null) return c.json({ error: "repository not installed for thwip" }, 404);
  if (identity.kind === "user") {
    const grant = await c.env.DB.prepare(
      "SELECT 1 AS allowed FROM repository_grants WHERE project_id = ? AND github_user_id = ? AND active = 1",
    )
      .bind(project.id, identity.githubUserId)
      .first<{ allowed: number }>();
    if (grant === null) return c.json({ error: "repository access required" }, 403);
  }
  return c.json({
    defaults:
      project.proof_defaults_json === null ? null : (JSON.parse(project.proof_defaults_json) as unknown),
    activePolicyDigest: project.active_policy_digest,
    activeConfigSource: project.config_source,
  });
});

// --- Run leases ------------------------------------------------------------

app.post("/v1/run-leases", async (c) => {
  const identity = await enrollmentIdentity(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json()) as {
    repositoryId?: string;
    treeOid?: string;
    parentOids?: string[];
    baseSha?: string;
    deviceKeyId?: string;
  };
  if (!body.repositoryId || !body.treeOid || !body.deviceKeyId) return c.json({ error: "missing fields" }, 400);
  const project = await c.env.DB.prepare(
    "SELECT id, active_policy_digest, security_profile FROM projects WHERE github_repository_id = ? AND enabled = 1",
  )
    .bind(body.repositoryId)
    .first<{ id: string; active_policy_digest: string; security_profile: string }>();
  if (!project) return c.json({ error: "project not enabled" }, 404);
  // The window closes when the policy stops accepting it. Read the lifetime
  // from the active policy rather than restating it here: a lease that outlives
  // `lease.maxAgeSeconds` is refused by the verifier while still looking valid
  // to the runner holding it.
  const activePolicy = await c.env.DB.prepare("SELECT canonical_json FROM policy_bundles WHERE digest = ?")
    .bind(project.active_policy_digest)
    .first<{ canonical_json: string }>();
  if (!activePolicy) return c.json({ error: "no active policy" }, 409);
  const leaseSeconds = (JSON.parse(activePolicy.canonical_json) as { lease?: { maxAgeSeconds?: unknown } }).lease
    ?.maxAgeSeconds;
  if (typeof leaseSeconds !== "number" || leaseSeconds <= 0) {
    return c.json({ error: "the active policy does not bound a run lease" }, 409);
  }
  const lease = await mintRunLease(c.env, {
    project: {
      activePolicyDigest: project.active_policy_digest,
      securityProfile: project.security_profile,
    },
    request: {
      repositoryId: body.repositoryId,
      treeOid: body.treeOid,
      parentOids: body.parentOids ?? [],
      baseSha: body.baseSha ?? null,
      deviceKeyId: body.deviceKeyId,
    },
    leaseSeconds,
  });
  return c.json({ lease, expiresInSeconds: leaseSeconds });
});

// --- Verification bundles --------------------------------------------------

interface OidcClaims {
  repository_id?: string;
  repository_owner_id?: string;
  repository?: string;
  run_id?: string;
  event_name?: string;
}

async function verifyGithubOidc(c: { env: Env; req: { raw: Request } }): Promise<OidcClaims | Response> {
  const auth = c.req.raw.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return Response.json({ error: "missing bearer token" }, { status: 401 });
  const token = auth.slice(7);
  try {
    const { payload } = await jwtVerify(token, githubJwks, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: `${c.env.PUBLIC_ORIGIN}/api/github-actions`,
    });
    return payload as OidcClaims;
  } catch {
    return Response.json({ error: "oidc verification failed" }, { status: 401 });
  }
}

app.post("/v1/verification-bundles:resolve", async (c) => {
  const claims = await verifyGithubOidc(c);
  if (claims instanceof Response) return claims;

  const body = (await c.req.json()) as {
    repositoryId?: string;
    headSha?: string;
    signerGithubUserId?: string;
    keyFingerprint?: string;
  };
  if (!body.repositoryId || !/^[0-9]+$/.test(body.repositoryId)) return c.json({ error: "repositoryId invalid" }, 400);
  if (String(claims.repository_id) !== body.repositoryId) {
    return c.json({ error: "repository not authorized by OIDC token" }, 403);
  }
  try {
    const resolution = await resolveVerificationBundle(c.env, {
      repositoryId: body.repositoryId,
      ...(body.signerGithubUserId !== undefined ? { signerGithubUserId: body.signerGithubUserId } : {}),
      ...(body.keyFingerprint !== undefined ? { keyFingerprint: body.keyFingerprint } : {}),
    });
    if (resolution.kind === "bootstrap_pending") {
      return c.json({
        state: resolution.kind,
        code: resolution.code,
        repositoryId: body.repositoryId,
        repository: resolution.repository,
        defaultBranch: resolution.defaultBranch,
      });
    }
    return c.json({
      state: "active",
      bundle: await signPayload(c.env, resolution.bundle, "thwip-bundle+jws"),
    });
  } catch (error) {
    if (error instanceof VerificationBundleError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    throw error;
  }
});

app.post("/v1/verification-observations", async (c) => {
  const claims = await verifyGithubOidc(c);
  if (claims instanceof Response) return claims;
  const body = (await c.req.json()) as { repositoryId?: string; headSha?: string; outcome?: string; runId?: string };
  if (!body.repositoryId || String(claims.repository_id) !== body.repositoryId) return c.json({ error: "forbidden" }, 403);
  if (!body.headSha || !body.outcome || body.outcome.length > 64) return c.json({ error: "invalid" }, 400);
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE github_repository_id = ?")
    .bind(body.repositoryId)
    .first<{ id: string }>();
  if (!project) return c.json({ error: "unknown project" }, 404);
  await c.env.DB.prepare(
    "INSERT INTO verification_observations (project_id, head_sha, outcome, run_id) VALUES (?, ?, ?, ?)",
  )
    .bind(project.id, body.headSha, body.outcome, body.runId ?? null)
    .run();
  return c.json({ ok: true });
});

app.get("/v1/proof-verifications/:id", async (c) => {
  const identity = await enrollmentIdentity(c);
  if (!identity) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.DB.prepare(
    `SELECT v.id, v.project_id, v.event, v.subject_sha, v.base_ref, v.policy_digest,
            v.verifier_version, v.mode, v.status, v.outcome, v.detail, v.check_name,
            v.check_run_id, v.audit_jws, v.started_at, v.completed_at, p.github_name
       FROM proof_verifications v JOIN projects p ON p.id = v.project_id
      WHERE v.id = ?`,
  )
    .bind(c.req.param("id"))
    .first<{
      id: string;
      project_id: string;
      event: string;
      subject_sha: string;
      base_ref: string;
      policy_digest: string | null;
      verifier_version: string;
      mode: string;
      status: string;
      outcome: string | null;
      detail: string | null;
      check_name: string;
      check_run_id: string | null;
      audit_jws: string | null;
      started_at: string;
      completed_at: string | null;
      github_name: string;
    }>();
  if (row === null) return c.json({ error: "verification not found" }, 404);
  if (identity.kind === "user") {
    const grant = await c.env.DB.prepare(
      "SELECT 1 AS allowed FROM repository_grants WHERE project_id = ? AND github_user_id = ? AND active = 1",
    )
      .bind(row.project_id, identity.githubUserId)
      .first<{ allowed: number }>();
    if (grant === null) return c.json({ error: "repository access required" }, 403);
  }
  return c.json({
    verification: {
      id: row.id,
      repository: row.github_name,
      event: row.event,
      subjectSha: row.subject_sha,
      baseRef: row.base_ref,
      policyDigest: row.policy_digest,
      verifierVersion: row.verifier_version,
      mode: row.mode,
      status: row.status,
      outcome: row.outcome,
      detail: row.detail,
      checkName: row.check_name,
      checkRunId: row.check_run_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    },
    auditJws: row.audit_jws,
  });
});

/**
 * Turn a pull_request webhook into a queue entry and a readiness evaluation.
 *
 * This is why no workflow needs to enqueue anything: the control plane learns
 * about a pull request from GitHub directly, so the queue cannot be bypassed by
 * someone not running a command, and there is no token in CI that can enqueue on
 * a developer's behalf.
 *
 * It is deliberately tolerant. A repository with no queue configured, or an event
 * for a branch the queue does not manage, is ignored rather than treated as an
 * error — most repositories in an installation are not queue projects.
 */
export async function queueFromPullRequest(env: Env, payload: {
  action?: string;
  pull_request?: {
    number?: number;
    draft?: boolean;
    state?: string;
    base?: { ref?: string; repo?: { id?: number } };
    head?: { sha?: string };
    user?: { id?: number; login?: string; type?: string };
  };
}): Promise<{ handled: boolean; detail: string }> {
  const pr = payload.pull_request;
  const repositoryId = pr?.base?.repo?.id;
  const baseRef = pr?.base?.ref;
  const number = pr?.number;
  const headSha = pr?.head?.sha;
  if (repositoryId == null || baseRef == null || number == null || headSha == null) {
    return { handled: false, detail: "not a pull request event we can place" };
  }

  const ref = `refs/heads/${baseRef}`;
  const entryId = `entry_${repositoryId}_${number}`;
  const action = payload.action ?? "sync";

  // Cancelling needs nothing but the entry's own address.
  //
  // This used to sit behind the project-configured and activated-principal
  // lookups below, both of which exist to decide whether a *new* entry may be
  // placed. A closed pull request that already has an entry needs neither: it
  // is not asking to be placed, it is asking to leave. Gating the cancel
  // behind them meant a queue whose project row had gone quiet, or an author
  // whose principal no longer resolved, silently kept a closed pull request
  // holding the lane — which starved everything behind it until an operator
  // ejected it by hand. That happened three times in one night, to pull
  // requests 78, 96 and 97, each already merged.
  if (action === "closed") {
    const { snapshot } = await runOnQueue(env, String(repositoryId), ref, ({ commands }) => {
      commands.cancel({
        idempotencyKey: `webhook:closed:${entryId}:${headSha}`,
        entryId,
        actorPrincipalId: "github",
        reason: "the pull request was closed",
      });
    });

    // Cancelling a closed entry that held the lane frees it exactly like an
    // eject does, and the same ninety-second offer expires unclaimed unless
    // something drives it. The eject route drives through `driveLane`; this
    // webhook has no route deps to borrow it from, so it repeats the same
    // lookup directly against `driveTurnFor`, the same dispatcher the route
    // uses underneath — and the same `requiresDeviceOnly` check `driveLane`
    // applies, read here with `readActivePolicy` directly rather than through
    // a `deps` object this module-level handler does not have. Skipping the
    // check would spend an Actions run under `fresh`/`audited`, where no
    // workflow can ever claim it.
    const holder = snapshot.entries.find((e) => e.state === "Offered" || e.state === "Active");
    if (holder !== undefined) {
      const policy = await readActivePolicy(env.DB as unknown as D1Like, String(repositoryId));
      if (!requiresDeviceOnly(policy?.securityProfile ?? null)) {
        try {
          await driveTurnFor(env, String(repositoryId), holder.pullRequestNumber);
        } catch {
          /* the turn survives; a later tick or the drain asks again */
        }
      }
    }

    return { handled: true, detail: "entry cancelled" };
  }

  const project = await env.DB.prepare(
    "SELECT activation_state FROM queue_projects WHERE github_repository_id = ? AND base_ref = ? AND enabled = 1",
  )
    .bind(String(repositoryId), ref)
    .first<{ activation_state: string }>();
  if (project === null) return { handled: false, detail: "no queue configured for this branch" };

  // The sponsor is the pull request's author, resolved through the projection so a
  // fairness share belongs to a person rather than to a login string.
  const authorId = pr?.user?.id;
  const principal =
    authorId == null
      ? null
      : await env.DB.prepare("SELECT id FROM principals WHERE github_user_id = ?")
          .bind(String(authorId))
          .first<{ id: string }>();
  if (principal === null) return { handled: false, detail: "author has no activated principal" };

  const draft = pr?.draft === true;
  const open = pr?.state === "open";
  const ready = !draft && open;
  const basePrimaryReason: BlockingReason | null = draft ? "PR_DRAFT" : !open ? "PR_CLOSED" : null;

  // A developer who is already heartbeating when the pull request is opened
  // must not need an absent-to-present transition to become eligible — the
  // heartbeat route only fires on that transition, so if this webhook wrote
  // AGENT_OFFLINE unconditionally here, a machine that showed up first would
  // never be corrected. Read before the transaction for the same reason
  // `/authorize` does: `runOnQueue`'s callback is synchronous.
  const policy = await readActivePolicy(env.DB as unknown as D1Like, String(repositoryId));
  const capability = ready
    ? await capabilityFor(
        env.DB as unknown as D1Like,
        String(repositoryId),
        principal.id,
        new Date().toISOString(),
        policy?.securityProfile ?? null,
      )
    : { serverExecutable: true, compatibleRunnerConnected: false };
  const folded = foldCapability({ ready, primaryReason: basePrimaryReason }, capability);

  await runOnQueue(env, String(repositoryId), ref, ({ commands }) => {
    commands.requestQueue({
      idempotencyKey: `webhook:request:${entryId}`,
      entryId,
      pullRequestNumber: number,
      sponsorPrincipalId: principal.id,
      sponsorGithubUserId: String(authorId),
      headSha,
    });

    // Readiness is re-derived from what GitHub just told us plus what it already
    // said; the event alone never decides it.
    commands.evaluateReadiness({
      idempotencyKey: `webhook:ready:${entryId}:${headSha}:${action}`,
      entryId,
      ready,
      schedulerEligible: folded.schedulerEligible,
      primaryReason: folded.primaryReason,
    });
  });

  return { handled: true, detail: `placed in ${project.activation_state}` };
}

// --- GitHub webhooks -------------------------------------------------------

app.post("/api/github/webhooks", async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "webhooks not configured" }, 503);
  const raw = await c.req.raw.arrayBuffer();
  if (raw.byteLength > 2 * 1024 * 1024) return c.json({ error: "too large" }, 413);
  const sig = c.req.header("x-hub-signature-256") ?? "";
  const expected = `sha256=${await hmacSha256Hex(secret, raw)}`;
  if (!timingSafeEqualHex(sig, expected)) return c.json({ error: "bad signature" }, 401);
  const delivery = c.req.header("x-github-delivery") ?? randomId("dlv");
  const event = c.req.header("x-github-event") ?? "unknown";
  let duplicate = false;
  try {
    await c.env.DB.prepare("INSERT INTO webhook_deliveries (provider, delivery_id, event) VALUES ('github', ?, ?)")
      .bind(delivery, event)
      .run();
  } catch {
    duplicate = true;
  }
  let installationId: string | null = null;
  let payload: GithubPolicyWebhookPayload & { repository?: { id?: number; default_branch?: string } } = {};
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as typeof payload;
    installationId = payload.installation?.id != null ? String(payload.installation.id) : null;
  } catch {
    /* hint only */
  }
  if (duplicate) return c.json({ ok: true, duplicate: true, queued: { handled: false, detail: "duplicate delivery" } });
  // Queue placement happens inline rather than through the projection queue: the
  // Durable Object is the authority and a delayed entry would mean a pull request
  // sits outside the queue for as long as the backlog is deep.
  let queued = { handled: false, detail: "not a queue event" };
  if (event === "pull_request") {
    try {
      queued = await queueFromPullRequest(c.env, payload as never);
    } catch (error) {
      queued = { handled: false, detail: error instanceof Error ? error.message : "queue placement failed" };
    }
  }

  // A push to the guarded branch that the queue did not make.
  //
  // The reducer has paused on this since the beginning and nothing ever told it,
  // so a branch that moved underneath the queue left it certifying merges onto a
  // tree it had never seen. The event, the invariant and the command all existed;
  // the caller did not.
  const external = externalPushFromWebhook(event, payload as never);
  if (external !== null) {
    try {
      queued = await queueExternalMove(c.env, external);
    } catch (error) {
      queued = { handled: false, detail: error instanceof Error ? error.message : "external move failed" };
    }
  }

  const policyPush = policyPushFromGithubWebhook(event, payload);
  const appProofTask = appProofTaskFromWebhook(event, payload as never);
  const reconcileProofRepositoryId =
    event === "push" &&
    payload.repository?.id != null &&
    payload.ref === `refs/heads/${payload.repository.default_branch ?? ""}`
      ? String(payload.repository.id)
      : null;
  await c.env.SYNC_QUEUE.send({
    provider: "github",
    delivery,
    event,
    installationId,
    policyPush,
    appProofTask,
    reconcileProofRepositoryId,
  });
  return c.json({ ok: true, duplicate, queued });
});

// --- Stripe webhooks (entitlement mirror; Better Auth has its own route) ---

app.post("/api/stripe/webhook", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "stripe not configured" }, 503);
  const raw = await c.req.raw.text();
  if (raw.length > 2 * 1024 * 1024) return c.json({ error: "too large" }, 413);
  const sigHeader = c.req.header("stripe-signature") ?? "";
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v];
    }),
  ) as Record<string, string>;
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return c.json({ error: "bad signature header" }, 400);
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return c.json({ error: "timestamp out of tolerance" }, 400);
  const expected = await hmacSha256Hex(secret, te.encode(`${t}.${raw}`));
  if (!timingSafeEqualHex(v1, expected)) return c.json({ error: "bad signature" }, 401);

  const event = JSON.parse(raw) as {
    id: string;
    type: string;
    data: { object: { id?: string; customer?: string; status?: string; metadata?: Record<string, string> } };
  };
  try {
    await c.env.DB.prepare("INSERT INTO stripe_events (event_id, type) VALUES (?, ?)").bind(event.id, event.type).run();
  } catch {
    return c.json({ ok: true, duplicate: true });
  }
  if (event.type.startsWith("customer.subscription.")) {
    const sub = event.data.object;
    const orgId = sub.metadata?.["thwip_org_github_id"];
    const active = sub.status === "active" || sub.status === "trialing";
    if (orgId) {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO stripe_state (organization_id, stripe_customer_id, stripe_subscription_id, plan, status, updated_at)
           SELECT o.id, ?, ?, ?, ?, ? FROM organizations o WHERE o.github_org_id = ?
           ON CONFLICT(organization_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = excluded.stripe_subscription_id, plan = excluded.plan, status = excluded.status, updated_at = excluded.updated_at`,
        ).bind(String(sub.customer ?? ""), sub.id ?? "", active ? "pro" : "free", sub.status ?? "unknown", nowIso(), orgId),
        c.env.DB.prepare("UPDATE organizations SET plan = ? WHERE github_org_id = ?").bind(active ? "pro" : "free", orgId),
      ]);
    }
  }
  return c.json({ received: true });
});

// --- GitHub App manifest bootstrap (one-time; disabled once App exists) ----

app.get("/admin/github/manifest", async (c) => {
  if (c.env.GITHUB_APP_ID) return c.text("App already registered; manifest bootstrap disabled.", 410);
  const org = c.req.query("org") ?? "recallnet";
  const state = randomId("mfst");
  await c.env.DB.prepare("INSERT INTO enroll_challenges (challenge, expires_at) VALUES (?, ?)")
    .bind(state, new Date(Date.now() + 3600_000).toISOString())
    .run();
  const origin = c.env.PUBLIC_ORIGIN;
  const manifest = {
    name: c.env.THWIP_ENV === "production" ? "thwip" : "thwip dev",
    url: origin,
    description: "Git-native CI proofs for agent-run pipelines.",
    hook_attributes: { url: `${origin}/api/github/webhooks`, active: true },
    redirect_url: `${origin}/admin/github/manifest/callback`,
    callback_urls: [`${origin}/api/auth/callback/github`],
    setup_url: `${origin}/dashboard`,
    setup_on_update: true,
    request_oauth_on_install: true,
    public: false,
    default_permissions: {
      checks: "write",
      contents: "read",
      emails: "read",
      members: "read",
      metadata: "read",
      pull_requests: "read",
    },
    // The same list the router handles, never a copy of it. A fresh App
    // registered from a copy that fell behind delivers nothing for whatever the
    // copy is missing, and the handler waits forever without erroring.
    default_events: APP_MANIFEST_EVENTS,
  };
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Register thwip GitHub App</title>
     <body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
     <h1>Register the thwip GitHub App</h1>
     <p>Submits the App manifest to the <b>${org}</b> organization. GitHub will ask you to confirm.</p>
     <form method="post" action="https://github.com/organizations/${org}/settings/apps/new?state=${state}">
       <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
       <button type="submit" style="font-size:1.1rem;padding:8px 20px">Create App on GitHub</button>
     </form></body>`,
  );
});

app.get("/admin/github/manifest/callback", async (c) => {
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  const row = await c.env.DB.prepare(
    "UPDATE enroll_challenges SET consumed_at = ? WHERE challenge = ? AND consumed_at IS NULL AND expires_at > ? RETURNING challenge",
  )
    .bind(nowIso(), state, nowIso())
    .first();
  if (!row) return c.text("invalid or expired state", 400);
  c.header("cache-control", "no-store");
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>thwip App registered</title>
     <body style="font-family:ui-monospace,monospace;max-width:46rem;margin:4rem auto">
     <h1>One-time conversion code</h1>
     <p>Exchange within one hour from the operator machine (never logged):</p>
     <pre style="background:#eee;padding:12px;word-break:break-all">${code}</pre>
     <p>curl -s -X POST https://api.github.com/app-manifests/${code}/conversions</p></body>`,
  );
});

// --- Static assets (marketing site + dashboard SPA) ------------------------

/* ---------- Thwip Queue ---------- */

/**
 * Ask GitHub to run the merge workflow for a pull request the queue offered.
 *
 * repository_dispatch, because it needs only Contents: write, which the App
 * has, and because it always runs the default branch's copy of the workflow.
 *
 * Module-level so the request route and the five-minute heartbeat share one
 * implementation rather than each keeping a copy.
 */
async function driveTurnFor(env: Env, repositoryId: string, pullRequestNumber: number): Promise<void> {
  const project = await env.DB.prepare(
    "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
  )
    .bind(repositoryId)
    .first<{ github_name: string; installation_id: string | null }>();
  if (project === null || project.installation_id === null) return;
  const token = await installationToken(env, project.installation_id);
  await fetch(`https://api.github.com/repos/${project.github_name}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "thwip-control-plane",
    },
    body: JSON.stringify({
      event_type: "thwip-queue-turn",
      client_payload: { pullRequestNumber },
    }),
  });
}

/* The queue's own routes. Authorization reuses the GitHub projection: a viewer
   is a queue participant through their principal, and repository admin comes
   from the synced org role. */
app.route(
  "/",
  queueRoutes<Env>({
    async authenticate(c: { req: { raw: Request } }, env: Env) {
      // The operator token authenticates too. Every administrative action needing a
      // browser session was a reason to leave the terminal, and an operator fixing a
      // stuck lane at 3am should not have to.
      if (requireAdmin(env, c.req.raw)) {
        return { ok: true as const, principalId: "operator", githubUserId: "0", isAdmin: true, operator: true };
      }
      const viewer = await resolveViewer(env, c.req.raw);
      if (viewer === null) return { ok: false as const, status: 401 as const };
      if (viewer.principalId === null) return { ok: false as const, status: 403 as const };
      return {
        ok: true as const,
        principalId: viewer.principalId,
        githubUserId: viewer.githubUserId,
        isAdmin: isOrgAdmin(viewer.githubOrgRole),
      };
    },
    async verifyOidc(c: { req: { raw: Request } }, env: Env) {
      const claims = await verifyGithubOidc({ env, req: c.req });
      return claims instanceof Response ? null : (claims as unknown as Record<string, unknown>);
    },
    async queueProject(env: Env, repositoryId: string, baseRef: string) {
      const row = await env.DB.prepare(
        "SELECT activation_state, merge_method FROM queue_projects WHERE github_repository_id = ? AND base_ref = ? AND enabled = 1",
      )
        .bind(repositoryId, baseRef)
        .first<{ activation_state: string; merge_method: string }>();
      if (row === null) return null;
      // The column is a free-text default in the schema; a record must never
      // bind a value the protocol does not recognize.
      const mergeMethod = row.merge_method === "merge" || row.merge_method === "squash"
        ? row.merge_method
        : DEFAULT_MERGE_METHOD;
      return { activationState: row.activation_state, mergeMethod };
    },
    async principalFor(env: Env, githubUserId: string) {
      if (!/^[0-9]{1,32}$/.test(githubUserId)) return null;
      const row = await env.DB.prepare("SELECT id FROM principals WHERE github_user_id = ?")
        .bind(githubUserId)
        .first<{ id: string }>();
      return row?.id ?? null;
    },
    async commitFacts(env: Env, repositoryId: string, sha: string) {
      const project = await env.DB.prepare(
        "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
      )
        .bind(repositoryId)
        .first<{ github_name: string; installation_id: string | null }>();
      if (project === null || project.installation_id === null) return null;
      const token = await installationToken(env, project.installation_id);
      const res = await fetch(`https://api.github.com/repos/${project.github_name}/git/commits/${sha}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "thwip-control-plane",
        },
      });
      if (!res.ok) return null;
      const commit = (await res.json()) as {
        tree?: { sha?: string };
        parents?: Array<{ sha?: string }>;
        message?: string;
      };
      const treeOid = commit.tree?.sha;
      if (typeof treeOid !== "string") return null;
      return {
        // The message carries the proof trailer, which is where the work receipt
        // digest comes from. Reading it here costs nothing extra: the commit has
        // already been fetched.
        message: typeof commit.message === "string" ? commit.message : "",
        treeOid,
        parentShas: (commit.parents ?? []).map((p) => p.sha).filter((v): v is string => typeof v === "string"),
      };
    },
    async pinnedVerifier(env: Env, repositoryId: string) {
      const row = await env.DB.prepare(
        "SELECT verifier_json FROM queue_projects WHERE github_repository_id = ? AND enabled = 1",
      )
        .bind(repositoryId)
        .first<{ verifier_json: string }>();
      return row === null ? null : (JSON.parse(row.verifier_json) as never);
    },
    /**
     * What the active policy requires of an integrated candidate.
     *
     * Read from the policy bundle rather than from anything the caller sends, so
     * the suite list a verdict is judged against is the one the project activated.
     */
    async activePolicy(env: Env, repositoryId: string) {
      return readActivePolicy(env.DB as unknown as D1Like, repositoryId);
    },
    /**
     * Ask GitHub to run the merge workflow for a pull request the queue offered.
     *
     * repository_dispatch, because it needs only Contents: write, which the App
     * has, and because it always runs the default branch's copy of the workflow.
     */
    async driveTurn(env: Env, repositoryId: string, pullRequestNumber: number) {
      return driveTurnFor(env, repositoryId, pullRequestNumber);
    },
    /**
     * The App's proof check that verified this head.
     *
     * Read from what the App recorded rather than from GitHub: the row is the
     * App's own account of the evaluation it ran, and it is the thing a reuse
     * record cites. Only an accepted verification counts — citing a check that
     * refused the proof would make the record say the opposite of what happened.
     */
    async proofCheckRunId(env: Env, repositoryId: string, headSha: string) {
      const project = await env.DB.prepare(
        "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
      )
        .bind(repositoryId)
        .first<{ github_name: string; installation_id: string | null }>();
      if (project === null || project.installation_id === null) return null;
      const token = await installationToken(env, project.installation_id);
      const res = await fetch(
        `https://api.github.com/repos/${project.github_name}/commits/${encodeURIComponent(headSha)}/check-runs?check_name=${encodeURIComponent(PROOF_CHECK)}&filter=latest`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "user-agent": "thwip-control-plane",
          },
        },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { check_runs?: Array<{ id?: number; conclusion?: string }> };
      // Only a check that passed. Citing one that refused the proof would make
      // the record say the opposite of what happened.
      const run = body.check_runs?.find((r) => r.conclusion === "success");
      return run?.id === undefined ? null : String(run.id);
    },
    /**
     * The integrated candidate GitHub has computed for a pull request.
     *
     * What a device is handed to run under `fresh`. It comes from GitHub, never
     * from the machine asking for work, so a runner cannot choose the tree it
     * will be credited with having tested. Null while GitHub is still computing
     * mergeability, and null for a pull request that cannot be integrated at
     * all: neither is a tree anybody should be asked to run.
     */
    async integratedCandidate(env: Env, repositoryId: string, baseRef: string, pullRequestNumber: number) {
      const project = await env.DB.prepare(
        "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
      )
        .bind(repositoryId)
        .first<{ github_name: string; installation_id: string | null }>();
      if (project === null || project.installation_id === null) return null;
      const [owner, repo] = project.github_name.split("/");
      if (owner === undefined || repo === undefined) return null;
      const token = await installationToken(env, project.installation_id);
      const pinned = await resolveCandidate(
        githubHttp(token),
        { owner, repo, repositoryId, baseRef },
        pullRequestNumber,
      );
      if (pinned.status !== "pinned") return null;
      return {
        baseSha: pinned.subject.baseSha,
        headSha: pinned.subject.headSha,
        candidateSha: pinned.subject.candidateSha,
        candidateTreeOid: pinned.subject.candidateTreeOid,
      };
    },
    async signRecordBytes(env: Env, bytes: Uint8Array, typ: string) {
      const { key, kid } = await serviceKey(env);
      return new CompactSign(bytes).setProtectedHeader({ alg: "ES256", kid, typ }).sign(key);
    },
    /**
     * What GitHub says the pull request is now.
     *
     * Read by the queue itself before it will record that a merge did not
     * happen. Null when it cannot be read, which the caller treats as unknown
     * rather than as a negative.
     */
    async pullRequestMergeState(env: Env, repositoryId: string, pullRequestNumber: number) {
      const project = await env.DB.prepare(
        "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
      )
        .bind(repositoryId)
        .first<{ github_name: string; installation_id: string | null }>();
      if (project === null || project.installation_id === null) return null;
      const token = await installationToken(env, project.installation_id);
      const res = await fetch(
        `https://api.github.com/repos/${project.github_name}/pulls/${pullRequestNumber}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "user-agent": "thwip-control-plane",
          },
        },
      );
      if (!res.ok) return null;
      const pull = (await res.json()) as { merged?: boolean; merge_commit_sha?: string | null };
      return {
        merged: pull.merged === true,
        mergeCommitSha: typeof pull.merge_commit_sha === "string" ? pull.merge_commit_sha : null,
      };
    },
    /**
     * Whether the base branch already contains a commit, from git ancestry.
     *
     * The second opinion the queue needs before it may certify that a merge did
     * not happen. The pull request's own flag lagged its own merge by seconds;
     * the ancestry did not.
     */
    async baseContainsSha(env: Env, repositoryId: string, baseRef: string, sha: string) {
      const project = await env.DB.prepare(
        "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
      )
        .bind(repositoryId)
        .first<{ github_name: string; installation_id: string | null }>();
      if (project === null || project.installation_id === null) return null;
      const token = await installationToken(env, project.installation_id);
      const branch = baseRef.replace(/^refs\/heads\//, "");
      const res = await fetch(
        `https://api.github.com/repos/${project.github_name}/compare/${encodeURIComponent(branch)}...${encodeURIComponent(sha)}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "user-agent": "thwip-control-plane",
          },
        },
      );
      if (!res.ok) return null;
      const compared = (await res.json()) as { status?: string };
      if (typeof compared.status !== "string") return null;
      // `behind` means the head is behind the base branch, which is to say the
      // base already contains it.
      return compared.status === "behind" || compared.status === "identical";
    },
    /**
     * Publish whose turn it is, as a check GitHub can require.
     *
     * Waiting is reported as still running rather than failed. A required check
     * that has failed goes on refusing the merge until something re-runs it, so
     * reporting "not your turn" as a failure meant GitHub kept refusing after the
     * queue had authorized, and the queue offered the same turn to a pull request
     * that could not take it.
     */
    async publishTurnCheck(env: Env, repositoryId: string, update: TurnCheckUpdate) {
      const project = await env.DB.prepare(
        "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
      )
        .bind(repositoryId)
        .first<{ github_name: string; installation_id: string | null }>();
      if (project === null || project.installation_id === null) return;
      const token = await installationToken(env, project.installation_id);
      const said = turnCheckRun(update);
      const call = (path: string, init?: RequestInit) =>
        fetch(`https://api.github.com/repos/${project.github_name}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": "thwip-control-plane",
            ...(init?.headers ?? {}),
          },
        });

      // What this commit already says, if anything.
      //
      // One read buys two things. Creating a check run per publish left a pile of
      // them on a pull request that waited through several turns, and publishing
      // unconditionally — which the unplaceable path did — made a new one on every
      // poll. Neither broke the gate, because GitHub reads the latest, but both
      // were unbounded writes to say something already said.
      const existing = await call(
        `/commits/${encodeURIComponent(update.headSha)}/check-runs?check_name=${encodeURIComponent(TURN_CHECK)}`,
      )
        .then((r) => (r.ok ? (r.json() as Promise<{ check_runs?: Array<Record<string, unknown>> }>) : null))
        .catch(() => null);
      const current = existing?.check_runs?.[0];

      if (
        current !== undefined &&
        current["status"] === said.status &&
        (current["conclusion"] ?? null) === said.conclusion &&
        (current["output"] as { title?: string } | undefined)?.title === said.title
      ) {
        return;
      }

      const body = JSON.stringify({
        name: TURN_CHECK,
        head_sha: update.headSha,
        status: said.status,
        ...(said.conclusion === null ? {} : { conclusion: said.conclusion }),
        details_url: `${env.PUBLIC_ORIGIN}/dashboard/projects`,
        output: { title: said.title, summary: said.summary },
      });

      const id = current?.["id"];
      if (typeof id === "number") {
        await call(`/check-runs/${id}`, { method: "PATCH", body });
        return;
      }
      await call("/check-runs", { method: "POST", body });
    },
    /**
     * The candidate verdict, as a check on the pull request head.
     *
     * Moved here from the verifier workflow, which asked GitHub for
     * `checks: write` and was refused because this repository's default workflow
     * permission is read-only. Every passing verification therefore finished as a
     * failed run. The App already holds the permission and already publishes the
     * other two checks.
     *
     * Not a required check: it reports what ran against the integrated candidate,
     * and the queue decides the merge from the verdict it stored, not from this.
     */
    async publishCandidateCheck(
      env: Env,
      repositoryId: string,
      update: { headSha: string; accepted: boolean; summary: string },
    ) {
      const project = await env.DB.prepare(
        "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
      )
        .bind(repositoryId)
        .first<{ github_name: string; installation_id: string | null }>();
      if (project === null || project.installation_id === null) return;
      const token = await installationToken(env, project.installation_id);
      await fetch(`https://api.github.com/repos/${project.github_name}/check-runs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "thwip-control-plane",
        },
        body: JSON.stringify({
          name: CANDIDATE_CHECK,
          head_sha: update.headSha,
          status: "completed",
          conclusion: update.accepted ? "success" : "failure",
          details_url: `${env.PUBLIC_ORIGIN}/dashboard/projects`,
          output: {
            title: "Required suites against the integrated candidate",
            summary: update.summary,
          },
        }),
      });
    },
    async dispatchCandidateVerification(
      env: Env,
      repositoryId: string,
      payload: {
        baseRef: string;
        pullRequestNumber: number;
        attemptId: string;
        baseSha: string;
        candidateSha: string;
        candidateTreeOid: string;
      },
    ) {
      const project = await env.DB.prepare(
        "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
      )
        .bind(repositoryId)
        .first<{ github_name: string; installation_id: string | null }>();
      if (project === null || project.installation_id === null) {
        return { ok: false as const, status: 0, detail: "no installation for this repository" };
      }
      const token = await installationToken(env, project.installation_id);
      // repository_dispatch runs the default branch's copy of the workflow. That is
      // the whole reason the candidate verifier is dispatched rather than triggered
      // by the pull request: a pull request can edit its own workflow file, and a
      // verifier a contributor can edit verifies nothing.
      const res = await fetch(`https://api.github.com/repos/${project.github_name}/dispatches`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "thwip-control-plane",
        },
        body: JSON.stringify({ event_type: "thwip-queue-verify", client_payload: payload }),
      });
      if (res.status === 204) return { ok: true as const };
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false as const, status: res.status, detail };
    },
  }) as never,
);

app.all("*", (c) => {
  // An unmatched path under a prefix the Worker owns is a missing route, and
  // must say so. Handing it to the assets returns the dashboard's HTML with a
  // 200, which reads as success to every client that asked for JSON.
  const { pathname } = new URL(c.req.url);
  if (isWorkerOwnedPath(pathname)) return c.json({ error: "no such route", path: pathname }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const synced = new Set<string>();
    for (const msg of batch.messages) {
      const body = msg.body as {
        event?: string;
        installationId?: string | null;
        policyPush?: PolicyPush | null;
        appProofTask?: AppProofTask | null;
        reconcileProofRepositoryId?: string | null;
      };
      const inst = body?.installationId;
      try {
        if (inst && !synced.has(inst)) {
          await syncInstallation(env, inst);
          synced.add(inst);
          if (["member", "membership", "organization", "repository", "team"].includes(body.event ?? "")) {
            await reconcileInstallationProofChecks(env, inst);
          }
        }
        if (body.policyPush != null) {
          await activatePolicyFromDefaultBranchPush(env, body.policyPush);
        }
        if (body.event === "policy_reconcile" && inst) {
          await reconcileInstallationPolicies(env, inst);
          await reconcileInstallationProofChecks(env, inst);
        }
        if (body.reconcileProofRepositoryId) {
          await reconcileProjectProofChecks(env, body.reconcileProofRepositoryId);
        }
        if (body.appProofTask?.kind === "verify") {
          await processAppProof(env, body.appProofTask.request);
        } else if (body.appProofTask?.kind === "rerequest") {
          const request = await requestForRerequest(env, body.appProofTask.verificationId);
          if (request !== null) await processAppProof(env, request);
        }
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // The five minute trigger is the queue's clock. It is separate from the
    // daily reconciliation because a queue that only moves when CI traffic
    // arrives will sit on an expired offer indefinitely on a quiet repository.
    if (controller.cron === "*/5 * * * *") {
      const result = await tickAllQueues(env as unknown as QueueRouteEnv, {
        driveTurn: (repositoryId, pullRequestNumber) => driveTurnFor(env, repositoryId, pullRequestNumber),
        onQueueTicked: () => {},
        onQueueFailed: (repositoryId, error) => {
          // wrangler tail is how this account observes the Worker. A heartbeat
          // whose failures vanish is the problem this port exists to prevent.
          console.error(`[queue heartbeat] tick failed for repository ${repositoryId}:`, error);
        },
      });
      console.log(
        `[queue heartbeat] ticked=${result.ticked} driven=${result.driven} failed=${result.failed}`,
      );
      return;
    }

    const orgs = await env.DB.prepare(
      "SELECT installation_id FROM organizations WHERE installation_id IS NOT NULL AND status = 'active'",
    ).all<{ installation_id: string }>();
    for (const o of orgs.results) {
      try {
        await syncInstallation(env, o.installation_id);
        await reconcileInstallationPolicies(env, o.installation_id);
        await reconcileInstallationProofChecks(env, o.installation_id);
      } catch {
        /* retried next run */
      }
    }

    // Copy anything the mirror missed. Idempotent, bounded, and it reports zero
    // once the backlog is gone.
    try {
      const backfill = await backfillAttestations(env.DB as unknown as D1Like, {
        organizationIdFor: async (repositoryId) => {
          const row = await env.DB.prepare(
            "SELECT organization_id AS id FROM projects WHERE github_repository_id = ?",
          )
            .bind(repositoryId)
            .first<{ id: string }>();
          return row?.id ?? null;
        },
        has: async (input) =>
          env.EVIDENCE === undefined
            ? true
            : hasEvidence(env.EVIDENCE as unknown as R2Like, {
                organizationId: input.organizationId,
                repositoryId: input.repositoryId,
                kind: input.kind as never,
                digest: input.digest as `sha256:${string}`,
              }),
        put: async (input) => {
          if (env.EVIDENCE === undefined) return;
          await putEvidence(env.EVIDENCE as unknown as R2Like, {
            organizationId: input.organizationId,
            repositoryId: input.repositoryId,
            kind: input.kind,
            digest: input.digest as `sha256:${string}`,
            bytes: input.bytes,
          });
        },
      });
      console.log(
        `[attestation backfill] copied=${backfill.copied} alreadyThere=${backfill.alreadyThere} skipped=${backfill.skipped}`,
      );
    } catch (error) {
      // wrangler tail is how this account observes the Worker. A backfill whose
      // failure vanishes leaves the backlog it exists to drain silently stuck.
      console.error(`[attestation backfill] run failed:`, error);
    }
  },
} satisfies ExportedHandler<Env>;

/* The Durable Object and Workflow classes the wrangler bindings name. They live
   in ./queue and are re-exported here because Cloudflare resolves a binding's
   class_name against the Worker's own exports. */
export { BranchQueue } from "./queue/BranchQueue.js";
