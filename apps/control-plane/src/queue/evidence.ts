import {
  canonicalBytes,
  envelopeDigest,
  parseIntegrationAssignment,
  parseMergeIntent,
  parseTransitionRecord,
  QUEUE_PREDICATE_TYPES,
  recordDigest,
  parentOidsDigest,
  requiredSuitesDigest,
  type AssignmentVerifier,
  type ExternalObservationCode,
  type GitSubject,
  type IntegrationAssignmentV1,
  type MergeIntentV1,
  type Sha256,
  type TransitionRecordV1,
  type VerifiedExecutionV1,
} from "@thwip/queue-protocol";

/**
 * Building the queue's signed evidence.
 *
 * Two rules from the protocol are easy to get wrong and are enforced here rather
 * than left to callers.
 *
 * A record is validated before it is signed. Signing an unvalidated payload
 * would produce a signature over something the verifier will reject, which turns
 * a caller mistake into an unexplainable failure at merge time.
 *
 * A record's digest is taken over the exact signed bytes, never over JSON
 * rebuilt from a parsed object. So `signRecord` returns the
 * bytes it signed alongside the digest, and callers pass those bytes on rather
 * than re-serializing.
 */

export interface Signer {
  /** Signs the given bytes and returns a compact JWS. */
  sign(bytes: Uint8Array, typ: string): Promise<string>;
}

export interface SignedRecord<T> {
  readonly record: T;
  /** The exact bytes that were signed. Keep these; do not re-serialize. */
  readonly bytes: Uint8Array;
  readonly digest: Sha256;
  readonly jws: string;
}

/**
 * Canonicalize, validate, sign, and digest — in that order. The digest is of the
 * canonical payload bytes, which are also what the signature covers, so the
 * digest always names the thing that was signed.
 */
async function signRecord<T>(
  value: unknown,
  parse: (v: unknown) => { ok: true; value: T } | { ok: false; detail: string },
  predicateType: string,
  signer: Signer,
): Promise<SignedRecord<T> | { readonly error: string }> {
  const parsed = parse(value);
  if (!parsed.ok) return { error: parsed.detail };

  // Canonical JSON of the *validated* record, so a field the parser normalized
  // (NFC, ordering) is what gets signed.
  const canonical = JSON.stringify(sortDeep(parsed.value as unknown));
  const bytes = canonicalBytes(canonical);
  const [digest, jws] = await Promise.all([envelopeDigest(bytes), signer.sign(bytes, predicateType)]);
  return { record: parsed.value, bytes, digest, jws };
}

/** RFC 8785 ordering, applied to the validated record before signing. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = sortDeep(inner);
    }
    return out;
  }
  return value;
}

export async function signAssignment(
  value: unknown,
  signer: Signer,
): Promise<SignedRecord<IntegrationAssignmentV1> | { error: string }> {
  return signRecord(value, parseIntegrationAssignment, QUEUE_PREDICATE_TYPES.integrationAssignment, signer);
}

export async function signMergeIntent(
  value: unknown,
  signer: Signer,
): Promise<SignedRecord<MergeIntentV1> | { error: string }> {
  return signRecord(value, parseMergeIntent, QUEUE_PREDICATE_TYPES.mergeIntent, signer);
}

export async function signTransitionRecord(
  value: unknown,
  signer: Signer,
): Promise<SignedRecord<TransitionRecordV1> | { error: string }> {
  return signRecord(value, parseTransitionRecord, QUEUE_PREDICATE_TYPES.transitionRecord, signer);
}

/* ------------------------------------------------------------------ */

/**
 * Build the assignment for one attempt. Every digest here is computed, not
 * passed through, so a caller cannot accidentally bind an attempt to a policy or
 * pipeline it did not resolve.
 */
