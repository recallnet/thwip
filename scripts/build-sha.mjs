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
 */

export function buildStamp(git) {
  const head = git("rev-parse", "--short=12", "HEAD");
  const dirty = git("status", "--porcelain").length > 0;
  return dirty ? `${head}-dirty` : head;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { execFileSync } = await import("node:child_process");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  process.stdout.write(buildStamp(git));
}
