import { EXIT, type ExitCode } from "./queue-exit.js";

/**
 * `thwip queue work --watch`.
 *
 * Under `fresh` and `audited` there is no GitHub Actions fallback: a turn goes
 * to a connected developer machine or it goes nowhere. This is the client half
 * of "connected" — it says this machine is here, on an interval, and notices
 * the moment the server reports this principal holds an offer.
 *
 * Claiming the offer, materializing the candidate and signing an integration
 * receipt belong to `thwip ship --wait`, which runs in the checkout being
 * integrated (fresh-turn.ts). This command has no checkout to run against, so
 * it reports the offer and names the command that takes it.
 */

/**
 * How often this machine says it is here.
 *
 * Chosen well inside the server's grace window — `GRACE_SECONDS` in
 * `apps/control-plane/src/queue/runners.ts` — so a couple of slow round trips
 * never let a healthy machine read as gone. That file is the source of truth
 * for the window; `queue-work.test.ts` asserts this constant against it
 * directly rather than restating the server's number here, because a literal
 * copied once is a literal that can drift the next time either side changes.
 */
export const HEARTBEAT_INTERVAL_SECONDS = 15;

export interface HeartbeatOutcome {
  readonly ok: boolean;
  /** 0 when the request never reached the network. */
  readonly status: number;
  readonly holdsOffer: boolean;
}

export type HeartbeatCaller = () => Promise<HeartbeatOutcome>;

export interface WatchPorts {
  readonly heartbeat: HeartbeatCaller;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal;
}

export type WatchOutcome = { readonly kind: "offer" } | { readonly kind: "interrupted" };

/**
 * Waits until either this principal holds an offer or `ports.signal` aborts.
 *
 * A failing heartbeat — network down, 5xx, an expired session — is reported
 * through `onFailure` and retried on the next tick. It never throws out of the
 * loop: the point of this command is presence, and one bad poll is not grounds
 * to stop announcing this machine to a queue that may still offer it work once
 * the network recovers.
 */
export async function watchForOffer(ports: WatchPorts, onFailure: (status: number) => void): Promise<WatchOutcome> {
  while (!ports.signal.aborted) {
    const outcome = await ports.heartbeat();
    if (ports.signal.aborted) return { kind: "interrupted" };
    if (!outcome.ok) {
      onFailure(outcome.status);
    } else if (outcome.holdsOffer) {
      return { kind: "offer" };
    }
    await sleepUnlessAborted(ports);
  }
  return { kind: "interrupted" };
}

/** Sleeps for one interval, but returns the moment the signal aborts rather than waiting it out. */
function sleepUnlessAborted(ports: WatchPorts): Promise<void> {
  if (ports.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => resolve();
    ports.signal.addEventListener("abort", onAbort, { once: true });
    void ports.sleep(HEARTBEAT_INTERVAL_SECONDS * 1000).then(() => {
      ports.signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * Parses `POST .../runners/heartbeat`'s `{ holdsOffer: boolean }` body.
 * Anything else — a malformed body, a body from a future version this build
 * does not know — reads as "no offer", never as a crash.
 */
export function parseHeartbeatBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  return (body as Record<string, unknown>)["holdsOffer"] === true;
}

/** Builds a heartbeat call against the real control plane. Never throws. */
export function realHeartbeat(
  endpoint: string,
  auth: string,
  repositoryId: string,
  deviceKeyId: string,
): HeartbeatCaller {
  return async () => {
    try {
      const res = await fetch(`${endpoint}/v1/queue/${repositoryId}/runners/heartbeat`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ deviceKeyId }),
      });
      if (!res.ok) return { ok: false, status: res.status, holdsOffer: false };
      const body = await res.json().catch(() => null);
      return { ok: true, status: res.status, holdsOffer: parseHeartbeatBody(body) };
    } catch {
      return { ok: false, status: 0, holdsOffer: false };
    }
  };
}

export interface RunQueueWorkOptions {
  readonly repo: string;
  readonly ports: WatchPorts;
  readonly emit: (text: string) => void;
}

/**
 * The full behavior of `thwip queue work --watch`: announce, watch, and report
 * plainly which of the two ways it stopped — an offer arrived, or the operator
 * (or their laptop's lid) interrupted it.
 */
export async function runQueueWork(options: RunQueueWorkOptions): Promise<ExitCode> {
  options.emit(`[thwip] watching for a turn on ${options.repo}; heartbeating every ${HEARTBEAT_INTERVAL_SECONDS}s`);
  const outcome = await watchForOffer(options.ports, (status) => {
    options.emit(`[thwip] heartbeat failed (${status === 0 ? "network unreachable" : status}); retrying`);
  });
  if (outcome.kind === "offer") {
    options.emit(
      `[thwip] this machine holds an offer for ${options.repo}. Run thwip ship --wait in the checkout ` +
        "you want integrated, which claims the offer and runs the candidate the queue names.",
    );
    return EXIT.ok;
  }
  options.emit(`[thwip] no longer available for ${options.repo}; any queued work keeps its place in line`);
  return EXIT.interrupted;
}
