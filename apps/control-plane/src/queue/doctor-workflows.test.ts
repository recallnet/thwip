import { describe, expect, it } from "vitest";
import { QUEUE_ACTION_REF, setupPullRequestFiles } from "./bootstrap-workflows.js";
import { actionCommitUsesInstallationToken, managedWorkflowHealth } from "./doctor-workflows.js";

const ENDPOINT = "https://thwip.test";

function exactFiles(): Record<string, string | null> {
  return Object.fromEntries(
    setupPullRequestFiles({ endpoint: ENDPOINT, actionRef: QUEUE_ACTION_REF }).map((file) => [file.path, file.content]),
  );
}

describe("managed workflow doctor", () => {
  it("uses the installation token only when the Action is in the installed repository", () => {
    expect(actionCommitUsesInstallationToken("recallnet/thwip", "RecallNet/Thwip")).toBe(true);
    expect(actionCommitUsesInstallationToken("recallnet/thwip", "customer/project")).toBe(false);
  });

  it("accepts the exact live workflow bytes and accessible pinned action", () => {
    expect(managedWorkflowHealth({
      endpoint: ENDPOINT,
      files: exactFiles(),
      actionAccessible: true,
    })).toMatchObject({
      healthy: true,
      missing: [],
      drifted: [],
      actionRef: QUEUE_ACTION_REF,
      actionAccessible: true,
    });
  });

  it("fails a missing workflow", () => {
    const files = exactFiles();
    files[".github/workflows/thwip-required.yml"] = null;
    expect(managedWorkflowHealth({
      endpoint: ENDPOINT,
      files,
      actionAccessible: true,
    })).toMatchObject({
      healthy: false,
      missing: [".github/workflows/thwip-required.yml"],
    });
  });

  it("fails changed workflow permissions or action pins", () => {
    const files = exactFiles();
    files[".github/workflows/thwip-required.yml"] = files[".github/workflows/thwip-required.yml"]!.replace(
      "checks: write",
      "checks: read",
    );
    expect(managedWorkflowHealth({
      endpoint: ENDPOINT,
      files,
      actionAccessible: true,
    })).toMatchObject({
      healthy: false,
      drifted: [".github/workflows/thwip-required.yml"],
    });
  });

  it("fails when the pinned action commit is inaccessible", () => {
    expect(managedWorkflowHealth({
      endpoint: ENDPOINT,
      files: exactFiles(),
      actionAccessible: false,
    })).toMatchObject({
      healthy: false,
      actionAccessible: false,
    });
  });
});
