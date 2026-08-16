import { describe, expect, it } from "vitest";
import { COLD_START_COMMAND, initPrompt, initReport } from "./index.js";

describe("shared init prompt", () => {
  it("names one cold-start command and no update command", () => {
    const prompt = initPrompt();
    expect(COLD_START_COMMAND).toBe("npx @recallnet/thwip@latest init");
    expect(prompt).toContain(COLD_START_COMMAND);
    expect(prompt).toContain("Init is also the update command");
    expect(prompt).not.toMatch(/thwip update/);
    expect(prompt).toContain("exact\n   `doctor --allow-unread` invocation init wrote in AGENTS.md");
    expect(prompt).not.toMatch(/^\s*thwip doctor/m);
  });

  it("separates a returning machine from repository enrolment", () => {
    const prompt = initPrompt({
      githubName: "example/project",
      defaultBranch: "trunk",
      repositoryState: "ready",
      signedIn: true,
      keyState: "registered",
    });
    expect(prompt).toContain("already enrolled on trunk");
    expect(prompt).toContain("Prepare only this machine");
    expect(prompt).toContain("Do not run queue setup");
  });

  it("does not misname a selected but disabled project as incomplete enrolment", () => {
    const prompt = initPrompt({
      githubName: "example/project",
      repositoryState: "not-ready",
      repositoryDetail: "the project is disabled",
    });
    expect(prompt).toContain("not currently ready");
    expect(prompt).toContain("the project is disabled");
    expect(prompt).not.toContain("resume the existing Queue setup");
  });
});

describe("CLI terminal report", () => {
  it("does not tell init to run itself again after success", () => {
    const report = initReport(
      {
        githubName: "example/project",
        defaultBranch: "main",
        repositoryState: "ready",
        signedIn: true,
        keyState: "registered",
      },
      {
        guidance: {
          state: "current",
          paths: [],
          claudeCompatibility: "managed-file",
          cliCommand: "pnpm -w thwip",
        },
        config: "not-requested",
      },
    );
    expect(report).not.toContain(COLD_START_COMMAND);
    expect(report).not.toContain("run init");
    expect(report).toContain("already current");
    expect(report).toContain("no remote GitHub");
    expect(report).toContain("pnpm -w thwip doctor --allow-unread");
  });

  it("does not claim blocked guidance or Claude compatibility was checked", () => {
    const report = initReport(
      {
        githubName: "example/project",
        repositoryState: "unreadable",
        repositoryDetail: "service unavailable",
        signedIn: true,
        keyState: "unreadable",
        keyDetail: "GitHub unavailable",
      },
      { guidance: { state: "blocked" }, config: "not-requested" },
    );
    expect(report).toContain("Not checked or changed");
    expect(report).toContain("Claude compatibility was not checked");
    expect(report).not.toContain("already current");
    expect(report).not.toContain("contains only a pointer");
  });
});
