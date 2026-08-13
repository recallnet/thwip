import {
  canonicalRecordBytes,
  envelopeDigest,
  parseTransitionRecord,
  parseIntegrationAssignment,
  recordDigest,
  requiredSuitesDigest,
  type MergeIntentV1,
  type Sha256,
} from "@thwip/queue-protocol";
import { transitionKindOf } from "@thwip/queue-domain";
import type { QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";
import { buildSnapshot, type QueueSnapshot } from "./queue-operations.js";
import { loadQueueState } from "./queue-state.js";
import type { SnapshotQueueStore } from "./snapshot-store.js";
import type { QueueCommands } from "./commands.js";
import {
  authorizationFor,
  clearAttestationChainPosition,
  durableMergeRecordForCommit,
  readAttestation,
  recordCoveringCommit,
  queueTransitionLinkForDigest,
  signReusedRecord,
  signVerifiedRecord,
  recoverExactMergeRecord,
  storeAttestation,
  transitionRecordFor,
  type VerifiedEvidence,
} from "./attestation.js";
import { issuedAssignmentForAttempt } from "./assignment-store.js";
import { acceptIntegrationReceipt, integrationReceiptDigest } from "./integration-receipt.js";
import { withTransitionSigningLease } from "./transition-signing-lease.js";
import { projectAuthoritativeQueue } from "./queue-projection.js";

/**
 * Putting a merge back into the chain from what survives the attempt.
 *
 * The attempt does not survive the failure this exists for. A merge write is
 * authorized, GitHub returns an ambiguous refusal, the merge lands, and the
 * attempt is terminated and compacted. Four merges reached `main` that way in
 * one morning.
 *
 * What survives is the signed merge intent. It is stored by digest and it names
 * the base, the head, the tree the queue authorized, the pull request, the
 * policy and the evidence, which is everything a transition record cites. So a
 * merge can be recorded long after the attempt is gone, and the caller supplies
 * one thing: a commit sha.
 *
 * Three things stop this recording a merge nobody authorized. The commit's tree
 * and parents come from GitHub rather than the caller. `authorizationFor`
 * returns an intent only where its pinned tree and pinned parents are exactly
 * that commit's. And the transition record schema refuses a record whose merged
 * tree is not the candidate tree and whose first and second parents are not the
 * base and head the intent names.
 *
 * Where the record goes is decided by the chain, not by when the merge
 * happened. The chain is hash-linked and append-only, so a record's position and
 * the digest of the record before it are inside the bytes that were signed.
 * Putting a merge back where it belongs chronologically would mean re-signing
 * every record after it, which is a rewrite, and refusing to rewrite is the
 * whole claim. A repair links the current head and takes the next sequence.
 */
export type RecordFromIntentRefusal =
  | "COMMIT_UNREADABLE"
  | "MERGE_NOT_ON_BASE"
  | "MERGE_NOT_AUTHORIZED"
  | "ATTEMPT_STILL_LIVE"
  | "BASE_UNREADABLE"
  | "SIGNING_REFUSED"
  | "CHAIN_MOVED";

export type RecordFromIntentResult =
  | {
      readonly status: "recorded";
      readonly attemptId: string;
      readonly pullRequestNumber: number | null;
      readonly mergeSha: string;
      readonly sequence: number;
      readonly transitionDigest: string;
      readonly mergeIntentDigest: string;
      readonly repairAuditDigest: string;
    }
  | {
      readonly status: "already";
      /** Null where the record that covers this commit cites no attempt. */
      readonly attemptId: string | null;
      readonly pullRequestNumber: number | null;
      readonly transitionDigest: string;
      readonly repairAuditDigest: string | null;
    }
  | { readonly status: "refused"; readonly code: RecordFromIntentRefusal; readonly detail: string };

/**
 * The subset of the route's dependencies this path uses.
 *
 * `signRecordBytes` and `storeEvidence` are injected for the same reason
 * `commitFacts` and `baseContainsSha` are. Each reaches something the caller
 * chooses, whether that is the signing key, the evidence bucket, or GitHub, and
 * a test that has to reach any of them for real is a test nobody runs.
 */
export interface RecordFromIntentDeps<TEnv extends QueueRouteEnv> {
  commitFacts(
    env: TEnv,
    repositoryId: string,
    sha: string,
  ): Promise<{ treeOid: string; parentShas: string[]; message?: string } | null>;
  baseContainsSha(env: TEnv, repositoryId: string, baseRef: string, sha: string): Promise<boolean | null>;
  pullRequestMergeState(
    env: TEnv,
    repositoryId: string,
    pullRequestNumber: number,
  ): Promise<{ merged: boolean; mergeCommitSha: string | null } | null>;
  activePolicy(
    env: TEnv,
    repositoryId: string,
  ): Promise<{
    policyDigest: string;
    pipelineDigest: string | null;
    requiredSuites: readonly string[];
    organizationId: string;
  } | null>;
  signRecordBytes(env: TEnv, bytes: Uint8Array, typ: string): Promise<string>;
  storeEvidence(
    env: TEnv,
    input: {
      readonly organizationId: string;
      readonly repositoryId: string;
      readonly kind: "merge-intent" | "transition-record";
      readonly digest: `sha256:${string}`;
      readonly bytes: Uint8Array;
    },
  ): Promise<string>;
  onQueue: <T>(
    env: TEnv,
    repositoryId: string,
    baseRef: string,
    decide: (parts: { store: SnapshotQueueStore; commands: QueueCommands }) => T,
  ) => Promise<{ result: T; snapshot: QueueSnapshot }>;
}

/** Read the queue without writing anything. */
export async function readQueue(
  env: QueueRouteEnv,
  repositoryId: string,
  baseRef: string,
): Promise<{ store: SnapshotQueueStore; snapshot: QueueSnapshot }> {
  const loaded = await loadQueueState(env.DB as unknown as D1Like, repositoryId, baseRef);
  return { store: loaded.store, snapshot: buildSnapshot(loaded.store) };
}

/**
 * Rebuild the verified evidence from records the queue wrote before the merge.
 *
 * The signed intent says what was authorized. The signed assignment says what
 * the device was told to run. The accepted receipt row says which signed
 * answer the queue accepted. A repair may use those three stored accounts, but
 * it must not replace any of them with values from the operator's request.
 */
async function verifiedEvidenceForRepair(
  db: D1Like,
  input: {
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly intent: Extract<MergeIntentV1, { kind: "verified" }>;
    readonly organizationId: string;
  },
): Promise<{ readonly ok: true; readonly evidence: VerifiedEvidence } | { readonly ok: false; readonly detail: string }> {
  const assignment = await issuedAssignmentForAttempt(db, input.intent.attemptId);
  if (assignment === null) {
    return { ok: false, detail: "the verified intent has no stored assignment" };
  }
  if (assignment.receipt === null) {
    return { ok: false, detail: "the verified intent has no stored accepted receipt" };
  }
  if (input.intent.evidence.execution.ranOn !== "device") {
    return { ok: false, detail: "only a stored device run can authorize a verified repair" };
  }

  const signedAssignment = await readAttestation(db, input.intent.evidence.assignmentDigest);
  if (signedAssignment?.kind !== "integration-assignment") {
    return { ok: false, detail: "the assignment named by the verified intent is not stored" };
  }
  const assignmentBytes = await db
    .prepare("SELECT bytes FROM queue_attestations WHERE digest = ?")
    .bind(input.intent.evidence.assignmentDigest)
    .first<{ bytes: string }>();
  if (
    assignmentBytes === null ||
    (await envelopeDigest(new TextEncoder().encode(assignmentBytes.bytes))) !== input.intent.evidence.assignmentDigest
  ) {
    return { ok: false, detail: "the stored assignment bytes do not match the digest named by the intent" };
  }
  const parsed = parseIntegrationAssignment(signedAssignment.record);
  if (!parsed.ok) {
    return { ok: false, detail: `the stored assignment is unreadable: ${parsed.detail}` };
  }
  const document = parsed.value;
  if ((await recordDigest(document)) !== input.intent.evidence.assignmentDigest) {
    return { ok: false, detail: "the stored assignment bytes do not match the digest named by the intent" };
  }
  if (document.execution.mode !== "run") {
    return { ok: false, detail: "the stored assignment is not a device-run assignment" };
  }

  const storedReceipt = {
    assignmentId: assignment.receipt.assignmentId,
    assignmentDigest: assignment.receipt.assignmentDigest,
    candidateTreeOid: assignment.receipt.candidateTreeOid,
    deviceKeyId: assignment.receipt.deviceKeyId,
    suites: assignment.receipt.suites,
  };
  const computedReceiptDigest = await integrationReceiptDigest(storedReceipt);
  if (computedReceiptDigest !== assignment.receipt.receiptDigest) {
    return { ok: false, detail: "the stored accepted receipt does not match its content digest" };
  }

  const receiptVerdict = acceptIntegrationReceipt(
    storedReceipt,
    {
      assignmentId: assignment.assignmentId,
      digest: assignment.assignmentDigest,
      candidateTreeOid: assignment.candidateTreeOid,
      deviceKeyId: assignment.deviceKeyId,
      requiredSuites: assignment.requiredSuites,
    },
  );
  if (!receiptVerdict.ok) {
    return { ok: false, detail: `the stored accepted receipt no longer matches its assignment: ${receiptVerdict.detail}` };
  }

  const suitesDigest = await requiredSuitesDigest(assignment.requiredSuites);
  const same = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  const mismatches = [
    assignment.attemptId === input.intent.attemptId ? null : "attempt",
    assignment.repositoryId === input.repositoryId ? null : "repository",
    assignment.baseRef === input.baseRef ? null : "base ref",
    assignment.assignmentId === document.assignmentId ? null : "assignment id",
    assignment.assignmentDigest === input.intent.evidence.assignmentDigest ? null : "assignment digest",
    assignment.receipt.receiptDigest === input.intent.evidence.integrationEvidenceDigest
      ? null
      : "integration receipt digest",
    assignment.candidateSha === input.intent.git.candidateSha ? null : "candidate commit",
    assignment.candidateTreeOid === input.intent.git.candidateTreeOid ? null : "candidate tree",
    suitesDigest === input.intent.evidence.requiredSuitesDigest ? null : "required suites",
    document.attemptId === input.intent.attemptId ? null : "signed assignment attempt",
    document.repository.repositoryId === input.repositoryId ? null : "signed assignment repository",
    document.repository.baseRef === input.baseRef ? null : "signed assignment base ref",
    document.queue.pullRequestNumber === input.intent.pullRequestNumber ? null : "signed assignment pull request",
    document.queue.queueEpoch === input.intent.queueEpoch ? null : "signed assignment queue epoch",
    document.queue.turnSequence === input.intent.turnSequence ? null : "signed assignment turn",
    document.git.objectFormat === input.intent.git.objectFormat ? null : "signed assignment object format",
    document.git.repositoryId === input.intent.git.repositoryId ? null : "signed assignment git repository",
    document.git.baseRef === input.intent.git.baseRef ? null : "signed assignment git base ref",
    document.git.candidateSha === input.intent.git.candidateSha ? null : "signed assignment candidate commit",
    document.git.candidateTreeOid === input.intent.git.candidateTreeOid ? null : "signed assignment candidate tree",
    document.git.baseSha === input.intent.git.baseSha ? null : "signed assignment base commit",
    document.git.headRepositoryId === input.intent.git.headRepositoryId
      ? null
      : "signed assignment head repository",
    document.git.headSha === input.intent.git.headSha ? null : "signed assignment head commit",
    same(document.git.candidateParentOids, input.intent.git.candidateParentOids)
      ? null
      : "signed assignment candidate parents",
    document.policy.digest === input.intent.policyDigest ? null : "signed assignment policy",
    same(document.policy.requiredSuites, assignment.requiredSuites) ? null : "signed assignment required suites",
    document.evidence.workReceiptDigest === input.intent.evidence.workReceiptDigest
      ? null
      : "signed assignment work receipt",
    document.evidence.previousTransitionDigest === input.intent.previousTransitionDigest
      ? null
      : "signed assignment previous transition",
    document.execution.deviceKeyId === assignment.deviceKeyId ? null : "signed assignment device",
    document.execution.runnerPrincipalId === assignment.principalId ? null : "signed assignment runner",
    input.intent.evidence.execution.deviceKeyId === assignment.deviceKeyId ? null : "verified intent device",
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    return { ok: false, detail: `stored verified evidence disagrees on ${mismatches.join(", ")}` };
  }

  return {
    ok: true,
    evidence: {
      workReceiptDigest: input.intent.evidence.workReceiptDigest,
      organizationId: input.organizationId,
      policyDigest: input.intent.policyDigest,
      pipelineDigest: input.intent.evidence.pipelineDigest,
      requiredSuitesDigest: input.intent.evidence.requiredSuitesDigest,
      assignmentDigest: input.intent.evidence.assignmentDigest,
      integrationEvidenceDigest: input.intent.evidence.integrationEvidenceDigest,
      execution: input.intent.evidence.execution,
    },
  };
}

/** First signed audit stored for a repaired transition. */
export async function repairAuditForTransition(
  db: D1Like,
  input: { repositoryId: string; baseRef: string; transitionDigest: string },
): Promise<{ digest: string; record: unknown; jws: string } | null> {
  const row = await db
    .prepare(
      `SELECT digest, bytes, jws FROM queue_attestations
        WHERE kind = 'transition-repair-audit'
          AND github_repository_id = ? AND base_ref = ?
          AND transition_sequence IS NULL
          AND json_extract(bytes, '$.transitionDigest') = ?
        ORDER BY created_at, digest
        LIMIT 1`,
    )
    .bind(input.repositoryId, input.baseRef, input.transitionDigest)
    .first<{ digest: string; bytes: string; jws: string }>();
  if (row === null) return null;
  return { digest: row.digest, record: JSON.parse(row.bytes) as unknown, jws: row.jws };
}

async function storeRepairAudit<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: RecordFromIntentDeps<TEnv>,
  db: D1Like,
  input: {
    digest: string;
    repositoryId: string;
    baseRef: string;
    attemptId: string;
    actorPrincipalId: string;
    reason: string;
  },
): Promise<string> {
  const existing = await repairAuditForTransition(db, {
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    transitionDigest: input.digest,
  });
  if (existing !== null) return existing.digest;

  const transition = await readAttestation(db, input.digest);
  const parsed = transition === null ? null : parseTransitionRecord(transition.record);
  if (parsed === null || !parsed.ok) throw new Error(`cannot audit unreadable transition ${input.digest}`);
  const document = {
    schemaVersion: "1",
    kind: "transition-repair-audit",
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    transitionDigest: input.digest,
    attemptId: input.attemptId,
    actorPrincipalId: input.actorPrincipalId,
    reason: input.reason,
    recordedAt: new Date().toISOString(),
  };
  const bytes = canonicalRecordBytes(document);
  const digest = await envelopeDigest(bytes);
  const jws = await deps.signRecordBytes(
    env,
    bytes,
    "urn:thwip:attestation:transition-repair-audit:v1",
  );
  await storeAttestation(db, {
    digest,
    kind: "transition-repair-audit",
    repositoryId: input.repositoryId,
    baseRef: input.baseRef,
    transitionSequence: null,
    attemptId: input.attemptId,
    bytes,
    jws,
  });
  // Two administrators can reach the query above together. Both signed audits
  // are true records of actions that happened; lookup is first-wins by stored
  // time and digest, and sequential retries always return that first record.
  return (
    await repairAuditForTransition(db, {
      repositoryId: input.repositoryId,
      baseRef: input.baseRef,
      transitionDigest: input.digest,
    })
  )?.digest ?? digest;
}

