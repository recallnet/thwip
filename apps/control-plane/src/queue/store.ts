import {
  applyEvent,
  assertInvariants,
  emptyState,
  QueueRuleViolation,
  selectNext,
  type BranchQueueState,
  type EligibleEntry,
  type QueueEvent,
} from "@thwip/queue-domain";
import { initSchema, type SqlLike } from "./sql.js";

/**
 * Durable state for one branch queue.
 *
 * The reducer in @thwip/queue-domain decides what an event means; this store
 * decides how that meaning survives a restart. The SQL tables are the snapshot,
 * not a cache of a replayable log: §39.4 compacts event bodies while keeping
 * their sequence and digest, so replaying the log is not a recovery strategy.
 *
 * Every accepted command writes the snapshot change, the event, any outbox item,
 * and the earliest deadline in one pass, and nothing is written when the reducer
 * rejects the command (plan.md §39.1).
 */

export type DeadlineKind = "offer" | "execution" | "grace" | "merge-confirm" | "readiness";

export interface Deadline {
  readonly kind: DeadlineKind;
  readonly attemptId: string;
  readonly dueAt: string;
}

export interface OutboxItem {
  readonly kind: string;
  readonly attemptId?: string;
  readonly operationId?: string;
  readonly payload: unknown;
}

export interface PendingOutbox extends OutboxItem {
  readonly outboxId: number;
  readonly attemptRevision: number;
  readonly attempts: number;
}

export interface AppendOptions {
  readonly setDeadlines?: readonly Deadline[];
  readonly clearDeadlines?: ReadonlyArray<{ kind: DeadlineKind; attemptId: string }>;
  readonly outbox?: readonly OutboxItem[];
  /**
   * Set when the command changes a fact the active attempt depends on: base,
   * head, candidate, policy, runner authorization, reviews, pause state,
   * assignment, receipt, or chain head (plan.md §39.2).
   */
  readonly bumpAttemptRevision?: boolean;
}

export type AppendResult =
  | { readonly status: "applied"; readonly sequence: number; readonly generation: number; readonly attemptRevision: number }
  | { readonly status: "duplicate"; readonly sequence: number; readonly generation: number; readonly attemptRevision: number }
  | { readonly status: "rejected"; readonly detail: string };

/**
 * Event as submitted: the store assigns the sequence. Omit has to distribute
 * over the union, or the type collapses to the fields every event shares and
 * every command loses its own payload.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SubmittedEvent = DistributiveOmit<QueueEvent, "sequence">;

/** How many recent idempotency keys stay resident for deduplication. */
const DEDUPE_WINDOW = 512;

interface MetaRow {
  generation: number;
  active_attempt_revision: number;
  queue_epoch: number;
  last_sequence: number;
  turn_sequence: string;
  ordinal_sequence: string;
  paused: number;
  pause_reason: string | null;
  rebaseline_required: number;
  base_sha: string | null;
  active_attempt_id: string | null;
  chain_head_digest: string | null;
  chain_head_sequence: number;
  activation_state: string;
  active_config_digest: string | null;
}

export class BranchQueueStore {
  private cached: BranchQueueState | null = null;

  private constructor(
    private readonly sql: SqlLike,
    readonly queueKey: string,
    readonly repositoryId: string,
    readonly baseRef: string,
  ) {}

  static open(
    sql: SqlLike,
    identity: { queueKey: string; repositoryId: string; baseRef: string },
  ): BranchQueueStore {
    initSchema(sql);
    const rows = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM queue_meta").toArray();
    if ((rows[0]?.c ?? 0) === 0) {
      sql.exec(
        "INSERT INTO queue_meta (id, queue_key, repository_id, base_ref) VALUES (1, ?, ?, ?)",
        identity.queueKey,
        identity.repositoryId,
        identity.baseRef,
      );
    }
    return new BranchQueueStore(sql, identity.queueKey, identity.repositoryId, identity.baseRef);
  }

  /** Rehydrated state. Cheap after the first call; correct after an eviction. */
  state(): BranchQueueState {
    if (this.cached !== null) return this.cached;
    this.cached = this.rehydrate();
    return this.cached;
  }

  generation(): number {
    return this.meta().generation;
  }

  attemptRevision(): number {
    return this.meta().active_attempt_revision;
  }

