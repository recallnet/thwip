/**
 * Performing the merge the queue authorized, from the Worker.
 *
 * This used to be shell inside every adopter's `thwip-merge.yml`, behind a
 * `THWIP_ENQUEUE_TOKEN` the adopter minted and pasted into Actions. That put a
 * branch-write credential in the most exposed surface in the design, made every
 * adopter rotate one, and left the guard that makes the whole scheme safe as
 * untested shell in somebody else's repository. The App already requires
 * `contents: write` — writing a commit object and moving a ref are both
 * Contents, and `managedOwnershipRuleset` already names the App as the only
 * actor that may update a managed branch — so the write moves here and the
 * guard becomes code with tests around it.
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
 * that wants to force cannot be written. The workflow version of this is held
 * to the same property by regex in `scripts/workflow-lint.mjs`; a type is what
 * holds it here, and `merge-write.test.ts` reads the recorded request back.
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

  const landed = await github.updateRef(intent.baseRef, { sha: composed.sha, force: false });
  if (landed.ok) return { kind: "merged", mergeSha: landed.sha };

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

/**
 * Who moves the branch for a queue project.
 *
 * `workflow` is every repository enrolled before this existed: the merge is
 * shell in `thwip-merge.yml` behind the adopter's own token. `app` is the
 * Worker performing it. One at a time, and never before the repository has
 * stopped running the workflow, because two writers racing for one turn is how
 * a merge that landed gets reported as a base that moved.
 */
export type MergeWriter = "workflow" | "app";

export function mergeWriterOf(value: string | null | undefined): MergeWriter {
  return value === "app" ? "app" : "workflow";
}
