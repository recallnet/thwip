import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trimEnd();
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
