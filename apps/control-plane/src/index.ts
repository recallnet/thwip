import { Hono } from "hono";
import { CompactSign, SignJWT, createRemoteJWKSet, importJWK, jwtVerify, type JWK } from "jose";
import { sha256Fingerprint, verifySshSigEd25519 } from "./sshsig-verify.js";
import { createAuth } from "./auth.js";
import { githubSigningKeys, installationToken, listInstallations, syncInstallation } from "./github-app.js";
import { queueRoutes } from "./queue/routes.js";
import { queueKey as queueKeyOf } from "@thwip/queue-domain";
import type { Env } from "./env.js";

export type { Env } from "./env.js";

const te = new TextEncoder();

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const githubJwks = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

const PLAN_LIMITS: Record<string, { projects: number; users: number }> = {
  free: { projects: 3, users: 5 },
  pro: { projects: 15, users: 25 },
};

async function serviceKey(env: Env) {
  const jwk = JSON.parse(env.THWIP_SERVICE_SIGNING_PRIVATE_JWK) as JWK;
  return { key: await importJWK(jwk, "ES256"), kid: jwk.kid ?? "thwip-svc-1" };
}

async function signPayload(env: Env, payload: unknown, typ: string): Promise<string> {
  const { key, kid } = await serviceKey(env);
  return new CompactSign(te.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256", kid, typ })
    .sign(key);
}

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

app.get("/v1/dashboard/projects", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.github_repository_id, p.github_name, p.default_branch, p.enabled, p.active_policy_digest,
            b.version AS policy_version,
            json_extract(b.canonical_json, '$.securityProfile') AS policy_profile,
            (SELECT COUNT(*) FROM repository_grants g WHERE g.project_id = p.id AND g.active = 1) AS collaborators,
            (SELECT outcome FROM verification_observations o WHERE o.project_id = p.id ORDER BY observed_at DESC LIMIT 1) AS last_outcome,
            (SELECT observed_at FROM verification_observations o WHERE o.project_id = p.id ORDER BY observed_at DESC LIMIT 1) AS last_observed_at
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
  await c.env.DB.prepare("UPDATE projects SET enabled = 0 WHERE id = ? AND organization_id = ?")
    .bind(projectId, viewer.organizationId)
    .run();
  return c.json({ enabled: false });
});

