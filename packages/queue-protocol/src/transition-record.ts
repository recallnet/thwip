import {
  BOUNDS,
  array,
  baseRef,
  counter,
  decimalId,
  exactKeys,
  fail,
  gitOid,
  isRecord,
  isoDateTime,
  literal,
  nullableSha256,
  ok,
  opaqueId,
  positiveCounter,
  sha256,
  type ParseResult,
  type Sha256,
} from "./primitives.js";
import {
  MERGE_METHODS,
  OVERRIDE_OMISSIONS,
  SECURITY_PROFILES,
  parseVerifiedExecution,
  type MergeMethod,
  type VerifiedExecutionV1,
} from "./merge-intent.js";

/**
 * The Transition Record (plan.md §21.8) is how a branch's history becomes
 * auditable: one record per movement of the base, numbered consecutively within
 * an epoch and linked to the digest of the record before it.
 *
 * Four kinds, and the difference between them is the whole point. A verified
 * merge carries full evidence. An override says who skipped what. An external
 * transition admits the queue did not cause the movement. A genesis opens an
 * epoch. Silently coercing one into another would erase exactly the fact a
 * reader needs, so the parser refuses foreign fields.
 */

export const TRANSITION_KINDS = [
  "verified-merge",
  /**
   * A merge whose evidence is the signed proof already on the head, because the
   * policy asked for nothing more.
   *
   * It is a separate kind rather than a `verified-merge` with a field left out,
   * and that is the whole point: a verified merge claims something ran against
   * the integrated candidate, and under this profile nothing did. Recording one
   * as the other would be a false claim however well it were signed, and a
   * reader auditing the chain has no way to tell the difference after the fact.
   *
   * What it binds instead is why reusing the head's proof is legitimate here:
   * the policy it was accepted under, the pipeline it describes, and the suites
   * that policy required. If any of those differ from what the merge was
   * judged against, the reuse does not hold and the record says so by not
   * matching.
   */
  "reused-proof-merge",
  "candidate-verified-merge",
  "override-merge",
  "external-transition",
  /**
   * A record that names the record it corrects and states the sha that record
   * should have named.
   *
   * Record 54 said pull request 107's merge left the base at the throwaway test
   * merge GitHub computes for an open pull request. That commit is on no branch.
   * Its bytes cannot change: its digest is the next record's predecessor and six
   * records chain from it, so editing it means re-signing seven records under
   * new digests, which replaces the chain rather than repairing it.
   *
   * So a correction is appended and the walk substitutes its edge for the one it
   * corrects. What it may change is exactly one field. It restates the record's
   * `before` and the record's tree and parents unchanged, and the verifier
   * refuses it if any of those differ, because a correction that could move
   * where a merge began, or what tree it certified, would be the licence to
   * rewrite the past that this design exists to withhold.
   */
  "base-correction",
  "genesis",
] as const;
export type TransitionRecordKind = (typeof TRANSITION_KINDS)[number];

export const EXTERNAL_OBSERVATION_CODES = [
  "unexpected_push",
  "ruleset_bypass",
  "unknown_provider_movement",
  "imported_history",
] as const;
export type ExternalObservationCode = (typeof EXTERNAL_OBSERVATION_CODES)[number];

export interface TransitionAfter {
  readonly baseSha: string;
  readonly treeOid: string;
  readonly parentOids: readonly string[];
  readonly parentCount: number;
  readonly parentOidsDigest: Sha256;
  readonly parentsComplete: boolean;
}

export interface TransitionRecordBaseV1 {
  readonly schemaVersion: "1";
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly queueEpoch: number;
  readonly transitionSequence: number;
  readonly previousTransitionDigest: Sha256 | null;
  readonly before: { readonly baseSha: string | null; readonly treeOid: string | null };
  readonly after: TransitionAfter;
  readonly observedAt: string;
}

