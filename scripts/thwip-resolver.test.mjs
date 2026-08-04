/**
 * The resolver decides which thwip a bare `thwip` runs.
 *
 * Every case here was a real state on the machine that prompted it: one `thwip`
 * on PATH pointing into one worktree's `dist`, so five agents in five worktrees
 * all ran the sixth one's build, and a bug in `thwip ship` survived a day of use
 * because nobody was running the code they were reading.
 *
 * Driven as a real process against real directories. A resolver tested through a
 * mock of the filesystem it walks is testing the mock.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const resolver = join(dirname(fileURLToPath(import.meta.url)), "thwip-resolver.sh");
const made = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "thwip-resolver-"));
  made.push(dir);
  return dir;
}

/** A directory that looks like a thwip checkout, with a build that announces itself. */
function checkout(root, { name = "@thwip/cli", built = true } = {}) {
  mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
  writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
  writeFileSync(join(root, "packages", "cli", "package.json"), JSON.stringify({ name }, null, 2));
  if (built) {
    writeFileSync(
      join(root, "packages", "cli", "dist", "main.js"),
      `console.log("checkout build ${root}", process.argv.slice(2).join(" "));\n`,
    );
  }
  return root;
}

/** A prepared release install, so no test ever reaches the network. */
function release(home) {
  const pkg = join(home, "node_modules", "@recallnet", "thwip");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "thwip.mjs"), `console.log("release build", process.argv.slice(2).join(" "));\n`);
  return home;
}

function run(cwd, releaseHome, args = []) {
  chmodSync(resolver, 0o755);
  return execFileSync(resolver, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, THWIP_RELEASE_HOME: releaseHome },
  }).trim();
}

afterEach(() => {
  for (const dir of made.splice(0)) execFileSync("rm", ["-rf", dir]);
});

describe("thwip-resolver", () => {
  it("runs the build of the checkout it is standing in", () => {
    const root = checkout(scratch());
    expect(run(root, release(scratch()))).toContain(`checkout build ${root}`);
  });

  it("runs that same build from anywhere inside the checkout", () => {
    const root = checkout(scratch());
    const deep = join(root, "packages", "cli", "dist");
    expect(run(deep, release(scratch()))).toContain(`checkout build ${root}`);
  });

  it("runs a different worktree's build when you stand in that worktree", () => {
    // The whole point. Two checkouts, one PATH entry, and each answers for
    // itself rather than for whichever one was linked.
    const a = checkout(scratch());
    const b = checkout(scratch());
    const home = release(scratch());
    expect(run(a, home)).toContain(`checkout build ${a}`);
    expect(run(b, home)).toContain(`checkout build ${b}`);
  });

  it("runs the published release outside any checkout", () => {
    expect(run(scratch(), release(scratch()))).toContain("release build");
  });

  it("runs the published release in a git repository that is not thwip", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "cli"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
    writeFileSync(join(root, "packages", "cli", "package.json"), JSON.stringify({ name: "@someone/cli" }));
    expect(run(root, release(scratch()))).toContain("release build");
  });

  it("passes arguments through untouched", () => {
    const root = checkout(scratch());
    expect(run(root, release(scratch()), ["queue", "status", "--json"])).toContain("queue status --json");
  });

  it("falls back to the release in an unbuilt checkout, and says which it used", () => {
    // A fresh clone of thwip has no build yet. Stopping here broke the first
    // command a new contributor ran. Falling back silently is the other half of
    // the trap, so the fallback is announced.
    const root = checkout(scratch(), { built: false });
    const out = execFileSync(resolver, [], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, THWIP_RELEASE_HOME: release(scratch()) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toContain("release build");
  });

  it("names pnpm build on stderr when it falls back from an unbuilt checkout", () => {
    const root = checkout(scratch(), { built: false });
    const result = spawnSync(resolver, [], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, THWIP_RELEASE_HOME: release(scratch()) },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("pnpm build");
  });

  it("never installs anything on its own, and says what to run instead", () => {
    // A network fetch on `thwip --version` is a side effect nobody asked for.
    // The resolver reports; scripts/install-thwip.mjs installs.
    const empty = scratch();
    const result = spawnSync(resolver, ["--version"], {
      cwd: scratch(),
      encoding: "utf8",
      env: { ...process.env, THWIP_RELEASE_HOME: empty },
    });
    expect(result.status).toBe(12);
    expect(result.stderr).toContain("npm install --prefix");
    expect(result.stderr).toContain(empty);
    expect(existsSync(join(empty, "node_modules"))).toBe(false);
  });
});
