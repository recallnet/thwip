import { describe, expect, it } from "vitest";
import { deploymentId, validDeploymentId } from "./deployment-id.mjs";

describe("the deployment generation marker", () => {
  it("uses the exact generated nonce", () => {
    expect(deploymentId(() => "00000000-0000-4000-8000-000000000001"))
      .toBe("00000000-0000-4000-8000-000000000001");
  });

  it("rejects placeholders and malformed generations", () => {
    expect(validDeploymentId("unstamped")).toBe(false);
    expect(validDeploymentId("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(() => deploymentId(() => "not-a-uuid")).toThrow(/valid deployment id/);
  });
});
