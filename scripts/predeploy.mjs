/**
 * Say what is about to be deployed, and refuse the two mistakes I actually made.
 *
 * A deploy takes the working tree, not a branch or a tag, so deploying from a
 * checkout that is missing commits silently reverts the running worker. That
 * happened twice. Confirm-from-facts vanished from staging because I had switched
 * branches. Later a fix that moved queue reads off the Durable Object was
 * deployed, verified working, and then reverted by the next deploy from a branch
 * cut before it, which took the whole queue down for hours.
 *
 * Being level with origin/main does not make a branch safe to deploy. Every open
 * branch carrying deployed work is invisible to that check, so this also names
 * what a non-main deploy is about to drop.
 *
 * The third mistake is not a git one and is why `deploy:staging` builds first.
 * A deploy bundles each package's built output, not its source, so a package
 * left unbuilt ships the previous version of itself. That put a worker live
 * whose protocol did not know a record kind the same commit had added, and the
 * queue — correctly — refused to sign anything and stopped merging.
 * The fourth mistake is the database. Code shipped against a schema that had
 * not been migrated: 0020 and 0021 sat unapplied on staging while the Worker
 * reading their tables was live, and `/authorize` under the `fresh` profile
 * answered 500 for four deploys. Each migration now declares which side of the
 * deploy it belongs on, and the block below refuses while one the code needs is
 * still pending. See `scripts/schema-guard.mjs` for why that is a declaration
 * rather than a rule.
 *
 * That check used to shell `wrangler d1 migrations list --remote`, which made
 * deploying and administering the database the same authority: a contributor
 * could not be given one without the other. It asks the live Worker instead, at
 * `/v1/schema`, and applying a migration is now `migrate:staging` under a
 * separate credential. See `docs/production-access.md`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { deployIdentity, liveSchemaUrl } from "./deploy-identity.mjs";
import {
  blockingMigrations,
  formatSchemaRefusal,
  readMigrations,
  unappliedAgainst,
  undeclaredMigrations,
} from "./schema-guard.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const head = git("rev-parse", "--short", "HEAD");
const dirty = git("status", "--porcelain").length > 0;

let behind = "0";
try {
  git("fetch", "--quiet", "origin", "main");
  behind = git("rev-list", "--count", "HEAD..origin/main");
} catch {
  behind = "?";
}

console.log(`deploying ${branch}@${head}${dirty ? " (uncommitted changes)" : ""}, ${behind} commit(s) behind origin/main`);

const identity = deployIdentity(process.env);
console.log(identity.note);
if (identity.refusal !== null) {
  console.error(`\n${identity.refusal}`);
  process.exit(1);
}

const allow = process.env.THWIP_DEPLOY_ANYWAY === "1";
if (behind !== "0" && behind !== "?" && !allow) {
  console.error(
    `\nRefusing: this checkout is missing ${behind} commit(s) that are on origin/main, so deploying it would\n` +
      `revert whatever those commits changed. Rebase, or set THWIP_DEPLOY_ANYWAY=1 if that is genuinely intended.`,
  );
  process.exit(1);
}

// Deploying anything but main overwrites the running worker with one branch's
// view of the world. Every other open branch's deployed work goes with it, and
// nothing about that is visible in the diff being deployed.
if (branch !== "main") {
  let others = [];
  try {
    others = git("branch", "-r", "--no-merged", "HEAD", "--format=%(refname:short)")
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b.length > 0 && b !== "origin/HEAD" && b !== "origin/main");
  } catch {
    others = [];
  }

  console.warn(`\nDeploying ${branch}, not main. The running worker becomes exactly this tree.`);
  if (others.length > 0) {
    console.warn(`Work on these branches is not in it and will be reverted if it is currently deployed:`);
    for (const b of others.slice(0, 20)) console.warn(`  ${b}`);
    if (others.length > 20) console.warn(`  ... and ${others.length - 20} more`);
  }
  if (!allow) {
    console.error(
      `\nRefusing: deploy from main so the worker matches what has been reviewed and merged.\n` +
        `Set THWIP_DEPLOY_ANYWAY=1 to deploy this branch anyway, having read the list above.`,
    );
    process.exit(1);
  }
}

// --- The database the code is about to run against -------------------------

const envArgIndex = process.argv.indexOf("--env");
const targetEnv = envArgIndex === -1 ? "staging" : (process.argv[envArgIndex + 1] ?? "staging");
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const migrations = readMigrations(migrationsDir);

const undeclared = undeclaredMigrations(migrations);
if (undeclared.length > 0) {
  console.error(
    `\nRefusing: these migrations do not say which side of the deploy they belong on:\n` +
      undeclared.map((name) => `  ${name}`).join("\n") +
      `\n\nAdd "-- DEPLOY ORDER: before-worker" or "-- DEPLOY ORDER: after-worker" as the first line.`,
  );
  process.exit(1);
}

// Asked of the Worker, not of wrangler.
//
// This used to shell `wrangler d1 migrations list --remote`, which meant the
// deploy gate needed a credential that could also rewrite the schema, and so
// deploying and administering the database were one authority. The Worker holds
// the binding already and `/v1/schema` says what it has, so the check is an
// unauthenticated HTTP read and a deploy needs no database permission at all.
// Applying migrations is `migrate:staging` now, run deliberately by whoever does
// hold that authority. See docs/production-access.md.
const schemaUrl = liveSchemaUrl(targetEnv);
let unapplied = null;
try {
  const response = await fetch(schemaUrl, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    console.error(
      `\nRefusing: ${schemaUrl} answered 404, so the live Worker predates the endpoint this gate reads.\n` +
        `Deploy once with THWIP_DEPLOY_ANYWAY=1 to put it there, then this check works from now on.`,
    );
    process.exit(allow ? 0 : 1);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const body = await response.json();
  // A body without the field is not an empty list of migrations. Reading it as
  // one is the exact shape of the failure this check was added for.
  unapplied = Array.isArray(body.applied) ? unappliedAgainst(migrations, body.applied) : null;
} catch (error) {
  unapplied = null;
  console.error(`\nCould not ask ${targetEnv} which migrations it has: ${error.message.split("\n")[0]}`);
}

if (unapplied === null) {
  // An unreadable answer is not a clean one.
  if (!allow) {
    console.error(
      `\nRefusing: ${schemaUrl} could not be read, so nothing here knows whether the schema\n` +
        `is ahead of or behind this code. Check the live Worker is up, or set THWIP_DEPLOY_ANYWAY=1.`,
    );
    process.exit(1);
  }
} else {
  const blockers = blockingMigrations(migrations, unapplied);
  if (blockers.length > 0 && !allow) {
    console.error(`\n${formatSchemaRefusal(blockers, targetEnv)}`);
    process.exit(1);
  }
  const deferred = unapplied.filter((name) => !blockers.includes(name));
  console.log(
    `schema: ${targetEnv} is ${unapplied.length === 0 ? "level with this tree" : `missing ${unapplied.length} migration(s)`}` +
      (deferred.length > 0 ? `, ${deferred.length} of which apply after this deploy: ${deferred.join(", ")}` : ""),
  );
}
