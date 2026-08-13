import type { D1Like } from "./projection.js";
import { cellOf, SnapshotQueueStore } from "./snapshot-store.js";
import { acquireProjectWriteLease, type ProjectWriteLease } from "../project-lifecycle.js";

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
  /** Project incarnation that owns this queue document. */
  readonly projectId: string | null;
  /** `unchanged` when the commands wrote nothing, so a read costs no write. */
  save(): Promise<"saved" | "conflict" | "unchanged" | "removed">;
}

interface StateRow {
  generation: number;
  document: string;
  projectId: string | null;
}

function identityOf(repositoryId: string, baseRef: string) {
  return { queueKey: `${repositoryId}:${baseRef}`, repositoryId, baseRef };
}

export class QueueProjectUnavailableError extends Error {
  constructor(readonly repositoryId: string) {
    super(`repository ${repositoryId} has been unavailable in thwip`);
    this.name = "QueueProjectUnavailableError";
  }
}

async function projectIsUnavailable(db: D1Like, repositoryId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found
         WHERE EXISTS (SELECT 1 FROM project_release_jobs WHERE github_repository_id = ?)
            OR NOT EXISTS (
              SELECT 1 FROM projects p JOIN organizations o ON o.id = p.organization_id
               WHERE p.github_repository_id = ? AND o.status = 'active'
            )`,
    )
    .bind(repositoryId, repositoryId)
    .first<{ found: number }>();
  return row !== null;
}

export async function loadQueueState(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<LoadedQueueState> {
  const row = await db
    .prepare(
      "SELECT generation, document, project_id AS projectId FROM queue_state WHERE github_repository_id = ? AND base_ref = ?",
    )
    .bind(repositoryId, baseRef)
    .first<StateRow>();
  const currentProject = await db
    .prepare(
      `SELECT p.id
         FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE p.github_repository_id = ? AND o.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM project_release_jobs j WHERE j.github_repository_id = p.github_repository_id)`,
    )
    .bind(repositoryId)
    .first<{ id: string }>();
  const projectId = row?.projectId ?? currentProject?.id ?? null;

  const cell = cellOf(row?.document ?? null);
  const store = SnapshotQueueStore.open(cell, identityOf(repositoryId, baseRef));
  // What the row held, so a save can tell "nothing happened" from "the commands
  // produced the same bytes", and so the compare-and-swap has something to
  // compare against.
  const loadedDocument = row?.document ?? null;
  const loadedGeneration = row?.generation ?? null;

  return {
    store,
    projectId,
    async save() {
      const document = cell.read();
      if (document === null || document === loadedDocument) return "unchanged";
      const at = new Date().toISOString();

      if (loadedGeneration === null) {
        if (projectId === null) return "removed";
        // No row yet. Two writers can reach here at once, so the insert has to
        // lose quietly rather than raise, and the loser retries against the row
        // the winner created.
        const result = await db
          .prepare(
            `INSERT INTO queue_state (github_repository_id, base_ref, generation, document, updated_at, project_id)
             SELECT ?, ?, 1, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM projects p JOIN organizations o ON o.id = p.organization_id
                 WHERE p.id = ? AND p.github_repository_id = ? AND o.status = 'active'
              ) AND NOT EXISTS (
                SELECT 1 FROM project_release_jobs WHERE github_repository_id = ?
              )
             ON CONFLICT (github_repository_id, base_ref) DO NOTHING`,
          )
          .bind(repositoryId, baseRef, document, at, projectId, projectId, repositoryId, repositoryId)
          .run();
        if (changed(result)) return "saved";
        return (await projectIsUnavailable(db, repositoryId)) ? "removed" : "conflict";
      }

      const result = await db
        .prepare(
          `UPDATE queue_state SET generation = ?, document = ?, updated_at = ?
            WHERE github_repository_id = ? AND base_ref = ? AND generation = ? AND project_id = ?
              AND EXISTS (
                SELECT 1 FROM projects p JOIN organizations o ON o.id = p.organization_id
                 WHERE p.id = ? AND p.github_repository_id = ? AND o.status = 'active'
              ) AND NOT EXISTS (
                SELECT 1 FROM project_release_jobs WHERE github_repository_id = ?
              )`,
        )
        .bind(
          loadedGeneration + 1,
          document,
          at,
          repositoryId,
          baseRef,
          loadedGeneration,
          projectId,
          projectId,
          repositoryId,
          repositoryId,
        )
        .run();
      if (changed(result)) return "saved";
      return (await projectIsUnavailable(db, repositoryId)) ? "removed" : "conflict";
    },
  };
}

function changed(result: unknown): boolean {
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

export interface WithQueueStateOptions {
  /** Reject work queued for an earlier project incarnation. */
  readonly expectedProjectId?: string;
  /** Reuse the lease held by a larger operation, including during release drain. */
  readonly lease?: ProjectWriteLease;
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
  decide: (store: SnapshotQueueStore, projectId: string | null) => T | Promise<T>,
  options: WithQueueStateOptions = {},
): Promise<T> {
  let loaded = await loadQueueState(db, repositoryId, baseRef);
  const expectedProjectId = options.expectedProjectId ?? loaded.projectId ?? undefined;
  const borrowed = options.lease !== undefined;
  const lease = options.lease ?? await acquireProjectWriteLease(db, repositoryId, expectedProjectId);
  if (lease === null || loaded.projectId !== lease.projectId) {
    if (!borrowed) await lease?.release();
    throw new QueueProjectUnavailableError(repositoryId);
  }
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) loaded = await loadQueueState(db, repositoryId, baseRef);
      if (loaded.projectId !== lease.projectId) throw new QueueProjectUnavailableError(repositoryId);
      await lease.renew();
      const result = await decide(loaded.store, loaded.projectId);
      if (options.beforeSave !== undefined) await options.beforeSave();
      await lease.renew();
      const outcome = await loaded.save();
      if (outcome === "removed") throw new QueueProjectUnavailableError(repositoryId);
      if (outcome !== "conflict") return result;
    }
  } finally {
    if (!borrowed) await lease.release();
  }
  // Losing five times in a row is not contention, it is something writing to this
  // queue continuously. Failing here turns that into a retryable error for the
  // caller instead of a loop that holds the request open.
  throw new Error(
    `could not commit queue ${repositoryId} ${baseRef}: lost the compare-and-swap ${MAX_ATTEMPTS} times`,
  );
}
