/**
 * Apply migrations only when their declared deploy order makes the operation safe.
 *
 * Wrangler applies every pending migration visible in its configured directory.
 * This command exposes only the next contiguous deploy phase, so one reviewed
 * tree may safely carry the additive migration, its Worker, and the finishing
 * migration without applying both sides of the deploy at once. It also requires
 * a separate short-lived migration token and a literal acknowledgement that
 * staging is the live database behind thwip.ai.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStamp,
  d1CredentialFromEnv,
  deployControlPlane,
  liveD1Target,
  liveHealthUrl,
  liveSchemaUrl,
  liveTargetRefusal,
  preflightD1Credential,
  tokenAcceptance,
  validDeploymentId,
  verifyD1CredentialCleared,
  wranglerEnvironment,
} from "./control-plane-core.mjs";
import {
  liveMigrationState,
  migrationReleaseState,
  migrationTrackRefusal,
  missingMigrationFiles,
  readMigrations,
  undeclaredMigrations,
} from "./migration-core.mjs";

const PROJECT_LIFECYCLE_FINISH_MIGRATION = "0031_finish_github_repository_lifecycle.sql";
const PROJECT_LIFECYCLE_REOPEN_MIGRATION = "0034_reopen_after_project_lifecycle.sql";
const PROJECT_LIFECYCLE_COMPATIBILITY_WINDOW_MS = 60 * 60_000;
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function migrationPlan(migrations, applied) {
  return migrationReleaseState(migrations, applied);
}

async function readJson(fetchImpl, url, description) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing: could not read ${description} at ${url}: ${message.split("\n")[0]}`);
  }
  if (!response.ok) {
    throw new Error(`Refusing: ${description} at ${url} answered ${response.status} ${response.statusText}`.trim());
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Refusing: ${description} at ${url} did not return JSON.`);
  }
}

/**
 * Dependency injection keeps every refusal test away from the live database.
 * The CLI below is the only caller that supplies Wrangler as `run`.
 */
