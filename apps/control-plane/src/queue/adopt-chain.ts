import type { QueueCommands } from "./commands.js";
import type { D1Like } from "./projection.js";
import type { SnapshotQueueStore } from "./snapshot-store.js";

/**
 * Carry an existing transition chain into a fresh queue document.
 *
 * The queue's authority moved from a Durable Object to D1, and the object's
 * copy was unreachable when the move happened. The entries rebuild themselves,
 * because every pull request asks the gate again and is enqueued. The chain does
 * not: it is a hash chain, and a queue that starts a new document would record
 * its next merge with a null prior digest, claiming to be the first link when
 * twenty-one came before it. That is a false claim about integrity, which is the
 * one thing this product sells.
 *
 * So the recorded links are replayed through the reducer, which checks that each
 * sequence is consecutive and that each prior digest matches the link before it.
 * A projection that disagrees with itself is refused rather than adopted.
 *
 * `attemptId` is deliberately dropped. The reducer will only chain an attempt it
 * can see in the state and that state is new, so keeping the identifiers would
 * mean inventing merged attempts to satisfy a check. The attempt each link came
 * from is still recorded in the projection, which is where a reader looks for it.
 */

export interface AdoptedChain {
  adopted: number;
  /** Why nothing was adopted, when nothing was. */
  reason?: string;
}

interface ProjectedTransition {
  transition_sequence: number;
  kind: string;
  digest: string;
  prior_digest: string | null;
  base_sha: string;
}

export async function readProjectedChain(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<readonly ProjectedTransition[]> {
  const rows = await db
    .prepare(
      `SELECT transition_sequence, kind, digest, prior_digest, base_sha
         FROM queue_transitions_index
        WHERE github_repository_id = ? AND base_ref = ?
        ORDER BY transition_sequence`,
    )
    .bind(repositoryId, baseRef)
    .all<ProjectedTransition>();
  return rows.results;
}

export function adoptChain(
  commands: QueueCommands,
  store: SnapshotQueueStore,
  chain: readonly ProjectedTransition[],
): AdoptedChain {
  // Only ever into an empty chain. Adopting on top of links this queue recorded
  // itself would either duplicate them or be refused halfway, and a partly
  // adopted chain is worse than none.
  if (store.state().transitions.length > 0) {
    return { adopted: 0, reason: "CHAIN_ALREADY_PRESENT" };
  }
  if (chain.length === 0) return { adopted: 0, reason: "NOTHING_TO_ADOPT" };

  let adopted = 0;
  for (const link of chain) {
    const result = commands.recordTransition({
      idempotencyKey: `adopt:${link.transition_sequence}:${link.digest}`,
      kind: link.kind as never,
      transitionSequence: link.transition_sequence,
      priorDigest: link.prior_digest,
      digest: link.digest,
      baseSha: link.base_sha,
      attemptId: null,
      witnessPrincipalIds: [],
    });
    if (result.status === "rejected") {
      // The reducer found a break in the links. Stop rather than skip: the point
      // of adopting is that the chain still checks out, and a chain with a hole
      // in it proves nothing.
      return { adopted, reason: `LINK_REFUSED_AT_${link.transition_sequence}` };
    }
    adopted += 1;
  }
  return { adopted };
}