/**
 * A merge the queue assigned to a device, which signed a receipt for the suites
 * it ran against the integrated candidate.
 *
 * The assignment and the receipt are what no other kind may claim. Beside them
 * sit the policy, the pipeline and the suites the run had to cover, so a reader
 * can tell what "the suites passed" was required to mean, and an execution that
 * says where the run happened. Under `fresh` that is a device and there is no
 * check run to name; under `audited` a second execution in Actions produced a
 * result and both run ids.
 */
export interface VerifiedMergeFacts {
  readonly attemptId: string;
  readonly mergeIntentDigest: Sha256;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly candidateSha: string;
  readonly candidateTreeOid: string;
  readonly mergeMethod: MergeMethod;
  readonly workReceiptDigest: Sha256;
  readonly assignmentDigest: Sha256;
  readonly integrationEvidenceDigest: Sha256;
  readonly policyDigest: Sha256;
  readonly pipelineDigest: Sha256;
  readonly requiredSuitesDigest: Sha256;
  readonly execution: VerifiedExecutionV1;
}

/**
 * A merge whose evidence is the proof already on the head.
 *
 * There is no verifier result and no integration evidence here, and that is
 * deliberate: nothing ran against the integrated candidate, so there is nothing
 * honest to put in those fields. What stands in their place is the equivalence
 * the reuse rests on — the policy the proof was accepted under, the pipeline it
 * describes, and the suites that policy required.
 */
export interface ReusedProofMergeFacts {
  readonly attemptId: string;
  readonly mergeIntentDigest: Sha256;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly candidateSha: string;
  readonly candidateTreeOid: string;
  readonly mergeMethod: MergeMethod;
  readonly workReceiptDigest: Sha256;
  readonly policyDigest: Sha256;
  readonly pipelineDigest: Sha256;
  readonly requiredSuitesDigest: Sha256;
  readonly checkRunId: string;
}

/**
 * A merge where the queue had the integrated candidate run before allowing it.
 *
 * Distinct from `verified-merge`, which additionally binds an assignment and an
 * integration receipt. The managed verifier is dispatched rather than assigned,
 * and produces a result rather than a receipt, so those two do not exist here
 * and are refused rather than filled in. What it does bind is the verifier's own
 * result, which is the thing a reuse merge cannot claim.
 */
export interface CandidateVerifiedMergeFacts {
  readonly attemptId: string;
  readonly mergeIntentDigest: Sha256;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly candidateSha: string;
  readonly candidateTreeOid: string;
  readonly mergeMethod: MergeMethod;
  readonly workReceiptDigest: Sha256;
  readonly policyDigest: Sha256;
  readonly pipelineDigest: Sha256;
  readonly requiredSuitesDigest: Sha256;
  readonly verifierResultDigest: Sha256;
  readonly checkRunId: string;
}

export interface OverrideMergeFacts {
  readonly attemptId: string;
  readonly mergeIntentDigest: Sha256;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly candidateSha: string;
  readonly candidateTreeOid: string;
  readonly mergeMethod: MergeMethod;
  readonly workReceiptDigest: Sha256;
  readonly assignmentDigest: Sha256;
  readonly liveGuardDigest: Sha256;
  readonly candidateCheckRunId: string;
  readonly authorization: {
    readonly actorGithubId: string;
    readonly reason: string;
    readonly omission: { readonly profile: string; readonly omittedControls: readonly string[] };
  };
}

export interface ExternalFacts {
  readonly observationReasonCode: ExternalObservationCode;
  readonly observedActorGithubId?: string;
  readonly operatorReasonDigest?: Sha256;
  readonly confirmingDeliveryId?: string;
}

/**
 * What a correction cites, and what it may not touch.
 *
 * `correctedBaseSha` is the sha the cited record named. Carrying it inside the
 * signed bytes is what lets a reader tell a correction from an ordinary record
 * without holding the record it corrects, and what lets the verifier refuse a
 * correction whose target does not say what the correction claims it says.
 *
 * `attemptId` is the attempt the corrected record cites. A correction that named
 * a different one would be reattributing a merge to a turn that did not ask for
 * it, so it is bound here and checked against the target.
 */
