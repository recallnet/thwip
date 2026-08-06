import { parseMergeIntent } from "@thwip/queue-protocol";
import type { GitSubject, MergeIntentV1, MergeMethod, Sha256, VerifiedExecutionV1 } from "@thwip/queue-protocol";
import {
  buildMergeIntent,
  buildReusedProofRecord,
  buildTransitionRecord,
  reuseEquivalenceDigests,
  signMergeIntent,
  signTransitionRecord,
} from "./evidence.js";
import { proofShortfall, type ProofBinding } from "./work-receipt.js";
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
  /** Tenant scope, threaded through so a signed record can be mirrored under it. */
  readonly organizationId: string;
  readonly policyDigest: Sha256;
  readonly pipelineDigest: Sha256;
  readonly requiredSuitesDigest: Sha256;
  /** The check run that verified the proof on this head. */
  readonly proofCheckRunId: string;
  /**
   * The verifier's result, where the queue had the integrated candidate run.
   * Absent under a profile that asks for nothing beyond the head's own proof,
   * and its presence is what decides which claim the records make.
   */
  readonly verifierResultDigest?: Sha256;
}

/**
 * Why a merge may not be signed.
 *
 * `reason` names the blocking reason a developer already has a sentence for.
 * Without one the caller reports that the evidence is incomplete, which is what
 * an absent value is; a policy the proof never bound is a different thing and
 * the developer acts on it differently.
 */
export interface EvidenceRefusal {
  readonly missing: string;
  readonly reason?: "POLICY_CHANGED";
}

/**
 * Gather what a reuse merge rests on, or say what is missing.
 *
 * Every value here is read from something that already happened. Where one
 * cannot be read the answer is what is absent, never a substitute: the whole
 * point of signing these records is that a reader can believe them, and a record
 * assembled around a stand-in is worth less than no record at all.
 *
 * The three equivalence digests come from the repository's current policy, and
 * for a while nothing compared them to the proof being reused. So a repository
 * could add a required suite, keep the green check the old proof earned, and
 * merge under a signed record stamping the new policy's digests over work that
 * never satisfied it. Reuse skips a Dagger run, never a current-authorization
 * check, so the proof has to bind the policy in force here or
 * there is nothing to sign.
 */
