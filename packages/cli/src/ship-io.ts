import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EXIT, humanSummary, line, type ExitCode, type Outcome } from "./queue-exit.js";
import { nextShipStep, planInterrupt, reactToReason, type ShipState } from "./ship.js";

const execFileP = promisify(execFile);

/**
 * The I/O half of `thwip ship`. The planner in ship.ts decides; this performs.
 *
 * Keeping them apart matters for one reason above the usual: the loop below runs
 * against a live repository and a live queue, and every decision inside it is
 * already covered by tests that need neither. What is left here is the part that
 * genuinely cannot be tested without them, and it is deliberately thin.
 */

export interface ShipPorts {
  /** Reads the world. Called once per loop turn, because it changes underneath us. */
  observe(): Promise<ShipState>;
  runSuites(): Promise<{ ok: boolean; reasonCode?: string }>;
  /**
   * Reports a refusal rather than throwing one. Attaching the proof rewrote the
   * commit, so a rejected push is an expected outcome of the step before it, and
   * letting git's error escape ended the process on a stack trace and exit 1.
   */
  push(): Promise<{ reasonCode?: string }>;
  /**
   * Opens the pull request, or says it did not. The old signature could only
   * describe success, so a failed `gh pr create` came back as a number nobody
   * looked at and ship carried on to the queue. Null means no open pull request
   * exists, which is a refusal however it happened.
   */
  openOrUpdatePullRequest(): Promise<{ pullRequestNumber: number | null; reasonCode?: string }>;
  joinQueue(): Promise<{ reasonCode?: string }>;
  /**
   * Say this machine is here, so a profile that runs the turn on a device can
   * offer it one. A no-op under a profile the server executes itself.
   *
   * Reports a refusal rather than throwing on one. A queue that will not accept
   * the announcement withholds the offer forever, and the developer sees a wait
   * with no end and no reason — which is exactly how an unannounced ship spent
   * sixty polls looking like a slow queue instead of an invisible machine.
   */
  announcePresence(): Promise<{ refusal?: string }>;
  awaitTurn(): Promise<{ reasonCode?: string }>;
  executeTurn(): Promise<{ reasonCode?: string }>;
  awaitMerge(): Promise<{ reasonCode?: string }>;
  /** Frees the lane on interrupt so the branch is not blocked until a deadline. */
  releaseTurn(): Promise<void>;
}

export interface ShipReport {
  readonly exitCode: ExitCode;
  readonly outcome?: Outcome;
  readonly reasonCode?: string;
}

/**
 * Run the loop until a terminal decision. Bounded, so a bug in a port cannot spin
 * forever: each turn either advances the plan or reports a reason, and a state
 * that stops changing ends the run rather than repeating.
 */
export async function runShip(
  ports: ShipPorts,
  emit: (text: string) => void,
  options: { jsonEvents: boolean; maxTurns?: number },
): Promise<ShipReport> {
  const maxTurns = options.maxTurns ?? 2000;
  const at = () => new Date().toISOString();
  const say = (event: string, reasonCode?: string, detail?: string) => {
    emit(
      options.jsonEvents
        ? line(event, { at: at(), ...(reasonCode === undefined ? {} : { reasonCode }), ...(detail === undefined ? {} : { detail }) })
        : humanSummary({ event, ...(reasonCode === undefined ? {} : { reasonCode }), ...(detail === undefined ? {} : { detail }) }),
    );
  };

  let previous = "";
  let repeats = 0;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const state = await ports.observe();
    const decision = nextShipStep(state);

    if (decision.kind === "done") {
      say(`ship.${decision.outcome.toLowerCase()}`, "PASS");
      return { exitCode: decision.exitCode, outcome: decision.outcome };
    }
    if (decision.kind === "stop") {
      say("ship.stopped", decision.reasonCode, decision.why);
      return { exitCode: decision.exitCode, reasonCode: decision.reasonCode };
    }

    // A plan that keeps returning the same step without the world changing means a
    // port is not doing what it claims. Better to stop and say so than to loop.
    const fingerprint = `${decision.step}:${state.turn}:${state.headProof}:${state.pullRequestNumber ?? "-"}`;
    repeats = fingerprint === previous ? repeats + 1 : 0;
    previous = fingerprint;
    if (repeats > 60) {
      say("ship.stalled", "INTERNAL_FAILURE", `no progress after ${repeats} attempts at ${decision.step}`);
      return { exitCode: EXIT.invariant, reasonCode: "INTERNAL_FAILURE" };
    }

    // Presence is a fact with a short expiry, and both of these steps depend on
    // it: the queue withholds the offer from an absent machine, and refuses a
    // claim from one. Announced here rather than inside the ports so the two
    // steps cannot drift apart, and it costs a `fast` repository nothing — its
    // announcement is a no-op.
    if (decision.step === "await-turn" || decision.step === "execute-turn") {
      const presence = await ports.announcePresence();
      if (presence.refusal !== undefined) say("ship.presence-refused", "AGENT_OFFLINE", presence.refusal);
    }

    say(`ship.${decision.step}`, undefined, decision.why);

    const outcome = await perform(ports, decision.step);
    if (outcome.reasonCode !== undefined) {
      const reaction = reactToReason(outcome.reasonCode, { wait: state.options.wait });
      if (reaction.kind === "stop") {
        say("ship.stopped", reaction.reasonCode, reaction.why);
        return { exitCode: reaction.exitCode, reasonCode: reaction.reasonCode };
      }
      say("ship.waiting", reaction.reasonCode, reaction.why);
    }
  }

  say("ship.stopped", "INTERNAL_FAILURE", `exceeded ${maxTurns} turns`);
  return { exitCode: EXIT.invariant, reasonCode: "INTERNAL_FAILURE" };
}