export interface BaseCorrectionFacts {
  readonly correctsTransitionDigest: Sha256;
  readonly correctsTransitionSequence: number;
  readonly correctedBaseSha: string;
  readonly attemptId: string;
  readonly actorPrincipalId: string;
  readonly reason: string;
}

export interface GenesisFacts {
  readonly policyDigest: Sha256;
  readonly configDigest: Sha256;
  readonly rulesetDigest: Sha256;
  readonly priorEpochClosingDigest: Sha256 | null;
}

export type TransitionRecordV1 =
  | (TransitionRecordBaseV1 & { readonly kind: "verified-merge"; readonly verifiedMerge: VerifiedMergeFacts })
  | (TransitionRecordBaseV1 & {
      readonly kind: "reused-proof-merge";
      readonly reusedProof: ReusedProofMergeFacts;
    })
  | (TransitionRecordBaseV1 & {
      readonly kind: "candidate-verified-merge";
      readonly candidateVerified: CandidateVerifiedMergeFacts;
    })
  | (TransitionRecordBaseV1 & { readonly kind: "override-merge"; readonly override: OverrideMergeFacts })
  | (TransitionRecordBaseV1 & { readonly kind: "external-transition"; readonly external: ExternalFacts })
  | (TransitionRecordBaseV1 & { readonly kind: "base-correction"; readonly correction: BaseCorrectionFacts })
  | (TransitionRecordBaseV1 & { readonly kind: "genesis"; readonly genesis: GenesisFacts });

const BASE_KEYS = [
  "schemaVersion",
  "kind",
  "repositoryId",
  "baseRef",
  "queueEpoch",
  "transitionSequence",
  "previousTransitionDigest",
  "before",
  "after",
  "observedAt",
] as const;

const FACTS_KEY: Record<TransitionRecordKind, string> = {
  "verified-merge": "verifiedMerge",
  "reused-proof-merge": "reusedProof",
  "candidate-verified-merge": "candidateVerified",
  "override-merge": "override",
  "external-transition": "external",
  "base-correction": "correction",
  genesis: "genesis",
};

function parseAfter(v: unknown, objectFormatWidth: number | null): ParseResult<TransitionAfter> {
  if (!isRecord(v)) return fail("transition.after must be an object");
  const shape = exactKeys(v, "transition.after", [
    "baseSha",
    "treeOid",
    "parentOids",
    "parentCount",
    "parentOidsDigest",
    "parentsComplete",
  ]);
  if (!shape.ok) return shape;

  const baseSha = gitOid(v["baseSha"], "transition.after.baseSha");
  if (!baseSha.ok) return baseSha;
  const treeOid = gitOid(v["treeOid"], "transition.after.treeOid");
  if (!treeOid.ok) return treeOid;
  // At most sixteen parents are embedded for diagnosis; the digest and count
  // bind the full vector, and Git remains the source of the whole list (§21.9).
  const parentOids = array(v["parentOids"], "transition.after.parentOids", BOUNDS.transitionParentOids, (item, i) =>
    gitOid(item, `parent ${i}`),
  );
  if (!parentOids.ok) return parentOids;
  const parentCount = counter(v["parentCount"], "transition.after.parentCount");
  if (!parentCount.ok) return parentCount;
  const parentOidsDigest = sha256(v["parentOidsDigest"], "transition.after.parentOidsDigest");
  if (!parentOidsDigest.ok) return parentOidsDigest;
  if (typeof v["parentsComplete"] !== "boolean") {
    return fail("transition.after.parentsComplete must be a boolean");
  }
  const parentsComplete = v["parentsComplete"];

  if (parentCount.value < parentOids.value.length) {
    return fail("transition.after.parentCount is smaller than the embedded parents");
  }
  if (parentsComplete && parentCount.value !== parentOids.value.length) {
    return fail("transition.after.parentsComplete claims a complete vector that is not embedded");
  }
  if (!parentsComplete && parentCount.value <= BOUNDS.transitionParentOids) {
    return fail("transition.after.parentsComplete may only be false when parents exceed the embedding bound");
  }
  if (objectFormatWidth !== null) {
    for (const oid of [baseSha.value, treeOid.value, ...parentOids.value]) {
      if (oid.length !== objectFormatWidth) return fail("transition.after mixes object id widths");
    }
  }

  return ok({
    baseSha: baseSha.value,
    treeOid: treeOid.value,
    parentOids: parentOids.value,
    parentCount: parentCount.value,
    parentOidsDigest: parentOidsDigest.value,
    parentsComplete,
  });
}

