import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTips, tryGit } from "./git.js";
import { forceArgs, planPush } from "./push-plan.js";

/**
 * The same path against real git: a real remote, a real amend, a real rejection.
 *
 * The unit tests decide from facts handed to them, and the facts are read from
 * git output that changes between versions. This is where the reading itself is
 * checked, and it is the exact sequence that ended in a stack trace twice while
 * the product was being demonstrated.
 */

let root = "";
let work = "";
let remote = "";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(join(cwd, file), body);
  sh(cwd, "add", file);
  sh(cwd, "-c", "commit.gpgsign=false", "commit", "-m", message);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "thwip-push-"));
  remote = join(root, "origin.git");
  work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
  execFileSync("git", ["clone", remote, work], { stdio: "ignore" });
  sh(work, "config", "user.email", "test@example.invalid");
  sh(work, "config", "user.name", "Test");
  commit(work, "a.txt", "one\n", "first");
  commit(work, "b.txt", "two\n", "second");
  sh(work, "push", "--set-upstream", "origin", "HEAD:refs/heads/main");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("pushing a branch whose tip the proof rewrote", () => {
  it("is rejected, recognized, and resolved with a lease naming the old tip", async () => {
    const before = sh(work, "rev-parse", "HEAD");
    // What attaching a proof does: same tree, same parents, new commit.
    sh(work, "-c", "commit.gpgsign=false", "commit", "--amend", "-m", "second\n\nThwip-Proof: signed");
    const after = sh(work, "rev-parse", "HEAD");
    expect(after).not.toBe(before);

    const attempt = await tryGit(work, ["push", "--set-upstream", "origin", "HEAD:refs/heads/main"]);
    expect(attempt.ok).toBe(false);

    const plan = planPush(attempt, await readTips(work, "main"));
    expect(plan).toMatchObject({ kind: "force-with-lease", branch: "main", expect: before });

    if (plan.kind !== "force-with-lease") throw new Error("unreachable");
    const forced = await tryGit(work, forceArgs(plan));
    expect(forced.ok).toBe(true);
    expect(sh(remote, "rev-parse", "refs/heads/main")).toBe(after);
  });

  it("stops rather than overwrite a commit somebody else pushed", async () => {
    // Another clone lands a commit on top while this one is amending.
    const other = join(root, "other");
    execFileSync("git", ["clone", remote, other], { stdio: "ignore" });
    sh(other, "config", "user.email", "other@example.invalid");
    sh(other, "config", "user.name", "Other");
    commit(other, "c.txt", "three\n", "theirs");
    sh(other, "push", "origin", "HEAD:refs/heads/main");
    const theirs = sh(other, "rev-parse", "HEAD");

    sh(work, "-c", "commit.gpgsign=false", "commit", "--amend", "-m", "second\n\nThwip-Proof: signed again");
    const attempt = await tryGit(work, ["push", "--set-upstream", "origin", "HEAD:refs/heads/main"]);
    expect(attempt.ok).toBe(false);

    const plan = planPush(attempt, await readTips(work, "main"));
    expect(plan).toMatchObject({ kind: "stop", reasonCode: "PUSH_REJECTED" });
    expect(sh(remote, "rev-parse", "refs/heads/main")).toBe(theirs);
  });
});
