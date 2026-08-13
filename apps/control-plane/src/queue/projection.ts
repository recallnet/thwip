/**
 * D1 projection of queue state.
 *
 * The Durable Object is live authority. D1 exists for reads that span
 * organizations — a dashboard listing every queue, an export, an audit — and it is
 * allowed to lag. What it is not allowed to do is disagree in a way a reader
 * cannot detect, so every projected row carries the generation it came from and a
 * write from an older generation is dropped rather than applied.
 *
 * That ordering rule is the whole design. Projection messages arrive through a
 * queue with at-least-once delivery and no ordering guarantee, so without it a
 * retried older message would overwrite a newer truth and stay wrong until the
 * next change.
 */
import type { QueueSnapshot } from "./queue-operations.js";
import { TERMINAL_RECONCILIATION_CANCEL_REASON } from "./terminal-comment-priority.js";

export interface ProjectionEntry {
  readonly entryId: string;
  readonly pullRequestNumber: number;
  readonly sponsorPrincipalId: string;
  readonly state: string;
  readonly primaryReason: string | null;
  readonly fairnessOrdinal: string;
  readonly schedulerEligible: boolean;
  readonly cooldownUntil: string | null;
  readonly lastAttemptId: string | null;
  readonly headSha: string | null;
}

/** Final state of an entry compacted out of the live queue snapshot. */
export interface TerminalProjectionEntry extends ProjectionEntry {
  readonly generation: number;
  /** This ending repairs a missed GitHub terminal event and publishes first. */
  readonly terminalCommentPriority?: boolean;
}

/** A terminal history row whose existing status comment still needs closing. */
export type TrackedTerminalEntry = QueueSnapshot["entries"][number] & {
  /** Generation at which authority last carried this admission. */
  readonly generation: number;
  readonly terminalCommentPriority: boolean;
  readonly transition: ProjectionTransition | null;
};

export interface ProjectionTransition {
  readonly transitionSequence: number;
  readonly kind: string;
  readonly digest: string;
  readonly priorDigest: string | null;
  readonly baseSha: string;
  readonly attemptId: string | null;
  readonly witnessCount: number;
  /** Null when the object recorded the transition before it tracked the time. */
  readonly observedAt: string | null;
}

export interface ProjectionMessage {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly queueEpoch: number;
  /** The Durable Object generation this snapshot was taken at. */
  readonly generation: number;
  /** Branch-wide facts, so a reader does not need the object to render the page. */
  readonly activeAttemptId: string | null;
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly rebaselineRequired: boolean;
  readonly baseSha: string | null;
  readonly entries: readonly ProjectionEntry[];
  readonly transitions: readonly ProjectionTransition[];
}

export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
  batch(statements: unknown[]): Promise<unknown>;
}

/** Shape authoritative queue state for the cross-queue read projection. */
export function projectionMessageFrom(
  repositoryId: string,
  baseRef: string,
  snapshot: QueueSnapshot,
): ProjectionMessage {
  return {
    repositoryId,
    baseRef,
    queueEpoch: snapshot.queueEpoch,
    generation: snapshot.generation,
    activeAttemptId: snapshot.activeAttemptId,
    paused: snapshot.paused,
    pauseReason: snapshot.pauseReason,
    rebaselineRequired: snapshot.rebaselineRequired,
    baseSha: snapshot.baseSha,
    entries: snapshot.entries.map((entry) => ({
      entryId: entry.entryId,
      pullRequestNumber: entry.pullRequestNumber,
      sponsorPrincipalId: entry.sponsorPrincipalId,
      state: entry.state,
      primaryReason: entry.primaryReason,
      fairnessOrdinal: entry.fairnessOrdinal,
      schedulerEligible: entry.schedulerEligible,
      cooldownUntil: entry.cooldownUntil,
      lastAttemptId: entry.lastAttemptId,
      headSha: entry.headSha,
    })),
    transitions: snapshot.transitions.map((transition) => ({
      transitionSequence: transition.transitionSequence,
      kind: transition.kind,
      digest: transition.digest,
      priorDigest: transition.priorDigest,
      baseSha: transition.baseSha,
      attemptId: transition.attemptId,
      witnessCount: transition.witnessPrincipalIds.length,
      observedAt: transition.recordedAt,
    })),
  };
}

