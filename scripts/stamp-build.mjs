/**
 * Write the stamp that lets a thwip build say what it is.
 *
 * A machine here runs five to ten agent sessions across as many worktrees, and
 * one `thwip` on PATH served all of them from whichever worktree the symlink
 * pointed at. Nobody could tell, because the CLI could not say which build it
 * was. A bug in `thwip ship` survived a full day of use for exactly that
 * reason: the runs that hit it were not running the code anybody was reading.
 *
 * The stamp goes beside the build rather than into the source, so it covers
 * both ways the CLI is produced (tsc into dist, esbuild into dist-npm) and
 * nothing generated is ever committed.
 *
 * Usage: node scripts/stamp-build.mjs <output-dir>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStamp } from "./build-sha.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? join(root, "packages/cli/dist"));

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;

writeFileSync(
  join(outDir, "build-stamp.json"),
  `${JSON.stringify({ version, commit: buildStamp(git) }, null, 2)}\n`,
);
