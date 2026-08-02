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

  checkLaneConcurrency(filename, source, workflow);
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
