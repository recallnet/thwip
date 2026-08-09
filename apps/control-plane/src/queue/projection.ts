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

export type ProjectionResult =
  | { readonly applied: true; readonly entries: number; readonly transitions: number }
  | { readonly applied: false; readonly reason: "STALE_GENERATION"; readonly seen: number };

/**
 * Apply a projection message. Idempotent and order-independent: replaying an old
 * message is a no-op, and replaying the current one changes nothing.
 */
export async function projectQueueState(db: D1Like, message: ProjectionMessage): Promise<ProjectionResult> {
  const marker = await db
    .prepare(
      "SELECT MAX(generation) AS generation FROM queue_projection_marks WHERE github_repository_id = ? AND base_ref = ?",
    )
    .bind(message.repositoryId, message.baseRef)
    .first<{ generation: number | null }>();

  const seen = marker?.generation ?? 0;
  // A message from a generation we have already projected tells us nothing new,
  // and applying it would move the projection backwards.
  if (message.generation <= seen) return { applied: false, reason: "STALE_GENERATION", seen };

  const statements: unknown[] = [];

  for (const entry of message.entries) {
    statements.push(
      db
        .prepare(
          `INSERT INTO queue_entries_index (
             id, github_repository_id, base_ref, entry_id, pull_request_number,
             sponsor_principal_id, state, primary_reason, fairness_ordinal,
             scheduler_eligible, cooldown_until, last_attempt_id, head_sha, generation, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT (github_repository_id, base_ref, entry_id) DO UPDATE SET
             state = excluded.state,
             primary_reason = excluded.primary_reason,
             fairness_ordinal = excluded.fairness_ordinal,
             sponsor_principal_id = excluded.sponsor_principal_id,
             scheduler_eligible = excluded.scheduler_eligible,
             cooldown_until = excluded.cooldown_until,
             last_attempt_id = excluded.last_attempt_id,
             head_sha = excluded.head_sha,
             -- Which message last saw this entry in the queue. A row left at an
             -- older generation is one the authority no longer carries, and that
             -- is the only thing anybody can say about it without guessing.
             generation = excluded.generation,
             updated_at = excluded.updated_at`,
        )
        .bind(
          rowKey("qei", message.repositoryId, message.baseRef, entry.entryId),
          message.repositoryId,
          message.baseRef,
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
          message.generation,
        ),
    );
  }

  // Only the links this table has not already got.
  //
  // The chain is append-only and immutable, so re-offering the older links wrote
  // rows that could only ever conflict and do nothing. It also made the write
  // cost of a merge grow with the length of the chain, which is the one number
  // here that never stops rising. One read replaces all of it.
  //
  // Scoped to the epoch: a rebaseline starts the chain again from sequence one,
  // and a high-water mark taken across epochs would discard every link of the new
  // chain until it passed the length of the old one.
  const highest = await db
    .prepare(
      `SELECT MAX(transition_sequence) AS seq FROM queue_transitions_index
        WHERE github_repository_id = ? AND base_ref = ? AND queue_epoch = ?`,
    )
    .bind(message.repositoryId, message.baseRef, message.queueEpoch)
    .first<{ seq: number | null }>();
  const projectedThrough = highest?.seq ?? 0;

  for (const transition of message.transitions) {
    if (transition.transitionSequence <= projectedThrough) continue;
    // Transitions are immutable once recorded, so a conflict means we have already
    // seen this one and there is nothing to change.
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

  const entries = await db
    .prepare(
      `SELECT entry_id, pull_request_number, sponsor_principal_id, state, primary_reason,
              fairness_ordinal, scheduler_eligible, cooldown_until, last_attempt_id, head_sha
         FROM queue_entries_index
        WHERE github_repository_id = ? AND base_ref = ?
        ORDER BY fairness_ordinal`,
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
    }>();

  const transitions = await db
    .prepare(
      `SELECT transition_sequence, kind, digest, prior_digest, base_sha, attempt_id,
              witness_count, observed_at
         FROM queue_transitions_index
        WHERE github_repository_id = ? AND base_ref = ?
        ORDER BY transition_sequence`,
    )
    .bind(repositoryId, baseRef)
    .all<{
      transition_sequence: number;
      kind: string;
      digest: string;
      prior_digest: string | null;
      base_sha: string;
      attempt_id: string | null;
      witness_count: number;
      observed_at: string | null;
    }>();

  const head = transitions.results.at(-1);
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
    chainHead: head === undefined ? null : { sequence: head.transition_sequence, digest: head.digest },
    transitions: transitions.results.map((t) => ({
      transitionSequence: t.transition_sequence,
      kind: t.kind,
      digest: t.digest,
      priorDigest: t.prior_digest,
      baseSha: t.base_sha,
      attemptId: t.attempt_id,
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
  };
}
