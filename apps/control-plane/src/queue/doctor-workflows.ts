import { QUEUE_ACTION_REF, setupPullRequestFiles } from "./bootstrap-workflows.js";

export interface ManagedWorkflowHealth {
  readonly healthy: boolean;
  readonly expectedPaths: readonly string[];
  readonly missing: readonly string[];
  readonly drifted: readonly string[];
  readonly actionRef: string;
  readonly actionAccessible: boolean;
}

/** Compare the default branch's live workflow bytes with the setup payload. */
export function managedWorkflowHealth(input: {
  readonly endpoint: string;
  readonly files: Readonly<Record<string, string | null>>;
  readonly actionAccessible: boolean;
}): ManagedWorkflowHealth {
  const expected = setupPullRequestFiles({ endpoint: input.endpoint, actionRef: QUEUE_ACTION_REF });
  const expectedPaths = expected.map((file) => file.path);
  const missing = expected.filter((file) => input.files[file.path] === null).map((file) => file.path);
  const drifted = expected
    .filter((file) => input.files[file.path] !== null && input.files[file.path] !== file.content)
    .map((file) => file.path);
  return {
    healthy: missing.length === 0 && drifted.length === 0 && input.actionAccessible,
    expectedPaths,
    missing,
    drifted,
    actionRef: QUEUE_ACTION_REF,
    actionAccessible: input.actionAccessible,
  };
}
