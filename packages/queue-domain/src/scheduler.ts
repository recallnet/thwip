/**
 * `principal-round-robin-v1`.
 *
 * Fairness is per person, not per pull request, per key, or per device
 * (plan.md §8). Ten PRs from one author must not precede one PR from someone
 * else, so only a principal's oldest eligible entry ever competes, and the
 * principal served least recently wins the round.
 *
 * This module is pure and has no clock of its own: `now` is an argument so the
 * same inputs always produce the same choice.
 */

export interface EligibleEntry {
  readonly entryId: string;
  readonly sponsorPrincipalId: string;
  readonly sponsorGithubUserId: bigint;
  readonly fairnessOrdinal: bigint;
  readonly pullRequestNumber: number;
  readonly cooldownUntil: string | null;
}

const QUEUE_KEY_DOMAIN = "thwip-branch-queue-v1";

/**
 * Branch-scoped queue identity (plan.md §6.1). `main` and `release` are
 * separate protected resources and must not share a lane.
 */
export async function queueKey(decimalRepositoryId: string, exactBaseRef: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${QUEUE_KEY_DOMAIN}\n${decimalRepositoryId}\n${exactBaseRef}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparators run in order; the first non-zero decides. */
type Key = (entry: EligibleEntry) => bigint;

function minimumBy(entries: readonly EligibleEntry[], keys: readonly Key[]): EligibleEntry | null {
  let best: EligibleEntry | null = null;
  let bestKeys: bigint[] = [];
  for (const entry of entries) {
    const candidate = keys.map((k) => k(entry));
    if (best === null) {
      best = entry;
      bestKeys = candidate;
      continue;
    }
    for (let i = 0; i < candidate.length; i += 1) {
      const a = candidate[i]!;
      const b = bestKeys[i]!;
      if (a === b) continue;
      if (a < b) {
        best = entry;
        bestKeys = candidate;
      }
      break;
    }
  }
  return best;
}

/**
 * Within a principal, Ready entries are FIFO by fairness ordinal, so a blocked
 * entry cannot head-of-line block that principal's other independent work
 * (plan.md §8.3).
 */
function oldestEligibleEntryByPrincipal(entries: readonly EligibleEntry[]): EligibleEntry[] {
  const oldest = new Map<string, EligibleEntry>();
  for (const entry of entries) {
    const held = oldest.get(entry.sponsorPrincipalId);
    if (held === undefined || entry.fairnessOrdinal < held.fairnessOrdinal) {
      oldest.set(entry.sponsorPrincipalId, entry);
      continue;
    }
    // Equal ordinals can only happen across a repair; keep the choice stable.
    if (entry.fairnessOrdinal === held.fairnessOrdinal && entry.entryId < held.entryId) {
      oldest.set(entry.sponsorPrincipalId, entry);
    }
  }
  return [...oldest.values()];
}

/** Turn a string id into an ordering key without privileging its length. */
function lexicalKey(value: string): bigint {
  let acc = 0n;
  for (const char of value.slice(0, 16)) acc = (acc << 16n) | BigInt(char.charCodeAt(0));
  return acc;
}

export function selectNext(
  eligibleEntries: readonly EligibleEntry[],
  lastServedTurn: ReadonlyMap<string, bigint>,
  now: string,
): EligibleEntry | null {
  const eligible = eligibleEntries.filter(
    (entry) => entry.cooldownUntil === null || entry.cooldownUntil <= now,
  );

  return minimumBy(oldestEligibleEntryByPrincipal(eligible), [
    (entry) => lastServedTurn.get(entry.sponsorPrincipalId) ?? 0n,
    (entry) => entry.fairnessOrdinal,
    (entry) => entry.sponsorGithubUserId,
    (entry) => BigInt(entry.pullRequestNumber),
    (entry) => lexicalKey(entry.entryId),
  ]);
}
