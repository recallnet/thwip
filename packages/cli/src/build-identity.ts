/**
 * Which build of thwip is running, and does it belong here.
 *
 * One machine had a single `thwip` on PATH, symlinked into one worktree. Every
 * agent in every other worktree ran that build whatever branch they were on. A
 * change to the CLI was never the code being exercised, and what the CLI did
 * depended on when that one worktree was last compiled. The pull-request bug in
 * ship.ts survived a day of use that way: the runs that hit it were not running
 * the code anybody was reading.
 *
 * A symlink on somebody's machine is not this repository's to move. A build
 * standing in another checkout now stops and names the checkout-local command.
 * A warning still let an agent ship with code from the wrong worktree, which is
 * the failure this check exists to prevent.
 */

import { dirname, join, sep } from "node:path";

export interface BuildIdentity {
  /** From packages/cli/package.json when the build was stamped. */
  readonly version: string;
  /** The commit the build was made from, "-dirty" when the tree was not clean. */
  readonly commit: string;
  /** The file node is actually executing. */
  readonly mainPath: string;
}

/** Where a thwip build lives inside a checkout. Nowhere else counts. */
const CLI_PACKAGE = join("packages", "cli");

/**
 * The nearest enclosing checkout that builds its own thwip, or nothing.
 *
 * `exists` is injected so the walk is testable without a filesystem. A worktree
 * carries `.git` as a file rather than a directory, so only presence is asked
 * about; a check for a directory would find nothing in every worktree, which is
 * precisely where this matters.
 */
export function findCliCheckout(startDir: string, exists: (path: string) => boolean): string | null {
  let dir = startDir;
  for (;;) {
    if (exists(join(dir, ".git")) && exists(join(dir, CLI_PACKAGE, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * One line naming the mismatch and the safe command, or nothing when the
 * checkout selected its own build.
 */
export function buildMismatchFailure(input: {
  runningMainPath: string;
  checkoutRoot: string | null;
  identity: { version: string; commit: string };
}): string | null {
  const { runningMainPath, checkoutRoot, identity } = input;
  if (checkoutRoot === null) return null;

  // The separator is what makes this a path test rather than a string test.
  // Without it /repos/thwip-old answers to /repos/thwip and the warning that
  // matters most stays silent.
  if (runningMainPath.startsWith(join(checkoutRoot, CLI_PACKAGE) + sep)) return null;

  return (
    `[thwip] running ${runningMainPath} (${identity.version}, ${identity.commit}) ` +
    `while standing in ${checkoutRoot}, which builds its own thwip. ` +
    "Stop and run the checkout build with `pnpm -w thwip <command>` instead."
  );
}

/**
 * Read the stamp the build wrote beside itself. `null` is a build made before
 * stamping existed, and it says so rather than borrowing the version of
 * whatever package.json happens to be nearby.
 */
export function parseBuildStamp(text: string | null, mainPath: string): BuildIdentity {
  const stamp = text === null ? null : parse(text);
  return {
    version: typeof stamp?.["version"] === "string" ? stamp["version"] : "unknown",
    commit: typeof stamp?.["commit"] === "string" ? stamp["commit"] : "unknown",
    mainPath,
  };
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function versionReport(identity: BuildIdentity): string {
  return `thwip ${identity.version}\ncommit ${identity.commit}\nrunning ${identity.mainPath}\n`;
}