export async function reuseEvidenceFor(
  workReceiptDigest: Sha256,
  policy: {
    policyDigest: string;
    pipelineDigest: string | null;
    requiredSuites: readonly string[];
    organizationId: string;
  } | null,
  proofCheckRunId: string | null,
  verifierResultDigest: string | null,
  proof: ProofBinding | null,
): Promise<ReuseEvidence | EvidenceRefusal> {
  if (policy === null) return { missing: "the repository has no active policy" };
  if (policy.pipelineDigest === null) return { missing: "the active policy names no pipeline" };
  if (proofCheckRunId === null) {
    return { missing: "no passing proof check was found for this head" };
  }
  const equivalence = await reuseEquivalenceDigests({
    policyDigest: policy.policyDigest as Sha256,
    pipelineDigest: policy.pipelineDigest as Sha256,
    requiredSuites: policy.requiredSuites,
  });

  if (proof === null) return { missing: "the head's proof binds no policy this merge can read" };

  // One comparison, shared with readiness, so the two cannot reach different
  // verdicts about the same head. That split is the bug family this change
  // closes, and a second copy here would reopen it the first time one moved.
  //
  // The policy's digest is deliberately not part of it. A digest changes when
  // anything in the policy changes, including settings a proof cannot fail: the
  // minimum permission, the allowed key algorithms, the lease rules. Refusing on
  // identity made a cosmetic edit invalidate every proof in flight, which is what
  // the App's twenty-four hour grace list existed to paper over. That list is
  // gone. What a proof can fail is the pipeline it ran and the suites it passed.
  const shortfall = proofShortfall(proof, {
    pipelineDigest: equivalence.pipelineDigest,
    requiredSuites: policy.requiredSuites,
  });
  if (shortfall !== null) return { missing: shortfall, reason: "POLICY_CHANGED" };

  return {
    workReceiptDigest,
    organizationId: policy.organizationId,
    policyDigest: equivalence.policyDigest,
    pipelineDigest: equivalence.pipelineDigest,
    requiredSuitesDigest: equivalence.requiredSuitesDigest,
    proofCheckRunId,
    ...(verifierResultDigest === null ? {} : { verifierResultDigest: verifierResultDigest as Sha256 }),
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
  readonly mergeMethod: MergeMethod;
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
    mergeMethod: input.mergeMethod,
    policyDigest: input.evidence.policyDigest,
    previousTransitionDigest: input.position.previousTransitionDigest,
    // What the App writer is told to write, so the intent specifies the commit
    // rather than describing one after the fact.
    commitTitle: mergeCommitTitle(input.pullRequestNumber),
    commitMessage: mergeCommitMessage(input.operationId),
    createdAt: input.createdAt,
    evidence:
      input.evidence.verifierResultDigest === undefined
        ? {
            kind: "reused",
            workReceiptDigest: input.evidence.workReceiptDigest,
            pipelineDigest: input.evidence.pipelineDigest,
            requiredSuitesDigest: input.evidence.requiredSuitesDigest,
            proofCheckRunId: input.evidence.proofCheckRunId,
          }
        : {
            kind: "candidate-verified",
            workReceiptDigest: input.evidence.workReceiptDigest,
            pipelineDigest: input.evidence.pipelineDigest,
            requiredSuitesDigest: input.evidence.requiredSuitesDigest,
            verifierResultDigest: input.evidence.verifierResultDigest,
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
  readonly mergeMethod: MergeMethod;
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
    mergeMethod: input.mergeMethod,
    attemptId: input.attemptId,
    pullRequestNumber: input.pullRequestNumber,
    mergeIntentDigest: input.mergeIntentDigest,
    workReceiptDigest: input.evidence.workReceiptDigest,
    policyDigest: input.evidence.policyDigest,
    pipelineDigest: input.evidence.pipelineDigest,
    requiredSuitesDigest: input.evidence.requiredSuitesDigest,
    ...(input.evidence.verifierResultDigest === undefined
      ? {}
      : { verifierResultDigest: input.evidence.verifierResultDigest }),
    checkRunId: input.evidence.proofCheckRunId,
  });
  return signTransitionRecord(doc, input.signer);
}

/**
 * The queue's own signed records, for a merge backed by an assignment and a
 * signed integration receipt.
 *
 * This is the strongest of the four kinds, and until the assignment and
 * receipt paths existed there was nothing to fill these fields with — a
 * verified merge asserts the queue dispatched the run and the device signed
 * for it, and a record built without either would be signing a claim the
 * queue cannot back.
 */

export interface VerifiedEvidence {
  readonly workReceiptDigest: Sha256;
  /** Tenant scope, threaded through so a signed record can be mirrored under it. */
  readonly organizationId: string;
  readonly policyDigest: Sha256;
  readonly pipelineDigest: Sha256;
  readonly requiredSuitesDigest: Sha256;
  readonly assignmentDigest: Sha256;
  readonly integrationEvidenceDigest: Sha256;
  readonly execution: VerifiedExecutionV1;
}

/**
 * Gather what a verified merge rests on, or say what is missing.
 *
 * Every digest here names something that actually happened: an assignment
 * issued to a device, and a receipt that device signed back. Either one absent
 * means the record must not be built — a refusal here is what keeps the record
 * from claiming more than the queue can show.
 *
 * Where the run happened is the other thing this decides. Under `fresh` the
 * suites ran on the device and GitHub saw none of it, so the execution names
 * the device and stops there. Under `audited` a second execution ran in
 * Actions, and that one has a result and both run ids or it is not recorded at
 * all: half a rerun would be a claim with nothing behind it.
 */