/** One independently selected page of the project Queue view. */
export interface QueuePageRequest {
  readonly entriesPage: number;
  readonly transitionsPage: number;
  readonly pageSize: number;
}

export interface QueuePageInfo {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export function queuePageInfo(page: number, pageSize: number, total: number): QueuePageInfo {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * A projected row's identity must include the base ref. A queue exists per
 * repository *and* base branch, so `main` and `release` can hold entries with the
 * same id, and an identity that omitted the ref would make two independent
 * branches collide on the primary key.
 */
function rowKey(prefix: string, repositoryId: string, baseRef: string, suffix: string): string {
  const ref = baseRef.replace(/^refs\/heads\//, "").replace(/[^A-Za-z0-9._-]/g, "_");
  return `${prefix}_${repositoryId}_${ref}_${suffix}`;
}

function entryProjectionStatement(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  generation: number,
  entry: ProjectionEntry,
  terminalCommentPriority = false,
): unknown {
  return db
    .prepare(
      `INSERT INTO queue_entries_index (
         id, github_repository_id, base_ref, entry_id, pull_request_number,
         sponsor_principal_id, state, primary_reason, fairness_ordinal,
         scheduler_eligible, cooldown_until, last_attempt_id, head_sha, generation,
         terminal_comment_priority, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (github_repository_id, base_ref, entry_id) DO UPDATE SET
         state = excluded.state,
         primary_reason = excluded.primary_reason,
         fairness_ordinal = excluded.fairness_ordinal,
         sponsor_principal_id = excluded.sponsor_principal_id,
         scheduler_eligible = excluded.scheduler_eligible,
         cooldown_until = excluded.cooldown_until,
         last_attempt_id = excluded.last_attempt_id,
         head_sha = excluded.head_sha,
         terminal_comment_priority = CASE
           -- A projection replay cannot erase an unacknowledged repair. A
           -- reopened nonterminal admission may clear it, and an explicit
           -- comment acknowledgement below is the other clearing path.
           WHEN excluded.state IN ('Merged', 'Cancelled')
            AND queue_entries_index.terminal_comment_priority IN (1, 2)
            AND excluded.terminal_comment_priority = 0
            AND excluded.fairness_ordinal = queue_entries_index.fairness_ordinal
             THEN queue_entries_index.terminal_comment_priority
           ELSE excluded.terminal_comment_priority
         END,
         -- Which message last saw this entry in the queue. A row left at an
         -- older generation is one the authority no longer carries, and that
         -- is the only thing anybody can say about it without guessing.
         generation = excluded.generation,
         updated_at = excluded.updated_at
       WHERE excluded.generation >= queue_entries_index.generation`,
    )
    .bind(
      rowKey("qei", repositoryId, baseRef, entry.entryId),
      repositoryId,
      baseRef,
      entry.entryId,
      entry.pullRequestNumber,
      entry.sponsorPrincipalId,
      entry.state,
      entry.primaryReason,
      entry.fairnessOrdinal,
      entry.schedulerEligible ? 1 : 0,
      entry.cooldownUntil,
      entry.lastAttemptId,
      entry.headSha,
      generation,
      terminalCommentPriority ? 1 : 0,
    );
}

/**
 * Persist final states that compaction removed from the live snapshot.
 *
 * This deliberately does not advance the projection mark. These rows are
 * history and carry a generation below current authority, so queue reads omit
 * them while the status publisher can still close the conversation it opened.
 */
export async function projectTerminalEntryHistory(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  entries: readonly TerminalProjectionEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.batch(
    entries.map((entry) =>
      entryProjectionStatement(
        db,
        repositoryId,
        baseRef,
        entry.generation,
        entry,
        entry.terminalCommentPriority === true,
      ),
    ),
  );
}

/**
 * Recover the one deploy-window gap that existed before terminal handoffs were
 * stored in queue authority.
 *
 * The terminal event is still authoritative. D1 supplies only the entry fields
 * that the event no longer carries, and only for a stale row whose status
 * comment proves there is something to retire. Current admissions are fenced
 * by both entry id and pull request number.
 */
export async function terminalEntryHistoryFromRecentEvents(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  currentEntries: readonly ProjectionEntry[],
  events: readonly { sequence: number; type: string; body: unknown }[],
): Promise<TerminalProjectionEntry[]> {
  const newestFirst = [...events].sort((left, right) => right.sequence - left.sequence);
  const attemptEntryIds = new Map<string, string>();
  for (const event of newestFirst) {
    if (event.type !== "TurnOffered") continue;
    const body = event.body as { attemptId?: unknown; entryId?: unknown };
    if (typeof body.attemptId === "string" && typeof body.entryId === "string") {
      attemptEntryIds.set(body.attemptId, body.entryId);
    }
  }
  const terminalEvents = new Map<
    string,
    { sequence: number; state: "Merged" | "Cancelled"; attemptId: string | null }
  >();
  const settledAdmissions = new Set<string>();
  for (const event of newestFirst) {
    if (event.type === "MergeConfirmed") {
      const body = event.body as { attemptId?: unknown };
      if (typeof body.attemptId === "string") {
        const entryId = attemptEntryIds.get(body.attemptId);
        if (entryId !== undefined) settledAdmissions.add(entryId);
      }
      continue;
    }
    if (event.type === "QueueRequested") {
      const body = event.body as { entryId?: unknown; resetOrdinal?: unknown };
      if (body.resetOrdinal === true && typeof body.entryId === "string") {
        // One entry id is stable across close/reopen admissions. A newer
        // re-request is an admission boundary, so no older repair may describe
        // the row now projected for the new fairness ordinal.
        settledAdmissions.add(body.entryId);
      }
      continue;
    }
    if (event.type !== "EntryMergeReconciled" && event.type !== "EntryCancelled") continue;
    const body = event.body as {
      entryId?: unknown;
      attemptId?: unknown;
      actorPrincipalId?: unknown;
      reason?: unknown;
    };
    if (typeof body.entryId !== "string" || settledAdmissions.has(body.entryId)) continue;
    // The newest terminal event wins even when it is ordinary and therefore
    // earns no repair priority. Recording the admission before qualification
    // prevents an older repair of the same stable entry id leaking forward.
    settledAdmissions.add(body.entryId);
    if (event.type === "EntryMergeReconciled" && typeof body.attemptId !== "string") continue;
    if (
      event.type === "EntryCancelled" &&
      (body.actorPrincipalId !== "github" ||
        body.reason !== TERMINAL_RECONCILIATION_CANCEL_REASON)
    ) {
      continue;
    }
    terminalEvents.set(body.entryId, {
      sequence: event.sequence,
      state: event.type === "EntryMergeReconciled" ? "Merged" : "Cancelled",
      attemptId: event.type === "EntryMergeReconciled" ? (body.attemptId as string) : null,
    });
  }
  if (terminalEvents.size === 0) return [];
  const eventEntryIds = [...terminalEvents.keys()];

  type LegacyTerminalRow = {
    entry_id: string;
    pull_request_number: number;
    sponsor_principal_id: string;
    primary_reason: string | null;
    fairness_ordinal: string;
    scheduler_eligible: number;
    cooldown_until: string | null;
    last_attempt_id: string | null;
    head_sha: string | null;
    generation: number;
    terminal_comment_priority: number;
  };
  const rows: LegacyTerminalRow[] = [];
  // D1 accepts at most 100 bound parameters in one statement. Repository and
  // ref spend two, and a fixed page of 50 leaves room if this lookup grows.
  for (let offset = 0; offset < eventEntryIds.length; offset += 50) {
    const entryIds = eventEntryIds.slice(offset, offset + 50);
    const page = await db
      .prepare(
        `SELECT e.entry_id, e.pull_request_number, e.sponsor_principal_id,
                e.primary_reason, e.fairness_ordinal, e.scheduler_eligible,
                e.cooldown_until, e.last_attempt_id, e.head_sha, e.generation,
                e.terminal_comment_priority
           FROM queue_entries_index e
           JOIN queue_status_comments c
             ON c.github_repository_id = e.github_repository_id
            AND c.base_ref = e.base_ref
            AND c.pull_request_number = e.pull_request_number
           JOIN queue_projection_marks m
             ON m.github_repository_id = e.github_repository_id
            AND m.base_ref = e.base_ref
          WHERE e.github_repository_id = ? AND e.base_ref = ?
            AND e.generation < m.generation
            AND e.entry_id IN (${entryIds.map(() => "?").join(", ")})`,
      )
      .bind(repositoryId, baseRef, ...entryIds)
      .all<LegacyTerminalRow>();
    rows.push(...page.results);
  }
  const liveEntryIds = new Set(currentEntries.map((entry) => entry.entryId));
  const livePullRequests = new Set(currentEntries.map((entry) => entry.pullRequestNumber));
  return rows.flatMap((row) => {
    const event = terminalEvents.get(row.entry_id);
    if (
      event === undefined ||
      row.head_sha === null ||
      liveEntryIds.has(row.entry_id) ||
      livePullRequests.has(row.pull_request_number) ||
      row.terminal_comment_priority === 2
    ) {
      return [];
    }
    return [
      {
        generation: row.generation,
        entryId: row.entry_id,
        pullRequestNumber: row.pull_request_number,
        sponsorPrincipalId: row.sponsor_principal_id,
        state: event.state,
        primaryReason: row.primary_reason,
        fairnessOrdinal: row.fairness_ordinal,
        schedulerEligible: false,
        cooldownUntil: row.cooldown_until,
        lastAttemptId: event.attemptId ?? row.last_attempt_id,
        headSha: row.head_sha,
        terminalCommentPriority: true,
      },
    ];
  });
}

/**
 * Remove terminal handoff rows that have no status conversation left to close.
 * A current admission of the same pull request also supersedes the old ending.
 */
export async function pruneTerminalEntryHistory(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM queue_entries_index AS terminal
        WHERE terminal.github_repository_id = ? AND terminal.base_ref = ?
          AND terminal.state IN ('Merged', 'Cancelled')
          AND terminal.generation < (
            SELECT generation FROM queue_projection_marks
             WHERE github_repository_id = terminal.github_repository_id
               AND base_ref = terminal.base_ref
          )
          AND (
            terminal.terminal_comment_priority = 2
            OR
            NOT EXISTS (
              SELECT 1 FROM queue_status_comments c
               WHERE c.github_repository_id = terminal.github_repository_id
                 AND c.base_ref = terminal.base_ref
                 AND c.pull_request_number = terminal.pull_request_number
            )
            OR EXISTS (
              SELECT 1 FROM queue_entries_index current
               JOIN queue_projection_marks m
                 ON m.github_repository_id = current.github_repository_id
                AND m.base_ref = current.base_ref
               WHERE current.github_repository_id = terminal.github_repository_id
                 AND current.base_ref = terminal.base_ref
                 AND current.pull_request_number = terminal.pull_request_number
                 AND current.generation = m.generation
                 AND current.state NOT IN ('Merged', 'Cancelled')
            )
          )`,
    )
    .bind(repositoryId, baseRef)
    .run();
}

/** A terminal comment is current, so history retires and retained priority clears. */
export async function acknowledgeTerminalEntryStatus(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  entryId: string,
  fairnessOrdinal: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM queue_entries_index
        WHERE github_repository_id = ? AND base_ref = ?
          AND entry_id = ? AND fairness_ordinal = ?
          AND state IN ('Merged', 'Cancelled')
          AND generation < (
            SELECT generation FROM queue_projection_marks
             WHERE github_repository_id = ? AND base_ref = ?
          )`,
      )
      .bind(repositoryId, baseRef, entryId, fairnessOrdinal, repositoryId, baseRef),
    db
      .prepare(
        `UPDATE queue_entries_index
            SET terminal_comment_priority = 0
          WHERE github_repository_id = ? AND base_ref = ?
            AND entry_id = ? AND fairness_ordinal = ?
            AND state IN ('Merged', 'Cancelled')`,
      )
      .bind(repositoryId, baseRef, entryId, fairnessOrdinal),
  ]);
}

