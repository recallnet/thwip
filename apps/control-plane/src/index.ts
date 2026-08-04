import { Hono } from "hono";
import { CompactSign, createRemoteJWKSet, jwtVerify } from "jose";
import { sha256Fingerprint, verifySshSigEd25519 } from "./sshsig-verify.js";
import { isWorkerOwnedPath } from "./worker-routes.js";
import { latestVerification } from "./latest-verification.js";
import { projectsInReach } from "./dashboard-scope.js";
import { isMembership, selectPrincipal } from "./viewer-scope.js";
import { createAuth } from "./auth.js";
import { githubSigningKeys, installationToken, listInstallations, syncInstallation } from "./github-app.js";
import { APP_MANIFEST_PERMISSIONS, REQUIRED_APP_PERMISSIONS } from "./app-permissions.js";
import { APP_MANIFEST_EVENTS, webhookEventDrift } from "./github-events.js";
import { syncInstallations } from "./admin-sync.js";
import {
  activatePolicyFromDefaultBranchPush,
  reconcileInstallationPolicies,
  type GithubPolicyWebhookPayload,
  type PolicyPush,
} from "./policy-activation.js";
import { projectPolicyState } from "./policy-state.js";
import { mintRunLease } from "./run-lease.js";
import { serviceKey, signPayload } from "./service-signing.js";
import { verificationKeys } from "./service-keys.js";
import { readActivePolicy } from "./active-policy.js";
import { capabilityFor, enrolDeviceKey, requiresDeviceOnly } from "./queue/runners.js";
import { isOrgAdmin } from "./queue/repository-access.js";
import { bootstrapRouteResponse, bootstrapStatusResponse } from "./queue/bootstrap-route.js";
import {
  deriveReadiness,
  foldCapability,
  type PlatformHealth,
  type PullRequestGates,
} from "./queue/readiness.js";
import { loadQueueState } from "./queue/queue-state.js";
import type { D1Like } from "./queue/projection.js";
import type { BlockingReason } from "@thwip/queue-domain";
import { resolveVerificationBundle, VerificationBundleError } from "./verification-bundle.js";
import {
  mergeWriterOf,
  performMergeWrite,
  refUpdateRequestBody,
  type MergeIntent,
  type MergeWriteOutcome,
} from "./queue/merge-write.js";
import { queueRoutes, runOnQueue, type QueueRouteEnv } from "./queue/routes.js";
import { authorizeTurn } from "./queue/authorize-turn.js";
import { reconsiderHead } from "./queue/reconsider-head.js";
import { driveQueue } from "./queue/drive-queue.js";
import { GITHUB_READS } from "./queue/deadlines.js";
import type { OnQueue } from "./queue/merge-lane.js";
import { requestTurn } from "./queue/queue-operations.js";
import { DEFAULT_MERGE_METHOD } from "./queue/merge-commit.js";
import { githubHttp, resolveCandidate } from "./queue/github-port.js";
import { integratedCandidateFrom } from "./queue/candidate.js";
import { tickAllQueues } from "./queue/scheduled-tick.js";
import {
  CANDIDATE_CHECK,
  PROOF_CHECK,
  TURN_CHECK,
  turnCheckRun,
  unplaceableUpdate,
  type TurnCheckUpdate,
} from "./queue/turn-check.js";
import { externalPushFromWebhook, pushedQueueBranch } from "./queue/external-push.js";
import { queueExternalMove } from "./queue/external-move.js";
import { backfillAttestations } from "./queue/attestation-backfill.js";
import { hasEvidence, putEvidence, type R2Like } from "./queue/evidence-store.js";
import { parseThwipYaml, type ThwipYaml } from "@thwip/policy";
import {
  processAppProof,
  reconcileInstallationProofChecks,
  reconcileProjectProofChecks,
  requestForRerequest,
  type AppProofTask,
} from "./app-proof-verification.js";
import { webhookWork } from "./webhook-work.js";
import { processQueueMessage, type QueueConsumerDeps, type QueueConsumerMessage } from "./queue-consumer.js";
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
  /** The organizations this viewer is a member of. Outside collaborators have none. */
  orgs: ViewerOrg[];
  /** the principal selected for this request (?org=<github org id>, else first) */
  principalId: string | null;
  /**
   * The organization selected for this request, and only when the viewer is a
   * member of it.
   *
   * Null for a viewer acting as an outside collaborator. Every
   * organization-wide read below already refuses a viewer without one, so a
   * collaborator is refused the member list, the seat counts and the
   * organization's settings by the guard that was already on each of them
   * rather than by a new check that some route would eventually forget.
   */
  organizationId: string | null;
  githubOrgRole: string | null;
  activated: boolean;
}