  private meta(): MetaRow {
    const rows = this.sql.exec<MetaRow>("SELECT * FROM queue_meta WHERE id = 1").toArray();
    const row = rows[0];
    if (row === undefined) throw new Error("branch queue meta row is missing");
    return row;
  }

  private rehydrate(): BranchQueueState {
    const meta = this.meta();
    const state = emptyState(this.queueKey, this.repositoryId, this.baseRef);
    state.lastSequence = meta.last_sequence;
    state.turnSequence = BigInt(meta.turn_sequence);
    state.ordinalSequence = BigInt(meta.ordinal_sequence);
    state.paused = meta.paused === 1;
    state.pauseReason = meta.pause_reason;
    state.rebaselineRequired = meta.rebaseline_required === 1;
    state.baseSha = meta.base_sha;
    state.activeAttemptId = meta.active_attempt_id;

    for (const row of this.sql
      .exec<{
        entry_id: string;
        pull_request_number: number;
        sponsor_principal_id: string;
        sponsor_github_user_id: string;
        fairness_ordinal: string;
        state: string;
        primary_reason: string | null;
        secondary_reasons: string;
        scheduler_eligible: number;
        cooldown_until: string | null;
        head_sha: string;
        current_attempt_id: string | null;
        last_attempt_id: string | null;
      }>("SELECT * FROM entries")
      .toArray()) {
      state.entries.set(row.entry_id, {
        entryId: row.entry_id,
        pullRequestNumber: row.pull_request_number,
        sponsorPrincipalId: row.sponsor_principal_id,
        sponsorGithubUserId: row.sponsor_github_user_id,
        fairnessOrdinal: BigInt(row.fairness_ordinal),
        state: row.state as BranchQueueState["entries"] extends Map<string, infer E>
          ? E extends { state: infer S }
            ? S
            : never
          : never,
        primaryReason: row.primary_reason as never,
        secondaryReasons: JSON.parse(row.secondary_reasons) as never,
        schedulerEligible: row.scheduler_eligible === 1,
        cooldownUntil: row.cooldown_until,
        headSha: row.head_sha,
        currentAttemptId: row.current_attempt_id,
        lastAttemptId: row.last_attempt_id,
      });
    }

    for (const row of this.sql
      .exec<{ attempt_id: string; body: string }>("SELECT attempt_id, body FROM attempts")
      .toArray()) {
      state.attempts.set(row.attempt_id, JSON.parse(row.body) as never);
    }

    for (const row of this.sql
      .exec<{ principal_id: string; last_served_turn: string; fairness_debt: string | null }>(
        "SELECT * FROM principals",
      )
      .toArray()) {
      state.lastServedTurn.set(row.principal_id, BigInt(row.last_served_turn));
      if (row.fairness_debt !== null) {
        state.fairnessDebt.set(row.principal_id, JSON.parse(row.fairness_debt) as string[]);
      }
    }

    for (const row of this.sql
      .exec<{
        transition_sequence: number;
        kind: string;
        prior_digest: string | null;
        digest: string;
        base_sha: string;
        attempt_id: string | null;
        witnesses: string;
      }>("SELECT * FROM transitions ORDER BY transition_sequence")
      .toArray()) {
      state.transitions.push({
        kind: row.kind as never,
        transitionSequence: row.transition_sequence,
        priorDigest: row.prior_digest,
        digest: row.digest,
        baseSha: row.base_sha,
        attemptId: row.attempt_id,
        witnessPrincipalIds: JSON.parse(row.witnesses) as string[],
      });
    }

    for (const row of this.sql
      .exec<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM inbox_dedupe ORDER BY sequence DESC LIMIT ?",
        DEDUPE_WINDOW,
      )
      .toArray()) {
      state.appliedKeys.add(row.idempotency_key);
    }

