export interface ProjectPolicyProjection {
  enabled: number;
  active_policy_digest: string | null;
}

export type ProjectPolicyState =
  | { kind: "not_imported"; code: "PROJECT_NOT_IMPORTED" }
  | { kind: "disabled"; code: "PROJECT_DISABLED" }
  | { kind: "bootstrap_pending"; code: "POLICY_AWAITING_FIRST_MERGE" }
  | { kind: "active"; digest: string };

/** The product states that used to be collapsed into one misleading 404. */
export function projectPolicyState(project: null): Extract<ProjectPolicyState, { kind: "not_imported" }>;
export function projectPolicyState(
  project: ProjectPolicyProjection,
): Exclude<ProjectPolicyState, { kind: "not_imported" }>;
export function projectPolicyState(project: ProjectPolicyProjection | null): ProjectPolicyState {
  if (project === null) return { kind: "not_imported", code: "PROJECT_NOT_IMPORTED" };
  if (project.enabled !== 1) return { kind: "disabled", code: "PROJECT_DISABLED" };
  if (project.active_policy_digest === null) {
    return { kind: "bootstrap_pending", code: "POLICY_AWAITING_FIRST_MERGE" };
  }
  return { kind: "active", digest: project.active_policy_digest };
}
