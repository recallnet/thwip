import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatSchemaRefusal,
  liveMigrationState,
  migrationTrackRefusal,
  migrationReleaseState,
  missingMigrationFiles,
  readMigrations,
  undeclaredMigrations,
} from "./migration-core.mjs";

const GUARDS = Object.freeze([
  "behind-main",
  "unmerged-tree",
  "schema-endpoint-missing",
  "schema-unreadable",
  "pending-migrations",
]);

export function parseBreakGlass(value) {
  const raw = (value ?? "").trim();
  if (!raw) return { guards: [], reason: null, error: null };
  const split = raw.indexOf(":");
  const guards = (split === -1 ? raw : raw.slice(0, split)).split(",").map((name) => name.trim()).filter(Boolean);
  const reason = split === -1 ? "" : raw.slice(split + 1).trim();
  const unknown = guards.filter((name) => !GUARDS.includes(name));
  if (unknown.length > 0) {
    return { guards: [], reason: null, error: `THWIP_BREAK_GLASS names no such guard: ${unknown.join(", ")}. Valid guards: ${GUARDS.join(", ")}.` };
  }
  if (reason.length < 20) {
    return { guards: [], reason: null, error: "THWIP_BREAK_GLASS needs a reason of at least 20 characters after the colon." };
  }
  return { guards, reason, error: null };
}

export function excuses(declared, guard) {
  return declared.error === null && declared.guards.includes(guard);
}

export function breakGlassRefusal(guard, why) {
  return `Refusing: ${why}\n\nIf this is deliberate, record why:\n  THWIP_BREAK_GLASS="${guard}: why this cannot wait" pnpm --filter @thwip/control-plane run deploy:staging`;
}

export function exceptionStamp(declared, { branch, head, at }) {
  if (declared.error !== null || declared.guards.length === 0) return "";
  return JSON.stringify({ guards: declared.guards, reason: declared.reason, tree: `${branch}@${head}`, at });
}

const DEPLOY_TOKEN_PERMISSIONS = [
  "Account / Workers Scripts:Edit",
  "Account / Workers R2 Storage:Edit",
  "Account / Workers KV Storage:Edit",
  "Account / Queues:Edit",
  "Account / Workers Tail:Read",
  "Account / Account Settings:Read",
  "User / User Details:Read",
  "User / Memberships:Read",
  "Zone / Workers Routes:Edit (thwip.ai)",
];
const SCOPED_TOKEN_INSTRUCTIONS = [
  "Create a scoped deploy token with exactly these permissions:",
  ...DEPLOY_TOKEN_PERMISSIONS.map((permission) => `  ${permission}`),
  "Give it no D1 permission. Export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
].join("\n");

export function deployIdentity(env) {
  if (!(env.CLOUDFLARE_API_TOKEN ?? "")) {
    return {
      kind: "missing",
      refusal: "Refusing: deploys require an explicit CLOUDFLARE_API_TOKEN and never use the ambient Wrangler login.\n" + SCOPED_TOKEN_INSTRUCTIONS,
      note: "No scoped deploy token is configured.",
    };
  }
  if (!(env.CLOUDFLARE_ACCOUNT_ID ?? "")) {
    return {
      kind: "scoped-token",
      refusal: "Refusing: CLOUDFLARE_API_TOKEN is set and CLOUDFLARE_ACCOUNT_ID is not.",
      note: "The scoped deploy token has no configured account.",
    };
  }
  return { kind: "scoped-token", refusal: null, note: "Deploying under the explicit scoped deploy token." };
}

export function liveD1Target(env) {
  const source = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  const selected = config.env?.[env];
  const origin = selected?.vars?.PUBLIC_ORIGIN;
  const database = selected?.d1_databases?.find((candidate) => candidate.binding === "DB");
  if (typeof origin !== "string" || typeof database?.database_name !== "string" || typeof database.database_id !== "string") {
    throw new Error(`wrangler.jsonc defines no complete live D1 target for --env ${env}`);
  }
  return { env, origin: origin.replace(/\/$/, ""), databaseName: database.database_name, databaseId: database.database_id };
}

export const liveSchemaUrl = (env) => `${liveD1Target(env).origin}/v1/schema`;
export const liveHealthUrl = (env) => `${liveD1Target(env).origin}/health`;

const REPOSITORY = "recallnet/thwip";
const REPOSITORY_ID = "1315419165";
const MAIN_REF = "refs/heads/main";
const actionRefusal = (detail) => ({ branch: "HEAD", note: null, refusal: `Refusing GitHub Actions deploy checkout: ${detail}` });