export async function buildAssignment(input: {
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly git: GitSubject;
  readonly queue: {
    readonly queueEpoch: number;
    readonly turnSequence: number;
    readonly entryId: string;
    readonly pullRequestNumber: number;
    readonly sponsorPrincipalId: string;
    readonly queueDecisionDigest: Sha256;
  };
  readonly policy: {
    readonly version: number;
    readonly securityProfile: "fast" | "fresh" | "audited" | "remote";
    readonly requiredSuites: readonly string[];
    /** The policy document, digested here rather than trusted as a value. */
    readonly document: unknown;
  } & (
    | { readonly runner: "command" }
    | { readonly runner: "dagger"; readonly daggerModuleDigest: Sha256; readonly daggerEngineDigest: Sha256 }
  );
  readonly execution: IntegrationAssignmentV1["execution"];
  readonly evidence: { readonly workReceiptDigest: Sha256; readonly previousTransitionDigest: Sha256 | null };
  /** Present only for a `remote` assignment; a local run has no GitHub workflow to pin. */
  readonly verifier?: AssignmentVerifier;
  readonly issuedAt: string;
  readonly executionSeconds: number;
  readonly nonce: string;
}): Promise<Record<string, unknown>> {
  const policyDigest = await recordDigest(input.policy.document);
  const expiresAt = new Date(Date.parse(input.issuedAt) + input.executionSeconds * 1000).toISOString();
  return {
    schemaVersion: "1",
    assignmentId: input.assignmentId,
    attemptId: input.attemptId,
    repository: { ownerId: input.ownerId, repositoryId: input.git.repositoryId, baseRef: input.git.baseRef },
    queue: { ...input.queue },
    execution: input.execution,
    git: input.git,
    policy: {
      digest: policyDigest,
      version: input.policy.version,
      securityProfile: input.policy.securityProfile,
      runner: input.policy.runner,
      requiredSuites: [...input.policy.requiredSuites],
      ...(input.policy.runner === "dagger"
        ? { daggerModuleDigest: input.policy.daggerModuleDigest, daggerEngineDigest: input.policy.daggerEngineDigest }
        : {}),
    },
    evidence: { ...input.evidence },
    ...(input.verifier !== undefined ? { verifier: input.verifier } : {}),
    timing: { issuedAt: input.issuedAt, notBefore: input.issuedAt, expiresAt },
    nonce: input.nonce,
  };
}

/**
 * Build the merge intent. The commit message is digested rather than embedded, so
 * a long message cannot push the signed envelope past its carrier bound
 *.
 */
export async function buildMergeIntent(input: {
  readonly operationId: string;
  readonly attemptId: string;
  readonly git: GitSubject;
  readonly queueEpoch: number;
  readonly turnSequence: number;
  readonly transitionSequence: number;
  readonly pullRequestNumber: number;
  readonly mergeMethod: "merge" | "squash";
  readonly policyDigest: Sha256;
  readonly previousTransitionDigest: Sha256 | null;
  readonly commitTitle: string;
  readonly commitMessage: string;
  readonly createdAt: string;
  readonly evidence:
    | {
        readonly kind: "verified";
        readonly workReceiptDigest: Sha256;
        readonly assignmentDigest: Sha256;
        readonly integrationEvidenceDigest: Sha256;
        readonly pipelineDigest: Sha256;
        readonly requiredSuitesDigest: Sha256;
        readonly execution: VerifiedExecutionV1;
      }
    | {
        /** A merge the queue had the integrated candidate run for. */
        readonly kind: "candidate-verified";
        readonly workReceiptDigest: Sha256;
        readonly pipelineDigest: Sha256;
        readonly requiredSuitesDigest: Sha256;
        readonly verifierResultDigest: Sha256;
        readonly proofCheckRunId: string;
      }
    | {
        /**
         * A merge resting on the proof already carried by the head. It names no
         * assignment and no verifier result because nothing was dispatched and
         * nothing ran against the integrated candidate.
         */
        readonly kind: "reused";
        readonly workReceiptDigest: Sha256;
        readonly pipelineDigest: Sha256;
        readonly requiredSuitesDigest: Sha256;
        readonly proofCheckRunId: string;
      }
    | {
        readonly kind: "override";
        readonly workReceiptDigest: Sha256;
        readonly assignmentDigest: Sha256;
        readonly liveGuardDigest: Sha256;
        readonly candidateCheckRunId: string;
        readonly override: MergeIntentV1 extends { override: infer O } ? O : never;
      };
}): Promise<Record<string, unknown>> {
  const base = {
    schemaVersion: "1",
    operationId: input.operationId,
    attemptId: input.attemptId,
    repositoryId: input.git.repositoryId,
    baseRef: input.git.baseRef,
    queueEpoch: input.queueEpoch,
    turnSequence: input.turnSequence,
    transitionSequence: input.transitionSequence,
    git: input.git,
    pullRequestNumber: input.pullRequestNumber,
    mergeMethod: input.mergeMethod,
    policyDigest: input.policyDigest,
    previousTransitionDigest: input.previousTransitionDigest,
    generatedCommitTitle: input.commitTitle,
    generatedCommitMessageDigest: await recordDigest(input.commitMessage),
    createdAt: input.createdAt,
  };

  if (
    input.evidence.kind === "verified" ||
    input.evidence.kind === "reused" ||
    input.evidence.kind === "candidate-verified"
  ) {
    const { kind, ...evidence } = input.evidence;
    return { ...base, kind, evidence };
  }
  const { kind: _kind, override, ...evidence } = input.evidence;
  return { ...base, kind: "override", evidence, override };
}

