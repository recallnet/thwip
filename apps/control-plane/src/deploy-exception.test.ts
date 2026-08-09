import { describe, expect, it } from "vitest";
// @ts-expect-error -- the deploy scripts are plain modules with no declarations.
import { exceptionStamp, parseBreakGlass } from "../../../scripts/break-glass.mjs";
import { readException } from "./deploy-exception.js";

/**
 * The writer and the reader are on opposite sides of a bundle boundary: one is a
 * node script run at deploy time, the other is Worker source. Nothing but this
 * test makes them agree, so the test writes with the real writer rather than
 * with a hand-made string that would keep passing after the format moved.
 */
describe("what the deploy stamps and the worker reads", () => {
  const reason = "the queue cannot merge its own repair, so the fix cannot reach main";

  it("reads back everything the deploy wrote", () => {
    const stamp = exceptionStamp(parseBreakGlass(`unmerged-tree,behind-main: ${reason}`), {
      branch: "break-glass-deploy",
      head: "abc1234",
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
    const stamp = exceptionStamp(parseBreakGlass(undefined), { branch: "main", head: "abc1234", at: "x" });
    expect(readException(stamp)).toBeNull();
  });

  it("treats an unreadable stamp as no exception rather than a bad one", () => {
    expect(readException("{")).toBeNull();
    expect(readException(undefined)).toBeNull();
  });
});
