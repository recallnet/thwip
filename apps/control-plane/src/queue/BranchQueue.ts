import { DurableObject } from "cloudflare:workers";
import { BranchQueueStore } from "./store.js";
import { buildSnapshot, type QueueSnapshot } from "./queue-operations.js";
import type { SqlLike } from "./sql.js";

/**
 * What is left of the Durable Object the queue used to live in.
 *
 * The queue's authority is a D1 document now. Durable Object requests are
 * metered against a daily cap, and while this class was in the path of every
 * merge decision a single spinning alarm spent that cap twice in one week, each
 * time stopping every merge in the repository for the rest of the day.
 *
 * The class stays for two reasons and does two things. It stays because the
 * binding has to resolve, and because removing the class from the configuration
 * takes a migration that deletes what it stored — which is the only record of
 * what the queue knew before the move, and worth keeping until nobody has any
 * reason to look at it again.
 *
 * So it reads, and that is all it does.
 *
 * The commands are gone rather than left throwing. Every one of them was a way
 * to write to a copy of the state that nothing reads, silently, which is exactly
 * what went wrong when the webhook handler kept calling this after the move: a
 * closed pull request stayed in a queue nobody was looking at, holding the lane
 * until somebody noticed by hand. A caller still holding the old interface now
 * fails on a method that does not exist, which is as loud as an exception and
 * needs no list here to stay accurate.
 */

export interface BranchQueueEnv {
  readonly THWIP_ENV?: string;
}

export class BranchQueue extends DurableObject<BranchQueueEnv> {
  private store: BranchQueueStore | null = null;

  /** What this object held when it was still the authority, or null if it never was. */
  async snapshot(): Promise<QueueSnapshot | null> {
    const store = this.reopen();
    return store === null ? null : buildSnapshot(store);
  }

  /**
   * Stop, and do not ask to be woken again.
   *
   * Deadlines are handled by whatever touches the queue next. Anything this
   * object did on a timer would be acting on state nothing reads, and every wake
   * is billed against a cap that two separate spins have already exhausted.
   */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

  /** Permanently remove the retired copy after its project is removed. */
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.store = null;
  }

  /** The identity this object wrote when it was the authority, or nothing. */
  private reopen(): BranchQueueStore | null {
    if (this.store !== null) return this.store;
    const sql = this.ctx.storage.sql as unknown as SqlLike;
    let row: { queue_key: string; repository_id: string; base_ref: string } | undefined;
    try {
      row = sql
        .exec<{ queue_key: string; repository_id: string; base_ref: string }>(
          "SELECT queue_key, repository_id, base_ref FROM queue_meta WHERE id = 1",
        )
        .toArray()[0];
    } catch {
      // No schema, so this object was never bound to anything.
      return null;
    }
    if (row === undefined) return null;
    this.store = BranchQueueStore.open(sql, {
      queueKey: row.queue_key,
      repositoryId: row.repository_id,
      baseRef: row.base_ref,
    });
    return this.store;
  }
}