/**
 * Build the transition record for a merge that landed. Parent digest and count
 * bind the full vector even when only the first sixteen are embedded (§21.9).
 */
export async function buildTransitionRecord(input: {
  readonly git: GitSubject;
  readonly queueEpoch: number;
  readonly transitionSequence: number;
  readonly previousTransitionDigest: Sha256 | null;
  readonly before: { readonly baseSha: string | null; readonly treeOid: string | null };
  readonly final: { readonly sha: string; readonly treeOid: string; readonly parentShas: readonly string[] };
  readonly observedAt: string;
  readonly mergeMethod: "merge" | "squash";
  readonly attemptId: string;
  readonly pullRequestNumber: number;
  readonly mergeIntentDigest: Sha256;
  readonly workReceiptDigest: Sha256;
  readonly assignmentDigest: Sha256;
  readonly integrationEvidenceDigest: Sha256;
  readonly policyDigest: Sha256;
  readonly pipelineDigest: Sha256;
  readonly requiredSuitesDigest: Sha256;
  readonly execution: VerifiedExecutionV1;
}): Promise<Record<string, unknown>> {
  const parents = input.final.parentShas;
  const embedded = parents.slice(0, 16);
  return {
    schemaVersion: "1",
    kind: "verified-merge",
    repositoryId: input.git.repositoryId,
    baseRef: input.git.baseRef,
    queueEpoch: input.queueEpoch,
    transitionSequence: input.transitionSequence,
    previousTransitionDigest: input.previousTransitionDigest,
    before: input.before,
    after: {
      baseSha: input.final.sha,
      treeOid: input.final.treeOid,
      parentOids: embedded,
      parentCount: parents.length,
      parentOidsDigest: await parentOidsDigest(parents),
      parentsComplete: embedded.length === parents.length,
    },
    observedAt: input.observedAt,
    verifiedMerge: {
      attemptId: input.attemptId,
      mergeIntentDigest: input.mergeIntentDigest,
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.git.headSha,
      candidateSha: input.final.sha,
      candidateTreeOid: input.final.treeOid,
      mergeMethod: input.mergeMethod,
      workReceiptDigest: input.workReceiptDigest,
      assignmentDigest: input.assignmentDigest,
      integrationEvidenceDigest: input.integrationEvidenceDigest,
      policyDigest: input.policyDigest,
      pipelineDigest: input.pipelineDigest,
      requiredSuitesDigest: input.requiredSuitesDigest,
      execution: input.execution,
    },
  };
}

/**
 * Build the transition record for a merge that rested on the head's own proof.
 *
 * The same git facts as a verified merge, and a different claim: no verifier
 * result and no integration evidence, because nothing ran against the integrated
 * candidate, and no assignment, because no runner was dispatched. What it binds
 * instead is why the reuse was legitimate — the proof, the policy and pipeline it
 * satisfied, the suites that were required, and the check run that verified it.
 */
