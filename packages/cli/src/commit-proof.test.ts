import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DsseEnvelope } from "@thwip/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { proofStateAtCommit } from "./commit-proof.js";
import { attachTrailer, buildStatement } from "./proof.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "thwip-commit-proof-"));
  roots.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "user.name", "Test");
  return cwd;
}

function messageWithProofFor(treeOid: string): string {
  const statement = buildStatement({
    subject: {
      headSha: "9".repeat(40),
      treeOid,
      parentOids: [],
      baseRef: "refs/heads/main",
      baseSha: "d".repeat(40),
      objectFormat: "sha1",
    },
    ownerId: "1",
    repositoryId: "2",
    policyDigest: `sha256:${"e".repeat(64)}`,
    policyVersion: 1,
    pipelineDigest: `sha256:${"f".repeat(64)}`,
    runner: "command",
    suites: [{ id: "test", status: "passed", durationMs: 1 }],
    startedAt: "2026-08-05T00:00:00.000Z",
    finishedAt: "2026-08-05T00:00:01.000Z",
    keyId: "SHA256:test",
    githubUserId: "3",
    privateKeyPath: "/dev/null",
  });
  const envelope: DsseEnvelope = {
    payloadType: "application/vnd.in-toto+json",
    payload: btoa(JSON.stringify(statement)),
    signatures: [{ keyid: "SHA256:test", sig: "AAAA" }],
  };
  return attachTrailer("proved commit\n", envelope);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("proof state at an exact commit", () => {
  it("checks the requested historical commit instead of the current worktree HEAD", async () => {
    const cwd = repository();
    writeFileSync(join(cwd, "proved.txt"), "proved\n");
    git(cwd, "add", "proved.txt");
    const provedTree = git(cwd, "write-tree");
    git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", messageWithProofFor(provedTree));
    const provedCommit = git(cwd, "rev-parse", "HEAD");

    writeFileSync(join(cwd, "later.txt"), "later\n");
    git(cwd, "add", "later.txt");
    git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "unproved tip");

    await expect(proofStateAtCommit(cwd, provedCommit)).resolves.toMatchObject({
      treeOid: provedTree,
      state: "accepted",
    });
    await expect(proofStateAtCommit(cwd, "HEAD")).resolves.toMatchObject({ state: "missing" });
  });

  it("does not accept a carried proof after the commit tree changes", async () => {
    const cwd = repository();
    writeFileSync(join(cwd, "before.txt"), "before\n");
    git(cwd, "add", "before.txt");
    const beforeTree = git(cwd, "write-tree");

    writeFileSync(join(cwd, "after.txt"), "after\n");
    git(cwd, "add", "after.txt");
    git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", messageWithProofFor(beforeTree));

    await expect(proofStateAtCommit(cwd, "HEAD")).resolves.toMatchObject({ state: "stale" });
  });
});
