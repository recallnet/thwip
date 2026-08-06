/**
 * Performing the merge the queue authorized, from the Worker.
 *
 * The App owns the write. Writing a commit object and moving a ref are both
 * covered by `contents: write`; GitHub additionally requires `workflows: write`
 * when the tree changes `.github/workflows`. `appOwnershipRuleset` names the
 * App as the only actor that may update the queued branch, so the fast-forward
 * guard is code this repository tests directly.
 *
 * The guard is one sentence. GitHub accepts a ref update without force only
 * where the branch is an ancestor of the new commit, and the only branch that is
 * an ancestor of a commit whose first parent is the pinned base is that base. So
 * a base that moved makes GitHub refuse and the merge does not happen at all.
 * Pull requests 114, 117, 119 and 121 each merged onto a base they were not
 * verified against, through an API that takes an expected head and no expected
 * base, and GitHub reported all four as successes.
 *
 * Nothing here decides anything about the merge. The base, the tree and the
 * parents come from the queue document; this composes exactly those and moves
 * the branch to the result, and the reducer refuses a confirmation whose first
 * parent is not the pinned base as the second net.
 */

import { confirmMergeAbsence } from "./merge-absence.js";

/**
 * The one shape a branch move may take.
 *
 * `force` is typed to the literal `false` rather than to `boolean`, so a caller
 * that wants to force cannot be written. `merge-write.test.ts` also reads the
 * recorded request back at the runtime boundary.
 */
export interface RefUpdate {
  readonly sha: string;
  readonly force: false;
}

/**
 * The JSON body of a branch move, built in one place.
 *
 * The type already makes a forcing caller unwriteable. This is the same rule at
 * runtime, for the boundary where a `RefUpdate` arrives as parsed JSON and the
 * type has stopped meaning anything: an update that says anything but
 * `force: false` never reaches GitHub.
 */
export function refUpdateRequestBody(update: RefUpdate): string {
  if (update.force !== false) {
    throw new Error(
      "a queue merge moves the branch without force; the update that does not force is what makes GitHub refuse a base that moved",
    );
  }
  return JSON.stringify({ sha: update.sha, force: false });
}

export interface MergeWriteGithub {
  /** Write the merge commit object. Writes nothing to any branch. */
  createCommit(input: {
    message: string;
    tree: string;
    parents: readonly string[];
  }): Promise<{ ok: true; sha: string } | { ok: false; status: number; message: string }>;
  /** Move a branch to a commit. The only call here that changes the repository. */
  updateRef(
    ref: string,
    update: RefUpdate,
  ): Promise<{ ok: true; sha: string } | { ok: false; status: number; message: string }>;
  /** What the pull request says about itself, or null when it could not be read. */
  readPull(): Promise<{ merged: boolean; mergeCommitSha: string | null } | null>;
  /** Whether the base branch already contains the head, from git ancestry. */
  baseContainsHead(): Promise<boolean | null>;
  /**
   * Whether GitHub reads the App's own required check on this head as
   * concluded. Null where the check runs could not be read.
   *
   * Not optional. A caller that could leave it out would move the branch into
   * the race this exists to close, and would do it silently.
   */
  requiredTurnCheckConcluded(): Promise<boolean | null>;
}

/** The commit the queue pinned. Every field comes from the queue document. */
export interface MergeIntent {
  readonly baseRef: string;
  /** Which pull request, so a failed write can ask what became of it. */
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeOid: string;
  readonly parentShas: readonly string[];
  readonly message: string;
}

export type MergeWriteOutcome =
  /** `mergeSha` is null where git settled it and the branch was not read. */
  | { readonly kind: "merged"; readonly mergeSha: string | null }
  | { readonly kind: "base-moved"; readonly detail: string }
  | { readonly kind: "not-merged"; readonly detail: string }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

/** GitHub's wording for the refusal that means the base is no longer the base. */
const NOT_A_FAST_FORWARD = /not a fast forward/i;

/**
 * GitHub's wording for a required check it has not finished reading.
 *
 * The Worker publishes `thwip / turn` green and moves the branch inside one
 * request, and GitHub's rule evaluation runs behind its own check-run write, so
 * the ref update is refused with 422 naming a check that just concluded.
 * Narrow on purpose. A required check that is genuinely unsatisfied says
 * "expected" rather than "in progress", takes no retry, and still refuses the
 * merge.
 */
const CHECK_IN_PROGRESS = /required status check.*\bis in progress\b/i;