export async function buildReusedProofRecord(input: {
  /** Which claim this record makes; see the two kinds in @thwip/queue-protocol. */
  readonly verifierResultDigest?: Sha256;
  readonly git: GitSubject;
  readonly queueEpoch: number;
  readonly transitionSequence: number;
  readonly previousTransitionDigest: Sha256 | null;
  readonly before: { readonly baseSha: string | null; readonly treeOid: string | null };
  readonly final: { readonly sha: string; readonly treeOid: string; readonly parentShas: readonly string[] };
  readonly observedAt: string;
  readonly mergeMethod: "merge" | "squash";
  readonly attemptId: string;
  readonly pullRequestNumber: number;
  readonly mergeIntentDigest: Sha256;
  readonly workReceiptDigest: Sha256;
  readonly policyDigest: Sha256;
  readonly pipelineDigest: Sha256;
  readonly requiredSuitesDigest: Sha256;
  readonly checkRunId: string;
}): Promise<Record<string, unknown>> {
  const parents = input.final.parentShas;
  const embedded = parents.slice(0, 16);
  const verified = input.verifierResultDigest !== undefined;
  return {
    schemaVersion: "1",
    kind: verified ? "candidate-verified-merge" : "reused-proof-merge",
    repositoryId: input.git.repositoryId,
    baseRef: input.git.baseRef,
    queueEpoch: input.queueEpoch,
    transitionSequence: input.transitionSequence,
    previousTransitionDigest: input.previousTransitionDigest,
    before: input.before,
    after: {
      baseSha: input.final.sha,
      treeOid: input.final.treeOid,
      parentOids: embedded,
      parentCount: parents.length,
      parentOidsDigest: await parentOidsDigest(parents),
      parentsComplete: embedded.length === parents.length,
    },
    observedAt: input.observedAt,
    [verified ? "candidateVerified" : "reusedProof"]: {
      attemptId: input.attemptId,
      mergeIntentDigest: input.mergeIntentDigest,
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.git.headSha,
      candidateSha: input.final.sha,
      candidateTreeOid: input.final.treeOid,
      mergeMethod: input.mergeMethod,
      workReceiptDigest: input.workReceiptDigest,
      policyDigest: input.policyDigest,
      pipelineDigest: input.pipelineDigest,
      requiredSuitesDigest: input.requiredSuitesDigest,
      ...(verified ? { verifierResultDigest: input.verifierResultDigest } : {}),
      checkRunId: input.checkRunId,
    },
  };
}

/**
 * Build the record that corrects an earlier record's base sha.
 *
 * Nothing here is composed from the caller's description of the commit. The
 * tree, the parents and the parent count are copied from the record being
 * corrected, and the route has already made GitHub agree that the commit it
 * names carries exactly those. `before` is copied too. One field differs from
 * the record it corrects, and that is the point: a correction that could change
 * anything else would be a rewrite wearing a different name.
 */
export async function buildBaseCorrectionRecord(input: {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly queueEpoch: number;
  readonly transitionSequence: number;
  readonly previousTransitionDigest: Sha256;
  readonly corrected: {
    readonly digest: Sha256;
    readonly transitionSequence: number;
    readonly before: { readonly baseSha: string; readonly treeOid: string };
    readonly after: {
      readonly baseSha: string;
      readonly treeOid: string;
      readonly parentOids: readonly string[];
      readonly parentCount: number;
      readonly parentOidsDigest: Sha256;
      readonly parentsComplete: boolean;
    };
    readonly attemptId: string;
  };
  readonly baseSha: string;
  readonly actorPrincipalId: string;
  readonly reason: string;
  readonly observedAt: string;
}): Promise<Record<string, unknown>> {
  return {
    schemaVersion: "1",
    kind: "base-correction",
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    queueEpoch: input.queueEpoch,
    transitionSequence: input.transitionSequence,
    previousTransitionDigest: input.previousTransitionDigest,
    before: input.corrected.before,
    after: {
      baseSha: input.baseSha,
      treeOid: input.corrected.after.treeOid,
      parentOids: [...input.corrected.after.parentOids],
      parentCount: input.corrected.after.parentCount,
      parentOidsDigest: input.corrected.after.parentOidsDigest,
      parentsComplete: input.corrected.after.parentsComplete,
    },
    observedAt: input.observedAt,
    correction: {
      correctsTransitionDigest: input.corrected.digest,
      correctsTransitionSequence: input.corrected.transitionSequence,
      correctedBaseSha: input.corrected.after.baseSha,
      attemptId: input.corrected.attemptId,
      actorPrincipalId: input.actorPrincipalId,
      reason: input.reason,
    },
  };
}

/**
 * Build the record for a branch movement the queue did not certify.
 *
 * This is the weakest of the merge-shaped kinds and it is chosen on purpose.
 * Where a commit reached the branch and no signed intent pins that tree on
 * those parents, the queue cannot say it authorized the merge, because it did
 * not. What it can say is that the branch went from one commit to another and
 * that the queue was not the cause. That claim rests only on git, which anybody
 * can re-check, and it fills the hole in the chain without asserting anything
 * the evidence does not carry.
 *
 * Nothing here comes from an operator except `operatorReasonDigest`, which
 * binds the words they gave for asking. The shas, the tree and the parents are
 * read from the commit.
 */
