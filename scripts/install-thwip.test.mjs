/**
 * Installing thwip onto a machine that has never seen it (issue #29).
 *
 * The bar is a `thwip` a fresh login shell can run, verified before the
 * installer says it worked. Setup used to end with authentication done, keys
 * enrolled, and no command on PATH, so the documented next step was to type out
 * a path into somebody's `dist` directory.
 *
 * Every test here runs under a temporary HOME and a PATH that contains nothing
 * but the system directories, because the machine that has thwip working
 * already is the one environment that proves nothing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const installer = join(here, "install-thwip.mjs");
const made = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "thwip-install-"));
  made.push(dir);
  return dir;
}

/**
 * A HOME with a release already in place, so no test reaches the network. The
 * stub answers every command the installer verifies.
 */
function home({ withRelease = true, shell = "/bin/zsh" } = {}) {
  const dir = scratch();
  if (withRelease) {
    const pkg = join(dir, ".local", "share", "thwip", "release", "node_modules", "@recallnet", "thwip");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "thwip.mjs"),
      [
        "const arg = process.argv[2] ?? '';",
        "if (arg === '--version') console.log('thwip 9.9.9\\ncommit stub');",
        "else if (arg === 'keys') console.log('{\"registeredWithGithub\":true}');",
        "else console.log('stub ' + process.argv.slice(2).join(' '));",
      ].join("\n") + "\n",
    );
  }
  return { dir, shell };
}

function install(env, args = []) {
  return spawnSync("node", [installer, ...args], {
    encoding: "utf8",
    cwd: scratch(),
    env: {
      HOME: env.dir,
      SHELL: env.shell,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      ...env.extra,
    },
  });
}

afterEach(() => {
  for (const dir of made.splice(0)) execFileSync("rm", ["-rf", dir]);
});

describe("install-thwip", () => {
  it("leaves an executable thwip in the user-local bin directory", () => {
    const env = home();
    const result = install(env);
    const installed = join(env.dir, ".local", "bin", "thwip");
    expect(result.status).toBe(0);
    expect(existsSync(installed)).toBe(true);
    // Executable, or a fresh login shell finds a file it cannot run. Run from
    // outside any checkout, which is where the release is what should answer.
    const out = execFileSync(installed, ["--version"], {
      cwd: scratch(),
      encoding: "utf8",
      env: { ...process.env, HOME: env.dir },
    });
    expect(out).toContain("9.9.9");
  });

  it("verifies the command before reporting success", () => {
    const result = install(home());
    expect(result.stdout).toContain("command -v thwip");
    expect(result.stdout).toContain("thwip --version");
    expect(result.stdout).toContain("thwip keys status");
  });

  it("fails when a verification command fails, rather than reporting success", () => {
    // The point of the issue. Setup used to finish while nothing was runnable.
    const env = home();
    const bundle = join(
      env.dir,
      ".local/share/thwip/release/node_modules/@recallnet/thwip/thwip.mjs",
    );
    writeFileSync(bundle, "process.exit(3);\n");
    const result = install(env);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("thwip --version");
  });

  it("runs twice with the same result and no second PATH edit", () => {
    const env = home();
    const rc = join(env.dir, ".zshrc");
    writeFileSync(rc, "# existing\n");
    const first = install(env, ["--write-path"]);
    const afterFirst = readFileSync(rc, "utf8");
    const second = install(env, ["--write-path"]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(readFileSync(rc, "utf8")).toBe(afterFirst);
  });

  it("prints one line to paste when the bin directory is off PATH and consent was not given", () => {
    const env = home();
    const result = install(env);
    const lines = result.stdout.split("\n").filter((l) => l.includes("PATH=") && l.includes(".local/bin"));
    expect(lines).toHaveLength(1);
    expect(existsSync(join(env.dir, ".zshrc"))).toBe(false);
  });

  it("appends one guarded line to the shell's rc file when asked to", () => {
    const env = home();
    const result = install(env, ["--write-path"]);
    const rc = readFileSync(join(env.dir, ".zshrc"), "utf8");
    expect(result.status).toBe(0);
    expect(rc).toContain(".local/bin");
    expect(rc).toContain("thwip");
  });

  it("writes to the rc file of the shell that is running", () => {
    const env = home({ shell: "/bin/bash" });
    install(env, ["--write-path"]);
    expect(existsSync(join(env.dir, ".bashrc"))).toBe(true);
    expect(existsSync(join(env.dir, ".zshrc"))).toBe(false);
  });

  it("says nothing about PATH when the bin directory is already on it", () => {
    const env = home();
    env.extra = { PATH: `${join(env.dir, ".local", "bin")}:${dirname(process.execPath)}:/usr/bin:/bin` };
    const result = install(env, ["--write-path"]);
    expect(result.status).toBe(0);
    expect(existsSync(join(env.dir, ".zshrc"))).toBe(false);
  });

  it("stops with the command to run when no release is installed", () => {
    // It does not fetch. An installer that silently reaches the network is the
    // same surprise as a resolver that does.
    const env = home({ withRelease: false });
    const result = install(env, ["--no-fetch"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("npm install");
  });

  it("copies no private key anywhere", () => {
    const env = home();
    mkdirSync(join(env.dir, ".ssh"), { recursive: true });
    writeFileSync(join(env.dir, ".ssh", "id_ed25519"), "PRIVATE\n");
    install(env);
    const stray = spawnSync("grep", ["-rl", "PRIVATE", join(env.dir, ".local")], { encoding: "utf8" });
    expect(stray.stdout.trim()).toBe("");
  });

  it("installs the resolver, so the installed thwip prefers a checkout's own build", () => {
    const env = home();
    install(env);
    const root = scratch();
    mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
    writeFileSync(join(root, "packages", "cli", "package.json"), JSON.stringify({ name: "@thwip/cli" }));
    writeFileSync(join(root, "packages", "cli", "dist", "main.js"), `console.log("checkout build");\n`);
    chmodSync(join(env.dir, ".local", "bin", "thwip"), 0o755);
    const out = execFileSync(join(env.dir, ".local", "bin", "thwip"), [], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HOME: env.dir },
    });
    expect(out).toContain("checkout build");
  });
});
