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
  parseGitSubject,
  positiveCounter,
  reasonText,
  sha256,
  type GitSubject,
  type ParseResult,
  type Sha256,
} from "./primitives.js";

/**
 * The Merge Intent (plan.md §21.7) is the last thing written before the network
 * write that mutates the branch. It exists so that an ambiguous merge response
 * can be reconciled against a durable statement of exactly what was intended,
 * rather than being retried blindly.
 *
 * Two variants only. A verified merge carries integration and verifier
 * evidence; an override carries an authorization naming precisely which
 * controls were skipped. The parser refuses a payload holding fields from the
 * other variant, so an override can never be read as verified.
 */

export const SECURITY_PROFILES = ["fast", "fresh", "audited", "remote"] as const;
export type SecurityProfile = (typeof SECURITY_PROFILES)[number];

export const MERGE_METHODS = ["merge", "squash"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/**
 * Exactly which controls each profile is allowed to omit under override, as an
 * ordered tuple. No extra, missing, or reordered value is accepted (§21.9), so
 * an administrator cannot quietly widen an override by editing the list.
 */
export const OVERRIDE_OMISSIONS: Readonly<Record<SecurityProfile, readonly string[]>> = {
  fast: ["exact_receipt_reuse", "integration_verifier_result"],
  fresh: ["integration_receipt", "integration_verifier_result"],
  audited: ["integration_receipt", "independent_dagger_rerun", "integration_verifier_result"],
  remote: ["independent_dagger_run", "integration_verifier_result"],
};

export interface OverrideOmissionV1 {
  readonly profile: SecurityProfile;
  readonly omittedControls: readonly string[];
}

export interface OverrideAuthorizationV1 {
  readonly actorGithubId: string;
  readonly reason: string;
  readonly omission: OverrideOmissionV1;
}

export interface MergeIntentBaseV1 {
  readonly schemaVersion: "1";
  readonly operationId: string;
  readonly attemptId: string;
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly queueEpoch: number;
  readonly turnSequence: number;
  readonly transitionSequence: number;
  readonly git: GitSubject;
  readonly pullRequestNumber: number;
  readonly mergeMethod: MergeMethod;
  readonly policyDigest: Sha256;
  readonly previousTransitionDigest: Sha256 | null;
  readonly generatedCommitTitle: string;
  readonly generatedCommitMessageDigest: Sha256;
  readonly createdAt: string;
}

export interface VerifiedMergeEvidence {
  readonly workReceiptDigest: Sha256;
  readonly assignmentDigest: Sha256;
  readonly integrationEvidenceDigest: Sha256;
  readonly verifierResultDigest: Sha256;
  readonly candidateCheckRunId: string;
}

export interface OverrideMergeEvidence {
  readonly workReceiptDigest: Sha256;
  readonly assignmentDigest: Sha256;
  readonly liveGuardDigest: Sha256;
  readonly candidateCheckRunId: string;
}

export interface ReusedMergeEvidence {
  readonly workReceiptDigest: Sha256;
  readonly pipelineDigest: Sha256;
  readonly requiredSuitesDigest: Sha256;
  readonly proofCheckRunId: string;
}

export type MergeIntentV1 =
  | (MergeIntentBaseV1 & { readonly kind: "verified"; readonly evidence: VerifiedMergeEvidence })
  | (MergeIntentBaseV1 & { readonly kind: "reused"; readonly evidence: ReusedMergeEvidence })
  | (MergeIntentBaseV1 & {
      readonly kind: "override";
      readonly evidence: OverrideMergeEvidence;
      readonly override: OverrideAuthorizationV1;
    });

const BASE_KEYS = [
  "schemaVersion",
  "operationId",
  "attemptId",
  "repositoryId",
  "baseRef",
  "queueEpoch",
  "turnSequence",
  "transitionSequence",
  "git",
  "pullRequestNumber",
  "mergeMethod",
  "policyDigest",
  "previousTransitionDigest",
  "generatedCommitTitle",
  "generatedCommitMessageDigest",
  "createdAt",
  "kind",
  "evidence",
] as const;

const VERIFIED_EVIDENCE_KEYS = [
  "workReceiptDigest",
  "assignmentDigest",
  "integrationEvidenceDigest",
  "verifierResultDigest",
  "candidateCheckRunId",
] as const;

const OVERRIDE_EVIDENCE_KEYS = [
  "workReceiptDigest",
  "assignmentDigest",
  "liveGuardDigest",
  "candidateCheckRunId",
] as const;

/**
 * What a reuse rests on: the proof the developer signed, the pipeline and suites
 * it had to satisfy, and the check run that verified it.
 *
 * No assignment and no verifier result, because nothing was dispatched and
 * nothing ran against the integrated candidate. Those are the two claims a
 * verified intent makes, and this kind exists so a merge under a profile that
 * makes neither cannot be signed as though it did.
 */
const REUSED_EVIDENCE_KEYS = [
  "workReceiptDigest",
  "pipelineDigest",
  "requiredSuitesDigest",
  "proofCheckRunId",
] as const;

/** The commit title is embedded, so it needs a bound like any other signed text. */
const COMMIT_TITLE_MAX = 512;

function parseBase(v: Record<string, unknown>): ParseResult<MergeIntentBaseV1> {
  if (v["schemaVersion"] !== "1") return fail("mergeIntent.schemaVersion must be \"1\"");

  const operationId = opaqueId(v["operationId"], "mergeIntent.operationId");
  if (!operationId.ok) return operationId;
  const attemptId = opaqueId(v["attemptId"], "mergeIntent.attemptId");
  if (!attemptId.ok) return attemptId;
  const repositoryId = decimalId(v["repositoryId"], "mergeIntent.repositoryId");
  if (!repositoryId.ok) return repositoryId;
  const ref = baseRef(v["baseRef"], "mergeIntent.baseRef");
  if (!ref.ok) return ref;
  const queueEpoch = counter(v["queueEpoch"], "mergeIntent.queueEpoch");
  if (!queueEpoch.ok) return queueEpoch;
  const turnSequence = positiveCounter(v["turnSequence"], "mergeIntent.turnSequence");
  if (!turnSequence.ok) return turnSequence;
  const transitionSequence = positiveCounter(v["transitionSequence"], "mergeIntent.transitionSequence");
  if (!transitionSequence.ok) return transitionSequence;
  const git = parseGitSubject(v["git"], "mergeIntent.git");
  if (!git.ok) return git;
  const pullRequestNumber = positiveCounter(v["pullRequestNumber"], "mergeIntent.pullRequestNumber");
  if (!pullRequestNumber.ok) return pullRequestNumber;
  const mergeMethod = literal(v["mergeMethod"], "mergeIntent.mergeMethod", MERGE_METHODS);
  if (!mergeMethod.ok) return mergeMethod;
  const policyDigest = sha256(v["policyDigest"], "mergeIntent.policyDigest");
  if (!policyDigest.ok) return policyDigest;
  const previousTransitionDigest = nullableSha256(
    v["previousTransitionDigest"],
    "mergeIntent.previousTransitionDigest",
  );
  if (!previousTransitionDigest.ok) return previousTransitionDigest;
  const title = boundedTitle(v["generatedCommitTitle"]);
  if (!title.ok) return title;
  const messageDigest = sha256(
    v["generatedCommitMessageDigest"],
    "mergeIntent.generatedCommitMessageDigest",
  );
  if (!messageDigest.ok) return messageDigest;
  const createdAt = isoDateTime(v["createdAt"], "mergeIntent.createdAt");
  if (!createdAt.ok) return createdAt;

  // The candidate must actually sit on the base and head the intent names.
  if (git.value.repositoryId !== repositoryId.value) {
    return fail("mergeIntent.git.repositoryId disagrees with mergeIntent.repositoryId");
  }
  if (git.value.baseRef !== ref.value) {
    return fail("mergeIntent.git.baseRef disagrees with mergeIntent.baseRef");
  }
  if (git.value.candidateParentOids[0] !== git.value.baseSha) {
    return fail("mergeIntent.git first candidate parent must be the base commit");
  }
  // A merge commit has the head as its second parent; a squash has one parent.
  if (mergeMethod.value === "merge" && git.value.candidateParentOids.length !== 2) {
    return fail("a merge candidate must have exactly two parents");
  }
  if (mergeMethod.value === "squash" && git.value.candidateParentOids.length !== 1) {
    return fail("a squash candidate must have exactly one parent");
  }
  if (mergeMethod.value === "merge" && git.value.candidateParentOids[1] !== git.value.headSha) {
    return fail("mergeIntent.git second candidate parent must be the pull request head");
  }

  return ok({
    schemaVersion: "1",
    operationId: operationId.value,
    attemptId: attemptId.value,
    repositoryId: repositoryId.value,
    baseRef: ref.value,
    queueEpoch: queueEpoch.value,
    turnSequence: turnSequence.value,
    transitionSequence: transitionSequence.value,
    git: git.value,
    pullRequestNumber: pullRequestNumber.value,
    mergeMethod: mergeMethod.value,
    policyDigest: policyDigest.value,
    previousTransitionDigest: previousTransitionDigest.value,
    generatedCommitTitle: title.value,
    generatedCommitMessageDigest: messageDigest.value,
    createdAt: createdAt.value,
  });
}

function boundedTitle(v: unknown): ParseResult<string> {
  if (typeof v !== "string" || v.length === 0) return fail("mergeIntent.generatedCommitTitle is required");
  const bytes = new TextEncoder().encode(v.normalize("NFC")).length;
  if (bytes > COMMIT_TITLE_MAX) return fail(`mergeIntent.generatedCommitTitle exceeds ${COMMIT_TITLE_MAX} bytes`);
  if (v.includes("\n")) return fail("mergeIntent.generatedCommitTitle must be a single line");
  return ok(v.normalize("NFC"));
}

function parseOverrideAuthorization(v: unknown): ParseResult<OverrideAuthorizationV1> {
  if (!isRecord(v)) return fail("mergeIntent.override must be an object");
  const shape = exactKeys(v, "mergeIntent.override", ["actorGithubId", "reason", "omission"]);
  if (!shape.ok) return shape;
  const actorGithubId = decimalId(v["actorGithubId"], "mergeIntent.override.actorGithubId");
  if (!actorGithubId.ok) return actorGithubId;
  const reason = reasonText(v["reason"], "mergeIntent.override.reason");
  if (!reason.ok) return reason;

  const omission = v["omission"];
  if (!isRecord(omission)) return fail("mergeIntent.override.omission must be an object");
  const omissionShape = exactKeys(omission, "mergeIntent.override.omission", ["profile", "omittedControls"]);
  if (!omissionShape.ok) return omissionShape;
  const profile = literal(omission["profile"], "mergeIntent.override.omission.profile", SECURITY_PROFILES);
  if (!profile.ok) return profile;
  const controls = array(
    omission["omittedControls"],
    "mergeIntent.override.omission.omittedControls",
    BOUNDS.reasonCodeArray,
    (item, i) => {
      if (typeof item !== "string") return fail(`control ${i} must be a string`);
      return ok(item);
    },
  );
  if (!controls.ok) return controls;

  // Exactly the tuple for the active profile: same values, same order (§21.9).
  const expected = OVERRIDE_OMISSIONS[profile.value];
  if (controls.value.length !== expected.length || controls.value.some((c, i) => c !== expected[i])) {
    return fail(
      `mergeIntent.override.omission.omittedControls must be exactly [${expected.join(", ")}] for profile ${profile.value}`,
    );
  }

  return ok({
    actorGithubId: actorGithubId.value,
    reason: reason.value,
    omission: { profile: profile.value, omittedControls: expected },
  });
}

export function parseMergeIntent(v: unknown): ParseResult<MergeIntentV1> {
  if (!isRecord(v)) return fail("mergeIntent must be an object");

  const kind = literal(v["kind"], "mergeIntent.kind", ["verified", "reused", "override"] as const);
  if (!kind.ok) return kind;

  const allowed = kind.value === "override" ? [...BASE_KEYS, "override"] : BASE_KEYS;
  // A verified intent carrying an `override` field, or an override carrying
  // verifier digests, is rejected rather than trimmed (§21.8).
  const shape = exactKeys(v, "mergeIntent", allowed);
  if (!shape.ok) return shape;

  const base = parseBase(v);
  if (!base.ok) return base;

  const evidence = v["evidence"];
  if (!isRecord(evidence)) return fail("mergeIntent.evidence must be an object");

  if (kind.value === "verified") {
    const evidenceShape = exactKeys(evidence, "mergeIntent.evidence", VERIFIED_EVIDENCE_KEYS);
    if (!evidenceShape.ok) return evidenceShape;
    const digests = readDigests(evidence, VERIFIED_EVIDENCE_KEYS);
    if (!digests.ok) return digests;
    return ok({
      ...base.value,
      kind: "verified",
      evidence: digests.value as unknown as VerifiedMergeEvidence,
    });
  }

  if (kind.value === "reused") {
    const evidenceShape = exactKeys(evidence, "mergeIntent.evidence", REUSED_EVIDENCE_KEYS);
    if (!evidenceShape.ok) return evidenceShape;
    const digests = readDigests(evidence, REUSED_EVIDENCE_KEYS);
    if (!digests.ok) return digests;
    return ok({
      ...base.value,
      kind: "reused",
      evidence: digests.value as unknown as ReusedMergeEvidence,
    });
  }

  const evidenceShape = exactKeys(evidence, "mergeIntent.evidence", OVERRIDE_EVIDENCE_KEYS);
  if (!evidenceShape.ok) return evidenceShape;
  const digests = readDigests(evidence, OVERRIDE_EVIDENCE_KEYS);
  if (!digests.ok) return digests;
  const authorization = parseOverrideAuthorization(v["override"]);
  if (!authorization.ok) return authorization;

  return ok({
    ...base.value,
    kind: "override",
    evidence: digests.value as unknown as OverrideMergeEvidence,
    override: authorization.value,
  });
}

function readDigests(
  evidence: Record<string, unknown>,
  keys: readonly string[],
): ParseResult<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (key === "candidateCheckRunId" || key === "proofCheckRunId") {
      const id = decimalId(evidence[key], `mergeIntent.evidence.${key}`);
      if (!id.ok) return id;
      out[key] = id.value;
      continue;
    }
    const digest = sha256(evidence[key], `mergeIntent.evidence.${key}`);
    if (!digest.ok) return digest;
    out[key] = digest.value;
  }
  return ok(out);
}
