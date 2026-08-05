import { describe, expect, it } from "vitest";
import { completedQueueActivationText } from "./App.js";

describe("completed queue setup copy", () => {
  it("describes ownership and required checks once enforcement is active", () => {
    expect(completedQueueActivationText("enforced")).toBe(
      "It owns normal branch updates and requires the App proof and turn checks.",
    );
  });

  it.each([undefined, "observe", "canary"])("does not claim %s owns branch updates", (activationState) => {
    expect(completedQueueActivationText(activationState)).toBe(
      "It reports what it would do and blocks nothing until you enforce it.",
    );
  });
});
