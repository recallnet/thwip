import type { D1Like } from "./projection.js";
import { COMMENT_MARKER, commentFingerprint, statusCommentBody, type CommentView } from "./status-comment.js";

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
export type CommentWriteOutcome = "unchanged" | "created" | "updated" | "failed" | "forbidden";

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
): Promise<CommentWriteOutcome> {
  const fingerprint = commentFingerprint(view);
  const record = await stored(db, where, view.pullRequestNumber);

  // Nothing moved. This is the common case on a five-minute tick over a quiet
  // queue, and it has to cost nothing: no listing, no edit, no request at all.
  if (record !== null && record.comment_id !== null && record.fingerprint === fingerprint) {
    return "unchanged";
  }

  const body = statusCommentBody(view, asOf);

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
