import { describe, expect, it } from "vitest";
import { runShip, type ShipPorts } from "./ship-io.js";
import { EXIT } from "./queue-exit.js";
import type { ShipState } from "./ship.js";

/**
 * The loop, driven with fake ports. What matters here is that it cannot spin: a
 * port that reports success without changing anything must end the run with a
 * diagnosis rather than looping against a live queue forever.
 */

function state(over: Partial<ShipState> = {}): ShipState {
  return {
    workingTreeClean: true,
    headProof: "accepted",
    pushedHeadMatchesLocal: true,
    pullRequestNumber: 42,
    queueEntryExists: true,
    turn: "none",
    options: { wait: true, queue: true, jsonEvents: true },
    ...over,
  };
}

/** Ports that walk a scripted sequence of states. */
function scripted(states: ShipState[], over: Partial<ShipPorts> = {}) {
  let i = 0;
  const calls: string[] = [];
  const base: ShipPorts = {
    observe: async () => states[Math.min(i++, states.length - 1)]!,
    runSuites: async () => ({ ok: true }),
    push: async () => ({}),
    openOrUpdatePullRequest: async () => ({ pullRequestNumber: 42 }),
    joinQueue: async () => ({}),
    announcePresence: async () => ({}),
    awaitTurn: async () => ({}),
    executeTurn: async () => ({}),
    awaitMerge: async () => ({}),
    releaseTurn: async () => {},
  };

  // Record around the override, not inside the default. Recording inside would
  // make an overridden port invisible and quietly weaken every assertion about
  // how many times it was called.
  const merged = { ...base, ...over } as ShipPorts;
  const ports = Object.fromEntries(
    (Object.keys(base) as Array<keyof ShipPorts>).map((name) => [
      name,
      async (input: never) => {
        if (name !== "observe") calls.push(name);
        return (merged[name] as (arg: never) => unknown)(input);
      },
    ]),
  ) as unknown as ShipPorts;

  return { ports, calls };
}

function collect() {
  const lines: string[] = [];
  return { emit: (t: string) => void lines.push(t), lines };
}

