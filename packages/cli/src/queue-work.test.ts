import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_INTERVAL_SECONDS,
  parseHeartbeatBody,
  runQueueWork,
  watchForOffer,
  type HeartbeatOutcome,
  type WatchPorts,
} from "./queue-work.js";
import { EXIT } from "./queue-exit.js";
// The server's own constants, imported directly rather than restated as a
// literal here — see the comment on HEARTBEAT_INTERVAL_SECONDS in
// queue-work.ts for why a copied number is a number that can drift.
import { GRACE_SECONDS } from "../../../apps/control-plane/src/queue/runners.js";

function ports(overrides: Partial<WatchPorts> = {}): WatchPorts {
  return {
    heartbeat: vi.fn(async (): Promise<HeartbeatOutcome> => ({ ok: true, status: 200, holdsOffer: false })),
    sleep: vi.fn(async () => {}),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("the heartbeat interval stays inside the server's grace window", () => {
  it("is comfortably shorter than GRACE_SECONDS, not merely shorter", () => {
    // "Comfortably" because a grace window only one heartbeat wider than the
    // interval retires a healthy runner on a single missed beat; this asserts
    // room for at least one full extra interval of slack.
    expect(HEARTBEAT_INTERVAL_SECONDS).toBeLessThanOrEqual(GRACE_SECONDS - HEARTBEAT_INTERVAL_SECONDS);
  });
});

describe("parseHeartbeatBody", () => {
  it("reads holdsOffer true", () => {
    expect(parseHeartbeatBody({ holdsOffer: true })).toBe(true);
  });

  it("reads everything else as no offer, never throwing", () => {
    for (const body of [{ holdsOffer: false }, {}, null, undefined, "not json", 42, { holdsOffer: "true" }]) {
      expect(parseHeartbeatBody(body)).toBe(false);
    }
  });
});

describe("watchForOffer", () => {
  it("heartbeats on an interval and stops the moment this principal holds an offer", async () => {
    const heartbeat = vi
      .fn<() => Promise<HeartbeatOutcome>>()
      .mockResolvedValueOnce({ ok: true, status: 200, holdsOffer: false })
      .mockResolvedValueOnce({ ok: true, status: 200, holdsOffer: false })
      .mockResolvedValueOnce({ ok: true, status: 200, holdsOffer: true });
    const sleep = vi.fn(async (ms: number) => {
      expect(ms).toBe(HEARTBEAT_INTERVAL_SECONDS * 1000);
    });
    const outcome = await watchForOffer(ports({ heartbeat, sleep }), vi.fn());

    expect(outcome).toEqual({ kind: "offer" });
    expect(heartbeat).toHaveBeenCalledTimes(3);
    // One sleep between each pair of heartbeats, none after the last.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports a failing heartbeat and retries rather than crashing", async () => {
    const heartbeat = vi
      .fn<() => Promise<HeartbeatOutcome>>()
      .mockResolvedValueOnce({ ok: false, status: 503, holdsOffer: false })
      .mockResolvedValueOnce({ ok: false, status: 0, holdsOffer: false })
      .mockResolvedValueOnce({ ok: true, status: 200, holdsOffer: true });
    const onFailure = vi.fn();

    const outcome = await watchForOffer(ports({ heartbeat, sleep: vi.fn(async () => {}) }), onFailure);

    expect(outcome).toEqual({ kind: "offer" });
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenNthCalledWith(1, 503);
    expect(onFailure).toHaveBeenNthCalledWith(2, 0);
  });

  it("stops as soon as the signal aborts, without waiting out a sleep in progress", async () => {
    const controller = new AbortController();
    const heartbeat = vi.fn(async (): Promise<HeartbeatOutcome> => ({ ok: true, status: 200, holdsOffer: false }));
    // A sleep that never resolves on its own: only the abort listener may end it.
    const sleep = vi.fn(() => new Promise<void>(() => {}));

    const result = watchForOffer(ports({ heartbeat, sleep, signal: controller.signal }), vi.fn());
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled());
    controller.abort();

    await expect(result).resolves.toEqual({ kind: "interrupted" });
  });

  it("never calls heartbeat once the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const heartbeat = vi.fn(async (): Promise<HeartbeatOutcome> => ({ ok: true, status: 200, holdsOffer: false }));

    const outcome = await watchForOffer(ports({ heartbeat, signal: controller.signal }), vi.fn());

    expect(outcome).toEqual({ kind: "interrupted" });
    expect(heartbeat).not.toHaveBeenCalled();
  });
});

describe("runQueueWork", () => {
  it("reports the offer plainly and names the command that takes it", async () => {
    const emit = vi.fn();
    const heartbeat = vi.fn(async (): Promise<HeartbeatOutcome> => ({ ok: true, status: 200, holdsOffer: true }));

    const code = await runQueueWork({ repo: "recallnet/thwip", ports: ports({ heartbeat }), emit });

    expect(code).toBe(EXIT.ok);
    expect(emit).toHaveBeenCalledWith(expect.stringMatching(/holds an offer/));
    // This command watches from outside a checkout, so it cannot run a
    // candidate. It says which command can, rather than claiming an offer it
    // has nowhere to execute.
    expect(emit).toHaveBeenCalledWith(expect.stringMatching(/thwip ship --wait/));
  });

  it("on interrupt, says the machine is no longer available and exits the interrupted code", async () => {
    const controller = new AbortController();
    const emit = vi.fn();
    const heartbeat = vi.fn(async (): Promise<HeartbeatOutcome> => ({ ok: true, status: 200, holdsOffer: false }));
    const sleep = vi.fn(() => new Promise<void>(() => {}));

    const result = runQueueWork({
      repo: "recallnet/thwip",
      ports: ports({ heartbeat, sleep, signal: controller.signal }),
      emit,
    });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled());
    controller.abort();
    const code = await result;

    expect(code).toBe(EXIT.interrupted);
    expect(emit).toHaveBeenCalledWith(expect.stringMatching(/no longer available/));
  });
});
