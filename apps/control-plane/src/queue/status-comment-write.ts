import {
  acknowledgeTerminalEntryStatus,
  trackedTerminalEntries,
  type D1Like,
} from "./projection.js";
import type { QueueSnapshot } from "./queue-operations.js";
import {
  COMMENT_MARKER,
  commentFingerprint,
  commentViews,
  statusCommentBody,
  type CommentView,
} from "./status-comment.js";

/**
 * Putting the comment on the pull request, and keeping it to one.
 *
 * Split from `status-comment.ts` because that file is arithmetic over a
 * snapshot and this one talks to GitHub and to D1. The three calls it needs are
 * a port, so the tests beside it can hold a real GitHub's behaviour without a
 * network: an installation token is a signed JWT and a round trip, and neither
 * is what any of this is about.
 */

/** The three things the App does to a pull request's conversation. */
export interface CommentApi {
  list(pullRequestNumber: number): Promise<Array<{ id: number; body: string }>>;
  create(pullRequestNumber: number, body: string): Promise<number>;
  update(commentId: number, body: string): Promise<void>;
}

/**
 * What happened, so a caller can count it and a log line can name it.
 *
 * `forbidden` is separate from `failed` because it is not a fault and it does
 * not clear on a retry. An installation granted before `issues: write` existed
 * answers 403 to every one of these forever, and it must keep merging.
 */
export type CommentWriteOutcome =
  | "unchanged"
  | "created"
  | "updated"
  | "failed"
  | "forbidden"
  | "over-budget";

/**
 * How many comments one pass over a queue may write.
 *
 * A Worker invocation gets fifty subrequests and each comment costs up to two,
 * against a queue document that keeps every entry it has ever held. On 4 August
 * the sweep tried fourteen and lost the whole tick to the ceiling, taking the
 * lane driving and the chain check with it.
 *
 * Counted in writes, never in entries. A comment that already says the right
 * thing costs nothing and is not counted, so this only ever bounds a genuine
 * backlog, and the backlog drains over a few ticks rather than failing on every
 * one.
 */
export interface CommentBudget {
  remaining: number;
}

/**
 * Publish live entries together with terminal rows already compacted from the
 * authoritative snapshot.
 *
 * The terminal rows live in D1 after their queue-document handoff is
 * acknowledged. Keeping this composition beside the writer gives a failed
 * GitHub edit a durable retry owner even when the next heartbeat sees an empty
 * terminal page and an empty handoff backlog.
 */
export async function writeStatusCommentsForSnapshot(
  db: D1Like,
  api: CommentApi,
  where: { repositoryId: string; baseRef: string },
  snapshot: QueueSnapshot,
  options: { observing: boolean; now: string },
  budget?: CommentBudget,
): Promise<CommentWriteOutcome[]> {
  const currentPullRequests = new Set(snapshot.entries.map((entry) => entry.pullRequestNumber));
  const compactedTerminals = (
    await trackedTerminalEntries(db, where.repositoryId, where.baseRef)
  ).filter((entry) => !currentPullRequests.has(entry.pullRequestNumber));
  const completeSnapshot: QueueSnapshot = {
    ...snapshot,
    entries: [...snapshot.entries, ...compactedTerminals],
    transitions: [
      ...snapshot.transitions,
      ...compactedTerminals.flatMap((entry) =>
        entry.transition === null
          ? []
          : [
              {
                transitionSequence: entry.transition.transitionSequence,
                kind: entry.transition.kind,
                digest: entry.transition.digest,
                priorDigest: entry.transition.priorDigest,
                baseSha: entry.transition.baseSha,
                attemptId: entry.transition.attemptId,
                witnessPrincipalIds: [],
                recordedAt: entry.transition.observedAt,
              },
            ],
      ),
    ],
  };
  const outcomes: CommentWriteOutcome[] = [];
  for (const view of commentViews(completeSnapshot, options)) {
    const outcome = await writeStatusComment(db, api, where, view, options.now, budget);
    outcomes.push(outcome);
    if (
      (view.state === "merged" || view.state === "cancelled" || view.state === "withdrawn-draft") &&
      (outcome === "updated" || outcome === "unchanged")
    ) {
      const entry = compactedTerminals.find((candidate) => candidate.entryId === view.entryId);
      if (entry !== undefined) {
        await acknowledgeTerminalEntryStatus(
          db,
          where.repositoryId,
          where.baseRef,
          entry.entryId,
          entry.fairnessOrdinal,
        );
      }
    }
  }
  return outcomes;
}

/**
 * The states that may open a conversation, as opposed to continue one.
 *
 * Found live on 4 August, on the first tick after this shipped. The queue
 * document keeps every entry it has ever held, so the sweep walked fourteen
 * pull requests that had merged weeks earlier and tried to comment on each of
 * them. It spent the Worker's whole subrequest budget and took the tick down
 * with it, and had GitHub let it through it would have mailed fourteen closed
 * pull requests instead.
 *
 * So an ending is only worth saying to somebody thwip was already talking to. A
 * merged entry with no comment behind it gets nothing, which is also what keeps
 * the sweep's cost proportional to the live queue rather than to its history.
 */
