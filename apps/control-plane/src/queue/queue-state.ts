import type { D1Like } from "./projection.js";
import { cellOf, SnapshotQueueStore } from "./snapshot-store.js";

/**
 * Read the queue document, run commands against it, write it back if it changed.
 *
 * A Durable Object gave the queue serialisation for free: one thread, one object,
 * so two authorizations could not overlap. D1 gives no such thing, and the lane
 * is exactly the fact that must never be handed out twice. So the ordering is
 * made explicit here with a compare-and-swap on the row's generation. A writer
 * reads the document and the generation together, and its update carries the
 * generation it read. If anything committed in between, the update matches no row
 * and the writer has to start again from what the winner wrote.
 *
 * Replaying is safe because every command carries an idempotency key. A command
 * that already landed in the winner's document is recognised as a duplicate on
 * the retry rather than applied twice, which is what makes "read, decide, write,
 * lose, decide again" produce the same answer as a queue that never raced.
 */

const MAX_ATTEMPTS = 5;

export interface LoadedQueueState {
  readonly store: SnapshotQueueStore;
  /** `unchanged` when the commands wrote nothing, so a read costs no write. */
  save(): Promise<"saved" | "conflict" | "unchanged">;
}

interface StateRow {
  generation: number;
  document: string;
}

function identityOf(repositoryId: string, baseRef: string) {
  return { queueKey: `${repositoryId}:${baseRef}`, repositoryId, baseRef };
}

export async function loadQueueState(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<LoadedQueueState> {
  const row = await db
    .prepare("SELECT generation, document FROM queue_state WHERE github_repository_id = ? AND base_ref = ?")
    .bind(repositoryId, baseRef)
    .first<StateRow>();

  const cell = cellOf(row?.document ?? null);
  const store = SnapshotQueueStore.open(cell, identityOf(repositoryId, baseRef));
  // What the row held, so a save can tell "nothing happened" from "the commands
  // produced the same bytes", and so the compare-and-swap has something to
  // compare against.
  const loadedDocument = row?.document ?? null;
  const loadedGeneration = row?.generation ?? null;

  return {
    store,
    async save() {
      const document = cell.read();
      if (document === null || document === loadedDocument) return "unchanged";
      const at = new Date().toISOString();

      if (loadedGeneration === null) {
        // No row yet. Two writers can reach here at once, so the insert has to
        // lose quietly rather than raise, and the loser retries against the row
        // the winner created.
        const result = await db
          .prepare(
            `INSERT INTO queue_state (github_repository_id, base_ref, generation, document, updated_at)
             VALUES (?, ?, 1, ?, ?)
             ON CONFLICT (github_repository_id, base_ref) DO NOTHING`,
          )
          .bind(repositoryId, baseRef, document, at)
          .run();
        return changed(result) ? "saved" : "conflict";
      }

      const result = await db
        .prepare(
          `UPDATE queue_state SET generation = ?, document = ?, updated_at = ?
            WHERE github_repository_id = ? AND base_ref = ? AND generation = ?`,
        )
        .bind(loadedGeneration + 1, document, at, repositoryId, baseRef, loadedGeneration)
        .run();
      return changed(result) ? "saved" : "conflict";
    },
  };
}

function changed(result: unknown): boolean {
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

export interface WithQueueStateOptions {
  /**
   * Runs between deciding and committing.
   *
   * The tests use it to commit a competing writer at the exact moment that makes
   * the compare-and-swap fail, which is the only way to produce the race on
   * purpose. Nothing in production passes it.
   */
  readonly beforeSave?: () => Promise<void>;
}

/**
 * Run `decide` against the queue and commit what it did, retrying against the
 * winner's state if somebody else commits first.
 *
 * `decide` may run more than once and must be safe to repeat, which for the queue
 * means every command it issues carries an idempotency key.
 *
 * It may be asynchronous, and it has to be: offering a turn writes the queue
 * decision record the offer binds, and digesting and storing that record are
 * both awaits. The result is awaited before the save, so a decision that has not
 * finished cannot be committed as though it had.
 */
export async function withQueueState<T>(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  decide: (store: SnapshotQueueStore) => T | Promise<T>,
  options: WithQueueStateOptions = {},
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const loaded = await loadQueueState(db, repositoryId, baseRef);
    const result = await decide(loaded.store);
    if (options.beforeSave !== undefined) await options.beforeSave();
    const outcome = await loaded.save();
    if (outcome !== "conflict") return result;
  }
  // Losing five times in a row is not contention, it is something writing to this
  // queue continuously. Failing here turns that into a retryable error for the
  // caller instead of a loop that holds the request open.
  throw new Error(
    `could not commit queue ${repositoryId} ${baseRef}: lost the compare-and-swap ${MAX_ATTEMPTS} times`,
  );
}
