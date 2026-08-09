import {
  applyEvent,
  assertInvariants,
  compactState,
  decodeState,
  DEFAULT_COMPACTION,
  emptyState,
  encodeState,
  QueueRuleViolation,
  selectNext,
  type BranchQueueState,
  type CompactionLimits,
  type EligibleEntry,
  type QueueEvent,
} from "@thwip/queue-domain";
import type {
  AppendOptions,
  AppendResult,
  Deadline,
  DeadlineKind,
  PendingOutbox,
  SubmittedEvent,
  TransitionRow,
  UnresolvedMergeOperation,
} from "./store.js";

/**
 * The same durable state, in one document instead of eleven SQL tables.
 *
 * `BranchQueueStore` needs SQLite, and the only SQLite a Worker can reach
 * synchronously belongs to a Durable Object. That put the coordination object in
 * the path of every read and every write, including the ones that coordinate
 * nothing, and Durable Object requests are the resource with a hard daily cliff.
 * A single spinning alarm spent a whole day's budget in two hours and the queue
 * stopped answering for nineteen hours, with the merge decision it was protecting
 * sitting intact the entire time.
 *
 * So the authority moves to D1, which is priced by rows rather than by requests
 * and which this account uses about two percent of. D1 is async, and the reducer
 * and every command run synchronously, so the shape has to be read-modify-write:
 * load the document, run the commands in memory, write it back if it changed.
 * `SnapshotCell` is that document while it is in memory, and the compare-and-swap
 * on the way out is what makes concurrent writers safe.
 *
 * Nothing about the rules moves. The reducer is the same reducer, the invariants
 * are the same invariants, and this file only decides where the bytes rest.
 *
 * Most of the old tables were projections of the reducer state and are gone, kept
 * now by serialising the state itself. What survives is what the state does not
 * carry: deadlines, the outbox, the merge write guard, when each transition was
 * observed, and a bounded tail of events for diagnosis.
 */

/** The stored document, while it is in memory. */
export interface SnapshotCell {
  read(): string | null;
  write(json: string): void;
}

/** A cell backed by a variable. The tests use it; so does a cold load from D1. */
export function cellOf(initial: string | null = null): SnapshotCell {
  let held = initial;
  return {
    read: () => held,
    write: (json) => {
      held = json;
    },
  };
}

/** How many recent idempotency keys stay resident for deduplication. */
const DEDUPE_WINDOW = 512;

/**
 * How many recent events the document keeps.
 *
 * Only diagnosis reads them, and it asks for a couple of dozen. The old table
 * kept every event forever, which is the one part of this that would have grown
 * without bound once the document has to be read and written whole.
 */
const EVENT_TAIL = 200;

/**
 * How many outbox items the document keeps.
 *
 * Nothing in the Worker acknowledges one. `acknowledgeOutbox` had no caller
 * outside the tests, so every item any command ever appended was still here,
 * unacknowledged, and the array is re-serialised on every command and every
 * tick. On 5 August 2026 it held 1053 items and 281KB of a 613KB document, the
 * oldest dating from 31 July. The tick stopped fitting in a Worker invocation,
 * Cloudflare stopped dispatching the five minute trigger, and the queue sat for
 * eleven hours.
 *
 * The side effects these items describe are performed directly by the routes
 * that record them, so what is kept is a diagnostic tail, the same as the
 * events above.
 */
const OUTBOX_TAIL = 200;

/**
 * How many settled merge writes the document keeps.
 *
 * Only settled ones are counted. A write whose outcome nobody could confirm is
 * exactly what the sweep comes back for, and it can sit unsettled across many
 * later merges, so dropping one for being old would leave a merge unrecorded
 * with nothing left that knows to look.
 */
const MERGE_OPERATION_TAIL = 200;

/**
 * What the whole document is allowed to weigh.
 *
 * Every cap above counts rows, and rows are not the resource. A Worker on the
 * free plan gets 10ms of CPU per invocation, and it spends that parsing this
 * document, folding it and serialising it again. Six caps, each chosen after a
 * different incident and each modest alone, summed to 398KB on 9 August 2026
 * with none of them exceeded, and the tick stopped fitting anyway.
 *
 * Counting rows also leaves the budget to be re-divided by hand whenever a field
 * is added, by someone who has no reason to know the other five exist. Bounding
 * the bytes is the bound that does not need maintaining: a new field spends the
 * same budget as the old ones and is shed by the same rule.
 *
 * 128KB parses and re-serialises in roughly a millisecond, which leaves the rest
 * of the invocation for the work.
 */
