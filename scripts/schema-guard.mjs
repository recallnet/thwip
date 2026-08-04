/**
 * Whether the database is ready for the code about to be deployed.
 *
 * `deploy:staging` builds first so a package cannot ship its previous self, and
 * `predeploy.mjs` refuses a checkout behind origin/main so a deploy cannot
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
import { readFileSync, readdirSync } from "node:fs";

/** The two orders a migration may declare. */
export const DEPLOY_ORDERS = ["before-worker", "after-worker"];

/**
 * Only the machine-readable token counts. Prose about ordering is welcome under
 * it, and 0021's header already talks about 0018's opposite order, so anything
 * that scanned the paragraph for "before" or "after" would read the wrong one.
 */
const HEADER = /^--[ \t]*DEPLOY ORDER:[ \t]*(before-worker|after-worker)\b/m;

export function parseDeployOrder(sql) {
  const match = HEADER.exec(sql);
  return match === null ? null : match[1];
}

export function readMigrations(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, order: parseDeployOrder(readFileSync(`${dir}/${name}`, "utf8")) }));
}

/** Migrations that never said which side of the deploy they belong on. */
export function undeclaredMigrations(migrations) {
  return migrations.filter((migration) => migration.order === null).map((migration) => migration.name);
}

/** Unapplied migrations the code being deployed needs already in place. */
export function blockingMigrations(migrations, unapplied) {
  const pending = new Set(unapplied);
  return migrations
    .filter((migration) => migration.order === "before-worker" && pending.has(migration.name))
    .map((migration) => migration.name);
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

export function formatSchemaRefusal(blockers, env) {
  return [
    `Refusing: ${blockers.length} migration(s) the code needs are not in the ${env} database.`,
    ...blockers.map((name) => `  ${name}`),
    "",
    "Deploying now puts a Worker live that reads tables which do not exist, and every",
    "request on that path answers 500. Apply them, then deploy:",
    "",
    `  pnpm --filter @thwip/control-plane run migrate:${env}`,
    "",
    "That command is the one place a person administers this database, and it needs a",
    "credential a deploy does not. See docs/production-access.md.",
  ].join("\n");
}
