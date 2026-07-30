import { EXIT, exitCodeFor, isRetryable, type ExitCode, type Outcome } from "./queue-exit.js";

/**
 * `thwip ship` (plan.md §30.1, §30.4.1).
 *
 * One command for the whole path: run the required suites, sign a proof, push,
 * request a queue turn, execute the turn when it arrives, and wait for the merge.
 *
 * The sequencing is a pure planner so it can be tested without a repository, a
 * network, or a queue. What the planner decides is only ever "what next", never
 * "what happened" — the caller performs the step and reports the result back.
 *
 * Interrupt safety is a design constraint, not an afterthought. Ctrl-C at any
 * point must leave the durable queue request intact, because a developer who
 * loses their place for pressing Ctrl-C will stop using the queue.
 */

export type ShipStep =
  | "check-auth"
  | "check-clean-tree"
  | "run-suites"
  | "push"
  | "open-or-update-pr"
  | "join-queue"
  | "await-turn"
  | "execute-turn"
  | "await-merge"
  | "done";

export interface ShipState {
  readonly authenticated: boolean;
  /** Uncommitted changes; the proof binds a committed tree, so this must be clean. */
  readonly workingTreeClean: boolean;
  /** Whether HEAD already carries an accepted proof for its exact tree. */
  readonly headProof: "accepted" | "missing" | "stale";
  readonly pushedHeadMatchesLocal: boolean;
  readonly pullRequestNumber: number | null;
  readonly queueEntryExists: boolean;
  readonly turn: "none" | "offered" | "claimed" | "running" | "verified" | "merging" | "merged";
  /** --wait, --no-queue and --json-events. */
  readonly options: { readonly wait: boolean; readonly queue: boolean; readonly jsonEvents: boolean };
}

export type ShipDecision =
  | { readonly kind: "step"; readonly step: ShipStep; readonly why: string }
  | { readonly kind: "done"; readonly outcome: Outcome; readonly exitCode: ExitCode }
  | { readonly kind: "stop"; readonly reasonCode: string; readonly exitCode: ExitCode; readonly why: string };

/**
 * The next thing to do. Deterministic, so two runs from the same state agree and
 * an interrupted run resumes at the same place rather than starting over.
 */
export function nextShipStep(state: ShipState): ShipDecision {
  if (!state.authenticated) {
    return {
      kind: "stop",
      reasonCode: "LOGIN_REQUIRED",
      exitCode: EXIT.authRequired,
      why: "run `thwip login` in your own terminal; it needs your browser",
    };
  }

  // A proof binds a committed tree. Signing with a dirty tree would attest to
  // something no reviewer can see, so this is refused rather than worked around.
  if (!state.workingTreeClean) {
    return {
      kind: "stop",
      reasonCode: "UNCOMMITTED_CHANGES",
      exitCode: EXIT.usage,
      why: "commit or stash your changes; a proof binds the committed tree",
    };
  }

  if (state.headProof !== "accepted") {
    return {
      kind: "step",
      step: "run-suites",
      why: state.headProof === "missing" ? "this commit carries no proof" : "the proof does not match this tree",
    };
  }

  if (!state.pushedHeadMatchesLocal) {
    return { kind: "step", step: "push", why: "the remote does not have this commit yet" };
  }

  if (state.pullRequestNumber === null) {
    return { kind: "step", step: "open-or-update-pr", why: "no pull request exists for this branch" };
  }

  // --no-queue stops here: the proof is attached and pushed, which is a complete
  // and useful outcome on its own.
  if (!state.options.queue) {
    return { kind: "done", outcome: "PR_UPDATED", exitCode: EXIT.ok };
  }

  if (!state.queueEntryExists) {
    return { kind: "step", step: "join-queue", why: "not yet in the queue for this branch" };
  }

  // Without --wait, requesting the turn is the terminal outcome. The queue will
  // offer a turn later; the developer does not have to sit here.
  if (!state.options.wait) {
    return { kind: "done", outcome: "QUEUE_REQUESTED", exitCode: EXIT.ok };
  }

  switch (state.turn) {
    case "none":
      return { kind: "step", step: "await-turn", why: "waiting for a fair turn" };
    case "offered":
      return { kind: "step", step: "execute-turn", why: "a turn was offered to this device" };
    case "claimed":
    case "running":
      return { kind: "step", step: "execute-turn", why: "integrating the exact candidate" };
    case "verified":
    case "merging":
      return { kind: "step", step: "await-merge", why: "verified; waiting for the merge to confirm" };
    case "merged":
      return { kind: "done", outcome: "MERGE_CONFIRMED", exitCode: EXIT.ok };
  }
}

