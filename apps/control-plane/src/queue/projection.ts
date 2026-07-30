/**
 * D1 projection of queue state (plan.md §41.3).
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
             sponsor_principal_id, state, primary_reason, fairness_ordinal, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT (github_repository_id, base_ref, entry_id) DO UPDATE SET
             state = excluded.state,
             primary_reason = excluded.primary_reason,
             fairness_ordinal = excluded.fairness_ordinal,
             sponsor_principal_id = excluded.sponsor_principal_id,
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
        ),
    );
  }

  for (const transition of message.transitions) {
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
        `INSERT INTO queue_projection_marks (github_repository_id, base_ref, generation, projected_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT (github_repository_id, base_ref) DO UPDATE SET
           generation = excluded.generation, projected_at = excluded.projected_at`,
      )
      .bind(message.repositoryId, message.baseRef, message.generation),
  );

  await db.batch(statements);
  return { applied: true, entries: message.entries.length, transitions: message.transitions.length };
}

/**
 * Is the projection behind, and by how much? Surfaced so a reader can be told
 * "this may be up to N generations stale" rather than being quietly misled.
 */
export async function projectionLag(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  liveGeneration: number,
): Promise<{ projected: number; live: number; behind: number }> {
  const row = await db
    .prepare(
      "SELECT generation FROM queue_projection_marks WHERE github_repository_id = ? AND base_ref = ?",
    )
    .bind(repositoryId, baseRef)
    .first<{ generation: number }>();
  const projected = row?.generation ?? 0;
  return { projected, live: liveGeneration, behind: Math.max(0, liveGeneration - projected) };
}