/**
 * Resolve the signed-in viewer to the GitHub projection. GitHub, not
 * Better Auth, is the authorization source: roles and permissions come from
 * the synced org projections keyed by the numeric GitHub user id. A viewer
 * can belong to several installed organizations; `?org=` selects one.
 *
 * A principal row is the viewer's place in one organization's world and no
 * longer means membership of it: installation sync writes one for every outside
 * collaborator, with `github_org_role` set to `outside`. So the rows are split
 * here. `orgs` is what the viewer belongs to, and a collaborator's row gives
 * them a principal to act as with no organization selected.
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
  const principals: ViewerOrg[] = rows.results
    .filter((r) => r.id !== null && r.organization_id !== null)
    .map((r) => ({
      organizationId: r.organization_id!,
      githubOrgId: r.github_org_id!,
      githubLogin: r.github_login!,
      principalId: r.id!,
      githubOrgRole: r.github_org_role,
      activated: r.activated_at != null,
    }));
  const orgs = principals.filter((p) => isMembership(p.githubOrgRole));
  const requested = new URL(req.url).searchParams.get("org");
  const selected = selectPrincipal(principals, requested);
  const member = selected !== null && isMembership(selected.githubOrgRole);
  return {
    baUserId: session.user.id,
    githubUserId: account.accountId,
    orgs,
    principalId: selected?.principalId ?? null,
    organizationId: member ? selected!.organizationId : null,
    githubOrgRole: member ? selected!.githubOrgRole : null,
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

/**
 * Signed in is enough to ask. What comes back is the organization's projects
 * when the viewer is a member of one, plus every repository their grants reach,
 * which is the whole answer for somebody who belongs to no organization and
 * used to be sent away with a 401.
 */
app.get("/v1/dashboard/projects", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer) return c.json({ error: "unauthenticated" }, 401);
  const projects = await projectsInReach(c.env.DB as unknown as D1Like, {
    organizationId: viewer.organizationId,
    githubUserId: viewer.githubUserId,
  });
  return c.json({ projects });
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

  // The key is its own name. Minting a separate identifier here produced keys
  // nothing could look up: every reader of `device_keys` resolves a key by
  // `key_id` holding a fingerprint.
  const enrolled = await enrolDeviceKey(c.env.DB as unknown as D1Like, {
    githubUserId,
    publicKey: body.publicKey,
    label: body.label ?? "device",
  });
  if (enrolled === null) return c.json({ error: "key already enrolled" }, 409);
  return c.json({ keyId: enrolled.keyId, fingerprint: enrolled.fingerprint, githubUserId });
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
  const granted = installation.permissions ?? {};
  const missing = Object.entries(REQUIRED_APP_PERMISSIONS).filter(
    ([scope, level]) => granted[scope] !== level,
  );

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
    requiredPermissions: REQUIRED_APP_PERMISSIONS,
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

/**
 * Setup, as a request.
 *
 * Enrolling `recallnet/thwip-test` took a hand-written D1 row, two workflows
 * copied in, a secret set by hand, and a ruleset built with `gh api`. The code
 * that does all of it has been here and tested since; what was missing was this.
 * Same administrator as the doctor, because this writes what the doctor reads.
 */
app.post("/v1/queue/:repositoryId/bootstrap", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  const body = await c.req.json().catch(() => ({}));
  const result = await bootstrapRouteResponse(c.env, viewer, c.req.param("repositoryId"), body);
  return c.json(result.body as never, result.status as never);
});

