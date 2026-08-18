import { describe, expect, it, vi } from "vitest";
import { verifyAndAuthorize } from "./orchestration.js";

describe("proof verification and queue enrolment", () => {
  it("enrols after a passing proof", async () => {
    const authorize = vi.fn(async () => undefined);
    await expect(verifyAndAuthorize(async () => 0, authorize, vi.fn(), vi.fn())).resolves.toBe(0);
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("enrols after a failed proof and keeps the proof failure", async () => {
    const authorize = vi.fn(async () => undefined);
    await expect(verifyAndAuthorize(async () => 1, authorize, vi.fn(), vi.fn())).resolves.toBe(1);
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("does not turn a queue outage into a proof failure", async () => {
    const warn = vi.fn();
    await expect(
      verifyAndAuthorize(
        async () => 0,
        async () => {
          throw new Error("offline");
        },
        vi.fn(),
        warn,
      ),
    ).resolves.toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("still enrols when verification throws", async () => {
    const fail = vi.fn();
    const authorize = vi.fn(async () => undefined);
    await expect(
      verifyAndAuthorize(
        async () => {
          throw new Error("bad bundle");
        },
        authorize,
        fail,
        vi.fn(),
      ),
    ).resolves.toBe(1);
    expect(fail).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledOnce();
  });
});