/**
 * A permission refusal acknowledges repair priority without discarding retry.
 *
 * GitHub will keep refusing until an installation administrator accepts the
 * permission, so retrying this row would starve later terminal history. State
 * 2 is not priority; it is a durable no-op acknowledgement that prevents both
 * publication retry and deploy-window recovery from marking the row again.
 */
export async function acknowledgeTerminalEntryStatusForbidden(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  entryId: string,
  fairnessOrdinal: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE queue_entries_index
          SET terminal_comment_priority = 2
        WHERE github_repository_id = ? AND base_ref = ?
          AND entry_id = ? AND fairness_ordinal = ?
          AND state IN ('Merged', 'Cancelled')`,
    )
    .bind(repositoryId, baseRef, entryId, fairnessOrdinal)
    .run();
}

/** Repaired terminal admissions, including rows still in live authority. */
export async function terminalCommentRepairState(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<{ priority: Set<string>; acknowledged: Set<string> }> {
  const rows = await db
    .prepare(
      `SELECT e.entry_id, e.terminal_comment_priority
         FROM queue_entries_index e
         JOIN queue_status_comments c
           ON c.github_repository_id = e.github_repository_id
          AND c.base_ref = e.base_ref
          AND c.pull_request_number = e.pull_request_number
        WHERE e.github_repository_id = ? AND e.base_ref = ?
          AND e.state IN ('Merged', 'Cancelled')
          AND e.terminal_comment_priority IN (1, 2)
          AND NOT EXISTS (
            SELECT 1 FROM queue_entries_index current
             JOIN queue_projection_marks m
               ON m.github_repository_id = current.github_repository_id
              AND m.base_ref = current.base_ref
             WHERE current.github_repository_id = e.github_repository_id
               AND current.base_ref = e.base_ref
               AND current.pull_request_number = e.pull_request_number
               AND current.generation = m.generation
               AND current.state NOT IN ('Merged', 'Cancelled')
          )`,
    )
    .bind(repositoryId, baseRef)
    .all<{ entry_id: string; terminal_comment_priority: number }>();
  return {
    priority: new Set(
      rows.results.filter((row) => row.terminal_comment_priority === 1).map((row) => row.entry_id),
    ),
    acknowledged: new Set(
      rows.results.filter((row) => row.terminal_comment_priority === 2).map((row) => row.entry_id),
    ),
  };
}

/**
 * Terminal history that may still have a live queue-status comment.
 *
 * The anti-join is the reopen fence. A new admission of the same pull request
 * must keep its current status; an older terminal row must never overwrite it.
 */
export async function trackedTerminalEntries(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<TrackedTerminalEntry[]> {
  const rows = await db
    .prepare(
      `SELECT e.entry_id, e.pull_request_number, e.sponsor_principal_id, e.state,
              e.primary_reason, e.fairness_ordinal, e.scheduler_eligible,
              e.cooldown_until, e.last_attempt_id, e.head_sha, e.generation,
              e.terminal_comment_priority,
              t.transition_sequence, t.kind AS transition_kind, t.digest,
              t.prior_digest, t.base_sha AS transition_base_sha,
              t.witness_count, t.observed_at
         FROM queue_entries_index e
         JOIN queue_status_comments c
           ON c.github_repository_id = e.github_repository_id
          AND c.base_ref = e.base_ref
          AND c.pull_request_number = e.pull_request_number
         JOIN queue_projection_marks m
           ON m.github_repository_id = e.github_repository_id
          AND m.base_ref = e.base_ref
         LEFT JOIN queue_transitions_index t
           ON t.github_repository_id = e.github_repository_id
          AND t.base_ref = e.base_ref
          AND t.queue_epoch = m.queue_epoch
          AND t.attempt_id = e.last_attempt_id
        WHERE e.github_repository_id = ? AND e.base_ref = ?
          AND e.state IN ('Merged', 'Cancelled')
          AND e.terminal_comment_priority <> 2
          AND e.generation < m.generation
          AND NOT EXISTS (
            SELECT 1 FROM queue_entries_index current
             WHERE current.github_repository_id = e.github_repository_id
               AND current.base_ref = e.base_ref
               AND current.pull_request_number = e.pull_request_number
               AND current.generation = m.generation
               AND current.state NOT IN ('Merged', 'Cancelled')
          )
        ORDER BY length(e.fairness_ordinal), e.fairness_ordinal, e.entry_id`,
    )
    .bind(repositoryId, baseRef)
    .all<{
      entry_id: string;
      pull_request_number: number;
      sponsor_principal_id: string;
      state: string;
      primary_reason: string | null;
      fairness_ordinal: string;
      scheduler_eligible: number;
      cooldown_until: string | null;
      last_attempt_id: string | null;
      head_sha: string | null;
      generation: number;
      terminal_comment_priority: number;
      transition_sequence: number | null;
      transition_kind: string | null;
      digest: string | null;
      prior_digest: string | null;
      transition_base_sha: string | null;
      witness_count: number | null;
      observed_at: string | null;
    }>();
  return rows.results.map((row) => ({
    entryId: row.entry_id,
    pullRequestNumber: row.pull_request_number,
    sponsorPrincipalId: row.sponsor_principal_id,
    state: row.state,
    primaryReason: row.primary_reason as TrackedTerminalEntry["primaryReason"],
    fairnessOrdinal: row.fairness_ordinal,
    schedulerEligible: row.scheduler_eligible === 1,
    cooldownUntil: row.cooldown_until,
    lastAttemptId: row.last_attempt_id,
    headSha: row.head_sha,
    generation: row.generation,
    terminalCommentPriority: row.terminal_comment_priority === 1,
    transition:
      row.transition_sequence === null ||
      row.transition_kind === null ||
      row.digest === null ||
      row.transition_base_sha === null
        ? null
        : {
            transitionSequence: row.transition_sequence,
            kind: row.transition_kind,
            digest: row.digest,
            priorDigest: row.prior_digest,
            baseSha: row.transition_base_sha,
            attemptId: row.last_attempt_id,
            witnessCount: row.witness_count ?? 0,
            observedAt: row.observed_at,
          },
  }));
}

export type ProjectionResult =
  | { readonly applied: true; readonly entries: number; readonly transitions: number }
  | { readonly applied: false; readonly reason: "STALE_GENERATION"; readonly seen: number }
  | { readonly applied: false; readonly reason: "PROJECT_REMOVED"; readonly seen: 0 };

/**
 * Apply a projection message. Idempotent and order-independent: replaying an old
 * message is a no-op, and replaying the current one changes nothing.
 */
export async function projectQueueState(db: D1Like, message: ProjectionMessage): Promise<ProjectionResult> {
  const removed = await db
    .prepare("SELECT 1 AS found FROM removed_projects WHERE github_repository_id = ? LIMIT 1")
    .bind(message.repositoryId)
    .first<{ found: number }>();
  if (removed !== null) return { applied: false, reason: "PROJECT_REMOVED", seen: 0 };
  const marker = await db
    .prepare(
      "SELECT MAX(generation) AS generation FROM queue_projection_marks WHERE github_repository_id = ? AND base_ref = ?",
    )
    .bind(message.repositoryId, message.baseRef)
    .first<{ generation: number | null }>();

  const seen = marker?.generation ?? 0;
  // A message from a generation we have already projected tells us nothing new,
  // and applying it would move the projection backwards.
  if (message.generation < seen) return { applied: false, reason: "STALE_GENERATION", seen };

  const statements: unknown[] = [];

  for (const entry of message.entries) {
    statements.push(entryProjectionStatement(db, message.repositoryId, message.baseRef, message.generation, entry));
  }

  for (const transition of message.transitions) {
    // Transitions are immutable once recorded, so a conflict means we have already
    // seen this one and there is nothing to change. Re-offering the bounded live
    // tail also repairs a missing row when the authoritative queue write landed
    // but its projection did not. A high-water mark cannot do that because one
    // missing row below a later row looks complete from MAX(sequence).
    statements.push(
      db
        .prepare(
          `INSERT INTO queue_transitions_index (
             id, github_repository_id, base_ref, queue_epoch, transition_sequence,
             kind, digest, prior_digest, base_sha, attempt_id, witness_count, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (github_repository_id, base_ref, queue_epoch, transition_sequence) DO NOTHING`,
        )
        .bind(
          rowKey("qti", message.repositoryId, message.baseRef, `${message.queueEpoch}_${transition.transitionSequence}`),
          message.repositoryId,
          message.baseRef,
          message.queueEpoch,
          transition.transitionSequence,
          transition.kind,
          transition.digest,
          transition.priorDigest,
          transition.baseSha,
          transition.attemptId,
          transition.witnessCount,
          transition.observedAt,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO queue_projection_marks (
           github_repository_id, base_ref, generation, projected_at,
           active_attempt_id, paused, pause_reason, rebaseline_required, base_sha, queue_epoch
         ) VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)
         ON CONFLICT (github_repository_id, base_ref) DO UPDATE SET
           generation = excluded.generation,
           projected_at = excluded.projected_at,
           active_attempt_id = excluded.active_attempt_id,
           paused = excluded.paused,
           pause_reason = excluded.pause_reason,
           rebaseline_required = excluded.rebaseline_required,
           base_sha = excluded.base_sha,
           queue_epoch = excluded.queue_epoch`,
      )
      .bind(
        message.repositoryId,
        message.baseRef,
        message.generation,
        message.activeAttemptId,
        message.paused ? 1 : 0,
        message.pauseReason,
        message.rebaselineRequired ? 1 : 0,
        message.baseSha,
        message.queueEpoch,
      ),
  );

  await db.batch(statements);
  return { applied: true, entries: message.entries.length, transitions: message.transitions.length };
}