function parseBase(v: Record<string, unknown>): ParseResult<TransitionRecordBaseV1> {
  if (v["schemaVersion"] !== "1") return fail('transition.schemaVersion must be "1"');
  const repositoryId = decimalId(v["repositoryId"], "transition.repositoryId");
  if (!repositoryId.ok) return repositoryId;
  const ref = baseRef(v["baseRef"], "transition.baseRef");
  if (!ref.ok) return ref;
  const queueEpoch = counter(v["queueEpoch"], "transition.queueEpoch");
  if (!queueEpoch.ok) return queueEpoch;
  const transitionSequence = positiveCounter(v["transitionSequence"], "transition.transitionSequence");
  if (!transitionSequence.ok) return transitionSequence;
  const previousTransitionDigest = nullableSha256(
    v["previousTransitionDigest"],
    "transition.previousTransitionDigest",
  );
  if (!previousTransitionDigest.ok) return previousTransitionDigest;

  const before = v["before"];
  if (!isRecord(before)) return fail("transition.before must be an object");
  const beforeShape = exactKeys(before, "transition.before", ["baseSha", "treeOid"]);
  if (!beforeShape.ok) return beforeShape;
  const beforeBase = before["baseSha"] === null ? null : gitOid(before["baseSha"], "transition.before.baseSha");
  if (beforeBase !== null && !beforeBase.ok) return beforeBase;
  const beforeTree = before["treeOid"] === null ? null : gitOid(before["treeOid"], "transition.before.treeOid");
  if (beforeTree !== null && !beforeTree.ok) return beforeTree;
  // Only the first record in an epoch may have an empty "before".
  const isFirst = transitionSequence.value === 1;
  if (!isFirst && (beforeBase === null || beforeTree === null)) {
    return fail("only the first transition in an epoch may have a null before state");
  }

  const width = beforeBase !== null && beforeBase.ok ? beforeBase.value.length : null;
  const after = parseAfter(v["after"], width);
  if (!after.ok) return after;

  const observedAt = isoDateTime(v["observedAt"], "transition.observedAt");
  if (!observedAt.ok) return observedAt;

  if (isFirst !== (previousTransitionDigest.value === null)) {
    return fail("the first transition in an epoch must be the only one without a prior digest");
  }
  if (beforeBase !== null && beforeBase.ok && beforeBase.value === after.value.baseSha) {
    return fail("a transition must move the base");
  }

  return ok({
    schemaVersion: "1",
    repositoryId: repositoryId.value,
    baseRef: ref.value,
    queueEpoch: queueEpoch.value,
    transitionSequence: transitionSequence.value,
    previousTransitionDigest: previousTransitionDigest.value,
    before: {
      baseSha: beforeBase === null ? null : beforeBase.value,
      treeOid: beforeTree === null ? null : beforeTree.value,
    },
    after: after.value,
    observedAt: observedAt.value,
  });
}