export const DOCUMENT_BUDGET_BYTES = 131_072;

/**
 * What shedding may not take.
 *
 * Diagnosis can be cut to a stub and the queue still decides correctly. These
 * floors are where cutting further would change an answer rather than blur a
 * record: deduplication that no longer recognises a retry would apply it twice.
 */
const FLOORS = { events: 20, outbox: 20, mergeOperations: 20, dedupe: 64 } as const;

interface DedupeRow {
  key: string;
  sequence: number;
  result: string;
  at: string;
}

interface OutboxRow {
  outboxId: number;
  kind: string;
  attemptId: string | null;
  operationId: string | null;
  attemptRevision: number;
  payload: unknown;
  attempts: number;
  acknowledged: boolean;
}

interface MergeOperationRow {
  operationId: string;
  attemptId: string;
  attemptRevision: number;
  expectedBaseSha: string;
  expectedHeadSha: string;
  expectedTreeOid: string;
  /**
   * Absent on every row this document held before the key existed. Production
   * runs on this store, and the four writes the sweep was built for are four
   * such rows, so the key is optional here and the absence is carried as null
   * rather than read back as a number nobody wrote.
   */
  pullRequestNumber?: number | null;
  writeStartedAt: string;
  outcome: string | null;
  resolvedAt: string | null;
  /**
   * What the sweep concluded last time it looked, how many consecutive times it
   * concluded the same thing, when that was, and when it will look again.
   *
   * Absent on every row written before the sweep learned to remember a refusal,
   * which reads as never refused and is asked about on the next tick, the way it
   * behaved before.
   */
  refusalReason?: string | null;
  refusalCount?: number;
  refusedAt?: string | null;
  retryAfter?: string | null;
}

export interface EventRow {
  sequence: number;
  at: string;
  type: string;
  body: unknown;
}

interface Document {
  queueKey: string;
  repositoryId: string;
  baseRef: string;
  generation: number;
  attemptRevision: number;
  queueEpoch: number;
  state: ReturnType<typeof encodeState>;
  dedupe: DedupeRow[];
  deadlines: Deadline[];
  outbox: OutboxRow[];
  nextOutboxId: number;
  mergeOperations: MergeOperationRow[];
  /** transitionSequence to the time it was first recorded. */
  transitionsRecordedAt: Record<string, string>;
  events: EventRow[];
}

/** Whether the sweep may read GitHub about this write on a tick at `now`. */
function due(row: MergeOperationRow, now: string): boolean {
  return typeof row.retryAfter !== "string" || row.retryAfter <= now;
}

function emptyDocument(identity: { queueKey: string; repositoryId: string; baseRef: string }): Document {
  return {
    ...identity,
    generation: 0,
    attemptRevision: 0,
    queueEpoch: 0,
    state: encodeState(emptyState(identity.queueKey, identity.repositoryId, identity.baseRef)),
    dedupe: [],
    deadlines: [],
    outbox: [],
    nextOutboxId: 1,
    mergeOperations: [],
    transitionsRecordedAt: {},
    events: [],
  };
}

export class SnapshotQueueStore {
  private doc: Document;
  private cached: BranchQueueState | null = null;

  private constructor(
    private readonly cell: SnapshotCell,
    readonly queueKey: string,
    readonly repositoryId: string,
    readonly baseRef: string,
    private readonly compaction: CompactionLimits = DEFAULT_COMPACTION,
  ) {
    const held = cell.read();
    this.doc = held === null ? emptyDocument({ queueKey, repositoryId, baseRef }) : (JSON.parse(held) as Document);

    // Pay down a backlog the moment the document is opened, not when the next
    // event happens to apply.
    //
    // A queue that has grown too large has usually stopped applying events:
    // the tick no longer fits in an invocation, so nothing applies, so a bound
    // that only ran on an applied event never ran. That is what shipped on
    // 5 August, and it left 1057 outbox items in place on the queue it was
    // written for, because the queue had gone quiet by the time it landed.
    //
    // A document already within its bounds writes nothing, so opening stays
    // free for the reads it was kept free for. One that is over pays once and
    // is never over again.
    if (this.overBounds()) this.flush();
  }

