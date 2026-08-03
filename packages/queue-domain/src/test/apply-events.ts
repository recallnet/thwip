import type { QueueEvent } from "../events.js";
import { applyEvent, type BranchQueueState } from "../reducer.js";

/**
 * Fold a whole event log in one call. Suites build states from logs constantly;
 * production appends one event at a time and calls `applyEvent` directly, so
 * this lives here rather than on the package surface.
 */
export function applyEvents(
  state: BranchQueueState,
  events: readonly QueueEvent[],
): BranchQueueState {
  return events.reduce(applyEvent, state);
}