/** Where setup got to. Polled while the setup pull request waits for review. */
app.get("/v1/queue/:repositoryId/bootstrap", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  const result = await bootstrapStatusResponse(c.env, viewer, c.req.param("repositoryId"));
  return c.json(result.body as never, result.status as never);
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
            b.config_source, b.source_sha
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
      source_sha: string | null;
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
    activePolicySourceSha: project.source_sha,
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
    const { snapshot } = await runOnQueue(
      env,
      String(repositoryId),
      ref,
      ({ commands }) => {
        commands.cancel({
          idempotencyKey: `webhook:closed:${entryId}:${headSha}`,
          entryId,
          actorPrincipalId: "github",
          reason: "the pull request was closed",
        });
      },
      // Cancelling frees the lane, and the settle that follows offers it to
      // whoever is next. That pull request's turn has changed and its check has
      // to say so.
      (update) => publishTurnCheckFor(env, String(repositoryId), update),
    );

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

  // Who the turn belongs to, decided once and never recomputed.
  //
  // An entry that already exists keeps the sponsor it was created with. That is
  // what stops one pull request having two sponsors, which it had while this
  // webhook and the join route each decided it from different facts and
  // whichever ran last won: under `fresh` the turn went to one person while the
  // queue waited for a machine belonging to the other. One row read against the
  // document this handler is about to open anyway.
  const placed = (await loadQueueState(env.DB as unknown as D1Like, String(repositoryId), ref)).store
    .state()
    .entries.get(entryId);

  // A bot has no principal and no fairness share, so it cannot sponsor its own
  // pull request. `user.type` was read from GitHub, declared on this payload,
  // and never used, which is why `SPONSOR_REQUIRED` had no writer and a
  // `renovate[bot]` pull request read as unplaceable with no fix at all.
  const authorIsBot = pr?.user?.type === "Bot";
  const authorId = pr?.user?.id;
  const author =
    authorIsBot || authorId == null
      ? null
      : await env.DB.prepare("SELECT id FROM principals WHERE github_user_id = ?")
          .bind(String(authorId))
          .first<{ id: string }>();
  const sponsorPrincipalId = placed?.sponsorPrincipalId ?? author?.id ?? null;
  const sponsorGithubUserId = placed?.sponsorGithubUserId ?? String(authorId);

  if (sponsorPrincipalId === null) {
    // A required check that never arrives blocks the merge forever with nothing
    // on the page explaining it, so the one case a person can act on says so.
    // A human sponsor clears it by joining the queue for this pull request.
    if (authorIsBot) {
      try {
        await publishTurnCheckFor(
          env,
          String(repositoryId),
          unplaceableUpdate({ entryId, pullRequestNumber: number, headSha, reason: "SPONSOR_REQUIRED" }),
        );
      } catch {
        /* the check may lag; the answer below is unaffected */
      }
      return { handled: false, detail: "a bot pull request needs a human sponsor before it can queue" };
    }
    return { handled: false, detail: "author has no activated principal" };
  }

  // The same walk `/authorize` makes, from the same reads.
  //
  // This used to enqueue and stop: `requestTurn` and `evaluateReadiness` from
  // two facts on the payload, with everything else spread from a permissive
  // constant, so the twenty-two facts a webhook cannot answer all read as no
  // objection and a pull request with red CI or no approval was called ready.
  // The scheduler was never ticked and no lane was ever driven, because all of
  // that lived in a route only a workflow could call.
  //
  // `authorizeTurn` reads what it needs with the App's own token, admits,
  // evaluates, ticks, claims and drives. `prepare` is false: preparing starts
  // the merge-confirmation clock, and this delivery is not the caller that is
  // about to write.
  const walked = await authorizeTurn(env, queueDeps as never, queueOnQueue, {
    repositoryId: String(repositoryId),
    baseRef: ref,
    pullRequestNumber: number,
    headSha,
    authorGithubUserId: String(authorId),
    draft: pr?.draft === true,
    prepare: false,
  });

  return {
    handled: walked.outcome !== "not-configured",
    detail: walked.outcome === "not-configured" ? "no queue configured for this branch" : `placed in ${project.activation_state}`,
  };
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

  // The base branch moved, so whoever holds the lane is walked again.
  //
  // Both cases are worth waking for. The queue's own merge frees the lane for
  // whoever is next, and a push from outside it changes the base every waiting
  // candidate was integrated against. `driveQueue` answers nothing for a
  // repository that still runs `thwip-merge.yml`, where the dispatch already
  // starts the workflow that asks.
  const moved = pushedQueueBranch(event, payload as never);
  if (moved !== null) {
    try {
      await driveQueue(c.env, queueDeps as never, queueOnQueue, moved);
    } catch {
      /* the lane survives; the next delivery or the tick asks again */
    }
  }

  const work = webhookWork(event, payload as never, { delivery, installationId });
  if (work === null) {
    // Deliberately silent about the common case. Most deliveries are check_run
    // events the App caused by publishing its own checks, and a log line each
    // would cost more than the send did.
    return c.json({ ok: true, duplicate, queued: { handled: false, detail: "no work in this delivery" } });
  }
  await c.env.SYNC_QUEUE.send(work);
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
    // Sign-in depends on this. A private App is visible only to members of the
    // organization that owns it, so GitHub answers the authorize page with a
    // 404 for everybody else, and everybody else now includes the outside
    // collaborators this deployment can otherwise serve. They cannot reach the
    // dashboard at all until the App itself says public.
    //
    // This manifest registers an App; it does not change one that already
    // exists. An installed deployment needs the flag flipped in the App's own
    // settings, which only its owner can do.
    public: true,
    // The same list the doctor checks an installation against, never a copy of
    // it. This asked for `contents: read` and `pull_requests: read` while
    // `queueDoctor` a few hundred lines up reported `canMerge` off both being
    // write, so an App registered from this manifest failed the diagnostic
    // written beside it.
    default_permissions: APP_MANIFEST_PERMISSIONS,
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

/**
 * Publish whose turn it is, as a check GitHub can require.
 *
 * Waiting is reported as still running rather than failed. A required check that
 * has failed goes on refusing the merge until something re-runs it, so reporting
 * "not your turn" as a failure meant GitHub kept refusing after the queue had
 * authorized, and the queue offered the same turn to a pull request that could
 * not take it.
 *
 * Module-level for the same reason `driveTurnFor` is. The routes reach it
 * through their deps object; the pull-request webhook has no deps object and
 * used to publish nothing at all, which left every pull request that waited
 * without the check the branch requires.
 */
/**
 * Run commands against one queue with the turn check wired in.
 *
 * The same binding `queueRoutes` makes for its routes. A caller that skipped it
 * would move the lane without the check following, which is the failure that
 * left the queue rotating turns nobody could take.
 */
const queueOnQueue: OnQueue<Env> = (env, repositoryId, baseRef, decide) =>
  runOnQueue(env, repositoryId, baseRef, decide, (update) => publishTurnCheckFor(env, repositoryId, update));

async function publishTurnCheckFor(env: Env, repositoryId: string, update: TurnCheckUpdate): Promise<void> {
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
  // poll. Neither broke the gate, because GitHub reads the latest, but both were
  // unbounded writes to say something already said.
  const existing = await call(
    `/commits/${encodeURIComponent(update.headSha)}/check-runs?check_name=${encodeURIComponent(TURN_CHECK)}`,
  )
    .then((r) => (r.ok ? (r.json() as Promise<{ check_runs?: Array<Record<string, unknown>> }>) : null))
    .catch(() => null);
  const current = existing?.check_runs?.[0];

  // The summary is compared too, not only the title. Two blocking reasons can
  // share a title — a missing review and a missing code-owner review are both
  // "Waiting for review" — while the sentence saying what to do about them
  // differs, and comparing titles alone left the wrong instruction on the commit.
  const output = current?.["output"] as { title?: string; summary?: string } | undefined;
  if (
    current !== undefined &&
    current["status"] === said.status &&
    (current["conclusion"] ?? null) === said.conclusion &&
    output?.title === said.title &&
    output?.summary === said.summary
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
}

/* The queue's own routes. Authorization reuses the GitHub projection: a viewer
/**
 * Everything the queue reads and everything it may ask GitHub to do.
 *
 * One object, because the routes and the `pull_request` webhook walk the same
 * turn. While the walk lived inside `/authorize` this list was an argument to
 * one call and the webhook had no way to reach any of it, which is why a
 * repository holding no workflow files could enqueue a pull request and never
 * merge one.
 */
const queueDeps = {
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
      "SELECT activation_state, merge_method, merge_writer FROM queue_projects WHERE github_repository_id = ? AND base_ref = ? AND enabled = 1",
    )
      .bind(repositoryId, baseRef)
      .first<{ activation_state: string; merge_method: string; merge_writer: string | null }>();
    if (row === null) return null;
    // The column is a free-text default in the schema; a record must never
    // bind a value the protocol does not recognize.
    const mergeMethod = row.merge_method === "merge" || row.merge_method === "squash"
      ? row.merge_method
      : DEFAULT_MERGE_METHOD;
    return {
      activationState: row.activation_state,
      mergeMethod,
      mergeWriter: mergeWriterOf(row.merge_writer),
    };
  },
  async principalFor(env: Env, githubUserId: string) {
    if (!/^[0-9]{1,32}$/.test(githubUserId)) return null;
    const row = await env.DB.prepare("SELECT id FROM principals WHERE github_user_id = ?")
      .bind(githubUserId)
      .first<{ id: string }>();
    return row?.id ?? null;
  },
  /**
   * Who wrote a pull request, whether that author is a bot, and which branch
   * it targets, read from GitHub so none of it is the caller's to choose. Null
   * on anything that is not an answer: no installation, a refused read, a
   * payload missing a field.
   */
  async pullRequestPlacement(env: Env, repositoryId: string, pullRequestNumber: number) {
    const project = await env.DB.prepare(
      "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
    )
      .bind(repositoryId)
      .first<{ github_name: string; installation_id: string | null }>();
    if (project === null || project.installation_id === null) return null;
    const token = await installationToken(env, project.installation_id);
    const res = await fetch(`https://api.github.com/repos/${project.github_name}/pulls/${pullRequestNumber}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "thwip-control-plane",
      },
    });
    if (!res.ok) return null;
    const pull = (await res.json()) as {
      user?: { id?: number; type?: string };
      base?: { ref?: string };
      head?: { sha?: string };
      draft?: boolean;
    };
    const authorId = pull.user?.id;
    const ref = pull.base?.ref;
    const headSha = pull.head?.sha;
    if (typeof authorId !== "number" || typeof ref !== "string" || ref === "") return null;
    if (typeof headSha !== "string" || headSha === "") return null;
    return {
      authorGithubUserId: String(authorId),
      baseRef: `refs/heads/${ref}`,
      // The same field the `pull_request` webhook carries, so one source
      // decides bot-ness for both paths.
      authorIsBot: pull.user?.type === "Bot",
      draft: pull.draft === true,
      headSha,
    };
  },
  /**
   * The pull requests a commit belongs to, from git rather than from a payload.
   *
   * Read when a fact about a head changes and the queue has to work out which
   * entries that answer belongs to. Null when GitHub could not be read, which
   * has to stay apart from the empty array: one means the read did not happen,
   * the other means the commit belongs to no pull request.
   */
  pullRequestNumbersForCommit(env: Env, repositoryId: string, sha: string) {
    return GITHUB_READS.pullRequestNumbersForCommit(env, repositoryId, sha);
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
   * will be credited with having tested. When there is no candidate, the state
   * GitHub is in travels with the answer: a conflict ends the turn and
   * mergeability GitHub has not finished computing does not, and the caller
   * cannot tell them apart from a bare null. Null is kept for the repository
   * itself being unreadable.
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
    return integratedCandidateFrom(pinned);
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
  /**
   * Perform the merge, with the App's own installation token.
   *
   * `contents: write` is what this needs and all it needs: writing a commit
   * object and moving a branch ref are both Contents, and the ownership
   * ruleset already names the App as the only actor that may update a managed
   * branch. Nothing here decides anything about the merge — the base, the
   * tree and the parents come from the queue document, and the ref update
   * does not force, which is what makes GitHub refuse a base that moved.
   */
  async mergeWrite(env: Env, repositoryId: string, intent: MergeIntent): Promise<MergeWriteOutcome> {
    const project = await env.DB.prepare(
      "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
    )
      .bind(repositoryId)
      .first<{ github_name: string; installation_id: string | null }>();
    if (project === null || project.installation_id === null) {
      return { kind: "unknown", detail: "no installation for this repository" };
    }
    const token = await installationToken(env, project.installation_id);
    const api = `https://api.github.com/repos/${project.github_name}`;
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "thwip-control-plane",
    };
    const refused = async (res: Response) => ({
      status: res.status,
      message: ((await res.json().catch(() => ({}))) as { message?: string }).message ?? "no message",
    });

    return performMergeWrite(
      {
        async createCommit(input) {
          const res = await fetch(`${api}/git/commits`, {
            method: "POST",
            headers,
            body: JSON.stringify({ message: input.message, tree: input.tree, parents: input.parents }),
          });
          if (!res.ok) return { ok: false as const, ...(await refused(res)) };
          const body = (await res.json()) as { sha?: string };
          return typeof body.sha === "string"
            ? { ok: true as const, sha: body.sha }
            : { ok: false as const, status: res.status, message: "GitHub wrote the commit and named no sha" };
        },
        async updateRef(ref, update) {
          const res = await fetch(`${api}/git/${ref}`, {
            method: "PATCH",
            headers,
            // Built in one place, which is where force is held to false.
            body: refUpdateRequestBody(update),
          });
          if (!res.ok) return { ok: false as const, ...(await refused(res)) };
          const body = (await res.json()) as { object?: { sha?: string } };
          return typeof body.object?.sha === "string"
            ? { ok: true as const, sha: body.object.sha }
            : { ok: false as const, status: res.status, message: "GitHub moved the ref and named no sha" };
        },
        // The same two reads `/not-merged` resolves an absence from. GitHub's
        // reads lag its own writes, so one negative answer is not a negative.
        async readPull() {
          const res = await fetch(`${api}/pulls/${intent.pullRequestNumber}`, { headers });
          if (!res.ok) return null;
          const pull = (await res.json()) as { merged?: boolean; merge_commit_sha?: string | null };
          return {
            merged: pull.merged === true,
            mergeCommitSha: typeof pull.merge_commit_sha === "string" ? pull.merge_commit_sha : null,
          };
        },
        async baseContainsHead() {
          const branch = intent.baseRef.replace(/^refs\/heads\//, "");
          const res = await fetch(
            `${api}/compare/${encodeURIComponent(branch)}...${encodeURIComponent(intent.headSha)}`,
            { headers },
          );
          if (!res.ok) return null;
          const compared = (await res.json()) as { status?: string };
          if (typeof compared.status !== "string") return null;
          // `behind` means the head is behind the base branch, which is to say
          // the base already contains it.
          return compared.status === "behind" || compared.status === "identical";
        },
      },
      intent,
    );
  },
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
  publishTurnCheck: publishTurnCheckFor,
  /**
   * What the branch requires of a head, and what the head says about it.
   *
   * The rules endpoint answers with the rules in force for one branch, across
   * every ruleset that targets it, which is what the merge is actually held
   * to. The check runs come back latest-per-name, so a rerun does not leave
   * its own earlier failure lying next to it.
   *
   * Null on any unreadable answer. The caller treats that as unknown and goes
   * ahead, because refusing a merge on our own failure to read GitHub would
   * stop the queue every time GitHub had a bad minute.
   */
  async requiredCheckState(env: Env, repositoryId: string, baseRef: string, headSha: string) {
    const project = await env.DB.prepare(
      "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
    )
      .bind(repositoryId)
      .first<{ github_name: string; installation_id: string | null }>();
    if (project === null || project.installation_id === null) return null;
    const token = await installationToken(env, project.installation_id);
    const read = async <T>(path: string): Promise<T | null> => {
      const res = await fetch(`https://api.github.com/repos/${project.github_name}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "thwip-control-plane",
        },
      }).catch(() => null);
      if (res === null || !res.ok) return null;
      return (await res.json().catch(() => null)) as T | null;
    };

    const branch = baseRef.replace(/^refs\/heads\//, "");
    const rules = await read<
      Array<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string }> } }>
    >(`/rules/branches/${encodeURIComponent(branch)}`);
    if (rules === null) return null;
    const required = rules
      .filter((rule) => rule.type === "required_status_checks")
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((check) => check.context)
      .filter((context): context is string => typeof context === "string");
    if (required.length === 0) return { required: [], runs: [] };

    const checks = await read<{
      check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null }>;
    }>(`/commits/${encodeURIComponent(headSha)}/check-runs?filter=latest&per_page=100`);
    if (checks === null) return null;
    // Commit statuses too. A required context may be satisfied by either, and a
    // queue that read only check runs would call a context satisfied by a
    // status absent and refuse a merge GitHub would have allowed.
    const statuses = await read<{ statuses?: Array<{ context?: string; state?: string }> }>(
      `/commits/${encodeURIComponent(headSha)}/status?per_page=100`,
    );
    if (statuses === null) return null;
    return {
      required,
      runs: [
        ...(checks.check_runs ?? [])
          .filter((run): run is { name: string; status?: string; conclusion?: string | null } =>
            typeof run.name === "string",
          )
          .map((run) => ({
            name: run.name,
            status: run.status ?? "queued",
            conclusion: run.conclusion ?? null,
          })),
        ...(statuses.statuses ?? [])
          .filter((status): status is { context: string; state?: string } => typeof status.context === "string")
          .map((status) =>
            status.state === "pending"
              ? { name: status.context, status: "in_progress", conclusion: null }
              : {
                  name: status.context,
                  status: "completed",
                  conclusion: status.state === "success" ? "success" : "failure",
                },
          ),
      ],
    };
  },
  /**
   * Whether the repository is still the one this queue's policy assumes.
   *
   * Three questions the queue never asked before it merged. The branch rules
   * say whether the checks the queue publishes are still required and whether
   * the branch can still be force-pushed or deleted; the installation says
   * whether the App can still perform the merge it is about to certify; and
   * the collaborator permission says whether the person whose turn this is may
   * still write here.
   *
   * Three reads, once, on the walk to a merge. `requiredCheckState` already
   * reads the same rules endpoint a moment later, and the duplicate is left
   * standing rather than threading a cache through the dependency boundary:
   * one extra read per merge against an hourly budget this account uses a
   * fraction of is not worth a second cached shape that can go stale.
   *
   * Null on any unreadable answer, all the way down. Refusing a merge because
   * GitHub had a bad minute would stop the queue for everyone, and that is a
   * worse failure than the one this exists to catch.
   */
  async platformHealth(
    env: Env,
    repositoryId: string,
    baseRef: string,
    sponsorGithubUserId: string,
  ): Promise<PlatformHealth | null> {
    const project = await env.DB.prepare(
      `SELECT p.github_name, o.installation_id, o.id AS organization_id
         FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE p.github_repository_id = ?`,
    )
      .bind(repositoryId)
      .first<{ github_name: string; installation_id: string | null; organization_id: string }>();
    if (project === null || project.installation_id === null) return null;

    // The sponsor by the name GitHub's permission endpoint takes. A numeric id
    // will not address it, and guessing a login would ask about somebody else.
    const sponsor = await env.DB.prepare(
      "SELECT github_login FROM principals WHERE organization_id = ? AND github_user_id = ?",
    )
      .bind(project.organization_id, sponsorGithubUserId)
      .first<{ github_login: string | null }>();
    if (sponsor?.github_login == null) return null;

    const token = await installationToken(env, project.installation_id);
    const read = async <T>(path: string): Promise<T | null> => {
      const res = await fetch(`https://api.github.com/repos/${project.github_name}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "thwip-control-plane",
        },
      }).catch(() => null);
      if (res === null || !res.ok) return null;
      return (await res.json().catch(() => null)) as T | null;
    };

    const branch = baseRef.replace(/^refs\/heads\//, "");
    const rules = await read<
      Array<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string }> } }>
    >(`/rules/branches/${encodeURIComponent(branch)}`);
    if (rules === null) return null;
    const ruleTypes = new Set(rules.map((rule) => rule.type));
    const requiredContexts = new Set(
      rules
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .map((check) => check.context),
    );
    // What the queue's own guarantee rests on, and nothing wider. The turn
    // check is what stops a merge out of turn and the proof check is what
    // stops an unproven one, so a branch that no longer requires both is a
    // branch the queue cannot speak for. Force-push and deletion are the two
    // ways the merged history it signs can be rewritten underneath it.
    const rulesetEnforced =
      requiredContexts.has(TURN_CHECK) &&
      requiredContexts.has(PROOF_CHECK) &&
      ruleTypes.has("non_fast_forward") &&
      ruleTypes.has("deletion");

    const permission = await read<{ permission?: string }>(
      `/collaborators/${encodeURIComponent(sponsor.github_login)}/permission`,
    );
    if (permission === null) return null;
    const sponsorAuthorized =
      permission.permission === "admin" ||
      permission.permission === "maintain" ||
      permission.permission === "write";

    // The installation's permissions, from the App's own view of it.
    //
    // Only the three the merge itself depends on: writing the branch,
    // performing the merge, and publishing the check GitHub requires. `actions`
    // is not among them deliberately — a verifier that cannot be dispatched
    // stops the attempt long before this point, and refusing here would name
    // the wrong problem.
    const installations = await listInstallations(env).catch(() => null);
    if (installations === null) return null;
    const installation = installations.find((i) => String(i.id) === project.installation_id);
    if (installation?.permissions === undefined) return null;
    const permissions = installation.permissions;
    const appPermissionsHealthy = ["contents", "pull_requests", "checks"].every(
      (scope) => permissions[scope] === "write",
    );

    return { rulesetEnforced, appPermissionsHealthy, sponsorAuthorized };
  },
  /**
   * What the branch's `pull_request` rule asks of this pull request, and
   * whether GitHub says it is met.
   *
   * Two reads. The rules endpoint says which of the four gates apply, because
   * a branch that does not require a code owner must never be told one is
   * missing. GraphQL answers all of the rest in one round trip: the review
   * decision GitHub itself computed under those rules, the outstanding code
   * owner request, which commit each approval names, the open review threads,
   * and mergeability.
   *
   * The decision is what refuses. Counting approvals here would refuse merges
   * GitHub allows, because the rule can be satisfied by reviewers this queue
   * cannot enumerate; the counts are only used to say which rule is unmet once
   * GitHub has already said one is.
   *
   * Null on any unreadable answer, all the way down, for the same reason
   * `requiredCheckState` is: a bad minute at GitHub must not stop the queue
   * for everyone.
   */
  async pullRequestGates(
    env: Env,
    repositoryId: string,
    baseRef: string,
    pullRequestNumber: number,
    headSha: string,
  ): Promise<PullRequestGates | null> {
    const project = await env.DB.prepare(
      "SELECT p.github_name, o.installation_id FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.github_repository_id = ?",
    )
      .bind(repositoryId)
      .first<{ github_name: string; installation_id: string | null }>();
    if (project === null || project.installation_id === null) return null;
    const [owner, repo] = project.github_name.split("/");
    if (owner === undefined || repo === undefined) return null;
    const token = await installationToken(env, project.installation_id);
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "thwip-control-plane",
    };

    const branch = baseRef.replace(/^refs\/heads\//, "");
    const rulesRes = await fetch(
      `https://api.github.com/repos/${project.github_name}/rules/branches/${encodeURIComponent(branch)}`,
      { headers },
    ).catch(() => null);
    if (rulesRes === null || !rulesRes.ok) return null;
    const rules = (await rulesRes.json().catch(() => null)) as Array<{
      type?: string;
      parameters?: {
        required_approving_review_count?: number;
        require_code_owner_review?: boolean;
        require_last_push_approval?: boolean;
        required_review_thread_resolution?: boolean;
      };
    }> | null;
    if (rules === null) return null;
    const pullRule = rules.find((rule) => rule.type === "pull_request")?.parameters ?? {};

    const graphRes = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        query:
          "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeable reviewDecision reviewRequests(first:100){nodes{asCodeOwner}} reviewThreads(first:100){nodes{isResolved isOutdated}} latestOpinionatedReviews(first:100){nodes{state commit{oid}}}}}}",
        variables: { owner, name: repo, number: pullRequestNumber },
      }),
    }).catch(() => null);
    if (graphRes === null || !graphRes.ok) return null;
    const answer = (await graphRes.json().catch(() => null)) as {
      data?: {
        repository?: {
          pullRequest?: {
            mergeable?: string;
            reviewDecision?: string | null;
            reviewRequests?: { nodes?: Array<{ asCodeOwner?: boolean }> };
            reviewThreads?: { nodes?: Array<{ isResolved?: boolean; isOutdated?: boolean }> };
            latestOpinionatedReviews?: { nodes?: Array<{ state?: string; commit?: { oid?: string } }> };
          } | null;
        } | null;
      };
    } | null;
    const pull = answer?.data?.repository?.pullRequest;
    if (pull == null) return null;

    const approving = (pull.latestOpinionatedReviews?.nodes ?? []).filter((r) => r.state === "APPROVED");
    const decision =
      pull.reviewDecision === "APPROVED" ||
      pull.reviewDecision === "CHANGES_REQUESTED" ||
      pull.reviewDecision === "REVIEW_REQUIRED"
        ? pull.reviewDecision
        : null;

    return {
      // `UNKNOWN` is GitHub still computing it, which is not a conflict.
      mergeable:
        pull.mergeable === "MERGEABLE" ? true : pull.mergeable === "CONFLICTING" ? false : null,
      review: {
        requiredApprovingReviewCount: pullRule.required_approving_review_count ?? 0,
        requireCodeOwnerReview: pullRule.require_code_owner_review === true,
        requireLastPushApproval: pullRule.require_last_push_approval === true,
        requireThreadResolution: pullRule.required_review_thread_resolution === true,
        reviewDecision: decision,
        pendingCodeOwnerReview: (pull.reviewRequests?.nodes ?? []).some((r) => r.asCodeOwner === true),
        approvals: approving.length,
        approvalsOnHead: approving.filter((r) => r.commit?.oid === headSha).length,
        // An outdated thread no longer applies to the head, and GitHub does
        // not hold the merge on one.
        unresolvedThreads: (pull.reviewThreads?.nodes ?? []).filter(
          (t) => t.isResolved !== true && t.isOutdated !== true,
        ).length,
      },
    };
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
      requiredSuites: readonly string[];
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
} as const;