  static open(
    cell: SnapshotCell,
    identity: { queueKey: string; repositoryId: string; baseRef: string },
    compaction: CompactionLimits = DEFAULT_COMPACTION,
  ): SnapshotQueueStore {
    // Opening an empty or already-bounded document writes nothing. A queue
    // nobody has used yet has no document, and creating one on every read would
    // turn each poll of an idle repository into a write. The one exception is a
    // legacy document above its bounds: opening it performs the cleanup write
    // that lets a queue too large to process recover without first accepting an
    // event.
    return new SnapshotQueueStore(
      cell,
      identity.queueKey,
      identity.repositoryId,
      identity.baseRef,
      compaction,
    );
  }

  /**
   * Persist the document, within its bounds.
   *
   * The bounds are applied here rather than where an event is accepted, because
   * a queue that is already too large has usually stopped accepting events. The
   * tick stops fitting in an invocation, so nothing applies, so a bound that
   * only ran on an applied event never runs. Shipped that way on 5 August, it
   * left 1057 outbox items in place on the queue it was written for.
   *
   * Opening pays an existing backlog down, and every later persistence path
   * keeps it down: an applied event, a no-op command, or a merge write starting
   * or settling. What is persisted is always within bounds, which is the
   * property worth having.
   */
  private flush(): void {
    this.trimOutbox();
    this.trimMergeOperations();
    if (this.doc.events.length > EVENT_TAIL) this.doc.events = this.doc.events.slice(-EVENT_TAIL);
    if (this.doc.dedupe.length > DEDUPE_WINDOW) {
      this.doc.dedupe = [...this.doc.dedupe].sort((a, b) => a.sequence - b.sequence).slice(-DEDUPE_WINDOW);
    }
    this.forgetUnreachableTransitionTimes();
    this.cell.write(this.serialiseWithinBudget());
  }

  /**
   * A timestamp for a chain link the document no longer carries.
   *
   * `transitionsRecordedAt` is a sidecar of the chain, keyed by sequence, and the
   * chain itself is compacted to a window. The sidecar was not, so it kept one
   * key per transition for the life of the repository.
   */
  private forgetUnreachableTransitionTimes(): void {
    const reachable = new Set(this.state().transitions.map((t) => String(t.transitionSequence)));
    for (const key of Object.keys(this.doc.transitionsRecordedAt)) {
      if (!reachable.has(key)) delete this.doc.transitionsRecordedAt[key];
    }
  }

  /**
   * Serialise, and if the result is over budget, shed diagnosis until it fits.
   *
   * Order matters, and it is the order of what a reader loses. Events go first:
   * they duplicate the transition chain and the projection holds them. Then the
   * outbox, whose side effects have already been performed by the routes that
   * recorded them. Then settled merge writes, which the projection also holds.
   * Deduplication is last and stops at a floor, because a window too small to
   * recognise a retry lets the same command apply twice.
   *
   * What is never shed is anything a live decision reaches. If the state alone
   * exceeds the budget the document is written over it: a queue holding that many
   * open pull requests has a problem shedding cannot fix, and dropping the queue
   * to make the bytes fit would be the queue lying about itself.
   */
  private serialiseWithinBudget(): string {
    let json = JSON.stringify(this.doc);
    if (json.length <= DOCUMENT_BUDGET_BYTES) return json;

    const shed: (() => boolean)[] = [
      () => this.halve("events", FLOORS.events),
      () => this.halve("outbox", FLOORS.outbox),
      () => this.shedSettledMergeOperations(FLOORS.mergeOperations),
      () => this.halve("dedupe", FLOORS.dedupe),
    ];

    for (const step of shed) {
      while (json.length > DOCUMENT_BUDGET_BYTES && step()) {
        json = JSON.stringify(this.doc);
      }
      if (json.length <= DOCUMENT_BUDGET_BYTES) break;
    }
    return json;
  }

  /** Drop the older half of a diagnostic tail. Reports whether anything went. */
  private halve(field: "events" | "outbox" | "dedupe", floor: number): boolean {
    const rows = this.doc[field];
    if (rows.length <= floor) return false;
    const keep = Math.max(floor, Math.floor(rows.length / 2));
    this.doc[field] = rows.slice(-keep) as never;
    return true;
  }