export function deployCheckout(facts, env) {
  if (env.GITHUB_ACTIONS !== "true") return { branch: facts.gitBranch, note: null, refusal: null };
  if (env.CI !== "true") return actionRefusal("CI is not true");
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REPOSITORY_ID !== REPOSITORY_ID) return actionRefusal(`expected ${REPOSITORY} (${REPOSITORY_ID})`);
  if (!["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME ?? "")) return actionRefusal("only push and workflow_dispatch may deploy");
  if (env.GITHUB_REF !== MAIN_REF) return actionRefusal(`expected ${MAIN_REF}`);
  if (env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/deploy-staging.yml@${MAIN_REF}`) return actionRefusal("the deploy workflow is not running from canonical main");
  if (facts.dirty) return actionRefusal("the checkout has uncommitted changes");
  if (!/^[0-9a-f]{40,64}$/.test(env.GITHUB_SHA ?? "")) return actionRefusal("GITHUB_SHA is not a full Git object id");
  if (facts.headSha !== env.GITHUB_SHA) return actionRefusal(`HEAD ${facts.headSha} does not match GITHUB_SHA`);
  if (facts.remoteMainSha !== env.GITHUB_SHA) return actionRefusal(`origin/main ${facts.remoteMainSha ?? "could not be read"} does not match GITHUB_SHA`);
  return { branch: "main", note: `GitHub Actions checkout is canonical ${MAIN_REF} at ${facts.headSha}.`, refusal: null };
}

export function buildStamp(git, env = {}) {
  if (env.GITHUB_ACTIONS === "true") {
    const checkout = deployCheckout({
      gitBranch: git("rev-parse", "--abbrev-ref", "HEAD"),
      headSha: git("rev-parse", "HEAD"),
      remoteMainSha: git("rev-parse", "origin/main"),
      dirty: git("status", "--porcelain").length > 0,
    }, env);
    if (checkout.refusal !== null) throw new Error(checkout.refusal);
    return env.GITHUB_SHA;
  }
  const head = git("rev-parse", "HEAD");
  return git("status", "--porcelain").length > 0 ? `${head}-dirty` : head;
}

const DEPLOYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validDeploymentId = (value) => typeof value === "string" && DEPLOYMENT_ID_PATTERN.test(value);
export function deploymentId(uuid = randomUUID) {
  const value = uuid();
  if (!validDeploymentId(value)) throw new Error("could not create a valid deployment id");
  return value;
}

const API = "https://api.cloudflare.com/client/v4";
const TOKEN_ENV = { read: "THWIP_D1_READ_API_TOKEN", migration: "THWIP_D1_MIGRATION_API_TOKEN" };
const MAX_D1_TOKEN_REMAINING_MS = 24 * 60 * 60 * 1000;

function tokenVariable(kind) {
  const variable = TOKEN_ENV[kind];
  if (variable === undefined) throw new Error(`unknown D1 credential kind: ${kind}`);
  return variable;
}

export function d1CredentialFromEnv(env, kind) {
  const variable = tokenVariable(kind);
  const token = env[variable] ?? "";
  const accountId = env.THWIP_D1_ACCOUNT_ID ?? "";
  if (!token) return { credential: null, refusal: `Refusing: ${kind} access requires ${variable}. This command never uses CLOUDFLARE_API_TOKEN or the ambient Wrangler login.` };
  if (!/^[0-9a-f]{32}$/i.test(accountId)) return { credential: null, refusal: "Refusing: THWIP_D1_ACCOUNT_ID must be the 32-character Cloudflare account id." };
  return { credential: { kind, token, accountId, tokenVariable: variable }, refusal: null };
}

export function liveTargetRefusal(target, confirmation) {
  const hostname = new URL(target.origin).hostname;
  return confirmation === hostname ? null : `Refusing: --confirm-live must be ${hostname}. Cloudflare calls this environment ${target.env}, but it is live at ${hostname}.`;
}

async function jsonResponse(fetchImpl, url, init, description) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new Error(`Refusing: could not reach Cloudflare to check ${description}.`);
  }
  return { response, body: await response.json().catch(() => null) };
}

async function tokenVerification(fetchImpl, token, accountId) {
  const refusals = [];
  for (const url of [`${API}/accounts/${accountId}/tokens/verify`, `${API}/user/tokens/verify`]) {
    const checked = await jsonResponse(fetchImpl, url, { headers: { authorization: `Bearer ${token}` } }, "the API token");
    const result = checked.body?.result;
    if (checked.response.ok && checked.body?.success === true && typeof result?.status === "string") {
      return { result, rejected: false };
    }
    refusals.push({ status: checked.response.status, success: checked.body?.success });
  }
  return {
    result: null,
    rejected: refusals.every(({ status, success }) =>
      (status === 400 || status === 401) && success === false),
  };
}

async function activeToken(fetchImpl, token, accountId) {
  const { result } = await tokenVerification(fetchImpl, token, accountId);
  if (result?.status !== "active") throw new Error("Refusing: Cloudflare did not confirm that the explicit API token is active.");
  return result;
}

const queryUrl = (accountId, databaseId) => `${API}/accounts/${accountId}/d1/database/${databaseId}/query`;

export async function preflightDeployCredential({ fetchImpl, token, accountId, target }) {
  await activeToken(fetchImpl, token, accountId);
  const probed = await jsonResponse(fetchImpl, queryUrl(accountId, target.databaseId), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT 1 AS thwip_deploy_d1_probe" }),
  }, "that the deploy token has no live D1 access");
  if (probed.response.ok && probed.body?.success === true) throw new Error("Refusing: the deploy token can query the live D1. Remove every D1 permission.");
  if (probed.response.status !== 403) throw new Error("Refusing: Cloudflare did not give a clear permission refusal for the deploy token on live D1.");
  return { status: "active", liveD1Access: false };
}

export async function preflightD1Credential({
  fetchImpl,
  credential,
  target,
  now = Date.now(),
  maxRemainingMs = MAX_D1_TOKEN_REMAINING_MS,
}) {
  const token = await activeToken(fetchImpl, credential.token, credential.accountId);
  const expiresAt = Date.parse(token.expires_on ?? "");
  const remaining = expiresAt - now;
  if (!Number.isFinite(expiresAt) || remaining <= 0 || remaining > maxRemainingMs) throw new Error("Refusing: the D1 token must expire within the next 24 hours.");
  const probed = await jsonResponse(fetchImpl, queryUrl(credential.accountId, target.databaseId), {
    method: "POST",
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT 1 AS thwip_d1_preflight" }),
  }, `${target.databaseName} access`);
  const result = Array.isArray(probed.body?.result) ? probed.body.result[0] : null;
  const row = Array.isArray(result?.results) ? result.results[0] : null;
  if (!probed.response.ok || probed.body?.success !== true || result?.success !== true || row?.thwip_d1_preflight !== 1 || result?.meta?.changed_db !== false || (result?.meta?.rows_written ?? 0) !== 0) {
    throw new Error(`Refusing: the explicit ${credential.kind} token did not pass the non-mutating probe for ${target.databaseName}.`);
  }
  return { status: "active", expiresOn: new Date(expiresAt).toISOString(), target: `${target.env}/${target.databaseName}` };
}

export function wranglerEnvironment(baseEnv, credential) {
  const child = { ...baseEnv };
  for (const name of [
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_API_TOKEN", "CF_API_KEY",
    "CF_EMAIL", "CF_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ENV", "THWIP_D1_READ_API_TOKEN",
    "THWIP_D1_MIGRATION_API_TOKEN", "THWIP_D1_ACCOUNT_ID",
  ]) delete child[name];
  child.CLOUDFLARE_API_TOKEN = credential.token;
  child.CLOUDFLARE_ACCOUNT_ID = credential.accountId;
  child.WRANGLER_LOG_SANITIZE = "true";
  return child;
}

/** Prove that Cloudflare no longer accepts a role token after use. */
export async function tokenAcceptance({ fetchImpl, token, accountId }) {
  const { result, rejected } = await tokenVerification(fetchImpl, token, accountId);
  if (result !== null) return { accepted: result.status === "active", status: result.status };
  if (rejected) return { accepted: false, status: "rejected" };
  throw new Error("Could not prove that Cloudflare revoked the D1 token. Check it in Cloudflare, then try again.");
}

export function verifyD1CredentialCleared(env, kind) {
  const variable = tokenVariable(kind);
  if ((env[variable] ?? "") || (env.THWIP_D1_ACCOUNT_ID ?? "")) {
    throw new Error(`Refusing: ${variable} or THWIP_D1_ACCOUNT_ID is still set in this shell.`);
  }
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultGit = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

/** Fail closed before a Worker deploy can touch the live service. */
export async function preflightDeploy({
  targetEnv = "staging",
  env = process.env,
  fetchImpl = fetch,
  git = defaultGit,
  log = console,
} = {}) {
  const gitBranch = git("rev-parse", "--abbrev-ref", "HEAD");
  const headSha = git("rev-parse", "HEAD");
  const head = git("rev-parse", "--short", "HEAD");
  const dirty = git("status", "--porcelain").length > 0;
  let behind = "0";
  let remoteMainSha = null;
  try {
    git("fetch", "--quiet", "origin", "main");
    remoteMainSha = git("rev-parse", "origin/main");
    behind = git("rev-list", "--count", "HEAD..origin/main");
  } catch {
    behind = "?";
  }

  const checkout = deployCheckout({ gitBranch, headSha, remoteMainSha, dirty }, env);
  const branch = checkout.branch;
  log.log(`deploying ${branch}@${head}${dirty ? " (uncommitted changes)" : ""}, ${behind} commit(s) behind origin/main`);
  if (checkout.note !== null) log.log(checkout.note);
  if (checkout.refusal !== null) throw new Error(checkout.refusal);

  const identity = deployIdentity(env);
  log.log(identity.note);
  if (identity.refusal !== null) throw new Error(identity.refusal);
  await preflightDeployCredential({
    fetchImpl,
    token: env.CLOUDFLARE_API_TOKEN,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    target: liveD1Target(targetEnv),
  });
  log.log("deploy identity: active, and refused by the live D1 database");

  const declared = parseBreakGlass(env.THWIP_BREAK_GLASS);
  if (declared.error !== null) throw new Error(declared.error);
  if (declared.guards.length > 0) {
    log.warn(`break-glass: excusing ${declared.guards.join(", ")}`);
    log.warn(`reason: ${declared.reason}`);
    log.warn("This is published at /health for as long as the worker runs it.");
  }
  if (behind !== "0" && behind !== "?" && !excuses(declared, "behind-main")) {
    throw new Error(breakGlassRefusal(
      "behind-main",
      `this checkout is missing ${behind} commit(s) that are on origin/main, so deploying it would revert those commits. Rebase, or:`,
    ));
  }
  if (branch !== "main") {
    let others = [];
    try {
      others = git("branch", "-r", "--no-merged", "HEAD", "--format=%(refname:short)")
        .split("\n")
        .map((value) => value.trim())
        .filter((value) => value && value !== "origin/HEAD" && value !== "origin/main");
    } catch {
      // The refusal below does not depend on listing other branches.
    }
    log.warn(`Deploying ${branch}, not main. The running worker becomes exactly this tree.`);
    for (const other of others.slice(0, 20)) log.warn(`  ${other}`);
    if (!excuses(declared, "unmerged-tree")) {
      throw new Error(breakGlassRefusal(
        "unmerged-tree",
        "deploy from main so the worker matches what has been reviewed and merged. Having read the list above:",
      ));
    }
  }

  const migrations = readMigrations(`${root}/migrations`);
  const undeclared = undeclaredMigrations(migrations);
  if (undeclared.length > 0) {
    throw new Error(`Refusing: migrations absent from the shared release model:\n${undeclared.map((name) => `  ${name}`).join("\n")}`);
  }
  const missing = missingMigrationFiles(migrations);
  if (missing.length > 0) {
    throw new Error(`Refusing: release-model SQL files are missing:\n${missing.map((name) => `  ${name}`).join("\n")}`);
  }

  const schemaUrl = liveSchemaUrl(targetEnv);
  let response = null;
  try {
    response = await fetchImpl(schemaUrl, { headers: { accept: "application/json" } });
  } catch (error) {
    log.error(`Could not ask ${targetEnv} which migrations it has: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response?.status === 404) {
    const refusal = breakGlassRefusal(
      "schema-endpoint-missing",
      `${schemaUrl} answered 404, so the live Worker predates the schema endpoint. Deploying once puts it there:`,
    );
    if (!excuses(declared, "schema-endpoint-missing")) throw new Error(refusal);
    log.warn(refusal);
    return;
  }

  let schema = null;
  if (response?.ok) {
    try {
      schema = await response.json();
    } catch {
      schema = null;
    }
  } else if (response !== null) {
    log.error(`Could not ask ${targetEnv} which migrations it has: ${response.status} ${response.statusText}`);
  }
  let release = null;
  const live = liveMigrationState(schema);
  if (live !== null) {
    const trackRefusal = migrationTrackRefusal(migrations, live.track);
    if (trackRefusal !== null) throw new Error(`Refusing: ${trackRefusal}.`);
    release = migrationReleaseState(migrations, live.applied);
  }
  if (release === null) {
    if (!excuses(declared, "schema-unreadable")) {
      throw new Error(breakGlassRefusal(
        "schema-unreadable",
        `${schemaUrl} could not be read, so the schema cannot be compared with this code. Check the Worker, or:`,
      ));
    }
    return;
  }
  if (release.outOfOrderApplied.length > 0) {
    throw new Error(`Refusing: ${targetEnv} has an out-of-order migration ledger:\n${release.outOfOrderApplied.join("\n")}`);
  }
  if (release.deployBlockers.length > 0 && !excuses(declared, "pending-migrations")) {
    throw new Error(
      `${formatSchemaRefusal(
        release.deployBlockers,
        targetEnv,
        new URL(liveD1Target(targetEnv).origin).hostname,
      )}\n\n` +
      breakGlassRefusal("pending-migrations", "the schema this code needs is not there yet."),
    );
  }
  log.log(
    `schema: ${targetEnv} release phase ${release.kind}; selected: ${release.selected.join(", ") || "none"}` +
      (release.barrier === null ? "" : `; barrier: ${release.barrier.name}`) +
      (release.blockedBehindBarrier.length === 0 ? "" : `; blocked: ${release.blockedBehindBarrier.join(", ")}`),
  );
}

export function dirtyShaCaveat(sha) {
  return sha.endsWith("-dirty")
    ? `${sha} names the commit, not the uncommitted change. This is not unique; commit before deploying if the change must be verifiable.`
    : null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForBuildSha({
  url,
  expectedSha,
  expectedDeploymentId = null,
  fetchImpl = fetch,
  sleepMs = 3000,
  timeoutMs = 120000,
  sleep = defaultSleep,
  now = Date.now,
  onProgress = () => {},
}) {
  const start = now();
  let lastSha = null;
  let lastError = null;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (response.ok) {
        const body = await response.json();
        lastSha = typeof body.buildSha === "string" ? body.buildSha : null;
        lastError = null;
        const seenId = typeof body.projectLifecycle?.workerDeploymentId === "string"
          ? body.projectLifecycle.workerDeploymentId
          : null;
        if (lastSha === expectedSha && (expectedDeploymentId === null || seenId === expectedDeploymentId)) {
          return { ok: true, sha: lastSha, attempts, waitedMs: now() - start };
        }
      } else {
        lastError = `${response.status} ${response.statusText}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const elapsed = now() - start;
    onProgress({ attempts, elapsed, lastSha, lastError });
    if (elapsed >= timeoutMs) {
      return { ok: false, sha: lastSha, error: lastError, attempts, waitedMs: elapsed };
    }
    await sleep(sleepMs);
  }
}

/** Build, gate, deploy, and confirm one exact Worker generation. */
export async function deployControlPlane({ targetEnv = "staging", env = process.env } = {}) {
  execFileSync("pnpm", ["-w", "build"], { cwd: root, stdio: "inherit", env });
  await preflightDeploy({ targetEnv, env });
  const sha = buildStamp(defaultGit, env);
  const id = deploymentId();
  const declared = parseBreakGlass(env.THWIP_BREAK_GLASS);
  const exception = exceptionStamp(declared, {
    branch: defaultGit("rev-parse", "--abbrev-ref", "HEAD"),
    head: defaultGit("rev-parse", "--short", "HEAD"),
    at: new Date().toISOString(),
  });
  execFileSync(
    "pnpm",
    [
      "--filter", "@thwip/control-plane", "exec", "wrangler",
      "deploy",
      "--env", targetEnv,
      "--var", `BUILD_SHA:${sha}`,
      "--var", `DEPLOYMENT_ID:${id}`,
      "--var", `DEPLOY_EXCEPTION:${exception}`,
    ],
    { cwd: root, stdio: "inherit", env },
  );
  const url = liveHealthUrl(targetEnv);
  const caveat = dirtyShaCaveat(sha);
  if (caveat !== null) console.warn(caveat);
  const result = await waitForBuildSha({
    url,
    expectedSha: sha,
    expectedDeploymentId: id,
    onProgress: ({ attempts, elapsed, lastSha, lastError }) => {
      const seen = lastError ? `error: ${lastError}` : `serving ${lastSha ?? "no build SHA"}`;
      console.log(`[${Math.round(elapsed / 1000)}s] attempt ${attempts}: ${seen}`);
    },
  });
  if (!result.ok) {
    throw new Error(
      `Refusing to call this deployed: ${url} ${result.error ? `could not be read (${result.error})` : `still serves ${result.sha ?? "no build SHA"}`}`,
    );
  }
  console.log(`confirmed: ${url} serves ${sha} as deployment ${id}`);
}