/* The queue's own routes. Authorization reuses the GitHub projection: a viewer
   is a queue participant through their principal, and repository admin comes
   from the synced org role. */
app.route("/", queueRoutes<Env>(queueDeps as never));

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
    const deps: QueueConsumerDeps = {
      syncInstallation: (id) => syncInstallation(env, id),
      reconcileInstallationProofChecks: (id) => reconcileInstallationProofChecks(env, id),
      activatePolicyFromDefaultBranchPush: (policyPush) => activatePolicyFromDefaultBranchPush(env, policyPush),
      reconcileInstallationPolicies: (id) => reconcileInstallationPolicies(env, id),
      reconcileProjectProofChecks: (id) => reconcileProjectProofChecks(env, id),
      processAppProof: (request) => processAppProof(env, request),
      requestForRerequest: (verificationId) => requestForRerequest(env, verificationId),
      reconsiderHead: (repositoryId, headSha) =>
        reconsiderHead(env, queueDeps as never, queueOnQueue, { repositoryId, headSha }),
    };
    for (const msg of batch.messages) {
      try {
        await processQueueMessage(msg.body as QueueConsumerMessage, synced, deps);
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
        `[queue heartbeat] ticked=${result.ticked} driven=${result.driven} failed=${result.failed} ` +
          `reconciled=${result.reconciled} settledWrites=${result.settledWrites} chainFindings=${result.chainFindings}`,
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
