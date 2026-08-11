/**
 * What commit is this build?
 *
 * `BUILD_SHA` was the literal string "dev" in every deployment. `/health`
 * reported it, so when a stale bundle broke merging on staging there was no way
 * to tell from outside which code was live. Worse, `app-proof-verification.ts`
 * uses it as `verifierVersion`, which is recorded in the proof: every proof
 * claimed it was judged by a verifier called "dev".
 *
 * A stamp that cannot say the tree was dirty is its own kind of lie, so a
 * working tree with uncommitted changes is marked as such rather than borrowing
 * the credibility of the commit it sits on.
 *
 * The automatic deploy is stricter. Its checkout has already passed the
 * canonical-main gate, and its public identity is the full GitHub workflow SHA.
 * Keep all of it: shortening that stamp would make the health check weaker than
 * the merge evidence the workflow just verified.
 */

import { deployCheckout } from "./deploy-checkout.mjs";

export function buildStamp(git, env = {}) {
  if (env.GITHUB_ACTIONS === "true") {
    const checkout = deployCheckout(
      {
        gitBranch: git("rev-parse", "--abbrev-ref", "HEAD"),
        headSha: git("rev-parse", "HEAD"),
        remoteMainSha: git("rev-parse", "origin/main"),
        dirty: git("status", "--porcelain").length > 0,
      },
      env,
    );
    if (checkout.refusal !== null) throw new Error(checkout.refusal);
    return env.GITHUB_SHA;
  }

  const head = git("rev-parse", "--short=12", "HEAD");
  const dirty = git("status", "--porcelain").length > 0;
  return dirty ? `${head}-dirty` : head;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { execFileSync } = await import("node:child_process");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  try {
    process.stdout.write(buildStamp(git, process.env));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
