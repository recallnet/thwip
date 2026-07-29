import {
  array,
  baseRef,
  counter,
  decimalId,
  exactKeys,
  fail,
  isRecord,
  isoDateTime,
  nullableSha256,
  ok,
  opaqueId,
  positiveCounter,
  requireKeys,
  type ParseResult,
  type Sha256,
} from "./primitives.js";

/**
 * The Queue Decision (plan.md §21.2) makes one scheduling choice explainable to
 * authorized repository members: who was selected, and what the scheduler could
 * see when it chose.
 *
 * It is honest about its limits. A signed decision proves what the inputs were
 * when the choice was made; it does not prove Thwip observed every event. The
 * repository event log and later reconciliation carry that weight.
 */

export const SCHEDULER_ALGORITHM = "principal-round-robin-v1" as const;

/** Bound on the explanation: a queue lane with more principals than this is
 * summarized rather than enumerated, so a decision never grows unbounded. */
export const MAX_EXPLAINED_PRINCIPALS = 256;

export interface EligiblePrincipalHead {
  readonly sponsorPrincipalId: string;
  readonly sponsorGithubUserId: string;
  readonly lastServedTurn: string;
  readonly oldestReadyEntryId: string;
  readonly fairnessOrdinal: string;
}

export interface QueueDecisionV1 {
  readonly schemaVersion: "1";
  readonly algorithm: typeof SCHEDULER_ALGORITHM;
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly queueEpoch: number;
  readonly turnSequence: number;
  readonly inputStateVersion: number;
  readonly selected: {
    readonly entryId: string;
    readonly pullRequestNumber: number;
    readonly sponsorPrincipalId: string;
    readonly fairnessOrdinal: string;
  };
  readonly eligiblePrincipalHeads: readonly EligiblePrincipalHead[];
  readonly priorDecisionDigest: Sha256 | null;
  readonly decidedAt: string;
}

const KEYS = [
  "schemaVersion",
  "algorithm",
  "repositoryId",
  "baseRef",
  "queueEpoch",
  "turnSequence",
  "inputStateVersion",
  "selected",
  "eligiblePrincipalHeads",
  "priorDecisionDigest",
  "decidedAt",
] as const;

const HEAD_KEYS = [
  "sponsorPrincipalId",
  "sponsorGithubUserId",
  "lastServedTurn",
  "oldestReadyEntryId",
  "fairnessOrdinal",
] as const;

/** Turn counters are unbounded, so they travel as decimal strings. */
function counterString(v: unknown, name: string): ParseResult<string> {
  if (typeof v !== "string" || !/^[0-9]+$/.test(v) || v.length > 32) {
    return fail(`${name} must be a decimal counter string`);
  }
  return ok(v);
}

function parseHead(v: unknown, index: number): ParseResult<EligiblePrincipalHead> {
  if (!isRecord(v)) return fail(`head ${index} must be an object`);
  const shape = exactKeys(v, `head ${index}`, HEAD_KEYS);
  if (!shape.ok) return shape;
  const present = requireKeys(v, `head ${index}`, HEAD_KEYS);
  if (!present.ok) return present;

  const sponsorPrincipalId = opaqueId(v["sponsorPrincipalId"], "sponsorPrincipalId");
  if (!sponsorPrincipalId.ok) return sponsorPrincipalId;
  const sponsorGithubUserId = decimalId(v["sponsorGithubUserId"], "sponsorGithubUserId");
  if (!sponsorGithubUserId.ok) return sponsorGithubUserId;
  const lastServedTurn = counterString(v["lastServedTurn"], "lastServedTurn");
  if (!lastServedTurn.ok) return lastServedTurn;
  const oldestReadyEntryId = opaqueId(v["oldestReadyEntryId"], "oldestReadyEntryId");
  if (!oldestReadyEntryId.ok) return oldestReadyEntryId;
  const fairnessOrdinal = counterString(v["fairnessOrdinal"], "fairnessOrdinal");
  if (!fairnessOrdinal.ok) return fairnessOrdinal;

  return ok({
    sponsorPrincipalId: sponsorPrincipalId.value,
    sponsorGithubUserId: sponsorGithubUserId.value,
    lastServedTurn: lastServedTurn.value,
    oldestReadyEntryId: oldestReadyEntryId.value,
    fairnessOrdinal: fairnessOrdinal.value,
  });
}

