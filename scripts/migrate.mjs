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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildStamp } from "./build-sha.mjs";
import { liveD1Target, liveHealthUrl, liveSchemaUrl } from "./deploy-identity.mjs";
import { validDeploymentId } from "./deployment-id.mjs";
import {
  d1CredentialFromEnv,
  liveTargetRefusal,
  preflightD1Credential,
  wranglerEnvironment,
} from "./d1-identity.mjs";
import {
  migrationReleaseState,
  missingMigrationFiles,
  readMigrations,
  undeclaredMigrations,
} from "./schema-guard.mjs";

const PROJECT_LIFECYCLE_FINISH_MIGRATION = "0031_finish_github_repository_lifecycle.sql";
const PROJECT_LIFECYCLE_REOPEN_MIGRATION = "0034_reopen_after_project_lifecycle.sql";
const PROJECT_LIFECYCLE_COMPATIBILITY_WINDOW_MS = 60 * 60_000;

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
  if (!Array.isArray(schema.applied) || schema.applied.some((name) => typeof name !== "string")) {
    throw new Error(`Refusing: ${schemaUrl} did not return an applied migration filename list.`);
  }

  const plan = migrationPlan(migrations, schema.applied);
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

export function applySelectedMigrationFiles({ names, env, database, migrationsDir, configPath, wranglerEnv }) {
  const temporary = mkdtempSync(join(tmpdir(), "thwip-migration-phase-"));
  try {
    const selectedDir = join(temporary, "migrations");
    mkdirSync(selectedDir);
    for (const name of names) copyFileSync(join(migrationsDir, name), join(selectedDir, name));

    const config = selectedMigrationConfig(readFileSync(configPath, "utf8"), env, database);
    const temporaryConfig = join(temporary, "wrangler.json");
    writeFileSync(temporaryConfig, JSON.stringify(config));
    execFileSync(
      "wrangler",
      ["d1", "migrations", "apply", database, "--env", env, "--remote", "--config", temporaryConfig],
      { stdio: "inherit", cwd: temporary, env: wranglerEnv },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = argument("--env", "staging");
  const database = argument("--database");
  const confirmLive = argument("--confirm-live");
  if (database === null) {
    console.error("Refusing: migrate.mjs requires --database <name>.");
    process.exit(1);
  }

  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

  try {
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
    console.log(
      `D1 migration identity is active for ${report.target} until ${report.expiresOn}. No application rows were read.`,
    );
    const wranglerEnv = wranglerEnvironment(process.env, credential);
    const run = (names) => applySelectedMigrationFiles({
      names,
      env,
      database,
      migrationsDir,
      configPath,
      wranglerEnv,
    });
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
      run,
    });
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
