import type { QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";
import { confirmOnly, recordOnly, type QueueSnapshot } from "./queue-operations.js";
import type { SnapshotQueueStore } from "./snapshot-store.js";
import type { QueueCommands } from "./commands.js";
import { proofBindingFrom, type ProofBinding } from "./work-receipt.js";
import {
  clearAttestationChainPosition,
  durableTransitionForAttempt,
  placeAttestationInChain,
  reuseEvidenceFor,
  signReusedRecord,
  signVerifiedRecord,
  recoverExactMergeRecord,
  storeAttestation,
  transitionRecordFor,
  verifiedEvidenceFor,
} from "./attestation.js";
import { mergeCommitText } from "./merge-commit.js";
import type { MergeIntent, MergeWriteOutcome } from "./merge-write.js";
import { requiredSuitesDigest, type Sha256, type TransitionRecordKind } from "@thwip/queue-protocol";
import { transitionKindOf, type TransitionKind } from "@thwip/queue-domain";
import {
  beginR2WriteIntent,
  putEvidence,
  type R2Like,
  type R2WriteIntentLease,
} from "./evidence-store.js";
import { acceptedReceiptFor } from "./assignment-store.js";
import { withTransitionSigningLease } from "./transition-signing-lease.js";
import { projectAuthoritativeQueue } from "./queue-projection.js";
import {
  acquireProjectWriteLease,
  repositoryAllowsExternalWrite,
  type ProjectWriteLease,
} from "../project-lifecycle.js";

/** How a caller runs commands against one queue document. */
export type OnQueue<TEnv> = <T>(
  env: TEnv,
  repositoryId: string,
  baseRef: string,
  decide: (parts: { store: SnapshotQueueStore; commands: QueueCommands }) => T | Promise<T>,
  lease?: ProjectWriteLease,
) => Promise<{ result: T; snapshot: QueueSnapshot }>;

/**
 * What the active policy requires of a candidate, and which workflow may say it
 * was met.
 *
 * One shape, read by the gate that authorizes a merge and by the record that
 * writes it down, so the two can never disagree about what the merge rested on.
 */
export interface ActivePolicy {
  projectId: string;
  policyDigest: string;
  /**
   * The pipeline the proof had to satisfy, which a reuse record binds. Null
   * when the bundle names none; a record then cannot be built rather than
   * being built around a substitute.
   */
  pipelineDigest: string | null;
  requiredSuites: readonly string[];
  securityProfile: string;
  /** Combined candidates touching one of these globs must be run again. */
  exclusivePaths?: readonly string[];
  /** Evidence keys are tenant-scoped so an export or deletion can be bounded. */
  organizationId: string;
  /** Null when no verifier is pinned, which only matters to a stronger profile. */
  verifier: { workflowRef: string; workflowSha: string | null } | null;
  /**
   * The activated document itself, which an assignment digests rather than
   * trusting a digest handed alongside it, plus what the pipeline pins. Only
   * the profiles that dispatch a run to a device read these.
   */
  document?: unknown;
  version?: number;
  daggerModuleDigest?: string | null;
  daggerEngineDigest?: string | null;
}

/**
 * What writing a merge and writing it down needs of GitHub and of the queue.
 *
 * Named once so the route deps and anything else that walks a turn to a merge
 * satisfy the same shape, rather than each call site listing the reads it
 * happens to remember.
 */
export interface MergeLaneDeps<TEnv extends QueueRouteEnv> {
  activePolicy(env: TEnv, repositoryId: string, baseRef?: string): Promise<ActivePolicy | null>;
  proofCheckRunId(env: TEnv, repositoryId: string, headSha: string): Promise<string | null>;
  /**
   * Whether the base branch already contains a commit, from git ancestry.
   *
   * Required here, not optional: a record that cannot be checked is a record
   * that does not get signed.
   */
  baseContainsSha(env: TEnv, repositoryId: string, baseRef: string, sha: string): Promise<boolean | null>;
  signRecordBytes(env: TEnv, bytes: Uint8Array, typ: string): Promise<string>;
  commitFacts(
    env: TEnv,
    repositoryId: string,
    sha: string,
  ): Promise<{ treeOid: string; parentShas: string[]; message?: string } | null>;
  /**
   * Perform the merge the queue just authorized, from the Worker.
   */
  mergeWrite(
    env: TEnv,
    repositoryId: string,
    intent: MergeIntent,
    lease?: ProjectWriteLease,
  ): Promise<MergeWriteOutcome>;
  /** Hold the project incarnation across the GitHub write and its signed record. */
  projectWriteLease?(
    env: TEnv,
    repositoryId: string,
    projectId?: string,
  ): Promise<{ projectId: string; renew(): Promise<void>; release(): Promise<void> } | null>;
  /** The backoff between reads that have to outlast GitHub's own lag. */
  sleep?(ms: number): Promise<void>;
}

/**
 * Ask git whether the branch contains the commit, until it says yes or the
 * backoff runs out.
 *
 * One read is not an answer here for the same reason one read is not an answer
 * in `confirmMergeAbsence`: GitHub's reads lag GitHub's own writes, and the
 * caller has just moved this branch itself. A stale comparison can therefore
 * say the branch does not contain a merge that has already landed.
 *
 * Only `true` proceeds. A read that never agrees records nothing, because a
 * record written on a read nobody could complete is the failure this guard
 * exists to prevent.
 */
const CONTAINS_ATTEMPTS = 3;
const CONTAINS_DELAYS_MS = [1000, 2000, 4000] as const;

async function baseContainsAfterOurOwnWrite(
  ask: () => Promise<boolean | null>,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean | null> {
  let last: boolean | null = null;
  for (let i = 0; i < CONTAINS_ATTEMPTS; i += 1) {
    if (i > 0) await sleep(CONTAINS_DELAYS_MS[Math.min(i - 1, CONTAINS_DELAYS_MS.length - 1)] ?? 1000);
    last = await ask();
    if (last === true) return true;
  }
  return last;
}

/**
 * Write evidence, reporting what happened rather than throwing.
 *
 * A bucket may be absent, and a storage failure must not lose a verdict the
 * verifier already produced: the queue's decision is authoritative from the
 * object, and the bucket exists so a reader can audit it afterwards.
 */
export async function storeEvidence(
  env: QueueRouteEnv,
  input: Parameters<typeof putEvidence>[1] & {
    readonly projectId: string;
    readonly writeLease?: ProjectWriteLease;
  },
): Promise<string> {
  if (env.EVIDENCE === undefined) return "no-bucket";
  const borrowed = input.writeLease !== undefined;
  const lease = input.writeLease ?? await acquireProjectWriteLease(
      env.DB as unknown as D1Like,
      input.repositoryId,
      input.projectId,
    );
  if (lease === null) return "project-unavailable";
  if (lease.projectId !== input.projectId) return "project-unavailable";
  const intentState: { lease: R2WriteIntentLease | null } = { lease: null };
  try {
    await lease.renew();
    const result = await putEvidence(env.EVIDENCE as unknown as R2Like, input, {
      beforePut: async (key) => {
        intentState.lease = await beginR2WriteIntent(env.DB as unknown as D1Like, {
          key,
          projectId: input.projectId,
          organizationId: input.organizationId,
          repositoryId: input.repositoryId,
        });
        if (intentState.lease === null) throw new Error("project became unavailable before R2");
      },
    });
    if (result.stored) {
      const current = await repositoryAllowsExternalWrite(
        env.DB as unknown as D1Like,
        input.repositoryId,
        input.projectId,
      );
      if (!current) {
        if (intentState.lease !== null) {
          await intentState.lease.compensate(env.EVIDENCE as unknown as R2Like);
          intentState.lease = null;
        } else await (env.EVIDENCE as unknown as R2Like).delete(result.key);
        return "project-unavailable";
      }
      await intentState.lease?.complete();
      intentState.lease = null;
      return result.deduplicated ? "already-stored" : "stored";
    }
    return result.reason;
  } catch (error) {
    if (intentState.lease !== null) {
      await intentState.lease.markCleanup().catch(() => {
        // The durable row remains for the global cleanup drainer. If ownership
        // was lost, its lease supplies the retry boundary.
      });
    }
    return `failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`;
  } finally {
    if (!borrowed) await lease.release();
  }
}

/**
 * What the proof on a head bound, for a caller holding only the sha.
 *
 * The commit is fetched again here rather than carried on the attempt, because
 * the attempt keeps the receipt's digest and the binding is inside the receipt.
 */
async function proofBindingForHead<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: {
    commitFacts(
      env: TEnv,
      repositoryId: string,
      sha: string,
    ): Promise<{ treeOid: string; parentShas: string[]; message?: string } | null>;
  },
  repositoryId: string,
  headSha: string,
): Promise<ProofBinding | null> {
  const head = await deps.commitFacts(env, repositoryId, headSha);
  return head?.message === undefined ? null : proofBindingFrom(head.message);
}

/**
 * Build, sign, store and record the transition for a merge that landed.
 *
 * The chain link is the digest of the record, so the record has to exist before
 * the link can. Where it cannot be built the link is not written: a missing link
 * is visible and can be retried, while a link naming a record nobody has is the
 * thing this replaces.
 */
export async function recordMergedTransition<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: MergeLaneDeps<TEnv>,
  input: {
    repositoryId: string;
    baseRef: string;
    attemptId: string;
    mergeSha: string;
    projectId?: string;
    mergeTree: string;
    parentShas: readonly string[];
    attempt: {
      baseSha: string | null;
      headSha: string | null;
      receiptDigest: string | null;
      intentDigest: string | null;
      verifierResultDigest: string | null;
    } | null;
    chainHead: { sequence: number; digest: string } | null;
    queueEpoch: number;
    turnSequence: number;
    pullRequestNumber: number | null;
    witnessPrincipalIds: readonly string[];
    onQueue: OnQueue<TEnv>;
    writeLease?: ProjectWriteLease;
  },
): Promise<{
  status: string;
  sequence: number | null;
  digest: string | null;
  detail?: string;
  snapshot: QueueSnapshot | null;
}> {
  const skip = (detail: string) => ({ status: "skipped", sequence: null, digest: null, detail, snapshot: null });

  // The record about to be built says the base branch became this commit. That
  // is a claim about a branch, and GitHub can be asked about it, and nothing
  // asked. A losing merge run can report the temporary merge GitHub computes
  // for an open pull request. It has the real merge's parents and tree, so local
  // consistency checks pass even though the commit is on no branch.
  //
  // Asked before the replay lookup, so a report naming a commit that is not on
  // the branch never takes the chain position that the correct report of the
  // same merge would then be deduplicated against.
  const onBase = await baseContainsAfterOurOwnWrite(
    () => deps.baseContainsSha(env, input.repositoryId, input.baseRef, input.mergeSha),
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  );
  if (onBase !== true) {
    return skip(
      onBase === false
        ? `${input.baseRef} does not contain ${input.mergeSha}, so no record may say it became that`
        : `${input.baseRef} could not be asked whether it contains ${input.mergeSha}`,
    );
  }

  const db = env.DB as unknown as D1Like;
  const signingOwner = `merge-callback:${input.attemptId}:${crypto.randomUUID()}`;
  const signing = await withTransitionSigningLease(
    db,
    {
      repositoryId: input.repositoryId,
      baseRef: input.baseRef,
      owner: signingOwner,
    },
    async (claim) => {

  await projectAuthoritativeQueue(db, input.repositoryId, input.baseRef, input.writeLease);
  if (!(await claim.fence())) {
    return skip("a later signed transition writer replaced this callback while it restored queue authority");
  }

  if (input.pullRequestNumber !== null) {
    const exact = await recoverExactMergeRecord(db, {
      repositoryId: input.repositoryId,
      baseRef: input.baseRef,
      pullRequestNumber: input.pullRequestNumber,
      mergeSha: input.mergeSha,
      projectId: input.writeLease?.projectId,
    });
    if (exact?.status === "linked") {
      return {
        status: "duplicate",
        sequence: exact.transitionSequence,
        digest: exact.digest,
        snapshot: null,
      };
    }
  }

  // One merge, one signed record. The domain layer already deduplicates the
  // transition itself by attempt id, but signing used to run again on every
  // call regardless: a fresh `observedAt` made a fresh digest every time, so
  // two racing reports of the same merge each got their own signed record and
  // the chain carried two links claiming one position. Checked first, before
  // anything is built or signed, so a second report of a merge this attempt
  // already produced is idempotent all the way through rather than only at
  // the transition.
  const existingDigest = await transitionRecordFor(db, input.repositoryId, input.baseRef, input.attemptId);
  const existingLink = await durableTransitionForAttempt(db, {
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    attemptId: input.attemptId,
    mergeSha: input.mergeSha,
    projectId: input.writeLease?.projectId,
  });
  if (existingLink !== null) {
    const placed = await placeAttestationInChain(db, {
      digest: existingLink.digest,
      repositoryId: input.repositoryId,
      baseRef: input.baseRef,
      attemptId: input.attemptId,
      transitionSequence: existingLink.transitionSequence,
      projectId: input.writeLease?.projectId,
    });
    return placed
      ? {
          status: "duplicate",
          sequence: existingLink.transitionSequence,
          digest: existingLink.digest,
          snapshot: null,
        }
      : skip("the queue link exists but its signed record could not be placed in the public chain");
  }
  if (existingDigest !== null) {
    // Old builds stored a positioned row before asking the queue for the link.
    // The full durable transition index says no link exists, so that position
    // is a stale claim, not a successful replay.
    await clearAttestationChainPosition(db, existingDigest, input.writeLease?.projectId);
  }

  const attempt = input.attempt;
  if (attempt?.headSha == null || attempt.baseSha == null || attempt.receiptDigest == null) {
    return skip("the attempt no longer holds what the record would cite");
  }
  if (attempt.intentDigest == null) return skip("no signed merge intent to cite");
  if (input.pullRequestNumber === null) return skip("the merged entry could not be found");

  // What the device did, read from storage rather than inferred from the queue
  // document. Its presence is what makes this a verified merge: an assignment
  // this queue issued and a receipt the device signed for the tree that landed.
  const localRun = await acceptedReceiptFor(db, input.attemptId);
  const activePolicy = await deps.activePolicy(env, input.repositoryId, input.baseRef);
  const evidence =
    localRun === null || activePolicy === null
      ? await reuseEvidenceFor(
          attempt.receiptDigest as Sha256,
          activePolicy,
          await deps.proofCheckRunId(env, input.repositoryId, attempt.headSha),
          // Present exactly when the queue had the integrated candidate run, which is
          // what decides whether the record claims a candidate-verified merge or a reuse.
          attempt.verifierResultDigest,
          // The same comparison the authorize gate made, made again from the
          // head this record is about. A policy activated between the two
          // leaves the merge landed and unrecorded rather than recorded under a
          // binding the proof never carried.
          await proofBindingForHead(env, deps, input.repositoryId, attempt.headSha),
        )
      : verifiedEvidenceFor({
          workReceiptDigest: attempt.receiptDigest as Sha256,
          organizationId: activePolicy.organizationId,
          policyDigest: activePolicy.policyDigest as Sha256,
          pipelineDigest: activePolicy.pipelineDigest as Sha256 | null,
          requiredSuitesDigest: await requiredSuitesDigest(activePolicy.requiredSuites),
          assignmentDigest: localRun.assignmentDigest as Sha256,
          integrationEvidenceDigest: localRun.receiptDigest as Sha256,
          deviceKeyId: localRun.deviceKeyId,
          rerun: null,
        });
  if ("missing" in evidence) return skip(evidence.missing);
  if (activePolicy === null) return skip("no active project policy owns this merge record");
  const verifiedMerge = "assignmentDigest" in evidence;

  // The tree the branch had before this merge. A transition that is not the
  // first in its epoch has to say where it started from, and only the commit
  // itself can say that.
  const before = await deps.commitFacts(env, input.repositoryId, attempt.baseSha);

  const recordSubject = {
    attemptId: input.attemptId,
    mergeMethod: "merge" as const,
    git: {
      objectFormat: "sha1" as const,
      repositoryId: input.repositoryId,
      baseRef: input.baseRef as `refs/heads/${string}`,
      baseSha: attempt.baseSha,
      headRepositoryId: input.repositoryId,
      headSha: attempt.headSha,
      candidateSha: input.mergeSha,
      candidateTreeOid: input.mergeTree,
      candidateParentOids: [...input.parentShas],
    },
    position: {
      queueEpoch: input.queueEpoch,
      turnSequence: input.turnSequence,
      transitionSequence: (input.chainHead?.sequence ?? 0) + 1,
      previousTransitionDigest: (input.chainHead?.digest ?? null) as Sha256 | null,
    },
    pullRequestNumber: input.pullRequestNumber,
    mergeIntentDigest: attempt.intentDigest as Sha256,
    before: { baseSha: attempt.baseSha, treeOid: before?.treeOid ?? null },
    final: { sha: input.mergeSha, treeOid: input.mergeTree, parentShas: input.parentShas },
    observedAt: new Date().toISOString(),
    signer: { sign: (bytes: Uint8Array, typ: string) => deps.signRecordBytes(env, bytes, typ) },
  };
  const recordKind: TransitionRecordKind = verifiedMerge
    ? "verified-merge"
    : "verifierResultDigest" in evidence && evidence.verifierResultDigest !== undefined
      ? "candidate-verified-merge"
      : "reused-proof-merge";
  const expectedSequence = recordSubject.position.transitionSequence;
  const expectedPrior = recordSubject.position.previousTransitionDigest;
  if (!(await claim.fence())) {
    return skip("a later signed transition writer replaced this callback before it could recover staged bytes");
  }
  const reusable = await recoverExactMergeRecord(db, {
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    pullRequestNumber: input.pullRequestNumber,
    mergeSha: input.mergeSha,
    projectId: input.writeLease?.projectId,
    staged: {
      pullRequestNumber: input.pullRequestNumber,
      mergeTree: input.mergeTree,
      parentShas: input.parentShas,
      beforeBaseSha: attempt.baseSha,
      beforeTree: before?.treeOid ?? null,
      queueEpoch: input.queueEpoch,
      transitionSequence: expectedSequence,
      priorDigest: expectedPrior,
    },
  });
  if (reusable?.status === "linked") {
    return {
      status: "duplicate",
      sequence: reusable.transitionSequence,
      digest: reusable.digest,
      snapshot: null,
    };
  }
  let recordDigest = reusable?.digest ?? null;
  let recordAttemptId = reusable?.status === "staged" ? reusable.attemptId : input.attemptId;
  let linkingRecordKind = reusable?.status === "staged" ? reusable.recordKind : recordKind;
  if (recordDigest === null) {
    if (!(await claim.fence())) {
      return skip("a later signed transition writer replaced this callback before it could sign");
    }
    const signed =
      "assignmentDigest" in evidence
        ? await signVerifiedRecord({ ...recordSubject, evidence })
        : await signReusedRecord({ ...recordSubject, evidence });
    if ("error" in signed) return skip(`the queue refused to sign its own record: ${signed.error}`);
    if (!(await claim.fence())) {
      return skip("a later signed transition writer replaced this callback while it was signing");
    }

    // Stored before the link is written, so a link never names a record that
    // cannot be read back.
    recordDigest = signed.digest;
    recordAttemptId = input.attemptId;
    linkingRecordKind = recordKind;
    await storeAttestation(db, {
      digest: signed.digest,
      kind: recordKind,
      repositoryId: input.repositoryId,
      projectId: input.writeLease?.projectId ?? activePolicy.projectId,
      baseRef: input.baseRef,
      transitionSequence: null,
      attemptId: input.attemptId,
      bytes: signed.bytes,
      jws: signed.jws,
      organizationId: evidence.organizationId,
      mirror: (mirrored) =>
        storeEvidence(env, {
          projectId: activePolicy.projectId,
          ...(input.writeLease === undefined ? {} : { writeLease: input.writeLease }),
          organizationId: mirrored.organizationId,
          repositoryId: mirrored.repositoryId,
          kind: mirrored.kind,
          digest: mirrored.digest as `sha256:${string}`,
          bytes: mirrored.bytes,
        }).then(() => undefined),
    });
  }
  if (!(await claim.fence())) {
    return skip("a later signed transition writer replaced this callback before it could link its record");
  }
  const { result, snapshot } = await input.onQueue(env, input.repositoryId, input.baseRef, ({ commands, store }) => {
    if (!store.holdsTransitionSigning(signingOwner, new Date().toISOString())) {
      return { moved: true as const };
    }
    const tail = store.state().transitions.at(-1);
    if ((tail?.transitionSequence ?? 0) + 1 !== expectedSequence || (tail?.digest ?? null) !== expectedPrior) {
      return { moved: true as const };
    }
    return {
      moved: false as const,
      transition: commands.recordTransition({
        idempotencyKey: `transition:${recordAttemptId}`,
        kind: transitionKindOf(linkingRecordKind),
        transitionSequence: expectedSequence,
        priorDigest: expectedPrior,
        digest: recordDigest,
        baseSha: input.mergeSha,
        attemptId: recordAttemptId === input.attemptId ? input.attemptId : null,
        witnessPrincipalIds: input.witnessPrincipalIds,
      }),
    };
  }, input.writeLease);
  const linked = await recoverExactMergeRecord(db, {
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    pullRequestNumber: input.pullRequestNumber,
    mergeSha: input.mergeSha,
    projectId: input.writeLease?.projectId,
  });
  if (linked?.status !== "linked") {
    return skip(
      result.moved
        ? "the chain moved while the transition record was being signed"
        : result.transition.status === "rejected"
        ? `the queue refused the transition: ${result.transition.detail}`
        : "the transition command did not create the signed queue link",
    );
  }
  return {
    status: result.moved || linked.digest !== recordDigest ? "duplicate" : result.transition.status,
    sequence: linked.transitionSequence,
    digest: linked.digest,
    snapshot,
  };
    },
    input.writeLease,
  );
  return signing.acquired
    ? signing.result
    : skip("another signed transition writer owns this branch; the heartbeat will retry this record");
}

