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
}