  /** Same, for merge writes, and never for one whose outcome is still unknown. */
  private shedSettledMergeOperations(floor: number): boolean {
    const settled = this.doc.mergeOperations.filter((row) => row.outcome !== null);
    if (settled.length <= floor) return false;
    const keep = Math.max(floor, Math.floor(settled.length / 2));
    const dropped = new Set(settled.slice(0, settled.length - keep).map((row) => row.operationId));
    this.doc.mergeOperations = this.doc.mergeOperations.filter((row) => !dropped.has(row.operationId));
    return true;
  }

  /** What the document weighs right now. Diagnosis, and the bound's own test. */
  documentBytes(): number {
    return JSON.stringify(this.doc).length;
  }

  /** Which transitions the document still remembers a time for. */
  recordedTransitionKeys(): readonly string[] {
    return Object.keys(this.doc.transitionsRecordedAt);
  }

  /**
   * Rehydrated state.
   *
   * `appliedKeys` is rebuilt from the deduplication rows rather than taken from
   * the serialised state, because the rows are the ones that get pruned. Trusting
   * the serialised copy would let the set grow forever in the document while the
   * store reported a bounded window.
   */
  state(): BranchQueueState {
    if (this.cached !== null) return this.cached;
    const state = decodeState(this.doc.state);
    state.appliedKeys = new Set(
      [...this.doc.dedupe].sort((a, b) => b.sequence - a.sequence).slice(0, DEDUPE_WINDOW).map((row) => row.key),
    );
    this.cached = state;
    return state;
  }

  generation(): number {
    return this.doc.generation;
  }

  attemptRevision(): number {
    return this.doc.attemptRevision;
  }

  queueEpoch(): number {
    return this.doc.queueEpoch;
  }

  /**
   * The recorded transition chain, oldest first. `recordedAt` is when the
   * transition was first written, never now(), so a projection cannot report the
   * time it happened to run as the time the base moved.
   */
  transitionChain(): readonly TransitionRow[] {
    return this.state().transitions.map((t) => ({
      transitionSequence: t.transitionSequence,
      kind: t.kind,
      priorDigest: t.priorDigest,
      digest: t.digest,
      baseSha: t.baseSha,
      attemptId: t.attemptId,
      witnessPrincipalIds: t.witnessPrincipalIds,
      recordedAt: this.doc.transitionsRecordedAt[String(t.transitionSequence)] ?? null,
    }));
  }

  /** Most recent first, for diagnosis. */
  recentEvents(limit: number): readonly EventRow[] {
    return [...this.doc.events].sort((a, b) => b.sequence - a.sequence).slice(0, limit);
  }