/**
 * Answer a queue read from the projection.
 *
 * Shaped exactly like the object's snapshot, so a caller cannot tell the two
 * apart except by `source`. That matters: the dashboard renders one component
 * either way, and a second shape would be a second thing to keep correct.
 *
 * Returns null when nothing has been projected for this branch yet, which is a
 * different answer from an empty queue and has to stay distinguishable.
 */
export async function readProjectedQueue(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  pages?: QueuePageRequest,
): Promise<Record<string, unknown> | null> {
  const mark = await db
    .prepare(
      `SELECT generation, queue_epoch, active_attempt_id, paused, pause_reason,
              rebaseline_required, base_sha, projected_at
         FROM queue_projection_marks WHERE github_repository_id = ? AND base_ref = ?`,
    )
    .bind(repositoryId, baseRef)
    .first<{
      generation: number;
      queue_epoch: number;
      active_attempt_id: string | null;
      paused: number;
      pause_reason: string | null;
      rebaseline_required: number;
      base_sha: string | null;
      projected_at: string;
    }>();
  if (mark === null) return null;

  type EntryRow = {
      entry_id: string;
      pull_request_number: number;
      sponsor_principal_id: string;
      state: string;
      primary_reason: string | null;
      fairness_ordinal: string;
      scheduler_eligible: number;
      cooldown_until: string | null;
      last_attempt_id: string | null;
      head_sha: string | null;
  };

  const currentEntryWhere = "github_repository_id = ? AND base_ref = ? AND generation = ?";
  const pagedEntryWhere = `${currentEntryWhere} AND state NOT IN ('Merged', 'Cancelled')`;
  const entryCount = pages === undefined
    ? null
    : await db
        .prepare(`SELECT COUNT(*) AS total FROM queue_entries_index WHERE ${pagedEntryWhere}`)
        .bind(repositoryId, baseRef, mark.generation)
        .first<{ total: number }>();
  const entries = pages === undefined
    ? await db
        .prepare(
          `SELECT entry_id, pull_request_number, sponsor_principal_id, state, primary_reason,
                  fairness_ordinal, scheduler_eligible, cooldown_until, last_attempt_id, head_sha
             FROM queue_entries_index
            WHERE ${currentEntryWhere}
            ORDER BY length(fairness_ordinal), fairness_ordinal, entry_id`,
        )
        .bind(repositoryId, baseRef, mark.generation)
        .all<EntryRow>()
    : await db
        .prepare(
          `SELECT entry_id, pull_request_number, sponsor_principal_id, state, primary_reason,
                  fairness_ordinal, scheduler_eligible, cooldown_until, last_attempt_id, head_sha
             FROM queue_entries_index
            WHERE ${pagedEntryWhere}
            ORDER BY length(fairness_ordinal), fairness_ordinal, entry_id
            LIMIT ? OFFSET ?`,
        )
        .bind(
          repositoryId,
          baseRef,
          mark.generation,
          pages.pageSize,
          (pages.entriesPage - 1) * pages.pageSize,
        )
        .all<EntryRow>();

  type TransitionRow = {
      transition_sequence: number;
      kind: string;
      digest: string;
      prior_digest: string | null;
      base_sha: string;
      attempt_id: string | null;
      witness_count: number;
      observed_at: string | null;
      pull_request_number: number | null;
  };

  const currentTransitionWhere = "t.github_repository_id = ? AND t.base_ref = ? AND t.queue_epoch = ?";
  const legacyTransitionWhere = "t.github_repository_id = ? AND t.base_ref = ?";
  const transitionCount = pages === undefined
    ? null
    : await db
        .prepare(
          `SELECT COUNT(*) AS total FROM queue_transitions_index AS t WHERE ${currentTransitionWhere}`,
        )
        .bind(repositoryId, baseRef, mark.queue_epoch)
        .first<{ total: number }>();
  const transitionColumns =
    `SELECT t.transition_sequence, t.kind, t.digest, t.prior_digest, t.base_sha, t.attempt_id,
            t.witness_count, t.observed_at,
            (SELECT e.pull_request_number
               FROM queue_entries_index AS e
              WHERE e.github_repository_id = t.github_repository_id
                AND e.base_ref = t.base_ref
                AND e.last_attempt_id = t.attempt_id
              ORDER BY e.generation DESC
              LIMIT 1) AS pull_request_number
       FROM queue_transitions_index AS t`;
  const transitions = pages === undefined
    ? await db
        .prepare(`${transitionColumns} WHERE ${legacyTransitionWhere} ORDER BY t.queue_epoch, t.transition_sequence`)
        .bind(repositoryId, baseRef)
        .all<TransitionRow>()
    : await db
        .prepare(`${transitionColumns} WHERE ${currentTransitionWhere} ORDER BY t.transition_sequence DESC LIMIT ? OFFSET ?`)
        .bind(
          repositoryId,
          baseRef,
          mark.queue_epoch,
          pages.pageSize,
          (pages.transitionsPage - 1) * pages.pageSize,
        )
        .all<TransitionRow>();

  // The requested history page might not contain the head. Read it separately
  // so paging can never make the queue report an older chain position.
  const head = await db
    .prepare(
      `SELECT transition_sequence, digest
         FROM queue_transitions_index
        WHERE github_repository_id = ? AND base_ref = ? AND queue_epoch = ?
        ORDER BY transition_sequence DESC
        LIMIT 1`,
    )
    .bind(repositoryId, baseRef, mark.queue_epoch)
    .first<{ transition_sequence: number; digest: string }>();
  return {
    source: "projection",
    projectedAt: mark.projected_at,
    generation: mark.generation,
    queueEpoch: mark.queue_epoch,
    attemptRevision: 0,
    paused: mark.paused === 1,
    pauseReason: mark.pause_reason,
    rebaselineRequired: mark.rebaseline_required === 1,
    baseSha: mark.base_sha,
    activeAttemptId: mark.active_attempt_id,
    activeEntryId: null,
    chainHead: head === null ? null : { sequence: head.transition_sequence, digest: head.digest },
    transitions: transitions.results.map((t) => ({
      transitionSequence: t.transition_sequence,
      kind: t.kind,
      digest: t.digest,
      priorDigest: t.prior_digest,
      baseSha: t.base_sha,
      attemptId: t.attempt_id,
      pullRequestNumber: t.pull_request_number,
      witnessPrincipalIds: [],
      recordedAt: t.observed_at,
    })),
    entries: entries.results.map((e) => ({
      entryId: e.entry_id,
      pullRequestNumber: e.pull_request_number,
      sponsorPrincipalId: e.sponsor_principal_id,
      state: e.state,
      primaryReason: e.primary_reason,
      schedulerEligible: e.scheduler_eligible === 1,
      fairnessOrdinal: e.fairness_ordinal,
      cooldownUntil: e.cooldown_until,
      lastAttemptId: e.last_attempt_id,
      headSha: e.head_sha,
    })),
    ...(pages === undefined
      ? {}
      : {
          pagination: {
            entries: queuePageInfo(pages.entriesPage, pages.pageSize, entryCount?.total ?? 0),
            transitions: queuePageInfo(pages.transitionsPage, pages.pageSize, transitionCount?.total ?? 0),
          },
        }),
  };
}
