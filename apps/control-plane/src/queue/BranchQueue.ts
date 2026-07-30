import { DurableObject } from "cloudflare:workers";
import { queueKey } from "@thwip/queue-domain";
import { BranchQueueStore } from "./store.js";
import { DEFAULT_TIMINGS, QueueCommands, type QueueTimings } from "./commands.js";
import type { SqlLike } from "./sql.js";

/**
 * One Durable Object per repository and base ref (plan.md §6.1). `main` and
 * `release` are separate protected resources and must not share a lane, so they
 * are separate objects.
 *
 * This class is deliberately thin. All decisions live in the reducer, the store,
 * and the command layer, which run identically under test. What only the Durable
 * Object can provide is serialization, durable storage, and the single alarm —
 * so that is all it does here.
 */

export interface BranchQueueEnv {
  readonly QUEUE_TURN?: {
    create(options: { id: string; params: unknown }): Promise<unknown>;
  };
}

interface Identity {
  readonly queueKey: string;
  readonly repositoryId: string;
  readonly baseRef: string;
}

export class BranchQueue extends DurableObject<BranchQueueEnv> {
  private store: BranchQueueStore | null = null;
  private commands: QueueCommands | null = null;
  private timings: QueueTimings = DEFAULT_TIMINGS;

  /**
   * Identity arrives with the first command rather than from the object id,
   * because a Durable Object id derived from the queue key is opaque and the
   * repository and ref still have to be recorded for reads and evidence.
   */
  async bind(identity: Identity): Promise<{ queueKey: string }> {
    const expected = await queueKey(identity.repositoryId, identity.baseRef);
    if (expected !== identity.queueKey) {
      throw new Error("queue key does not match its repository and base ref");
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      this.open(identity);
    });
    return { queueKey: identity.queueKey };
  }

  private open(identity: Identity): void {
    if (this.store !== null) return;
    const sql = this.ctx.storage.sql as unknown as SqlLike;
    this.store = BranchQueueStore.open(sql, identity);
    this.commands = new QueueCommands(
      this.store,
      { now: () => new Date().toISOString() },
      {
        attemptId: () => `att_${crypto.randomUUID()}`,
        operationId: () => `op_${crypto.randomUUID()}`,
        nonce: () => crypto.randomUUID(),
        claimToken: () => crypto.randomUUID(),
      },
      this.timings,
    );
  }

  private require(): { store: BranchQueueStore; commands: QueueCommands } {
    if (this.store === null || this.commands === null) {
      throw new Error("branch queue has not been bound to a repository and base ref");
    }
    return { store: this.store, commands: this.commands };
  }

  /**
   * Run a command and reschedule the alarm in the same turn. The Durable Object
   * runtime serializes calls, so no lock is needed and no storage transaction is
   * held across network I/O (plan.md §39.1).
   */
  private async withAlarm<T>(fn: (parts: { store: BranchQueueStore; commands: QueueCommands }) => T): Promise<T> {
    const parts = this.require();
    const result = fn(parts);
    await this.rescheduleAlarm(parts.store);
    return result;
  }

  private async rescheduleAlarm(store: BranchQueueStore): Promise<void> {
    const next = store.earliestDeadline();
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    const target = Date.parse(next);
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }

  /* ---------------- reads ---------------- */

  async snapshot(): Promise<{
    generation: number;
    attemptRevision: number;
    paused: boolean;
    pauseReason: string | null;
    rebaselineRequired: boolean;
    baseSha: string | null;
    activeAttemptId: string | null;
    chainHead: { sequence: number; digest: string } | null;
    entries: Array<{
      entryId: string;
      pullRequestNumber: number;
      sponsorPrincipalId: string;
      state: string;
      primaryReason: string | null;
      schedulerEligible: boolean;
      fairnessOrdinal: string;
      cooldownUntil: string | null;
    }>;
  }> {
    const { store } = this.require();
    const state = store.state();
    const head = state.transitions.at(-1);
    return {
      generation: store.generation(),
      attemptRevision: store.attemptRevision(),
      paused: state.paused,
      pauseReason: state.pauseReason,
      rebaselineRequired: state.rebaselineRequired,
      baseSha: state.baseSha,
      activeAttemptId: state.activeAttemptId,
      chainHead: head === undefined ? null : { sequence: head.transitionSequence, digest: head.digest },
      // Projected order only: an exact permanent position would be a lie,
      // because readiness changes after every GitHub event (plan.md §8.3).
      entries: [...state.entries.values()]
        .sort((a, b) => (a.fairnessOrdinal < b.fairnessOrdinal ? -1 : 1))
        .map((entry) => ({
          entryId: entry.entryId,
          pullRequestNumber: entry.pullRequestNumber,
          sponsorPrincipalId: entry.sponsorPrincipalId,
          state: entry.state,
          primaryReason: entry.primaryReason,
          schedulerEligible: entry.schedulerEligible,
          fairnessOrdinal: entry.fairnessOrdinal.toString(),
          cooldownUntil: entry.cooldownUntil,
        })),
    };
  }

  /* ---------------- commands ---------------- */

  async request(input: Parameters<QueueCommands["requestQueue"]>[0]) {
    return this.withAlarm(({ commands }) => commands.requestQueue(input));
  }

  async readiness(input: Parameters<QueueCommands["evaluateReadiness"]>[0]) {
    return this.withAlarm(({ commands }) => commands.evaluateReadiness(input));
  }

  async tick(input: Parameters<QueueCommands["tick"]>[0]) {
    return this.withAlarm(({ commands }) => commands.tick(input));
  }

  async claim(input: Parameters<QueueCommands["claim"]>[0]) {
    return this.withAlarm(({ commands }) => commands.claim(input));
  }

  async candidatePrepared(input: Parameters<QueueCommands["candidatePrepared"]>[0]) {
    return this.withAlarm(({ commands }) => commands.candidatePrepared(input));
  }

  async assign(input: Parameters<QueueCommands["assign"]>[0]) {
    return this.withAlarm(({ commands }) => commands.assign(input));
  }

  async heartbeat(input: Parameters<QueueCommands["heartbeat"]>[0]) {
    return this.withAlarm(({ commands }) => commands.heartbeat(input));
  }

  async heartbeatLost(input: Parameters<QueueCommands["heartbeatLost"]>[0]) {
    return this.withAlarm(({ commands }) => commands.heartbeatLost(input));
  }

  async reconnect(input: Parameters<QueueCommands["reconnect"]>[0]) {
    return this.withAlarm(({ commands }) => commands.reconnect(input));
  }

  async receipt(input: Parameters<QueueCommands["submitReceipt"]>[0]) {
    return this.withAlarm(({ commands }) => commands.submitReceipt(input));
  }

  async startVerification(input: Parameters<QueueCommands["startVerification"]>[0]) {
    return this.withAlarm(({ commands }) => commands.startVerification(input));
  }

  async completeVerification(input: Parameters<QueueCommands["completeVerification"]>[0]) {
    return this.withAlarm(({ commands }) => commands.completeVerification(input));
  }

  async mergeIntent(input: Parameters<QueueCommands["createMergeIntent"]>[0]) {
    return this.withAlarm(({ commands }) => commands.createMergeIntent(input));
  }

  async beginMergeWrite(input: Parameters<QueueCommands["beginMergeWrite"]>[0]) {
    return this.withAlarm(({ commands }) => commands.beginMergeWrite(input));
  }

  async mergeOutcomeUnknown(input: Parameters<QueueCommands["mergeOutcomeUnknown"]>[0]) {
    return this.withAlarm(({ commands }) => commands.mergeOutcomeUnknown(input));
  }

  async confirmMerge(input: Parameters<QueueCommands["confirmMerge"]>[0]) {
    return this.withAlarm(({ commands }) => commands.confirmMerge(input));
  }

  async confirmNotMerged(input: Parameters<QueueCommands["confirmNotMerged"]>[0]) {
    return this.withAlarm(({ commands }) => commands.confirmNotMerged(input));
  }

  async recordTransition(input: Parameters<QueueCommands["recordTransition"]>[0]) {
    return this.withAlarm(({ commands }) => commands.recordTransition(input));
  }

  async terminateAttempt(input: Parameters<QueueCommands["terminateAttempt"]>[0]) {
    return this.withAlarm(({ commands }) => commands.terminateAttempt(input));
  }

  async externalTransition(input: Parameters<QueueCommands["observedExternalTransition"]>[0]) {
    return this.withAlarm(({ commands }) => commands.observedExternalTransition(input));
  }

  async pause(input: Parameters<QueueCommands["pause"]>[0]) {
    return this.withAlarm(({ commands }) => commands.pause(input));
  }

  async resume(input: Parameters<QueueCommands["resume"]>[0]) {
    return this.withAlarm(({ commands }) => commands.resume(input));
  }

  async rebaseline(input: Parameters<QueueCommands["rebaseline"]>[0]) {
    return this.withAlarm(({ commands }) => commands.rebaseline(input));
  }

  async cancel(input: Parameters<QueueCommands["cancel"]>[0]) {
    return this.withAlarm(({ commands }) => commands.cancel(input));
  }

  /**
   * Classify a callback before acting on it. A callback for an older attempt is
   * stale and harmless; one for the current attempt whose revision disagrees is
   * a conflict that must not be applied (plan.md §39.2).
   */
  async classifyCallback(attemptId: string, attemptRevision: number) {
    const { store } = this.require();
    return store.classifyCallback(attemptId, attemptRevision);
  }

  /**
   * Everything needed to answer "what is going on and why" in one call.
   *
   * Built because diagnosing this queue meant a state fetch, a log grep, and a
   * guess about cooldowns and idempotency keys. One call that says what the lane
   * holds, what each entry is waiting for, what deadlines exist and what happened
   * recently replaces all of that.
   */
  async diagnose(limit = 25): Promise<{
    snapshot: Awaited<ReturnType<BranchQueue["snapshot"]>>;
    deadlines: Array<{ kind: string; attemptId: string; dueAt: string }>;
    outbox: Array<{ kind: string; attemptId?: string; attempts: number }>;
    attempts: Array<{ attemptId: string; phase: string; outcome: string | null; outcomeUnknown: boolean }>;
    events: Array<{ sequence: number; at: string; type: string; detail: string }>;
  }> {
    const { store } = this.require();
    const sql = this.ctx.storage.sql as unknown as {
      exec<T>(q: string, ...b: unknown[]): { toArray(): T[] };
    };
    const state = store.state();
    return {
      snapshot: await this.snapshot(),
      deadlines: sql
        .exec<{ kind: string; attempt_id: string; due_at: string }>(
          "SELECT kind, attempt_id, due_at FROM deadlines ORDER BY due_at",
        )
        .toArray()
        .map((r) => ({ kind: r.kind, attemptId: r.attempt_id, dueAt: r.due_at })),
      outbox: store.pendingOutbox().map((o) => ({
        kind: o.kind,
        ...(o.attemptId === undefined ? {} : { attemptId: o.attemptId }),
        attempts: o.attempts,
      })),
      attempts: [...state.attempts.values()].map((a) => ({
        attemptId: a.attemptId,
        phase: a.phase,
        outcome: a.outcome,
        outcomeUnknown: a.outcomeUnknown,
      })),
      events: sql
        .exec<{ sequence: number; at: string; type: string; body: string }>(
          "SELECT sequence, at, type, body FROM events ORDER BY sequence DESC LIMIT ?",
          limit,
        )
        .toArray()
        .map((r) => {
          const body = JSON.parse(r.body) as Record<string, unknown>;
          const parts = ["entryId", "attemptId", "outcome", "primaryReason", "reason"]
            .map((k) => (body[k] === undefined || body[k] === null ? null : `${k}=${String(body[k])}`))
            .filter((v): v is string => v !== null);
          return { sequence: r.sequence, at: r.at, type: r.type, detail: parts.join(" ") };
        }),
    };
  }

  async pendingOutbox() {
    const { store } = this.require();
    return store.pendingOutbox();
  }

  async acknowledgeOutbox(outboxId: number) {
    const { store } = this.require();
    store.acknowledgeOutbox(outboxId);
  }

  /**
   * One alarm handles every due deadline, retries unacknowledged outbox items,
   * and reschedules (plan.md §39.3). Delivery is at-least-once, and every action
   * it takes carries a deadline-derived idempotency key, so a second delivery
   * changes nothing.
   */
  override async alarm(): Promise<void> {
    const parts = this.store === null ? null : this.require();
    if (parts === null) return;
    parts.commands.runAlarm();
    await this.rescheduleAlarm(parts.store);
  }
}
