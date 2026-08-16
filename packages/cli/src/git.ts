import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DivergedTips, PushAttempt } from "./push-plan.js";

const execFileP = promisify(execFile);

export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

/** A bounded, non-interactive Git read for onboarding remote discovery only. */
export async function gitInitRead(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", [...args], {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trimEnd();
}

/** Read exact bytes from git, for content-addressed policy material. */
export async function gitBytes(args: string[], cwd: string): Promise<Uint8Array> {
  const result = (await execFileP("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer",
  })) as unknown as { stdout: Buffer };
  return new Uint8Array(result.stdout);
}

export interface GitSubject {
  headSha: string;
  treeOid: string;
  parentOids: string[];
  baseRef: string;
  baseSha: string;
  objectFormat: "sha1" | "sha256";
}

export async function requireCleanTree(cwd: string): Promise<void> {
  const status = await git(["status", "--porcelain"], cwd);
  const dirty = status
    .split("\n")
    .filter((l) => l.length > 0 && !l.startsWith("??"));
  if (dirty.length > 0) {
    throw new Error(
      `refusing ambiguous dirty tree; commit or stash tracked changes first:\n${dirty.join("\n")}`,
    );
  }
}

export async function freezeSubject(cwd: string, baseRef: string): Promise<GitSubject> {
  const headSha = await git(["rev-parse", "HEAD"], cwd);
  const treeOid = await git(["rev-parse", "HEAD^{tree}"], cwd);
  const parentsLine = await git(["rev-list", "--parents", "-n", "1", "HEAD"], cwd);
  const parentOids = parentsLine.split(/\s+/).slice(1);
  const objectFormatRaw = await git(["rev-parse", "--show-object-format"], cwd);
  const objectFormat = objectFormatRaw === "sha256" ? "sha256" : "sha1";
  let baseSha: string;
  try {
    baseSha = await git(["merge-base", "HEAD", baseRef], cwd);
  } catch {
    throw new Error(`cannot resolve merge-base with ${baseRef}; fetch first`);
  }
  return { headSha, treeOid, parentOids, baseRef, baseSha, objectFormat };
}

export async function currentTree(cwd: string): Promise<string> {
  return git(["rev-parse", "HEAD^{tree}"], cwd);
}

export async function headMessage(cwd: string): Promise<string> {
  return git(["log", "-1", "--format=%B"], cwd);
}

export async function amendMessage(cwd: string, message: string): Promise<void> {
  await git(["commit", "--amend", "--no-edit", "-m", message], cwd);
}

export async function showFileAtHead(cwd: string, path: string): Promise<string> {
  return git(["show", `HEAD:${path}`], cwd);
}

/** Run git and keep what it printed, so a refusal can be classified rather than thrown. */
export async function tryGit(cwd: string, args: string[]): Promise<PushAttempt> {
  try {
    await git(args, cwd);
    return { ok: true, stderr: "" };
  } catch (error) {
    const carried = (error as { stderr?: unknown } | null)?.stderr;
    return {
      ok: false,
      stderr: typeof carried === "string" ? carried : error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The two tips a rejected push is about.
 *
 * The remote tip comes from `ls-remote`, because the remote-tracking ref is
 * whatever the last fetch left behind and the whole question is what is on the
 * remote now. Its parents are read from this machine's object store: the commit
 * ship amended is still here, and a tip this machine has never seen is one
 * somebody else pushed, which is the case that must never be forced over.
 */
export async function readTips(cwd: string, branch: string): Promise<DivergedTips> {
  const parentsOf = async (rev: string) =>
    (await git(["rev-list", "--parents", "-n", "1", rev], cwd)).split(/\s+/).slice(1);

  const localSha = await git(["rev-parse", "HEAD"], cwd);
  const localParents = await parentsOf("HEAD");

  let remoteSha: string | null = null;
  let remoteParents: string[] = [];
  try {
    const listed = await git(["ls-remote", "origin", `refs/heads/${branch}`], cwd);
    const sha = listed.split(/\s+/)[0] ?? "";
    if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      remoteParents = await parentsOf(sha);
      remoteSha = sha;
    }
  } catch {
    remoteSha = null;
  }

  return { branch, localSha, localParents, remoteSha, remoteParents };
}
