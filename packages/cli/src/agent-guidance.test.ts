import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { queueInstructions } from "@thwip/prompts";
import { writeAgentGuidance } from "./agent-guidance.js";

const open: string[] = [];

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "thwip-guidance-"));
  open.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const instructions = queueInstructions({ cliCommand: "npx @recallnet/thwip@latest" });

describe("atomic repository guidance", () => {
  it("creates both files and converges without a global command", async () => {
    const root = await temp();
    const first = await writeAgentGuidance(root, instructions);
    expect(first.changed).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toMatch(/^# Agent instructions\n\n<!-- thwip:start -->/);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("npx @recallnet/thwip@latest ship");
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain("AGENTS.md is the canonical agent contract");
    expect((await writeAgentGuidance(root, instructions)).changed).toEqual([]);
  });

  it("preserves authored bytes and file modes outside the managed regions", async () => {
    const root = await temp();
    const agents = join(root, "AGENTS.md");
    const claude = join(root, "CLAUDE.md");
    await writeFile(agents, "# Agents\r\n\r\nCafé.\r\n<!-- thwip:start -->\nold\n<!-- thwip:end -->\r\nTail");
    await writeFile(claude, "# Claude\n\nAuthored\n");
    await Promise.all([import("node:fs/promises").then(({ chmod }) => chmod(agents, 0o640)), import("node:fs/promises").then(({ chmod }) => chmod(claude, 0o600))]);
    await writeAgentGuidance(root, instructions);
    const next = await readFile(agents, "utf8");
    expect(next.startsWith("# Agents\r\n\r\nCafé.\r\n")).toBe(true);
    expect(next.endsWith("\r\nTail")).toBe(true);
    expect((await stat(agents)).mode & 0o777).toBe(0o640);
    expect((await stat(claude)).mode & 0o777).toBe(0o600);
  });

  it("preflights both targets before changing either", async () => {
    const root = await temp();
    await writeFile(join(root, "AGENTS.md"), "# Authored\n");
    await mkdir(join(root, "CLAUDE.md"));
    await expect(writeAgentGuidance(root, instructions)).rejects.toThrow("not a regular file");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# Authored\n");
  });

  it("refuses malformed markers and invalid UTF-8 without a partial write", async () => {
    const malformed = await temp();
    await writeFile(join(malformed, "AGENTS.md"), "<!-- thwip:start -->\nunfinished");
    await writeFile(join(malformed, "CLAUDE.md"), "# Claude\n");
    await expect(writeAgentGuidance(malformed, instructions)).rejects.toThrow("malformed or duplicate");
    expect(await readFile(join(malformed, "CLAUDE.md"), "utf8")).toBe("# Claude\n");

    const binary = await temp();
    await writeFile(join(binary, "AGENTS.md"), Buffer.from([0xc3, 0x28]));
    await expect(writeAgentGuidance(binary, instructions)).rejects.toThrow("not valid UTF-8");

    const fenced = await temp();
    await writeFile(join(fenced, "AGENTS.md"), "# Authored\n\n````md\nintentional EOF\n");
    await writeFile(join(fenced, "CLAUDE.md"), "# Claude stays authored\n");
    await expect(writeAgentGuidance(fenced, instructions)).rejects.toThrow("malformed or duplicate");
    expect(await readFile(join(fenced, "CLAUDE.md"), "utf8")).toBe("# Claude stays authored\n");
  });

  it("never follows AGENTS symlinks and accepts only CLAUDE pointing to root AGENTS", async () => {
    const root = await temp();
    const outside = join(await temp(), "outside.md");
    await writeFile(outside, "outside");
    await symlink(outside, join(root, "AGENTS.md"));
    await expect(writeAgentGuidance(root, instructions)).rejects.toThrow("is a symlink");
    expect(await readFile(outside, "utf8")).toBe("outside");

    const compatible = await temp();
    await symlink("AGENTS.md", join(compatible, "CLAUDE.md"));
    const result = await writeAgentGuidance(compatible, instructions);
    expect(result.claudeCompatibility).toBe("agents-symlink");
    expect(result.changed).toEqual(["AGENTS.md"]);

    const refused = await temp();
    await symlink(outside, join(refused, "CLAUDE.md"));
    await expect(writeAgentGuidance(refused, instructions)).rejects.toThrow("is a symlink");

    const traversing = await temp();
    await symlink("/tmp", join(traversing, "linkdir"));
    await symlink("linkdir/../AGENTS.md", join(traversing, "CLAUDE.md"));
    await expect(writeAgentGuidance(traversing, instructions)).rejects.toThrow("is a symlink");
  });

  it("detects edits before and after validation and serializes init runs", async () => {
    const before = await temp();
    await writeFile(join(before, "AGENTS.md"), "authored\n");
    await expect(
      writeAgentGuidance(before, instructions, {
        beforeCommit: () => writeFile(join(before, "AGENTS.md"), "concurrent\n"),
      }),
    ).rejects.toThrow("changed while init was preparing");
    expect(await readFile(join(before, "AGENTS.md"), "utf8")).toBe("concurrent\n");

    const after = await temp();
    await writeFile(join(after, "AGENTS.md"), "authored\n");
    await expect(
      writeAgentGuidance(after, instructions, {
        afterValidation: () => writeFile(join(after, "AGENTS.md"), "late edit\n"),
      }),
    ).rejects.toThrow("changed while init was preparing");
    expect(await readFile(join(after, "AGENTS.md"), "utf8")).toBe("late edit\n");

    const locked = await temp();
    await writeFile(join(locked, ".thwip-init.lock"), "held");
    await expect(writeAgentGuidance(locked, instructions)).rejects.toThrow("another thwip init");
  });

  it("refuses to create a reciprocal AGENTS and CLAUDE pointer loop", async () => {
    for (const text of [
      "Read CLAUDE.md before working.\n",
      "Claude-specific instructions: CLAUDE.md\n",
      "For Claude, consult CLAUDE.md\n",
    ]) {
      const root = await temp();
      await writeFile(join(root, "AGENTS.md"), text);
      await expect(writeAgentGuidance(root, instructions)).rejects.toThrow("reciprocal");
      await expect(lstat(join(root, "CLAUDE.md"))).rejects.toMatchObject({ code: "ENOENT" });
    }

    const example = await temp();
    await writeFile(join(example, "AGENTS.md"), "````md\n```\nRead CLAUDE.md before working.\n````\n");
    await expect(writeAgentGuidance(example, instructions)).resolves.toBeDefined();
  });

});
