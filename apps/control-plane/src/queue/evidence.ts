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
  type GitSubject,
  type IntegrationAssignmentV1,
  type MergeIntentV1,
  type Sha256,
  type TransitionRecordV1,
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
 * rebuilt from a parsed object (plan.md §21.8). So `signRecord` returns the
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
 * (plan.md §21.9).
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
        readonly verifierResultDigest: Sha256;
        readonly candidateCheckRunId: string;
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
  readonly verifierResultDigest: Sha256;
  readonly checkRunId: string;
  readonly actionRunId: string;
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
      verifierResultDigest: input.verifierResultDigest,
      checkRunId: input.checkRunId,
      actionRunId: input.actionRunId,
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
 * The equivalence digests a fast-path reuse claim binds (plan.md §21.5). Exposed
 * so the verifier and the scheduler compute them the same way; a difference here
 * would let reuse certify a tree nobody integrated.
 */
export async function reuseEquivalenceDigests(input: {
  readonly requiredSuites: readonly string[];
  readonly pipelineDocument: unknown;
  readonly policyDocument: unknown;
}): Promise<{ policyDigest: Sha256; pipelineDigest: Sha256; requiredSuitesDigest: Sha256 }> {
  const [policyDigest, pipelineDigest, suitesDigest] = await Promise.all([
    recordDigest(input.policyDocument),
    recordDigest(input.pipelineDocument),
    requiredSuitesDigest(input.requiredSuites),
  ]);
  return { policyDigest, pipelineDigest, requiredSuitesDigest: suitesDigest };
}

/**
 * Digest of the live guard facts, so an override records exactly which GitHub
 * controls still held at the moment it was authorized (§21.7).
 */
export async function liveGuardDigest(facts: Record<string, unknown>): Promise<Sha256> {
  return recordDigest(facts);
}