/**
 * The three things a caller does with a lane once the queue has authorized a
 * merge: write it, write it down, or hand it back.
 *
 * Built from the deps the App drive path already holds, so every internal wake
 * uses the same confirmation and recording logic.
 */
export function mergeLaneFor<TEnv extends QueueRouteEnv>(
  deps: MergeLaneDeps<TEnv>,
  onQueue: OnQueue<TEnv>,
) {
/**
 * Record a merge the queue authorized and that has landed.
 *
 * The record that becomes the chain link binds the tree that actually landed,
 * so confirmation happens before recording.
 */
  const recordLandedMerge = async (
    env: TEnv,
    input: {
      repositoryId: string;
      baseRef: string;
      attemptId: string;
      operationId: string;
      mergeSha: string;
      witnessPrincipalIds: readonly string[];
      writeLease?: ProjectWriteLease;
    },
  ): Promise<
    | { readonly ok: false; readonly code: "MERGE_UNREADABLE" | "RESULT_NOT_AUTHORIZED"; readonly detail: string }
    | {
        readonly ok: true;
        readonly confirmed: string;
        readonly transition: string;
        readonly sequence: number | null;
        readonly digest: string | null;
        readonly detail: string | null;
        readonly snapshot: QueueSnapshot;
      }
  > => {
  // What the commit carries, read from GitHub. The caller names the commit and
  // the queue reads it, so a record never repeats a figure it was handed.
  const landed = await deps.commitFacts(env, input.repositoryId, input.mergeSha);
  if (landed === null) {
    return { ok: false, code: "MERGE_UNREADABLE", detail: "could not read that commit" };
  }

  const { result: confirmation, snapshot: afterConfirm } = await onQueue(
    env,
    input.repositoryId,
    input.baseRef,
    async ({ commands, store }) =>
      confirmOnly(commands, store, {
        attemptId: input.attemptId,
        operationId: input.operationId,
        mergeSha: input.mergeSha,
        mergeTree: landed.treeOid,
        parentShas: landed.parentShas,
      }),
    input.writeLease,
  );

  if (confirmation.confirmed.status === "rejected") {
    // The reducer refuses a tree that is not the candidate it authorized, so a
    // rejection here means something other than the verified integration landed.
    return { ok: false, code: "RESULT_NOT_AUTHORIZED", detail: confirmation.confirmed.detail };
  }

  const recorded = await recordMergedTransition(env, deps, {
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    attemptId: input.attemptId,
    mergeSha: input.mergeSha,
    mergeTree: landed.treeOid,
    parentShas: landed.parentShas,
    attempt: confirmation.attempt,
    chainHead: confirmation.chainHead,
    queueEpoch: afterConfirm.queueEpoch,
    turnSequence: afterConfirm.turnSequence,
    pullRequestNumber:
      afterConfirm.entries.find((e) => e.entryId === confirmation.attempt?.entryId)?.pullRequestNumber ?? null,
    witnessPrincipalIds: [...input.witnessPrincipalIds],
    onQueue,
    ...(input.writeLease === undefined ? {} : { writeLease: input.writeLease }),
  });

  return {
    ok: true,
    confirmed: confirmation.confirmed.status,
    transition: recorded.status,
    sequence: recorded.sequence,
    digest: recorded.digest,
    detail: recorded.detail ?? null,
    snapshot: recorded.snapshot ?? afterConfirm,
  };
  };

/**
 * Free the lane for an attempt whose merge did not happen.
 *
 * An outcome already in doubt has to be declared unknown before it can be
 * resolved, which is the reducer refusing to skip reconciliation.
 */
  const resolveNotMerged = async (
    env: TEnv,
    input: { repositoryId: string; baseRef: string; attemptId: string; operationId: string },
  ): Promise<{ status: string; snapshot: QueueSnapshot }> => {
  const { result, snapshot } = await onQueue(
    env,
    input.repositoryId,
    input.baseRef,
    async ({ commands }) => {
      commands.mergeOutcomeUnknown({
        idempotencyKey: `not-merged:unknown:${input.attemptId}`,
        attemptId: input.attemptId,
      });
      return await commands.confirmNotMerged({
        idempotencyKey: `not-merged:${input.attemptId}`,
        attemptId: input.attemptId,
        operationId: input.operationId,
      });
    },
  );
  return { status: result.status, snapshot };
  };

  /**
   * Write the merge, then say what became of it.
   *
   * Every write outcome is handled here from the same reads, because GitHub's
   * reads lag its own writes and a refusal from our own call says what the call
   * did rather than what became of the pull request.
   */
  const performMergeFromWorker = async (
    env: TEnv,
    input: {
      repositoryId: string;
      baseRef: string;
      attemptId: string;
      operationId: string;
      pullRequestNumber: number;
      merge: { baseSha: string; headSha: string; treeOid: string; parentShas: string[] };
      projectId?: string;
    },
  ): Promise<Record<string, unknown>> => {
    const lease = deps.projectWriteLease === undefined
      ? { projectId: input.projectId ?? "", renew: async () => {}, release: async () => {} }
      : await deps.projectWriteLease(env, input.repositoryId, input.projectId);
    if (lease === null) {
      return { merged: false, recorded: false, reason: "PROJECT_UNAVAILABLE" };
    }
    try {
    const markUnrecorded = async (detail: string): Promise<void> => {
      await lease.renew();
      const now = new Date().toISOString();
      await onQueue(env, input.repositoryId, input.baseRef, ({ store }) =>
        store.refuseMergeOperation(input.operationId, detail, now, () => now),
        lease,
      );
      console.error(
        `[queue merge] ${input.operationId} landed without a signed transition: ${detail}`,
      );
    };

    await lease.renew();
    if (!(await repositoryAllowsExternalWrite(
      env.DB as unknown as D1Like,
      input.repositoryId,
      lease.projectId,
    ))) {
      return { merged: false, recorded: false, reason: "PROJECT_RELEASE_REQUESTED" };
    }
    const outcome = await deps.mergeWrite(env, input.repositoryId, {
      baseRef: input.baseRef,
      pullRequestNumber: input.pullRequestNumber,
      baseSha: input.merge.baseSha,
      headSha: input.merge.headSha,
      treeOid: input.merge.treeOid,
      parentShas: input.merge.parentShas,
      message: mergeCommitText(input.pullRequestNumber, input.operationId),
    }, lease);

    if (outcome.kind === "merged" && outcome.mergeSha !== null) {
      let recorded: Awaited<ReturnType<typeof recordLandedMerge>>;
      try {
        await lease.renew();
        recorded = await recordLandedMerge(env, {
          repositoryId: input.repositoryId,
          baseRef: input.baseRef,
          attemptId: input.attemptId,
          operationId: input.operationId,
          mergeSha: outcome.mergeSha,
          witnessPrincipalIds: [],
          writeLease: lease,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = `transition recording threw after the merge landed: ${message}`.slice(0, 1_000);
        await markUnrecorded(detail);
        return { merged: true, recorded: false, reason: "TRANSITION_RECORDING_FAILED", detail };
      }
      if (!recorded.ok) {
        await markUnrecorded(`${recorded.code}: ${recorded.detail}`);
        return { merged: true, recorded: false, reason: recorded.code, detail: recorded.detail };
      }
      const transitionRecorded =
        recorded.digest !== null && (recorded.transition === "applied" || recorded.transition === "duplicate");
      if (!transitionRecorded) {
        const detail =
          recorded.detail ??
          `transition ${recorded.transition}${recorded.digest === null ? " has no signed record" : " was not applied"}`;
        await markUnrecorded(detail);
      }
      return {
        merged: true,
        // A signed row and an applied queue link are both required. Reporting
        // either one alone as complete is how a merge with no public transition
        // became a successful App write.
        recorded: transitionRecorded,
        transition: recorded.transition,
        transitionDigest: recorded.digest,
        detail: recorded.detail,
      };
    }

    if (outcome.kind === "merged") {
      // Git settled it and the branch would not name the commit, which is the
      // one case where guessing writes a false record.
      const { snapshot } = await onQueue(env, input.repositoryId, input.baseRef, ({ commands }) =>
        commands.mergeOutcomeUnknown({
          idempotencyKey: `worker-merge:unknown:${input.attemptId}`,
          attemptId: input.attemptId,
          detail: "Git settled the merge but did not return a commit sha",
        }),
        lease,
      );
      return { merged: true, recorded: false, reason: "MERGE_UNNAMED" };
    }

    if (outcome.kind === "base-moved" || outcome.kind === "not-merged" || outcome.kind === "refused") {
      // The queue authorized a merge that is not going to happen, so it hears
      // that here. Otherwise the lane stays held until its deadline and every
      // pull request behind this one waits on a merge nobody is going to make.
      const { result: resolved } = await onQueue(env, input.repositoryId, input.baseRef, async ({ commands }) => {
        commands.mergeOutcomeUnknown({
          idempotencyKey: `not-merged:unknown:${input.attemptId}`,
          attemptId: input.attemptId,
        });
        return commands.confirmNotMerged({
          idempotencyKey: `not-merged:${input.attemptId}`,
          attemptId: input.attemptId,
          operationId: input.operationId,
        });
      }, lease);
      return {
        merged: false,
        reason: outcome.kind === "base-moved" ? "BASE_MOVED" : "MERGE_REFUSED",
        detail: outcome.detail,
        resolved: resolved.status,
      };
    }

    // Unknown is never reported as a refusal. Reconciliation reads for itself
    // and can still end in a confirmed merge with a record behind it.
    const { snapshot } = await onQueue(env, input.repositoryId, input.baseRef, ({ commands }) =>
      commands.mergeOutcomeUnknown({
        idempotencyKey: `worker-merge:unknown:${input.attemptId}`,
        attemptId: input.attemptId,
        detail: outcome.detail,
      }),
      lease,
    );
      return { merged: false, reason: "MERGE_OUTCOME_UNKNOWN", detail: outcome.detail };
    } finally {
      await lease.release();
    }
  };

  return { recordLandedMerge, resolveNotMerged, performMergeFromWorker };
}