function parseMergeFacts(
  v: unknown,
  label: string,
  extraKeys: readonly string[],
): ParseResult<Record<string, unknown>> {
  if (!isRecord(v)) return fail(`${label} must be an object`);
  const common = [
    "attemptId",
    "mergeIntentDigest",
    "pullRequestNumber",
    "headSha",
    "candidateSha",
    "candidateTreeOid",
    "mergeMethod",
    "workReceiptDigest",
  ];
  const shape = exactKeys(v, label, [...common, ...extraKeys]);
  if (!shape.ok) return shape;

  const out: Record<string, unknown> = {};
  const attemptId = opaqueId(v["attemptId"], `${label}.attemptId`);
  if (!attemptId.ok) return attemptId;
  out["attemptId"] = attemptId.value;
  for (const key of ["mergeIntentDigest", "workReceiptDigest"]) {
    const digest = sha256(v[key], `${label}.${key}`);
    if (!digest.ok) return digest;
    out[key] = digest.value;
  }
  const pr = positiveCounter(v["pullRequestNumber"], `${label}.pullRequestNumber`);
  if (!pr.ok) return pr;
  out["pullRequestNumber"] = pr.value;
  for (const key of ["headSha", "candidateSha", "candidateTreeOid"]) {
    const oid = gitOid(v[key], `${label}.${key}`);
    if (!oid.ok) return oid;
    out[key] = oid.value;
  }
  const method = literal(v["mergeMethod"], `${label}.mergeMethod`, MERGE_METHODS);
  if (!method.ok) return method;
  out["mergeMethod"] = method.value;
  return ok(out);
}

