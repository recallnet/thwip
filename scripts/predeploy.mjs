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
 */
import { execFileSync } from "node:child_process";

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
