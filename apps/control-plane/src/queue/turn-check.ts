import { isReasonCode, nextActionFor } from "@thwip/vocabulary";
import type { QueueSnapshot } from "./queue-operations.js";

/**
 * The check that says whose turn it is.
 *
 * Proof and turn are two different questions about a pull request, and fusing
 * them into one check is what made the queue hard to run. The `thwip` check
 * answers "is this proof good for this tree", which is a fact about the commit
 * and does not change while the commit does not. Whose turn it is changes every
 * time the lane moves, and a single check carrying both answers went red for
 * every pull request that was merely waiting.
 *
 * Red is the wrong colour for waiting, and not only cosmetically. A required
 * check that has failed keeps failing until something re-runs it, so GitHub went
 * on refusing the merge after the queue had authorized it, and the queue then
 * offered the same turn to a pull request that could not take it. The lane
 * rotated between pull requests that each held it for a moment.
 *
 * So waiting is reported as still running. That blocks the merge, which is the
 * point, without claiming anything failed and without leaving a red check behind
 * that somebody has to clear.
 *
 * Waiting is also where the developer finds out why. The queue derives a
 * blocking reason for every entry and used to publish none of it, so a pull
 * request held up by a review and one held up by a conflict both read "waiting
 * for a turn". The sentence for each reason comes from @thwip/vocabulary, which
 * the CLI and the dashboard read as well, so the three surfaces cannot tell a
 * developer three different things about one event.
 *
 * `unplaceable` is the exception, and it exists because this check is required.
 * A pull request the queue cannot place — an author with no activated principal,
 * say — would otherwise get no check at all, and a required check that never
 * arrives blocks the merge forever with nothing on the page to explain it. That
 * one is reported as a failure, because it is one, and because it will not
 * resolve on its own.
 */

/** The check GitHub requires for the turn, alongside `thwip` for the proof. */
export const TURN_CHECK = "thwip / turn";

/**
 * The required check that verifies the proof on a pull request head.
 *
 * Published by .github/workflows/thwip-required.yml, whose job is named `thwip`.
 * A reuse merge rests on this check having passed, so the signed record cites it
 * by run id.
 */
export const PROOF_CHECK = "thwip";

/**
 * The verdict on the integrated candidate, published on the pull request head.
 *
 * Published by the App rather than by the verifier workflow. The workflow asked
 * GitHub for `checks: write` and was refused, because this repository's default
 * workflow permission is read-only, so every passing verification finished as a
 * failed run. The App already holds the permission and already publishes the
 * other two checks, and the verdict reaches it before the workflow ends anyway.
 */
export const CANDIDATE_CHECK = "thwip / candidate";

export type TurnState = "holds" | "waiting" | "halted" | "unplaceable";

/** Entry states in which a pull request owns the lane. */
const HOLDING = new Set(["Offered", "Active", "Verifying", "MergeGuard", "Merging"]);
const FINISHED = new Set(["Merged", "Cancelled"]);

/** Which of the two things that halt a queue happened, since only one waits itself out. */
export type HaltReason = "EXTERNAL_TRANSITION" | "PAUSED";

export interface TurnCheckUpdate {
  readonly entryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly state: TurnState;
  /** How many others are waiting, so the check can say something useful. */
  readonly waiting: number;
  /**
   * What the queue decided is holding this entry up, when something is.
   *
   * Read off the entry, never derived here. Readiness is re-derived from every
   * current fact on every GitHub event, and a check that recomputed its own
   * version of it would eventually disagree with the queue that scheduled it.
   */
  readonly primaryReason?: string | null;
  /** Set only for `halted`. */
  readonly haltReason?: HaltReason | null;
}

export function turnStateOf(snapshot: QueueSnapshot, entryState: string): TurnState {
  if (snapshot.paused || snapshot.rebaselineRequired) return "halted";
  if (snapshot.activeAttemptId !== null && HOLDING.has(entryState)) return "holds";
  return "waiting";
}

/**
 * A branch that moved outside the queue needs a person; an ordinary pause needs
 * an administrator to change their mind. Telling the reader "one or the other"
 * made them go and find out which.
 */
export function haltReasonOf(snapshot: QueueSnapshot): HaltReason {
  return snapshot.rebaselineRequired || snapshot.pauseReason === "EXTERNAL_TRANSITION"
    ? "EXTERNAL_TRANSITION"
    : "PAUSED";
}

