import { describe, expect, it } from "vitest";
import { parseBundleResolutionBody } from "./bundle-resolution.js";

describe("verification bundle resolution contract", () => {
  it("treats awaiting-first-merge as an explicit bootstrap result", () => {
    expect(
      parseBundleResolutionBody({
        state: "bootstrap_pending",
        code: "POLICY_AWAITING_FIRST_MERGE",
        repository: "recallnet/playhouse",
        repositoryId: "123",
        defaultBranch: "main",
      }),
    ).toEqual({
      kind: "bootstrap_pending",
      code: "POLICY_AWAITING_FIRST_MERGE",
      repository: "recallnet/playhouse",
      repositoryId: "123",
      defaultBranch: "main",
    });
  });

  it("accepts active bundles from current and older control planes", () => {
    expect(parseBundleResolutionBody({ state: "active", bundle: "signed" })).toEqual({
      kind: "active",
      bundle: "signed",
    });
    expect(parseBundleResolutionBody({ bundle: "signed" })).toEqual({ kind: "active", bundle: "signed" });
  });

  it("does not turn malformed or disabled resolver responses into bootstrap success", () => {
    expect(() => parseBundleResolutionBody({ code: "PROJECT_DISABLED" })).toThrow("neither an active bundle");
    expect(() =>
      parseBundleResolutionBody({
        state: "bootstrap_pending",
        code: "PROJECT_DISABLED",
        repository: "recallnet/playhouse",
        repositoryId: "123",
        defaultBranch: "main",
      }),
    ).toThrow("malformed bootstrap state");
  });
});