export function verifiedEvidenceFor(input: {
  readonly workReceiptDigest: Sha256;
  readonly organizationId: string;
  readonly policyDigest: Sha256;
  readonly pipelineDigest: Sha256 | null;
  readonly requiredSuitesDigest: Sha256;
  readonly assignmentDigest: Sha256 | null;
  readonly integrationEvidenceDigest: Sha256 | null;
  /** The device the receipt came from, read from the accepted receipt. */
  readonly deviceKeyId: string | null;
  /** The audited profile's second execution, null where none ran. */
  readonly rerun: {
    readonly verifierResultDigest: Sha256 | null;
    readonly checkRunId: string | null;
    readonly actionRunId: string | null;
  } | null;
}): VerifiedEvidence | EvidenceRefusal {
  if (input.assignmentDigest === null) return { missing: "no assignment was issued for this attempt" };
  if (input.integrationEvidenceDigest === null) {
    return { missing: "no integration receipt was signed for this attempt" };
  }
  if (input.pipelineDigest === null) return { missing: "the active policy names no pipeline" };

  const execution = ((): VerifiedExecutionV1 | { missing: string } => {
    if (input.rerun === null) {
      // Nothing else ran, so the device is the whole account of the execution
      // and a record without it would say the suites passed somewhere unnamed.
      return input.deviceKeyId === null
        ? { missing: "no device is named by the receipt this merge rests on" }
        : { ranOn: "device", deviceKeyId: input.deviceKeyId };
    }
    const { verifierResultDigest, checkRunId, actionRunId } = input.rerun;
    if (verifierResultDigest === null) return { missing: "the second execution produced no result" };
    if (checkRunId === null || actionRunId === null) {
      return { missing: "the second execution names no check run and no Actions run" };
    }
    return { ranOn: "github-actions", verifierResultDigest, checkRunId, actionRunId };
  })();
  if ("missing" in execution) return execution;

  return {
    workReceiptDigest: input.workReceiptDigest,
    organizationId: input.organizationId,
    policyDigest: input.policyDigest,
    pipelineDigest: input.pipelineDigest,
    requiredSuitesDigest: input.requiredSuitesDigest,
    assignmentDigest: input.assignmentDigest,
    integrationEvidenceDigest: input.integrationEvidenceDigest,
    execution,
  };
}

export async function signVerifiedIntent(input: {
  readonly operationId: string;
  readonly attemptId: string;
  readonly git: GitSubject;
  readonly position: ChainPosition;
  readonly pullRequestNumber: number;
  readonly evidence: VerifiedEvidence;
  readonly mergeMethod: MergeMethod;
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
    mergeMethod: input.mergeMethod,
    policyDigest: input.evidence.policyDigest,
    previousTransitionDigest: input.position.previousTransitionDigest,
    // What the App writer is told to write, so the intent specifies the commit
    // rather than describing one after the fact.
    commitTitle: mergeCommitTitle(input.pullRequestNumber),
    commitMessage: mergeCommitMessage(input.operationId),
    createdAt: input.createdAt,
    evidence: {
      kind: "verified",
      workReceiptDigest: input.evidence.workReceiptDigest,
      assignmentDigest: input.evidence.assignmentDigest,
      integrationEvidenceDigest: input.evidence.integrationEvidenceDigest,
      pipelineDigest: input.evidence.pipelineDigest,
      requiredSuitesDigest: input.evidence.requiredSuitesDigest,
      execution: input.evidence.execution,
    },
  });
  return signMergeIntent(doc, input.signer);
}

export async function signVerifiedRecord(input: {
  readonly attemptId: string;
  readonly git: GitSubject;
  readonly position: ChainPosition;
  readonly pullRequestNumber: number;
  readonly evidence: VerifiedEvidence;
  readonly mergeMethod: MergeMethod;
  readonly mergeIntentDigest: Sha256;
  readonly before: { readonly baseSha: string | null; readonly treeOid: string | null };
  readonly final: { readonly sha: string; readonly treeOid: string; readonly parentShas: readonly string[] };
  readonly observedAt: string;
  readonly signer: Signer;
}): Promise<SignedRecord<unknown> | { error: string }> {
  const doc = await buildTransitionRecord({
    git: input.git,
    queueEpoch: input.position.queueEpoch,
    transitionSequence: input.position.transitionSequence,
    previousTransitionDigest: input.position.previousTransitionDigest,
    before: input.before,
    final: input.final,
    observedAt: input.observedAt,
    mergeMethod: input.mergeMethod,
    attemptId: input.attemptId,
    pullRequestNumber: input.pullRequestNumber,
    mergeIntentDigest: input.mergeIntentDigest,
    workReceiptDigest: input.evidence.workReceiptDigest,
    assignmentDigest: input.evidence.assignmentDigest,
    integrationEvidenceDigest: input.evidence.integrationEvidenceDigest,
    policyDigest: input.evidence.policyDigest,
    pipelineDigest: input.evidence.pipelineDigest,
    requiredSuitesDigest: input.evidence.requiredSuitesDigest,
    execution: input.evidence.execution,
  });
  return signTransitionRecord(doc, input.signer);
}

function isOneRecordPerAttemptViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message) && /attempt_id/i.test(message);
}

/**
 * Keep the exact bytes that were signed.
 *
 * Stored verbatim rather than re-serialised from the parsed record: the digest
 * is computed over these bytes and names nothing else, so a rebuild would
 * produce a record that means the same and verifies differently.
 *
 * Two simultaneous first reports of the same merge can both find nothing
 * recorded yet, both sign, and both reach this insert — the check in
 * `transitionRecordFor` narrows that window but cannot close it.
 * `idx_queue_attestations_one_record_per_attempt` closes it: the second
 * insert for a transition record fails rather than giving the attempt two
 * links in the chain. That failure is not this attempt's error, it is a
 * race it lost, so it is caught here and reported as such rather than
 * thrown — the caller uses the record that won instead of losing the merge
 * confirmation to an unhandled exception.
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
    /** Tenant scope for the durable copy. */
    readonly organizationId?: string;
    /**
     * Where the second copy goes.
     *
     * D1 is the only home a record has, and the queue document that references
     * it is compacted. A signed record is meant to outlive the queue that made
     * it, so it is written to content-addressed storage as well. The D1 row
     * below is written first and this is attempted after: a bucket write can be
     * retried by a backfill, but a lost merge record cannot, so failing to
     * mirror must never cost the record.
     */
    readonly mirror?: (input: {
      organizationId: string;
      repositoryId: string;
      kind: "merge-intent" | "transition-record";
      digest: string;
      bytes: Uint8Array;
    }) => Promise<void>;
  },
): Promise<{ stored: true } | { stored: false; digest: string }> {
  const result = await (async (): Promise<{ stored: true } | { stored: false; digest: string }> => {
    try {
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
      return { stored: true };
    } catch (error) {
      if (row.transitionSequence === null || !isOneRecordPerAttemptViolation(error)) throw error;
      const winner = await transitionRecordFor(db, row.repositoryId, row.baseRef, row.attemptId);
      // The constraint fires because a row for this attempt already holds a
      // position. When that row sits in this epoch, `transitionRecordFor`
      // finds it and this is the record that won the race.
      //
      // An epoch bump like migration 0016's produces the other case: the
      // attempt's old record sits exactly where it was, still holding the
      // partial index's one slot for that attempt id, while
      // `transitionRecordFor` now correctly stops seeing it because the
      // chain a verifier reads starts somewhere past it. That old row's
      // slot is freed the same way a losing race's row is freed elsewhere
      // in this file: the position is cleared, the bytes and signature
      // stay for anyone auditing what happened, and the insert this
      // attempt actually asked for is retried into the now-open slot.
      if (winner !== null) return { stored: false, digest: winner };
      const stale = await db
        .prepare(
          `SELECT digest FROM queue_attestations WHERE attempt_id = ? AND transition_sequence IS NOT NULL LIMIT 1`,
        )
        .bind(row.attemptId)
        .first<{ digest: string }>();
      if (stale === null) throw error;
      await db
        .prepare(`UPDATE queue_attestations SET transition_sequence = NULL WHERE digest = ?`)
        .bind(stale.digest)
        .run();
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
      return { stored: true };
    }
  })();

  // The row above is already committed by the time this runs. A bucket that is
  // down loses nothing that D1 does not already hold, so the failure is
  // swallowed here rather than thrown: the durable copy is retried by backfill,
  // but a merge record thrown away for a storage hiccup is not recoverable.
  //
  // This runs on the losing path too, mirroring the loser's own digest and
  // bytes rather than the winner's. The loser is a genuine signed record —
  // the queue really did sign it — and storage is content-addressed, so it
  // lands under its own digest and collides with nothing. That matches what
  // the schema migration chose for D1: the losing row is demoted out of the
  // chain but its bytes and signature are kept rather than deleted.
  // Destroying signed evidence to tidy up is a worse habit than keeping a
  // blob nobody references.
  if (row.mirror !== undefined && row.organizationId !== undefined) {
    try {
      await row.mirror({
        organizationId: row.organizationId,
        repositoryId: row.repositoryId,
        kind: row.kind === "merge-intent" ? "merge-intent" : "transition-record",
        digest: row.digest,
        bytes: row.bytes,
      });
      // Stamped here rather than left to the backfill: a row this mirror already
      // wrote a durable copy for has no reason to sit in the backlog it exists to
      // drain. Digest is content-addressed, so this is the same digest the row
      // above was inserted under whether this call won or lost the race in
      // storeAttestation's own insert.
      await db
        .prepare(`UPDATE queue_attestations SET mirrored_at = ? WHERE digest = ?`)
        .bind(new Date().toISOString(), row.digest)
        .run();
    } catch {
      /* the record is stored; the durable copy is retried by the backfill */
    }
  }

  return result;
}

