/**
 * Whether the database is ready for the code about to be deployed.
 *
 * `deploy:staging` builds first so a package cannot ship its previous self, and
 * The deploy command refuses a checkout behind origin/main so a deploy cannot
 * revert what is live. The database had neither. Migrations 0020 and 0021 were
 * never applied to staging while the Worker that reads `queue_runners` and
 * `queue_assignments` was deployed on top of them, so every `/authorize` under
 * the `fresh` profile answered `500 no such table: queue_runners`. Four deploys
 * went out that way. Nothing noticed, because the only repositories in the
 * queue run `fast`, which never touches those tables.
 *
 * The ordering is a per-migration fact, not a rule. Most migrations add
 * something the next Worker reads and have to land first. 0018 is the other
 * shape: it resolves a duplicate chain link and adds a unique index, and it
 * needed the Worker that catches the constraint to already be live, so applying
 * it first would have taken merges down. A blanket "always migrate first" would
 * have been wrong for it, and a blanket "never" is what happened here. So each
 * migration declares its own order in its header and this reads the answer.
 */
import { readdirSync } from "node:fs";

import {
  ALL_MIGRATION_RELEASES,
  BASELINE_MIGRATION_RELEASE,
  BASELINE_MIGRATION_RELEASES,
  LEGACY_MIGRATION_RELEASES,
  MIGRATION_RELEASES,
  evaluateMigrationReleases,
  migrationTrack,
} from "../packages/migration-plan/src/index.mjs";

export function readMigrations(dir) {
  const modeled = new Map(ALL_MIGRATION_RELEASES.map((migration) => [migration.name, migration]));
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const baseline = names.includes(BASELINE_MIGRATION_RELEASE.name);
  const legacy = names.some((name) => LEGACY_MIGRATION_RELEASES.some((migration) => migration.name === name));
  return names.map((name) => {
    // A directory may expose one starting track, never both. Mark the baseline
    // undeclared in a mixed directory so every existing caller fails closed.
    if (baseline && legacy && name === BASELINE_MIGRATION_RELEASE.name) return { name, phase: null };
    return modeled.get(name) ?? { name, phase: null };
  });
}

/** SQL files absent from the shared release model. */
export function undeclaredMigrations(migrations) {
  return migrations.filter((migration) => migration.phase === null).map((migration) => migration.name);
}

/** Modeled releases whose SQL file is absent from the checkout. */
export function missingMigrationFiles(migrations) {
  const files = new Set(migrations.map((migration) => migration.name));
  const model = files.has(BASELINE_MIGRATION_RELEASE.name)
    ? BASELINE_MIGRATION_RELEASES
    : MIGRATION_RELEASES;
  return model.filter((migration) => !files.has(migration.name)).map((migration) => migration.name);
}

/** Unapplied migrations the code being deployed needs already in place. */
export function blockingMigrations(migrations, unapplied) {
  const pending = new Set(unapplied);
  const applied = migrations.filter((migration) => !pending.has(migration.name)).map((migration) => migration.name);
  return evaluateMigrationReleases(migrations, applied).deployBlockers;
}

/** One evaluator for the migration command, deploy gate, and public Worker state. */
export function migrationReleaseState(migrations, applied) {
  return evaluateMigrationReleases(migrations, applied);
}

/** Parse the public `/v1/schema` envelope shared by deploy and migrate. */
export function liveMigrationState(value) {
  if (
    value === null
    || typeof value !== "object"
    || !Array.isArray(value.applied)
    || value.applied.some((name) => typeof name !== "string")
  ) return null;
  return { applied: value.applied, track: value.schema?.track };
}

/** Which supported starting track the checkout's SQL files describe. */
export function migrationFileTrack(migrations) {
  return migrationTrack(migrations.map((migration) => migration.name));
}

/** Refuse a live database whose durable starting track differs from this checkout. */
export function migrationTrackRefusal(migrations, liveTrack) {
  if (!["legacy", "baseline"].includes(liveTrack)) {
    return "the live schema did not identify a supported migration track";
  }
  const checkoutTrack = migrationFileTrack(migrations);
  return liveTrack === checkoutTrack
    ? null
    : `the live database uses the ${liveTrack} migration track, but this checkout exposes the ${checkoutTrack} track`;
}

/**
 * Migrations this tree carries that the database has not recorded.
 *
 * The database now says what it has rather than wrangler saying what is
 * missing, so the subtraction happens here. A name the database has and this
 * tree does not is somebody else's branch and not a blocker; reporting it would
 * refuse a deploy that is fine.
 */
export function unappliedAgainst(migrations, applied) {
  const have = new Set(applied);
  return migrations.filter((migration) => !have.has(migration.name)).map((migration) => migration.name);
}

export function formatSchemaRefusal(blockers, env, liveHostname) {
  return [
    `Refusing: ${blockers.length} migration(s) the code needs are not in the ${env} database.`,
    ...blockers.map((name) => `  ${name}`),
    "",
    "Deploying now puts a Worker live that reads tables which do not exist, and every",
    "request on that path answers 500. Apply them, then deploy:",
    "",
    `  pnpm --filter @thwip/control-plane run migrate:${env} -- --confirm-live ${liveHostname}`,
    "",
    "That command is the one place a person administers this database, and it needs a",
    "credential a deploy does not. See docs/production-access.md.",
  ].join("\n");
}
