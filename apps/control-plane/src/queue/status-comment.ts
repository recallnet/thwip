import { TERMINAL_ENTRY_STATES } from "@thwip/queue-domain";
import type { QueueSnapshot } from "./queue-operations.js";
import { blockedTitle, haltReasonOf, nextAction, type HaltReason } from "./turn-check.js";

/**
 * The one comment thwip keeps on a queued pull request.
 *
 * `thwip / turn` is a check, and a check has a title and a state. That is
 * enough to gate a merge and not enough to tell a person what is happening to
 * their work. A draft that is correctly blocked, an entry fifteen seconds from
 * the end of a cooldown, and an entry that is wedged all render as the same
 * yellow circle. All three were live on this repository at once on 4 August and
 * the middle one was read as the last one, by somebody who could also read the
 * queue's own diagnostics.
 *
 * The queue has known the difference the whole time. `/explain` answers with the
 * entry state, `schedulerEligible`, `primaryReason`, `cooldownUntil` and the
 * fairness ordinal, and none of it reached the page the developer was looking
 * at.
 *
 * One comment, edited in place. GitHub sends no notification for an edit, so the
 * comment can follow the queue as closely as it likes. A comment per transition
 * would mail everybody watching the repository every time a lane moved, and a
 * bot that does that gets uninstalled within the week.
 *
 * Everything here is arithmetic over a snapshot. Nothing reads GitHub, nothing
 * reads a clock it was not handed, and the caller decides what to do with the
 * answer. The publishing side lives in index.ts, next to the App's token.
 */

/**
 * Hidden in every comment the App writes, so it can find its own again.
 *
 * The comment id is stored in D1 and D1 can lose it: a migration, a restore, a
 * row written by a build that has since been rolled back. Scanning for this is
 * what stops a lost id from producing a second comment, which is the one
 * failure that makes a feature like this hated.
 */
export const COMMENT_MARKER = "<!-- thwip:queue-status -->";

/**
 * What the comment is about to say, at the granularity a reader distinguishes.
 *
 * `draft` is split out of `blocked` because it is the single most common reason
 * a pull request sits in this queue doing nothing, and because the person who
 * can clear it is the person reading the comment.
 *
 * `untracked` is not an entry state. It is what the comment says once the queue
 * stops managing the branch, so a comment left behind by a project somebody
 * disabled reports that rather than freezing on the last thing that was true.
 */
export type CommentState =
  | "draft"
  | "blocked"
  | "cooldown"
  | "waiting"
  | "holds"
  | "merging"
  | "halted"
  | "merged"
  | "cancelled"
  | "untracked";

/** Everything the comment renders, decided from the snapshot and nothing else. */
export interface CommentView {
  readonly entryId: string;
  readonly pullRequestNumber: number;
  readonly state: CommentState;
  /**
   * Where in line, counting from one, and how many are in line.
   *
   * Both are null once the entry is off the line. A position for a merged entry
   * would be a number that means nothing, and somebody would read it.
   */
  readonly position: number | null;
  readonly queued: number;
  /** The pull requests ahead of this one, in the order the queue will take them. */
  readonly ahead: readonly number[];
  /** The queue's own blocking reason, never one worked out here. */
  readonly reason: string | null;
  readonly cooldownUntil: string | null;
  readonly haltReason: HaltReason | null;
  /** The chain record this pull request merged as, for a reader who wants it. */
  readonly record: { sequence: number; digest: string } | null;
  /** The repository is enrolled and the queue merges nothing for it yet. */
  readonly observing: boolean;
}

/** States in which the entry owns the lane and something is running on it. */
const RUNNING = new Set(["Offered", "Active", "ReconnectGrace"]);
/** States past the run, where the queue is turning a verdict into a merge. */
const LANDING = new Set(["Verifying", "MergeGuard", "Merging", "Reconciling"]);

function terminal(state: string): boolean {
  return (TERMINAL_ENTRY_STATES as readonly string[]).includes(state);
}

/**
 * Which of the ten this entry is in, given the whole queue around it.
 *
 * Order matters here. A merged entry on a paused queue is merged, and a cooling
 * entry that is also a draft is a draft, because the draft is the thing its
 * author can act on.
 */
function stateOf(
  entry: QueueSnapshot["entries"][number],
  snapshot: QueueSnapshot,
  now: string,
): CommentState {
  if (entry.state === "Merged") return "merged";
  if (entry.state === "Cancelled") return "cancelled";
  if (entry.primaryReason === "PR_DRAFT") return "draft";
  if (snapshot.paused || snapshot.rebaselineRequired) return "halted";
  if (snapshot.activeEntryId === entry.entryId) {
    if (LANDING.has(entry.state)) return "merging";
    if (RUNNING.has(entry.state)) return "holds";
  }
  if (entry.cooldownUntil !== null && entry.cooldownUntil > now) return "cooldown";
  if (!entry.schedulerEligible && entry.primaryReason !== null) return "blocked";
  return "waiting";
}

/**
 * What to say about every entry on one queue.
 *
 * The whole queue, not the entry that moved. A position and a list of who is
 * ahead are facts about the line, so an entry leaving it changes what every
 * entry behind it should say. The caller decides which of these are worth a
 * GitHub call, by comparing fingerprints.
 */
