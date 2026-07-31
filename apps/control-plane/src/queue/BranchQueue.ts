import { DurableObject } from "cloudflare:workers";
import { queueKey } from "@thwip/queue-domain";
import { BranchQueueStore, type CandidateVerdict, type TransitionRow } from "./store.js";
import { DEFAULT_TIMINGS, QueueCommands, type QueueTimings } from "./commands.js";
import {
  admit,
  buildSnapshot,
  commandsFor,
  confirmAndRecord,
  walkToMergeReady,
  type AdmitInput,
  type ConfirmInput,
  type QueueSnapshot,
  type WalkInput,
} from "./queue-operations.js";
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
    this.commands = commandsFor(this.store, this.timings);
  }

  private require(): { store: BranchQueueStore; commands: QueueCommands } {
    // Reopen from the identity this object already stored. Every call used to be
    // preceded by a bind() from the caller, which is a whole round trip to say
    // something the object could read off its own disk, and it doubled the request
    // count of every read and every command.
    if (this.store === null || this.commands === null) this.reopen();
    if (this.store === null || this.commands === null) {
      throw new Error("branch queue has not been bound to a repository and base ref");
    }
    return { store: this.store, commands: this.commands };
  }

  /** The identity a bound object wrote when it was created, or nothing. */
  private reopen(): void {
    const sql = this.ctx.storage.sql as unknown as SqlLike;
    let row: { queue_key: string; repository_id: string; base_ref: string } | undefined;
    try {
      row = sql
        .exec<{ queue_key: string; repository_id: string; base_ref: string }>(
          "SELECT queue_key, repository_id, base_ref FROM queue_meta WHERE id = 1",
        )
        .toArray()[0];
    } catch {
      // No schema yet, so this object has never been bound.
      return;
    }
    if (row === undefined) return;
    this.open({ queueKey: row.queue_key, repositoryId: row.repository_id, baseRef: row.base_ref });
  }

  /**
   * Run a command and reschedule the alarm in the same turn. The Durable Object
   * runtime serializes calls, so no lock is needed and no storage transaction is
   * held across network I/O (plan.md §39.1).
   */
  private async withAlarm<T>(fn: (parts: { store: BranchQueueStore; commands: QueueCommands }) => T): Promise<T> {
    const parts = this.require();
    const result = fn(parts);
    // A command arrived, so whatever the alarm was stuck on is worth retrying.
    this.idleAlarms = 0;
    await this.rescheduleAlarm(parts.store);
    return result;
  }

  /**
   * Consecutive alarm runs that changed nothing.
   *
   * A wake loop is invisible in queue state precisely because it writes no
   * events, so nothing about the queue can reveal it. This counts the shape
   * directly, and stops rescheduling once it is unmistakable.
   */
  private idleAlarms = 0;

  /** Enough to ride out a transient, far short of the thousands a spin produces. */
  private static readonly IDLE_ALARM_LIMIT = 20;

  private async rescheduleAlarm(store: BranchQueueStore): Promise<void> {
    const next = store.earliestDeadline();
    if (next === null) {
      this.idleAlarms = 0;
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (this.idleAlarms >= BranchQueue.IDLE_ALARM_LIMIT) {
      // Stop asking to be woken. Something is due that handling does not clear,
      // and continuing costs a request every second for as long as it takes
      // somebody to notice. Any real command reopens the loop, because it resets
      // the counter and reschedules.
      console.error(
        `branch queue: ${this.idleAlarms} consecutive alarms changed nothing, deadline ${next}; ` +
          `refusing to reschedule until a command arrives`,
      );
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // Never ask to be woken at a time that has already passed. setAlarm with a
    // past timestamp fires immediately, so a deadline the alarm fails to clear
    // becomes a spin at machine speed: the object sustained fifteen wakes a second
    // for hours, writing almost no events, and spent an entire day of its request
    // budget before anything noticed.
    //
    // Clearing deadlines unconditionally is the actual fix. This is the floor
    // under it, so a case nobody predicted degrades into a slow retry rather than
    // a runaway.
    const target = Math.max(Date.parse(next), Date.now() + 1_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }

  /* ---------------- reads ---------------- */

  async snapshot(): Promise<QueueSnapshot> {
    return buildSnapshot(this.require().store);
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

  /**
   * Confirm a merge and record its transition, in one call.
   *
   * This was four: confirm, read the snapshot to work out the next sequence and
   * prior digest, record, then read the snapshot again to project. Two of those
   * existed only to ask the object for the chain head it already holds.
   *
   * The sequence and prior digest are derived here rather than passed in. A
   * caller computing them from a snapshot it fetched earlier is a caller racing
   * the object over its own chain.
   */
  async confirmAndRecord(input: ConfirmInput) {
    return this.withAlarm(({ commands, store }) => confirmAndRecord(commands, store, input));
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
   * Everything the merge gate does to get a pull request holding the lane, in one
   * call.
   *
   * This was thirteen separate round trips from the route: enqueue, evaluate
   * readiness, tick the scheduler, claim the offer, read back, and so on. The
   * object serializes calls anyway, so each hop bought nothing and every one was
   * a billed request. Thirteen per authorization, and the merge workflow polls
   * authorization while it waits, which is how a single repository spent a day's
   * request budget.
   *
   * The steps are unchanged and the reducer still decides each one. They just
   * happen where the state already is.
   */
  async admit(input: AdmitInput) {
    return this.withAlarm(({ commands, store }) => admit(commands, store, input));
  }

  async walkToMergeReady(input: WalkInput) {
    return this.withAlarm(({ commands, store }) => walkToMergeReady(commands, store, input));
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
  /**
   * Stop, and do not ask to be woken again.
   *
   * The queue's authority is in D1 now, and deadlines are handled by whatever
   * touches the queue next. Anything this object did on a timer would be acting
   * on state nothing reads, and every wake is billed against a daily cap that
   * two separate spins have already exhausted for a whole day at a time.
   *
   * The stored state is left alone. It is the only copy of what the queue knew
   * before the move, and deleting it to tidy up would throw away the only thing
   * a later comparison could be made against.
   */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }
}