/**
 * The transition record this attempt already produced, if any.
 *
 * A merge is reported at least once, and sometimes more: two racing runs can
 * both tell the queue their merge landed, or a single run can retry. The
 * domain layer already deduplicates the transition itself by attempt id, but
 * signing ran again on every call regardless — a fresh `observedAt` made a
 * fresh digest every time, so a merge that landed once ended up with two
 * signed records both claiming the same position in the chain. Checking here
 * first, before anything is built or signed, is what makes the second report
 * of a merge an idempotent no-op rather than a second link.
 *
 * Asked of every range this branch has ever had, not of the current one. A
 * record for an attempt is written once and cannot be written twice: the
 * partial unique index on `attempt_id` refuses a second row a position. So an
 * epoch-scoped answer here cannot lead to a repair, only to a repair attempted
 * on every tick and refused on every tick.
 *
 * Worse than the cost, it re-records. On 5 August the attested range on this
 * repository moved to 152 and fifty-nine merges recorded below it read back as
 * unrecorded. The sweep began writing second records for merges the chain
 * already held, at the head, so the new range said the base had moved to a
 * commit the branch left days ago and the walk broke at the first one. An epoch
 * boundary says which records a verifier is asked to check. It does not
 * un-record a merge, and reading a filtered-out record as an absent one is how
 * this repository keeps producing the same defect.
 */
export async function transitionRecordFor(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  attemptId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT digest FROM queue_attestations
        WHERE github_repository_id = ? AND base_ref = ? AND attempt_id = ? AND transition_sequence IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .bind(repositoryId, baseRef, attemptId)
    .first<{ digest: string }>();
  return row === null ? null : row.digest;
}

/**
 * The record this branch's chain already has for a commit, whatever wrote it.
 *
 * `transitionRecordFor` answers the same question keyed on the attempt, which
 * covers the merge that reported itself twice. It cannot cover a commit the
 * chain reached by another road: a movement record carries no attempt, because
 * the absence of one is the finding it answers. Without this, the sweep that
 * settles stranded merge writes would call the repair path, be refused for a
 * commit already sitting in the chain, and leave the row open to be read from
 * GitHub again on the next tick, forever.
 *
 * Asked of every range this branch has ever had. A merge record used to be
 * scoped to the current one, on the reasoning that a record from behind an
 * epoch boundary cites a policy and an intent a verifier no longer checks, so
 * answering from it would call a merge recorded while the live chain never
 * mentions it.
 *
 * What that produced instead is worse. The record does not stop existing when
 * the range moves, and the branch does not go back to the commit before it.
 * When the range on this repository moved to 152 on 5 August, fifty-nine merges
 * recorded below it read back as absent and the sweep wrote a second record for
 * each, at the head, saying the base had moved to a commit the branch left days
 * ago. The walk broke at the first one. A record for a commit is a fact about
 * git, and it reads as true from any range behind it, exactly the way a
 * movement record always did.
 *
 * Naming the record is not settling a write against it. What a caller does with
 * the answer is the caller's, and every caller here wants the same thing: stop,
 * because the chain already holds this.
 */