/** Four moves over seven seconds, which outlasts every lag seen so far. */
export const REF_UPDATE_ATTEMPTS = 4;
const REF_UPDATE_DELAYS_MS = [500, 1500, 3000] as const;

/** How long to wait for GitHub to read its own check run as concluded. */
const CHECK_READ_ATTEMPTS = 4;
const CHECK_READ_DELAYS_MS = [500, 1000, 2000] as const;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function performMergeWrite(
  github: MergeWriteGithub,
  intent: MergeIntent,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<MergeWriteOutcome> {
  // Refused before anything is written. A commit whose first parent is not the
  // pinned base is not bindable to that base by a ref update, so composing it
  // would leave an object nothing can safely land — and a squash, which has one
  // parent and does not contain the head, is exactly that commit.
  if (intent.parentShas[0] !== intent.baseSha) {
    return {
      kind: "refused",
      detail:
        "the merge commit's first parent is not the base the queue pinned, so a ref update cannot bind it to that base",
    };
  }

  const sleep = options.sleep ?? wait;

  // Let GitHub catch up with its own check run before asking it to apply the
  // rule that reads it. Unreadable is not a stop: the ref update is the
  // authority on whether the branch may move, and the retry below covers the
  // window this read was trying to skip.
  for (let i = 0; i < CHECK_READ_ATTEMPTS; i += 1) {
    if (i > 0) await sleep(CHECK_READ_DELAYS_MS[Math.min(i - 1, CHECK_READ_DELAYS_MS.length - 1)] ?? 1000);
    const concluded = await github.requiredTurnCheckConcluded();
    if (concluded !== false) break;
  }

  const composed = await github.createCommit({
    message: intent.message,
    tree: intent.treeOid,
    parents: intent.parentShas,
  });
  if (!composed.ok) {
    // Nothing was written to the branch, so nothing merged. Unknown rather than
    // a refusal, because the queue has said nothing about this attempt yet and
    // reconciliation reads rather than guesses.
    return {
      kind: "unknown",
      detail: `the merge commit could not be written (${composed.status}: ${composed.message})`,
    };
  }

  // The same commit object every time. Composing a fresh one per retry leaves an
  // orphan on the repository for each attempt that GitHub refused.
  let landed = await github.updateRef(intent.baseRef, { sha: composed.sha, force: false });
  for (let i = 1; i < REF_UPDATE_ATTEMPTS; i += 1) {
    if (landed.ok || landed.status !== 422 || !CHECK_IN_PROGRESS.test(landed.message)) break;
    await sleep(REF_UPDATE_DELAYS_MS[Math.min(i - 1, REF_UPDATE_DELAYS_MS.length - 1)] ?? 1000);
    landed = await github.updateRef(intent.baseRef, { sha: composed.sha, force: false });
  }
  if (landed.ok) return { kind: "merged", mergeSha: landed.sha };

  // Running out of patience with GitHub concludes nothing. The branch never
  // moved, and every read here would agree it did not, which is exactly the
  // shape of answer that would let the queue write down a refusal it has no
  // business being sure of. The sweep asks again later.
  if (landed.status === 422 && CHECK_IN_PROGRESS.test(landed.message)) {
    return {
      kind: "unknown",
      detail: `GitHub refused the branch move ${REF_UPDATE_ATTEMPTS} times because a required status check had not concluded (${landed.message})`,
    };
  }

  if (NOT_A_FAST_FORWARD.test(landed.message)) {
    return {
      kind: "base-moved",
      detail: `the base branch is no longer ${intent.baseSha}, which is what this candidate was verified against`,
    };
  }

  // The status code says what this call did, not what became of the pull
  // request. Two writers can race for one turn: one lands the merge and the
  // other is told 405, and reporting that as a refusal declares a merge did not
  // happen at the moment it just did. GitHub's reads also lag its own writes, so
  // one negative read is not a negative.
  const absence = await confirmMergeAbsence(
    { readPull: () => github.readPull(), baseContainsHead: () => github.baseContainsHead() },
    options.sleep === undefined ? {} : { sleep: options.sleep },
  );
  if (absence.kind === "merged") return { kind: "merged", mergeSha: absence.mergeSha };
  if (absence.kind === "not-merged") {
    return { kind: "not-merged", detail: `${landed.status}: ${landed.message}` };
  }
  return { kind: "unknown", detail: `${landed.status}: ${landed.message}; ${absence.reason}` };
}
