/**
 * What the worker says about how it was deployed.
 *
 * `scripts/control-plane-core.mjs` writes this stamp at deploy time and this reads it
 * back at runtime. The two live on opposite sides of a bundle boundary — the
 * deploy scripts are plain modules run by node, this is Worker source — so the
 * format is held together by `deploy-exception.test.ts`, which writes with one
 * and reads with the other.
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