export async function recordCoveringCommit(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  sha: string,
): Promise<{ digest: string; attemptId: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT digest, attempt_id AS attemptId FROM queue_attestations
        WHERE github_repository_id = ? AND base_ref = ? AND transition_sequence IS NOT NULL
          AND json_extract(bytes, '$.after.baseSha') = ?
        ORDER BY transition_sequence ASC
        LIMIT 1`,
    )
    .bind(repositoryId, baseRef, sha)
    .first<{ digest: string; attemptId: string | null }>();
  return row === null ? null : { digest: row.digest, attemptId: row.attemptId };
}

/**
 * The signed merge intent that authorizes exactly this commit.
 *
 * A merge is recorded from the attempt that authorized it, and an attempt does
 * not last: it is terminated when its outcome is settled and compacted out of
 * the queue document some twenty entries later. The intent does last. It is
 * signed before the branch is written, stored by digest, and it names the base,
 * the head, the tree the queue verified, the pull request, the policy and the
 * evidence. Everything a transition record cites is in it.
 *
 * The match is the whole safeguard. An operator names a commit; this finds the
 * intent whose candidate tree is that commit's tree and whose candidate parents
 * are that commit's parents, in order. A commit the queue never authorized has
 * no such intent, so there is nothing for a record to be built from, and an
 * operator who names one gets a refusal rather than a record. Nothing here is
 * taken on the caller's word: both halves of the comparison come from
 * elsewhere, the tree and parents from GitHub and the authorization from bytes
 * the queue signed.
 *
 * `attemptId` narrows it. Two attempts on the same base and head produce
 * intents that authorize the same commit, and rather than pick one this
 * refuses and asks which.
 */
export interface AuthorizedMerge {
  readonly intentDigest: Sha256;
  readonly intent: MergeIntentV1;
}

/**
 * Why no single intent came back, in a form something other than a person can
 * act on.
 *
 * `refused` is the sentence, and it stays because it is what an operator reads.
 * Beside it is the reason as a code, because the three reasons want three
 * different remedies: nothing authorized this commit at all, two attempts
 * authorized it and one must be named, or two intents for one attempt disagree.
 * A caller that had to tell those apart by matching on the sentence would drift
 * away from this function the first time the wording improved.
 */
export interface AuthorizationRefusal {
  readonly refused: string;
  readonly code: "NO_INTENT" | "AMBIGUOUS_ATTEMPT" | "INTENTS_DISAGREE";
  /** The attempts that authorized this commit, where more than one did. */
  readonly attemptIds: readonly string[];
  /**
   * Every intent that pins this commit's tree on this commit's parents.
   *
   * Empty where nothing pinned it. Where two intents disagree the disagreement
   * is between these two documents and nothing else identifies them, so a
   * person asked to settle it has to be handed both digests to read.
   */
  readonly intentDigests: readonly string[];
}

export async function authorizationFor(
  db: D1Like,
  input: {
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly treeOid: string;
    readonly parentShas: readonly string[];
    readonly attemptId?: string;
  },
): Promise<AuthorizedMerge | AuthorizationRefusal> {
  const rows = await db
    .prepare(
      `SELECT digest, bytes FROM queue_attestations
        WHERE github_repository_id = ? AND base_ref = ? AND kind = 'merge-intent'
          AND json_extract(bytes, '$.git.candidateTreeOid') = ?
          AND (? IS NULL OR attempt_id = ?)
        ORDER BY created_at, digest`,
    )
    .bind(
      input.repositoryId,
      input.baseRef,
      input.treeOid,
      input.attemptId ?? null,
      input.attemptId ?? null,
    )
    .all<{ digest: string; bytes: string }>();

  const matched: AuthorizedMerge[] = [];
  for (const row of rows.results) {
    const parsed = parseMergeIntent(JSON.parse(row.bytes) as unknown);
    if (!parsed.ok) continue;
    const git = parsed.value.git;
    if (git.repositoryId !== input.repositoryId || git.baseRef !== input.baseRef) continue;
    if (git.candidateParentOids.length !== input.parentShas.length) continue;
    if (git.candidateParentOids.some((oid, at) => oid !== input.parentShas[at])) continue;
    matched.push({ intentDigest: row.digest as Sha256, intent: parsed.value });
  }

  if (matched.length === 0) {
    return {
      refused:
        "no signed merge intent authorizes this commit: the queue never pinned this tree on these parents",
      code: "NO_INTENT",
      attemptIds: [],
      intentDigests: [],
    };
  }
  const digests = matched.map((m) => m.intentDigest);
  const attempts = [...new Set(matched.map((m) => m.intent.attemptId))];
  if (attempts.length > 1) {
    return {
      refused: `more than one attempt authorizes this commit; name one of ${attempts.join(", ")}`,
      code: "AMBIGUOUS_ATTEMPT",
      attemptIds: attempts,
      intentDigests: digests,
    };
  }

  // One attempt can sign its intent more than once: a merge run that restarts
  // asks to be authorized again, and each call stamps a fresh `createdAt` and
  // rebuilds the candidate commit, so two rows authorize the same merge under
  // different digests. That is not an ambiguity about what was authorized, and
  // refusing it would leave a merge unrecordable for a reason that says nothing
  // about the merge. What would be an ambiguity is two intents that disagree
  // about anything the record repeats, so that is what is compared, and the
  // earliest of a set that agrees is cited: it is the authorization that was in
  // force when the merge was asked for.
  const first = matched[0]!;
  if (matched.some((m) => cited(m.intent) !== cited(first.intent))) {
    return {
      refused: "this commit's merge intents disagree about what they authorized",
      code: "INTENTS_DISAGREE",
      attemptIds: attempts,
      intentDigests: digests,
    };
  }
  return first;
}

/** Everything a transition record repeats from the intent it cites. */
function cited(intent: MergeIntentV1): string {
  return JSON.stringify([
    intent.kind,
    intent.attemptId,
    intent.pullRequestNumber,
    intent.mergeMethod,
    intent.policyDigest,
    intent.turnSequence,
    intent.git.baseSha,
    intent.git.headSha,
    intent.git.candidateTreeOid,
    intent.git.candidateParentOids,
    Object.entries(intent.evidence).sort(),
  ]);
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

/**
 * Every signed link in a branch's attested range, oldest first.
 *
 * Only records occupy a position in the chain, so intents are left out: they are
 * cited by the record that follows them and are fetched by digest when a reader
 * wants one.
 *
 * `fromSequence` is `attested_from_sequence`, which says where the chain a
 * verifier is asked to trust begins. Serving what came before it served records
 * whose signatures the verifier then skipped, so a walk could report nothing
 * wrong having checked almost nothing, and the early history of this repository
 * — a link with no record, a commit sha standing in for a digest, merges that
 * landed outside the lane — arrived as findings a reader had no way to act on.
 * Below the range the records are still stored, still signed and still fetched
 * by digest at `/v1/queue/records/:digest`. Starting an attested range is a
 * statement about what is claimed, and it takes nothing away.
 */
export async function readChain(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  fromSequence = 0,
): Promise<Array<{ digest: string; sequence: number; bytes: Uint8Array; jws: string }>> {
  const rows = await db
    .prepare(
      `SELECT digest, transition_sequence AS sequence, bytes, jws
         FROM queue_attestations
        WHERE github_repository_id = ? AND base_ref = ? AND transition_sequence IS NOT NULL
          AND transition_sequence >= ?
        ORDER BY transition_sequence, created_at`,
    )
    .bind(repositoryId, baseRef, fromSequence)
    .all<{ digest: string; sequence: number; bytes: string; jws: string }>();
  const encoder = new TextEncoder();
  return rows.results.map((r) => ({
    digest: r.digest,
    sequence: r.sequence,
    bytes: encoder.encode(r.bytes),
    jws: r.jws,
  }));
}
