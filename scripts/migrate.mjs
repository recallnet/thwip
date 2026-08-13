/**
 * Apply migrations only when their declared deploy order makes the operation safe.
 *
 * Wrangler applies every pending migration visible in the checkout. It cannot
 * select `before-worker` or `after-worker`, so a tree containing both phases is
 * ambiguous: one phase belongs before a deploy and the other after it. This is
 * the guard between that all-or-nothing command and the live database. The
 * command also requires a separate short-lived migration token and a literal
 * acknowledgement that staging is the live database behind thwip.ai.
 */
import { execFileSync } from "node:child_process";
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

export function migrationPlan(migrations, applied) {
  const pendingNames = new Set(unappliedAgainst(migrations, applied));
  const pending = migrations.filter((migration) => pendingNames.has(migration.name));
  const before = pending.filter((migration) => migration.order === "before-worker").map((migration) => migration.name);
  const after = pending.filter((migration) => migration.order === "after-worker").map((migration) => migration.name);

  if (pending.length === 0) return { kind: "current", before, after };
  if (before.length > 0 && after.length > 0) return { kind: "mixed", before, after };
  return { kind: before.length > 0 ? "before-worker" : "after-worker", before, after };
}

export function formatMixedPhaseRefusal(plan, env) {
  const ordered = [
    ...plan.before.map((name) => ({ name, order: "before-worker" })),
    ...plan.after.map((name) => ({ name, order: "after-worker" })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return [
    `Refusing: ${env} has pending migrations on both sides of a Worker deploy.`,
    "",
    "Pending in repository order:",
    ...ordered.map(({ name, order }) => `  ${order.padEnd(13)} ${name}`),
    "",
    "Wrangler applies every pending migration in the checkout, so running it here",
    "would put at least one of these phases on the wrong side of its Worker.",
    "",
    "Use reviewed intermediate commits to expose one pending phase at a time, in",
    "migration order. For a before-worker batch: migrate, then deploy that commit.",
    "For an after-worker batch: deploy that commit, then migrate. Repeat until this",
    "tree has no mixed pending set. Do not bypass this with raw wrangler.",
  ].join("\n");
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
  if (plan.kind === "mixed") throw new Error(formatMixedPhaseRefusal(plan, env));

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
  }

  const names = plan.kind === "before-worker" ? plan.before : plan.after;
  log(`applying ${names.length} ${plan.kind} migration(s) to ${env}: ${names.join(", ")}`);
  run("wrangler", ["d1", "migrations", "apply", database, "--env", env, "--remote"], {
    env: identity.wranglerEnv,
  });
  return plan;
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
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const run = (command, args, options) => execFileSync(command, args, { stdio: "inherit", ...options });

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
    await applyMigrations({
      env,
      database,
      migrations: readMigrations(migrationsDir),
      fetchImpl: fetch,
      build: () => buildStamp(git),
      identity: { wranglerEnv: wranglerEnvironment(process.env, credential) },
      run,
    });
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