export async function applyMigrations({
  env,
  database,
  migrations,
  fetchImpl,
  build,
  canonicalBuild = build,
  identity,
  run,
  log = console.log,
}) {
  if (identity === null || identity === undefined) {
    throw new Error("Refusing: no explicit D1 migration identity was preflighted.");
  }
  const undeclared = undeclaredMigrations(migrations);
  if (undeclared.length > 0) {
    throw new Error(
      [
        "Refusing: these migrations are absent from the shared release model:",
        ...undeclared.map((name) => `  ${name}`),
      ].join("\n"),
    );
  }

  const schemaUrl = liveSchemaUrl(env);
  const schema = await readJson(fetchImpl, schemaUrl, `${env} schema`);
  const live = liveMigrationState(schema);
  if (live === null) {
    throw new Error(`Refusing: ${schemaUrl} did not return an applied migration filename list.`);
  }
  const trackRefusal = migrationTrackRefusal(migrations, live.track);
  if (trackRefusal !== null) throw new Error(`Refusing: ${trackRefusal}.`);

  const plan = migrationPlan(migrations, live.applied);
  if (plan.outOfOrderApplied.length > 0) {
    throw new Error(
      [
        "Refusing: the live migration ledger is not a valid prefix of the shared release model.",
        "These migrations are recorded after an earlier known migration that is still missing:",
        ...plan.outOfOrderApplied.map((name) => `  ${name}`),
      ].join("\n"),
    );
  }
  if (plan.kind === "current") {
    log(`schema: ${env} is level with this tree; nothing to apply.`);
    return plan;
  }
  const expectedBuild = build();
  if (expectedBuild.endsWith("-dirty")) {
    throw new Error(
      `Refusing: migrations require a clean checkout, and this tree is ${expectedBuild}.`,
    );
  }
  const canonical = canonicalBuild();
  if (expectedBuild !== canonical) {
    throw new Error(
      [
        "Refusing: migrations require the exact current canonical main checkout.",
        `  checkout:    ${expectedBuild}`,
        `  origin/main: ${canonical}`,
        "Fetch origin/main and run from that clean commit.",
      ].join("\n"),
    );
  }
  if (plan.kind === "after-worker") {
    const healthUrl = liveHealthUrl(env);
    const health = await readJson(fetchImpl, healthUrl, `${env} Worker health`);
    if (health.buildSha !== expectedBuild) {
      throw new Error(
        [
          "Refusing: an after-worker migration can run only after this exact Worker is live.",
          `  checkout: ${expectedBuild}`,
          `  live:     ${typeof health.buildSha === "string" ? health.buildSha : "missing buildSha"}`,
          "Deploy this clean commit, confirm it, then run the migration again.",
        ].join("\n"),
      );
    }
    if (
      plan.after.includes(PROJECT_LIFECYCLE_FINISH_MIGRATION)
      && (
        typeof health.projectLifecycle?.workerActivatedAt !== "string"
        || !Number.isFinite(Date.parse(health.projectLifecycle.workerActivatedAt))
        || Date.parse(health.projectLifecycle.workerActivatedAt)
          > Date.now() - PROJECT_LIFECYCLE_COMPATIBILITY_WINDOW_MS
        || health.projectLifecycle?.maintenanceMode !== false
        || health.projectLifecycle?.backfillReady !== true
      )
    ) {
      throw new Error(
        [
          "Refusing: the in-place lifecycle migration is not ready.",
          "Migration 0031 requires the exact lifecycle-aware Worker to have served for at least one hour,",
          "maintenanceMode=false, and the bounded project-id backfill to report backfillReady=true.",
          "No database, bucket, or GitHub App key rotation is required.",
        ].join("\n"),
      );
    }
    if (
      plan.after.includes(PROJECT_LIFECYCLE_REOPEN_MIGRATION)
      && (
        health.schema?.capabilities?.lifecycleFinished !== true
        || health.schema?.capabilities?.privateAgentFeedback !== true
        || health.schema?.capabilities?.verifierProtocolV3 !== true
        || health.schema?.phase !== "after-worker"
        || !health.schema?.selected?.includes(PROJECT_LIFECYCLE_REOPEN_MIGRATION)
        || health.projectLifecycle?.workerBuildSha !== expectedBuild
        || !validDeploymentId(health.projectLifecycle?.workerDeploymentId)
        || !validDeploymentId(health.projectLifecycle?.verifierV3PredeployId)
        || health.projectLifecycle.workerDeploymentId === health.projectLifecycle.verifierV3PredeployId
        || health.projectLifecycle?.maintenanceMode !== true
        || health.projectLifecycle?.backfillReady !== true
        || typeof health.projectLifecycle?.destructiveSchemaReadyAt !== "string"
        || health.projectLifecycle?.cleanupReady !== true
      )
    ) {
      throw new Error(
        [
          "Refusing: the lifecycle schema is not ready to reopen traffic.",
          "Migration 0034 requires canonical main to report maintenanceMode=true, its own build SHA,",
          "and a deployment generation different from the one migration 0033 snapshotted,",
          "complete backfill, the 0031 cleanup marker, and the 0032/0033 capabilities.",
          "Keep maintenance active, finish the guarded migration phases, deploy this exact build, then retry.",
        ].join("\n"),
      );
    }
  }

  const names = plan.kind === "before-worker" ? plan.before : plan.after;
  log(`applying ${names.length} ${plan.kind} migration(s) to ${env}: ${names.join(", ")}`);
  if (plan.blockedBehindBarrier.length > 0) {
    log(
      `blocked behind ${plan.barrier?.name ?? "the next after-worker barrier"}: `
      + plan.blockedBehindBarrier.join(", "),
    );
  }
  run(names);
  return plan;
}

