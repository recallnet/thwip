import type { BranchQueueState } from "./reducer.js";

/**
 * The invariants the TLA+ model checks (plan.md §53.2), expressed against real
 * state so the same properties are asserted in unit tests, property tests, and
 * at runtime after every Durable Object command.
 *
 * The reducer is written so these can never be violated. This checker exists to
 * catch the case where that is wrong: a violation is an operational incident,
 * not a user error.
 */

export type InvariantName =
  | "OneActiveLane"
  | "OnlyCurrentAttemptMayMerge"
  | "OnlyVerifiedMayCreateMergeIntent"
  | "NoSecondWriteWhileOutcomeUnknown"
  | "TransitionChainContiguous"
  | "ExternalMovePauses"
  | "AttemptDagAcyclic"
  | "BlockedEntryNamesReason";

export interface Violation {
  readonly invariant: InvariantName;
  readonly detail: string;
}

export function checkInvariants(state: BranchQueueState): Violation[] {
  const violations: Violation[] = [];
  const add = (invariant: InvariantName, detail: string) => violations.push({ invariant, detail });

  const live = [...state.attempts.values()].filter((a) => a.outcome === null && a.phase !== "MERGED");
  if (live.length > 1) {
    add("OneActiveLane", `${live.length} nonterminal attempts: ${live.map((a) => a.attemptId).join(", ")}`);
  }
  if (live.length === 1 && state.activeAttemptId !== live[0]!.attemptId) {
    add("OneActiveLane", `activeAttemptId ${state.activeAttemptId} does not name the live attempt`);
  }
  if (live.length === 0 && state.activeAttemptId !== null) {
    add("OneActiveLane", `activeAttemptId ${state.activeAttemptId} is set with no live attempt`);
  }

  // A reader that is shown a blocked entry with no reason concludes nothing is
  // wrong. Silence about a block is the one answer no caller can act on.
  for (const entry of state.entries.values()) {
    if (entry.state === "Blocked" && entry.primaryReason === null) {
      add("BlockedEntryNamesReason", `entry ${entry.entryId} is blocked with no reason`);
    }
  }

  for (const attempt of state.attempts.values()) {
    if (attempt.phase === "MERGED" && attempt.candidateTree === null) {
      add("OnlyCurrentAttemptMayMerge", `attempt ${attempt.attemptId} merged with no pinned candidate`);
    }
    if (attempt.intentDigest !== null && attempt.receiptDigest === null) {
      add(
        "OnlyVerifiedMayCreateMergeIntent",
        `attempt ${attempt.attemptId} has a merge intent with no receipt`,
      );
    }
    if (attempt.outcomeUnknown && attempt.outcome !== null) {
      add(
        "NoSecondWriteWhileOutcomeUnknown",
        `attempt ${attempt.attemptId} is terminal while its outcome is unknown`,
      );
    }
  }

  // Contiguous within whatever the state is holding, rather than anchored at
  // sequence 1.
  //
  // The property worth having is that the links join and no sequence is skipped.
  // Requiring the array to begin at 1 also required it to hold every transition
  // ever recorded, which made the state grow with the repository's whole merge
  // history and be read and written whole on every request. The full chain lives
  // in the projection, which is append-only; this holds a window of it.
  //
  // The first entry in the window has a prior digest naming a transition that is
  // no longer resident, so it cannot be checked against anything here. That is a
  // window boundary, not a broken link.
  const first = state.transitions[0];
  for (let i = 0; i < state.transitions.length; i += 1) {
    const transition = state.transitions[i]!;
    const prior = i === 0 ? null : state.transitions[i - 1]!;
    if (transition.transitionSequence !== first!.transitionSequence + i) {
      add("TransitionChainContiguous", `transition ${i} has sequence ${transition.transitionSequence}`);
    }
    if (prior !== null && prior.digest !== transition.priorDigest) {
      add("TransitionChainContiguous", `transition ${transition.transitionSequence} does not link its prior`);
    }
    if (i === 0 && transition.transitionSequence === 1 && transition.priorDigest !== null) {
      add("TransitionChainContiguous", "the first transition ever recorded has a prior digest");
    }
  }

  if (state.rebaselineRequired && !state.paused) {
    add("ExternalMovePauses", "a rebaseline is pending while the queue is running");
  }

  for (const attempt of state.attempts.values()) {
    const seen = new Set<string>([attempt.attemptId]);
    let cursor = attempt.parentAttemptId;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        add("AttemptDagAcyclic", `cycle through attempt ${cursor}`);
        break;
      }
      seen.add(cursor);
      cursor = state.attempts.get(cursor)?.parentAttemptId ?? null;
    }
  }

  return violations;
}

/** Throws when state is not admissible. Called after every command. */
export function assertInvariants(state: BranchQueueState): void {
  const violations = checkInvariants(state);
  if (violations.length > 0) {
    throw new Error(
      `branch queue invariant violation: ${violations
        .map((v) => `${v.invariant} (${v.detail})`)
        .join("; ")}`,
    );
  }
}

/**
 * Distinct-principal witness depth (plan.md §24.1): how many separate people
 * have certified transitions on top of a given point in the chain. One person
 * merging ten times is depth one.
 */
export function witnessDepth(state: BranchQueueState, fromSequence: number): number {
  const principals = new Set<string>();
  for (const transition of state.transitions) {
    if (transition.transitionSequence <= fromSequence) continue;
    if (transition.kind !== "verified") continue;
    for (const principal of transition.witnessPrincipalIds) principals.add(principal);
  }
  return principals.size;
}
