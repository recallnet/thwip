import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface StoredSession {
  readonly endpoint: string;
  readonly token: string;
}

/** Bind bearer credentials to one origin, never to a URL carrying other parts. */
export function normalizeSessionEndpoint(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("the Thwip endpoint must use HTTPS, except for a loopback development server");
  }
  if (url.href !== `${url.origin}/`) {
    throw new Error("the Thwip endpoint must be an origin without credentials, a path, query, or fragment");
  }
  return url.origin;
}

async function refuseUnsafeTarget(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path} is not a regular session file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Store endpoint and bearer together so a crash cannot pair either with the other. */
export async function writeStoredSession(path: string, session: StoredSession): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await refuseUnsafeTarget(path);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}`);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(JSON.stringify(session) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await refuseUnsafeTarget(path);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function readStoredSession(path: string): Promise<StoredSession | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path} is not a safe readable session file`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error(`${path} is not a safe session file`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${path} is not private; run thwip login to replace it`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
    const value = JSON.parse(text) as { endpoint?: unknown; token?: unknown };
    if (typeof value.endpoint !== "string" || typeof value.token !== "string" || value.token.trim() === "") {
      throw new Error(`${path} contains an invalid session`);
    }
    return { endpoint: value.endpoint, token: value.token.trim() };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(path)) throw error;
    throw new Error(`${path} contains an invalid session`);
  } finally {
    await handle.close();
  }
}
