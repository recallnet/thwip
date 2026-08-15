import { describe, expect, it } from "vitest";
import {
  ManagedInstructionsError,
  claudePointer,
  queueInstructions,
  queueSetupPrompt,
  withAgentInstructions,
  withClaudePointer,
} from "./queue.js";

const instructions = () => queueInstructions({ cliCommand: "npx @recallnet/thwip@latest" });

describe("canonical AGENTS instructions", () => {
  it("uses an invocation that works without a global install", () => {
    const text = instructions();
    expect(text).toContain("npx @recallnet/thwip@latest doctor --allow-unread");
    expect(text).toContain("npx @recallnet/thwip@latest ship --wait --json-events");
    expect(text).not.toMatch(/^thwip /m);
  });

  it("gates ship and queue prohibitions on live readiness", () => {
    const text = instructions();
    expect(text).toMatch(/First run:[\s\S]*doctor --allow-unread/);
    expect(text).toMatch(/If doctor confirms[\s\S]*ship --wait/);
    expect(text).toMatch(/If doctor does not confirm[\s\S]*do not run `ship`/);
    expect(text).toContain("existing reviewed pull-request flow");
    expect(text).toContain("Rules when doctor confirms the Queue is ready");
  });

  it("keeps draft proof separate from queueing and merging", () => {
    const text = instructions();
    expect(text).toContain("Draft or review-only work");
    expect(text).toContain("npx @recallnet/thwip@latest ship --draft");
    expect(text).toMatch(/creates or\s+refreshes the draft pull request/);
    expect(text).toContain("stops without joining the queue");
    expect(text).toContain("Do not mark the draft ready, join the queue, or merge unless the user asks");
  });

  it("does not persist transient state or branch names", () => {
    const text = instructions();
    for (const stale of ["configured", "observe", "canary", "enforced", "refs/heads"]) {
      expect(text).not.toContain(stale);
    }
    expect(text).toContain("default branch");
  });

  it("keeps the queue safety rules and precise completion", () => {
    const text = instructions();
    for (const rule of [
      "Do not call `gh pr merge`",
      "Do not merge through the GitHub UI",
      "Do not push directly to the default branch",
      "Do not manually rebase",
      "Do not amend or force-push a queued head",
      "complete only after `queue.merge_confirmed`",
    ]) {
      expect(text, rule).toContain(rule);
    }
  });

  it("does not require a repository override file", () => {
    expect(instructions()).toContain("Read `thwip.yaml` if it exists");
  });
});

describe("bounded managed regions", () => {
  it("creates a canonical AGENTS region without leading blank lines", () => {
    const updated = withAgentInstructions("", "Current instructions.");
    expect(updated).toBe("<!-- thwip:start -->\nCurrent instructions.\n<!-- thwip:end -->\n");
  });

  it("is idempotent and preserves authored bytes outside its markers", () => {
    const prefix = "# Agents\r\n\r\nCafé authored text.\r\n";
    const suffix = "\r\nAuthored suffix with no final newline";
    const stale = `${prefix}<!-- thwip:start -->\nold\n<!-- thwip:end -->${suffix}`;
    const updated = withAgentInstructions(stale, "new");
    expect(updated.startsWith(prefix)).toBe(true);
    expect(updated.endsWith(suffix)).toBe(true);
    expect(withAgentInstructions(updated, "new")).toBe(updated);
  });

  it.each([
    "<!-- thwip:start -->\none-sided",
    "<!-- thwip:end -->\nreversed\n<!-- thwip:start -->",
    "<!-- thwip:start -->\na\n<!-- thwip:start -->\nb\n<!-- thwip:end -->",
    "<!-- thwip:start -->\na\n<!-- thwip:end -->\n<!-- thwip:end -->",
  ])("refuses malformed or duplicate AGENTS markers", (text) => {
    expect(() => withAgentInstructions(text, "new")).toThrow(ManagedInstructionsError);
  });

  it.each(["```md", "~~~md"])("refuses an unclosed %s fence instead of appending inside it", (opening) => {
    const authored = `# Authored\n\n${opening}\nThis fence intentionally reaches EOF.\n`;
    expect(() => withAgentInstructions(authored, "generated")).toThrow(ManagedInstructionsError);
    expect(() => withClaudePointer(authored)).toThrow(ManagedInstructionsError);
  });

  it("does not claim inline or fenced marker examples as managed content", () => {
    const authored = [
      "# Marker docs",
      "",
      "Inline `<!-- thwip:start -->` and `<!-- thwip:end -->` examples.",
      "",
      "```md",
      "<!-- thwip:start -->",
      "sample",
      "<!-- thwip:end -->",
      "```",
      "",
    ].join("\n");
    const updated = withAgentInstructions(authored, "real managed content");
    expect(updated.startsWith(authored)).toBe(true);
    expect(updated.match(/<!-- thwip:start -->/g)).toHaveLength(3);
    expect(updated).toContain("real managed content");
  });

  it.each([
    ["````md", "```", "````"],
    ["~~~~md", "~~~", "~~~~"],
  ])("preserves markers inside a %s fence with a shorter fence-like line", (open, shorter, close) => {
    const authored = [
      "# Authored example",
      "",
      open,
      shorter,
      "<!-- thwip:start -->",
      "do not touch this example",
      "<!-- thwip:end -->",
      close,
      "",
    ].join("\n");
    const updated = withAgentInstructions(authored, "generated");
    expect(updated.startsWith(authored)).toBe(true);
    expect(updated).toContain("do not touch this example");
  });

  it("keeps Claude compatibility small and canonical", () => {
    const existing = "# Claude\n\nAuthored.\n";
    const updated = withClaudePointer(existing);
    expect(updated.startsWith(existing)).toBe(true);
    expect(updated).toContain(claudePointer());
    expect(updated).toContain("AGENTS.md is the canonical agent contract");
    expect(updated).not.toContain("ship --wait");
    expect(withClaudePointer(updated)).toBe(updated);
  });
});

describe("queue enrolment prompt", () => {
  it("uses init for local guidance", () => {
    const prompt = queueSetupPrompt("example/project");
    expect(prompt).toContain('Run "npx @recallnet/thwip@latest init" first');
    expect(prompt).not.toContain("queue setup --write");
    expect(prompt).not.toContain("push warning");
    expect(prompt.match(/npx @recallnet\/thwip@latest/g)).toHaveLength(1);
  });

  it("keeps remote enrolment human-guided", () => {
    const prompt = queueSetupPrompt("example/project");
    expect(prompt).toContain("merge the setup pull request");
    expect(prompt).toContain("apply only the disabled policy payloads");
    expect(prompt).toContain("confirm every bypass-actor list");
    expect(prompt).not.toContain("THWIP_ENQUEUE_TOKEN");
  });
});