export function parseTransitionRecord(v: unknown): ParseResult<TransitionRecordV1> {
  if (!isRecord(v)) return fail("transition must be an object");
  const kind = literal(v["kind"], "transition.kind", TRANSITION_KINDS);
  if (!kind.ok) return kind;

  // Exactly one facts block, matching the kind (§21.8).
  const factsKey = FACTS_KEY[kind.value];
  const shape = exactKeys(v, "transition", [...BASE_KEYS, factsKey]);
  if (!shape.ok) return shape;
  if (!(factsKey in v)) return fail(`transition of kind ${kind.value} requires ${factsKey}`);

  const base = parseBase(v);
  if (!base.ok) return base;

  switch (kind.value) {
    case "verified-merge": {
      const facts = parseMergeFacts(v[factsKey], "transition.verifiedMerge", [
        "assignmentDigest",
        "integrationEvidenceDigest",
        "policyDigest",
        "pipelineDigest",
        "requiredSuitesDigest",
        "execution",
      ]);
      if (!facts.ok) return facts;
      const raw = v[factsKey] as Record<string, unknown>;
      for (const key of [
        "assignmentDigest",
        "integrationEvidenceDigest",
        "policyDigest",
        "pipelineDigest",
        "requiredSuitesDigest",
      ]) {
        const digest = sha256(raw[key], `transition.verifiedMerge.${key}`);
        if (!digest.ok) return digest;
        facts.value[key] = digest.value;
      }
      const execution = parseVerifiedExecution(raw["execution"], "transition.verifiedMerge.execution");
      if (!execution.ok) return execution;
      facts.value["execution"] = execution.value;
      const consistency = checkMergeConsistency(base.value, facts.value);
      if (!consistency.ok) return consistency;
      return ok({
        ...base.value,
        kind: "verified-merge",
        verifiedMerge: facts.value as unknown as VerifiedMergeFacts,
      });
    }

    case "reused-proof-merge": {
      // No verifier result and no integration evidence, because there was no
      // integrated run — and no assignment either, because nothing was dispatched
      // and no runner was ever told to do anything. What it carries instead is the
      // equivalence the reuse rests on.
      const facts = parseMergeFacts(v[factsKey], "transition.reusedProof", [
        "policyDigest",
        "pipelineDigest",
        "requiredSuitesDigest",
        "checkRunId",
      ]);
      if (!facts.ok) return facts;
      const raw = v[factsKey] as Record<string, unknown>;
      for (const key of ["policyDigest", "pipelineDigest", "requiredSuitesDigest"]) {
        const digest = sha256(raw[key], `transition.reusedProof.${key}`);
        if (!digest.ok) return digest;
        facts.value[key] = digest.value;
      }
      const runId = decimalId(raw["checkRunId"], "transition.reusedProof.checkRunId");
      if (!runId.ok) return runId;
      facts.value["checkRunId"] = runId.value;
      const consistency = checkMergeConsistency(base.value, facts.value);
      if (!consistency.ok) return consistency;
      return {
        ok: true,
        value: {
          ...base.value,
          kind: kind.value,
          reusedProof: facts.value as unknown as ReusedProofMergeFacts,
        },
      };
    }

    case "candidate-verified-merge": {
      // The verifier's result, which is what makes this stronger than a reuse.
      // Still no assignment and no integration receipt: the verifier is
      // dispatched, not assigned, and it returns a result rather than a receipt.
      const facts = parseMergeFacts(v[factsKey], "transition.candidateVerified", [
        "policyDigest",
        "pipelineDigest",
        "requiredSuitesDigest",
        "verifierResultDigest",
        "checkRunId",
      ]);
      if (!facts.ok) return facts;
      const raw = v[factsKey] as Record<string, unknown>;
      for (const key of ["policyDigest", "pipelineDigest", "requiredSuitesDigest", "verifierResultDigest"]) {
        const digest = sha256(raw[key], `transition.candidateVerified.${key}`);
        if (!digest.ok) return digest;
        facts.value[key] = digest.value;
      }
      const runId = decimalId(raw["checkRunId"], "transition.candidateVerified.checkRunId");
      if (!runId.ok) return runId;
      facts.value["checkRunId"] = runId.value;
      const consistency = checkMergeConsistency(base.value, facts.value);
      if (!consistency.ok) return consistency;
      return {
        ok: true,
        value: {
          ...base.value,
          kind: "candidate-verified-merge",
          candidateVerified: facts.value as unknown as CandidateVerifiedMergeFacts,
        },
      };
    }

    case "override-merge": {
      const facts = parseMergeFacts(v[factsKey], "transition.override", [
        "assignmentDigest",
        "liveGuardDigest",
        "candidateCheckRunId",
        "authorization",
      ]);
      if (!facts.ok) return facts;
      const raw = v[factsKey] as Record<string, unknown>;
      const assignment = sha256(raw["assignmentDigest"], "transition.override.assignmentDigest");
      if (!assignment.ok) return assignment;
      facts.value["assignmentDigest"] = assignment.value;
      const guard = sha256(raw["liveGuardDigest"], "transition.override.liveGuardDigest");
      if (!guard.ok) return guard;
      facts.value["liveGuardDigest"] = guard.value;
      const checkRunId = decimalId(raw["candidateCheckRunId"], "transition.override.candidateCheckRunId");
      if (!checkRunId.ok) return checkRunId;
      facts.value["candidateCheckRunId"] = checkRunId.value;

      const auth = raw["authorization"];
      if (!isRecord(auth)) return fail("transition.override.authorization must be an object");
      const authShape = exactKeys(auth, "transition.override.authorization", [
        "actorGithubId",
        "reason",
        "omission",
      ]);
      if (!authShape.ok) return authShape;
      const actor = decimalId(auth["actorGithubId"], "transition.override.authorization.actorGithubId");
      if (!actor.ok) return actor;
      const reason = boundedReason(auth["reason"], "transition.override.authorization.reason");
      if (!reason.ok) return reason;
      const omission = auth["omission"];
      if (!isRecord(omission)) return fail("transition.override.authorization.omission must be an object");
      const omissionShape = exactKeys(omission, "transition.override.authorization.omission", [
        "profile",
        "omittedControls",
      ]);
      if (!omissionShape.ok) return omissionShape;
      const profile = literal(
        omission["profile"],
        "transition.override.authorization.omission.profile",
        SECURITY_PROFILES,
      );
      if (!profile.ok) return profile;
      const expected = OVERRIDE_OMISSIONS[profile.value];
      const controls = omission["omittedControls"];
      if (
        !Array.isArray(controls) ||
        controls.length !== expected.length ||
        controls.some((c, i) => c !== expected[i])
      ) {
        return fail(
          `transition.override.authorization.omission.omittedControls must be exactly [${expected.join(", ")}]`,
        );
      }
      facts.value["authorization"] = {
        actorGithubId: actor.value,
        reason: reason.value,
        omission: { profile: profile.value, omittedControls: expected },
      };

      const consistency = checkMergeConsistency(base.value, facts.value);
      if (!consistency.ok) return consistency;
      return ok({
        ...base.value,
        kind: "override-merge",
        override: facts.value as unknown as OverrideMergeFacts,
      });
    }

    case "external-transition": {
      const raw = v[factsKey];
      if (!isRecord(raw)) return fail("transition.external must be an object");
      const shapeExternal = exactKeys(raw, "transition.external", [
        "observationReasonCode",
        "observedActorGithubId",
        "operatorReasonDigest",
        "confirmingDeliveryId",
      ]);
      if (!shapeExternal.ok) return shapeExternal;
      const code = literal(
        raw["observationReasonCode"],
        "transition.external.observationReasonCode",
        EXTERNAL_OBSERVATION_CODES,
      );
      if (!code.ok) return code;
      const facts: Record<string, unknown> = { observationReasonCode: code.value };
      if (raw["observedActorGithubId"] !== undefined) {
        const actor = decimalId(raw["observedActorGithubId"], "transition.external.observedActorGithubId");
        if (!actor.ok) return actor;
        facts["observedActorGithubId"] = actor.value;
      }
      if (raw["operatorReasonDigest"] !== undefined) {
        // Operator prose stays tenant-scoped; only its digest travels (§21.9).
        const digest = sha256(raw["operatorReasonDigest"], "transition.external.operatorReasonDigest");
        if (!digest.ok) return digest;
        facts["operatorReasonDigest"] = digest.value;
      }
      if (raw["confirmingDeliveryId"] !== undefined) {
        const delivery = opaqueId(raw["confirmingDeliveryId"], "transition.external.confirmingDeliveryId");
        if (!delivery.ok) return delivery;
        facts["confirmingDeliveryId"] = delivery.value;
      }
      return ok({
        ...base.value,
        kind: "external-transition",
        external: facts as unknown as ExternalFacts,
      });
    }

    case "base-correction": {
      const raw = v[factsKey];
      if (!isRecord(raw)) return fail("transition.correction must be an object");
      const shapeCorrection = exactKeys(raw, "transition.correction", [
        "correctsTransitionDigest",
        "correctsTransitionSequence",
        "correctedBaseSha",
        "attemptId",
        "actorPrincipalId",
        "reason",
      ]);
      if (!shapeCorrection.ok) return shapeCorrection;
      const corrects = sha256(raw["correctsTransitionDigest"], "transition.correction.correctsTransitionDigest");
      if (!corrects.ok) return corrects;
      const correctsSequence = positiveCounter(
        raw["correctsTransitionSequence"],
        "transition.correction.correctsTransitionSequence",
      );
      if (!correctsSequence.ok) return correctsSequence;
      const correctedBaseSha = gitOid(raw["correctedBaseSha"], "transition.correction.correctedBaseSha");
      if (!correctedBaseSha.ok) return correctedBaseSha;
      const correctedAttempt = opaqueId(raw["attemptId"], "transition.correction.attemptId");
      if (!correctedAttempt.ok) return correctedAttempt;
      const actor = opaqueId(raw["actorPrincipalId"], "transition.correction.actorPrincipalId");
      if (!actor.ok) return actor;
      const why = boundedReason(raw["reason"], "transition.correction.reason");
      if (!why.ok) return why;

      // Appended, never inserted: a correction is written after the record it
      // corrects, and one that claimed otherwise would be claiming a position it
      // could not have held.
      if (correctsSequence.value >= base.value.transitionSequence) {
        return fail("a correction must come after the record it corrects");
      }
      // The chain opens with a genesis. A correction is a second record by
      // definition, so it can never be the first one.
      if (base.value.before.baseSha === null) {
        return fail("a correction may not open an epoch");
      }
      // Correcting a sha to itself corrects nothing, and would leave two records
      // asserting the same move off the same base.
      if (correctedBaseSha.value === base.value.after.baseSha) {
        return fail("a correction must name a different sha than the one it corrects");
      }
      return ok({
        ...base.value,
        kind: "base-correction",
        correction: {
          correctsTransitionDigest: corrects.value,
          correctsTransitionSequence: correctsSequence.value,
          correctedBaseSha: correctedBaseSha.value,
          attemptId: correctedAttempt.value,
          actorPrincipalId: actor.value,
          reason: why.value,
        },
      });
    }

    case "genesis": {
      const raw = v[factsKey];
      if (!isRecord(raw)) return fail("transition.genesis must be an object");
      const shapeGenesis = exactKeys(raw, "transition.genesis", [
        "policyDigest",
        "configDigest",
        "rulesetDigest",
        "priorEpochClosingDigest",
      ]);
      if (!shapeGenesis.ok) return shapeGenesis;
      const digests: Record<string, unknown> = {};
      for (const key of ["policyDigest", "configDigest", "rulesetDigest"]) {
        const digest = sha256(raw[key], `transition.genesis.${key}`);
        if (!digest.ok) return digest;
        digests[key] = digest.value;
      }
      const prior = nullableSha256(raw["priorEpochClosingDigest"], "transition.genesis.priorEpochClosingDigest");
      if (!prior.ok) return prior;
      digests["priorEpochClosingDigest"] = prior.value;
      // An epoch opens at sequence one; a later genesis would fork the chain.
      if (base.value.transitionSequence !== 1) {
        return fail("a genesis transition must open an epoch at sequence 1");
      }
      if (base.value.queueEpoch > 0 && prior.value === null) {
        return fail("a genesis after the first epoch must name the prior epoch's closing digest");
      }
      return ok({ ...base.value, kind: "genesis", genesis: digests as unknown as GenesisFacts });
    }
  }
}