app.post("/v1/dashboard/projects/:id/profile", async (c) => {
  // The security profile is policy material: it lives in the repository's
  // thwip.yaml and changes only through a reviewed policy activation. The
  // dashboard displays it; it cannot edit it out from under the file.
  return c.json(
    { error: "the security profile is set in thwip.yaml and changes with a policy activation", code: "MANAGED_IN_REPO" },
    409,
  );
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
  await c.env.DB.prepare(
    "UPDATE device_keys SET revoked_at = ?, revoked_reason = ? WHERE key_id = ? AND revoked_at IS NULL",
  )
    .bind(nowIso(), `revoked by ${viewer.githubUserId}`, keyId)
    .run();
  return c.json({ revoked: true });
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
    `SELECT o.head_sha, o.outcome, o.run_id, o.observed_at, p.github_name
     FROM verification_observations o JOIN projects p ON p.id = o.project_id
     WHERE p.organization_id = ? ORDER BY o.observed_at DESC LIMIT 25`,
  )
    .bind(viewer.organizationId)
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
  return c.json({ synced: counts });
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
  const r = await c.env.DB.prepare(
    "UPDATE device_keys SET revoked_at = ?, revoked_reason = ? WHERE key_id = ? AND revoked_at IS NULL",
  )
    .bind(nowIso(), reason ?? "revoked", c.req.param("keyId"))
    .run();
  return c.json({ revoked: (r.meta.changes ?? 0) > 0 });
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
  const results: Record<string, unknown> = {};
  for (const inst of installations) {
    results[inst.account.login] = await syncInstallation(c.env, String(inst.id));
  }
  return c.json({ installations: results });
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
  const granted = (installation as unknown as { permissions?: Record<string, string> }).permissions ?? {};
  const missing = Object.entries(required).filter(([scope, level]) => granted[scope] !== level);

  return Response.json({
    repo,
    installationId: String(installation.id),
    grantedPermissions: granted,
    requiredPermissions: required,
    missingPermissions: Object.fromEntries(missing),
    canPublishMergeCheck: missing.every(([scope]) => scope !== "checks"),
    canMerge: missing.every(([scope]) => scope !== "contents" && scope !== "pull_requests"),
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
  const { key, kid } = await serviceKey(c.env);
  const jti = randomId("lease");
  const lease = await new SignJWT({
    repositoryId: body.repositoryId,
    treeOid: body.treeOid,
    parentOids: body.parentOids ?? [],
    baseSha: body.baseSha ?? null,
    policyDigest: project.active_policy_digest,
    deviceKeyId: body.deviceKeyId,
    profile: project.security_profile,
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(c.env.PUBLIC_ORIGIN)
    .setAudience("urn:thwip:ci-run:v1")
    .setJti(jti)
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("30m")
    .sign(key);
  return c.json({ lease });
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

  const project = await c.env.DB.prepare(
    `SELECT p.id, p.github_repository_id, p.github_name, p.active_policy_digest, o.github_org_id
     FROM projects p JOIN organizations o ON o.id = p.organization_id
     WHERE p.github_repository_id = ? AND p.enabled = 1`,
  )
    .bind(body.repositoryId)
    .first<{
      id: string;
      github_repository_id: string;
      github_name: string;
      active_policy_digest: string;
      github_org_id: string;
    }>();
  if (!project || !project.active_policy_digest) return c.json({ error: "project not enabled" }, 404);

  const policyRow = await c.env.DB.prepare(
    "SELECT digest, version, canonical_json, status FROM policy_bundles WHERE digest = ?",
  )
    .bind(project.active_policy_digest)
    .first<{ digest: string; version: number; canonical_json: string; status: string }>();
  if (!policyRow || policyRow.status !== "active") return c.json({ error: "no active policy" }, 404);

  const grace = await c.env.DB.prepare(
    "SELECT digest FROM policy_bundles WHERE project_id = ? AND status = 'retired' AND activated_at > datetime('now','-1 day')",
  )
    .bind(project.id)
    .all<{ digest: string }>();

  const grants = await c.env.DB.prepare(
    "SELECT github_user_id, github_login, permission, active, synced_at FROM repository_grants WHERE project_id = ?",
  )
    .bind(project.id)
    .all<{ github_user_id: string; github_login: string; permission: string; active: number; synced_at: string }>();

  const refreshed: Array<{ githubUserId: string; permission: string; active: boolean }> = [];
  for (const g of grants.results) {
    const ageMs = Date.now() - Date.parse(g.synced_at + (g.synced_at.endsWith("Z") ? "" : "Z"));
    if (c.env.GITHUB_SYNC_TOKEN && ageMs > 60_000) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${project.github_name}/collaborators/${g.github_login}/permission`,
          {
            headers: {
              authorization: `Bearer ${c.env.GITHUB_SYNC_TOKEN}`,
              accept: "application/vnd.github+json",
              "user-agent": "thwip-control-plane",
            },
          },
        );
        if (res.ok) {
          const data = (await res.json()) as { permission: string; role_name?: string };
          const perm = data.role_name ?? data.permission;
          await c.env.DB.prepare(
            "UPDATE repository_grants SET permission = ?, active = 1, synced_at = ? WHERE project_id = ? AND github_user_id = ?",
          )
            .bind(perm, nowIso(), project.id, g.github_user_id)
            .run();
          refreshed.push({ githubUserId: g.github_user_id, permission: perm, active: true });
          continue;
        }
        if (res.status === 404) {
          await c.env.DB.prepare(
            "UPDATE repository_grants SET active = 0, synced_at = ? WHERE project_id = ? AND github_user_id = ?",
          )
            .bind(nowIso(), project.id, g.github_user_id)
            .run();
          refreshed.push({ githubUserId: g.github_user_id, permission: "none", active: false });
          continue;
        }
        return c.json({ error: "grant refresh failed" }, 503);
      } catch {
        return c.json({ error: "grant refresh failed" }, 503);
      }
    }
    refreshed.push({ githubUserId: g.github_user_id, permission: g.permission, active: g.active === 1 });
  }

  // Signing keys come from GitHub, which owns the key-to-identity binding.
  // thwip contributes only a deny list, for revoking a key inside the
  // organization faster than GitHub's own removal can propagate.
  const signerUserId = body.signerGithubUserId;
  const signerRow = signerUserId
    ? await c.env.DB.prepare("SELECT github_login FROM repository_grants WHERE project_id = ? AND github_user_id = ?")
        .bind(project.id, signerUserId)
        .first<{ github_login: string }>()
    : null;
  const githubKeys: Array<{
    keyId: string;
    githubUserId: string;
    algorithm: string;
    publicKey: string;
    revokedAt: string | null;
  }> = [];
  if (signerRow && signerUserId) {
    let token: string | undefined = c.env.GITHUB_SYNC_TOKEN;
    try {
      const org = await c.env.DB.prepare("SELECT installation_id FROM organizations WHERE github_org_id = ?")
        .bind(project.github_org_id)
        .first<{ installation_id: string | null }>();
      if (org?.installation_id) token = await installationToken(c.env, org.installation_id);
    } catch {
      /* fall back to the sync token or an unauthenticated read */
    }
    let listed: Awaited<ReturnType<typeof githubSigningKeys>>;
    try {
      listed = await githubSigningKeys(token, signerRow.github_login);
    } catch {
      return c.json({ error: "cannot read signer signing keys from GitHub" }, 503);
    }
    const denied = await c.env.DB.prepare(
      "SELECT fingerprint, revoked_at FROM device_keys WHERE github_user_id = ? AND revoked_at IS NOT NULL",
    )
      .bind(signerUserId)
      .all<{ fingerprint: string; revoked_at: string }>();
    const denyList = new Map(denied.results.map((d) => [d.fingerprint, d.revoked_at]));
    for (const k of listed) {
      const fingerprint = await sha256Fingerprint(k.publicKey);
      githubKeys.push({
        keyId: fingerprint,
        githubUserId: signerUserId,
        algorithm: k.publicKey.split(/\s+/)[0] ?? "unknown",
        publicKey: k.publicKey,
        revokedAt: denyList.get(fingerprint) ?? null,
      });
      // Remember the key so a proof stays explainable after GitHub removal.
      await c.env.DB.prepare(
        `INSERT INTO device_keys (key_id, github_user_id, algorithm, public_key, fingerprint, device_label, source)
         VALUES (?, ?, ?, ?, ?, ?, 'github') ON CONFLICT(key_id) DO NOTHING`,
      )
        .bind(fingerprint, signerUserId, k.publicKey.split(/\s+/)[0] ?? "unknown", k.publicKey, fingerprint, k.title)
        .run()
        .catch(() => undefined);
    }
  }

  const now = new Date();
  const bundle = {
    schemaVersion: "1",
    projectId: project.id,
    repositoryId: project.github_repository_id,
    ownerId: project.github_org_id,
    activePolicyDigest: policyRow.digest,
    gracePolicyDigests: grace.results.map((g) => g.digest),
    policy: JSON.parse(policyRow.canonical_json) as unknown,
    keys: githubKeys,
    grants: refreshed,
    leaseIssuerJwks: [],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  const jws = await signPayload(c.env, bundle, "thwip-bundle+jws");
  return c.json({ bundle: jws });
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
async function queueFromPullRequest(env: Env, payload: {
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

  const key = await queueKeyOf(String(repositoryId), ref);
  const stub = env.BRANCH_QUEUE.get(env.BRANCH_QUEUE.idFromName(key));
  await stub.bind({ queueKey: key, repositoryId: String(repositoryId), baseRef: ref });

  const entryId = `entry_${repositoryId}_${number}`;
  if (payload.action === "closed") {
    await stub.cancel({
      idempotencyKey: `webhook:closed:${entryId}:${headSha}`,
      entryId,
      actorPrincipalId: "github",
      reason: "the pull request was closed",
    });
    return { handled: true, detail: "entry cancelled" };
  }

  await stub.request({
    idempotencyKey: `webhook:request:${entryId}`,
    entryId,
    pullRequestNumber: number,
    sponsorPrincipalId: principal.id,
    sponsorGithubUserId: String(authorId),
    headSha,
  });

  // Readiness is re-derived from what GitHub just told us plus what it already
  // said; the event alone never decides it.
  await stub.readiness({
    idempotencyKey: `webhook:ready:${entryId}:${headSha}:${payload.action ?? "sync"}`,
    entryId,
    ready: pr?.draft !== true && pr?.state === "open",
    schedulerEligible: false,
    primaryReason: pr?.draft === true ? "PR_DRAFT" : pr?.state !== "open" ? "PR_CLOSED" : "AGENT_OFFLINE",
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
  try {
    await c.env.DB.prepare("INSERT INTO webhook_deliveries (provider, delivery_id, event) VALUES ('github', ?, ?)")
      .bind(delivery, event)
      .run();
  } catch {
    return c.json({ ok: true, duplicate: true });
  }
  let installationId: string | null = null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(raw)) as { installation?: { id?: number } };
    installationId = payload.installation?.id != null ? String(payload.installation.id) : null;
  } catch {
    /* hint only */
  }
  // Queue placement happens inline rather than through the projection queue: the
  // Durable Object is the authority and a delayed entry would mean a pull request
  // sits outside the queue for as long as the backlog is deep.
  let queued = { handled: false, detail: "not a queue event" };
  if (event === "pull_request") {
    try {
      queued = await queueFromPullRequest(c.env, JSON.parse(new TextDecoder().decode(raw)) as never);
    } catch (error) {
      queued = { handled: false, detail: error instanceof Error ? error.message : "queue placement failed" };
    }
  }

  await c.env.SYNC_QUEUE.send({ provider: "github", delivery, event, installationId });
  return c.json({ ok: true, queued });
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
    name: c.env.THWIP_ENV === "production" ? "thwip" : "thwip Dev",
    url: origin,
    description: "Git-native CI proofs for agent-run pipelines.",
    hook_attributes: { url: `${origin}/api/github/webhooks`, active: true },
    redirect_url: `${origin}/admin/github/manifest/callback`,
    callback_urls: [`${origin}/api/auth/callback/github`],
    setup_url: `${origin}/dashboard`,
    setup_on_update: true,
    request_oauth_on_install: true,
    public: false,
    default_permissions: { contents: "read", emails: "read", members: "read", metadata: "read" },
    default_events: ["member", "membership", "organization", "repository", "team"],
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

/* The queue's own routes. Authorization reuses the GitHub projection: a viewer
   is a queue participant through their principal, and repository admin comes
   from the synced org role. */
app.route(
  "/",
  queueRoutes<Env>({
    async authenticate(c: { req: { raw: Request } }, env: Env) {
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
        "SELECT activation_state FROM queue_projects WHERE github_repository_id = ? AND base_ref = ? AND enabled = 1",
      )
        .bind(repositoryId, baseRef)
        .first<{ activation_state: string }>();
      return row === null ? null : { activationState: row.activation_state };
    },
    async principalFor(env: Env, githubUserId: string) {
      if (!/^[0-9]{1,32}$/.test(githubUserId)) return null;
      const row = await env.DB.prepare("SELECT id FROM principals WHERE github_user_id = ?")
        .bind(githubUserId)
        .first<{ id: string }>();
      return row?.id ?? null;
    },
    async pinnedVerifier(env: Env, repositoryId: string) {
      const row = await env.DB.prepare(
        "SELECT verifier_json FROM queue_projects WHERE github_repository_id = ? AND enabled = 1",
      )
        .bind(repositoryId)
        .first<{ verifier_json: string }>();
      return row === null ? null : (JSON.parse(row.verifier_json) as never);
    },
  }) as never,
);

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const synced = new Set<string>();
    for (const msg of batch.messages) {
      const body = msg.body as { installationId?: string | null };
      const inst = body?.installationId;
      try {
        if (inst && !synced.has(inst)) {
          await syncInstallation(env, inst);
          synced.add(inst);
        }
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const orgs = await env.DB.prepare(
      "SELECT installation_id FROM organizations WHERE installation_id IS NOT NULL AND status = 'active'",
    ).all<{ installation_id: string }>();
    for (const o of orgs.results) {
      try {
        await syncInstallation(env, o.installation_id);
      } catch {
        /* retried next run */
      }
    }
  },
} satisfies ExportedHandler<Env>;

/* The Durable Object and Workflow classes the wrangler bindings name. They live
   in ./queue and are re-exported here because Cloudflare resolves a binding's
   class_name against the Worker's own exports. */
export { BranchQueue } from "./queue/BranchQueue.js";
export { IntegrationTurnWorkflow } from "./queue/IntegrationTurnWorkflow.js";
