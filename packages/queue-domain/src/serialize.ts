import type { Attempt, BranchQueueState, Entry, Transition } from "./reducer.js";

/**
 * Turn the queue state into something a text column can hold, and back.
 *
 * The reducer works on Maps, a Set and bigints. JSON has none of those, so each
 * one needs saying out loud. The alternative, a generic tagged encoder, hides
 * which fields are special and stops complaining the day somebody adds another.
 *
 * Sequence numbers are bigints because they are counters that only ever go up and
 * ordering by them is what fairness means. Encoding them as JSON numbers would
 * hold until the queue passed 2^53 and then start losing the low bits, which
 * reads as two principals having been served at the same turn.
 *
 * Nested objects are spread rather than rebuilt, so a new field on Entry or
 * Attempt travels without anyone remembering to add it here. Only the bigints
 * inside them are named.
 */

/** Written by `encodeState`, read by `decodeState`. JSON, nothing more. */
export type SerializedState = Record<string, unknown>;

export function encodeState(state: BranchQueueState): SerializedState {
  return {
    queueKey: state.queueKey,
    repositoryId: state.repositoryId,
    baseRef: state.baseRef,
    lastSequence: state.lastSequence,
    turnSequence: state.turnSequence.toString(),
    ordinalSequence: state.ordinalSequence.toString(),
    paused: state.paused,
    pauseReason: state.pauseReason,
    rebaselineRequired: state.rebaselineRequired,
    rebaselineReason: state.rebaselineReason,
    baseSha: state.baseSha,
    activeAttemptId: state.activeAttemptId,
    entries: [...state.entries].map(([id, e]) => [id, { ...e, fairnessOrdinal: e.fairnessOrdinal.toString() }]),
    attempts: [...state.attempts],
    lastServedTurn: [...state.lastServedTurn].map(([id, turn]) => [id, turn.toString()]),
    fairnessDebt: [...state.fairnessDebt],
    appliedKeys: [...state.appliedKeys],
    transitions: state.transitions,
  };
}

export function decodeState(raw: SerializedState): BranchQueueState {
  const entries = raw["entries"] as Array<[string, Entry & { fairnessOrdinal: string }]>;
  const lastServedTurn = raw["lastServedTurn"] as Array<[string, string]>;

  return {
    queueKey: raw["queueKey"] as string,
    repositoryId: raw["repositoryId"] as string,
    baseRef: raw["baseRef"] as string,
    lastSequence: raw["lastSequence"] as number,
    turnSequence: BigInt(raw["turnSequence"] as string),
    ordinalSequence: BigInt(raw["ordinalSequence"] as string),
    paused: raw["paused"] as boolean,
    pauseReason: raw["pauseReason"] as string | null,
    rebaselineRequired: raw["rebaselineRequired"] as boolean,
    // Absent from every document written before a rebaseline had to say why.
    rebaselineReason: (raw["rebaselineReason"] as string | null | undefined) ?? null,
    baseSha: raw["baseSha"] as string | null,
    activeAttemptId: raw["activeAttemptId"] as string | null,
    entries: new Map(entries.map(([id, e]) => [id, { ...e, fairnessOrdinal: BigInt(e.fairnessOrdinal) }])),
    attempts: new Map(raw["attempts"] as Array<[string, Attempt]>),
    lastServedTurn: new Map(lastServedTurn.map(([id, turn]) => [id, BigInt(turn)])),
    fairnessDebt: new Map(raw["fairnessDebt"] as Array<[string, readonly string[]]>),
    appliedKeys: new Set(raw["appliedKeys"] as string[]),
    // Only links a reader can fetch. Documents written before the reducer
    // stopped inventing one carry an `external:<sha>` entry for a base that
    // moved outside the queue, and the queue signs its chain head into every
    // assignment and merge intent it makes. A branch holding one of those could
    // issue nothing further, and dropping it here is what lets that branch
    // recover rather than needing the document rebuilt by hand.
    transitions: (raw["transitions"] as Transition[]).filter((t) => t.digest.startsWith("sha256:")),
  };
}