/**
 * The plain-language next action for a blocking reason, looked up rather than
 * written here.
 *
 * @thwip/vocabulary holds one sentence per reason and the CLI and the dashboard
 * read the same table, so a developer cannot be told one thing by a check and
 * another by their terminal for the same event. The table is a `Record` over the
 * closed union the queue's vocabulary feeds, so a blocking reason added without
 * a sentence fails to compile.
 *
 * An unrecognized reason is named rather than explained. Inventing guidance for
 * a code this build does not know is worse than quoting it.
 */
export function nextAction(reason: string | null): string | null {
  if (reason === null) return null;
  return isReasonCode(reason) ? nextActionFor(reason, "check") : `Blocked: ${reason}.`;
}

/**
 * A title that names the problem, so the check list on a pull request is
 * readable without opening anything.
 *
 * Exported because the status comment's heading needs the same clause and
 * writing it a second table was how the check, the CLI and the dashboard came
 * apart over the reason sentences. One reason, one short name for it, wherever
 * a person meets it.
 */
export function blockedTitle(reason: string): string {
  switch (reason) {
    case "AGENT_OFFLINE":
    case "NO_COMPATIBLE_RUNNER":
      return "Waiting for a machine";
    case "REVIEW_REQUIRED":
    case "CODEOWNER_REVIEW_REQUIRED":
    case "APPROVAL_AFTER_PUSH_REQUIRED":
      return "Waiting for review";
    case "MERGE_CONFLICT":
      return "Conflict with the base branch";
    case "REQUIRED_CHECK_FAILED":
      return "A required check failed";
    case "VERIFICATION_REJECTED":
      return "The verifier refused the candidate";
    case "REQUIRED_CHECK_PENDING":
      return "Waiting for a required check";
    case "LOCAL_RECEIPT_MISSING":
    case "LOCAL_RECEIPT_REJECTED":
      return "No accepted proof on this commit";
    default:
      return "Not ready to merge";
  }
}

/**
 * What to publish after a command, given what the queue looked like before it.
 *
 * Only what changed. The lane moving affects two pull requests, not the whole
 * queue, and publishing for everyone on every authorization would be a request
 * to GitHub per entry per check — the same shape of mistake as waking the object
 * for reads.
 *
 * A pull request that has finished gets nothing: it merged or it was cancelled,
 * and either way its check has already served its purpose.
 */
/**
 * The check for a pull request the queue cannot place at all.
 *
 * It has no entry, so nothing about it appears in a snapshot and the diff below
 * has nothing to compare. Kept separate rather than special-cased into that diff,
 * and still keyed by commit so a caller can tell whether it has already said this
 * about this commit — publishing on every ask would make a new check run per poll.
 */
/** What the check run should say, given the turn. */
export interface TurnCheckRun {
  readonly status: "in_progress" | "completed";
  readonly conclusion: "success" | "failure" | null;
  readonly title: string;
  readonly summary: string;
}

/**
 * Waiting is reported as still running, not as a failure.
 *
 * A required check that has failed goes on refusing the merge until something
 * re-runs it, so reporting "not your turn" as a failure meant GitHub kept
 * refusing after the queue had authorized. In progress blocks the merge just as
 * firmly and says something true.
 *
 * `unplaceable` is the one failure, because it will not resolve on its own: the
 * author has no activated principal, so the queue has nobody to give a turn to
 * and nothing about waiting longer changes that.
 */
