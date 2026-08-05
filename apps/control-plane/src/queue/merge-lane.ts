import type { QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";
import { confirmOnly, recordOnly, type QueueSnapshot } from "./queue-operations.js";
import type { SnapshotQueueStore } from "./snapshot-store.js";
import type { QueueCommands } from "./commands.js";
import { requiresDeviceOnly } from "./runners.js";
import { proofBindingFrom, type ProofBinding } from "./work-receipt.js";
import {
  readAttestation,
  reuseEvidenceFor,
  signReusedRecord,
  signVerifiedRecord,
  storeAttestation,
  transitionRecordFor,
  verifiedEvidenceFor,
} from "./attestation.js";
import {
  DEFAULT_MERGE_METHOD,
  mergeCommitMessage,
  mergeCommitTitle,
  type MergeMethod,
} from "./merge-commit.js";
import type { MergeIntent, MergeWriteOutcome, MergeWriter } from "./merge-write.js";
import {
  TRANSITION_KINDS as RECORD_KINDS,
  requiredSuitesDigest,
  type Sha256,
  type TransitionRecordKind,
} from "@thwip/queue-protocol";
import { transitionKindOf, type TransitionKind } from "@thwip/queue-domain";
import { putEvidence, type R2Like } from "./evidence-store.js";
import { acceptedReceiptFor } from "./assignment-store.js";

/** How a caller runs commands against one queue document. */
export type OnQueue<TEnv> = <T>(
  env: TEnv,
  repositoryId: string,
  baseRef: string,
  decide: (parts: { store: SnapshotQueueStore; commands: QueueCommands }) => T | Promise<T>,
) => Promise<{ result: T; snapshot: QueueSnapshot }>;

/**
 * What the active policy requires of a candidate, and which workflow may say it
 * was met.
 *
 * One shape, read by the gate that authorizes a merge and by the record that
 * writes it down, so the two can never disagree about what the merge rested on.
 */
export interface ActivePolicy {
  policyDigest: string;
  /**
   * The pipeline the proof had to satisfy, which a reuse record binds. Null
   * when the bundle names none; a record then cannot be built rather than
   * being built around a substitute.
   */
  pipelineDigest: string | null;
  requiredSuites: readonly string[];
  securityProfile: string;
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
  activePolicy(env: TEnv, repositoryId: string): Promise<ActivePolicy | null>;
  /**
   * The merge method the record must bind, and who performs the write. Both
   * read from the row rather than assumed: a record that claims "merge" for a
   * squash fails its own shape check, and two writers racing for one turn is
   * how a merge that landed gets reported as a base that moved.
   */
  queueProject(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
  ): Promise<{ mergeMethod: MergeMethod; mergeWriter?: MergeWriter } | null>;
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
  /** Ask GitHub to run the merge workflow for a pull request the queue has offered. */
  driveTurn(env: TEnv, repositoryId: string, pullRequestNumber: number): Promise<void>;
  /**
   * Perform the merge the queue just authorized, from the Worker.
   *
   * Optional, because a deployment that cannot reach GitHub with the App's own
   * credential has no way to do it and must go on letting the workflow write.
   */
  mergeWrite?(env: TEnv, repositoryId: string, intent: MergeIntent): Promise<MergeWriteOutcome>;
  /** The backoff between reads that have to outlast GitHub's own lag. */
  sleep?(ms: number): Promise<void>;
}

/**
 * Ask git whether the branch contains the commit, until it says yes or the
 * backoff runs out.
 *
 * One read is not an answer here for the same reason one read is not an answer
 * in `confirmMergeAbsence`: GitHub's reads lag GitHub's own writes, and the
 * caller has just moved this branch itself. Pull request 183 merged on 4 August
 * 2026, the queue confirmed the merge from the commit, and the comparison that
 * gates the record answered that the branch did not contain it. No record was
 * written for a merge that had already landed.
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
  input: Parameters<typeof putEvidence>[1],
): Promise<string> {
  if (env.EVIDENCE === undefined) return "no-bucket";
  try {
    const result = await putEvidence(env.EVIDENCE as unknown as R2Like, input);
    if (result.stored) return result.deduplicated ? "already-stored" : "stored";
    return result.reason;
  } catch (error) {
    return `failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`;
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
/**
 * What kind of transition a stored record is, read from the record itself.
 *
 * Null where the row is missing, or carries a kind this build does not know.
 * Both used to answer "reused", so an unreadable record and a record kind added
 * after this code was written both went into the chain claiming the merge rested
 * on the head's own proof. That claim is exactly what a reader auditing the
 * chain relies on, and it was the one thing nobody was checking.
 */
function storedTransitionKind(kind: string | undefined): TransitionKind | null {
  if (kind === undefined) return null;
  return (RECORD_KINDS as readonly string[]).includes(kind)
    ? transitionKindOf(kind as TransitionRecordKind)
    : null;
}

export async function recordMergedTransition<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: MergeLaneDeps<TEnv>,
  input: {
    repositoryId: string;
    baseRef: string;
    attemptId: string;
    mergeSha: string;
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
    onQueue: <T>(
      env: TEnv,
      repositoryId: string,
      baseRef: string,
      decide: (parts: { store: SnapshotQueueStore; commands: QueueCommands }) => T,
    ) => Promise<{ result: T; snapshot: QueueSnapshot }>;
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
  // asked. Pull request 107's losing merge run reported the test merge GitHub
  // computes for an open pull request; it has the real merge's parents and the
  // real merge's tree, so every consistency check the queue had passed it, and
  // chain record 54 says main became a commit that is an ancestor of nothing.
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

  // One merge, one signed record. The domain layer already deduplicates the
  // transition itself by attempt id, but signing used to run again on every
  // call regardless: a fresh `observedAt` made a fresh digest every time, so
  // two racing reports of the same merge each got their own signed record and
  // the chain carried two links claiming one position. Checked first, before
  // anything is built or signed, so a second report of a merge this attempt
  // already produced is idempotent all the way through rather than only at
  // the transition.
  const db = env.DB as unknown as D1Like;
  const existingDigest = await transitionRecordFor(db, input.repositoryId, input.baseRef, input.attemptId);
  if (existingDigest !== null) {
    // Read back what was actually stored: a plain replay stored a
    // "reused-proof-merge" record, but a process that died between storing
    // the record and recording the transition on a first report leaves a
    // "candidate-verified-merge" record here too, and hardcoding "reused"
    // would misreport that merge as a reuse forever.
    const existing = await readAttestation(db, existingDigest);
    const existingKind = storedTransitionKind(existing?.kind);
    if (existingKind === null) {
      return skip(`the stored record for this merge does not say what kind it is: ${existingDigest}`);
    }
    const { result, snapshot } = await input.onQueue(env, input.repositoryId, input.baseRef, ({ commands, store }) =>
      recordOnly(commands, store, {
        attemptId: input.attemptId,
        // Ignored on replay: the domain layer's idempotency key is keyed on
        // attempt id alone, so this call can only ever return the transition
        // this attempt already recorded.
        kind: existingKind,
        digest: existingDigest,
        baseSha: input.mergeSha,
        witnessPrincipalIds: input.witnessPrincipalIds,
      }),
    );
    return { status: result.transition.status, sequence: result.sequence, digest: existingDigest, snapshot };
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
  const activePolicy = await deps.activePolicy(env, input.repositoryId);
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
  const verifiedMerge = "assignmentDigest" in evidence;

  // The tree the branch had before this merge. A transition that is not the
  // first in its epoch has to say where it started from, and only the commit
  // itself can say that.
  const before = await deps.commitFacts(env, input.repositoryId, attempt.baseSha);

  // The same method the workflow was told to merge with, read from the same
  // row rather than assumed. A record that claims "merge" for a squash landing
  // fails its own two-parent shape check and never reaches the chain — that is
  // the bug this binds shut.
  const project = await deps.queueProject(env, input.repositoryId, input.baseRef);
  const mergeMethod = project?.mergeMethod ?? DEFAULT_MERGE_METHOD;

  const recordSubject = {
    attemptId: input.attemptId,
    mergeMethod,
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
  const signed =
    "assignmentDigest" in evidence
      ? await signVerifiedRecord({ ...recordSubject, evidence })
      : await signReusedRecord({ ...recordSubject, evidence });
  if ("error" in signed) return skip(`the queue refused to sign its own record: ${signed.error}`);

  // Stored before the link is written, so a link never names a record that
  // cannot be read back.
  const recordKind: TransitionRecordKind = verifiedMerge
    ? "verified-merge"
    : "verifierResultDigest" in evidence && evidence.verifierResultDigest !== undefined
      ? "candidate-verified-merge"
      : "reused-proof-merge";
  const stored = await storeAttestation(db, {
    digest: signed.digest,
    kind: recordKind,
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    transitionSequence: (input.chainHead?.sequence ?? 0) + 1,
    attemptId: input.attemptId,
    bytes: signed.bytes,
    jws: signed.jws,
    organizationId: evidence.organizationId,
    mirror: (input) =>
      storeEvidence(env, {
        organizationId: input.organizationId,
        repositoryId: input.repositoryId,
        kind: input.kind,
        digest: input.digest as `sha256:${string}`,
        bytes: input.bytes,
      }).then(() => undefined),
  });

  // Lost a simultaneous race with another report of the same merge: the
  // index refused this attempt a second chain position. The record that won
  // is already stored and is what the transition has to cite — this call's
  // own signed bytes never occupy a link and are not persisted.
  let digest = signed.digest;
  let kind = transitionKindOf(recordKind);
  if (!stored.stored) {
    digest = stored.digest as Sha256;
    const winner = await readAttestation(db, stored.digest);
    const winnerKind = storedTransitionKind(winner?.kind);
    if (winnerKind === null) {
      return skip(`the record that won this chain position does not say what kind it is: ${stored.digest}`);
    }
    kind = winnerKind;
  }

  const { result, snapshot } = await input.onQueue(env, input.repositoryId, input.baseRef, ({ commands, store }) =>
    recordOnly(commands, store, {
      attemptId: input.attemptId,
      kind,
      digest,
      baseSha: input.mergeSha,
      witnessPrincipalIds: input.witnessPrincipalIds,
    }),
  );
  return { status: result.transition.status, sequence: result.sequence, digest, snapshot };
}

/**
 * Why a lane was, or was not, driven through Actions.
 *
 * `nudge` reports these to its caller as a reason code; every other caller of
 * `driveLane` fires and forgets, so it can ignore the return value entirely.
 */
export type DriveLaneOutcome =
  | { readonly dispatched: false; readonly reason: "LANE_IDLE" }
  | { readonly dispatched: false; readonly reason: "APP_WRITES"; readonly pullRequestNumber: number }
  | { readonly dispatched: false; readonly reason: "DEVICE_ONLY"; readonly pullRequestNumber: number }
  | { readonly dispatched: false; readonly reason: "DISPATCH_FAILED"; readonly pullRequestNumber: number }
  | { readonly dispatched: false; readonly reason: "ALREADY_RUNNING"; readonly pullRequestNumber: number }
  | { readonly dispatched: true; readonly pullRequestNumber: number };

export async function driveLane<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: Pick<MergeLaneDeps<TEnv>, "driveTurn" | "activePolicy" | "queueProject">,
  repositoryId: string,
  baseRef: string,
  snapshot: QueueSnapshot,
  /**
   * The pull request whose own run is making this call, when one is.
   *
   * `/authorize` drives after it walks, because the walk can hand the lane to a
   * different pull request and nothing else would tell that one. The caller is
   * a run already executing for its own turn, so a dispatch back to it starts a
   * second run for work in flight, and `thwip-merge.yml` serialises on one
   * group per queue, so the second cancels the first. The cancelled one is the
   * run that would have written the merge.
   *
   * That ran 100 times in 35 minutes on 5 August 2026, one dispatch every
   * twenty seconds, and nothing merged for as long as it lasted.
   */
  options: { readonly exceptPullRequestNumber?: number } = {},
): Promise<DriveLaneOutcome> {
  const running = snapshot.entries.find((e) => e.state === "Offered" || e.state === "Active");
  // Under a device-only profile the run is over by the time the merge has to be
  // written, and writing it is still Actions' job.
  const ran = snapshot.entries.find((e) => e.state === "Verifying" || e.state === "MergeGuard");
  if (running === undefined && ran === undefined) return { dispatched: false, reason: "LANE_IDLE" };

  // The security profile is a repository-wide setting, not a per-entry one,
  // so one lookup answers for whichever entry holds the lane. `fresh` and
  // `audited` have no fallback to GitHub Actions for the run itself: the offer
  // is only ever claimed by a connected device, over the heartbeat response, so
  // dispatching while that device still holds the turn would spend an Actions
  // run to be told there is nothing for it to do. Once the device's receipt has
  // been accepted there is something to do, and it is dispatched then.
  //
  // This is the one place `driveTurn` is ever called. Every caller that wants
  // to drive a lane goes through here, so this predicate cannot be forgotten
  // at a call site the way it was at `/nudge` and the candidate-verdict
  // callback.
  const policy = await deps.activePolicy(env, repositoryId);
  const deviceOnly = requiresDeviceOnly(policy?.securityProfile ?? null);

  // A repository whose writer is the App has no merge workflow to dispatch.
  //
  // The dispatch existed to start `thwip-merge.yml`, which asked `/authorize`
  // for the pins and wrote the branch. Once the App writes, that file is gone,
  // and a `repository_dispatch` for a workflow that is not there is a call to
  // GitHub that starts nothing. The queue walks the holder itself, and the push
  // its own merge produces wakes it for the next one.
  const project = await deps.queueProject(env, repositoryId, baseRef);
  if (project?.mergeWriter === "app") {
    const holder = running ?? ran;
    return holder === undefined
      ? { dispatched: false, reason: "LANE_IDLE" }
      : { dispatched: false, reason: "APP_WRITES", pullRequestNumber: holder.pullRequestNumber };
  }

  let holder = running;
  if (deviceOnly) {
    if (running !== undefined) {
      return { dispatched: false, reason: "DEVICE_ONLY", pullRequestNumber: running.pullRequestNumber };
    }
    holder = ran;
  }
  if (holder === undefined) return { dispatched: false, reason: "LANE_IDLE" };
  const pullRequestNumber = holder.pullRequestNumber;
  if (pullRequestNumber === options.exceptPullRequestNumber) {
    return { dispatched: false, reason: "ALREADY_RUNNING", pullRequestNumber };
  }

  try {
    await deps.driveTurn(env, repositoryId, pullRequestNumber);
  } catch {
    /* the turn survives; a later tick or the drain asks again */
    return { dispatched: false, reason: "DISPATCH_FAILED", pullRequestNumber };
  }
  return { dispatched: true, pullRequestNumber };
}

/**
 * The three things a caller does with a lane once the queue has authorized a
 * merge: write it, write it down, or hand it back.
 *
 * Built from the deps a caller already holds, so the route that answers a
 * workflow and the path that writes from the Worker cannot differ about what
 * confirmation, what record, and what freed lane a merge produces.
 */
export function mergeLaneFor<TEnv extends QueueRouteEnv>(
  deps: MergeLaneDeps<TEnv>,
  onQueue: OnQueue<TEnv>,
) {
/**
 * Record a merge the queue authorized and that has landed.
 *
 * One implementation for the two callers: the `/merged` report a workflow sends
 * and the write the Worker performs itself. Both have to confirm before they
 * record, because the record that becomes the chain link binds the tree that
 * actually landed and cannot be built until the queue has accepted that this is
 * the tree it authorized.
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
   * The write used to be shell in the adopter's `thwip-merge.yml`, behind a
   * token the adopter minted. Every outcome it had to handle is handled here,
   * from the same reads, because GitHub's reads lag its own writes and a
   * refusal from our own call says what the call did rather than what became of
   * the pull request.
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
      mergeMethod: MergeMethod;
    },
  ): Promise<Record<string, unknown>> => {
    // A squash commit does not contain the pull request head, so the branch's
    // own required checks refuse the ref update and GitHub cannot tell the pull
    // request was merged. Refusing costs a squash repository its merges; merging
    // anyway costs everyone the one claim this queue makes.
    if (input.mergeMethod !== "merge") {
      const freed = await resolveNotMerged(env, input);
      await driveLane(env, deps, input.repositoryId, input.baseRef, freed.snapshot);
      return {
        merged: false,
        reason: "SQUASH_UNBINDABLE",
        detail: `this repository merges by ${input.mergeMethod}, and a ${input.mergeMethod} commit does not contain the pull request head, so there is no way to bind it to the base the queue verified`,
      };
    }

    const outcome = await deps.mergeWrite!(env, input.repositoryId, {
      baseRef: input.baseRef,
      pullRequestNumber: input.pullRequestNumber,
      baseSha: input.merge.baseSha,
      headSha: input.merge.headSha,
      treeOid: input.merge.treeOid,
      parentShas: input.merge.parentShas,
      message: `${mergeCommitTitle(input.pullRequestNumber)}\n\n${mergeCommitMessage(input.operationId)}`,
    });

    if (outcome.kind === "merged" && outcome.mergeSha !== null) {
      const recorded = await recordLandedMerge(env, {
        repositoryId: input.repositoryId,
        baseRef: input.baseRef,
        attemptId: input.attemptId,
        operationId: input.operationId,
        mergeSha: outcome.mergeSha,
        witnessPrincipalIds: [],
      });
      if (!recorded.ok) return { merged: true, recorded: false, reason: recorded.code, detail: recorded.detail };
      await driveLane(env, deps, input.repositoryId, input.baseRef, recorded.snapshot);
      return {
        merged: true,
        // What was actually written, not that the call returned. A skipped
        // transition used to be reported as `recorded: true` with the skip
        // sitting in a field nobody reads, which is how a merge with no record
        // looked like a merge with one.
        recorded: recorded.digest !== null,
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
        }),
      );
      await driveLane(env, deps, input.repositoryId, input.baseRef, snapshot);
      return { merged: true, recorded: false, reason: "MERGE_UNNAMED" };
    }

    if (outcome.kind === "base-moved" || outcome.kind === "not-merged" || outcome.kind === "refused") {
      // The queue authorized a merge that is not going to happen, so it hears
      // that here. Otherwise the lane stays held until its deadline and every
      // pull request behind this one waits on a merge nobody is going to make.
      const freed = await resolveNotMerged(env, input);
      await driveLane(env, deps, input.repositoryId, input.baseRef, freed.snapshot);
      return {
        merged: false,
        reason: outcome.kind === "base-moved" ? "BASE_MOVED" : "MERGE_REFUSED",
        detail: outcome.detail,
        resolved: freed.status,
      };
    }

    // Unknown is never reported as a refusal. Reconciliation reads for itself
    // and can still end in a confirmed merge with a record behind it.
    const { snapshot } = await onQueue(env, input.repositoryId, input.baseRef, ({ commands }) =>
      commands.mergeOutcomeUnknown({
        idempotencyKey: `worker-merge:unknown:${input.attemptId}`,
        attemptId: input.attemptId,
      }),
    );
    await driveLane(env, deps, input.repositoryId, input.baseRef, snapshot);
    return { merged: false, reason: "MERGE_OUTCOME_UNKNOWN", detail: outcome.detail };
  };

  return { recordLandedMerge, resolveNotMerged, performMergeFromWorker };
}
