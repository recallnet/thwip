import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installPushWarning, PUSH_WARNING_MARKER } from "./push-hook.js";

/**
 * Cut the throwaway repositories off from whoever is running the suite.
 *
 * The hook path comes from `git rev-parse --git-path`, which honours
 * `core.hooksPath`. A developer who sets that globally, which is how a shared
 * hook directory is normally configured, had every repository built here
 * resolve to their own `~/.config/git/hooks` instead of its own. The suite then
 * wrote a pre-push hook into it and cleaned up only the temporary directories,
 * so the file stayed, and every later run found an unmanaged hook and refused.
 *
 * These two variables are read by git itself, and the subprocesses started here
 * inherit them, so both the in-process calls and the spawned hook see them.
 */
beforeAll(() => {
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
});

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): { root: string; linked: string; sha: string } {
  const parent = mkdtempSync(join(tmpdir(), "thwip-push-warning-"));
  roots.push(parent);
  const root = join(parent, "root");
  const linked = join(parent, "linked");
  git(parent, "init", "-b", "main", root);
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "file.txt"), "one\n");
  git(root, "add", "file.txt");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", "first");
  git(root, "worktree", "add", "-b", "topic", linked);
  return { root, linked, sha: git(linked, "rev-parse", "HEAD") };
}

function fakeThwip(parent: string, exitCode: number): string {
  const bin = join(parent, `bin-${exitCode}`);
  execFileSync("mkdir", ["-p", bin]);
  const executable = join(bin, "thwip");
  writeFileSync(executable, `#!/bin/sh\nexit ${exitCode}\n`);
  chmodSync(executable, 0o755);
  return bin;
}

function runHook(
  hook: string,
  cwd: string,
  sha: string,
  bin: string,
  extraEnv: NodeJS.ProcessEnv = {},
  localRef = "refs/heads/topic",
) {
  return spawnSync(hook, [], {
    cwd,
    encoding: "utf8",
    input: `${localRef} ${sha} refs/heads/topic ${"0".repeat(40)}\n`,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ...extraEnv },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the optional pre-push proof warning", () => {
  it("installs once for all linked worktrees and updates its own hook", async () => {
    const repo = repository();
    const fromRoot = await installPushWarning(repo.root);
    const fromLinked = await installPushWarning(repo.linked);

    expect(fromRoot.status).toBe("installed");
    expect(fromLinked.status).toBe("updated");
    expect(fromLinked.path).toBe(fromRoot.path);
    expect(readFileSync(fromRoot.path, "utf8")).toContain(PUSH_WARNING_MARKER);
  });

  it("names the outgoing ref, exact commit, current checkout, remediation, and escape", async () => {
    const repo = repository();
    const installed = await installPushWarning(repo.root);
    const bin = fakeThwip(roots[0]!, 1);
    const result = runHook(installed.path, repo.linked, repo.sha, bin);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("refs/heads/topic");
    expect(result.stderr).toContain(repo.sha.slice(0, 12));
    expect(result.stderr).toContain(realpathSync(repo.linked));
    expect(result.stderr).toContain("thwip ship");
    expect(result.stderr).toContain("THWIP_ALLOW_UNPROVEN_PUSH=1");
    expect(result.stderr).toContain("this push is still allowed");
  });

  it("stays silent for an accepted proof and for the explicit escape", async () => {
    const repo = repository();
    const installed = await installPushWarning(repo.root);
    const passingBin = fakeThwip(roots[0]!, 0);
    const failingBin = fakeThwip(roots[0]!, 1);

    expect(runHook(installed.path, repo.linked, repo.sha, passingBin).stderr).toBe("");
    expect(
      runHook(installed.path, repo.linked, repo.sha, failingBin, {
        THWIP_ALLOW_UNPROVEN_PUSH: "1",
      }).stderr,
    ).toBe("");
  });

  it("ignores non-branch refs and never blocks their push", async () => {
    const repo = repository();
    const installed = await installPushWarning(repo.root);
    const bin = fakeThwip(roots[0]!, 1);
    const result = runHook(installed.path, repo.linked, repo.sha, bin, {}, "refs/tags/v1");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("refuses to overwrite an unmanaged pre-push hook", async () => {
    const repo = repository();
    const named = git(repo.root, "rev-parse", "--git-path", "hooks/pre-push");
    const hook = isAbsolute(named) ? named : resolve(repo.root, named);
    writeFileSync(hook, "#!/bin/sh\necho existing\n");

    await expect(installPushWarning(repo.linked)).resolves.toMatchObject({
      status: "refused",
      path: realpathSync(hook),
    });
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho existing\n");
  });
});