const MAY_SPEAK_FIRST = new Set<CommentView["state"]>([
  "draft",
  "blocked",
  "cooldown",
  "waiting",
  "holds",
  "merging",
  "halted",
]);

interface StoredComment {
  comment_id: number | null;
  fingerprint: string | null;
}

async function stored(
  db: D1Like,
  where: { repositoryId: string; baseRef: string },
  pullRequestNumber: number,
): Promise<StoredComment | null> {
  return db
    .prepare(
      "SELECT comment_id, fingerprint FROM queue_status_comments " +
        "WHERE github_repository_id = ? AND base_ref = ? AND pull_request_number = ?",
    )
    .bind(where.repositoryId, where.baseRef, pullRequestNumber)
    .first<StoredComment>();
}

/**
 * Whether the thing GitHub refused is the permission rather than the request.
 *
 * Read off the status, never off the message. GitHub's wording for this has
 * changed twice and a string match would go quiet the third time, which is the
 * absence-is-a-pass shape: the App would look like it was commenting fine.
 */
function refusedForPermission(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
}

/**
 * Write or edit thwip's one comment on a pull request, and say what it did.
 *
 * Never throws. The caller is a queue that has already decided something, and a
 * comment it could not write is not a reason to fail a merge. It is a reason to
 * say so loudly, which is what the `console.error` calls below are for: this
 * account watches the Worker's own log and nothing else would ever surface it.
 */
export async function writeStatusComment(
  db: D1Like,
  api: CommentApi,
  where: { repositoryId: string; baseRef: string },
  view: CommentView,
  asOf: string,
  /**
   * What this pass has left to spend. Optional because a single transition
   * writes one comment and has a whole invocation to do it in; the sweep is
   * where the budget matters.
   */
  budget?: CommentBudget,
): Promise<CommentWriteOutcome> {
  const removed = await db
    .prepare("SELECT 1 AS found FROM removed_projects WHERE github_repository_id = ? LIMIT 1")
    .bind(where.repositoryId)
    .first<{ found: number }>();
  if (removed !== null) return "unchanged";
  const fingerprint = commentFingerprint(view);
  const record = await stored(db, where, view.pullRequestNumber);

  // Nothing moved. This is the common case on a five-minute tick over a quiet
  // queue, and it has to cost nothing: no listing, no edit, no request at all.
  if (record !== null && record.comment_id !== null && record.fingerprint === fingerprint) {
    return "unchanged";
  }

  // An ending on a page thwip never spoke on. Nothing to close, nobody to tell.
  if (record?.comment_id == null && !MAY_SPEAK_FIRST.has(view.state)) return "unchanged";

  // Checked after the two free answers above, so an unchanged comment never
  // costs a place in the queue behind it.
  if (budget !== undefined && budget.remaining <= 0) return "over-budget";

  const body = statusCommentBody(view, asOf);

  if (budget !== undefined) budget.remaining -= 1;

  try {
    // The id, or the page. A stored id that has gone missing is what produces
    // the second comment, so the fallback is a read of the conversation for the
    // marker rather than a create.
    let commentId = record?.comment_id ?? null;
    if (commentId === null) {
      const existing = await api.list(view.pullRequestNumber);
      commentId = existing.find((comment) => comment.body.includes(COMMENT_MARKER))?.id ?? null;
    }

    let outcome: CommentWriteOutcome;
    if (commentId === null) {
      commentId = await api.create(view.pullRequestNumber, body);
      outcome = "created";
    } else {
      await api.update(commentId, body);
      outcome = "updated";
    }

    // After GitHub accepted it, never before. A fingerprint recorded ahead of
    // the write convinces every later attempt there is nothing to say, and
    // leaves whatever is on the page reading as current.
    await db
      .prepare(
        "INSERT INTO queue_status_comments " +
          "(github_repository_id, base_ref, pull_request_number, comment_id, fingerprint, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (github_repository_id, base_ref, pull_request_number) DO UPDATE SET " +
          "comment_id = excluded.comment_id, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at",
      )
      .bind(where.repositoryId, where.baseRef, view.pullRequestNumber, commentId, fingerprint, asOf)
      .run();
    return outcome;
  } catch (error) {
    if (refusedForPermission(error)) {
      console.error(
        `[queue status comment] GitHub refused the comment on pull request ${view.pullRequestNumber} of ` +
          `repository ${where.repositoryId}. The App is missing issues: write on this installation, so it ` +
          `will publish no status comment until an admin accepts the permission. Merging is unaffected.`,
      );
      return "forbidden";
    }
    console.error(
      `[queue status comment] could not write the comment on pull request ${view.pullRequestNumber} of ` +
        `repository ${where.repositoryId}: ${String(error)}. Whatever is on the page is older than the queue ` +
        `and says so; the next transition writes it again.`,
    );
    return "failed";
  }
}