function boundedReason(v: unknown, label: string): ParseResult<string> {
  if (typeof v !== "string" || v.trim().length === 0) return fail(`${label} is required`);
  const bytes = new TextEncoder().encode(v.normalize("NFC")).length;
  if (bytes > BOUNDS.reason) return fail(`${label} exceeds ${BOUNDS.reason} bytes`);
  return ok(v.normalize("NFC"));
}

/**
 * A merge transition has to describe the commit that actually landed: the new
 * base is the candidate, and its tree is the candidate's tree. Anything else
 * would certify a tree nobody integrated (§6.2 invariant 18).
 */
function checkMergeConsistency(
  base: TransitionRecordBaseV1,
  facts: Record<string, unknown>,
): ParseResult<true> {
  if (facts["candidateSha"] !== base.after.baseSha) {
    return fail("the merged base must be the candidate commit");
  }
  if (facts["candidateTreeOid"] !== base.after.treeOid) {
    return fail("the merged tree must be the candidate tree");
  }
  if (!base.after.parentsComplete) {
    return fail("a queue merge must record a complete parent vector");
  }
  const expectedParents = facts["mergeMethod"] === "merge" ? 2 : 1;
  if (base.after.parentCount !== expectedParents) {
    return fail(`a ${String(facts["mergeMethod"])} merge must have ${expectedParents} parents`);
  }
  if (base.before.baseSha !== null && base.after.parentOids[0] !== base.before.baseSha) {
    return fail("the merged commit's first parent must be the previous base");
  }
  if (expectedParents === 2 && base.after.parentOids[1] !== facts["headSha"]) {
    return fail("the merged commit's second parent must be the pull request head");
  }
  return ok(true);
}
