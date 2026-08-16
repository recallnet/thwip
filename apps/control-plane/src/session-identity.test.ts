import { describe, expect, it } from "vitest";
import { sessionIdentity } from "./session-identity.js";

describe("read-only CLI session identity", () => {
  it("projects only the existing GitHub user id", () => {
    const viewer = Object.freeze({ githubUserId: "42", activated: false, principalId: "p1" });
    expect(sessionIdentity(viewer)).toEqual({ githubUserId: "42" });
    expect(viewer).toEqual({ githubUserId: "42", activated: false, principalId: "p1" });
  });

  it("does not invent an unauthenticated identity", () => {
    expect(sessionIdentity(null)).toBeNull();
  });
});
