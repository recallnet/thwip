import { QUEUE_ACTION_REF, setupPullRequestFiles } from "./bootstrap-workflows.js";

export interface ManagedWorkflowHealth {
  readonly healthy: boolean;
  readonly expectedPaths: readonly string[];
  readonly missing: readonly string[];
  readonly drifted: readonly string[];
  readonly actionRef: string;
  readonly actionAccessible: boolean;
}

/** A repository-scoped App token may read an Action only from that repository. */
export function actionCommitUsesInstallationToken(actionRepository: string, installedRepository: string): boolean {
  return actionRepository.toLowerCase() === installedRepository.toLowerCase();
}

/** Compare the default branch's live workflow bytes with the setup payload. */
export function managedWorkflowHealth(input: {
  readonly endpoint: string;
  readonly files: Readonly<Record<string, string | null>>;
  readonly actionAccessible: boolean;
}): ManagedWorkflowHealth {
  const setupInput = { endpoint: input.endpoint, actionRef: QUEUE_ACTION_REF };
  const expected = setupPullRequestFiles(setupInput);
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
