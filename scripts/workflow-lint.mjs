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
}

const RERUN_FAILED_JOBS_API = /rerun-failed-jobs/;

/**
 * A timer has no pull request event proving an old workflow run is still live.
 * Recovery must start from current repository state, never from replaying a
 * historical failed run whose notifications may be days out of date.
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
      `retry from current repository state instead of replaying historical workflow records`,
  );
}
