import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materializeCandidate } from "./candidate.js";

const execFileP = promisify(execFile);

/**
 * Real git, on purpose.
 *
 * The claim this file has to hold is that the suites run against the merged
 * candidate rather than the developer's own head, and a fake git can be made
 * to agree with anything. So there is an origin, a clone whose head is not the
 * candidate, and a merge commit that exists only on the origin, exactly as it
 * does when the queue builds one.
 */

let origin: string;
let clone: string;
let candidateSha: string;
let candidateTree: string;
let cloneHeadTree: string;
let root: string;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout.trim();
}

async function commit(cwd: string, message: string): Promise<string> {
  await git(["add", "-A"], cwd);
  await git(["commit", "-m", message], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "thwip-candidate-test-"));
  origin = join(root, "origin");
  clone = join(root, "clone");

  await execFileP("git", ["init", "--initial-branch=main", origin]);
  for (const [key, value] of [
    ["user.name", "thwip test"],
    ["user.email", "test@example.invalid"],
    // A signing key the fixture does not have would fail every commit below.
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    // What GitHub allows, so the fetch this exercises is the fetch that runs
    // against a real remote.
    ["uploadpack.allowReachableSHA1InWant", "true"],
  ]) {
    await git(["config", key!, value!], origin);
  }

  await writeFile(join(origin, "base.txt"), "base\n");
  await commit(origin, "base");
  const base = await git(["rev-parse", "HEAD"], origin);

  // The developer's branch.
  await git(["checkout", "-b", "feature"], origin);
  await writeFile(join(origin, "feature.txt"), "feature\n");
  const head = await commit(origin, "feature");

  // The base moves on after the developer pushed, which is the whole reason a
  // candidate is not the head.
  await git(["checkout", "main"], origin);
  await writeFile(join(origin, "moved.txt"), "moved\n");
  await commit(origin, "base moves on");

  // The candidate the queue builds: the developer's head merged into the base
  // as it stands now. Kept under a ref of its own, as the queue keeps it.
  await git(["checkout", "-b", "candidate"], origin);
  await git(["merge", "--no-ff", "-m", "candidate", head], origin);
  candidateSha = await git(["rev-parse", "HEAD"], origin);
  candidateTree = await git(["rev-parse", "HEAD^{tree}"], origin);
  await git(["update-ref", "refs/thwip/candidate", candidateSha], origin);
  await git(["checkout", "main"], origin);
  await git(["branch", "-D", "candidate"], origin);

  // The developer's own clone. Its head is the feature branch, which carries
  // neither the moved base nor the merge.
  await execFileP("git", ["clone", "--branch", "feature", origin, clone]);
  for (const [key, value] of [
    ["user.name", "thwip test"],
    ["user.email", "test@example.invalid"],
    ["commit.gpgsign", "false"],
  ]) {
    await git(["config", key!, value!], clone);
  }
  cloneHeadTree = await git(["rev-parse", "HEAD^{tree}"], clone);
  expect(candidateTree).not.toBe(cloneHeadTree);
  expect(base).not.toBe(candidateSha);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("materializeCandidate", () => {
  it("checks out the merged candidate, not the head the developer is sitting on", async () => {
    const result = await materializeCandidate({
      repoDir: clone,
      candidateSha,
      candidateTreeOid: candidateTree,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const workspace = result.workspace;
    expect(await git(["rev-parse", "HEAD"], workspace.dir)).toBe(candidateSha);
    expect(await git(["rev-parse", "HEAD^{tree}"], workspace.dir)).toBe(candidateTree);
    expect(await git(["rev-parse", "HEAD^{tree}"], workspace.dir)).not.toBe(cloneHeadTree);

    // Both sides of the merge are present in the tree the suites will see, and
    // the file the base gained after the branch was cut is one of them.
    expect(await readFile(join(workspace.dir, "feature.txt"), "utf8")).toBe("feature\n");
    expect(await readFile(join(workspace.dir, "moved.txt"), "utf8")).toBe("moved\n");
    expect(existsSync(join(clone, "moved.txt"))).toBe(false);

    await workspace.dispose();
    expect(existsSync(workspace.dir)).toBe(false);
    // The developer's own checkout is where they left it.
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], clone)).toBe("feature");
    expect(await git(["rev-parse", "HEAD^{tree}"], clone)).toBe(cloneHeadTree);
  });

  it("refuses a candidate whose tree is not the tree the assignment names", async () => {
    const result = await materializeCandidate({
      repoDir: clone,
      candidateSha,
      candidateTreeOid: "0".repeat(40),
    });
    expect(result).toMatchObject({ ok: false, reasonCode: "CANDIDATE_TREE_MISMATCH" });
  });

  it("refuses a candidate the remote has never heard of", async () => {
    const result = await materializeCandidate({
      repoDir: clone,
      candidateSha: "9".repeat(40),
      candidateTreeOid: candidateTree,
    });
    expect(result).toMatchObject({ ok: false, reasonCode: "CANDIDATE_UNAVAILABLE" });
  });

  it("leaves nothing behind when it refuses", async () => {
    const before = await git(["worktree", "list"], clone);
    await materializeCandidate({ repoDir: clone, candidateSha, candidateTreeOid: "0".repeat(40) });
    expect(await git(["worktree", "list"], clone)).toBe(before);
  });
});