export async function buildExternalTransitionRecord(input: {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly queueEpoch: number;
  readonly transitionSequence: number;
  readonly previousTransitionDigest: Sha256 | null;
  readonly before: { readonly baseSha: string; readonly treeOid: string };
  readonly moved: { readonly sha: string; readonly treeOid: string; readonly parentShas: readonly string[] };
  readonly observationReasonCode: ExternalObservationCode;
  readonly operatorReasonDigest: Sha256;
  readonly observedAt: string;
}): Promise<Record<string, unknown>> {
  const parents = input.moved.parentShas;
  const embedded = parents.slice(0, 16);
  return {
    schemaVersion: "1",
    kind: "external-transition",
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    queueEpoch: input.queueEpoch,
    transitionSequence: input.transitionSequence,
    previousTransitionDigest: input.previousTransitionDigest,
    before: input.before,
    after: {
      baseSha: input.moved.sha,
      treeOid: input.moved.treeOid,
      parentOids: embedded,
      parentCount: parents.length,
      parentOidsDigest: await parentOidsDigest(parents),
      parentsComplete: embedded.length === parents.length,
    },
    observedAt: input.observedAt,
    external: {
      observationReasonCode: input.observationReasonCode,
      operatorReasonDigest: input.operatorReasonDigest,
    },
  };
}

/**
 * Build the record that opens an attested range.
 *
 * A chain that begins at a sequence in the middle of a table begins mid-air: a
 * reader is shown a first link whose predecessor they cannot fetch and whose
 * base they are asked to take on trust. A genesis is the root. It names what the
 * queue was configured with when the range opened, it states the commit the
 * branch stood at, and it starts from no base at all, which is the one place a
 * walk can start without asking what came before.
 *
 * `priorEpochClosingDigest` is the last record of the range before it, and it is
 * the same value as `previousTransitionDigest` on purpose. The storage chain is
 * unbroken across the boundary, so the record before this one is still the
 * record before this one; what changes is which range a verifier is asked to
 * check. Naming it twice is what stops a genesis claiming to follow one record
 * while descending from another.
 */
export async function buildGenesisRecord(input: {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly queueEpoch: number;
  readonly transitionSequence: number;
  readonly previousTransitionDigest: Sha256 | null;
  readonly at: { readonly sha: string; readonly treeOid: string; readonly parentShas: readonly string[] };
  readonly policyDigest: Sha256;
  readonly configDigest: Sha256;
  readonly rulesetDigest: Sha256;
  readonly observedAt: string;
}): Promise<Record<string, unknown>> {
  const parents = input.at.parentShas;
  const embedded = parents.slice(0, 16);
  return {
    schemaVersion: "1",
    kind: "genesis",
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    queueEpoch: input.queueEpoch,
    transitionSequence: input.transitionSequence,
    previousTransitionDigest: input.previousTransitionDigest,
    before: { baseSha: null, treeOid: null },
    after: {
      baseSha: input.at.sha,
      treeOid: input.at.treeOid,
      parentOids: embedded,
      parentCount: parents.length,
      parentOidsDigest: await parentOidsDigest(parents),
      parentsComplete: embedded.length === parents.length,
    },
    observedAt: input.observedAt,
    genesis: {
      policyDigest: input.policyDigest,
      configDigest: input.configDigest,
      rulesetDigest: input.rulesetDigest,
      priorEpochClosingDigest: input.previousTransitionDigest,
    },
  };
}

/** The three digests a fast-path reuse claim binds. */
export interface ReuseEquivalence {
  readonly policyDigest: Sha256;
  readonly pipelineDigest: Sha256;
  readonly requiredSuitesDigest: Sha256;
}

/**
 * The equivalence digests a fast-path reuse claim binds.
 *
 * One producer, so the record and the check that lets the record be signed
 * cannot compute the triple differently. It took a pipeline document before,
 * which is the reason it went uncalled: the activated bundle keeps the
 * pipeline's digest and not the pipeline itself, so no caller at the merge gate
 * could satisfy the signature. Required suites are digested here rather than
 * carried as a list because that is the form the record stores.
 */
export async function reuseEquivalenceDigests(input: {
  readonly requiredSuites: readonly string[];
  readonly pipelineDigest: Sha256;
  readonly policyDigest: Sha256;
}): Promise<ReuseEquivalence> {
  return {
    policyDigest: input.policyDigest,
    pipelineDigest: input.pipelineDigest,
    requiredSuitesDigest: await requiredSuitesDigest(input.requiredSuites),
  };
}