async function perform(ports: ShipPorts, step: string): Promise<{ reasonCode?: string }> {
  switch (step) {
    case "run-suites": {
      const result = await ports.runSuites();
      return result.ok ? {} : { reasonCode: result.reasonCode ?? "SUITE_FAILED" };
    }
    case "push":
      return ports.push();
    case "open-or-update-pr": {
      const result = await ports.openOrUpdatePullRequest();
      if (result.reasonCode !== undefined) return { reasonCode: result.reasonCode };
      // Having called the step is not evidence that it worked. What counts is a
      // number, and its absence stops the run instead of falling through to the
      // queue.
      return result.pullRequestNumber === null ? { reasonCode: "PR_NOT_OPENED" } : {};
    }
    case "join-queue":
      return ports.joinQueue();
    case "await-turn":
      return ports.awaitTurn();
    case "execute-turn":
      return ports.executeTurn();
    case "await-merge":
      return ports.awaitMerge();
    default:
      return { reasonCode: "INTERNAL_FAILURE" };
  }
}

/**
 * Wire an interrupt to the plan. Registered once, and it releases a held lane
 * before exiting so the branch is not blocked until the execution deadline.
 */
export function installInterruptHandler(
  ports: Pick<ShipPorts, "observe" | "releaseTurn">,
  emit: (text: string) => void,
  options: { jsonEvents: boolean },
): () => void {
  let handling = false;
  const handler = () => {
    if (handling) return;
    handling = true;
    void (async () => {
      const state = await ports.observe().catch(() => null);
      const plan =
        state === null
          ? { outcome: "WATCHING_DETACHED" as Outcome, exitCode: EXIT.interrupted, releaseTurn: false, message: "detached" }
          : planInterrupt(state);
      if (plan.releaseTurn) await ports.releaseTurn().catch(() => {});
      emit(
        options.jsonEvents
          ? line("ship.interrupted", { at: new Date().toISOString(), outcome: plan.outcome, detail: plan.message })
          : `interrupted: ${plan.message}`,
      );
      process.exit(plan.exitCode);
    })();
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

/* ------------------------------------------------------------------ */

/** Git facts the planner needs, read rather than assumed. */
export async function readGitState(cwd: string): Promise<{
  workingTreeClean: boolean;
  headSha: string;
  branch: string;
  pushedHeadMatchesLocal: boolean;
}> {
  const git = async (...args: string[]) => (await execFileP("git", args, { cwd })).stdout.trim();

  const status = await git("status", "--porcelain");
  const headSha = await git("rev-parse", "HEAD");
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");

  // An unset upstream means nothing has been pushed, which is not an error — it is
  // the normal state of a new branch and the next step handles it.
  let pushedHeadMatchesLocal = false;
  try {
    const upstream = await git("rev-parse", `${branch}@{upstream}`);
    pushedHeadMatchesLocal = upstream === headSha;
  } catch {
    pushedHeadMatchesLocal = false;
  }

  return { workingTreeClean: status.length === 0, headSha, branch, pushedHeadMatchesLocal };
}
