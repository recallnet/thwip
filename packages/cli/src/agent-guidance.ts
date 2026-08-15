import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  open,
  readlink,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withAgentInstructions, withClaudePointer } from "@thwip/prompts";

type GuidanceName = "AGENTS.md" | "CLAUDE.md";

interface MissingSnapshot {
  readonly kind: "missing";
  readonly path: string;
}

interface FileSnapshot {
  readonly kind: "file";
  readonly path: string;
  readonly bytes: Buffer;
  readonly text: string;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

interface CompatibleLinkSnapshot {
  readonly kind: "compatible-link";
  readonly path: string;
  readonly target: string;
}

type Snapshot = MissingSnapshot | FileSnapshot | CompatibleLinkSnapshot;

interface PlannedWrite {
  readonly name: GuidanceName;
  readonly path: string;
  readonly original: MissingSnapshot | FileSnapshot;
  readonly bytes: Buffer;
  readonly mode: number;
  tempPath?: string;
}

export interface GuidanceWriteResult {
  readonly changed: readonly GuidanceName[];
  readonly claudeCompatibility: "managed-file" | "agents-symlink";
}

export interface GuidanceWriteHooks {
  /** Tests use this to prove a concurrent edit is detected before replacement. */
  readonly beforeCommit?: () => Promise<void>;
  readonly afterValidation?: () => Promise<void>;
}

const MAX_GUIDANCE_BYTES = 1024 * 1024;

function pointsToClaude(text: string): boolean {
  // Any authored CLAUDE.md reference outside a code example may be a routing
  // instruction. Refusing is safer than creating a reciprocal pointer loop.
  let fence: { char: "`" | "~"; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (fence !== null) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      continue;
    }
    const opening = /^ {0,3}((`{3,})|(~{3,}))(.*)$/.exec(line);
    if (opening !== null && !(opening[2] !== undefined && opening[4]!.includes("`"))) {
      const delimiter = opening[1]!;
      fence = { char: delimiter[0] as "`" | "~", length: delimiter.length };
      continue;
    }
    if (/(?:^|[^A-Za-z0-9_.-])CLAUDE\.md(?:$|[^A-Za-z0-9_.-])/i.test(line)) return true;
  }
  return false;
}

function decode(path: string, bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path} is not valid UTF-8; init will not rewrite it`);
  }
}

async function snapshot(root: string, name: GuidanceName): Promise<Snapshot> {
  const path = join(root, name);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", path };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const namedTarget = await readlink(path);
    if (name === "CLAUDE.md" && (namedTarget === "AGENTS.md" || namedTarget === "./AGENTS.md")) {
      return { kind: "compatible-link", path, target: join(root, "AGENTS.md") };
    }
    throw new Error(`${path} is a symlink; init will not follow or replace it`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${path} is not a regular file; init will not replace it`);
    if (opened.size > MAX_GUIDANCE_BYTES) {
      throw new Error(`${path} is larger than ${MAX_GUIDANCE_BYTES} bytes; init will not load or replace it`);
    }
    const bytes = await handle.readFile();
    return {
      kind: "file",
      path,
      bytes,
      text: decode(path, bytes),
      mode: opened.mode & 0o777,
      dev: opened.dev,
      ino: opened.ino,
      mtimeMs: opened.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

function sameSnapshot(expected: MissingSnapshot | FileSnapshot, current: Snapshot): boolean {
  if (expected.kind === "missing") return current.kind === "missing";
  return (
    current.kind === "file" &&
    expected.dev === current.dev &&
    expected.ino === current.ino &&
    expected.mode === current.mode &&
    expected.mtimeMs === current.mtimeMs &&
    expected.bytes.equals(current.bytes)
  );
}

function plan(
  root: string,
  agents: Snapshot,
  claude: Snapshot,
  instructions: string,
): { writes: PlannedWrite[]; compatibility: GuidanceWriteResult["claudeCompatibility"] } {
  const writes: PlannedWrite[] = [];
  if (agents.kind === "compatible-link") throw new Error("AGENTS.md cannot be a compatibility link");
  const agentsExisting = agents.kind === "file" ? agents.text : "# Agent instructions\n";
  if (agents.kind === "file" && pointsToClaude(agents.text)) {
    throw new Error(
      `${agents.path} points readers to CLAUDE.md; init will not create a reciprocal CLAUDE.md pointer`,
    );
  }
  const agentsNext = withAgentInstructions(agentsExisting, instructions);
  if (agents.kind === "missing" || agentsNext !== agents.text) {
    writes.push({
      name: "AGENTS.md",
      path: join(root, "AGENTS.md"),
      original: agents,
      bytes: Buffer.from(agentsNext),
      mode: agents.kind === "file" ? agents.mode : 0o644,
    });
  }

  if (claude.kind === "compatible-link") {
    return { writes, compatibility: "agents-symlink" };
  }
  const claudeExisting = claude.kind === "file" ? claude.text : "# Claude Code instructions\n";
  const claudeNext = withClaudePointer(claudeExisting);
  if (claude.kind === "missing" || claudeNext !== claude.text) {
    writes.push({
      name: "CLAUDE.md",
      path: join(root, "CLAUDE.md"),
      original: claude,
      bytes: Buffer.from(claudeNext),
      mode: claude.kind === "file" ? claude.mode : 0o644,
    });
  }
  return { writes, compatibility: "managed-file" };
}

async function prepare(write: PlannedWrite): Promise<void> {
  const tempPath = join(dirname(write.path), `.${basename(write.path)}.thwip-${process.pid}-${randomUUID()}`);
  const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, write.mode);
  try {
    await handle.writeFile(write.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tempPath, write.mode);
  write.tempPath = tempPath;
}

async function install(write: PlannedWrite): Promise<void> {
  const tempPath = write.tempPath;
  if (tempPath === undefined) throw new Error(`no prepared file for ${write.name}`);
  if (write.original.kind === "missing") {
    // A hard link is an atomic create-if-absent. Unlike rename, it cannot
    // overwrite a file created after preflight.
    await link(tempPath, write.path);
    await unlink(tempPath);
  } else {
    await rename(tempPath, write.path);
  }
  delete write.tempPath;
}

/**
 * Converge the two root guidance files. Both are parsed and prepared before the
 * first rename. If a crash lands only AGENTS.md, rerunning safely finishes the
 * pointer; no rollback can overwrite a concurrent author edit.
 */
export async function writeAgentGuidance(
  root: string,
  instructions: string,
  hooks: GuidanceWriteHooks = {},
): Promise<GuidanceWriteResult> {
  const lockPath = join(root, ".thwip-init.lock");
  let lock;
  let writes: PlannedWrite[] = [];
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `another thwip init holds ${lockPath}; wait for it to finish, or after confirming no init process is running, remove that lock file`,
      );
    }
    throw error;
  }

  try {
    const [agents, claude] = await Promise.all([snapshot(root, "AGENTS.md"), snapshot(root, "CLAUDE.md")]);
    const planned = plan(root, agents, claude, instructions);
    writes = planned.writes;
    const compatibility = planned.compatibility;
    if (writes.length === 0) return { changed: [], claudeCompatibility: compatibility };
    for (const write of writes) await prepare(write);
    await hooks.beforeCommit?.();
    // Validate every target together before the first replacement.
    for (const write of writes) {
      const current = await snapshot(root, write.name);
      if (!sameSnapshot(write.original, current)) {
        throw new Error(`${write.name} changed while init was preparing it; nothing was replaced`);
      }
    }
    await hooks.afterValidation?.();
    // An editor does not honor Thwip's lock. Check again after validation and
    // immediately before each replacement so an observed edit is never lost.
    for (const write of writes) {
      const current = await snapshot(root, write.name);
      if (!sameSnapshot(write.original, current)) {
        throw new Error(`${write.name} changed while init was preparing it; nothing was replaced`);
      }
    }
    // AGENTS.md is canonical, so a partial crash leaves the useful half first.
    for (const write of writes.sort((a, b) => (a.name === "AGENTS.md" ? -1 : b.name === "AGENTS.md" ? 1 : 0))) {
      const current = await snapshot(root, write.name);
      if (!sameSnapshot(write.original, current)) {
        throw new Error(`${write.name} changed before init could replace it`);
      }
      await install(write);
    }
    return { changed: writes.map((write) => write.name), claudeCompatibility: compatibility };
  } finally {
    await Promise.all(
      writes.map(async (write) => {
        if (write.tempPath === undefined) return;
        await unlink(write.tempPath).catch(() => undefined);
      }),
    );
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}