export function commentViews(
  snapshot: QueueSnapshot,
  options: { observing: boolean; now: string },
): CommentView[] {
  const inLine = snapshot.entries.filter((entry) => !terminal(entry.state));
  const halted = haltReasonOf(snapshot);

  return snapshot.entries.map((entry) => {
    const state = stateOf(entry, snapshot, options.now);
    const place = inLine.findIndex((other) => other.entryId === entry.entryId);
    return {
      entryId: entry.entryId,
      pullRequestNumber: entry.pullRequestNumber,
      state,
      position: place === -1 ? null : place + 1,
      queued: inLine.length,
      ahead: place === -1 ? [] : inLine.slice(0, place).map((other) => other.pullRequestNumber),
      reason: entry.primaryReason,
      cooldownUntil: entry.cooldownUntil,
      haltReason: state === "halted" ? halted : null,
      record: state === "merged" ? snapshot.chainHead : null,
      observing: options.observing,
    };
  });
}

/** `21:14:17 UTC`, which is what a person reading a queue actually wants. */
function clock(iso: string): string {
  return `${iso.slice(11, 19)} UTC`;
}

/**
 * The reason code whose sentence answers this state.
 *
 * Every one of these already exists in @thwip/vocabulary, because the check and
 * the CLI and the dashboard all had to say the same things first. Writing a
 * second set here is how those three came apart before, and one event reported
 * two ways sent somebody to fix code that was fine.
 */
function reasonFor(view: CommentView): string | null {
  switch (view.state) {
    case "draft":
      return "PR_DRAFT";
    case "cooldown":
      return "COOLDOWN_ACTIVE";
    case "waiting":
      return "WAITING_FOR_TURN";
    case "holds":
    case "merging":
      return "HOLDS_TURN";
    case "halted":
      return view.haltReason === "EXTERNAL_TRANSITION" ? "REBASELINE_REQUIRED" : "QUEUE_PAUSED";
    case "untracked":
      return "PROJECT_DISABLED";
    case "blocked":
      return view.reason;
    default:
      return null;
  }
}

/** The right-hand side of the heading: one clause naming the situation. */
function headline(view: CommentView): string {
  switch (view.state) {
    case "draft":
      return "blocked · this pull request is a draft";
    case "cooldown":
      return `waiting · cooling down until ${clock(view.cooldownUntil ?? "")}`;
    case "waiting":
      return `position ${view.position} of ${view.queued} · waiting for its turn`;
    case "holds":
      return "its turn · thwip is running the suites";
    case "merging":
      return "its turn · thwip is writing the merge";
    case "halted":
      return view.haltReason === "EXTERNAL_TRANSITION"
        ? "paused · the branch moved outside the queue"
        : "paused · an administrator stopped the queue";
    case "cancelled":
      return "cancelled · this entry left the queue";
    case "untracked":
      return "not queued · thwip no longer manages this branch";
    default:
      // The same short name the check puts in its title, so a reader meeting
      // this reason twice meets one name for it.
      return view.reason === null ? "blocked" : `blocked · ${blockedTitle(view.reason)}`;
  }
}

/**
 * The whole comment, as GitHub markdown.
 *
 * `asOf` is passed rather than read, so the fingerprint below can be taken over
 * everything except the clock. A comment whose only change is the time it was
 * written is a GitHub call spent on nothing, and this account exhausted a daily
 * quota once already.
 */
export function statusCommentBody(view: CommentView, asOf: string): string {
  // Merged is one line. The pull request is done, the reader is gone, and the
  // only thing worth leaving behind is where the signed record for it lives.
  if (view.state === "merged") {
    const record =
      view.record === null
        ? "**thwip** · merged"
        : // The digest carries its algorithm, and slicing the whole string
          // spent eleven of sixteen characters spelling "sha256:". Live on pull
          // request 180 it read `sha256:39966989f`, which names the hash and
          // four bytes of the record.
          `**thwip** · merged as record ${view.record.sequence}, \`${view.record.digest.replace(/^[a-z0-9]+:/, "").slice(0, 16)}\``;
    return `${COMMENT_MARKER}\n${record}\n`;
  }

  const lines = [COMMENT_MARKER, `**thwip** · ${headline(view)}`, ""];

  const reason = reasonFor(view);
  const sentence = reason === null ? null : nextAction(reason);
  if (sentence !== null) lines.push(sentence, "");

  if (view.state === "blocked") {
    lines.push("It keeps its place in line while this is unresolved.", "");
  }

  if (view.ahead.length > 0) {
    lines.push(`Ahead of it: ${view.ahead.map((number) => `#${number}`).join(", ")}.`, "");
  }

  if (view.observing) {
    lines.push("This repository is observing, so thwip reports what it would do and merges nothing.", "");
  }

  lines.push(`_as of ${clock(asOf)}_`);
  return `${lines.join("\n")}\n`;
}

/**
 * A short hash of everything the comment says apart from when it said it.
 *
 * The caller stores this beside the comment id and writes nothing when it
 * matches, so a queue where nothing moved costs zero GitHub calls per tick.
 * FNV-1a, because it runs in a Worker with no imports and nothing here is
 * defending against anybody.
 */
export function commentFingerprint(view: CommentView): string {
  const material = JSON.stringify([
    view.state,
    view.position,
    view.queued,
    view.ahead,
    view.reason,
    view.cooldownUntil,
    view.haltReason,
    view.record,
    view.observing,
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
