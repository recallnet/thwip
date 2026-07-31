export type BundleResolutionBody =
  | { kind: "active"; bundle: string }
  | {
      kind: "bootstrap_pending";
      code: "POLICY_AWAITING_FIRST_MERGE";
      repository: string;
      repositoryId: string;
      defaultBranch: string;
    };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the resolver contract explicitly. An active bundle remains backwards
 * compatible with older control planes that omitted `state`.
 */
export function parseBundleResolutionBody(value: unknown): BundleResolutionBody {
  if (!record(value)) throw new Error("BUNDLE_UNAVAILABLE: resolver returned a non-object");
  if (value["state"] === "bootstrap_pending") {
    if (
      value["code"] !== "POLICY_AWAITING_FIRST_MERGE" ||
      typeof value["repository"] !== "string" ||
      typeof value["repositoryId"] !== "string" ||
      typeof value["defaultBranch"] !== "string"
    ) {
      throw new Error("BUNDLE_UNAVAILABLE: malformed bootstrap state");
    }
    return {
      kind: "bootstrap_pending",
      code: value["code"],
      repository: value["repository"],
      repositoryId: value["repositoryId"],
      defaultBranch: value["defaultBranch"],
    };
  }
  if ((value["state"] === undefined || value["state"] === "active") && typeof value["bundle"] === "string") {
    return { kind: "active", bundle: value["bundle"] };
  }
  throw new Error("BUNDLE_UNAVAILABLE: resolver returned neither an active bundle nor bootstrap state");
}