export async function recordMergeFromIntent<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: RecordFromIntentDeps<TEnv>,
  input: {
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly mergeSha: string;
    readonly witnessPrincipalId: string;
    readonly reason: string;
    readonly attemptId?: string;
  },
): Promise<RecordFromIntentResult> {
  const { repositoryId, baseRef, mergeSha } = input;

  const facts = await deps.commitFacts(env, repositoryId, mergeSha);
  if (facts === null) return { status: "refused", code: "COMMIT_UNREADABLE", detail: "could not read that commit" };
  if (facts.message === undefined) {
    return { status: "refused", code: "COMMIT_UNREADABLE", detail: "could not read that commit's message" };
  }
  const commitMessage = facts.message;

  // A commit that exists is not a commit that landed. The record would say the
  // base branch became this, so the branch is asked, exactly as the merge
  // report path asks. Without it an operator repairing by hand could name the
  // test merge of an open pull request and get it signed, which is how record
  // 54 reached the chain by another route.
  const reachable = await deps.baseContainsSha(env, repositoryId, baseRef, mergeSha);
  if (reachable !== true) {
    return {
      status: "refused",
      code: "MERGE_NOT_ON_BASE",
      detail:
        reachable === false
          ? `${baseRef} does not contain ${mergeSha}`
          : `${baseRef} could not be asked whether it contains ${mergeSha}`,
    };
  }

  const db = env.DB as unknown as D1Like;
  const signingOwner = `intent-repair:${input.attemptId ?? mergeSha}:${crypto.randomUUID()}`;
  const signing = await withTransitionSigningLease<RecordFromIntentResult>(
    db,
    {
      repositoryId,
      baseRef,
      owner: signingOwner,
    },
    async (claim) => {

  // Recovery reads the transition projection, but queue_state is authority.
  // Replay authority before deciding that no link exists; this repairs the
  // commit-before-projection failure without creating new signed bytes.
  await projectAuthoritativeQueue(db, repositoryId, baseRef);
  if (!(await claim.fence())) {
    return {
      status: "refused",
      code: "CHAIN_MOVED",
      detail: "a later signed transition writer replaced this repair while it restored queue authority",
    };
  }

  // Asked before the authorization, because a chain that already carries this
  // exact, authentic merge has nothing left to put back. This also settles an
  // orphaned operation for a later attempt after an earlier attempt recorded
  // the pull request: the commit is the durable identity, not the callback that
  // happened to notice it. Storage or key-read failure propagates; treating it
  // as absence could sign a second record.
  const durableCovered = await durableMergeRecordForCommit(db, { repositoryId, baseRef, mergeSha });
  if (durableCovered !== null) {
    const repairAuditDigest =
      durableCovered.queueAttemptId === null
        ? await storeRepairAudit(env, deps, db, {
            digest: durableCovered.digest,
            repositoryId,
            baseRef,
            attemptId: durableCovered.attemptId,
            actorPrincipalId: input.witnessPrincipalId,
            reason: input.reason,
          })
        : null;
    return {
      status: "already",
      attemptId: durableCovered.attemptId,
      pullRequestNumber: durableCovered.pullRequestNumber,
      transitionDigest: durableCovered.digest,
      repairAuditDigest,
    };
  }

  // Keep the legacy positioned-row cleanup and the external-movement shortcut.
  // A merge row reaches the shortcut above only after its signature, bytes and
  // queue link all agree. A forged or half-linked merge row is cleared instead
  // of being accepted as the reason to stop recovery.
  const covered = await recordCoveringCommit(db, repositoryId, baseRef, mergeSha);
  if (covered !== null) {
    if (covered.attemptId !== null) {
      if (await queueTransitionLinkForDigest(db, { repositoryId, baseRef, digest: covered.digest })) {
        if (covered.attemptId.startsWith("movement:")) {
          return {
            status: "already",
            attemptId: null,
            pullRequestNumber: null,
            transitionDigest: covered.digest,
            repairAuditDigest: null,
          };
        }
        return {
          status: "refused",
          code: "CHAIN_MOVED",
          detail: "the queue link and its signed record do not agree on one authentic public position",
        };
      }
      // A legacy build gave this row a position before the queue accepted the
      // link, or its alleged signature is not authentic. The strict lookup
      // above proves it cannot settle this merge.
      await clearAttestationChainPosition(db, covered.digest);
    } else if (await queueTransitionLinkForDigest(db, { repositoryId, baseRef, digest: covered.digest })) {
      return {
        status: "refused",
        code: "CHAIN_MOVED",
        detail: "the queue link names a record with no durable signing identity",
      };
    } else {
      await clearAttestationChainPosition(db, covered.digest);
    }
  }

  const authorization = await authorizationFor(db, {
    repositoryId,
    baseRef,
    treeOid: facts.treeOid,
    parentShas: facts.parentShas,
    message: commitMessage,
    ...(typeof input.attemptId === "string" ? { attemptId: input.attemptId } : {}),
  });
  if ("refused" in authorization) {
    return { status: "refused", code: "MERGE_NOT_AUTHORIZED", detail: authorization.refused };
  }
  const intent = authorization.intent;
  // An override binds a human authorization this path must not reissue.
  if (intent.kind === "override") {
    return {
      status: "refused",
      code: "MERGE_NOT_AUTHORIZED",
      detail: `a ${intent.kind} merge cannot be rebuilt from its intent alone`,
    };
  }
  const attemptId = intent.attemptId;

  const { snapshot } = await readQueue(env, repositoryId, baseRef);
  const pull = await deps.pullRequestMergeState(env, repositoryId, intent.pullRequestNumber);
  if (pull?.merged !== true || pull.mergeCommitSha !== mergeSha) {
    return {
      status: "refused",
      code: "MERGE_NOT_AUTHORIZED",
      detail: "GitHub does not confirm this commit as the pull request's merge commit",
    };
  }
  const linked = await recoverExactMergeRecord(db, {
    repositoryId,
    baseRef,
    pullRequestNumber: intent.pullRequestNumber,
    mergeSha,
  });
  if (linked?.status === "linked") {
    const repairAuditDigest = await storeRepairAudit(env, deps, db, {
      digest: linked.digest,
      repositoryId,
      baseRef,
      attemptId: linked.attemptId,
      actorPrincipalId: input.witnessPrincipalId,
      reason: input.reason,
    });
    return {
      status: "already",
      attemptId: linked.attemptId,
      pullRequestNumber: intent.pullRequestNumber,
      transitionDigest: linked.digest,
      repairAuditDigest,
    };
  }

  const already = await transitionRecordFor(db, repositoryId, baseRef, attemptId);
  if (already !== null) {
    await clearAttestationChainPosition(db, already);
  }

  if (snapshot.activeAttemptId === attemptId) {
    return {
      status: "refused",
      code: "ATTEMPT_STILL_LIVE",
      detail: "that attempt still holds the lane; reconcile it instead",
    };
  }

  // The tree the branch had before this merge, from the commit itself. A
  // record that is not first in its epoch has to say where it started.
  const before = await deps.commitFacts(env, repositoryId, intent.git.baseSha);
  if (before === null) {
    return { status: "refused", code: "BASE_UNREADABLE", detail: "could not read the base this merge started from" };
  }

  const head = snapshot.transitions.at(-1);
  const transitionSequence = (head?.transitionSequence ?? 0) + 1;
  const priorDigest = head?.digest ?? null;

  // The policy the intent bound, not whatever is active now: the record says
  // what this merge rested on, and the policy may have changed since.
  const policy = await deps.activePolicy(env, repositoryId);
  const verifiedEvidence =
    intent.kind === "verified"
      ? await verifiedEvidenceForRepair(db, {
          repositoryId,
          baseRef,
          intent,
          organizationId: policy?.organizationId ?? "",
        })
      : null;
  if (verifiedEvidence !== null && !verifiedEvidence.ok) {
    return { status: "refused", code: "MERGE_NOT_AUTHORIZED", detail: verifiedEvidence.detail };
  }
  const candidateVerified = intent.kind === "candidate-verified";
  const subject = {
    attemptId,
    mergeMethod: intent.mergeMethod,
    git: {
      ...intent.git,
      candidateSha: mergeSha,
      candidateTreeOid: facts.treeOid,
      candidateParentOids: [...facts.parentShas],
    },
    position: {
      queueEpoch: snapshot.queueEpoch,
      turnSequence: intent.turnSequence,
      transitionSequence,
      previousTransitionDigest: priorDigest as Sha256 | null,
    },
    pullRequestNumber: intent.pullRequestNumber,
    mergeIntentDigest: authorization.intentDigest,
    before: { baseSha: intent.git.baseSha, treeOid: before.treeOid },
    final: { sha: mergeSha, treeOid: facts.treeOid, parentShas: facts.parentShas },
    observedAt: new Date().toISOString(),
    signer: { sign: (bytes: Uint8Array, typ: string) => deps.signRecordBytes(env, bytes, typ) },
  };
  const recordKind =
    verifiedEvidence?.ok === true
      ? "verified-merge"
      : candidateVerified
        ? "candidate-verified-merge"
        : "reused-proof-merge";
  if (!(await claim.fence())) {
    return {
      status: "refused",
      code: "CHAIN_MOVED",
      detail: "a later signed transition writer replaced this repair before it could use its chain position",
    };
  }
  const reusable = await recoverExactMergeRecord(db, {
    repositoryId,
    baseRef,
    pullRequestNumber: intent.pullRequestNumber,
    mergeSha,
    staged: {
      pullRequestNumber: intent.pullRequestNumber,
      mergeTree: facts.treeOid,
      parentShas: facts.parentShas,
      beforeBaseSha: intent.git.baseSha,
      beforeTree: before.treeOid,
      queueEpoch: snapshot.queueEpoch,
      transitionSequence,
      priorDigest,
    },
  });
  if (reusable?.status === "linked") {
    const repairAuditDigest = await storeRepairAudit(env, deps, db, {
      digest: reusable.digest,
      repositoryId,
      baseRef,
      attemptId: reusable.attemptId,
      actorPrincipalId: input.witnessPrincipalId,
      reason: input.reason,
    });
    return {
      status: "already",
      attemptId: reusable.attemptId,
      pullRequestNumber: intent.pullRequestNumber,
      transitionDigest: reusable.digest,
      repairAuditDigest,
    };
  }
  let recordDigest = reusable?.digest ?? null;
  let recordAttemptId = reusable?.status === "staged" ? reusable.attemptId : attemptId;
  let linkingRecordKind = reusable?.status === "staged" ? reusable.recordKind : recordKind;
  if (recordDigest === null) {
    if (!(await claim.fence())) {
      return {
        status: "refused",
        code: "CHAIN_MOVED",
        detail: "a later signed transition writer replaced this repair before it could sign",
      };
    }
    const signed =
      verifiedEvidence?.ok === true
        ? await signVerifiedRecord({ ...subject, evidence: verifiedEvidence.evidence })
        : intent.kind === "verified"
          ? { error: "the stored verified evidence could not be rebuilt" }
          : await signReusedRecord({
              ...subject,
              evidence: {
                workReceiptDigest: intent.evidence.workReceiptDigest,
                organizationId: policy?.organizationId ?? "",
                policyDigest: intent.policyDigest,
                pipelineDigest: intent.evidence.pipelineDigest,
                requiredSuitesDigest: intent.evidence.requiredSuitesDigest,
                proofCheckRunId: intent.evidence.proofCheckRunId,
                ...(candidateVerified ? { verifierResultDigest: intent.evidence.verifierResultDigest } : {}),
              },
            });
    if ("error" in signed) {
      return {
        status: "refused",
        code: "SIGNING_REFUSED",
        detail: `the queue refused to sign its own record: ${signed.error}`,
      };
    }
    if (!(await claim.fence())) {
      return {
        status: "refused",
        code: "CHAIN_MOVED",
        detail: "a later signed transition writer replaced this repair while it was signing",
      };
    }
    recordDigest = signed.digest;
    recordAttemptId = attemptId;
    linkingRecordKind = recordKind;
    await storeAttestation(db, {
      digest: signed.digest,
      kind: recordKind,
      repositoryId,
      baseRef,
      transitionSequence: null,
      attemptId,
      bytes: signed.bytes,
      jws: signed.jws,
      ...(policy === null
        ? {}
        : {
            organizationId: policy.organizationId,
            mirror: (mirrored: {
              organizationId: string;
              repositoryId: string;
              kind: "merge-intent" | "transition-record";
              digest: string;
              bytes: Uint8Array;
            }) =>
              deps
                .storeEvidence(env, {
                  organizationId: mirrored.organizationId,
                  repositoryId: mirrored.repositoryId,
                  kind: mirrored.kind,
                  digest: mirrored.digest as `sha256:${string}`,
                  bytes: mirrored.bytes,
                })
                .then(() => undefined),
          }),
    });
  }
  if (!(await claim.fence())) {
    return {
      status: "refused",
      code: "CHAIN_MOVED",
      detail: "a later signed transition writer replaced this repair before it could link its record",
    };
  }
  const { result } = await deps.onQueue(env, repositoryId, baseRef, ({ commands, store }) => {
    if (!store.holdsTransitionSigning(signingOwner, new Date().toISOString())) {
      return { moved: true as const };
    }
    const tail = store.state().transitions.at(-1);
    // The position this record claims is inside the bytes that were signed,
    // and signing is not inside the transaction. A link recorded at a
    // position its own record does not claim is exactly the break the
    // verifier reports, so the record is dropped rather than misplaced.
    if ((tail?.transitionSequence ?? 0) + 1 !== transitionSequence || (tail?.digest ?? null) !== priorDigest) {
      return { moved: true as const };
    }
    return {
      moved: false as const,
      transition: commands.recordTransition({
        idempotencyKey: `repair:${recordAttemptId}`,
        kind: transitionKindOf(linkingRecordKind),
        transitionSequence,
        priorDigest,
        digest: recordDigest,
        baseSha: mergeSha,
        // The reducer chains an attempt only where it can see one whose phase
        // is MERGED, and this attempt was terminated and has since been
        // compacted away. The attempt is inside the signed record and on the
        // row that holds it, which is where a reader looks for it.
        attemptId: null,
        witnessPrincipalIds: [input.witnessPrincipalId],
        reason: input.reason,
      }),
    };
  });

  if (result.moved) {
    const winner = await recoverExactMergeRecord(db, {
      repositoryId,
      baseRef,
      pullRequestNumber: intent.pullRequestNumber,
      mergeSha,
    });
    if (winner?.status === "linked") {
      const repairAuditDigest = await storeRepairAudit(env, deps, db, {
          digest: winner.digest,
          repositoryId,
          baseRef,
          attemptId: winner.attemptId,
          actorPrincipalId: input.witnessPrincipalId,
          reason: input.reason,
      });
      return {
        status: "already",
        attemptId: winner.attemptId,
        pullRequestNumber: intent.pullRequestNumber,
        transitionDigest: winner.digest,
        repairAuditDigest,
      };
    }
    return {
      status: "refused",
      code: "CHAIN_MOVED",
      detail: "the chain moved while this record was being signed; try again",
    };
  }

  // The projection is the full durable queue chain. It also validates the
  // linked digest's signed sequence, predecessor and resulting base before a
  // D1 attestation row is allowed to claim that position.
  const winner = await recoverExactMergeRecord(db, {
    repositoryId,
    baseRef,
    pullRequestNumber: intent.pullRequestNumber,
    mergeSha,
  });
  if (winner?.status !== "linked") {
    return {
      status: "refused",
      code: "CHAIN_MOVED",
      detail:
        result.transition.status === "rejected"
          ? `the queue refused the transition: ${result.transition.detail}`
          : "the transition command did not create the signed queue link",
    };
  }
  const repairAuditDigest = await storeRepairAudit(env, deps, db, {
    digest: winner.digest,
    repositoryId,
    baseRef,
    attemptId: winner.attemptId,
    actorPrincipalId: input.witnessPrincipalId,
    reason: input.reason,
  });
  if (winner.digest !== recordDigest) {
    return {
      status: "already",
      attemptId: winner.attemptId,
      pullRequestNumber: intent.pullRequestNumber,
      transitionDigest: winner.digest,
      repairAuditDigest,
    };
  }

  return {
    status: "recorded",
    attemptId: recordAttemptId,
    pullRequestNumber: intent.pullRequestNumber,
    mergeSha,
    sequence: transitionSequence,
    transitionDigest: recordDigest,
    mergeIntentDigest: authorization.intentDigest,
    repairAuditDigest,
  };
    },
  );
  if (!signing.acquired) {
    return {
      status: "refused",
      code: "CHAIN_MOVED",
      detail: "another signed transition writer owns this branch; try again",
    };
  }
  return signing.result;
}
