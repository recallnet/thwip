import { TERMINAL_ENTRY_STATES } from "@thwip/queue-domain";
import type { D1Like } from "./queue/projection.js";

/**
 * One line of queue per repository, for the page that lists them all.
 *
 * Read from the projection rather than from each branch's Durable Object. That
 * is what the projection is for, in the words of the migration that created it:
 * D1 serves "reads that span organizations — a dashboard listing every queue".
 * The alternative is one object request per repository per page view, and the
 * refresh in `Queue.tsx` is already throttled to thirty seconds because that
 * spending is real.
 *
 * It may lag, which is the correct trade here. This is a summary that links to
 * the live view; nothing decides a merge from it.
 */

export interface QueueSummary {
  readonly githubRepositoryId: string;
  /** Entries that have not settled. The row a merge leaves behind is not one. */
  readonly waiting: number;
  readonly head: {
    readonly pullRequestNumber: number;
    readonly state: string;
    readonly primaryReason: string | null;
  } | null;
}

interface Row {
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly state: string;
  readonly primaryReason: string | null;
}

export async function queueSummaries(db: D1Like, organizationId: string): Promise<QueueSummary[]> {
  // The projection only ever upserts, so every entry a repository has ever had
  // keeps its row in the state it settled in. Counting rows would report a
  // repository that merged forty pull requests as forty waiting, forever.
  const settled = TERMINAL_ENTRY_STATES.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT e.github_repository_id AS repositoryId,
              e.pull_request_number AS pullRequestNumber,
              e.state AS state,
              e.primary_reason AS primaryReason
         FROM queue_entries_index e
         JOIN projects p ON p.github_repository_id = e.github_repository_id
        WHERE p.organization_id = ?
          AND e.state NOT IN (${settled})
        ORDER BY e.github_repository_id, e.fairness_ordinal`,
    )
    .bind(organizationId, ...TERMINAL_ENTRY_STATES)
    .all<Row>();

  // Ordered by the queue's own fairness ordinal, so the first row of each
  // repository is the entry the lane would reach next. That is the same order
  // the branch's own queue view reads.
  const summaries: QueueSummary[] = [];
  for (const row of results) {
    const last = summaries[summaries.length - 1];
    if (last !== undefined && last.githubRepositoryId === row.repositoryId) {
      summaries[summaries.length - 1] = { ...last, waiting: last.waiting + 1 };
      continue;
    }
    summaries.push({
      githubRepositoryId: row.repositoryId,
      waiting: 1,
      head: {
        pullRequestNumber: row.pullRequestNumber,
        state: row.state,
        primaryReason: row.primaryReason,
      },
    });
  }
  return summaries;
}
