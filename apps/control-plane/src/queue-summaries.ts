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
  //
  // Settling is not the only way to leave, either. The authority compacts
  // settled entries out of its document, so an entry that leaves the live set
  // stops appearing in every later message and its row keeps whatever state it
  // was last seen in. Pull request 184 merged on 5 August 2026 while the queue
  // was down, was compacted away before it recorded the outcome, and was still
  // being reported here as the head four days later — `Merging` is not terminal,
  // and it held the lowest ordinal.
  //
  // So a row also has to belong to the newest generation projected for its
  // queue. Nothing guesses at what became of a row that does not: a row at an
  // older generation is one the authority no longer carries, which is all anyone
  // can say without inventing an outcome.
  //
  // `mark.generation IS NULL` is a queue nobody has projected since the column
  // arrived. Refusing those rows would empty the dashboard on the deploy that
  // adds it, so an unprojected queue is trusted whole and the first message
  // after it corrects the set.
  const settled = TERMINAL_ENTRY_STATES.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT e.github_repository_id AS repositoryId,
              e.pull_request_number AS pullRequestNumber,
              e.state AS state,
              e.primary_reason AS primaryReason
         FROM queue_entries_index e
         JOIN projects p ON p.github_repository_id = e.github_repository_id
         LEFT JOIN queue_projection_marks m
                ON m.github_repository_id = e.github_repository_id
               AND m.base_ref = e.base_ref
        WHERE p.organization_id = ?
          AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
          AND NOT EXISTS (
            SELECT 1 FROM project_release_jobs r
             WHERE r.organization_id = p.organization_id
               AND r.github_repository_id = p.github_repository_id
          )
          AND e.state NOT IN (${settled})
          AND (m.generation IS NULL OR e.generation >= m.generation)
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
