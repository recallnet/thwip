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
 * `unplaceable` is the exception, and it exists because this check is required.
 * A pull request the queue cannot place — an author with no activated principal,
 * say — would otherwise get no check at all, and a required check that never
 * arrives blocks the merge forever with nothing on the page to explain it. That
 * one is reported as a failure, because it is one, and because it will not
 * resolve on its own.
 */

/** The check GitHub requires for the turn, alongside `thwip` for the proof. */
export const TURN_CHECK = "thwip / turn";

export type TurnState = "holds" | "waiting" | "halted" | "unplaceable";

/** Entry states in which a pull request owns the lane. */
const HOLDING = new Set(["Offered", "Active", "Verifying", "MergeGuard", "Merging"]);
const FINISHED = new Set(["Merged", "Cancelled"]);

export interface TurnCheckUpdate {
  readonly entryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly state: TurnState;
  /** How many others are waiting, so the check can say something useful. */
  readonly waiting: number;
}

export function turnStateOf(snapshot: QueueSnapshot, entryState: string): TurnState {
  if (snapshot.paused || snapshot.rebaselineRequired) return "halted";
  if (snapshot.activeAttemptId !== null && HOLDING.has(entryState)) return "holds";
  return "waiting";
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
        title: "The queue is paused",
        summary:
          "Thwip Queue is not offering turns. An administrator paused it, or the base branch moved outside the queue and a rebaseline is pending.",
      };
    case "unplaceable":
      return {
        status: "completed",
        conclusion: "failure",
        title: "Thwip Queue cannot place this pull request",
        summary:
          "The author has no activated thwip principal, so the queue has nobody to give the turn to. Activating the author, or having somebody who is activated sponsor the pull request, is what unblocks this. It will not resolve on its own.",
      };
    default: {
      const ahead = Math.max(0, update.waiting - 1);
      return {
        status: "in_progress",
        conclusion: null,
        title: `Waiting for a turn, behind ${ahead} other pull request${ahead === 1 ? "" : "s"}`,
        summary:
          "Thwip Queue merges one pull request at a time onto this branch. This check completes when it is this pull request's turn; nothing is wrong with it.",
      };
    }
  }
}

export function unplaceableUpdate(input: {
  entryId: string;
  pullRequestNumber: number;
  headSha: string;
}): TurnCheckUpdate {
  return { ...input, state: "unplaceable", waiting: 0 };
}

export function turnCheckUpdates(before: QueueSnapshot | null, after: QueueSnapshot): TurnCheckUpdate[] {
  const waiting = after.entries.filter(
    (entry) => !FINISHED.has(entry.state) && turnStateOf(after, entry.state) === "waiting",
  ).length;

  const updates: TurnCheckUpdate[] = [];
  for (const entry of after.entries) {
    if (FINISHED.has(entry.state)) continue;
    if (entry.headSha === null) continue;

    const now = turnStateOf(after, entry.state);
    const previous = before?.entries.find((e) => e.entryId === entry.entryId);
    // An entry nobody has published for yet needs its first check, and one whose
    // commit has moved needs one against the new commit.
    const was =
      previous === undefined || previous.headSha !== entry.headSha
        ? null
        : turnStateOf(before!, previous.state);
    if (was === now) continue;

    updates.push({
      entryId: entry.entryId,
      pullRequestNumber: entry.pullRequestNumber,
      headSha: entry.headSha,
      state: now,
      waiting,
    });
  }
  return updates;
}