export function turnCheckRun(update: TurnCheckUpdate): TurnCheckRun {
  switch (update.state) {
    case "holds":
      return {
        status: "completed",
        conclusion: "success",
        title: "It is this pull request's turn",
        summary:
          "Thwip Queue has offered this pull request the lane. The merge may proceed while it holds it.",
      };
    case "halted":
      return {
        status: "in_progress",
        conclusion: null,
        title:
          update.haltReason === "EXTERNAL_TRANSITION" ? "The branch moved outside the queue" : "The queue is paused",
        summary:
          update.haltReason === "EXTERNAL_TRANSITION"
            ? "Thwip Queue is not offering turns. The base branch moved outside the queue, so an administrator has to rebaseline before merging resumes."
            : "Thwip Queue is not offering turns. An administrator paused it, and can resume it.",
      };
    case "unplaceable":
      // A bot author is the one unplaceable case with a fix a developer can
      // perform, so it says what that fix is. Everything else here is an
      // activation problem for whoever runs the queue.
      if (update.primaryReason === "SPONSOR_REQUIRED") {
        return {
          status: "completed",
          conclusion: "failure",
          title: "This pull request needs a human sponsor",
          summary:
            "A bot opened this pull request, so no fairness share belongs to it and the queue has nobody to give the turn to. Join the queue for this pull request and you become its sponsor. It will not resolve on its own.",
        };
      }
      return {
        status: "completed",
        conclusion: "failure",
        title: "Thwip Queue cannot place this pull request",
        summary:
          "The author has no activated thwip principal, so the queue has nobody to give the turn to. Activating the author, or having somebody who is activated sponsor the pull request, is what unblocks this. It will not resolve on its own.",
      };
    default: {
      const ahead = Math.max(0, update.waiting - 1);
      const others = `${ahead} other pull request${ahead === 1 ? "" : "s"}`;
      const action = nextAction(update.primaryReason ?? null);

      // Nothing is blocking it, so the only true thing to say is that it is in
      // line. Reporting a problem here would send somebody looking for one.
      if (action === null) {
        return {
          status: "in_progress",
          conclusion: null,
          title: `Waiting for a turn, behind ${others}`,
          summary:
            "Thwip Queue merges one pull request at a time onto this branch. This check completes when it is this pull request's turn; nothing is wrong with it.",
        };
      }

      // Still in progress, however bad the reason. A required check that has
      // failed goes on refusing the merge until something re-runs it, so a
      // blocked pull request that later clears would stay blocked by its own
      // check. Being blocked is a reason to say more, not to go red.
      return {
        status: "in_progress",
        conclusion: null,
        title: blockedTitle(update.primaryReason!),
        summary: [
          action,
          `Thwip Queue merges one pull request at a time onto this branch, with ${others} waiting. That order changes as reviews and checks change.`,
          "This pull request keeps its place in line while this is unresolved.",
        ].join("\n\n"),
      };
    }
  }
}

export function unplaceableUpdate(input: {
  entryId: string;
  pullRequestNumber: number;
  headSha: string;
  /** Why, when the queue knows. `SPONSOR_REQUIRED` is the one a person can clear. */
  reason?: string | null;
}): TurnCheckUpdate {
  return {
    entryId: input.entryId,
    pullRequestNumber: input.pullRequestNumber,
    headSha: input.headSha,
    state: "unplaceable",
    waiting: 0,
    primaryReason: input.reason ?? null,
  };
}

export function turnCheckUpdates(before: QueueSnapshot | null, after: QueueSnapshot): TurnCheckUpdate[] {
  const waiting = after.entries.filter(
    (entry) => !FINISHED.has(entry.state) && turnStateOf(after, entry.state) === "waiting",
  ).length;

  const halted = haltReasonOf(after);

  const updates: TurnCheckUpdate[] = [];
  for (const entry of after.entries) {
    if (FINISHED.has(entry.state)) continue;
    if (entry.headSha === null) continue;

    const now = turnStateOf(after, entry.state);
    const previous = before?.entries.find((e) => e.entryId === entry.entryId);
    // An entry nobody has published for yet needs its first check, and one whose
    // commit has moved needs one against the new commit.
    const unsaid = previous === undefined || previous.headSha !== entry.headSha;
    // The reason is part of what the check says, so it is part of what counts as
    // a change. Comparing turn alone left a pull request whose review landed and
    // whose branch then conflicted reading the sentence about the review, since
    // it had been waiting both times and nothing republished.
    //
    // The waiting count is deliberately not compared. It moves whenever anyone
    // joins or leaves, and publishing the whole queue for that would be one
    // GitHub request per entry per command.
    const said = unsaid
      ? null
      : { state: turnStateOf(before!, previous.state), reason: previous.primaryReason, halt: haltReasonOf(before!) };
    if (said !== null && said.state === now && said.reason === entry.primaryReason && said.halt === halted) continue;

    updates.push({
      entryId: entry.entryId,
      pullRequestNumber: entry.pullRequestNumber,
      headSha: entry.headSha,
      state: now,
      waiting,
      primaryReason: entry.primaryReason,
      haltReason: now === "halted" ? halted : null,
    });
  }
  return updates;
}