  /**
   * Apply one event. Nothing is written unless the reducer accepts it and the
   * resulting state satisfies every invariant.
   */
  append(event: SubmittedEvent, options: AppendOptions = {}): AppendResult {
    const before = this.state();

    const seen = this.doc.dedupe.find((row) => row.key === event.idempotencyKey);
    if (seen !== undefined) {
      return {
        status: "duplicate",
        sequence: seen.sequence,
        generation: this.doc.generation,
        attemptRevision: this.doc.attemptRevision,
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

    // The reducer signals a no-op by returning the state it was given. Such an
    // event must not consume a sequence: the record would exist while lastSequence
    // stayed behind it, and the next append would reuse that sequence. The
    // idempotency key is still recorded, so a retry does not re-evaluate it.
    if (next === before) {
      this.remember({ key: event.idempotencyKey, sequence: before.lastSequence, result: "noop", at: event.at });
      this.flush();
      return {
        status: "duplicate",
        sequence: before.lastSequence,
        generation: this.doc.generation,
        attemptRevision: this.doc.attemptRevision,
      };
    }

    this.doc.generation += 1;
    if (options.bumpAttemptRevision === true) this.doc.attemptRevision += 1;

    this.doc.events.push({ sequence, at: event.at, type: event.type, body: full });
    this.remember({ key: event.idempotencyKey, sequence, result: "applied", at: event.at });

    // Drop what no live decision can reach, before it is written.
    //
    // Entries, attempts and the chain were all append-only, so this document grew
    // with the repository's whole merge history and was read and written whole on
    // every request. The projection keeps the history; this keeps what is live.
    compactState(next, this.compaction);
    this.doc.state = encodeState(next);
    for (const transition of next.transitions) {
      const key = String(transition.transitionSequence);
      // First write wins. Rewriting it on every append would move the observation
      // time forward every time anything else happened.
      this.doc.transitionsRecordedAt[key] ??= event.at;
    }

    for (const clear of options.clearDeadlines ?? []) {
      this.doc.deadlines = this.doc.deadlines.filter(
        (d) => !(d.kind === clear.kind && d.attemptId === clear.attemptId),
      );
    }
    for (const deadline of options.setDeadlines ?? []) {
      this.doc.deadlines = this.doc.deadlines.filter(
        (d) => !(d.kind === deadline.kind && d.attemptId === deadline.attemptId),
      );
      this.doc.deadlines.push(deadline);
    }

    for (const item of options.outbox ?? []) {
      this.doc.outbox.push({
        outboxId: this.doc.nextOutboxId,
        kind: item.kind,
        attemptId: item.attemptId ?? null,
        operationId: item.operationId ?? null,
        attemptRevision: this.doc.attemptRevision,
        payload: item.payload,
        attempts: 0,
        acknowledged: false,
      });
      this.doc.nextOutboxId += 1;
    }
    this.cached = next;
    this.flush();
    return {
      status: "applied",
      sequence,
      generation: this.doc.generation,
      attemptRevision: this.doc.attemptRevision,
    };
  }

  private remember(row: DedupeRow): void {
    this.doc.dedupe.push(row);
  }

  /* ---------------- scheduler ---------------- */

  /** Entries the scheduler may consider right now. */
  eligibleEntries(): EligibleEntry[] {
    return [...this.state().entries.values()]
      // Same rule as BranchQueueStore, and for the same reason: a Deferred entry
      // competes, and selectNext holds it until its cooldown elapses. Requiring
      // a cooldown here hid an entry that had none from the scheduler for good.
      .filter((entry) => entry.schedulerEligible && (entry.state === "Ready" || entry.state === "Deferred"))
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
    return this.doc.deadlines.filter((d) => d.dueAt <= now).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  /** The single alarm time: the earliest deadline, or null. */
  earliestDeadline(): string | null {
    let earliest: string | null = null;
    for (const deadline of this.doc.deadlines) {
      if (earliest === null || deadline.dueAt < earliest) earliest = deadline.dueAt;
    }
    return earliest;
  }

  clearDeadline(kind: DeadlineKind, attemptId: string): void {
    const before = this.doc.deadlines.length;
    this.doc.deadlines = this.doc.deadlines.filter((d) => !(d.kind === kind && d.attemptId === attemptId));
    if (this.doc.deadlines.length !== before) this.flush();
  }

  /**
   * Whether anything in the document is past the size it is allowed to be.
   *
   * The byte budget is checked here as well as at the write, and it is the check
   * that matters for a queue already in trouble: a document too large to process
   * has stopped applying events, so a bound that waits for one never runs. This
   * is what makes opening the document enough to repair it.
   */
  private overBounds(): boolean {
    return (
      this.doc.outbox.length > OUTBOX_TAIL ||
      this.doc.mergeOperations.filter((row) => row.outcome !== null).length > MERGE_OPERATION_TAIL ||
      this.doc.events.length > EVENT_TAIL ||
      this.doc.dedupe.length > DEDUPE_WINDOW ||
      this.documentBytes() > DOCUMENT_BUDGET_BYTES
    );
  }

  /** Keep the newest items, because the newest are what an operator is asking about. */
  private trimOutbox(): void {
    if (this.doc.outbox.length > OUTBOX_TAIL) {
      this.doc.outbox = this.doc.outbox.slice(-OUTBOX_TAIL);
    }
  }

  /**
   * Drop the oldest settled merge writes, and never an unsettled one.
   *
   * The sweep finds an orphaned write by asking for the ones that never
   * settled, so those stay however old they are. What is bounded is the record
   * of writes that already have an outcome, which `/explain` reports and
   * nothing decides from.
   */
  private trimMergeOperations(): void {
    const settled = this.doc.mergeOperations.filter((row) => row.outcome !== null);
    if (settled.length <= MERGE_OPERATION_TAIL) return;
    const dropped = new Set(settled.slice(0, settled.length - MERGE_OPERATION_TAIL).map((row) => row.operationId));
    this.doc.mergeOperations = this.doc.mergeOperations.filter((row) => !dropped.has(row.operationId));
  }

  pendingOutbox(): PendingOutbox[] {
    return this.doc.outbox
      .filter((row) => !row.acknowledged)
      .sort((a, b) => a.outboxId - b.outboxId)
      .map((row) => ({
        outboxId: row.outboxId,
        kind: row.kind,
        ...(row.attemptId !== null ? { attemptId: row.attemptId } : {}),
        ...(row.operationId !== null ? { operationId: row.operationId } : {}),
        attemptRevision: row.attemptRevision,
        payload: row.payload,
        attempts: row.attempts,
      }));
  }

  acknowledgeOutbox(outboxId: number): void {
    const row = this.doc.outbox.find((o) => o.outboxId === outboxId);
    if (row === undefined) return;
    row.acknowledged = true;
    this.flush();
  }

  recordOutboxAttempt(outboxId: number): void {
    const row = this.doc.outbox.find((o) => o.outboxId === outboxId);
    if (row === undefined) return;
    row.attempts += 1;
    this.flush();
  }

  /* ---------------- merge write guard ---------------- */

  /**
   * Record the intent to write before the network call. If this record exists, a
   * mutation may already have reached GitHub, and no retry may send another
   *.
   */
  beginMergeOperation(op: {
    operationId: string;
    attemptId: string;
    attemptRevision: number;
    expectedBaseSha: string;
    expectedHeadSha: string;
    expectedTreeOid: string;
    pullRequestNumber: number;
    at: string;
  }): { status: "started" } | { status: "already-started"; outcome: string | null } {
    const existing = this.doc.mergeOperations.find((row) => row.operationId === op.operationId);
    if (existing !== undefined) return { status: "already-started", outcome: existing.outcome };
    this.doc.mergeOperations.push({
      operationId: op.operationId,
      attemptId: op.attemptId,
      attemptRevision: op.attemptRevision,
      expectedBaseSha: op.expectedBaseSha,
      expectedHeadSha: op.expectedHeadSha,
      expectedTreeOid: op.expectedTreeOid,
      pullRequestNumber: op.pullRequestNumber,
      writeStartedAt: op.at,
      outcome: null,
      resolvedAt: null,
    });
    this.flush();
    return { status: "started" };
  }

  /** Async for the same reason as `BranchQueueStore.resolveMergeOperation`. */
  async resolveMergeOperation(operationId: string, outcome: string, at: string): Promise<void> {
    const row = this.doc.mergeOperations.find((o) => o.operationId === operationId);
    if (row === undefined) return;
    row.outcome = outcome;
    row.resolvedAt = at;
    this.flush();
  }

  /**
   * Write down that the sweep looked at this write and could not settle it.
   *
   * The count runs on while the reason holds and starts over when it changes,
   * because those are two different stories. Ten refusals saying the same
   * sentence is a write that needs a person; a new sentence is a write whose
   * situation moved, and it earns a fresh look on the next tick.
   *
   * Nothing here closes the row. It stays open, `/explain` reports it with the
   * reason and the count, and the sweep comes back when `retryAfter` passes. A
   * write nobody can settle has to stay visible, because a merge write nobody
   * owns is the failure this whole sweep exists to prevent.
   */
  async refuseMergeOperation(
    operationId: string,
    reason: string,
    at: string,
    retryAt: (count: number, refusedAt: string) => string,
  ): Promise<{ count: number } | null> {
    const row = this.doc.mergeOperations.find((o) => o.operationId === operationId);
    if (row === undefined) return null;
    const count = row.refusalReason === reason ? (row.refusalCount ?? 0) + 1 : 1;
    row.refusalReason = reason;
    row.refusalCount = count;
    row.refusedAt = at;
    row.retryAfter = retryAt(count, at);
    this.flush();
    return { count };
  }

  /**
   * Writes that were started and that nobody ever resolved, oldest first. See
   * the note on `BranchQueueStore.unresolvedMergeOperations`: the obligation to
   * settle a write belongs to the write, because the attempt that used to carry
   * it does not survive the failure that needs settling.
   */
  unresolvedMergeOperations(startedBefore: string, now: string): UnresolvedMergeOperation[] {
    return this.doc.mergeOperations
      .filter((row) => row.outcome === null && row.writeStartedAt < startedBefore && due(row, now))
      .sort((a, b) =>
        a.writeStartedAt === b.writeStartedAt
          ? a.operationId.localeCompare(b.operationId)
          : a.writeStartedAt.localeCompare(b.writeStartedAt),
      )
      .map((row) => ({
        operationId: row.operationId,
        attemptId: row.attemptId,
        attemptRevision: row.attemptRevision,
        expectedBaseSha: row.expectedBaseSha,
        expectedHeadSha: row.expectedHeadSha,
        expectedTreeOid: row.expectedTreeOid,
        pullRequestNumber: row.pullRequestNumber ?? null,
        writeStartedAt: row.writeStartedAt,
      }));
  }

  /**
   * Merge writes resolved MERGED since a moment, oldest first. See the note on
   * `BranchQueueStore.mergedWritesResolvedAfter`: resolved is not finished, and
   * a merge whose record was skipped is invisible to the unresolved sweep.
   */
  mergedWritesResolvedAfter(resolvedAfter: string, now: string): UnresolvedMergeOperation[] {
    return this.doc.mergeOperations
      .filter(
        (row) =>
          row.outcome === "MERGED" &&
          typeof row.resolvedAt === "string" &&
          row.resolvedAt >= resolvedAfter &&
          due(row, now),
      )
      .sort((a, b) =>
        a.writeStartedAt === b.writeStartedAt
          ? a.operationId.localeCompare(b.operationId)
          : a.writeStartedAt.localeCompare(b.writeStartedAt),
      )
      .map((row) => ({
        operationId: row.operationId,
        attemptId: row.attemptId,
        attemptRevision: row.attemptRevision,
        expectedBaseSha: row.expectedBaseSha,
        expectedHeadSha: row.expectedHeadSha,
        expectedTreeOid: row.expectedTreeOid,
        pullRequestNumber: row.pullRequestNumber ?? null,
        writeStartedAt: row.writeStartedAt,
      }));
  }

  /**
   * Every merge write this queue has started, oldest first.
   *
   * `unresolvedMergeOperations` answers the sweep's question and hides the
   * settled ones, which is right for a sweep and wrong for a person. Diagnosing
   * the four stranded writes meant seeing the settled rows next to the open ones
   * to tell which pull requests the queue believed it had finished with, and
   * without this the only way to see them was SQL against the live database.
   */
  mergeOperations(): Array<MergeOperationRow & { pullRequestNumber: number | null }> {
    return [...this.doc.mergeOperations]
      .sort((a, b) =>
        a.writeStartedAt === b.writeStartedAt
          ? a.operationId.localeCompare(b.operationId)
          : a.writeStartedAt.localeCompare(b.writeStartedAt),
      )
      .map((row) => ({ ...row, pullRequestNumber: row.pullRequestNumber ?? null }));
  }

  mergeOperation(
    operationId: string,
  ): { attemptId: string; attemptRevision: number; outcome: string | null } | null {
    const row = this.doc.mergeOperations.find((o) => o.operationId === operationId);
    if (row === undefined) return null;
    return { attemptId: row.attemptId, attemptRevision: row.attemptRevision, outcome: row.outcome };
  }

  /* ---------------- callback staleness ---------------- */

  /**
   * Classify a callback that names an attempt and a revision.
   * A callback for an older attempt is stale and harmless; one for the current
   * attempt whose facts disagree is an invariant conflict that pauses the lane.
   */
  classifyCallback(
    attemptId: string,
    attemptRevision: number,
  ): "current" | "STALE_ATTEMPT" | "CURRENT_ATTEMPT_INVARIANT_CONFLICT" {
    if (this.state().activeAttemptId !== attemptId) return "STALE_ATTEMPT";
    if (this.attemptRevision() !== attemptRevision) return "CURRENT_ATTEMPT_INVARIANT_CONFLICT";
    return "current";
  }

  /**
   * Drop the in-memory copy and read the document again.
   *
   * A Durable Object eviction did this to the SQL store. Here it also re-parses
   * the stored JSON, so the chaos tests exercise the serialisation on every
   * eviction rather than only when a process restarts.
   */
  evict(): void {
    this.cached = null;
    const held = this.cell.read();
    if (held !== null) this.doc = JSON.parse(held) as Document;
  }
}