/**
 * How to react when a step reports a reason code. The queue distinguishes losing
 * a turn from losing your place, so ship keeps waiting in the first case and stops
 * in the second (plan.md §30.7).
 */
export type ShipReaction =
  | { readonly kind: "keep-waiting"; readonly reasonCode: string; readonly why: string }
  | { readonly kind: "stop"; readonly reasonCode: string; readonly exitCode: ExitCode; readonly why: string };

export function reactToReason(reasonCode: string, options: { wait: boolean }): ShipReaction {
  const exitCode = exitCodeFor(reasonCode);

  // A lost turn keeps the entry. While waiting, that is not a failure — it is the
  // queue doing its job, and stopping would throw away the place in line.
  if (options.wait && exitCode === EXIT.turnLost) {
    return { kind: "keep-waiting", reasonCode, why: "the turn was lost but your place was not" };
  }
  if (options.wait && isRetryable(reasonCode) && exitCode !== EXIT.rateLimited) {
    return { kind: "keep-waiting", reasonCode, why: "transient; the queue will offer another turn" };
  }

  return { kind: "stop", reasonCode, exitCode, why: stopExplanation(reasonCode, exitCode) };
}

function stopExplanation(reasonCode: string, exitCode: ExitCode): string {
  switch (exitCode) {
    case EXIT.humanRequired:
      return "a person has to act; retrying will not help";
    case EXIT.repairRequired:
      return `fix the branch, then run \`thwip ship --wait\` again (${reasonCode})`;
    case EXIT.sourceChanged:
      return "the source changed; a new turn needs a new proof";
    case EXIT.ambiguous:
      return "the merge outcome is unknown; the queue is reconciling and will not write again";
    case EXIT.evidenceRejected:
      return "the evidence was refused; `thwip verify` explains why";
    case EXIT.suiteFailed:
      return "a required suite failed";
    case EXIT.invariant:
      return "an invariant disagreed; this needs a human, not a retry";
    case EXIT.rateLimited:
      return "rate limited by the provider";
    default:
      return reasonCode;
  }
}

/**
 * What an interrupt means (plan.md §30.6). Detaching is always safe; the durable
 * entry survives, and an in-flight turn is released rather than abandoned so the
 * lane does not stay held until its deadline.
 */
export interface InterruptPlan {
  readonly outcome: Outcome;
  readonly exitCode: ExitCode;
  /** True when the queue must be told, so the lane is freed immediately. */
  readonly releaseTurn: boolean;
  readonly message: string;
}

export function planInterrupt(state: ShipState): InterruptPlan {
  const holdingLane = ["claimed", "running", "verified"].includes(state.turn);

  if (state.turn === "merging" || state.turn === "merged") {
    // Never interrupt across a merge write: the outcome has to be resolved, and
    // walking away from it is what creates an ambiguous state.
    return {
      outcome: "MERGE_CONFIRMED",
      exitCode: EXIT.interrupted,
      releaseTurn: false,
      message: "the merge is already in progress; leaving it to finish and reconcile",
    };
  }

  if (holdingLane) {
    return {
      outcome: "WATCHING_DETACHED",
      exitCode: EXIT.interrupted,
      releaseTurn: true,
      message: "released the turn so the branch is not blocked; your place in line is kept",
    };
  }

  return {
    outcome: "WATCHING_DETACHED",
    exitCode: EXIT.interrupted,
    releaseTurn: false,
    message: state.queueEntryExists
      ? "detached; you are still queued and will be offered a turn"
      : "detached",
  };
}

/** Human-readable one-liner for a decision, for the non-JSON output mode. */
export function describeDecision(decision: ShipDecision): string {
  switch (decision.kind) {
    case "step":
      return `${decision.step}: ${decision.why}`;
    case "done":
      return decision.outcome;
    case "stop":
      return `${decision.reasonCode}: ${decision.why}`;
  }
}
