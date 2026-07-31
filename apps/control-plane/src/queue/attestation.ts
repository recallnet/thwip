import { requiredSuitesDigest } from "@thwip/queue-protocol";
import type { GitSubject, Sha256 } from "@thwip/queue-protocol";
import { buildMergeIntent, buildReusedProofRecord, signMergeIntent, signTransitionRecord } from "./evidence.js";
import type { Signer, SignedRecord } from "./evidence.js";
import { mergeCommitMessage, mergeCommitTitle } from "./merge-commit.js";
import type { D1Like } from "./projection.js";

/**
 * The queue's own signed records, for a merge that rested on the head's proof.
 *
 * A chain link used to be the merge commit id padded out to the shape of a
 * digest. It named the commit and attested to nothing, so the chain recorded
 * that merges happened while the claim the product makes — that a reader can
 * check what was verified before each one landed — had nothing behind it.
 *
 * Two records are signed. The intent, before the merge, saying what the queue is
 * about to do and on what evidence. The transition record, after it, saying what
 * landed and citing the intent. The record's digest becomes the chain link.
 *
 * Neither names an assignment or a verifier result. Under this profile nothing
 * was dispatched and nothing ran against the integrated candidate, and the
 * schemas refuse those fields rather than leave them to be filled in.
 */

export interface ReuseEvidence {
  readonly workReceiptDigest: Sha256;
  readonly policyDigest: Sha256;
  readonly pipelineDigest: Sha256;
  readonly requiredSuitesDigest: Sha256;
  /** The App's proof check that verified this head. */
  readonly proofCheckRunId: string;
}

/**
 * Gather what a reuse merge rests on, or say what is missing.
 *
 * Every value here is read from something that already happened. Where one
 * cannot be read the answer is what is absent, never a substitute: the whole
 * point of signing these records is that a reader can believe them, and a record
 * assembled around a stand-in is worth less than no record at all.
 */
export async function reuseEvidenceFor(
  workReceiptDigest: Sha256,
  policy: { policyDigest: string; pipelineDigest: string | null; requiredSuites: readonly string[] } | null,
  proofCheckRunId: string | null,
): Promise<ReuseEvidence | { missing: string }> {
  if (policy === null) return { missing: "the repository has no active policy" };
  if (policy.pipelineDigest === null) return { missing: "the active policy names no pipeline" };
  if (proofCheckRunId === null) {
    return { missing: "no passing proof check was found for this head" };
  }
  return {
    workReceiptDigest,
    policyDigest: policy.policyDigest as Sha256,
    pipelineDigest: policy.pipelineDigest as Sha256,
    requiredSuitesDigest: await requiredSuitesDigest(policy.requiredSuites),
    proofCheckRunId,
  };
}

export interface ChainPosition {
  readonly queueEpoch: number;
  readonly turnSequence: number;
  readonly transitionSequence: number;
  readonly previousTransitionDigest: Sha256 | null;
}

export async function signReusedIntent(input: {
  readonly operationId: string;
  readonly attemptId: string;
  readonly git: GitSubject;
  readonly position: ChainPosition;
  readonly pullRequestNumber: number;
  readonly evidence: ReuseEvidence;
  readonly createdAt: string;
  readonly signer: Signer;
}): Promise<SignedRecord<unknown> | { error: string }> {
  const doc = await buildMergeIntent({
    operationId: input.operationId,
    attemptId: input.attemptId,
    git: input.git,
    queueEpoch: input.position.queueEpoch,
    turnSequence: input.position.turnSequence,
    transitionSequence: input.position.transitionSequence,
    pullRequestNumber: input.pullRequestNumber,
    mergeMethod: "merge",
    policyDigest: input.evidence.policyDigest,
    previousTransitionDigest: input.position.previousTransitionDigest,
    // What the workflow is told to write, so the intent specifies the commit
    // rather than describing one after the fact.
    commitTitle: mergeCommitTitle(input.pullRequestNumber),
    commitMessage: mergeCommitMessage(input.operationId),
    createdAt: input.createdAt,
    evidence: {
      kind: "reused",
      workReceiptDigest: input.evidence.workReceiptDigest,
      pipelineDigest: input.evidence.pipelineDigest,
      requiredSuitesDigest: input.evidence.requiredSuitesDigest,
      proofCheckRunId: input.evidence.proofCheckRunId,
    },
  });
  return signMergeIntent(doc, input.signer);
}

export async function signReusedRecord(input: {
  readonly attemptId: string;
  readonly git: GitSubject;
  readonly position: ChainPosition;
  readonly pullRequestNumber: number;
  readonly evidence: ReuseEvidence;
  readonly mergeIntentDigest: Sha256;
  readonly before: { readonly baseSha: string | null; readonly treeOid: string | null };
  readonly final: { readonly sha: string; readonly treeOid: string; readonly parentShas: readonly string[] };
  readonly observedAt: string;
  readonly signer: Signer;
}): Promise<SignedRecord<unknown> | { error: string }> {
  const doc = await buildReusedProofRecord({
    git: input.git,
    queueEpoch: input.position.queueEpoch,
    transitionSequence: input.position.transitionSequence,
    previousTransitionDigest: input.position.previousTransitionDigest,
    before: input.before,
    final: input.final,
    observedAt: input.observedAt,
    mergeMethod: "merge",
    attemptId: input.attemptId,
    pullRequestNumber: input.pullRequestNumber,
    mergeIntentDigest: input.mergeIntentDigest,
    workReceiptDigest: input.evidence.workReceiptDigest,
    policyDigest: input.evidence.policyDigest,
    pipelineDigest: input.evidence.pipelineDigest,
    requiredSuitesDigest: input.evidence.requiredSuitesDigest,
    checkRunId: input.evidence.proofCheckRunId,
  });
  return signTransitionRecord(doc, input.signer);
}

/**
 * Keep the exact bytes that were signed.
 *
 * Stored verbatim rather than re-serialised from the parsed record: the digest
 * is computed over these bytes and names nothing else, so a rebuild would
 * produce a record that means the same and verifies differently.
 */
export async function storeAttestation(
  db: D1Like,
  row: {
    readonly digest: string;
    readonly kind: string;
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly transitionSequence: number | null;
    readonly attemptId: string;
    readonly bytes: Uint8Array;
    readonly jws: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(digest) DO NOTHING`,
    )
    .bind(
      row.digest,
      row.kind,
      row.repositoryId,
      row.baseRef,
      row.transitionSequence,
      row.attemptId,
      new TextDecoder().decode(row.bytes),
      row.jws,
    )
    .run();
}

export async function readAttestation(
  db: D1Like,
  digest: string,
): Promise<{ digest: string; kind: string; record: unknown; jws: string } | null> {
  const row = await db
    .prepare("SELECT digest, kind, bytes, jws FROM queue_attestations WHERE digest = ?")
    .bind(digest)
    .first<{ digest: string; kind: string; bytes: string; jws: string }>();
  if (row === null) return null;
  return { digest: row.digest, kind: row.kind, record: JSON.parse(row.bytes) as unknown, jws: row.jws };
}
