import { describe, expect, it } from "vitest";
import { findProjectByGithubName, parseProjectPath, projectPath } from "./projectPath.js";

/**
 * A project's address is `owner/repo`, not the `prj_…` id only the database
 * cares about. The parser has to tell an owner/repo pair apart from an
 * owner/repo/section triple, survive a cold load (it only ever sees a path
 * string, never client-navigation state), and say clearly when nothing
 * matches rather than leaving the caller to guess.
 */

describe("parseProjectPath", () => {
  it("parses owner/repo with no section as overview", () => {
    expect(parseProjectPath("/dashboard/projects/o/r")).toEqual({
      githubName: "o/r",
      section: "overview",
    });
  });

  it("parses owner/repo/section", () => {
    expect(parseProjectPath("/dashboard/projects/o/r/queue")).toEqual({
      githubName: "o/r",
      section: "queue",
    });
  });

  it("round-trips a name with a dot and a hyphen through projectPath", () => {
    const githubName = "re.call/th-wip";
    const path = projectPath(githubName, "queue");
    expect(parseProjectPath(path)).toEqual({ githubName, section: "queue" });
  });

  it("decodes percent-encoded segments", () => {
    expect(parseProjectPath("/dashboard/projects/re%2Ecall/th-wip")).toEqual({
      githubName: "re.call/th-wip",
      section: "overview",
    });
  });

  it("does not match the bare project list path", () => {
    expect(parseProjectPath("/dashboard/projects")).toBeNull();
  });

  it("does not match a path with only one segment after projects", () => {
    expect(parseProjectPath("/dashboard/projects/onlyowner")).toBeNull();
  });
});

describe("projectPath", () => {
  it("omits the section for overview", () => {
    expect(projectPath("recallnet/thwip")).toBe("/dashboard/projects/recallnet/thwip");
  });

  it("appends a non-overview section", () => {
    expect(projectPath("recallnet/thwip", "queue")).toBe("/dashboard/projects/recallnet/thwip/queue");
  });
});

describe("findProjectByGithubName", () => {
  const projects = [{ github_name: "recallnet/thwip" }, { github_name: "recallnet/other" }];

  it("finds an exact match", () => {
    expect(findProjectByGithubName(projects, "recallnet/thwip")).toBe(projects[0]);
  });

  it("matches case-insensitively", () => {
    expect(findProjectByGithubName(projects, "RecallNet/Thwip")).toBe(projects[0]);
  });

  it("returns undefined for an unknown repository", () => {
    expect(findProjectByGithubName(projects, "recallnet/does-not-exist")).toBeUndefined();
  });
});
