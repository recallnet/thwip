/**
 * Answer "not your turn" from the projection, without waking the object.
 *
 * The Durable Object is the authority and the projection lags behind it. That
 * asymmetry is the whole design here:
 *
 *   A stale "not your turn" is safe. The worst case is that it is pessimistic and
 *   the pull request waits one more round.
 *
 *   A stale "yes, you hold the lane" is catastrophic. Two pull requests merge at
 *   once and the single invariant this product exists to provide is gone.
 *
 * So this may only ever decline. Every authorization comes from the object, and
 * nothing here can produce one. When it is not certain, it says nothing and the
 * caller escalates.
 *
 * The win is that in a queue of N pull requests, N-1 are waiting. Only the one at
 * the head needs an authoritative answer, so a busier queue costs less per pull
 * request rather than more.
 */

export interface ProjectedEntry {
  readonly entryId: string;
  readonly state: string;
  readonly primaryReason: string | null;
  readonly schedulerEligible: boolean;
  readonly lastAttemptId: string | null;
  readonly headSha: string | null;
}

export interface ProjectedQueue {
  readonly activeAttemptId: string | null;
  readonly paused: boolean;
  readonly entries: readonly ProjectedEntry[];
}

export type Decline =
  | { readonly decline: true; readonly reason: string; readonly queuePosition: number }
  | { readonly decline: false };

/**
 * `null` for the projection means "nothing has been projected", which is not the
 * same as an empty queue and must escalate.
 */
export function declineFromProjection(
  projected: ProjectedQueue | null,
  input: { readonly entryId: string; readonly headSha: string },
): Decline {
  if (projected === null) return { decline: false };

  const entry = projected.entries.find((e) => e.entryId === input.entryId);

  // Not recorded yet, so this check has to enqueue it. That is a write and only
  // the object can do it.
  if (entry === undefined) return { decline: false };

  // Recorded against a different commit. The projection is answering about work
  // this check is not asking about, which is worse than not answering.
  if (entry.headSha === null || entry.headSha !== input.headSha) return { decline: false };

  // Already finished. Escalate rather than guess: a merged or cancelled entry
  // that has since been re-opened is exactly the case the projection gets wrong.
  if (entry.state === "Merged" || entry.state === "Cancelled") return { decline: false };

  const waiting = projected.entries.filter(
    (e) => e.state !== "Merged" && e.state !== "Cancelled" && e.schedulerEligible,
  ).length;

  if (projected.paused) {
    return { decline: true, reason: "QUEUE_PAUSED", queuePosition: waiting };
  }

  // Someone else demonstrably holds the lane. The projection can only be behind,
  // so at worst that pull request has since finished and this one waits one more
  // round. It cannot be ahead, so this can never decline a pull request that
  // actually holds the lane.
  if (projected.activeAttemptId !== null) {
    const holder = projected.entries.find((e) => e.lastAttemptId === projected.activeAttemptId);
    if (holder !== undefined && holder.entryId !== input.entryId) {
      return { decline: true, reason: "WAITING_FOR_TURN", queuePosition: waiting };
    }
    // The lane is held by this entry, or by an attempt the projection cannot
    // place. Either way the object decides.
    return { decline: false };
  }

  // The lane is free. Whether this entry gets it is a scheduling decision, and
  // scheduling belongs to the object.
  return { decline: false };
}
