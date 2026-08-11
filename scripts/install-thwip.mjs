/**
 * Install thwip so a fresh login shell can run it (issue #29).
 *
 * Developer setup used to finish with authentication done and keys enrolled and
 * nothing on PATH, so the documented next step was typing a path into somebody's
 * `dist` directory. That is not portable across shells, and it made every agent
 * invent its own wrapper.
 *
 * What this leaves behind:
 *
 *   ~/.local/bin/thwip                 the resolver from scripts/thwip-resolver.sh
 *   ~/.local/share/thwip/release/      the published release it falls back to
 *
 * Nothing is copied out of ~/.ssh or ~/.config/thwip; keys are GitHub's binding
 * and this does not touch them.
 *
 * Running it twice is the same as running it once. The PATH line is written at
 * most once because it is written with a marker and looked for by that marker,
 * and it is only written when asked: a shell configuration this repository
 * edited without consent is a machine somebody else owns.
 *
 * The last thing it does is check its own work. An installer that reports
 * success without running the command it installed is how the state in issue #29
 * happened in the first place.
 *
 * Usage: node scripts/install-thwip.mjs [--write-path] [--no-fetch]
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env["HOME"] ?? homedir();
const binDir = join(home, ".local", "bin");
const installed = join(binDir, "thwip");
const releaseHome = join(home, ".local", "share", "thwip", "release");
const bundle = join(releaseHome, "node_modules", "@recallnet", "thwip", "thwip.mjs");

const argv = process.argv.slice(2);
const writePath = argv.includes("--write-path");
const fetchAllowed = !argv.includes("--no-fetch");

const say = (text) => process.stdout.write(text + "\n");
const problems = [];

/* 1. The command itself. */
mkdirSync(binDir, { recursive: true });
try {
  // copyFileSync follows a destination symlink. The old installer therefore
  // overwrote a build inside another checkout instead of replacing the stale
  // bare command. Remove only this exact symlink before installing the managed
  // resolver; regular files remain the installer's normal update path.
  if (lstatSync(installed).isSymbolicLink()) unlinkSync(installed);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
copyFileSync(join(here, "thwip-resolver.sh"), installed);
chmodSync(installed, 0o755);
say(`installed ${installed}`);

/* 2. What it falls back to outside a checkout. */
if (existsSync(bundle)) {
  say(`release already installed at ${releaseHome}`);
} else if (fetchAllowed) {
  say(`fetching @recallnet/thwip into ${releaseHome}`);
  mkdirSync(releaseHome, { recursive: true });
  const npm = spawnSync("npm", ["install", "--prefix", releaseHome, "--no-fund", "--no-audit", "@recallnet/thwip"], {
    stdio: "inherit",
  });
  if (npm.status !== 0) problems.push(`npm install --prefix "${releaseHome}" @recallnet/thwip failed`);
} else {
  problems.push(`no release at ${releaseHome}. Run: npm install --prefix "${releaseHome}" @recallnet/thwip`);
}

/* 3. PATH, once, and only with consent. */
const currentPath = process.env["PATH"] ?? "";
const selectedBeforeResult = spawnSync("sh", ["-c", "command -v thwip"], {
  env: process.env,
  encoding: "utf8",
});
const selectedBefore = (selectedBeforeResult.stdout ?? "").trim();
const resolverSelected = selectedBefore === installed;
const MARKER = "# added by thwip installer";
const line = `export PATH="$HOME/.local/bin:$PATH" ${MARKER}`;

if (resolverSelected) {
  say(`${installed} is already the first thwip on PATH`);
} else if (writePath) {
  const rc = rcFile();
  const existing = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (existing.includes(MARKER)) {
    say(`${rc} already carries the PATH line`);
  } else {
    appendFileSync(rc, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${line}\n`);
    say(`added the PATH line to ${rc}; open a new shell for it`);
  }
} else {
  const selected = selectedBefore === "" ? "no thwip" : selectedBefore;
  say(`${installed} is not the first thwip on PATH (${selected}). Add this line to your shell profile, or re-run with --write-path:`);
  say(`  ${line}`);
}

/** The rc file of the shell that is running, not a guess about which one it is. */
function rcFile() {
  const shell = basename(process.env["SHELL"] ?? "zsh");
  if (shell === "bash") return join(home, ".bashrc");
  return join(home, ".zshrc");
}

/* 4. Check the work. Reporting success without this is the bug in issue #29. */
const pathForChecks = `${binDir}${delimiter}${currentPath}`;
const env = { ...process.env, PATH: pathForChecks, HOME: home };

checkSelectedCommand();
check("thwip --version", "thwip", ["--version"]);
check("thwip keys status", "thwip", ["keys", "status"]);

function check(label, command, args) {
  const result = spawnSync(command, args, { env, encoding: "utf8" });
  if (result.status === 0) {
    say(`ok   ${label}`);
    return;
  }
  const detail = (result.stderr ?? "").trim().split("\n")[0] ?? `exit ${result.status}`;
  say(`FAIL ${label}: ${detail}`);
  problems.push(`${label}: ${detail}`);
}

function checkSelectedCommand() {
  const result = spawnSync("sh", ["-c", "command -v thwip"], { env, encoding: "utf8" });
  const selected = (result.stdout ?? "").trim();
  if (result.status === 0 && selected === installed) {
    say("ok   command -v thwip");
    return;
  }
  const detail = selected === "" ? (result.stderr ?? "").trim() || `exit ${result.status}` : `selected ${selected}`;
  say(`FAIL command -v thwip: ${detail}`);
  problems.push(`command -v thwip: ${detail}`);
}

if (problems.length > 0) {
  process.stderr.write(`\nthwip is not installed and working yet:\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
  process.exit(1);
}

say("thwip is installed and answering");