export function parseQueueDecision(v: unknown): ParseResult<QueueDecisionV1> {
  if (!isRecord(v)) return fail("decision must be an object");
  const shape = exactKeys(v, "decision", KEYS);
  if (!shape.ok) return shape;
  const present = requireKeys(v, "decision", KEYS);
  if (!present.ok) return present;

  if (v["schemaVersion"] !== "1") return fail('decision.schemaVersion must be "1"');
  // One scheduler, no weights, no pay-to-prioritize (§49).
  if (v["algorithm"] !== SCHEDULER_ALGORITHM) {
    return fail(`decision.algorithm must be ${SCHEDULER_ALGORITHM}`);
  }

  const repositoryId = decimalId(v["repositoryId"], "decision.repositoryId");
  if (!repositoryId.ok) return repositoryId;
  const ref = baseRef(v["baseRef"], "decision.baseRef");
  if (!ref.ok) return ref;
  const queueEpoch = counter(v["queueEpoch"], "decision.queueEpoch");
  if (!queueEpoch.ok) return queueEpoch;
  const turnSequence = positiveCounter(v["turnSequence"], "decision.turnSequence");
  if (!turnSequence.ok) return turnSequence;
  const inputStateVersion = counter(v["inputStateVersion"], "decision.inputStateVersion");
  if (!inputStateVersion.ok) return inputStateVersion;

  const selected = v["selected"];
  if (!isRecord(selected)) return fail("decision.selected must be an object");
  const selectedShape = exactKeys(selected, "decision.selected", [
    "entryId",
    "pullRequestNumber",
    "sponsorPrincipalId",
    "fairnessOrdinal",
  ]);
  if (!selectedShape.ok) return selectedShape;
  const entryId = opaqueId(selected["entryId"], "decision.selected.entryId");
  if (!entryId.ok) return entryId;
  const pullRequestNumber = positiveCounter(selected["pullRequestNumber"], "decision.selected.pullRequestNumber");
  if (!pullRequestNumber.ok) return pullRequestNumber;
  const sponsorPrincipalId = opaqueId(selected["sponsorPrincipalId"], "decision.selected.sponsorPrincipalId");
  if (!sponsorPrincipalId.ok) return sponsorPrincipalId;
  const fairnessOrdinal = counterString(selected["fairnessOrdinal"], "decision.selected.fairnessOrdinal");
  if (!fairnessOrdinal.ok) return fairnessOrdinal;

  const heads = array(
    v["eligiblePrincipalHeads"],
    "decision.eligiblePrincipalHeads",
    MAX_EXPLAINED_PRINCIPALS,
    parseHead,
  );
  if (!heads.ok) return heads;

  const priorDecisionDigest = nullableSha256(v["priorDecisionDigest"], "decision.priorDecisionDigest");
  if (!priorDecisionDigest.ok) return priorDecisionDigest;
  const decidedAt = isoDateTime(v["decidedAt"], "decision.decidedAt");
  if (!decidedAt.ok) return decidedAt;

  // The selected entry must appear among the heads it was chosen from, or the
  // explanation does not explain the choice.
  const selectedHead = heads.value.find((h) => h.sponsorPrincipalId === sponsorPrincipalId.value);
  if (selectedHead === undefined) {
    return fail("decision.selected names a principal absent from eligiblePrincipalHeads");
  }
  if (selectedHead.oldestReadyEntryId !== entryId.value) {
    return fail("decision.selected must be the selected principal's oldest ready entry");
  }
  if (selectedHead.fairnessOrdinal !== fairnessOrdinal.value) {
    return fail("decision.selected fairness ordinal disagrees with the principal head");
  }
  // Round-robin: nobody eligible may have been served less recently.
  const chosenLastServed = BigInt(selectedHead.lastServedTurn);
  for (const head of heads.value) {
    if (BigInt(head.lastServedTurn) < chosenLastServed) {
      return fail(
        `decision violates ${SCHEDULER_ALGORITHM}: ${head.sponsorPrincipalId} was served less recently`,
      );
    }
  }
  const duplicates = new Set<string>();
  for (const head of heads.value) {
    if (duplicates.has(head.sponsorPrincipalId)) {
      return fail(`decision lists ${head.sponsorPrincipalId} twice`);
    }
    duplicates.add(head.sponsorPrincipalId);
  }

  return ok({
    schemaVersion: "1",
    algorithm: SCHEDULER_ALGORITHM,
    repositoryId: repositoryId.value,
    baseRef: ref.value,
    queueEpoch: queueEpoch.value,
    turnSequence: turnSequence.value,
    inputStateVersion: inputStateVersion.value,
    selected: {
      entryId: entryId.value,
      pullRequestNumber: pullRequestNumber.value,
      sponsorPrincipalId: sponsorPrincipalId.value,
      fairnessOrdinal: fairnessOrdinal.value,
    },
    eligiblePrincipalHeads: heads.value,
    priorDecisionDigest: priorDecisionDigest.value,
    decidedAt: decidedAt.value,
  });
}