/**
 * Give Wrangler only the contiguous phase selected above.
 *
 * Wrangler has no migration-file selector. A temporary config and migration
 * directory make the selected filenames the complete visible set, while D1's
 * normal migration table still records their real names. The next invocation
 * reads `/v1/schema` again before exposing the next phase.
 */
export function selectedMigrationConfig(source, env, database) {
  const parsed = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  const original = parsed.env?.[env]?.d1_databases?.find((entry) => entry.binding === "DB");
  if (original === undefined || original.database_name !== database) {
    throw new Error(`wrangler.jsonc binds no ${database} database for --env ${env}`);
  }
  return {
    name: "thwip-migration-phase",
    compatibility_date: parsed.compatibility_date,
    env: {
      [env]: {
        d1_databases: [{ ...original, migrations_dir: "migrations" }],
      },
    },
  };
}

export function applySelectedMigrationFiles({
  names,
  env,
  database,
  migrationsDir,
  configPath,
  wranglerEnv,
  workspaceRoot = REPOSITORY_ROOT,
  execute = execFileSync,
}) {
  const temporary = mkdtempSync(join(tmpdir(), "thwip-migration-phase-"));
  try {
    const selectedDir = join(temporary, "migrations");
    mkdirSync(selectedDir);
    for (const name of names) copyFileSync(join(migrationsDir, name), join(selectedDir, name));

    const config = selectedMigrationConfig(readFileSync(configPath, "utf8"), env, database);
    const temporaryConfig = join(temporary, "wrangler.json");
    writeFileSync(temporaryConfig, JSON.stringify(config));
    execute(
      "pnpm",
      [
        "--dir", workspaceRoot,
        "--filter", "@thwip/control-plane", "exec", "wrangler",
        "d1", "migrations", "apply", database, "--env", env, "--remote", "--config", temporaryConfig,
      ],
      { stdio: "inherit", cwd: temporary, env: wranglerEnv },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const WRITES = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA|ATTACH|REPLACE|TRUNCATE|VACUUM|REINDEX|DETACH|BEGIN|COMMIT|ROLLBACK)\b/i;
const READS = /^\s*(SELECT|WITH|EXPLAIN)\b/i;

/** Why a D1 statement cannot run through the bounded read path. */
export function refuse(statement) {
  const sql = statement.trim();
  if (sql.length === 0) return "Nothing to run.";
  const body = sql.endsWith(";") ? sql.slice(0, -1) : sql;
  if (body.includes(";")) return "Refusing: one statement at a time.";
  const write = WRITES.exec(body);
  if (write !== null) return `Refusing: this statement contains ${write[1].toUpperCase()}, and this path only reads.`;
  return READS.test(body) ? null : "Refusing: a read starts with SELECT, WITH or EXPLAIN.";
}

export function commandFor(statement, { database, env }) {
  return ["d1", "execute", database, "--env", env, "--remote", "--json", "--command", statement.trim()];
}

export function readDiagnostic(statement, target) {
  const digest = createHash("sha256").update(statement.trim()).digest("hex");
  const hostname = new URL(target.origin).hostname;
  return `reading ${target.databaseName} (${target.env}, live at ${hostname}); statement sha256:${digest}`;
}

export function executeRead(run, argv, env) {
  try {
    run(
      "pnpm",
      ["--filter", "@thwip/control-plane", "exec", "wrangler", ...argv],
      { stdio: ["ignore", "inherit", "inherit"], env },
    );
  } catch {
    throw new Error("The live D1 read failed. Wrangler wrote any available details above; the SQL was not repeated.");
  }
}

function argument(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

async function migrate(args) {
  const env = argument(args, "--env", "staging");
  const database = argument(args, "--database");
  const confirmLive = argument(args, "--confirm-live");
  if (database === null) {
    throw new Error("Refusing: control-plane migrate requires --database <name>.");
  }

  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

  const target = liveD1Target(env);
  if (database !== target.databaseName) {
    throw new Error(`Refusing: --database must be ${target.databaseName}, the DB binding for --env ${env}.`);
  }
  const targetRefusal = liveTargetRefusal(target, confirmLive);
  if (targetRefusal !== null) throw new Error(targetRefusal);
  const selected = d1CredentialFromEnv(process.env, "migration");
  if (selected.refusal !== null) throw new Error(selected.refusal);
  const credential = selected.credential;
  const report = await preflightD1Credential({ fetchImpl: fetch, credential, target });
  console.log(`D1 migration identity is active for ${report.target} until ${report.expiresOn}. No application rows were read.`);
  const wranglerEnv = wranglerEnvironment(process.env, credential);
  const migrations = readMigrations(migrationsDir);
  const missing = missingMigrationFiles(migrations);
  if (missing.length > 0) {
    throw new Error(`Refusing: the shared release model names missing SQL files:\n${missing.map((name) => `  ${name}`).join("\n")}`);
  }
  git("fetch", "--quiet", "origin", "main");
  await applyMigrations({
    env,
    database,
    migrations,
    fetchImpl: fetch,
    build: () => buildStamp(git),
    canonicalBuild: () => git("rev-parse", "origin/main"),
    identity: { wranglerEnv },
    run: (names) => applySelectedMigrationFiles({ names, env, database, migrationsDir, configPath, wranglerEnv }),
  });
}

async function d1Read(args) {
  const env = argument(args, "--env");
  const confirmation = argument(args, "--confirm-live");
  const statement = args.find((value, index) => !value.startsWith("--") && !["--env", "--confirm-live"].includes(args[index - 1]));
  if (env === null || statement === undefined) {
    throw new Error('usage: control-plane d1-read --env staging --confirm-live thwip.ai "SELECT ..."');
  }
  const refusal = refuse(statement);
  if (refusal !== null) throw new Error(refusal);
  const target = liveD1Target(env);
  const targetRefusal = liveTargetRefusal(target, confirmation);
  if (targetRefusal !== null) throw new Error(targetRefusal);
  const selected = d1CredentialFromEnv(process.env, "read");
  if (selected.refusal !== null) throw new Error(selected.refusal);
  const credential = selected.credential;
  const report = await preflightD1Credential({ fetchImpl: fetch, credential, target });
  console.error(`${readDiagnostic(statement, target)}; token expires ${report.expiresOn}`);
  executeRead(
    execFileSync,
    commandFor(statement, { database: target.databaseName, env }),
    wranglerEnvironment(process.env, credential),
  );
}

async function d1Token(args) {
  const [action] = args;
  const kind = argument(args, "--kind");
  if (action === "verify-cleared") {
    verifyD1CredentialCleared(process.env, kind);
    console.log("No role-specific D1 credential remains in this shell.");
    return;
  }
  if (action === "verify-revoked") {
    const selected = d1CredentialFromEnv(process.env, kind);
    if (selected.refusal !== null) throw new Error(selected.refusal);
    const status = await tokenAcceptance({
      fetchImpl: fetch,
      token: selected.credential.token,
      accountId: selected.credential.accountId,
    });
    if (status.accepted) throw new Error("Refusing: Cloudflare still accepts this D1 token. Delete it, then check again.");
    console.log("Cloudflare no longer accepts the D1 token. Clear it from this shell now.");
    return;
  }
  throw new Error("usage: control-plane.mjs d1-token verify-revoked|verify-cleared --kind read|migration");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "deploy") return deployControlPlane({ targetEnv: argument(args, "--env", "staging") });
  if (command === "migrate") return migrate(args);
  if (command === "d1-read") return d1Read(args);
  if (command === "d1-token") return d1Token(args);
  throw new Error("usage: control-plane.mjs deploy|migrate|d1-read|d1-token [options]");
}

export function invokedAsMain(argvPath, moduleUrl = import.meta.url) {
  return argvPath === fileURLToPath(moduleUrl);
}

if (invokedAsMain(process.argv[1])) {
  main().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
