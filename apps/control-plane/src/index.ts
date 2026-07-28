import { Hono } from "hono";
import { CompactSign, SignJWT, createRemoteJWKSet, importJWK, jwtVerify, type JWK } from "jose";
import { sha256Fingerprint, verifySshSigEd25519 } from "./sshsig-verify.js";

export interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue;
  THWIP_ENV: string;
  PUBLIC_ORIGIN: string;
  BUILD_SHA: string;
  THWIP_ADMIN_TOKEN: string;
  THWIP_SERVICE_SIGNING_PRIVATE_JWK: string;
  GITHUB_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  GITHUB_SYNC_TOKEN?: string;
}

const te = new TextEncoder();

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const githubJwks = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

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

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const payload = { service: "thwip", env: c.env.THWIP_ENV, buildSha: c.env.BUILD_SHA, now: nowIso() };
  const jws = await signPayload(c.env, payload, "thwip-health+jws");
  return c.json({ ...payload, jws });
});

// --- Device enrollment -----------------------------------------------------

app.post("/v1/devices/challenges", async (c) => {
  if (!requireAdmin(c.env, c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const challenge = randomId("chal");
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await c.env.DB.prepare("INSERT INTO enroll_challenges (challenge, expires_at) VALUES (?, ?)")
    .bind(challenge, expires)
    .run();
  return c.json({ challenge, expiresAt: expires });
});

app.post("/v1/devices", async (c) => {
  if (!requireAdmin(c.env, c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json()) as {
    publicKey?: string;
    label?: string;
    githubUserId?: string;
    challenge?: string;
    proofOfPossession?: string;
  };
  if (!body.publicKey || !body.githubUserId || !body.challenge || !body.proofOfPossession) {
    return c.json({ error: "missing fields" }, 400);
  }
  if (!/^[0-9]+$/.test(body.githubUserId)) return c.json({ error: "githubUserId must be decimal" }, 400);

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
      .bind(keyId, body.githubUserId, algorithm, body.publicKey.trim(), fingerprint, body.label ?? "device")
      .run();
  } catch {
    return c.json({ error: "key already enrolled" }, 409);
  }
  return c.json({ keyId, fingerprint });
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

// --- Admin bootstrap (org/project/policy/grants) ---------------------------

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

// --- Run leases ------------------------------------------------------------

app.post("/v1/run-leases", async (c) => {
  if (!requireAdmin(c.env, c.req.raw)) return c.json({ error: "unauthorized" }, 401);
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
  } catch (e) {
    return Response.json({ error: "oidc verification failed" }, { status: 401 });
  }
}

app.post("/v1/verification-bundles:resolve", async (c) => {
  const claims = await verifyGithubOidc(c);
  if (claims instanceof Response) return claims;

  const body = (await c.req.json()) as { repositoryId?: string; headSha?: string; keyIds?: string[] };
  if (!body.repositoryId || !/^[0-9]+$/.test(body.repositoryId)) return c.json({ error: "repositoryId invalid" }, 400);
  // The OIDC token authorizes exactly one repository; request may not widen it.
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

  const policyRow = await c.env.DB.prepare("SELECT digest, version, canonical_json, status FROM policy_bundles WHERE digest = ?")
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

  // Verification-time freshness: refresh stale grants from GitHub when a sync token is present.
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
  await c.env.SYNC_QUEUE.send({ provider: "github", delivery, event });
  return c.json({ ok: true });
});

// --- Stripe webhooks -------------------------------------------------------

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

app.get("/", (c) =>
  c.html(
    `<!doctype html><meta charset="utf-8"><title>thwip</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto"><h1>thwip</h1><p>Git-native CI receipts for agent-run pipelines. Environment: ${c.env.THWIP_ENV}.</p></body>`,
  ),
);

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch, _env: Env): Promise<void> {
    // v1 slice: webhook deliveries are recorded at ingest; reconciliation
    // happens via scheduled runs. Ack all messages.
    for (const msg of batch.messages) msg.ack();
  },
  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // Reserved for nightly reconciliation.
  },
} satisfies ExportedHandler<Env>;
