import { describe, expect, it } from "vitest";
import { projectSetupPrompt } from "./index.js";

describe("project setup prompt policy lifecycle", () => {
  it("explains the non-approving bootstrap result before first activation", () => {
    const prompt = projectSetupPrompt({
      githubName: "recallnet/playhouse",
      defaultBranch: "main",
      enabled: true,
      hasActivePolicy: false,
    });
    expect(prompt).toContain("BOOTSTRAP_PENDING");
    expect(prompt).toContain("does not approve this pull request's candidate policy or proof");
    expect(prompt).toContain("organization defaults");
    expect(prompt).toContain("canonical main");
    expect(prompt).toContain("candidate policy never approves itself");
  });

  it("explains that later policy changes remain under the active policy until merge", () => {
    const prompt = projectSetupPrompt({
      githubName: "recallnet/playhouse",
      defaultBranch: "main",
      enabled: true,
      hasActivePolicy: true,
    });
    expect(prompt).toContain("verified under that policy");
    expect(prompt).toContain("takes effect only after its protected merge lands");
    expect(prompt).toContain("thwip / proof (observe)");
    expect(prompt).toContain("Do not leave an unprotected interval");
    expect(prompt).not.toContain("BOOTSTRAP_PENDING");
  });

  it("does not promise a passing check while the project is disabled", () => {
    const prompt = projectSetupPrompt({
      githubName: "recallnet/playhouse",
      defaultBranch: "main",
      enabled: false,
      hasActivePolicy: false,
    });
    expect(prompt).toContain("currently disabled");
    expect(prompt).toContain("before expecting the thwip check to pass");
    expect(prompt).toContain("Once enabled");
  });
});
