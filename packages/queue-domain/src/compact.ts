import type { BranchQueueState } from "./reducer.js";

/**
 * Drop the history the queue can no longer reach a decision through.
 *
 * The state is read and written whole on every request. Entries, attempts and
 * the transition chain were all append-only, so a repository that had merged ten
 * thousand pull requests carried ten thousand of each on every authorization,
 * forever. That is a cost that only rises and, past a point, a document too large
 * to move at all.
 *
 * What is dropped is history, not state. The projection holds the full chain and
 * every entry that ever queued, append-only, and that is where a reader looks for
 * them. What stays here is what a live decision can still reach: anything not yet
 * finished, the attempts those things point at, and enough of the chain to extend
 * it.
 *
 * A recent tail of finished entries stays too. Nothing needs it to decide
 * anything, but an operator asking why a pull request merged an hour ago should
 * not have to go to another table for it.
 */

export interface CompactionLimits {
  /**
   * Finished entries to keep, newest first. At least one always survives.
   *
   * The projection is written from the state after a command, so an entry that
   * finished and was dropped in the same breath would never be recorded as
   * finished anywhere. One lane means at most one entry finishes per command, so
   * keeping one is enough to close that gap; the default keeps far more.
   */
  readonly terminalEntries: number;
  /** Chain links to keep. At least one always survives, whatever this says. */
  readonly transitions: number;
}

export const DEFAULT_COMPACTION: CompactionLimits = { terminalEntries: 20, transitions: 20 };

const FINISHED = new Set(["Merged", "Cancelled"]);

/** Compacts in place. */
export function compactState(state: BranchQueueState, limits: CompactionLimits = DEFAULT_COMPACTION): void {
  const finished = [...state.entries.values()]
    .filter((entry) => FINISHED.has(entry.state))
    .sort((a, b) => (a.fairnessOrdinal < b.fairnessOrdinal ? 1 : -1))
    .slice(0, Math.max(1, limits.terminalEntries));
  const keepEntry = new Set(finished.map((entry) => entry.entryId));

  for (const entry of state.entries.values()) {
    if (!FINISHED.has(entry.state)) keepEntry.add(entry.entryId);
  }
  for (const entryId of [...state.entries.keys()]) {
    if (!keepEntry.has(entryId)) state.entries.delete(entryId);
  }

  // An attempt is reachable through the entry that owns it, or because it holds
  // the lane. Nothing else can name one.
  const keepAttempt = new Set<string>();
  if (state.activeAttemptId !== null) keepAttempt.add(state.activeAttemptId);
  for (const entry of state.entries.values()) {
    if (entry.currentAttemptId !== null) keepAttempt.add(entry.currentAttemptId);
    if (entry.lastAttemptId !== null) keepAttempt.add(entry.lastAttemptId);
  }
  for (const attemptId of [...state.attempts.keys()]) {
    if (!keepAttempt.has(attemptId)) state.attempts.delete(attemptId);
  }

  // The reducer extends the chain from the last link it can see. A window that
  // emptied would make the next transition claim sequence 1 and start the chain
  // over, which is the one falsehood this queue exists to prevent.
  const keepLinks = Math.max(1, limits.transitions);
  if (state.transitions.length > keepLinks) {
    state.transitions.splice(0, state.transitions.length - keepLinks);
  }
}