describe("runShip", () => {
  it("walks to a confirmed merge and reports it once", async () => {
    const { ports } = scripted([
      state({ headProof: "missing" }),
      state({ pushedHeadMatchesLocal: false }),
      state({ pullRequestNumber: null }),
      state({ queueEntryExists: false }),
      state({ turn: "none" }),
      state({ turn: "offered" }),
      state({ turn: "verified" }),
      state({ turn: "merged" }),
    ]);
    const out = collect();
    const report = await runShip(ports, out.emit, { jsonEvents: true });
    expect(report).toMatchObject({ exitCode: EXIT.ok, outcome: "MERGE_CONFIRMED" });
    expect(out.lines.filter((l) => l.includes("merge_confirmed"))).toHaveLength(1);
  });

  it("says this machine is here before waiting for a turn, and again before taking one", async () => {
    // Under `fresh` the queue withholds the offer until a device is present, so
    // a ship that waits without announcing waits for a turn it has made
    // impossible. That is what happened: `queue_runners` stayed empty, the
    // entry sat Ready on AGENT_OFFLINE, and ship stalled on INTERNAL_FAILURE
    // after sixty polls of a queue that was never going to offer it anything.
    // Claiming reads the same presence, so the announcement has to precede the
    // claim too, not only the wait.
    const { ports, calls } = scripted([state({ turn: "none" }), state({ turn: "offered" }), state({ turn: "merged" })]);
    const report = await runShip(ports, collect().emit, { jsonEvents: true });
    expect(report).toMatchObject({ outcome: "MERGE_CONFIRMED" });
    expect(calls).toEqual(["announcePresence", "awaitTurn", "announcePresence", "executeTurn"]);
  });

  it("says out loud when the queue refuses this machine's presence", async () => {
    // The refusal was silent, so a session belonging to one GitHub account and
    // a signing key belonging to another read as a queue that was merely slow.
    const { ports } = scripted([state({ turn: "none" })], {
      announcePresence: async () => ({ refusal: "that device key belongs to somebody else" }),
    });
    const out = collect();
    await runShip(ports, out.emit, { jsonEvents: true, maxTurns: 2 });
    expect(out.lines.some((l) => l.includes("ship.presence-refused") && l.includes("somebody else"))).toBe(true);
  });

  it("ends a refused push with an exit class and a sentence, and joins nothing", async () => {
    // The proof amends HEAD, so a branch already on the remote is rejected as
    // non-fast-forward. That escaped as an unhandled exception: git's output, a
    // stack trace, a dump of the child-process object, and exit 1.
    const { ports, calls } = scripted([state({ pushedHeadMatchesLocal: false })], {
      push: async () => ({ reasonCode: "PUSH_REJECTED" }),
    });
    const out = collect();
    const report = await runShip(ports, out.emit, { jsonEvents: false, maxTurns: 4 });
    expect(report).toMatchObject({ exitCode: EXIT.sourceChanged, reasonCode: "PUSH_REJECTED" });
    expect(out.lines.some((l) => l.includes("Fetch and rebase onto it"))).toBe(true);
    expect(calls).not.toContain("joinQueue");
  });

  it("stops on something a person must fix, without touching the queue further", async () => {
    const { ports, calls } = scripted([state({ turn: "none" })], {
      awaitTurn: async () => ({ reasonCode: "REVIEW_REQUIRED" }),
    });
    const out = collect();
    const report = await runShip(ports, out.emit, { jsonEvents: true });
    expect(report).toMatchObject({ exitCode: EXIT.humanRequired, reasonCode: "REVIEW_REQUIRED" });
    expect(calls.filter((c) => c === "awaitTurn")).toHaveLength(1);
  });

  it("keeps waiting through a lost turn, because the place is kept", async () => {
    let attempts = 0;
    const { ports } = scripted(
      [state({ turn: "none" }), state({ turn: "none" }), state({ turn: "merged" })],
      {
        awaitTurn: async () => {
          attempts += 1;
          return attempts === 1 ? { reasonCode: "EXPIRED_UNCLAIMED" } : {};
        },
      },
    );
    const out = collect();
    const report = await runShip(ports, out.emit, { jsonEvents: true });
    expect(report).toMatchObject({ outcome: "MERGE_CONFIRMED" });
    expect(out.lines.some((l) => l.includes("ship.waiting") && l.includes("EXPIRED_UNCLAIMED"))).toBe(true);
  });

  it("cannot spin when a port reports success but nothing changes", async () => {
    // The failure this guards: a live loop hammering a real queue forever.
    const { ports, calls } = scripted([state({ turn: "none" })]);
    const out = collect();
    const report = await runShip(ports, out.emit, { jsonEvents: true });
    expect(report).toMatchObject({ exitCode: EXIT.invariant, reasonCode: "INTERNAL_FAILURE" });
    expect(out.lines.some((l) => l.includes("ship.stalled"))).toBe(true);
    // It stopped well short of the hard bound. Counted in loop turns, not port
    // calls, because a turn performs more than one call.
    expect(calls.filter((c) => c === "awaitTurn").length).toBeLessThan(100);
  });

  it("respects an explicit turn bound", async () => {
    const { ports } = scripted([state({ turn: "none" })], { awaitTurn: async () => ({}) });
    const out = collect();
    const report = await runShip(ports, out.emit, { jsonEvents: true, maxTurns: 3 });
    expect(report.exitCode).toBe(EXIT.invariant);
  });

  it("emits NDJSON when asked and plain lines otherwise", async () => {
    const json = collect();
    await runShip(scripted([state({ turn: "merged" })]).ports, json.emit, { jsonEvents: true });
    expect(() => JSON.parse(json.lines[0]!)).not.toThrow();

    const plain = collect();
    await runShip(scripted([state({ turn: "merged" })]).ports, plain.emit, { jsonEvents: false });
    expect(() => JSON.parse(plain.lines[0]!)).toThrow();
  });

  it("stops before doing anything when the tree is dirty", async () => {
    const { ports, calls } = scripted([state({ workingTreeClean: false })]);
    const report = await runShip(ports, collect().emit, { jsonEvents: true });
    expect(report).toMatchObject({ reasonCode: "UNCOMMITTED_CHANGES" });
    expect(calls).toEqual([]);
  });

  it("does not run suites when the head already carries an accepted proof", async () => {
    const { ports, calls } = scripted([state({ turn: "merged" })]);
    await runShip(ports, collect().emit, { jsonEvents: true });
    expect(calls).not.toContain("runSuites");
  });

  it("reports a failing suite as a suite failure, not as something to retry", async () => {
    const { ports } = scripted([state({ headProof: "missing" })], {
      runSuites: async () => ({ ok: false, reasonCode: "SUITE_FAILED" }),
    });
    const report = await runShip(ports, collect().emit, { jsonEvents: true });
    expect(report).toMatchObject({ exitCode: EXIT.suiteFailed, reasonCode: "SUITE_FAILED" });
  });

  it("fails when the pull-request step leaves no pull request behind", async () => {
    // Observed: ship pushed, printed ship.queue_requested, and no pull request
    // existed. `gh pr create` failed, its error was thrown away, and the step
    // reported success on the strength of having been called.
    const { ports, calls } = scripted([state({ pullRequestNumber: null })], {
      openOrUpdatePullRequest: async () => ({ pullRequestNumber: null }),
    });
    const out = collect();
    const report = await runShip(ports, out.emit, { jsonEvents: false, maxTurns: 4 });
    expect(report.exitCode).not.toBe(EXIT.ok);
    expect(report.reasonCode).toBe("PR_NOT_OPENED");
    expect(calls).not.toContain("joinQueue");
    expect(out.lines.some((l) => l.includes("PR_NOT_OPENED"))).toBe(true);
  });

  it("carries the reason the pull-request step gives rather than inventing one", async () => {
    const { ports } = scripted([state({ pullRequestNumber: null })], {
      openOrUpdatePullRequest: async () => ({ pullRequestNumber: null, reasonCode: "RATE_LIMITED" }),
    });
    const report = await runShip(ports, collect().emit, { jsonEvents: false, maxTurns: 4 });
    expect(report).toMatchObject({ exitCode: EXIT.rateLimited, reasonCode: "RATE_LIMITED" });
  });

  it("never reports a queue turn it requested for a pull request that was never opened", async () => {
    // The whole defect in one assertion. The states say the pull request is
    // missing and then say the queue holds an entry, which is exactly what a
    // stale number from a merged pull request produced.
    const { ports } = scripted(
      [
        state({ pullRequestNumber: null, options: { wait: false, queue: true, jsonEvents: false } }),
        state({ pullRequestNumber: 167, options: { wait: false, queue: true, jsonEvents: false } }),
      ],
      { openOrUpdatePullRequest: async () => ({ pullRequestNumber: null }) },
    );
    const out = collect();
    const report = await runShip(ports, out.emit, { jsonEvents: false, maxTurns: 4 });
    expect(report.outcome).toBeUndefined();
    expect(out.lines.some((l) => l.includes("queue_requested"))).toBe(false);
  });

  it("stops rather than waiting when --wait was not given", async () => {
    const { ports } = scripted([
      state({ turn: "none", options: { wait: false, queue: true, jsonEvents: true } }),
    ]);
    const report = await runShip(ports, collect().emit, { jsonEvents: true });
    expect(report).toMatchObject({ outcome: "QUEUE_REQUESTED", exitCode: EXIT.ok });
  });
});
