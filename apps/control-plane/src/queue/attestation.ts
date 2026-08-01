import { parseMergeIntent, requiredSuitesDigest } from "@thwip/queue-protocol";
import type { GitSubject, MergeIntentV1, Sha256 } from "@thwip/queue-protocol";
import {
  buildMergeIntent,
  buildReusedProofRecord,
  buildTransitionRecord,
  signMergeIntent,
  signTransitionRecord,
} from "./evidence.js";
import type { Signer, SignedRecord } from "./evidence.js";
import { mergeCommitMessage, mergeCommitTitle } from "./merge-commit.js";
import type { MergeMethod } from "./merge-commit.js";
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
 * Gather what a reuse merge rests on, or say what is missing.
 *
 * Every value here is read from something that already happened. Where one
 * cannot be read the answer is what is absent, never a substitute: the whole
 * point of signing these records is that a reader can believe them, and a record
 * assembled around a stand-in is worth less than no record at all.
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
): Promise<ReuseEvidence | { missing: string }> {
  if (policy === null) return { missing: "the repository has no active policy" };
  if (policy.pipelineDigest === null) return { missing: "the active policy names no pipeline" };
  if (proofCheckRunId === null) {
    return { missing: "no passing proof check was found for this head" };
  }
  return {
    workReceiptDigest,
    organizationId: policy.organizationId,
    policyDigest: policy.policyDigest as Sha256,
    pipelineDigest: policy.pipelineDigest as Sha256,
    requiredSuitesDigest: await requiredSuitesDigest(policy.requiredSuites),
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
    // What the workflow is told to write, so the intent specifies the commit
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
 * The queue's own signed records, for a merge backed by an assignment, a
 * signed integration receipt, and a verifier result.
 *
 * This is the strongest of the four kinds, and until the assignment and
 * receipt paths existed there was nothing to fill these fields with — a
 * verified merge asserts three things happened, and a record built without
 * them would be signing a claim the queue cannot back.
 */

export interface VerifiedEvidence {
  readonly workReceiptDigest: Sha256;
  /** Tenant scope, threaded through so a signed record can be mirrored under it. */
  readonly organizationId: string;
  readonly policyDigest: Sha256;
  readonly assignmentDigest: Sha256;
  readonly integrationEvidenceDigest: Sha256;
  readonly verifierResultDigest: Sha256;
  /** The check run the candidate ran under. */
  readonly candidateCheckRunId: string;
  readonly actionRunId: string;
}

/**
 * Gather what a verified merge rests on, or say what is missing.
 *
 * Every digest here names something that actually happened: an assignment
 * issued to a runner, a receipt that runner signed back, and a result the
 * verifier produced. Any one of those absent means the record must not be
 * built — a refusal here is what keeps the record from claiming more than
 * the queue can show.
 */
export function verifiedEvidenceFor(input: {
  readonly workReceiptDigest: Sha256;
  readonly organizationId: string;
  readonly policyDigest: Sha256;
  readonly assignmentDigest: Sha256 | null;
  readonly integrationEvidenceDigest: Sha256 | null;
  readonly verifierResultDigest: Sha256 | null;
  readonly candidateCheckRunId: string;
  readonly actionRunId: string;
}): VerifiedEvidence | { missing: string } {
  if (input.assignmentDigest === null) return { missing: "no assignment was issued for this attempt" };
  if (input.integrationEvidenceDigest === null) {
    return { missing: "no integration receipt was signed for this attempt" };
  }
  if (input.verifierResultDigest === null) return { missing: "no verifier result was produced for this attempt" };
  return {
    workReceiptDigest: input.workReceiptDigest,
    organizationId: input.organizationId,
    policyDigest: input.policyDigest,
    assignmentDigest: input.assignmentDigest,
    integrationEvidenceDigest: input.integrationEvidenceDigest,
    verifierResultDigest: input.verifierResultDigest,
    candidateCheckRunId: input.candidateCheckRunId,
    actionRunId: input.actionRunId,
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
    // What the workflow is told to write, so the intent specifies the commit
    // rather than describing one after the fact.
    commitTitle: mergeCommitTitle(input.pullRequestNumber),
    commitMessage: mergeCommitMessage(input.operationId),
    createdAt: input.createdAt,
    evidence: {
      kind: "verified",
      workReceiptDigest: input.evidence.workReceiptDigest,
      assignmentDigest: input.evidence.assignmentDigest,
      integrationEvidenceDigest: input.evidence.integrationEvidenceDigest,
      verifierResultDigest: input.evidence.verifierResultDigest,
      candidateCheckRunId: input.evidence.candidateCheckRunId,
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
    verifierResultDigest: input.evidence.verifierResultDigest,
    checkRunId: input.evidence.candidateCheckRunId,
    actionRunId: input.evidence.actionRunId,
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
      const winner = await transitionRecordFor(db, row.attemptId);
      // The constraint only fires because a row for this attempt already holds a
      // position, so the record that won the race is there to be read back.
      if (winner === null) throw error;
      return { stored: false, digest: winner };
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
 */
export async function transitionRecordFor(db: D1Like, attemptId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT digest FROM queue_attestations
        WHERE attempt_id = ? AND transition_sequence IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .bind(attemptId)
    .first<{ digest: string }>();
  return row === null ? null : row.digest;
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

export async function authorizationFor(
  db: D1Like,
  input: {
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly treeOid: string;
    readonly parentShas: readonly string[];
    readonly attemptId?: string;
  },
): Promise<AuthorizedMerge | { refused: string }> {
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
    };
  }
  const attempts = [...new Set(matched.map((m) => m.intent.attemptId))];
  if (attempts.length > 1) {
    return { refused: `more than one attempt authorizes this commit; name one of ${attempts.join(", ")}` };
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
    return { refused: "this commit's merge intents disagree about what they authorized" };
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
 * Every signed link on a branch, oldest first.
 *
 * Only records occupy a position in the chain, so intents are left out: they are
 * cited by the record that follows them and are fetched by digest when a reader
 * wants one.
 */
export async function readChain(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<Array<{ digest: string; sequence: number; bytes: Uint8Array; jws: string }>> {
  const rows = await db
    .prepare(
      `SELECT digest, transition_sequence AS sequence, bytes, jws
         FROM queue_attestations
        WHERE github_repository_id = ? AND base_ref = ? AND transition_sequence IS NOT NULL
        ORDER BY transition_sequence, created_at`,
    )
    .bind(repositoryId, baseRef)
    .all<{ digest: string; sequence: number; bytes: string; jws: string }>();
  const encoder = new TextEncoder();
  return rows.results.map((r) => ({
    digest: r.digest,
    sequence: r.sequence,
    bytes: encoder.encode(r.bytes),
    jws: r.jws,
  }));
}