    return state;
  }

  /**
   * Apply one event. Nothing is written unless the reducer accepts it and the
   * resulting state satisfies every invariant.
   */
  append(event: SubmittedEvent, options: AppendOptions = {}): AppendResult {
    const before = this.state();

    const seen = this.sql
      .exec<{ sequence: number; result: string }>(
        "SELECT sequence, result FROM inbox_dedupe WHERE idempotency_key = ?",
        event.idempotencyKey,
      )
      .toArray()[0];
    if (seen !== undefined) {
      const meta = this.meta();
      return {
        status: "duplicate",
        sequence: seen.sequence,
        generation: meta.generation,
        attemptRevision: meta.active_attempt_revision,
      };
    }

    const sequence = before.lastSequence + 1;
    const full = { ...event, sequence } as QueueEvent;

    let next: BranchQueueState;
    try {
      next = applyEvent(before, full);
      assertInvariants(next);
    } catch (error) {
      if (error instanceof QueueRuleViolation) return { status: "rejected", detail: error.message };
      throw error;
    }

    // A reducer that returned the same object means the event was a no-op; it
    // still consumes its idempotency key so a retry does not re-evaluate it.
    const meta = this.meta();
    const generation = meta.generation + 1;
    const attemptRevision = meta.active_attempt_revision + (options.bumpAttemptRevision === true ? 1 : 0);

    this.sql.exec(
      "INSERT INTO events (sequence, idempotency_key, at, type, body, generation) VALUES (?, ?, ?, ?, ?, ?)",
      sequence,
      event.idempotencyKey,
      event.at,
      event.type,
      JSON.stringify(full),
      generation,
    );
    this.sql.exec(
      "INSERT INTO inbox_dedupe (idempotency_key, sequence, result, recorded_at) VALUES (?, ?, ?, ?)",
      event.idempotencyKey,
      sequence,
      "applied",
      event.at,
    );
    this.sql.exec(
      "DELETE FROM inbox_dedupe WHERE idempotency_key IN (SELECT idempotency_key FROM inbox_dedupe ORDER BY sequence DESC LIMIT -1 OFFSET ?)",
      DEDUPE_WINDOW,
    );

    this.persist(next, generation, attemptRevision);
    this.applyDeadlines(options);
    this.enqueueOutbox(options.outbox ?? [], attemptRevision, event.at);

    this.cached = next;
    return { status: "applied", sequence, generation, attemptRevision };
  }

  private persist(next: BranchQueueState, generation: number, attemptRevision: number): void {
    this.sql.exec(
      `UPDATE queue_meta SET
         generation = ?, active_attempt_revision = ?, last_sequence = ?, turn_sequence = ?,
         ordinal_sequence = ?, paused = ?, pause_reason = ?, rebaseline_required = ?,
         base_sha = ?, active_attempt_id = ?, chain_head_digest = ?, chain_head_sequence = ?
       WHERE id = 1`,
      generation,
      attemptRevision,
      next.lastSequence,
      next.turnSequence.toString(),
      next.ordinalSequence.toString(),
      next.paused ? 1 : 0,
      next.pauseReason,
      next.rebaselineRequired ? 1 : 0,
      next.baseSha,
      next.activeAttemptId,
      next.transitions.at(-1)?.digest ?? null,
      next.transitions.at(-1)?.transitionSequence ?? 0,
    );

    for (const entry of next.entries.values()) {
      this.sql.exec(
        `INSERT INTO entries (
           entry_id, pull_request_number, sponsor_principal_id, sponsor_github_user_id,
           fairness_ordinal, state, primary_reason, secondary_reasons, scheduler_eligible,
           cooldown_until, head_sha, current_attempt_id, last_attempt_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (entry_id) DO UPDATE SET
           sponsor_principal_id = excluded.sponsor_principal_id,
           sponsor_github_user_id = excluded.sponsor_github_user_id,
           fairness_ordinal = excluded.fairness_ordinal,
           state = excluded.state,
           primary_reason = excluded.primary_reason,
           secondary_reasons = excluded.secondary_reasons,
           scheduler_eligible = excluded.scheduler_eligible,
           cooldown_until = excluded.cooldown_until,
           head_sha = excluded.head_sha,
           current_attempt_id = excluded.current_attempt_id,
           last_attempt_id = excluded.last_attempt_id`,
        entry.entryId,
        entry.pullRequestNumber,
        entry.sponsorPrincipalId,
        entry.sponsorGithubUserId,
        entry.fairnessOrdinal.toString(),
        entry.state,
        entry.primaryReason,
        JSON.stringify(entry.secondaryReasons),
        entry.schedulerEligible ? 1 : 0,
        entry.cooldownUntil,
        entry.headSha,
        entry.currentAttemptId,
        entry.lastAttemptId,
      );
    }

    for (const attempt of next.attempts.values()) {
      this.sql.exec(
        `INSERT INTO attempts (attempt_id, entry_id, parent_attempt_id, phase, outcome, body)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (attempt_id) DO UPDATE SET
           phase = excluded.phase, outcome = excluded.outcome, body = excluded.body`,
        attempt.attemptId,
        attempt.entryId,
        attempt.parentAttemptId,
        attempt.phase,
        attempt.outcome,
        JSON.stringify(attempt),
      );
      if (attempt.parentAttemptId !== null) {
        this.sql.exec(
          `INSERT INTO attempt_edges (parent_attempt_id, child_attempt_id, edge_kind)
           VALUES (?, ?, 'retry') ON CONFLICT DO NOTHING`,
          attempt.parentAttemptId,
          attempt.attemptId,
        );
      }
    }

    for (const [principalId, turn] of next.lastServedTurn) {
      const entry = [...next.entries.values()].find((e) => e.sponsorPrincipalId === principalId);
      this.sql.exec(
        `INSERT INTO principals (principal_id, github_user_id, last_served_turn, fairness_debt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (principal_id) DO UPDATE SET
           last_served_turn = excluded.last_served_turn,
           fairness_debt = excluded.fairness_debt`,
        principalId,
        entry?.sponsorGithubUserId ?? "0",
        turn.toString(),
        JSON.stringify(next.fairnessDebt.get(principalId) ?? null),
      );
    }

    for (const transition of next.transitions) {
      this.sql.exec(
        `INSERT INTO transitions (transition_sequence, kind, prior_digest, digest, base_sha, attempt_id, witnesses)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (transition_sequence) DO NOTHING`,
        transition.transitionSequence,
        transition.kind,
        transition.priorDigest,
        transition.digest,
        transition.baseSha,
        transition.attemptId,
        JSON.stringify(transition.witnessPrincipalIds),
      );
    }
  }

  private applyDeadlines(options: AppendOptions): void {
    for (const clear of options.clearDeadlines ?? []) {
      this.sql.exec("DELETE FROM deadlines WHERE kind = ? AND attempt_id = ?", clear.kind, clear.attemptId);
    }
    for (const deadline of options.setDeadlines ?? []) {
      this.sql.exec(
        `INSERT INTO deadlines (kind, attempt_id, due_at) VALUES (?, ?, ?)
         ON CONFLICT (kind, attempt_id) DO UPDATE SET due_at = excluded.due_at`,
        deadline.kind,
        deadline.attemptId,
        deadline.dueAt,
      );
    }
  }

  private enqueueOutbox(items: readonly OutboxItem[], attemptRevision: number, at: string): void {
    for (const item of items) {
      this.sql.exec(
        `INSERT INTO outbox (kind, attempt_id, operation_id, attempt_revision, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        item.kind,
        item.attemptId ?? null,
        item.operationId ?? null,
        attemptRevision,
        JSON.stringify(item.payload),
        at,
      );
    }
  }

  /* ---------------- scheduler ---------------- */

  /** Entries the scheduler may consider right now (plan.md §7.1). */
  eligibleEntries(): EligibleEntry[] {
    const state = this.state();
    return [...state.entries.values()]
      .filter((entry) => entry.state === "Ready" && entry.schedulerEligible)
      .map((entry) => ({
        entryId: entry.entryId,
        sponsorPrincipalId: entry.sponsorPrincipalId,
        sponsorGithubUserId: BigInt(entry.sponsorGithubUserId),
        fairnessOrdinal: entry.fairnessOrdinal,
        pullRequestNumber: entry.pullRequestNumber,
        cooldownUntil: entry.cooldownUntil,
      }));
  }

  /** Who should get the next turn, or null. Never mutates. */
  nextTurn(now: string): EligibleEntry | null {
    const state = this.state();
    if (state.paused || state.activeAttemptId !== null) return null;
    return selectNext(this.eligibleEntries(), state.lastServedTurn, now);
  }

  /* ---------------- deadlines and outbox ---------------- */

  dueDeadlines(now: string): Deadline[] {
    return this.sql
      .exec<{ kind: string; attempt_id: string; due_at: string }>(
        "SELECT * FROM deadlines WHERE due_at <= ? ORDER BY due_at",
        now,
      )
      .toArray()
      .map((row) => ({ kind: row.kind as DeadlineKind, attemptId: row.attempt_id, dueAt: row.due_at }));
  }

  /** The single alarm time: the earliest deadline, or null (plan.md §39.3). */
  earliestDeadline(): string | null {
    const rows = this.sql
      .exec<{ due_at: string }>("SELECT due_at FROM deadlines ORDER BY due_at LIMIT 1")
      .toArray();
    return rows[0]?.due_at ?? null;
  }

  clearDeadline(kind: DeadlineKind, attemptId: string): void {
    this.sql.exec("DELETE FROM deadlines WHERE kind = ? AND attempt_id = ?", kind, attemptId);
  }

  pendingOutbox(): PendingOutbox[] {
    return this.sql
      .exec<{
        outbox_id: number;
        kind: string;
        attempt_id: string | null;
        operation_id: string | null;
        attempt_revision: number;
        payload: string;
        attempts: number;
      }>("SELECT * FROM outbox WHERE acknowledged = 0 ORDER BY outbox_id")
      .toArray()
      .map((row) => ({
        outboxId: row.outbox_id,
        kind: row.kind,
        ...(row.attempt_id !== null ? { attemptId: row.attempt_id } : {}),
        ...(row.operation_id !== null ? { operationId: row.operation_id } : {}),
        attemptRevision: row.attempt_revision,
        payload: JSON.parse(row.payload) as unknown,
        attempts: row.attempts,
      }));
  }

  acknowledgeOutbox(outboxId: number): void {
    this.sql.exec("UPDATE outbox SET acknowledged = 1 WHERE outbox_id = ?", outboxId);
  }

  recordOutboxAttempt(outboxId: number): void {
    this.sql.exec("UPDATE outbox SET attempts = attempts + 1 WHERE outbox_id = ?", outboxId);
  }

  /* ---------------- merge write guard ---------------- */

  /**
   * Record the intent to write before the network call. If this row exists, a
   * mutation may already have reached GitHub, and no retry may send another
   * (plan.md §40.1).
   */
  beginMergeOperation(op: {
    operationId: string;
    attemptId: string;
    attemptRevision: number;
    expectedBaseSha: string;
    expectedHeadSha: string;
    expectedTreeOid: string;
    at: string;
  }): { status: "started" } | { status: "already-started"; outcome: string | null } {
    const existing = this.sql
      .exec<{ outcome: string | null }>(
        "SELECT outcome FROM merge_operations WHERE operation_id = ?",
        op.operationId,
      )
      .toArray()[0];
    if (existing !== undefined) return { status: "already-started", outcome: existing.outcome };
    this.sql.exec(
      `INSERT INTO merge_operations (
         operation_id, attempt_id, attempt_revision, expected_base_sha, expected_head_sha,
         expected_tree_oid, write_started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      op.operationId,
      op.attemptId,
      op.attemptRevision,
      op.expectedBaseSha,
      op.expectedHeadSha,
      op.expectedTreeOid,
      op.at,
    );
    return { status: "started" };
  }

  resolveMergeOperation(operationId: string, outcome: string, at: string): void {
    this.sql.exec(
      "UPDATE merge_operations SET outcome = ?, resolved_at = ? WHERE operation_id = ?",
      outcome,
      at,
      operationId,
    );
  }

  mergeOperation(operationId: string): { attemptId: string; attemptRevision: number; outcome: string | null } | null {
    const row = this.sql
      .exec<{ attempt_id: string; attempt_revision: number; outcome: string | null }>(
        "SELECT attempt_id, attempt_revision, outcome FROM merge_operations WHERE operation_id = ?",
        operationId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    return { attemptId: row.attempt_id, attemptRevision: row.attempt_revision, outcome: row.outcome };
  }

  /* ---------------- callback staleness ---------------- */

  /**
   * Classify a callback that names an attempt and a revision (plan.md §39.2).
   * A callback for an older attempt is stale and harmless; one for the current
   * attempt whose facts disagree is an invariant conflict that pauses the lane.
   */
  classifyCallback(attemptId: string, attemptRevision: number): "current" | "STALE_ATTEMPT" | "CURRENT_ATTEMPT_INVARIANT_CONFLICT" {
    const state = this.state();
    if (state.activeAttemptId !== attemptId) return "STALE_ATTEMPT";
    if (this.attemptRevision() !== attemptRevision) return "CURRENT_ATTEMPT_INVARIANT_CONFLICT";
    return "current";
  }

  /** Drop the in-memory snapshot, as a Durable Object eviction would. */
  evict(): void {
    this.cached = null;
  }
}
