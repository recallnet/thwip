/**
 * What the worker says about how it was deployed.
 *
 * Managed deployment tooling may write this stamp at deploy time; the Worker
 * reads it back at runtime. Self-hosted deployments normally leave it unset.
 */

export interface DeployException {
  /** Which deploy-gate refusals were excused, by name. */
  readonly guards: readonly string[];
  /** Why, in the deployer's words. */
  readonly reason: string;
  /** The tree that went out, as `branch@sha`. */
  readonly tree: string | null;
  /** When it was deployed. */
  readonly at: string | null;
}

/**
 * Read the stamp. Anything absent or unreadable is no exception rather than a
 * bad one: a worker that went out the ordinary way is the common case, and a
 * malformed stamp reported as an exception would cry wolf until nobody looked.
 */
export function readException(stamp: string | undefined): DeployException | null {
  if (typeof stamp !== "string" || stamp.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(stamp) as Partial<DeployException>;
    if (!Array.isArray(parsed.guards) || typeof parsed.reason !== "string") return null;
    return { guards: parsed.guards, reason: parsed.reason, tree: parsed.tree ?? null, at: parsed.at ?? null };
  } catch {
    return null;
  }
}
