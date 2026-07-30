/**
 * Say what is about to be deployed, and refuse the two mistakes I actually made.
 *
 * A deploy takes the working tree, not a branch or a tag, so deploying from a
 * checkout that is missing commits silently reverts the running worker. That
 * happened: confirm-from-facts vanished from staging because I had switched
 * branches. It cost several confusing round trips to notice.
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
