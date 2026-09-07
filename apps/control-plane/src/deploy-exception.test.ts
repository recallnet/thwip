import { describe, expect, it } from "vitest";
import { readException } from "./deploy-exception.js";

describe("what the worker reads from the deploy stamp", () => {
  const reason = "the queue cannot merge its own repair, so the fix cannot reach main";

  it("reads back a complete stamp", () => {
    const stamp = JSON.stringify({
      guards: ["unmerged-tree", "behind-main"],
      reason,
      tree: "break-glass-deploy@abc1234",
      at: "2026-08-09T14:00:00.000Z",
    });
    expect(readException(stamp)).toEqual({
      guards: ["unmerged-tree", "behind-main"],
      reason,
      tree: "break-glass-deploy@abc1234",
      at: "2026-08-09T14:00:00.000Z",
    });
  });

  it("reports no exception for an ordinary deploy", () => {
    expect(readException("")).toBeNull();
  });

  it("treats an unreadable stamp as no exception rather than a bad one", () => {
    expect(readException("{")).toBeNull();
    expect(readException(undefined)).toBeNull();
  });
});
