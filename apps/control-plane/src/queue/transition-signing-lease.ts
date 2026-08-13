import type { D1Like } from "./projection.js";
import { withQueueState } from "./queue-state.js";

/** Shorter than the five-minute heartbeat, so a crashed signer cannot wedge the chain. */
const TRANSITION_SIGNING_LEASE_MS = 4 * 60 * 1_000;
const TRANSITION_SIGNING_RENEW_MS = TRANSITION_SIGNING_LEASE_MS / 3;

export interface TransitionSigningFence {
  /** Renew the claim and prove no later owner has fenced this writer out. */
  fence(): Promise<boolean>;
}

/**
 * Run one signed transition-record writer for a branch at a time.
 *
 * The claim is durable and uses the same queue-document compare-and-swap as
 * webhooks, merge callbacks and heartbeat repair. A loser does not wait inside
 * a Worker invocation; its normal retry or the next heartbeat tries again.
 */
export async function withTransitionSigningLease<T>(
  db: D1Like,
  input: { repositoryId: string; baseRef: string; owner: string },
  work: (claim: TransitionSigningFence) => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const now = new Date().toISOString();
  const until = new Date(Date.parse(now) + TRANSITION_SIGNING_LEASE_MS).toISOString();
  const acquired = await withQueueState(db, input.repositoryId, input.baseRef, (store) =>
    store.claimTransitionSigning(input.owner, now, until),
  );
  if (!acquired) return { acquired: false };

  let fencedOut = false;
  const renew = async (): Promise<boolean> => {
    if (fencedOut) return false;
    const renewedUntil = new Date(Date.now() + TRANSITION_SIGNING_LEASE_MS).toISOString();
    const stillOwned = await withQueueState(db, input.repositoryId, input.baseRef, (store) =>
      store.renewTransitionSigning(input.owner, renewedUntil),
    );
    if (!stillOwned) fencedOut = true;
    return stillOwned;
  };
  const claim: TransitionSigningFence = {
    fence: renew,
  };
  // Keep a live writer's claim alive across slow GitHub, signing-key and R2
  // calls. Expiry remains crash recovery; it is not permission to overlap a
  // worker that is still making progress.
  const renewal = setInterval(() => {
    void renew().catch(() => {
      fencedOut = true;
    });
  }, TRANSITION_SIGNING_RENEW_MS);

  try {
    return { acquired: true, result: await work(claim) };
  } finally {
    clearInterval(renewal);
    await withQueueState(db, input.repositoryId, input.baseRef, (store) => {
      store.releaseTransitionSigning(input.owner);
    });
  }
}
