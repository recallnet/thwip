import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import { withTransitionSigningLease } from "./transition-signing-lease.js";

const REPO = "1315419165";
const REF = "refs/heads/main";
const open: Array<{ close(): void }> = [];

afterEach(() => {
  vi.useRealTimers();
  while (open.length > 0) open.pop()!.close();
});

describe("the signed-transition writer claim", () => {
  it("fences an expired owner after a later owner completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const t = testD1();
    open.push(t);
    const writes: string[] = [];
    let releaseA!: () => void;
    let startedA!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const started = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const ownerA = withTransitionSigningLease(
      t.db,
      { repositoryId: REPO, baseRef: REF, owner: "owner-a" },
      async (claim) => {
        startedA();
        await held;
        if (await claim.fence()) writes.push("a-sign", "a-record", "a-link");
      },
    );
    await started;

    // Move wall time without running A's renewal timer. This is the suspended
    // Worker case: the claim expires, B takes it, and A later resumes stale.
    vi.setSystemTime(new Date("2026-08-12T00:05:00.000Z"));
    const ownerB = await withTransitionSigningLease(
      t.db,
      { repositoryId: REPO, baseRef: REF, owner: "owner-b" },
      async (claim) => {
        expect(await claim.fence()).toBe(true);
        writes.push("b-sign", "b-record", "b-link");
      },
    );
    expect(ownerB.acquired).toBe(true);

    releaseA();
    await ownerA;
    expect(writes).toEqual(["b-sign", "b-record", "b-link"]);
  });

  it("renews a live owner's claim during a slow operation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const t = testD1();
    open.push(t);
    let releaseA!: () => void;
    let startedA!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const started = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const ownerA = withTransitionSigningLease(
      t.db,
      { repositoryId: REPO, baseRef: REF, owner: "live-owner-a" },
      async () => {
        startedA();
        await held;
      },
    );
    await started;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

    const overlapping = await withTransitionSigningLease(
      t.db,
      { repositoryId: REPO, baseRef: REF, owner: "owner-b" },
      async () => undefined,
    );
    expect(overlapping.acquired).toBe(false);

    releaseA();
    await ownerA;
  });
});
