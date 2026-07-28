import { Hono } from "hono";
import { CompactSign, SignJWT, createRemoteJWKSet, importJWK, jwtVerify, type JWK } from "jose";
import { sha256Fingerprint, verifySshSigEd25519 } from "./sshsig-verify.js";
import { createAuth } from "./auth.js";
import { listInstallations, syncInstallation } from "./github-app.js";
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
  const account = await env.DB.prepare(
    `SELECT accountId FROM account WHERE userId = ? AND providerId = 'github'`,
  )
    .bind(session.user.id)
    .first<{ accountId: string }>();
  if (!account) return null;
  const rows = await env.DB.prepare(
    `SELECT p.id, p.organization_id, p.github_org_role, p.activated_at, o.github_org_id, o.github_login
     FROM principals p JOIN organizations o ON o.id = p.organization_id
     WHERE p.github_user_id = ? ORDER BY o.github_login`,
  )
    .bind(account.accountId)
    .all<{
      id: string;
      organization_id: string;
      github_org_role: string | null;
      activated_at: string | null;
      github_org_id: string;
      github_login: string;
    }>();
  const orgs: ViewerOrg[] = rows.results.map((r) => ({
    organizationId: r.organization_id,
    githubOrgId: r.github_org_id,
    githubLogin: r.github_login,
    principalId: r.id,
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
  return c.json({ viewer: { ...viewer }, principal, organization: org, organizations: viewer.orgs });
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
    `SELECT p.id, p.github_repository_id, p.github_name, p.default_branch, p.enabled, p.security_profile, p.active_policy_digest,
            (SELECT COUNT(*) FROM repository_grants g WHERE g.project_id = p.id AND g.active = 1) AS collaborators,
            (SELECT outcome FROM verification_observations o WHERE o.project_id = p.id ORDER BY observed_at DESC LIMIT 1) AS last_outcome,
            (SELECT observed_at FROM verification_observations o WHERE o.project_id = p.id ORDER BY observed_at DESC LIMIT 1) AS last_observed_at
     FROM projects p WHERE p.organization_id = ? ORDER BY p.github_name`,
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
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const { profile } = (await c.req.json()) as { profile?: string };
  if (!profile || !["fast", "fresh", "audited", "remote"].includes(profile)) {
    return c.json({ error: "invalid profile" }, 400);
  }
  const projectId = c.req.param("id");
  const grant = await c.env.DB.prepare(
    "SELECT permission FROM repository_grants WHERE project_id = ? AND github_user_id = ? AND active = 1",
  )
    .bind(projectId, viewer.githubUserId)
    .first<{ permission: string }>();
  if (viewer.githubOrgRole !== "owner" && grant?.permission !== "admin") {
    return c.json({ error: "repository admin (per GitHub) required" }, 403);
  }
  await c.env.DB.prepare("UPDATE projects SET security_profile = ? WHERE id = ? AND organization_id = ?")
    .bind(profile, projectId, viewer.organizationId)
    .run();
  return c.json({ profile });
});

// --- Dashboard: people, teams, devices ------------------------------------

app.get("/v1/dashboard/people", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const orgId = viewer.organizationId;
  const members = await c.env.DB.prepare(
    `SELECT github_user_id, github_login, avatar_url, github_org_role, activated_at,
            (SELECT COUNT(*) FROM device_keys k WHERE k.github_user_id = principals.github_user_id AND k.revoked_at IS NULL) AS active_keys
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
  const grants = await c.env.DB.prepare(
    `SELECT g.project_id, p.github_name, g.github_user_id, g.github_login, g.permission, g.active
     FROM repository_grants g JOIN projects p ON p.id = g.project_id
     WHERE p.organization_id = ? ORDER BY p.github_name, g.github_login`,
  )
    .bind(orgId)
    .all();
  return c.json({
    members: members.results,
    teams: teams.results,
    teamMembers: teamMembers.results,
    grants: grants.results,
  });
});

app.get("/v1/dashboard/devices", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const rows = await c.env.DB.prepare(
    `SELECT k.key_id, k.github_user_id, p.github_login, k.algorithm, k.fingerprint, k.device_label, k.created_at, k.revoked_at
     FROM device_keys k LEFT JOIN principals p ON p.github_user_id = k.github_user_id AND p.organization_id = ?
     ORDER BY k.created_at DESC`,
  )
    .bind(viewer.organizationId)
    .all();
  return c.json({ devices: rows.results });
});

app.post("/v1/dashboard/devices/:keyId/revoke", async (c) => {
  const viewer = await resolveViewer(c.env, c.req.raw);
  if (!viewer?.organizationId) return c.json({ error: "unauthenticated" }, 401);
  const keyId = c.req.param("keyId");
  const key = await c.env.DB.prepare("SELECT github_user_id FROM device_keys WHERE key_id = ?")
    .bind(keyId)
    .first<{ github_user_id: string }>();
  if (!key) return c.json({ error: "unknown key" }, 404);
  // Key owner may revoke their own; GitHub org owners may revoke any.
  if (key.github_user_id !== viewer.githubUserId && viewer.githubOrgRole !== "owner") {
    return c.json({ error: "owner or org owner required" }, 403);
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

  const body = (await c.req.json()) as { repositoryId?: string; headSha?: string; keyIds?: string[] };
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

  const keys = await c.env.DB.prepare(
    "SELECT key_id, github_user_id, algorithm, public_key, revoked_at FROM device_keys",
  ).all<{ key_id: string; github_user_id: string; algorithm: string; public_key: string; revoked_at: string | null }>();

  const now = new Date();
  const bundle = {
    schemaVersion: "1",
    projectId: project.id,
    repositoryId: project.github_repository_id,
    ownerId: project.github_org_id,
    activePolicyDigest: policyRow.digest,
    gracePolicyDigests: grace.results.map((g) => g.digest),
    policy: JSON.parse(policyRow.canonical_json) as unknown,
    keys: keys.results.map((k) => ({
      keyId: k.key_id,
      githubUserId: k.github_user_id,
      algorithm: k.algorithm,
      publicKey: k.public_key,
      revokedAt: k.revoked_at,
    })),
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
  await c.env.SYNC_QUEUE.send({ provider: "github", delivery, event, installationId });
  return c.json({ ok: true });
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
