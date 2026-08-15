import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeSessionEndpoint, readStoredSession, writeStoredSession } from "./session-store.js";

describe("session endpoint binding", () => {
  it.each([
    ["https://thwip.ai", "https://thwip.ai"],
    ["https://thwip.ai/", "https://thwip.ai"],
    ["http://localhost:8787", "http://localhost:8787"],
  ])("accepts the exact origin %s", (input, expected) => {
    expect(normalizeSessionEndpoint(input)).toBe(expected);
  });

  it.each([
    "http://thwip.ai",
    "https://user:password@thwip.ai",
    "https://thwip.ai/v1",
    "https://thwip.ai/?mode=test",
    "https://thwip.ai/#fragment",
  ])("refuses endpoint URL parts in %s", (input) => {
    expect(() => normalizeSessionEndpoint(input)).toThrow();
  });
});

describe("session storage", () => {
  it("stores endpoint and token atomically with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "thwip-session-"));
    const path = join(root, "config", "session.json");
    await writeStoredSession(path, { endpoint: "https://thwip.ai", token: "secret" });
    expect(await readStoredSession(path)).toEqual({ endpoint: "https://thwip.ai", token: "secret" });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("replaces a permissive regular file and corrects its mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "thwip-session-"));
    const path = join(root, "session.json");
    await writeFile(path, '{}\n');
    await chmod(path, 0o644);
    await expect(readStoredSession(path)).rejects.toThrow("not private");
    await writeStoredSession(path, { endpoint: "https://thwip.ai", token: "new" });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("never follows a session symlink or accepts a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "thwip-session-"));
    const outside = join(root, "outside");
    await writeFile(outside, "untouched");
    const linked = join(root, "session.json");
    await symlink(outside, linked);
    await expect(writeStoredSession(linked, { endpoint: "https://thwip.ai", token: "secret" })).rejects.toThrow();
    await expect(readStoredSession(linked)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("untouched");

    const directory = join(root, "directory");
    await mkdir(directory);
    await expect(writeStoredSession(directory, { endpoint: "https://thwip.ai", token: "secret" })).rejects.toThrow();
  });
});
