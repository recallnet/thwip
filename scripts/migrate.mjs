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
import {
  d1CredentialFromEnv,
  liveTargetRefusal,
  preflightD1Credential,
  wranglerEnvironment,
} from "./d1-identity.mjs";
import { readMigrations, unappliedAgainst, undeclaredMigrations } from "./schema-guard.mjs";

const PROJECT_LIFECYCLE_FINISH_MIGRATION = "0031_finish_github_repository_lifecycle.sql";

export function migrationPlan(migrations, applied) {
  const pendingNames = new Set(unappliedAgainst(migrations, applied));
  const pending = migrations.filter((migration) => pendingNames.has(migration.name));
  if (pending.length === 0) return { kind: "current", before: [], after: [], deferred: [] };
  // Only one contiguous phase may move. A before/after pair in one reviewed
  // tree is safe when the first command exposes only the before files to
  // Wrangler, the Worker deploys, and the next command exposes only the after
  // files. Never skip an earlier phase to reach a later file.
  const kind = pending[0].order;
  const selected = pending.slice(0, pending.findIndex((migration) => migration.order !== kind) === -1
    ? pending.length
    : pending.findIndex((migration) => migration.order !== kind));
  const names = selected.map((migration) => migration.name);
  return {
    kind,
    before: kind === "before-worker" ? names : [],
    after: kind === "after-worker" ? names : [],
    deferred: pending.slice(selected.length).map((migration) => migration.name),
  };
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
        "Refusing: these migrations do not declare a deploy order:",
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
  if (plan.kind === "current") {
    log(`schema: ${env} is level with this tree; nothing to apply.`);
    return plan;
  }
  if (plan.kind === "after-worker") {
    const expectedBuild = build();
    if (expectedBuild.endsWith("-dirty")) {
      throw new Error(
        `Refusing: after-worker migrations require a clean checkout, and this tree is ${expectedBuild}.`,
      );
    }
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
        typeof health.projectLifecycle?.remoteCapabilitiesRetiredAt !== "string"
        || health.projectLifecycle?.remoteCapabilityEvidenceComplete !== true
        || health.projectLifecycle?.maintenanceMode !== true
        || health.projectLifecycle?.backfillReady !== true
      )
    ) {
      throw new Error(
        [
          "Refusing: the remote capability cutover has not been recorded.",
          "Migration 0031 removes compatibility objects that an already-started previous Worker may still use.",
          "Retire the old D1 database, R2 bucket binding, and GitHub App private key; record the reviewed evidence,",
          "then confirm /health reports maintenanceMode=true, remoteCapabilitiesRetiredAt,",
          "and remoteCapabilityEvidenceComplete=true plus backfillReady=true from the new D1 generation.",
        ].join("\n"),
      );
    }
  }

  const names = plan.kind === "before-worker" ? plan.before : plan.after;
  log(`applying ${names.length} ${plan.kind} migration(s) to ${env}: ${names.join(", ")}`);
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
    await applyMigrations({
      env,
      database,
      migrations: readMigrations(migrationsDir),
      fetchImpl: fetch,
      build: () => buildStamp(git),
      identity: { wranglerEnv },
      run,
    });
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
