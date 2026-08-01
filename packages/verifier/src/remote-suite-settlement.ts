/**
 * Proving that a remote suite failed.
 *
 * This is the merge path's rule (`apps/control-plane/src/queue/merge-absence.ts`,
 * `confirmMergeAbsence`) applied to a different question. That rule exists
 * because one read of GitHub decided a merge had not happened 1.5 seconds after
 * it had, and three merges left the signed chain
 * (`.superpowers/sdd/not-merged-report.md`). The same shape sat here: one read
 * of `check-runs`, and a check that had not finished was written down as a
 * failure the developer read as "your tests failed".
 *
 * So the same discipline holds. A pass ends it on the first read. A failure is a
 * conclusion of last resort: every read across a 1s/2s/4s backoff has to name
 * the same suite and the same conclusion. A check still running, a check that
 * has not appeared, and a read GitHub would not answer all mean the same thing,
 * which is that nobody knows yet. That is `unsettled`, and the caller waits
 * instead of writing a verdict down.
 *
 * `confirmMergeAbsence` itself is not reused. It reads a pull request and git
 * ancestry, two sources the verifier has no access to and no business holding,
 * and it lives in the control plane while this runs in the Action too. Sharing
 * it would mean widening it into a generic poller and losing the thing that
 * makes it readable, which is that it names what it asks and why.
 */

/** Check conclusions by check name. `pending` stands for a run GitHub has not completed. */
export type SuiteConclusions = ReadonlyMap<string, string>;

export interface SettlementReads {
  /** Conclusions for the head commit, or null when the list could not be read. */
  readConclusions(): Promise<SuiteConclusions | null>;
}

export type SuiteSettlement =
  | { readonly kind: "passed" }
  | { readonly kind: "failed"; readonly suiteId: string; readonly conclusion: string; readonly reason: string }
  | { readonly kind: "unsettled"; readonly reason: string };

/** Three reads over seven seconds, matching the merge path. */
export const SETTLEMENT_ATTEMPTS = 3;
export const SETTLEMENT_DELAYS_MS = [1000, 2000, 4000] as const;

/** States GitHub reports for a run it has not concluded. */
const NOT_CONCLUDED = new Set(["pending", "queued", "in_progress", "waiting", "requested", "none", ""]);

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Negative {
  suiteId: string;
  conclusion: string;
}

/** Ask repeatedly how GitHub's own checks concluded, and report a failure only when every answer agreed. */
export async function settleRemoteSuites(
  suiteIds: readonly string[],
  reads: SettlementReads,
  options: {
    readonly attempts?: number;
    readonly delaysMs?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<SuiteSettlement> {
  const attempts = options.attempts ?? SETTLEMENT_ATTEMPTS;
  const delays = options.delaysMs ?? SETTLEMENT_DELAYS_MS;
  const sleep = options.sleep ?? wait;

  let agreed = 0;
  let agreedNegative: Negative | null = null;
  let unsettled = "no read of GitHub's checks was attempted";

  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(delays[Math.min(i - 1, delays.length - 1)] ?? 1000);

    const conclusions = await reads.readConclusions();
    if (conclusions === null) {
      unsettled = "GitHub did not answer when asked which checks ran on this commit; thwip reads again and decides then";
      continue;
    }

    let waiting: string | null = null;
    let negative: Negative | null = null;
    for (const suiteId of suiteIds) {
      const conclusion = conclusions.get(suiteId) ?? conclusions.get(`thwip / ${suiteId}`);
      if (conclusion === undefined) {
        waiting ??= `\`${suiteId}\` has no check on this commit yet; thwip verifies the proof once GitHub reports one`;
        continue;
      }
      if (conclusion === "success") continue;
      if (NOT_CONCLUDED.has(conclusion)) {
        waiting ??= `GitHub is still running \`${suiteId}\` on this commit; thwip verifies the proof once that check reports`;
        continue;
      }
      negative ??= { suiteId, conclusion };
    }

    if (negative === null && waiting === null) return { kind: "passed" };
    if (negative === null) {
      // A read that says "still running" breaks any agreement a previous read
      // built, because the reads no longer say the same thing.
      agreed = 0;
      agreedNegative = null;
      unsettled = waiting!;
      continue;
    }
    if (agreedNegative !== null && agreedNegative.suiteId === negative.suiteId && agreedNegative.conclusion === negative.conclusion) {
      agreed += 1;
    } else {
      agreedNegative = negative;
      agreed = 1;
    }
    unsettled = `GitHub's reads disagree about \`${negative.suiteId}\`; thwip reads again and decides then`;
  }

  if (agreedNegative !== null && agreed === attempts) {
    return {
      kind: "failed",
      suiteId: agreedNegative.suiteId,
      conclusion: agreedNegative.conclusion,
      reason: `GitHub's check for \`${agreedNegative.suiteId}\` concluded ${agreedNegative.conclusion} on this commit, and ${attempts} reads agree; fix that check and push again`,
    };
  }
  return { kind: "unsettled", reason: unsettled };
}
