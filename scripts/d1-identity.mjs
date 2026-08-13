#!/usr/bin/env node
/**
 * The explicit, short-lived credentials allowed to reach the live D1 database.
 *
 * These functions never inspect or reuse Wrangler's stored OAuth session. A
 * caller supplies the role-specific token variable and the Recall account id.
 * Cloudflare confirms that token directly before Wrangler receives it.
 */
import { liveD1Target } from "./deploy-identity.mjs";

const API = "https://api.cloudflare.com/client/v4";
const TOKEN_ENV = {
  read: "THWIP_D1_READ_API_TOKEN",
  migration: "THWIP_D1_MIGRATION_API_TOKEN",
};

export const MAX_D1_TOKEN_REMAINING_MS = 24 * 60 * 60 * 1000;

function tokenVariable(kind) {
  const variable = TOKEN_ENV[kind];
  if (variable === undefined) throw new Error(`unknown D1 credential kind: ${kind}`);
  return variable;
}

/** Resolve only the credential variable for this operation. */
export function d1CredentialFromEnv(env, kind) {
  const variable = tokenVariable(kind);
  const token = env[variable] ?? "";
  const accountId = env.THWIP_D1_ACCOUNT_ID ?? "";
  if (token.length === 0) {
    return {
      credential: null,
      refusal:
        `Refusing: ${kind} access requires ${variable}. ` +
        "This command never uses CLOUDFLARE_API_TOKEN or the ambient Wrangler login.",
    };
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    return {
      credential: null,
      refusal: "Refusing: THWIP_D1_ACCOUNT_ID must be the 32-character Recall Cloudflare account id.",
    };
  }
  return { credential: { kind, token, accountId, tokenVariable: variable }, refusal: null };
}

/** Require a literal acknowledgement of the hostname backed by this live DB. */
export function liveTargetRefusal(target, confirmation) {
  const hostname = new URL(target.origin).hostname;
  return confirmation === hostname
    ? null
    : `Refusing: --confirm-live must be ${hostname}. Cloudflare calls this environment ${target.env}, but it is the live database behind ${hostname}.`;
}

async function jsonResponse(fetchImpl, url, init, description) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new Error(`Refusing: could not reach Cloudflare to check ${description}.`);
  }
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function activeToken(fetchImpl, token) {
  const checked = await jsonResponse(
    fetchImpl,
    `${API}/user/tokens/verify`,
    { headers: { authorization: `Bearer ${token}` } },
    "the API token",
  );
  const result = checked.body?.result;
  if (!checked.response.ok || checked.body?.success !== true || result?.status !== "active") {
    throw new Error("Refusing: Cloudflare did not confirm that the explicit API token is active.");
  }
  return result;
}

function queryUrl(accountId, databaseId) {
  return `${API}/accounts/${accountId}/d1/database/${databaseId}/query`;
}

/**
 * Prove the deploy token is active and cannot query this deployment's live D1.
 * A successful D1 read is a refusal: deploy authority must not include it.
 */
export async function preflightDeployCredential({ fetchImpl, token, accountId, target }) {
  await activeToken(fetchImpl, token);
  const probed = await jsonResponse(
    fetchImpl,
    queryUrl(accountId, target.databaseId),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1 AS thwip_deploy_d1_probe" }),
    },
    "that the deploy token has no live D1 access",
  );
  if (probed.response.ok && probed.body?.success === true) {
    throw new Error("Refusing: the deploy token can query the live D1 database. Remove every D1 permission from it.");
  }
  if (probed.response.status !== 403) {
    throw new Error("Refusing: Cloudflare did not give a clear permission refusal for the deploy token on live D1.");
  }
  return { status: "active", liveD1Access: false };
}

/**
 * Prove the explicit D1 token is active, expires soon, and reaches only the
 * target selected from wrangler.jsonc. The probe reads SELECT 1 and no product
 * rows. Cloudflare does not expose a token's full policy to itself, so the
 * operator still confirms D1 Read or D1 Edit, and no other permission, when
 * creating it.
 */
