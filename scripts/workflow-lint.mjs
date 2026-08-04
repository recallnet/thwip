import { parse } from "yaml";

/** Parse a workflow and require the top-level trigger GitHub expects. */
export function validateWorkflow(filename, source) {
  let workflow;
  try {
    workflow = parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${filename}: invalid YAML: ${detail}`, { cause: error });
  }

  if (
    workflow === null ||
    typeof workflow !== "object" ||
    Array.isArray(workflow) ||
    !Object.hasOwn(workflow, "on")
  ) {
    throw new Error(`${filename}: no trigger`);
  }

  checkScheduledFailureReruns(filename, source, workflow);
  checkLaneConcurrency(filename, source, workflow);
  checkMergeBindsBase(filename, source);
}

const RERUN_FAILED_JOBS_API = /rerun-failed-jobs/;

/**
 * A scheduled rerun has no pull request event to prove the run is still live.
 *
 * thwip-drain once listed every failed workflow record older than thirty
 * minutes and called rerun-failed-jobs on each one. A failed attempt refreshed
 * updated_at, became eligible again on the next schedule, and sent a fresh
 * notification for pull requests that had merged days earlier. Recovery for a
 * live pull request has to start from that pull request's current head; a timer
 * must never replay historical workflow records by itself.
 */
function checkScheduledFailureReruns(filename, source, workflow) {
  const triggers = workflow.on;
  const scheduled =
    triggers !== null &&
    typeof triggers === "object" &&
    !Array.isArray(triggers) &&
    Object.hasOwn(triggers, "schedule");

  if (!scheduled || !RERUN_FAILED_JOBS_API.test(source)) return;

  throw new Error(
    `${filename}: scheduled workflows must not call rerun-failed-jobs; ` +
      `retry from a current open pull request head instead of replaying historical workflow records`,
  );
}

// A PATCH or POST to git/refs/heads is a branch moving, which is what a merge is.
const MOVES_A_REF = /git\/refs\/heads/;

// Contexts that are the same for every run in a repository, whatever triggered
// it. A group built from these and literals names the queue. Anything else names
// something narrower, and a lane keyed on something narrower than the lane is not
// a lane.
const QUEUE_WIDE_CONTEXT =
  /^(github\.repository|github\.repository_id|github\.repository_owner|github\.workflow)$/;

const INTERPOLATION = /\$\{\{([^}]*)\}\}/g;

/**
 * One pull request at a time drives a branch. GitHub enforces that with the
 * concurrency group, so a workflow that moves a branch ref has to key its group
 * on the queue itself: the repository, and the base ref if the trigger can name
 * it. thwip-merge keyed its group per pull request instead, so two runs for two
 * pull requests drove the same lane at once and pull requests 114, 117 and 119
 * each landed a merge commit whose tree nobody had verified.
 */
function checkLaneConcurrency(filename, source, workflow) {
  if (!MOVES_A_REF.test(source)) return;

  const concurrency = workflow.concurrency;
  if (concurrency === undefined || concurrency === null) {
    throw new Error(`${filename}: moves a branch ref and declares no concurrency group`);
  }

  const group = typeof concurrency === "string" ? concurrency : concurrency.group;
  if (typeof group !== "string" || group.trim() === "") {
    throw new Error(`${filename}: concurrency group is empty`);
  }

  for (const [, expression] of group.matchAll(INTERPOLATION)) {
    const named = expression.trim();
    if (QUEUE_WIDE_CONTEXT.test(named)) continue;
    throw new Error(
      `${filename}: moves a branch ref, so its concurrency group must name the queue, ` +
        `but it varies with \${{ ${named} }}`,
    );
  }

  // Cancelling a run that is mid-merge can leave the branch moved with no record
  // of the merge, which is the one outcome the queue exists to prevent. Stating
  // it is part of the rule: the default is false, and a lane that relies on a
  // default is a lane whose author did not decide.
  const cancel = typeof concurrency === "string" ? undefined : concurrency["cancel-in-progress"];
  if (cancel !== false) {
    throw new Error(
      `${filename}: cancel-in-progress must be false; cancelling a run mid-merge can ` +
        `move the branch with nothing recording that it moved`,
    );
  }
}

// The merge-pull-request API. It takes an expected head and no expected base.
const MERGE_PULL_REQUEST_API = /pulls\/[^"'\s]+\/merge/;

// The pins the queue answers `authorize` with: the base the intent bound, the
// tree the verifier ran, and the parents the merge commit gets.
const PINNED_BASE = /merge\.baseSha/;
const PINNED_TREE = /merge\.treeOid/;
const PINNED_PARENTS = /merge\.parentShas/;

const FORCE_FALSE = /force\s*:\s*false/;
const FORCE_TRUE = /force\s*:\s*true/;

/**
 * A merge lands the tree that was verified, on the base it was verified against.
 *
 * GitHub's merge-pull-request API cannot say that. It takes an expected head and
 * nothing about the base, so it merges onto whatever the branch is at that
 * instant. Pull requests 114, 117, 119 and 121 were each signed against one base
 * and merged onto another, each producing a tree no suite had run, and GitHub
 * reported all four as successes.
 *
 * The only base-binding primitive GitHub offers is a ref update without force:
 * it succeeds only where the branch is an ancestor of the new commit, and the
 * only branch that is an ancestor of a commit whose first parent is the pinned
 * base is that base. So a workflow that merges composes the commit from what the
 * queue pinned and moves the ref without force, and this is what says so.
 */
function checkMergeBindsBase(filename, source) {
  if (MERGE_PULL_REQUEST_API.test(source)) {
    throw new Error(
      `${filename}: merges through the pull-request merge API, which takes an expected head and no ` +
        `expected base, so it merges onto whatever the branch is at that moment; compose the merge ` +
        `commit on the base the queue pinned and move the ref with force:false`,
    );
  }

  if (!MOVES_A_REF.test(source)) return;

  if (FORCE_TRUE.test(source)) {
    throw new Error(
      `${filename}: moves a branch ref with force; the update that does not force is the whole ` +
        `guard, because it is what makes GitHub refuse a base that moved`,
    );
  }
  if (!FORCE_FALSE.test(source)) {
    throw new Error(
      `${filename}: moves a branch ref without saying force:false; GitHub defaults to it, and a ` +
        `merge whose only guard is a default is a merge whose author did not decide`,
    );
  }

  if (!PINNED_BASE.test(source) || !PINNED_TREE.test(source) || !PINNED_PARENTS.test(source)) {
    throw new Error(
      `${filename}: moves a branch ref to a commit it did not compose on the base the queue pinned; ` +
        `read merge.baseSha, merge.treeOid and merge.parentShas from the authorize answer, because a ` +
        `base this run read for itself is not the base the record binds`,
    );
  }
}
