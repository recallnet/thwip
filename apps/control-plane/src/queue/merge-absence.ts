/**
 * Proving that a merge did not happen.
 *
 * Saying a merge landed needs evidence, and so does saying it did not. GitHub's
 * reads are eventually consistent with GitHub's own writes: a pull request that
 * merged at 16:41:38 answered `merged: false` at 16:41:39. A queue that turns
 * that one answer into a durable negative writes a chain that is missing the
 * merge it just performed, which is the one failure the chain exists to prevent.
 *
 * So a negative here is a conclusion of last resort. Every read has to agree,
 * across a backoff long enough to outlast the lag, and git has to agree too: if
 * the base branch already contains the head commit then the merge landed
 * whatever the pull request says about itself. Anything short of that is
 * unknown, and unknown is carried by MERGE_OUTCOME_UNKNOWN, which reconciles
 * instead of deciding.
 */

/** What the pull request says about itself, or null when it could not be read. */
export interface PullMergeState {
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
}

export interface AbsenceReads {
  readPull(): Promise<PullMergeState | null>;
  /**
   * Whether the base branch already contains the head commit, from git ancestry
   * rather than from the pull request's own flag. Null when it cannot be read.
   */
  baseContainsHead(): Promise<boolean | null>;
}

export type AbsenceVerdict =
  | { readonly kind: "merged"; readonly mergeSha: string | null; readonly reason: string }
  | { readonly kind: "not-merged"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/** Three reads over seven seconds, which is an order of magnitude past the lag seen. */
const ABSENCE_ATTEMPTS = 3;
const ABSENCE_DELAYS_MS = [1000, 2000, 4000] as const;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask repeatedly whether the merge landed, and only report a negative when every
 * answer, from both sources, said so.
 */
export async function confirmMergeAbsence(
  reads: AbsenceReads,
  options: {
    readonly attempts?: number;
    readonly delaysMs?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<AbsenceVerdict> {
  const attempts = options.attempts ?? ABSENCE_ATTEMPTS;
  const delays = options.delaysMs ?? ABSENCE_DELAYS_MS;
  const sleep = options.sleep ?? wait;

  let agreed = 0;
  let unreadable = "no read was attempted";

  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(delays[Math.min(i - 1, delays.length - 1)] ?? 1000);

    const pull = await reads.readPull();
    if (pull?.merged === true) {
      return { kind: "merged", mergeSha: pull.mergeCommitSha, reason: "the pull request reports itself merged" };
    }

    const contains = await reads.baseContainsHead();
    if (contains === true) {
      // Git settles it. The pull request read is behind its own write, which is
      // exactly the state that made the queue conclude a merge had not happened
      // one and a half seconds after it had.
      return {
        kind: "merged",
        // No sha. This arm is reached exactly when the pull request has not
        // caught up with its own merge, and while a pull request is open
        // `merge_commit_sha` holds the test merge GitHub computes for it: same
        // parents and same tree as the real merge, different commit, on no
        // branch. Carrying that value out would let a chain claim that the base
        // became a commit it never contained. What landed is read from the
        // branch by the caller, or not read at all.
        mergeSha: null,
        reason: "the base branch already contains the head commit",
      };
    }

    if (pull === null) {
      unreadable = "the pull request could not be read";
      continue;
    }
    if (contains === null) {
      unreadable = "the base branch could not be compared to the head commit";
      continue;
    }
    agreed += 1;
  }

  if (agreed === attempts) {
    return {
      kind: "not-merged",
      reason: `${attempts} reads agree the pull request is not merged and the base does not contain the head commit`,
    };
  }
  return { kind: "unknown", reason: unreadable };
}