export async function preflightD1Credential({
  fetchImpl,
  credential,
  target,
  now = Date.now(),
  maxRemainingMs = MAX_D1_TOKEN_REMAINING_MS,
}) {
  const token = await activeToken(fetchImpl, credential.token);
  const expiresAt = Date.parse(token.expires_on ?? "");
  const remaining = expiresAt - now;
  if (!Number.isFinite(expiresAt) || remaining <= 0 || remaining > maxRemainingMs) {
    throw new Error("Refusing: the D1 token must expire within the next 24 hours.");
  }

  const probed = await jsonResponse(
    fetchImpl,
    queryUrl(credential.accountId, target.databaseId),
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1 AS thwip_d1_preflight" }),
    },
    `${target.databaseName} access`,
  );
  const result = Array.isArray(probed.body?.result) ? probed.body.result[0] : null;
  const row = Array.isArray(result?.results) ? result.results[0] : null;
  if (
    !probed.response.ok ||
    probed.body?.success !== true ||
    result?.success !== true ||
    row?.thwip_d1_preflight !== 1 ||
    result?.meta?.changed_db !== false ||
    (result?.meta?.rows_written ?? 0) !== 0
  ) {
    throw new Error(
      `Refusing: the explicit ${credential.kind} token did not pass the non-mutating probe for ${target.databaseName}.`,
    );
  }

  return {
    status: "active",
    expiresOn: new Date(expiresAt).toISOString(),
    target: `${target.env}/${target.databaseName}`,
  };
}

/** Give Wrangler only the selected API token, never another ambient identity. */
export function wranglerEnvironment(baseEnv, credential) {
  const child = { ...baseEnv };
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "CF_API_TOKEN",
    "CF_API_KEY",
    "CF_EMAIL",
    "CF_ACCOUNT_ID",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_ENV",
    "THWIP_D1_READ_API_TOKEN",
    "THWIP_D1_MIGRATION_API_TOKEN",
    "THWIP_D1_ACCOUNT_ID",
  ]) {
    delete child[name];
  }
  child.CLOUDFLARE_API_TOKEN = credential.token;
  child.CLOUDFLARE_ACCOUNT_ID = credential.accountId;
  child.WRANGLER_LOG_SANITIZE = "true";
  return child;
}

/** Check whether Cloudflare still accepts a token after the operator deletes it. */
export async function tokenAcceptance({ fetchImpl, token }) {
  const checked = await jsonResponse(
    fetchImpl,
    `${API}/user/tokens/verify`,
    { headers: { authorization: `Bearer ${token}` } },
    "whether the D1 token was revoked",
  );
  if (checked.response.ok && checked.body?.success === true) {
    const status = checked.body?.result?.status;
    return { accepted: status === "active", status: typeof status === "string" ? status : "unknown" };
  }
  if (
    (checked.response.status === 400 || checked.response.status === 401) &&
    checked.body?.success === false
  ) {
    return { accepted: false, status: "rejected" };
  }
  throw new Error(
    "Could not prove that Cloudflare revoked the D1 token. Check the token in Cloudflare, then try again.",
  );
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const action = process.argv[2];
  const kind = argument("--kind");
  try {
    if (action === "verify-cleared") {
      const variable = tokenVariable(kind);
      if ((process.env[variable] ?? "").length > 0 || (process.env.THWIP_D1_ACCOUNT_ID ?? "").length > 0) {
        throw new Error(`Refusing: ${variable} or THWIP_D1_ACCOUNT_ID is still set in this shell.`);
      }
      console.log("No role-specific D1 credential remains in this shell.");
    } else if (action === "verify-revoked") {
      const selected = d1CredentialFromEnv(process.env, kind);
      if (selected.refusal !== null) throw new Error(selected.refusal);
      const status = await tokenAcceptance({ fetchImpl: fetch, token: selected.credential.token });
      if (status.accepted) throw new Error("Refusing: Cloudflare still accepts this D1 token. Delete it, then check again.");
      console.log("Cloudflare no longer accepts the D1 token. Clear it from this shell now.");
    } else {
      throw new Error("usage: d1-identity.mjs verify-revoked|verify-cleared --kind read|migration");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
