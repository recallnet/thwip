import type { Sha256 } from "@thwip/queue-protocol";
import type { QueueRouteEnv } from "./routes.js";
import type { D1Like } from "./projection.js";
import { buildSnapshot, type QueueSnapshot } from "./queue-operations.js";
import { loadQueueState } from "./queue-state.js";
import type { SnapshotQueueStore } from "./snapshot-store.js";
import type { QueueCommands } from "./commands.js";
import {
  authorizationFor,
  recordCoveringCommit,
  signReusedRecord,
  storeAttestation,
  transitionRecordFor,
} from "./attestation.js";

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
    }
  | {
      readonly status: "already";
      /** Null where the record that covers this commit cites no attempt. */
      readonly attemptId: string | null;
      readonly pullRequestNumber: number | null;
      readonly transitionDigest: string;
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

export async function recordMergeFromIntent<TEnv extends QueueRouteEnv>(
  env: TEnv,
  deps: RecordFromIntentDeps<TEnv>,
  input: {
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly mergeSha: string;
    readonly witnessPrincipalId: string;
    readonly attemptId?: string;
  },
): Promise<RecordFromIntentResult> {
  const { repositoryId, baseRef, mergeSha } = input;

  const facts = await deps.commitFacts(env, repositoryId, mergeSha);
  if (facts === null) return { status: "refused", code: "COMMIT_UNREADABLE", detail: "could not read that commit" };

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

  // Asked before the authorization, because a chain that already carries this
  // commit has nothing left to put back and the reason no intent authorizes it
  // may be the reason a movement record was written for it. The sweep leaves a
  // row alone whenever this path refuses, so refusing here for a commit that is
  // already in the chain would keep a settled write open and re-read from
  // GitHub on every tick for as long as the account lives.
  const covered = await recordCoveringCommit(db, repositoryId, baseRef, mergeSha);
  if (covered !== null) {
    return { status: "already", attemptId: covered.attemptId, pullRequestNumber: null, transitionDigest: covered.digest };
  }

  const authorization = await authorizationFor(db, {
    repositoryId,
    baseRef,
    treeOid: facts.treeOid,
    parentShas: facts.parentShas,
    ...(typeof input.attemptId === "string" ? { attemptId: input.attemptId } : {}),
  });
  if ("refused" in authorization) {
    return { status: "refused", code: "MERGE_NOT_AUTHORIZED", detail: authorization.refused };
  }
  const intent = authorization.intent;
  // A verified merge's record binds an Actions run id, which the intent does
  // not carry, and an override binds an authorization this must not reissue.
  // Neither can be rebuilt from what survives, so neither is guessed at.
  if (intent.kind !== "reused" && intent.kind !== "candidate-verified") {
    return {
      status: "refused",
      code: "MERGE_NOT_AUTHORIZED",
      detail: `a ${intent.kind} merge cannot be rebuilt from its intent alone`,
    };
  }
  const attemptId = intent.attemptId;

  const already = await transitionRecordFor(db, repositoryId, baseRef, attemptId);
  if (already !== null) {
    return { status: "already", attemptId, pullRequestNumber: intent.pullRequestNumber, transitionDigest: already };
  }

  const { snapshot } = await readQueue(env, repositoryId, baseRef);
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
  const verified = intent.kind === "candidate-verified";
  const signed = await signReusedRecord({
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
    evidence: {
      workReceiptDigest: intent.evidence.workReceiptDigest,
      organizationId: policy?.organizationId ?? "",
      policyDigest: intent.policyDigest,
      pipelineDigest: intent.evidence.pipelineDigest,
      requiredSuitesDigest: intent.evidence.requiredSuitesDigest,
      proofCheckRunId: intent.evidence.proofCheckRunId,
      ...(verified ? { verifierResultDigest: intent.evidence.verifierResultDigest } : {}),
    },
    mergeIntentDigest: authorization.intentDigest,
    before: { baseSha: intent.git.baseSha, treeOid: before.treeOid },
    final: { sha: mergeSha, treeOid: facts.treeOid, parentShas: facts.parentShas },
    observedAt: new Date().toISOString(),
    signer: { sign: (bytes, typ) => deps.signRecordBytes(env, bytes, typ) },
  });
  if ("error" in signed) {
    return {
      status: "refused",
      code: "SIGNING_REFUSED",
      detail: `the queue refused to sign its own record: ${signed.error}`,
    };
  }

  const stored = await storeAttestation(db, {
    digest: signed.digest,
    kind: verified ? "candidate-verified-merge" : "reused-proof-merge",
    repositoryId,
    baseRef,
    transitionSequence,
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
  if (!stored.stored) {
    return {
      status: "already",
      attemptId,
      pullRequestNumber: intent.pullRequestNumber,
      transitionDigest: stored.digest,
    };
  }

  const { result } = await deps.onQueue(env, repositoryId, baseRef, ({ commands, store }) => {
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
        idempotencyKey: `repair:${attemptId}`,
        kind: verified ? "verified" : "reused",
        transitionSequence,
        priorDigest,
        digest: signed.digest,
        baseSha: mergeSha,
        // The reducer chains an attempt only where it can see one whose phase
        // is MERGED, and this attempt was terminated and has since been
        // compacted away. The attempt is inside the signed record and on the
        // row that holds it, which is where a reader looks for it.
        attemptId: null,
        witnessPrincipalIds: [input.witnessPrincipalId],
      }),
    };
  });

  if (result.moved) {
    // The chain grew between reading the head and recording. The bytes stay:
    // the queue really did sign them, and destroying signed evidence to tidy
    // up is a worse habit than keeping a row nothing points at. What goes is
    // the claim to a position, so the chain never serves a record whose own
    // sequence disagrees with the one it was served at.
    await db
      .prepare("UPDATE queue_attestations SET transition_sequence = NULL WHERE digest = ?")
      .bind(signed.digest)
      .run();
    return {
      status: "refused",
      code: "CHAIN_MOVED",
      detail: "the chain moved while this record was being signed; try again",
    };
  }

  return {
    status: "recorded",
    attemptId,
    pullRequestNumber: intent.pullRequestNumber,
    mergeSha,
    sequence: transitionSequence,
    transitionDigest: signed.digest,
    mergeIntentDigest: authorization.intentDigest,
  };
}
